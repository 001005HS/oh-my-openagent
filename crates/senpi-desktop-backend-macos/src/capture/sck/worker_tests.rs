//! Restart regressions through the real session-thread worker and child pipes.

use super::test_support::{fake_helper, ProgramGuard, PY_PREAMBLE};
use super::{target_window, SckCaptureError, SckWorker};

fn capture_after_transport_failure(first_reply: &str, started: bool) {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(
        &dir,
        &format!(
            "{PY_PREAMBLE}
import os, pathlib

read_request()
marker = pathlib.Path(__file__).with_suffix('.started')
if not marker.exists():
    marker.touch()
{first_reply}
    os._exit(1)
header({{
    'kind': 'frame', 'index': 0, 'width': 1, 'height': 1, 'byteLength': 4,
    'bounds': {{'x': 0.0, 'y': 0.0, 'width': 1.0, 'height': 1.0}}
}})
pixels(1, 1, [56, 34, 12, 255])
"
        ),
    );
    let _program = ProgramGuard::new(helper);
    let requests = [target_window(42)];
    let first = SckWorker::capture(&requests);
    if started {
        assert!(matches!(first, Err(SckCaptureError::Failed(_))), "{first:?}");
    } else {
        assert!(matches!(first, Err(SckCaptureError::Start(_))), "{first:?}");
    }
    let frames = SckWorker::capture(&requests).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].image.as_raw(), &[12, 34, 56, 255]);
}

#[test]
fn a_worker_dying_during_its_first_capture_restarts_for_the_next_capture() {
    capture_after_transport_failure(
        "    header({
        'kind': 'frame', 'index': 0, 'width': 2, 'height': 2, 'byteLength': 16,
        'bounds': {'x': 0.0, 'y': 0.0, 'width': 2.0, 'height': 2.0}
    })
    pixels(1, 1, [0, 0, 0, 255])",
        true,
    );
}

#[test]
fn a_helper_dying_before_any_reply_byte_is_a_start_failure() {
    capture_after_transport_failure("    pass", false);
}

#[test]
fn oversized_dimensions_reset_the_worker_before_the_next_capture() {
    capture_after_transport_failure(
        "    header({
        'kind': 'frame', 'index': 0, 'width': 4294967295, 'height': 1, 'byteLength': 4,
        'bounds': {'x': 0.0, 'y': 0.0, 'width': 1.0, 'height': 1.0}
    })
    pixels(1, 1, [0, 0, 0, 255])",
        true,
    );
}

#[test]
fn an_established_worker_death_surfaces_error_and_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(
        &dir,
        &format!(
            "{PY_PREAMBLE}
import os, pathlib

marker = pathlib.Path(__file__).with_suffix('.started')
first_start = not marker.exists()
marker.touch()
read_request()
header({{
    'kind': 'frame', 'index': 0, 'width': 1, 'height': 1, 'byteLength': 4,
    'bounds': {{'x': 0.0, 'y': 0.0, 'width': 1.0, 'height': 1.0}}
}})
pixels(1, 1, [56, 34, 12, 255])
if first_start:
    read_request()
    os._exit(1)
"
        ),
    );
    let _program = ProgramGuard::new(helper);
    let requests = [target_window(42)];
    assert_eq!(SckWorker::capture(&requests).unwrap().len(), 1);
    let failure = SckWorker::capture(&requests);
    assert!(matches!(failure, Err(SckCaptureError::Failed(_))), "{failure:?}");
    let frames = SckWorker::capture(&requests).unwrap();
    assert_eq!(frames[0].image.as_raw(), &[12, 34, 56, 255]);
}
