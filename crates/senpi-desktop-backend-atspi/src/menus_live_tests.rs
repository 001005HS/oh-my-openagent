//! Live menu checks against a real GTK menu bar over a real AT-SPI bus.
//! `#[ignore]`d; each needs a fresh session of its own:
//!
//! `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" cargo test
//! -p senpi-desktop-backend-atspi --lib -- --ignored --exact --nocapture <name>`
//!
//! The fixture (`tests/fixtures/menu_fixture.py`, `python3-gi` + GTK 3)
//! appends `<label>@<title>` to its record file for every command it runs.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::types::DesktopWindow;

use crate::{AtSpiAx, WindowIds};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/menu_fixture.py");
const DEADLINE: Duration = Duration::from_secs(30);

struct Fixture {
    child: Child,
    record: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(err) = self.child.kill().and_then(|()| self.child.wait().map(drop)) {
            eprintln!("fixture cleanup failed: {err}");
        }
        drop(std::fs::remove_file(&self.record));
    }
}

fn spawn_fixture(title: &str) -> Fixture {
    let record = std::env::temp_dir().join(format!("{title}.record"));
    std::fs::write(&record, "").unwrap();
    let child = Command::new("python3")
        .args([FIXTURE, title, record.to_str().unwrap()])
        .env("GTK_MODULES", "gail:atk-bridge")
        .env("NO_AT_BRIDGE", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    Fixture { child, record }
}

fn until<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(started.elapsed() < DEADLINE, "{what} never happened");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn find_window(ax: &mut AtSpiAx, title: &str) -> Option<DesktopWindow> {
    ax.windows().ok()?.into_iter().find(|window| window.title == title)
}

fn recorded(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn labels(path: &[&str]) -> Vec<String> {
    path.iter().map(|label| (*label).to_string()).collect()
}

fn no_stop() -> CoreResult<()> {
    Ok(())
}

#[test]
#[ignore = "live: needs an AT-SPI bus (dbus-run-session), an X display, and python3-gi with GTK 3"]
fn menu_listing_and_select_against_a_real_gtk_menu_bar() {
    let title = format!("senpi-atspi-menu-{}", std::process::id());
    let fixture = spawn_fixture(&title);
    let mut ax = AtSpiAx::new(WindowIds::AtSpiFrames).unwrap();
    let window = until("the fixture window", || find_window(&mut ax, &title));
    println!("window_id={} pid={:?}", window.id, window.pid);

    let bar = ax.menu_items(&window, &[]).unwrap();
    let bar_titles: Vec<&str> = bar.iter().map(|item| item.title.as_str()).collect();
    println!("menu_bar={bar_titles:?}");
    assert_eq!(bar_titles, ["File", "Edit"]);

    let file = ax.menu_items(&window, &labels(&["File"])).unwrap();
    let file_titles: Vec<&str> = file.iter().map(|item| item.title.as_str()).collect();
    println!("file_menu={file_titles:?} save_shortcut={:?}", file[1].shortcut);
    assert_eq!(file_titles, ["Open...", "Save", "Recent"]);
    assert_eq!(file[1].shortcut.as_deref(), Some("<Primary>s"));
    assert!(file[2].has_submenu);

    ax.menu_select(&window, &labels(&["file", "save"]), &no_stop).unwrap();
    until("Save to be recorded", || {
        Some(recorded(&fixture.record)).filter(|text| text.contains("Save@"))
    });
    ax.menu_select(&window, &labels(&["File", "Open"]), &no_stop).unwrap();
    ax.menu_select(&window, &labels(&["File", "Recent", "a.txt"]), &no_stop).unwrap();
    let after = until("all three commands to be recorded", || {
        Some(recorded(&fixture.record)).filter(|text| text.lines().count() == 3)
    });
    println!("recorded={after:?}");
    assert_eq!(
        after,
        format!("Save@{title}\nOpen...@{title}\na.txt@{title}\n")
    );

    let disabled = ax.menu_select(&window, &labels(&["Edit", "Undo"]), &no_stop).unwrap_err();
    let submenu = ax.menu_select(&window, &labels(&["File", "Recent"]), &no_stop).unwrap_err();
    println!("disabled_error={} submenu_error={}", disabled.message, submenu.message);
    assert!(disabled.message.contains("disabled"), "{}", disabled.message);
    assert!(submenu.message.contains("leaf menu command"), "{}", submenu.message);
    // The app runs actions in order, so once a later sentinel command is recorded,
    // anything a refused path had dispatched would already be in the file.
    ax.menu_select(&window, &labels(&["File", "Save"]), &no_stop).unwrap();
    let last = until("the sentinel Save", || {
        Some(recorded(&fixture.record)).filter(|text| text.lines().count() >= 4)
    });
    assert_eq!(last, format!("{after}Save@{title}\n"), "a refused path ran a command");
}
