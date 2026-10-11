//! Exact-window menus: attached HMENU first, bounded owned UIA otherwise.

mod native;
mod target;
mod uia;
mod uia_command;
mod uia_tree;

use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::menus::{validate_path, MenuItem};
use senpi_desktop_core::types::DesktopWindow;

use super::Win32Ax;
use crate::integrity::IntegrityRid;

/// Raises the proven target window for foreground delivery.
pub(crate) type RaiseWindow<'a> = &'a dyn Fn(&str) -> CoreResult<()>;

impl Win32Ax {
    pub(crate) fn menu_items(
        &mut self,
        window: &DesktopWindow,
        path: &[String],
        integrity: IntegrityRid,
    ) -> CoreResult<Vec<MenuItem>> {
        validate_path(path, true)?;
        let target = target::Target::new(window, integrity)?;
        let root = target.menu();
        if root == 0 {
            uia::UiaMenus::new(self, &target, &|| Ok(()))?.items(path)
        } else {
            crate::menus::native::items(&native::Native(&target), root, path)
        }
    }

    pub(crate) fn menu_select(
        &mut self,
        window: &DesktopWindow,
        path: &[String],
        integrity: IntegrityRid,
        check_stop: &dyn Fn() -> CoreResult<()>,
        raise: Option<RaiseWindow<'_>>,
    ) -> CoreResult<()> {
        validate_path(path, false)?;
        check_stop()?;
        let target = target::Target::new(window, integrity)?;
        if let Some(raise) = raise {
            raise(&window.id)?;
        }
        let root = target.menu();
        if root == 0 {
            uia::UiaMenus::new(self, &target, check_stop)?.select(path)
        } else {
            crate::menus::native::select(&native::Native(&target), root, path, check_stop)
        }
    }
}

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod live_uia_tests;
#[cfg(test)]
mod live_window;
