#!/usr/bin/env -S ags run

// AGS infers GTK4 by scanning this entry file before bundling.
// This type-only import is erased by TypeScript/esbuild, so GTK/GDK/GSK
// are initialized normally by the app imports below.
import type Gtk from "gi://Gtk?version=4.0"

import app from "ags/gtk4/app"
import style from "./style.css"

import Gdk from "gi://Gdk?version=4.0"

import { Bar } from "./widgets/Bar"
import { registerAppLauncherRequestHandler } from "./widgets/AppLauncher"
import { initializeOsd, OsdWindow } from "./widgets/Osd"
import { debugPopupLog } from "./widgets/DebugPopupLog"

app.start({
  instanceName: "obsidian-shell",
  css: style,
  main() {
    registerAppLauncherRequestHandler(app)
    initializeOsd()
    OsdWindow()

    const display = Gdk.Display.get_default()
    const monitors = display ? display.get_monitors().get_n_items() : 1

    // DEBUG_POPUP_LOG: temporary startup marker; remove with DebugPopupLog.ts after diagnosis.
    debugPopupLog("startup", "main", { monitors })

    for (let i = 0; i < monitors; i++) {
      Bar({ monitor: i })
    }
  },
})
