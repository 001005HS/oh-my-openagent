//! B9 routing between the persistent ScreenCaptureKit worker (macOS 14+) and
//! the legacy `screencapture` path, with once-per-reason fallback logging.

use std::sync::atomic::{AtomicU8, Ordering};

use image::RgbaImage;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::types::{DesktopDisplay, DesktopWindow, DisplaySelector, Target};

use super::sck::{SckCaptureError, SckFrame, SckUnavailable, SckWorker};
use super::{parse_window_id, MacCapture};

/// Each legacy fallback reason logs once per engine process, never per
/// capture. Bits double as the `legacyCapture` capabilities flag's memory of
/// a start failure that only a capture attempt could reveal.
const REASON_UNSUPPORTED: u8 = 1;
const REASON_HELPER_MISSING: u8 = 2;
const REASON_START_FAILED: u8 = 4;
static LEGACY_REASONS: AtomicU8 = AtomicU8::new(0);

fn note_legacy(reason: u8, log_line: &str) {
    note_legacy_into(&LEGACY_REASONS, reason, log_line, |line| {
        eprintln!("senpi-desktop-backend-macos: capture: {line}");
    });
}

fn note_legacy_into(store: &AtomicU8, reason: u8, log_line: &str, log: impl FnOnce(&str)) {
    let prior = store.fetch_or(reason, Ordering::Relaxed);
    if prior & reason == 0 {
        log(log_line);
    }
}

/// Whether a legacy fallback already ran (or a helper start already failed).
fn legacy_capture_active() -> bool {
    LEGACY_REASONS.load(Ordering::Relaxed) != 0
}

/// The availability the router honors; tests override it.
fn sck_availability() -> Result<(), SckUnavailable> {
    #[cfg(test)]
    if let Some(value) = test_support::AVAILABILITY.with(std::cell::Cell::get) {
        return value;
    }
    SckWorker::availability()
}

impl MacCapture {
    /// Whether captures run through the legacy `screencapture` path: the SCK
    /// worker is unavailable on this host, or a helper start already failed.
    pub(crate) fn legacy_capture(&self) -> bool {
        !matches!(sck_availability(), Ok(())) || legacy_capture_active()
    }

    /// A capture whose display targets may exclude titled windows (B9 SCK).
    ///
    /// The legacy `screencapture` path runs with no error in all three
    /// fallback cases (lead ruling 2026-10-12): macOS < 14, a missing helper,
    /// and a helper that fails to start on 14+. Each logs once per reason and
    /// reports `legacyCapture: true` on the result. A helper that dies
    /// mid-capture instead surfaces the error and resets for the next capture.
    pub(crate) fn capture_with_exclusions(
        &self,
        target: &Target,
        exclude_window_titles: &[String],
    ) -> CoreResult<(RgbaImage, FrameGeometry)> {
        self.require_permission()?;
        match sck_availability() {
            Ok(()) => match self.capture_via_sck(target, exclude_window_titles)? {
                Some(captured) => Ok(captured),
                None => {
                    note_legacy(
                        REASON_START_FAILED,
                        "the ScreenCaptureKit capture helper failed to start; using the screencapture fallback",
                    );
                    self.capture_via_legacy(target)
                },
            },
            Err(SckUnavailable::Unsupported) => {
                note_legacy(
                    REASON_UNSUPPORTED,
                    "ScreenCaptureKit requires macOS 14; using the screencapture fallback",
                );
                self.capture_via_legacy(target)
            },
            Err(SckUnavailable::HelperUnavailable) => {
                note_legacy(
                    REASON_HELPER_MISSING,
                    "no ScreenCaptureKit capture helper is staged; using the screencapture fallback",
                );
                self.capture_via_legacy(target)
            },
        }
    }

    /// The SCK route. `Ok(None)` only when the helper failed to start (the
    /// caller falls back silently); reply errors and mid-capture transport
    /// deaths surface as errors (the worker resets after a death).
    fn capture_via_sck(
        &self,
        target: &Target,
        exclude_window_titles: &[String],
    ) -> CoreResult<Option<(RgbaImage, FrameGeometry)>> {
        match target {
            Target::Window(id) => {
                let window_id = parse_window_id(id)?;
                let request = super::sck::target_window(window_id);
                let frames = match SckWorker::capture(std::slice::from_ref(&request)) {
                    Ok(frames) => frames,
                    Err(SckCaptureError::Start) => return Ok(None),
                    Err(SckCaptureError::Failed(error)) => return Err(error),
                };
                let [frame] = <[SckFrame; 1]>::try_from(frames).map_err(|_| {
                    DesktopError::capture_failed(
                        "capture worker returned a batch for a single window request",
                    )
                })?;
                let (width, height) = (frame.image.width(), frame.image.height());
                let (x, y, logical_width, logical_height) = frame.bounds;
                let window = DesktopWindow {
                    id: id.clone(),
                    title: String::new(),
                    app: String::new(),
                    pid: None,
                    x: x.round() as i32,
                    y: y.round() as i32,
                    width: logical_width.round() as u32,
                    height: logical_height.round() as u32,
                    focused: false,
                    is_on_screen: frame.is_on_screen,
                    elevated: None,
                };
                let geometry = FrameGeometry::for_window(&window, width, height);
                Ok(Some((frame.into_image(), geometry)))
            },
            Target::Desktop | Target::Display(_) => {
                let selector = target.display_selector().unwrap_or_else(|| self.selector.clone());
                let displays = self.displays_for(&selector)?;
                let requests: Vec<_> = displays
                    .iter()
                    .filter_map(|display| {
                        display
                            .id
                            .parse::<u32>()
                            .ok()
                            .map(|id| super::sck::target_display(id, exclude_window_titles))
                    })
                    .collect();
                if requests.len() != displays.len() {
                    return self
                        .capture_desktop(&selector)
                        .map(|(image, geometry)| Some((image, geometry.into_legacy_capture())));
                }
                match SckWorker::capture(&requests) {
                    Ok(frames) => composite_sck(&displays, frames).map(Some),
                    Err(SckCaptureError::Start) => Ok(None),
                    Err(SckCaptureError::Failed(error)) => Err(error),
                }
            },
        }
    }

    /// The pre-B9 route: `screencapture` per shot, marked `legacyCapture`.
    /// The cursor overlay stays hidden and locked, exactly as before B9.
    fn capture_via_legacy(&self, target: &Target) -> CoreResult<(RgbaImage, FrameGeometry)> {
        let (image, geometry) = match target {
            Target::Window(id) => self.capture_window(id)?,
            Target::Desktop | Target::Display(_) => {
                let selector = target.display_selector().unwrap_or_else(|| self.selector.clone());
                self.capture_desktop(&selector)?
            },
        };
        Ok((image, geometry.into_legacy_capture()))
    }
}

/// Pairs SCK display frames with their displays and composites them.
fn composite_sck(
    displays: &[DesktopDisplay],
    frames: Vec<SckFrame>,
) -> CoreResult<(RgbaImage, FrameGeometry)> {
    if frames.len() != displays.len() {
        return Err(DesktopError::capture_failed(
            "capture worker returned a partial display batch",
        ));
    }
    let regions = displays
        .iter()
        .cloned()
        .zip(frames.into_iter().map(|frame| frame.into_image()))
        .collect();
    super::displays::composite(regions)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::SckUnavailable;
    use std::cell::Cell;

    thread_local! {
        pub(crate) static AVAILABILITY: Cell<Option<Result<(), SckUnavailable>>> = const { None };
    }

    pub(crate) fn override_availability(value: Option<Result<(), SckUnavailable>>) {
        AVAILABILITY.with(|cell| cell.set(value));
    }
}

#[cfg(test)]
mod tests;
