//! Optional display-only helper shared by native input, AX and capture.
mod client;
mod coordination;
mod helper;
mod motion;
mod panel;
mod wire;

use super::focus;
use client::Helper;
use parking_lot::Mutex;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use std::sync::Arc;
use std::path::Path;
use std::time::Duration;
use wire::Command;

pub(crate) use helper::run;
pub(crate) use coordination::path as lock_path;

/// WindowServer identity shared by every session's private overlay helper.
pub(crate) const WINDOW_TITLE: &str = "senpi-desktop-cursor-overlay";

#[derive(Debug, Default)]
struct State {
    helper: Option<Helper>,
    token: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Overlay(Arc<Mutex<State>>);

impl Overlay {
    pub fn configure(&self, enabled: bool) {
        let mut state = self.0.lock();
        state.helper = None;
        if enabled {
            match Helper::start() {
                Ok(helper) => {
                    state.helper = Some(helper);
                }
                Err(error) => eprintln!("cursor-overlay: unavailable: {error}"),
            }
        }
    }

    pub fn available(&self) -> bool {
        let mut state = self.0.lock();
        let Some(helper) = state.helper.as_mut() else {
            return false;
        };
        match helper.running() {
            Ok(true) => true,
            Ok(false) => {
                state.helper = None;
                false
            }
            Err(error) => {
                eprintln!("cursor-overlay: liveness check failed; disabling: {error}");
                state.helper = None;
                false
            }
        }
    }

    #[cfg(test)]
    pub fn owner_pid(&self) -> Option<u32> {
        if !self.available() {
            return None;
        }
        self.0.lock().helper.as_ref().map(Helper::pid)
    }

    pub fn target(&self, x: f64, y: f64) {
        let mut state = self.0.lock();
        state.token = state.token.wrapping_add(1);
        let token = state.token;
        if let Some(helper) = state.helper.as_mut() {
            if let Err(error) = helper.send(Command::Target { token, x, y }) {
                eprintln!("cursor-overlay: input display disabled: {error}");
                state.helper = None;
            }
        }
    }

    /// One hide/ACK scope for every capture route, including fallbacks.
    /// If hiding fails, kill/reap first; refuse pixels if a window remains.
    pub fn capture<T>(
        &self,
        path: &Path,
        window_info: impl FnOnce() -> CoreResult<Vec<focus::WindowInfo>>,
        wait: impl FnMut(Duration),
        capture: impl FnOnce() -> CoreResult<T>,
    ) -> CoreResult<T> {
        let token = {
            let mut state = self.0.lock();
            state.token = state.token.wrapping_add(1);
            let token = state.token;
            if let Some(helper) = state.helper.as_mut() {
                match helper.send(Command::Hide { token }) {
                    Ok(reply) if !reply.visible => {}
                    Ok(_) => state.helper = None,
                    Err(error) => {
                        eprintln!(
                            "cursor-overlay: hide failed; terminating before capture: {error}"
                        );
                        state.helper = None;
                    }
                }
            }
            token
        };
        let _hidden = Hidden {
            overlay: self.clone(),
            token,
        };
        // A title check alone races another session's next render. The
        // exclusive scope prevents every helper from appearing during pixels.
        let _capture = coordination::open(path)
            .and_then(|file| coordination::capture(file, wait))
            .map_err(|error| {
                DesktopError::capture_failed(format!(
                    "cursor exclusion lock '{}' unavailable; capture refused: {error}",
                    path.display()
                ))
            })?;
        let windows = window_info().map_err(|error| {
            DesktopError::capture_failed(format!("cannot verify cursor exclusion: {error}"))
        })?;
        ensure_hidden(&windows)?;
        capture()
    }
}

fn ensure_hidden(windows: &[focus::WindowInfo]) -> CoreResult<()> {
    if windows.iter().any(|window| window.cursor_overlay && window.on_screen) {
        return Err(DesktopError::capture_failed(
            "a cursor overlay is still visible; capture refused",
        ));
    }
    Ok(())
}

struct Hidden {
    overlay: Overlay,
    token: u64,
}

impl Drop for Hidden {
    fn drop(&mut self) {
        let mut state = self.overlay.0.lock();
        if let Some(helper) = state.helper.as_mut() {
            if let Err(error) = helper.send(Command::Resume { token: self.token }) {
                eprintln!("cursor-overlay: resume failed; disabling: {error}");
                state.helper = None;
            }
        }
    }
}

#[cfg(test)]
mod motion_tests;

#[cfg(test)]
#[path = "visibility_tests.rs"]
mod visibility_tests;

#[cfg(test)]
mod orchestration_tests;

#[cfg(test)]
mod capture_budget_tests;

#[cfg(test)]
mod account_path_tests;
