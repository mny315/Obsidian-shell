#!/usr/bin/env -S ags run

import app from "ags/gtk4/app"
import style from "./style.css"

import Gdk from "gi://Gdk?version=4.0"

import { Bar } from "./widgets/Bar"
import { registerAppLauncherRequestHandler } from "./widgets/AppLauncher"

app.start({
  css: style,
  main() {
    registerAppLauncherRequestHandler(app)

    const display = Gdk.Display.get_default()
    const monitors = display ? display.get_monitors().get_n_items() : 1

    for (let i = 0; i < monitors; i++) {
      Bar({ monitor: i })
    }
  },
})
