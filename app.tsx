#!/usr/bin/env -S ags run

// AGS infers GTK4 by scanning this entry file before bundling.
// This type-only import is erased by TypeScript/esbuild, so it does not
// initialize Gtk/Gdk before we choose the renderer below.
import type Gtk from "gi://Gtk?version=4.0"

import GLib from "gi://GLib?version=2.0"

// Must run before importing ags/gtk4/app, Gdk, Gtk, Astal, or widget modules.
// GTK/GSK chooses the renderer when it creates a renderer for a surface.
GLib.setenv("GSK_RENDERER", "gl", true)
GLib.setenv("GDK_BACKEND", "wayland", true)

await import("./main")
