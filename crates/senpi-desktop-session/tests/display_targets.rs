use std::sync::Arc;

use senpi_desktop_backend_fake::FakeScenario;
use senpi_desktop_core::error::ErrorCode;
use senpi_desktop_core::protocol_params::{CaptureParams, PointParams};
use senpi_desktop_core::types::{CaptureResult, DesktopSessionOptions};
use senpi_desktop_safety::{FakeClock, StopPathId, Supervisor};
use senpi_desktop_session::{
    BackendSelection, Op, Response, Session, SessionSafety, SessionTimeouts,
};

async fn capture(session: &Session, target: &str) -> CaptureResult {
    let response = session
        .submit(Op::Capture(CaptureParams {
            target: target.into(),
            caps: None,
        }))
        .wait()
        .await
        .unwrap();
    let Response::Capture(capture) = response else {
        panic!("expected capture")
    };
    capture
}

#[tokio::test]
async fn per_call_display_frames_survive_other_target_captures_without_reopening() {
    let scenario = FakeScenario::from_json(include_str!(
        "../../senpi-desktop-backend-fake/fixtures/two-displays-one-window.json"
    ))
    .unwrap();
    let supervisor = Arc::new(Supervisor::new(Arc::new(FakeClock::new(0))));
    supervisor.set_live(StopPathId::Global, true);
    let safety = SessionSafety {
        supervisor,
        audit: Box::new(|_| {}),
        control_slot: senpi_desktop_session::ControlSlot::new(),
    };
    let session = Session::start_supervised(
        BackendSelection::FakeScenario(Box::new(scenario)),
        SessionTimeouts::default(),
        safety,
    )
    .unwrap();
    session
        .open(DesktopSessionOptions::default())
        .wait()
        .await
        .unwrap();

    let desktop = capture(&session, "desktop").await;
    let selected = capture(&session, "display:2").await;
    let all = capture(&session, "display:all").await;
    assert_eq!(
        (selected.source_width, selected.source_height),
        (2880, 1800)
    );
    assert_eq!((all.source_width, all.source_height), (4800, 1800));
    assert_eq!(selected.target, "display:2");
    assert_ne!(selected.frame_id, desktop.frame_id);
    for (target, frame_id) in [
        ("desktop", desktop.frame_id),
        ("display:2", selected.frame_id.clone()),
    ] {
        let moved = session
            .submit(Op::MoveMouse(PointParams {
                target: target.into(),
                x: 20.0,
                y: 10.0,
                frame_id: Some(frame_id),
                opts: None,
            }))
            .wait()
            .await;
        assert_eq!(moved, Ok(Response::Unit));
    }
    let wrong_frame = session
        .submit(Op::MoveMouse(PointParams {
            target: "desktop".into(),
            x: 20.0,
            y: 10.0,
            frame_id: Some(selected.frame_id),
            opts: None,
        }))
        .wait()
        .await
        .unwrap_err();
    assert_eq!(wrong_frame.code, ErrorCode::InvalidCoordinateFrame);
    let invalid = session
        .submit(Op::Capture(CaptureParams {
            target: "display:missing".into(),
            caps: None,
        }))
        .wait()
        .await
        .unwrap_err();
    assert_eq!(invalid.code, ErrorCode::InvalidTarget);
}
