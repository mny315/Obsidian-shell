#!/usr/bin/env -S ags run

import app from "ags/gtk4/app"
import style from "./style.css"

import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"

GLib.log_set_handler(
  "GLib-GIO",
  GLib.LogLevelFlags.LEVEL_CRITICAL,
  (domain: string, _level: number, message: string) => {
    if (message?.includes("g_list_store_remove")) return
    print(`[${domain}] CRITICAL: ${message}`)
  }
)

import { Bar } from "./widgets/Bar"
import { ShellTooltipWindow } from "./widgets/ShellTooltip"
import { registerAppLauncherRequestHandler } from "./widgets/AppLauncher"
import { initializeOsd, OsdWindow } from "./widgets/Osd"
import { AudioThreadVisualizerWindow } from "./widgets/AudioThreadVisualizer"

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
      ShellTooltipWindow({ monitor: i })
      AudioThreadVisualizerWindow({ monitor: i })
    }
  },
})
