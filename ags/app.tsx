#!/usr/bin/env -S ags run

import app from "ags/gtk4/app"
import style from "./style.css"

import Gdk from "gi://Gdk?version=4.0"

import { Bar } from "./widgets/Bar"
import { registerAppLauncherRequestHandler } from "./widgets/AppLauncher"
import { initializeOsd, OsdWindow } from "./widgets/Osd"

app.start({
  instanceName: "obsidian-shell",
  css: style,
  main() {
    registerAppLauncherRequestHandler(app)
    initializeOsd()
    OsdWindow()

    const display = Gdk.Display.get_default()
    const monitors = display ? display.get_monitors().get_n_items() : 1

    for (let i = 0; i < monitors; i++) {
      Bar({ monitor: i })
    }
  },
})
