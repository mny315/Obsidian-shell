import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { execAsync } from "ags/process"

import { REVEALER_HIDE_DELAY_MS } from "../config"
import { AppLauncherControl } from "./AppLauncher"
import { BluetoothControl } from "./Bluetooth"
import { NetworkControl } from "./Network"
import { BrightnessControl } from "./Brightness"
import { AudioControl } from "./Audio"
import { PowerControl } from "./Power"
import { attachEscapeKey } from "./EscapeKey"

type HoverWatcher = (hovered: boolean) => void

export function RightModules({
  monitor,
  bindBarHoverHandlers,
}: {
  monitor: number
  bindBarHoverHandlers: (handlers: { onEnter: () => void; onLeave: () => void }) => void
}) {
  let brightnessRevealer: Gtk.Revealer | null = null
  let audioRevealer: Gtk.Revealer | null = null
  let powerRevealer: Gtk.Revealer | null = null
  let barHovered = false
  let hideTimeoutId = 0
  let controlsShell: Gtk.Box | null = null
  const barHoverWatchers = new Set<HoverWatcher>()

  const allRevealers = () => [brightnessRevealer, audioRevealer, powerRevealer]

  const notifyBarHover = (hovered: boolean) => {
    for (const watcher of barHoverWatchers) {
      try {
        watcher(hovered)
      } catch (error) {
        console.error(error)
      }
    }
  }

  const clearHideTimeout = () => {
    if (hideTimeoutId !== 0) {
      GLib.source_remove(hideTimeoutId)
      hideTimeoutId = 0
    }
  }

  const hasOpenRevealer = () => allRevealers().some((revealer) => revealer?.get_reveal_child())

  const closeAll = () => {
    clearHideTimeout()

    for (const revealer of allRevealers()) {
      if (!revealer) continue
      revealer.revealChild = false
    }
  }

  const scheduleHideIfNeeded = () => {
    clearHideTimeout()

    if (barHovered || !hasOpenRevealer()) return

    hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEALER_HIDE_DELAY_MS, () => {
      hideTimeoutId = 0

      if (!barHovered) closeAll()

      return GLib.SOURCE_REMOVE
    })
  }

  const focusControlsShell = () => {
    controlsShell?.grab_focus()
  }

  const toggleRevealer = (target: Gtk.Revealer | null) => {
    if (!target) return

    const shouldOpen = !target.get_reveal_child()

    for (const revealer of allRevealers()) {
      if (!revealer) continue
      revealer.revealChild = shouldOpen && revealer === target
    }

    if (shouldOpen) {
      focusControlsShell()
      scheduleHideIfNeeded()
    }
    else clearHideTimeout()
  }

  const runPowerAction = (command: string) => {
    closeAll()
    void execAsync(["bash", "-lc", command]).catch(console.error)
  }

  bindBarHoverHandlers({
    onEnter: () => {
      barHovered = true
      clearHideTimeout()
      notifyBarHover(true)
    },
    onLeave: () => {
      barHovered = false
      scheduleHideIfNeeded()
      notifyBarHover(false)
    },
  })

  return (
    <box
      class="section section-right-main controls-shell"
      spacing={2}
      hexpand={false}
      halign={Gtk.Align.END}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        controlsShell = self
        self.set_focusable(true)
        attachEscapeKey(self, closeAll)
      }}
    >
      <AppLauncherControl monitor={monitor} bindBarHoverWatcher={(watcher) => barHoverWatchers.add(watcher)} />
      <BluetoothControl monitor={monitor} bindBarHoverWatcher={(watcher) => barHoverWatchers.add(watcher)} />
      <NetworkControl monitor={monitor} bindBarHoverWatcher={(watcher) => barHoverWatchers.add(watcher)} />
     

      <BrightnessControl
        onToggle={() => toggleRevealer(brightnessRevealer)}
        bindRevealer={(self) => (brightnessRevealer = self)}
      />

      <AudioControl
        onToggle={() => toggleRevealer(audioRevealer)}
        bindRevealer={(self) => (audioRevealer = self)}
      />

      <PowerControl
        onToggle={() => toggleRevealer(powerRevealer)}
        bindRevealer={(self) => (powerRevealer = self)}
        onRun={runPowerAction}
      />
    </box>
  )
}
