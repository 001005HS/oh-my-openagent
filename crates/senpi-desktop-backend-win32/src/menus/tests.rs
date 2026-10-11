//! Portable policy tests and dispatch-boundary regression checks.

use super::native::{Entry, Level, NativeMenu};
use super::*;
use senpi_desktop_core::menus::MenuItem;
use std::cell::{Cell, RefCell};

#[test]
fn native_labels_decode_mnemonics_and_accelerators() {
    for (raw, title, shortcut) in [
        ("&Open...\tCtrl+O", "Open...", Some("Ctrl+O")),
        ("Rock && &Roll", "Rock & Roll", None),
        ("&Über…\t  Alt+Ü  ", "Über…", Some("Alt+Ü")),
        ("Save &\t ", "Save &", None),
    ] {
        assert_eq!(
            native_label(raw),
            (title.into(), shortcut.map(str::to_owned))
        );
    }
}

#[test]
fn native_command_ids_are_never_silently_truncated() {
    assert_eq!(native_message(42, 3, 0).unwrap(), (0x111, 42));
    assert_eq!(native_message(0, 3, 0).unwrap(), (0x111, 0));
    assert_eq!(native_message(65535, 3, 0).unwrap(), (0x111, 65535));
    assert!(native_message(65536, 3, 0).is_err());
    assert!(native_message(u32::MAX, 3, 0).is_err());
    assert_eq!(
        native_message(u32::MAX, 3, NOTIFY_BY_POSITION).unwrap(),
        (0x126, 3)
    );
}

#[test]
fn uia_commands_prefer_invoke_then_nonempty_legacy_then_toggle() {
    assert_eq!(
        uia_command(true, Some(""), true).unwrap(),
        UiaCommand::Invoke
    );
    assert_eq!(
        uia_command(false, Some("Press"), true).unwrap(),
        UiaCommand::Legacy
    );
    assert!(uia_command(false, Some(" "), true).is_err());
    assert_eq!(uia_command(false, None, true).unwrap(), UiaCommand::Toggle);
    assert!(uia_command(false, None, false).is_err());
}

#[test]
fn native_item_count_is_bounded() {
    assert_eq!(native::bounded_count(512).unwrap(), MAX_ITEMS);
    assert!(native::bounded_count(513).is_err());
    assert!(native::bounded_count(-1).is_err());
}

#[derive(Default)]
struct Fixture {
    detached: Cell<bool>,
    changed_count: Cell<bool>,
    change_at_style: bool,
    count_at_style: bool,
    disabled: bool,
    disabled_parent: bool,
    ambiguous: bool,
    renamed: Cell<bool>,
    reads: Cell<usize>,
    rename_after_read: bool,
    root_style: u32,
    submenu_style: u32,
    dispatched: RefCell<Vec<(u32, usize)>>,
    calls: RefCell<Vec<&'static str>>,
}

impl NativeMenu for Fixture {
    fn level(&self, menu: usize, path: &[String]) -> CoreResult<Level> {
        let mut rows = if menu == 1 {
            vec![("File", 0, 2, !self.disabled_parent)]
        } else {
            vec![
                ("Open...", 42, 0, !self.disabled),
                ("Recent", 0, 3, true),
                ("", 0, 0, true),
            ]
        };
        if self.ambiguous && menu == 2 {
            rows.push(("Open...", 43, 0, true));
        }
        if self.renamed.get() && menu == 2 {
            rows[0].1 = 99;
        }
        let count = rows.len() as i32;
        let mut items = Vec::new();
        let mut entries = Vec::new();
        for (position, (title, id, submenu, enabled)) in rows.into_iter().enumerate() {
            let mut canonical = path.to_vec();
            canonical.push(title.into());
            items.push(MenuItem {
                title: title.into(),
                path: canonical,
                enabled,
                checked: false,
                has_submenu: submenu != 0,
                shortcut: None,
            });
            entries.push(Entry {
                menu,
                position: position as u32,
                id,
                submenu,
            });
        }
        self.reads.set(self.reads.get() + 1);
        if self.rename_after_read && self.reads.get() == 2 {
            self.renamed.set(true);
        }
        Ok(Level {
            items,
            entries,
            count,
        })
    }
    fn attached(&self, _root: usize) -> CoreResult<()> {
        self.calls.borrow_mut().push("attached");
        if self.detached.get() {
            Err(failed("detached"))
        } else {
            Ok(())
        }
    }
    fn count(&self, menu: usize) -> CoreResult<i32> {
        self.calls.borrow_mut().push("count");
        Ok(if menu == 1 {
            1
        } else if self.changed_count.get() {
            4
        } else {
            3
        })
    }
    fn style(&self, menu: usize) -> CoreResult<u32> {
        self.detached.set(self.change_at_style);
        self.changed_count.set(self.count_at_style);
        Ok(if menu == 1 { self.root_style } else { self.submenu_style })
    }
    fn dispatch(&self, _entry: Entry, message: u32, wparam: usize) -> CoreResult<()> {
        self.calls.borrow_mut().push("dispatch");
        self.dispatched.borrow_mut().push((message, wparam));
        Ok(())
    }
}

fn path(labels: &[&str]) -> Vec<String> {
    labels.iter().map(|label| (*label).into()).collect()
}

#[test]
fn native_listing_and_normalized_selection_dispatch_once() {
    let source = Fixture::default();
    let items = native::items(&source, 1, &path(&["file"])).unwrap();
    assert_eq!(items[0].path, path(&["File", "Open..."]));
    native::select(&source, 1, &path(&["File", "Open"]), &|| Ok(())).unwrap();
    assert_eq!(*source.dispatched.borrow(), vec![(0x111, 42)]);
}

#[test]
fn native_refusals_dispatch_nothing() {
    for (source, labels) in [
        (
            Fixture {
                disabled_parent: true,
                ..Fixture::default()
            },
            vec!["File", "Open"],
        ),
        (
            Fixture {
                disabled: true,
                ..Fixture::default()
            },
            vec!["File", "Open"],
        ),
        (
            Fixture {
                ambiguous: true,
                ..Fixture::default()
            },
            vec!["File", "Open"],
        ),
        (Fixture::default(), vec!["File", "Recent"]),
        (Fixture::default(), vec!["File", ""]),
        (Fixture::default(), vec!["File", "Open", "child"]),
        (
            Fixture {
                rename_after_read: true,
                ..Fixture::default()
            },
            vec!["File", "Open"],
        ),
    ] {
        assert!(native::select(&source, 1, &path(&labels), &|| Ok(())).is_err());
        assert!(source.dispatched.borrow().is_empty());
    }
}

#[test]
fn detached_menu_after_resolution_never_dispatches() {
    let source = Fixture {
        change_at_style: true,
        ..Fixture::default()
    };
    assert!(native::select(&source, 1, &path(&["File", "Open"]), &|| Ok(())).is_err());
    assert!(source.dispatched.borrow().is_empty());
}

#[test]
fn changed_count_after_resolution_never_dispatches() {
    let source = Fixture {
        count_at_style: true,
        ..Fixture::default()
    };
    assert!(native::select(&source, 1, &path(&["File", "Open"]), &|| Ok(())).is_err());
    assert!(source.dispatched.borrow().is_empty());
}

#[test]
fn the_menu_bar_style_alone_selects_position_notification() {
    let by_position = Fixture {
        root_style: NOTIFY_BY_POSITION,
        ..Fixture::default()
    };
    native::select(&by_position, 1, &path(&["File", "Open"]), &|| Ok(())).unwrap();
    assert_eq!(*by_position.dispatched.borrow(), vec![(0x126, 0)]);
    let submenu_only = Fixture {
        submenu_style: NOTIFY_BY_POSITION,
        ..Fixture::default()
    };
    native::select(&submenu_only, 1, &path(&["File", "Open"]), &|| Ok(())).unwrap();
    assert_eq!(*submenu_only.dispatched.borrow(), vec![(0x111, 42)]);
}

#[test]
fn the_last_stop_check_runs_after_every_revalidation_and_right_before_dispatch() {
    let source = Fixture::default();
    let stop = || {
        source.calls.borrow_mut().push("stop");
        Ok(())
    };
    native::select(&source, 1, &path(&["File", "Open"]), &stop).unwrap();
    let calls = source.calls.borrow();
    assert_eq!(calls[calls.len() - 2..], ["stop", "dispatch"]);
    let last_revalidation = calls.iter().rposition(|call| *call != "stop" && *call != "dispatch");
    assert_eq!(last_revalidation, Some(calls.len() - 3));
}

#[test]
fn stop_at_each_level_or_immediately_before_dispatch_prevents_command() {
    for halt in 1..=5 {
        let source = Fixture::default();
        let calls = Cell::new(0);
        let stop = || {
            calls.set(calls.get() + 1);
            if calls.get() == halt {
                Err(failed("stopped"))
            } else {
                Ok(())
            }
        };
        assert!(native::select(&source, 1, &path(&["File", "Open"]), &stop).is_err());
        assert_eq!(calls.get(), halt);
        assert!(source.dispatched.borrow().is_empty());
    }
}
