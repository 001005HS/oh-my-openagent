use image::{imageops, RgbaImage};
use senpi_desktop_core::error::{CoreResult, DesktopError};
use senpi_desktop_core::types::{DesktopDisplay, DisplaySelector};

/// Wayland exposes no focused-window geometry; Active uses the primary display.
pub(crate) fn select_capture(
    selector: &DisplaySelector,
    image: RgbaImage,
    displays: Vec<DesktopDisplay>,
) -> CoreResult<(RgbaImage, Vec<DesktopDisplay>)> {
    let selected = selector.select(displays, None)?;
    if *selector == DisplaySelector::All {
        return Ok((image, selected));
    }
    let mut display = selected
        .into_iter()
        .next()
        .expect("selector returns a nonempty display set");
    let right = display
        .pixel_x
        .checked_add(display.pixel_width)
        .ok_or_else(|| DesktopError::capture_failed("Wayland ScreenCast display width overflow"))?;
    let bottom = display
        .pixel_y
        .checked_add(display.pixel_height)
        .ok_or_else(|| {
            DesktopError::capture_failed("Wayland ScreenCast display height overflow")
        })?;
    if right > image.width() || bottom > image.height() {
        return Err(DesktopError::capture_failed(format!(
            "Wayland display '{}' lies outside the captured composite", display.id
        )));
    }
    let selected = imageops::crop_imm(
        &image,
        display.pixel_x,
        display.pixel_y,
        display.pixel_width,
        display.pixel_height,
    )
    .to_image();
    display.pixel_x = 0;
    display.pixel_y = 0;
    Ok((selected, vec![display]))
}
