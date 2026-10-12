//! Wire tests against fake helpers: real child processes speaking (or
//! breaking) the helper protocol, so transport, reset, and error mapping all
//! run against the actual pipe code.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use senpi_desktop_core::error::ErrorCode;

use super::client::HelperClient;
use super::protocol::TargetRequest;

/// A fake helper: an executable Python script at `path`.
fn fake_helper(dir: &tempfile::TempDir, body: &str) -> PathBuf {
    let path = dir.path().join("helper.py");
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

const PY_PREAMBLE: &str = r#"#!/usr/bin/env python3
import json, struct, sys

def header(value):
    sys.stdout.buffer.write((json.dumps(value) + "\n").encode())
    sys.stdout.buffer.flush()

def pixels(width, height, bgra):
    sys.stdout.buffer.write(bytes(bgra) * (width * height))
    sys.stdout.buffer.flush()

def read_request():
    line = sys.stdin.buffer.readline()
    return json.loads(line.decode())
"#;

fn request_batch(targets: &[TargetRequest]) -> Vec<TargetRequest> {
    targets.to_vec()
}

#[test]
fn frame_reply_decodes_rgba_and_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nread_request()\nheader({{'kind':'frame','index':0,'width':2,'height':1,'byteLength':8,'isOnScreen':True,'bounds':{{'x':10.0,'y':20.0,'width':2.0,'height':1.0}}}})\npixels(2, 1, [56, 34, 12, 255, 1, 2, 3, 255])\n"
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let frames = client
        .capture(&request_batch(&[TargetRequest::window(42)]))
        .unwrap();
    assert_eq!(frames.len(), 1);
    let frame = &frames[0];
    assert_eq!(frame.bounds, (10.0, 20.0, 2.0, 1.0));
    assert_eq!(frame.is_on_screen, Some(true));
    assert_eq!(
        frame.image.as_raw(),
        &vec![12, 34, 56, 255, 3, 2, 1, 255]
    );
}

#[test]
fn excluded_titles_reach_the_helper_on_display_requests() {
    let dir = tempfile::tempdir().unwrap();
    let capture_log = dir.path().join("request.json");
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nreq = read_request()\nopen(r'{capture}', 'w').write(json.dumps(req))\nheader({{'kind':'frame','index':0,'width':1,'height':1,'byteLength':4,'bounds':{{'x':0.0,'y':0.0,'width':1.0,'height':1.0}}}})\npixels(1, 1, [0, 0, 0, 255])\n",
        capture = capture_log.display()
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let targets = request_batch(&[TargetRequest::display(7, &["OmO HUD".to_owned(), "Pi".to_owned()])]);
    client.capture(&targets).unwrap();
    let sent: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&capture_log).unwrap()).unwrap();
    assert_eq!(
        sent["requests"][0]["excludeWindowTitles"],
        serde_json::json!(["OmO HUD", "Pi"])
    );
    assert_eq!(sent["requests"][0]["kind"], serde_json::json!("display"));
}

#[test]
fn capture_unavailable_maps_reason_without_resetting_the_worker() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nread_request()\nheader({{'kind':'error','code':'CaptureUnavailable','reason':'minimized','error':'The window is minimized'}})\nheader({{'kind':'frame','index':0,'width':1,'height':1,'byteLength':4,'bounds':{{'x':0.0,'y':0.0,'width':1.0,'height':1.0}}}})\n# second request served below\nread_request()\npixels(1, 1, [9, 9, 9, 255])\n"
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::window(9)])).unwrap_err();
    assert_eq!(error.code, ErrorCode::CaptureUnavailable);
    assert_eq!(
        error.capture_unavailable.map(|data| data.reason),
        Some("minimized".to_owned())
    );
    // A reply-level error keeps the worker alive: the next capture succeeds.
    let frames = client.capture(&request_batch(&[TargetRequest::window(9)])).unwrap();
    assert_eq!(frames.len(), 1);
}

#[test]
fn permission_denied_maps_through_the_tcc_guidance() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nread_request()\nheader({{'kind':'error','code':'PermissionDenied','error':'Screen Recording permission is not granted'}})\n"
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::display(1, &[])])).unwrap_err();
    assert_eq!(error.code, ErrorCode::PermissionDenied);
}

#[test]
fn a_dead_helper_is_a_transport_failure() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, "#!/usr/bin/env python3\nimport os\nos._exit(1)\n");
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::window(1)])).unwrap_err();
    assert_eq!(error.code, ErrorCode::CaptureFailed);
    assert!(
        error.message.contains("exited before returning") || error.message.contains("transport"),
        "{}",
        error.message
    );
}

#[test]
fn a_truncated_frame_is_a_transport_failure() {
    let dir = tempfile::tempdir().unwrap();
    // Announces 16 bytes then closes after 4.
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nread_request()\nheader({{'kind':'frame','index':0,'width':2,'height':2,'byteLength':16,'bounds':{{'x':0.0,'y':0.0,'width':2.0,'height':2.0}}}})\nsys.stdout.buffer.write(bytes(4))\nsys.stdout.buffer.flush()\nimport os; os._exit(0)\n"
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::window(1)])).unwrap_err();
    assert!(
        error.message.contains("truncated") || error.message.contains("exceeded its"),
        "{}",
        error.message
    );
}

#[test]
fn a_garbage_header_is_a_transport_failure() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, "#!/usr/bin/env python3\nimport sys\nsys.stdout.write('not json\\n')\nsys.stdout.flush()\n");
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::window(1)])).unwrap_err();
    assert!(error.message.contains("invalid native capture response"), "{}", error.message);
}

#[test]
fn an_unsupported_reply_is_an_internal_bug_on_modern_macos() {
    let dir = tempfile::tempdir().unwrap();
    let helper = fake_helper(&dir, &format!(
        "{PY_PREAMBLE}\nread_request()\nheader({{'kind':'error','code':'Unsupported','error':'requires macOS 14'}})\n"
    ));
    let mut client = HelperClient::start(&helper).unwrap();
    let error = client.capture(&request_batch(&[TargetRequest::window(1)])).unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
}
