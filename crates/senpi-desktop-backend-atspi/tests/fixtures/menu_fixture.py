#!/usr/bin/env python3
"""GTK3 menu fixture for the AT-SPI menu live tests.

Usage: menu_fixture.py <title> <record-file>

Opens one window titled <title> with a menu bar:
File > Open..., Save (Ctrl+S), Recent > a.txt; Edit > Undo (insensitive).
Every activated command appends "<label>@<title>" to <record-file>.
"""

import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

title, record = sys.argv[1], sys.argv[2]


def recorder(label):
    def activate(_item):
        with open(record, "a", encoding="utf-8") as out:
            out.write(f"{label}@{title}\n")

    return activate


def command(label, accel_group=None, accel=None, sensitive=True):
    item = Gtk.MenuItem(label=label)
    item.connect("activate", recorder(label))
    item.set_sensitive(sensitive)
    if accel_group is not None and accel is not None:
        key, mods = Gtk.accelerator_parse(accel)
        item.add_accelerator("activate", accel_group, key, mods, Gtk.AccelFlags.VISIBLE)
    return item


def submenu(label, items):
    top = Gtk.MenuItem(label=label)
    menu = Gtk.Menu()
    for child in items:
        menu.append(child)
    top.set_submenu(menu)
    return top


window = Gtk.Window(title=title)
window.set_default_size(480, 320)
accels = Gtk.AccelGroup()
window.add_accel_group(accels)
bar = Gtk.MenuBar()
bar.append(
    submenu(
        "File",
        [
            command("Open..."),
            Gtk.SeparatorMenuItem(),
            command("Save", accels, "<Primary>s"),
            submenu("Recent", [command("a.txt")]),
        ],
    )
)
bar.append(submenu("Edit", [command("Undo", sensitive=False)]))
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
box.pack_start(bar, False, False, 0)
box.pack_start(Gtk.Label(label="menu fixture"), True, True, 0)
window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
