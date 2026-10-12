//! Legacy-fallback routing tests: the once-per-reason log, the availability
//! override driving `legacy_capture`, and the SCK start/crash/flag mapping.

use std::cell::RefCell;
use std::sync::atomic::AtomicU8;
use std::time::Duration;

use image::{Rgba, RgbaImage};
use senpi_desktop_core::error::{CoreResult, DesktopError, ErrorCode};
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::types::{DisplaySelector, Target};

use super::super::sck::{override_capture, SckCaptureError, SckFrame, SckTargetRequest, SckUnavailable};
use super::test_support::override_availability;
use super::{note_legacy, note_legacy_into, MacCapture, REASON_START_FAILED};
use crate::capture::minimized::override_probe;
use crate::capture::Screencapture;

fn shooter() -> Screencapture {
    Screencapture::with(std::path::PathBuf::from("/usr/bin/true"), Duration::from_secs(60), || true)
}

fn capture() -> MacCapture {
    MacCapture::new(DisplaySelector::All, shooter())
}

fn sck_frame() -> SckFrame {
    SckFrame {
        image: RgbaImage::from_pixel(4, 2, Rgba([1, 2, 3, 255])),
        bounds: (10.0, 20.0, 40.0, 20.0),
        is_on_screen: Some(false),
        pid: None,
    }
}

fn fake_frames(_requests: &[SckTargetRequest]) -> Result<Vec<SckFrame>, SckCaptureError> {
    Ok(vec![sck_frame()])
}

fn fake_start(_requests: &[SckTargetRequest]) -> Result<Vec<SckFrame>, SckCaptureError> {
    Err(SckCaptureError::Start)
}

fn fake_unavailable(_requests: &[SckTargetRequest]) -> Result<Vec<SckFrame>, SckCaptureError> {
    Err(SckCaptureError::Failed(DesktopError::capture_unavailable(
        "minimized",
        "The window is minimized",
    )))
}

#[test]
fn each_reason_logs_exactly_once() {
    let store = AtomicU8::new(0);
    let lines = RefCell::new(Vec::new());
    let log = |line: &str| lines.borrow_mut().push(line.to_owned());
    for _ in 0..3 {
        note_legacy_into(&store, REASON_START_FAILED, "start failed", log);
    }
    assert_eq!(lines.borrow().as_slice(), &["start failed".to_owned()]);
}

#[test]
fn unsupported_and_missing_helper_report_legacy() {
    for reason in [
        SckUnavailable::Unsupported,
        SckUnavailable::HelperUnavailable,
    ] {
        override_availability(Some(Err(reason)));
        assert!(capture().legacy_capture(), "{reason:?} must report legacy");
    }
    override_availability(None);
}

#[test]
fn a_start_failure_marks_legacy_after_it_is_noted() {
    note_legacy(REASON_START_FAILED, "start failed");
    override_availability(Some(Ok(())));
    assert!(capture().legacy_capture());
    override_availability(None);
}

#[test]
fn a_helper_start_failure_falls_back_without_error() {
    override_availability(Some(Ok(())));
    override_capture(Some(fake_start));
    let result = capture().capture_via_sck(&Target::Window("42".to_owned()), &[]);
    override_capture(None);
    override_availability(None);
    // Ok(None) is the silent-fallback signal: no error reaches the caller.
    assert!(matches!(result, Ok(None)), "{result:?}");
}

#[test]
fn a_reply_level_capture_error_surfaces_without_fallback() {
    override_availability(Some(Ok(())));
    override_capture(Some(fake_unavailable));
    let result = capture().capture_via_sck(&Target::Window("42".to_owned()), &[]);
    override_capture(None);
    override_availability(None);
    let error = result.unwrap_err();
    assert_eq!(error.code, ErrorCode::CaptureUnavailable);
    assert_eq!(
        error.capture_unavailable.map(|data| data.reason),
        Some("minimized".to_owned())
    );
}

#[test]
fn an_sck_window_capture_is_not_legacy_and_carries_is_on_screen() {
    override_availability(Some(Ok(())));
    override_capture(Some(fake_frames));
    let result = capture().capture_via_sck(&Target::Window("42".to_owned()), &[]);
    override_capture(None);
    override_availability(None);
    let Some((_image, geometry)) = result.unwrap() else {
        panic!("expected an SCK capture");
    };
    assert!(!geometry.is_legacy_capture());
    assert_eq!(geometry.window_is_on_screen(), Some(false));
}

fn fake_owned_off_screen(_requests: &[SckTargetRequest]) -> Result<Vec<SckFrame>, SckCaptureError> {
    Ok(vec![SckFrame { pid: Some(7), ..sck_frame() }])
}

fn capture_off_screen_window(
    probe: fn(i32, u32) -> Option<bool>,
) -> CoreResult<Option<(RgbaImage, FrameGeometry)>> {
    override_availability(Some(Ok(())));
    override_capture(Some(fake_owned_off_screen));
    override_probe(Some(probe));
    let result = capture().capture_via_sck(&Target::Window("42".to_owned()), &[]);
    override_probe(None);
    override_capture(None);
    override_availability(None);
    result
}

#[test]
fn a_minimized_off_screen_window_is_refused_with_capture_unavailable() {
    // Given an off-screen window that Accessibility reports minimized
    let error = capture_off_screen_window(|pid, window| (pid == 7 && window == 42).then_some(true))
        .unwrap_err();
    // Then it is refused, not returned as a stale image
    assert_eq!(error.code, ErrorCode::CaptureUnavailable);
    assert_eq!(
        error.capture_unavailable.map(|data| data.reason),
        Some("minimized".to_owned())
    );
}

#[test]
fn an_off_space_window_is_captured_with_is_on_screen_false() {
    // Given an off-screen window that is not minimized (another Space)
    let captured = capture_off_screen_window(|_, _| Some(false)).unwrap();
    // Then it is captured and says it is off screen
    let Some((_image, geometry)) = captured else { panic!("expected an SCK capture") };
    assert_eq!(geometry.window_is_on_screen(), Some(false));
}

#[test]
fn an_off_screen_window_is_captured_when_minimized_is_unknown() {
    // Given no Accessibility answer
    let captured = capture_off_screen_window(|_, _| None).unwrap();
    // Then the capture is returned rather than refused on a guess
    assert!(captured.is_some());
}
