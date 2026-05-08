import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import { BRIGHTNESS_MIN, BRIGHTNESS_STEP, clamp } from "../config"
import { suppressBrightnessOsd } from "./Osd"
import { debugPopupLog } from "./DebugPopupLog"

type BrightnessBackend = "unknown" | "backlight" | "ddc" | "none"

function parseBrightness(out: string) {
  return clamp(Number.parseFloat(out.trim()) || BRIGHTNESS_MIN, BRIGHTNESS_MIN, 1)
}

function parseBrightnessSnapshot(out: string): { backend: BrightnessBackend; value: number } {
  const [backendRaw, valueRaw] = out.trim().split(/\s+/, 2)
  const backend = backendRaw === "backlight" || backendRaw === "ddc" || backendRaw === "none"
    ? backendRaw
    : "none"

  return {
    backend,
    value: parseBrightness(valueRaw ?? String(BRIGHTNESS_MIN)),
  }
}

const DDCUTIL_HELPER = String.raw`
resolve_ddcutil() {
  if [ -n "$OBSIDIAN_SHELL_DDCUTIL" ] && [ -x "$OBSIDIAN_SHELL_DDCUTIL" ]; then
    printf '%s\n' "$OBSIDIAN_SHELL_DDCUTIL"
    return 0
  fi

  command -v ddcutil 2>/dev/null
}
`

const READ_BRIGHTNESS_COMMAND = String.raw`
${DDCUTIL_HELPER}

if out=$(brightnessctl --class=backlight -m 2>/dev/null); then
  value=$(printf '%s\n' "$out" | awk -F, 'NR==1 {gsub(/%/, "", $4); if ($4 != "") print $4 / 100; exit}')
  if [ -n "$value" ]; then
    printf 'backlight %s\n' "$value"
    exit 0
  fi
fi

ddcutil_bin="$(resolve_ddcutil || true)"
if [ -n "$ddcutil_bin" ] && out=$("$ddcutil_bin" getvcp 10 2>/dev/null); then
  value=$(printf '%s\n' "$out" | sed -n 's/.*current value = *\([0-9][0-9]*\).*/\1/p' | head -n1)
  max=$(printf '%s\n' "$out" | sed -n 's/.*max value = *\([0-9][0-9]*\).*/\1/p' | head -n1)

  if [ -n "$value" ] && [ -n "$max" ] && [ "$max" -gt 0 ]; then
    awk "BEGIN { print \"ddc \" $value / $max }"
    exit 0
  fi
fi

printf 'none %s\n' ${BRIGHTNESS_MIN}
`

function writeBacklightCommand(percent: number) {
  return String.raw`
brightnessctl --class=backlight set "${percent}%"
`
}

function writeDdcCommand(percent: number) {
  return String.raw`
${DDCUTIL_HELPER}

ddcutil_bin="$(resolve_ddcutil || true)"
if [ -z "$ddcutil_bin" ]; then
  exit 0
fi

"$ddcutil_bin" setvcp 10 "${percent}"
`
}

function writeAutoCommand(percent: number) {
  return String.raw`
${DDCUTIL_HELPER}

if out=$(brightnessctl --class=backlight -m 2>/dev/null); then
  value=$(printf '%s\n' "$out" | awk -F, 'NR==1 {gsub(/%/, "", $4); if ($4 != "") print $4; exit}')
  if [ -n "$value" ]; then
    brightnessctl --class=backlight set "${percent}%"
    exit $?
  fi
fi

ddcutil_bin="$(resolve_ddcutil || true)"
if [ -n "$ddcutil_bin" ]; then
  "$ddcutil_bin" setvcp 10 "${percent}"
fi
`
}

export function BrightnessControl({
  onToggle,
  bindRevealer,
}: {
  onToggle: () => void
  bindRevealer: (self: Gtk.Revealer) => void
}) {
  const [current, setCurrent] = createState(BRIGHTNESS_MIN)

  const [showPercent, setShowPercent] = createState(false)

  let backend: BrightnessBackend = "unknown"
  let flashTimeoutId: number | null = null
  let syncTimeoutId = 0
  let deferredSyncTimeoutId = 0
  let writeDebounceId = 0
  let readBusy = false
  let writeBusy = false
  let pendingWritePercent: number | null = null
  let lastWrittenPercent = -1
  let updatingFromRead = false
  let ignoreSliderChangesUntil = 0

  const clearSource = (sourceId: number) => {
    if (!sourceId) return 0

    try {
      GLib.source_remove(sourceId)
    } catch {}

    return 0
  }

  const applyCurrentFromRead = (next: number) => {
    updatingFromRead = true
    ignoreSliderChangesUntil = GLib.get_monotonic_time() + 300 * 1000
    setCurrent(next)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      updatingFromRead = false
      return GLib.SOURCE_REMOVE
    })
  }

  const flashPercent = () => {
    setShowPercent(true)

    if (flashTimeoutId) GLib.source_remove(flashTimeoutId)

    flashTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
      flashTimeoutId = null
      setShowPercent(false)
      return GLib.SOURCE_REMOVE
    })
  }

  const percent = current((v) => `${Math.round(v * 100)}%`)
  const triggerLabel = createComputed(() => showPercent() ? `${Math.round(current() * 100)}%` : "󰃟")
  const tooltip = createComputed(() => `Brightness ${Math.round(current() * 100)}%`)

  const syncBrightness = async () => {
    if (readBusy) return
    readBusy = true

    try {
      const out = await execAsync([
        "bash",
        "-lc",
        READ_BRIGHTNESS_COMMAND,
      ])
      const snapshot = parseBrightnessSnapshot(out)
      backend = snapshot.backend
      applyCurrentFromRead(snapshot.value)
    } catch (err) {
      console.error(err)
    } finally {
      readBusy = false
    }
  }

  const writeBrightnessNow = async (percent: number) => {
    if (writeBusy) {
      pendingWritePercent = percent
      return
    }

    if (percent === lastWrittenPercent) return

    writeBusy = true

    try {
      const command = backend === "backlight"
        ? writeBacklightCommand(percent)
        : backend === "ddc"
          ? writeDdcCommand(percent)
          : writeAutoCommand(percent)

      await execAsync(["bash", "-lc", command])
      lastWrittenPercent = percent
    } catch (err) {
      console.error(err)
    } finally {
      writeBusy = false

      const nextPercent = pendingWritePercent
      pendingWritePercent = null

      if (nextPercent !== null && nextPercent !== lastWrittenPercent) {
        void writeBrightnessNow(nextPercent)
      }
    }
  }

  const scheduleBrightnessWrite = (nextValue: number) => {
    const nextPercent = Math.round(clamp(nextValue, BRIGHTNESS_MIN, 1) * 100)
    pendingWritePercent = nextPercent

    if (backend !== "ddc") {
      const immediatePercent = pendingWritePercent
      pendingWritePercent = null
      if (immediatePercent !== null) void writeBrightnessNow(immediatePercent)
      return
    }

    writeDebounceId = clearSource(writeDebounceId)
    writeDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      writeDebounceId = 0
      const delayedPercent = pendingWritePercent
      pendingWritePercent = null
      if (delayedPercent !== null) void writeBrightnessNow(delayedPercent)
      return GLib.SOURCE_REMOVE
    })
  }

  const scheduleBrightnessSync = (delayMs: number) => {
    deferredSyncTimeoutId = clearSource(deferredSyncTimeoutId)
    deferredSyncTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delayMs, () => {
      deferredSyncTimeoutId = 0
      void syncBrightness()
      return GLib.SOURCE_REMOVE
    })
  }

  const setBrightness = (nextValue: number) => {
    if (updatingFromRead || GLib.get_monotonic_time() < ignoreSliderChangesUntil) return

    const next = clamp(nextValue, BRIGHTNESS_MIN, 1)
    suppressBrightnessOsd()
    setCurrent(next)
    scheduleBrightnessWrite(next)
  }

  const adjustBrightness = (delta: number) => {
    setCurrent((prev) => {
      const next = clamp(prev + delta, BRIGHTNESS_MIN, 1)

      suppressBrightnessOsd()
      scheduleBrightnessWrite(next)

      return next
    })
  }

  return (
    <box
      class="quick-control inline-control"
      spacing={6}
      hexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        scheduleBrightnessSync(1500)

        syncTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          if (backend === "ddc") return GLib.SOURCE_CONTINUE
          void syncBrightness()
          return GLib.SOURCE_CONTINUE
        })

        self.connect("destroy", () => {
          syncTimeoutId = clearSource(syncTimeoutId)
          deferredSyncTimeoutId = clearSource(deferredSyncTimeoutId)
          writeDebounceId = clearSource(writeDebounceId)
          if (flashTimeoutId) GLib.source_remove(flashTimeoutId)
        })
      }}
    >
      <revealer
        class="inline-revealer"
        revealChild={false}
        transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
        transitionDuration={300}
        hexpand={false}
        halign={Gtk.Align.START}
        valign={Gtk.Align.CENTER}
        $={bindRevealer}
      >
        <box
          class="inline-panel slider-panel"
          spacing={8}
          hexpand={false}
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
        >
          <label class="module-icon brightness-icon" label={"󰃟"} />
          <slider
            class="slider-control"
            hexpand
            min={BRIGHTNESS_MIN}
            max={1}
            step={0.01}
            value={current}
            onChangeValue={({ value }) => {
              setBrightness(value)
            }}
          />
          <label class="slider-value" label={percent} />
        </box>
      </revealer>

      <button
        class="icon-button quick-toggle flat"
        valign={Gtk.Align.CENTER}
        tooltipText={tooltip}
        onClicked={() => {
          debugPopupLog("brightness", "trigger onClicked", { backend, current: current(), shown: showPercent() })
          onToggle()
          if (backend === "unknown") scheduleBrightnessSync(600)
        }}
      >
        <Gtk.EventControllerScroll
          flags={Gtk.EventControllerScrollFlags.VERTICAL}
          onScroll={(_, _dx, dy) => {
            if (dy < 0) adjustBrightness(BRIGHTNESS_STEP)
            else if (dy > 0) adjustBrightness(-BRIGHTNESS_STEP)
            flashPercent()
            return true
          }}
        />
        <label class={showPercent((shown) => shown ? "module-percent brightness-percent" : "module-icon brightness-icon")} label={triggerLabel} />
      </button>
    </box>
  )
}
