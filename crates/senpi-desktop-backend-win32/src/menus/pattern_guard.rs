//! Providers known to activate their window during UIA actions.

use senpi_desktop_core::error::CoreResult;

use super::failed;
use crate::delivery;

/// Refuses a background UIA command on a provider that takes foreground while
/// it acts; the caller exempts a window that already owns foreground.
pub(crate) fn require_safe(
    class: &str,
    image: Option<&str>,
    embedded_chromium: bool,
) -> CoreResult<()> {
    let xaml_image = image.is_some_and(|path| {
        let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
        [
            "notepad.exe",
            "calculatorapp.exe",
            "calc.exe",
            "applicationframehost.exe",
            "photos.exe",
            "systemsettings.exe",
        ]
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known))
    });
    let activating = embedded_chromium
        || xaml_image
        || delivery::is_chromium_class(class)
        || delivery::is_wpf_class(class)
        || delivery::is_uwp_frame_class(class)
        || delivery::is_winui3_class(class)
        || class == "Microsoft.UI.Content.DesktopChildSiteBridge";
    if activating {
        return Err(failed(
            "this window can take foreground during UI Automation actions; no command was dispatched; explicitly focus the target first",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_self_activating_providers_require_existing_foreground() {
        for (class, image, embedded) in [
            ("Chrome_WidgetWin_1", None, false),
            ("HwndWrapper[window]", None, false),
            ("ApplicationFrameWindow", None, false),
            ("WinUIDesktopWin32WindowClass", None, false),
            ("Microsoft.UI.Content.DesktopChildSiteBridge", None, false),
            ("Notepad", Some("C:\\Windows\\NOTEPAD.EXE"), false),
            ("Custom", Some("C:/Windows/SystemApps/Photos.exe"), false),
            ("Custom", None, true),
        ] {
            assert!(require_safe(class, image, embedded).is_err());
        }
        assert!(require_safe("Custom", None, false).is_ok());
        assert!(require_safe("Custom", Some("C:/notepad.exe/other.exe"), false).is_ok());
    }
}
