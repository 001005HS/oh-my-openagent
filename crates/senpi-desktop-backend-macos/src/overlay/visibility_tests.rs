use super::{ensure_hidden, WINDOW_TITLE};
use crate::focus::WindowInfo;

#[test]
fn window_server_title_blocks_either_helpers_visible_window() {
    let helper = |pid, on_screen| WindowInfo {
        pid, window_number: pid, layer: 1000, on_screen, cursor_overlay: true,
    };
    assert!(!WINDOW_TITLE.is_empty());
    // Neither process belongs to the capturing session. Each is independently excluded.
    assert!(ensure_hidden(&[helper(77, true), helper(88, false)]).is_err());
    assert!(ensure_hidden(&[helper(77, false), helper(88, true)]).is_err());
    assert!(ensure_hidden(&[helper(77, false), helper(88, false)]).is_ok());
    assert!(ensure_hidden(&[WindowInfo { cursor_overlay: false, ..helper(77, true) }]).is_ok());
}
