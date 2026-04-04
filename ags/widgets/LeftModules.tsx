import Gtk from "gi://Gtk?version=4.0"

import { With } from "ags"

import { BatteryStatus } from "./BatteryStatus"
import { Clock } from "./Clock"
import { KeyboardLayout } from "./KeyboardLayout"
import { PinnedPlayerBar } from "./PlayerInline"
import { playerPinned } from "./PlayerPinState"

export function LeftModules({ monitor }: { monitor: number }) {
  return (
    <box class="left-side-wrap" spacing={0} valign={Gtk.Align.CENTER}>
      <box class="section section-center left-module-shell" spacing={0}>
        <Clock monitor={monitor} />
      </box>

      <BatteryStatus />
      <KeyboardLayout />

      <With value={playerPinned}>
        {(pinned) => pinned ? <PinnedPlayerBar /> : <box />}
      </With>
    </box>
  )
}
