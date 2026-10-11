//! The menu request is bound to its exact window, and every re-check after
//! discovery refuses before any action reaches the bus.

use atspi::{Role, State};
use senpi_desktop_core::types::DesktopWindow;

use crate::fake::{FakeBus, FakeNode, EDITOR_RECT};
use crate::menu_target::MenuTarget;
use crate::menus::{items, select};
use crate::menus_tests::{actions, command, menus, no_stop, on, path, submenu, window};
use crate::WindowIds;

/// A second frame of the same application with the same title and size,
/// holding its own File > Save (node 71).
fn twin() -> FakeBus {
    let mut bus = menus();
    bus.add(15, 1, FakeNode::frame("notes.txt - gedit", EDITOR_RECT));
    bus.add(22, 15, FakeNode::new(Role::Filler, ""));
    bus.add(32, 22, FakeNode::new(Role::MenuBar, ""));
    bus.add(70, 32, submenu("File"));
    bus.add(71, 70, command("Save"));
    bus
}

fn second_window() -> DesktopWindow {
    DesktopWindow {
        id: "atspi::1.15:/org/a11y/atspi/accessible/15".into(),
        ..window()
    }
}

#[test]
fn a_command_runs_in_the_exact_window_named_not_a_same_titled_sibling() {
    let mut bus = twin();
    select(&mut bus, on(&second_window()), &path(&["File", "Save"]), &no_stop).unwrap();
    assert_eq!(actions(&bus), ["action 71 #0"]);
    select(&mut bus, on(&window()), &path(&["File", "Save"]), &no_stop).unwrap();
    assert_eq!(actions(&bus), ["action 71 #0", "action 43 #0"]);
}

#[test]
fn a_window_id_no_frame_carries_is_refused() {
    let mut bus = menus();
    let gone = DesktopWindow {
        id: "atspi::1.99:/org/a11y/atspi/accessible/99".into(),
        ..window()
    };
    let error = items(&mut bus, on(&gone), &[]).unwrap_err();
    assert!(error.message.contains("provably window"), "{}", error.message);
}

fn native(id: &str) -> DesktopWindow {
    DesktopWindow {
        id: id.into(),
        ..window()
    }
}

#[test]
fn a_native_window_one_frame_correlates_to_runs_its_command() {
    let mut bus = menus();
    let listed = [native("0x800001")];
    let target = MenuTarget {
        window: &listed[0],
        ids: WindowIds::Native,
        windows: &listed,
    };
    select(&mut bus, target, &path(&["File", "Save"]), &no_stop).unwrap();
    assert_eq!(actions(&bus), ["action 43 #0"]);
}

#[test]
fn a_native_window_a_minimized_unlisted_sibling_also_correlates_to_is_refused() {
    let mut bus = twin();
    let listed = [native("0x800001")];
    let target = MenuTarget {
        window: &listed[0],
        ids: WindowIds::Native,
        windows: &listed,
    };
    let error = select(&mut bus, target, &path(&["File", "Save"]), &no_stop).unwrap_err();
    assert!(error.message.contains("provably window"), "{}", error.message);
    assert!(actions(&bus).is_empty());
}

#[test]
fn a_native_window_whose_frame_vanished_never_falls_to_a_hidden_sibling() {
    let mut bus = twin();
    bus.nodes.remove(&10);
    let listed = [native("0x800001")];
    let target = MenuTarget {
        window: &listed[0],
        ids: WindowIds::Native,
        windows: &listed,
    };
    assert!(select(&mut bus, target, &path(&["File", "Save"]), &no_stop).is_err());
    assert!(actions(&bus).is_empty());
}

#[test]
fn a_native_window_missing_from_the_list_is_refused() {
    let mut bus = menus();
    let listed: [DesktopWindow; 0] = [];
    let target = MenuTarget {
        window: &native("0x800001"),
        ids: WindowIds::Native,
        windows: &listed,
    };
    let error = items(&mut bus, target, &[]).unwrap_err();
    assert!(error.message.contains("provably window"), "{}", error.message);
}

#[test]
fn a_native_window_its_frames_cannot_be_told_apart_from_is_refused() {
    let mut bus = twin();
    let native = DesktopWindow {
        id: "0x800001".into(),
        ..window()
    };
    let listed = [
        native.clone(),
        DesktopWindow {
            id: "0x800002".into(),
            ..window()
        },
    ];
    let target = MenuTarget {
        window: &native,
        ids: WindowIds::Native,
        windows: &listed,
    };
    let error = select(&mut bus, target, &path(&["File", "Save"]), &no_stop).unwrap_err();
    assert!(error.message.contains("provably window"), "{}", error.message);
    assert!(actions(&bus).is_empty());
}

/// Reads of File's children: 1 and 2 are the first resolve (its submenu
/// probe, then its level); 3 starts the re-resolve after discovery.
const RE_RESOLVE: usize = 3;

#[test]
fn a_command_replaced_during_discovery_is_refused() {
    let mut bus = menus();
    bus.mutate_on_children = Some((40, RE_RESOLVE, |bus| {
        bus.nodes.get_mut(&40).unwrap().children.retain(|child| *child != 43);
        bus.add(48, 40, command("Save"));
    }));
    let error = select(&mut bus, on(&window()), &path(&["File", "Save"]), &no_stop).unwrap_err();
    assert!(error.message.contains("command changed"), "{}", error.message);
    assert!(actions(&bus).is_empty());
}

#[test]
fn a_command_moved_to_another_frame_during_discovery_is_refused() {
    let mut bus = menus();
    bus.mutate_on_children = Some((40, 2, |bus| {
        bus.add(13, 1, FakeNode::frame("other", EDITOR_RECT));
        bus.nodes.get_mut(&20).unwrap().parent = 13;
    }));
    let error = select(&mut bus, on(&window()), &path(&["File", "Save"]), &no_stop).unwrap_err();
    assert!(error.message.contains("no longer belongs"), "{}", error.message);
    assert!(actions(&bus).is_empty());
}

#[test]
fn a_frame_that_disappears_during_discovery_is_refused() {
    let mut bus = menus();
    bus.mutate_on_children = Some((40, 2, |bus| {
        bus.nodes.get_mut(&1).unwrap().children.retain(|child| *child != 10);
    }));
    let error = select(&mut bus, on(&window()), &path(&["File", "Save"]), &no_stop).unwrap_err();
    assert!(error.message.contains("provably window"), "{}", error.message);
    assert!(actions(&bus).is_empty());
}

#[test]
fn a_non_menu_child_or_defunct_item_refuses_the_level() {
    let mut bus = menus();
    bus.add(49, 40, FakeNode::new(Role::Button, "Sneaky"));
    let error = items(&mut bus, on(&window()), &path(&["File"])).unwrap_err();
    assert!(error.message.contains("non-menu child"), "{}", error.message);

    let mut bus = menus();
    bus.nodes.get_mut(&43).unwrap().state.insert(State::Defunct);
    let error = items(&mut bus, on(&window()), &path(&["File"])).unwrap_err();
    assert!(error.message.contains("defunct"), "{}", error.message);
}

#[test]
fn a_container_chain_deeper_than_the_bound_is_refused() {
    let mut bus = menus();
    let mut parent = 10;
    for id in 100..140 {
        bus.add(id, parent, FakeNode::new(Role::Filler, ""));
        parent = id;
    }
    bus.nodes.get_mut(&10).unwrap().children.retain(|child| *child != 20);
    let error = items(&mut bus, on(&window()), &[]).unwrap_err();
    assert!(error.message.contains("bounded tree"), "{}", error.message);
}
