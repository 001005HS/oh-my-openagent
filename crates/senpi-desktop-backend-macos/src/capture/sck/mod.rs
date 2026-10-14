//! The session-owned ScreenCaptureKit worker: one persistent helper per
//! session thread, reset after a transport failure, with `screencapture`
//! retained as the fallback when the worker is unavailable (macOS < 14, no
//! staged helper, or a helper that cannot start).

mod client;
mod frame;
mod protocol;

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod worker_tests;

use std::cell::RefCell;
use std::path::PathBuf;

use senpi_desktop_core::error::{CoreResult, DesktopError};

use self::client::{ClientError, HelperClient};
use self::protocol::TargetRequest;

/// The frame type `MacCapture` composites.
pub(crate) use self::frame::Frame as SckFrame;
#[cfg(test)]
pub(crate) use self::protocol::TargetRequest as SckTargetRequest;

/// A window capture request (off-Space ids resolve; minimized is refused).
pub(crate) fn target_window(id: u32) -> TargetRequest {
    TargetRequest::window(id)
}

/// A display capture request; titled windows and the given window IDs are
/// excluded from the shot.
pub(crate) fn target_display(id: u32, exclude_window_titles: &[String], exclude_window_ids: &[u32]) -> TargetRequest {
    TargetRequest::display(id, exclude_window_titles, exclude_window_ids)
}

/// Empty when build.rs could not compile the helper (no Xcode CLT); the
/// worker is then unavailable and capture falls back to `screencapture`.
const HELPER: &[u8] = include_bytes!(env!("SENPI_DESKTOP_CAPTURE_HELPER"));

/// `SENPI_DESKTOP_CAPTURE_HELPER_PROGRAM` replaces the helper binary (tests,
/// and the release pipeline's signed staging probe).
const ENV_HELPER_PROGRAM: &str = "SENPI_DESKTOP_CAPTURE_HELPER_PROGRAM";

thread_local! {
    /// The owning `MacosBackend` lives on the session thread, so its helper
    /// cannot outlive that thread or contend with another session's pipes.
    /// The temp dir staging the embedded helper lives beside it.
    static HELPER_CLIENT: RefCell<Option<(HelperClient, Option<tempfile::TempDir>)>> =
        const { RefCell::new(None) };
}

fn supports_sck() -> bool {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    version.majorVersion >= 14
}

/// Why the SCK worker cannot serve this capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SckUnavailable {
    /// macOS < 14: the caller falls back to `screencapture` and logs once.
    Unsupported,
    /// No helper is staged and none is embedded.
    HelperUnavailable,
}

/// How one helper capture failed. Start failures fall back silently; reply
/// errors surface with the worker alive; transport deaths surface after the
/// worker was reset for the next capture.
#[derive(Debug)]
pub(crate) enum SckCaptureError {
    /// The helper could not be started on macOS 14+: the caller falls back
    /// to `screencapture` and logs once.
    Start(DesktopError),
    /// The capture failed; surface this error to the caller.
    Failed(DesktopError),
}

/// The worker handle `MacCapture` holds. Cheap and stateless: the worker
/// itself is the session-thread singleton above.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SckWorker;

impl SckWorker {
    pub(crate) fn availability() -> Result<(), SckUnavailable> {
        if !supports_sck() {
            return Err(SckUnavailable::Unsupported);
        }
        if HELPER.is_empty() && std::env::var_os(ENV_HELPER_PROGRAM).is_none() {
            return Err(SckUnavailable::HelperUnavailable);
        }
        Ok(())
    }

    /// One batch capture through the persistent helper.
    pub(crate) fn capture(
        requests: &[TargetRequest],
    ) -> Result<Vec<frame::Frame>, SckCaptureError> {
        #[cfg(test)]
        if let Some(fake) = TEST_CAPTURE.with(std::cell::Cell::get) {
            return fake(requests);
        }
        HELPER_CLIENT.with_borrow_mut(|slot| {
            if slot.is_none() {
                match start_client() {
                    Ok(started) => *slot = Some(started),
                    Err(error) => return Err(SckCaptureError::Start(error)),
                }
            }
            let (client, _) = slot.as_mut().expect("capture client initialized");
            match client.capture(requests) {
                Ok(frames) => Ok(frames),
                Err(ClientError::Transport(error)) => {
                    let first_reply = !client.has_replied;
                    *slot = None;
                    Err(if first_reply {
                        SckCaptureError::Start(error)
                    } else {
                        SckCaptureError::Failed(error)
                    })
                },
                Err(ClientError::Reply(error)) => Err(SckCaptureError::Failed(error)),
            }
        })
    }
}

/// Picks the helper program: the env seam, then the embedded bytes staged
/// into a fresh private temp dir (returned so the caller can keep it alive
/// beside the client).
fn start_client() -> CoreResult<(HelperClient, Option<tempfile::TempDir>)> {
    #[cfg(test)]
    if let Some(program) = test_support::program() {
        return HelperClient::start(&program).map(|client| (client, None));
    }
    if let Some(program) = std::env::var_os(ENV_HELPER_PROGRAM).map(PathBuf::from) {
        return HelperClient::start(&program).map(|client| (client, None));
    }
    if HELPER.is_empty() {
        return Err(DesktopError::capture_failed(
            "no ScreenCaptureKit capture helper is staged",
        ));
    }
    let dir = tempfile::Builder::new()
        .prefix("senpi-desktop-capture-")
        .tempdir()
        .map_err(|error| {
            DesktopError::internal(format!("cannot stage the capture helper: {error}"))
        })?;
    let program = dir.path().join("senpi-desktop-capture-helper");
    std::fs::write(&program, HELPER)
        .map_err(|error| {
            DesktopError::internal(format!("cannot write the capture helper: {error}"))
        })?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| {
                DesktopError::internal(format!(
                    "cannot mark the capture helper executable: {error}"
                ))
            })?;
    }
    let client = HelperClient::start(&program)?;
    Ok((client, Some(dir)))
}

#[cfg(test)]
type CaptureDouble = fn(&[TargetRequest]) -> Result<Vec<frame::Frame>, SckCaptureError>;

#[cfg(test)]
thread_local! {
    static TEST_CAPTURE: std::cell::Cell<Option<CaptureDouble>> =
        const { std::cell::Cell::new(None) };
}

/// Routes `SckWorker::capture` to a test double.
#[cfg(test)]
pub(crate) fn override_capture(fake: Option<CaptureDouble>) {
    TEST_CAPTURE.with(|cell| cell.set(fake));
}
