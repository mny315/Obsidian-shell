import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createState } from "ags"
import { execAsync } from "ags/process"

type BatterySnapshot = {
  available: boolean
  percent: number
  charging: boolean
}

function parseBatterySnapshot(raw: string): BatterySnapshot {
  const line = raw.trim()
  if (!line || line === "none") {
    return { available: false, percent: 0, charging: false }
  }

  const [percentRaw, statusRaw = ""] = line.split("|")
  const percent = Number.parseInt(percentRaw ?? "0", 10)

  if (!Number.isFinite(percent)) {
    return { available: false, percent: 0, charging: false }
  }

  const status = statusRaw.trim().toLowerCase()
  const charging = status === "charging" || status === "full"

  return {
    available: true,
    percent: Math.max(0, Math.min(100, percent)),
    charging,
  }
}

async function readBatterySnapshot() {
  const raw = await execAsync([
    "bash",
    "-lc",
    String.raw`found=""; for bat in /sys/class/power_supply/BAT*; do [ -d "$bat" ] || continue; cap="$(cat "$bat/capacity" 2>/dev/null || true)"; status="$(cat "$bat/status" 2>/dev/null || true)"; case "$cap" in ''|*[!0-9]*) continue ;; *) found=1; printf '%s|%s\n' "$cap" "$status"; break ;; esac; done; [ -n "$found" ] || echo none`,
  ])

  return parseBatterySnapshot(raw)
}

export function BatteryStatus() {
  const [visible, setVisible] = createState(false)
  const [percent, setPercent] = createState(0)
  const [tooltip, setTooltip] = createState("Battery")

  const percentLabel = percent((value) => `${value}%`)

  return (
    <box
      class="section section-center left-module-shell left-status-shell"
      spacing={0}
      visible={visible}
      valign={Gtk.Align.CENTER}
      tooltipText={tooltip}
      $={(self) => {
        const syncBattery = async () => {
          try {
            const snapshot = await readBatterySnapshot()
            setVisible(snapshot.available)
            setPercent(snapshot.percent)
            setTooltip(snapshot.charging ? `Battery ${snapshot.percent}% • Charging` : `Battery ${snapshot.percent}%`)
          } catch (error) {
            console.error(error)
            setVisible(false)
          }
        }

        void syncBattery()

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
          void syncBattery()
          return GLib.SOURCE_CONTINUE
        })

        self.connect("destroy", () => {
          if (id) GLib.source_remove(id)
        })
      }}
    >
      <box
        class="battery-indicator left-module-button left-module-content left-status-content"
        spacing={0}
        valign={Gtk.Align.CENTER}
        halign={Gtk.Align.CENTER}
      >
        <label class="battery-percent left-module-label" label={percentLabel} />
      </box>
    </box>
  )
}
