//! Binds a menu request to the exact window it names. A frame picked by
//! title or geometry could be a sibling window of the same application, so
//! the frame is proven to be the requested window before any discovery and
//! again before the action.

use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::types::DesktopWindow;

use crate::apps::{frames, window_root};
use crate::bus::AtSpiBus;
use crate::owner::native_owner;
use crate::WindowIds;

/// The window a menu request names, in the host backend's id space, with
/// the backend's full window list for native correlation.
#[derive(Clone, Copy)]
pub(crate) struct MenuTarget<'a> {
    pub(crate) window: &'a DesktopWindow,
    pub(crate) ids: WindowIds,
    pub(crate) windows: &'a [DesktopWindow],
}

fn unbound(window: &DesktopWindow) -> DesktopError {
    DesktopError::ax_failed(format!(
        "AT-SPI menu: no accessible frame is provably window {}; no command was dispatched",
        window.id
    ))
}

/// The frame that is `target.window`: looked up by object id when window ids
/// are AT-SPI frames, else the correlated frame whose native owner is proven.
pub(crate) fn bound_root<B: AtSpiBus>(bus: &mut B, target: MenuTarget<'_>) -> CoreResult<B::Node> {
    match target.ids {
        WindowIds::AtSpiFrames => {
            let applications = bus.applications().map_err(DesktopError::ax_failed)?;
            let mut matches = Vec::new();
            for app in applications {
                for frame in frames(bus, &app).map_err(DesktopError::ax_failed)? {
                    if bus.object_id(&frame) == target.window.id {
                        matches.push(frame);
                    }
                }
            }
            match <[B::Node; 1]>::try_from(matches) {
                Ok([frame]) => Ok(frame),
                Err(_) => Err(unbound(target.window)),
            }
        }
        WindowIds::Native => {
            let frame = window_root(bus, target.window)?;
            require_bound(bus, &frame, target)?;
            Ok(frame)
        }
    }
}

/// Refuses unless `frame` is `target.window` in the host backend's id space.
pub(crate) fn require_bound<B: AtSpiBus>(bus: &mut B, frame: &B::Node, target: MenuTarget<'_>) -> CoreResult<()> {
    let id = match target.ids {
        WindowIds::AtSpiFrames => Some(bus.object_id(frame)),
        WindowIds::Native => native_owner(bus, frame, target.windows)?,
    };
    if id.as_deref() == Some(target.window.id.as_str()) {
        Ok(())
    } else {
        Err(unbound(target.window))
    }
}
