import Gtk from "gi://Gtk?version=4.0"

import { With } from "ags"

import { Clock } from "./Clock"
import { PinnedPlayerBar } from "./PlayerInline"
import { playerPinned } from "./PlayerPinState"

export function LeftModules({ monitor }: { monitor: number }) {
  return (
    <box class="left-side-wrap" spacing={0} valign={Gtk.Align.CENTER}>
      <box class="section section-center left-module-shell" spacing={0}>
        <Clock monitor={monitor} />
      </box>

      <With value={playerPinned}>
        {(pinned) => pinned ? <PinnedPlayerBar /> : <box />}
      </With>
    </box>
  )
}
