
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
