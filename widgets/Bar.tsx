import GLib from "gi://GLib"

import { idle } from "ags/time"
import { Astal } from "ags/gtk4"

import Gtk from "gi://Gtk?version=4.0"

import { LeftModules } from "./LeftModules"
import { Tray } from "./Tray"
import { CenterModules } from "./CenterModules"
import { RightModules } from "./RightModules"

const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

export function Bar({ monitor }: { monitor: number }) {
  let barHoverHandlers = {
    onEnter: () => {},
    onLeave: () => {},
  }
  let revealer: Gtk.Revealer | null = null
  let closing = false
  let closeTimeoutId = 0

  return (
    <window
      visible
      monitor={monitor}
      namespace="obsidian-shell"
      class="bar-window"
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={TOP | LEFT | RIGHT}
      $={(self) => {
        self.connect("destroy", () => {
          if (closeTimeoutId !== 0) {
            GLib.source_remove(closeTimeoutId)
            closeTimeoutId = 0
          }
        })

        self.connect("close-request", () => {
          if (closing) return false
          if (!revealer?.get_reveal_child()) return false

          closing = true
          revealer.revealChild = false
          closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
            closeTimeoutId = 0
            self.close()
            return GLib.SOURCE_REMOVE
          })
          return true
        })
      }}
    >
      <revealer
        class="bar-revealer"
        revealChild={false}
        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        transitionDuration={260}
        $={(self) => {
          revealer = self
          idle(() => (self.revealChild = true))
        }}
      >
        <centerbox class="bar-shell">
          <Gtk.EventControllerMotion
            onEnter={() => barHoverHandlers.onEnter()}
            onLeave={() => barHoverHandlers.onLeave()}
          />

          <box class="bar-start" $type="start" valign={Gtk.Align.CENTER}>
            <LeftModules monitor={monitor} />
          </box>

          <box class="bar-center" hexpand $type="center" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <CenterModules monitor={monitor} />
          </box>

          <box
            $type="end"
            class="bar-end right-side-wrap"
            spacing={0}
            hexpand={false}
            halign={Gtk.Align.END}
            valign={Gtk.Align.CENTER}
          >
            <Tray />
            <RightModules monitor={monitor} bindBarHoverHandlers={(handlers) => (barHoverHandlers = handlers)} />
          </box>
        </centerbox>
      </revealer>
    </window>
  )
}
