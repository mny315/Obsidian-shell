import Gtk from "gi://Gtk?version=4.0"
import { createPoll } from "ags/time"

import { fallback } from "../config"
import { WallpaperWidgetButton } from "./WallpaperWidget"
import { BatteryStatus } from "./BatteryStatus"
import { KeyboardLayout } from "./KeyboardLayout"

export function Clock({ monitor }: { monitor: number }) {
  const time = createPoll(
    fallback.clock,
    1000,
    ["bash", "-lc", "LC_TIME=C date '+%H:%M %a %b %-d'"],
  )

  return (
    <box class="left-module-button left-module-content clock-module-content" spacing={4} valign={Gtk.Align.CENTER}>
      <WallpaperWidgetButton monitor={monitor} />
      <label class="clock-icon" label={"󰅐"} />
      <label class="clock left-module-label" label={time} />
      <BatteryStatus />
      <KeyboardLayout />
    </box>
  )
}
