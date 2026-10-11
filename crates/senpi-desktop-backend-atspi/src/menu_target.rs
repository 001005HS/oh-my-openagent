//! Binds a menu request to the exact window it names. A frame picked by
//! title or geometry could be a sibling window of the same application, so
//! exactly one accessible frame must provably be the requested window,
//! before any discovery and again before the action.

use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::types::DesktopWindow;

use crate::apps::frames;
use crate::bus::AtSpiBus;
use crate::owner::native_owner;
use crate::WindowIds;

/// The window a menu request names, in the host backend's id space, with
/// the backend's window list for native correlation.
#[derive(Clone, Copy)]
pub(crate) struct MenuTarget<'a> {
    pub(crate) window: &'a DesktopWindow,
    pub(crate) ids: WindowIds,
    pub(crate) windows: &'a [DesktopWindow],
}

fn unbound(window: &DesktopWindow) -> DesktopError {
    DesktopError::ax_failed(format!(
        "AT-SPI menu: no single accessible frame is provably window {}; no command was dispatched",
        window.id
    ))
}

/// The one frame that is `target.window`. With AT-SPI frame ids that is the
/// frame carrying the id; with native ids it is the frame whose correlated
/// owner is the window, which refuses when a sibling (a minimized one
/// included) correlates to it too. An application that cannot be read is
/// skipped: it cannot hold the window's frame without being read.
pub(crate) fn bound_root<B: AtSpiBus>(bus: &mut B, target: MenuTarget<'_>) -> CoreResult<B::Node> {
    let mut matches = Vec::new();
    for app in bus.applications().map_err(DesktopError::ax_failed)? {
        if target.ids == WindowIds::Native && target.window.pid.is_some() && bus.process_id(&app) != target.window.pid {
            continue;
        }
        let Ok(app_frames) = frames(bus, &app) else {
            continue;
        };
        for frame in app_frames {
            let id = match target.ids {
                WindowIds::AtSpiFrames => Some(bus.object_id(&frame)),
                WindowIds::Native => native_owner(bus, &frame, target.windows).ok().flatten(),
            };
            if id.as_deref() == Some(target.window.id.as_str()) {
                matches.push(frame);
            }
        }
    }
    match <[B::Node; 1]>::try_from(matches) {
        Ok([frame]) => Ok(frame),
        Err(_) => Err(unbound(target.window)),
    }
}
