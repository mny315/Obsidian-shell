import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createComputed, createState } from "ags"
import { Astal } from "ags/gtk4"
import { execAsync } from "ags/process"

import {
  BRIGHTNESS_MIN,
  OSD_AUTO_HIDE_DELAY_MS,
  OSD_BAR_SUPPRESS_MS,
  OSD_BOTTOM_MARGIN,
  OSD_POLL_INTERVAL_MS,
  OSD_REVEAL_DURATION_MS,
  OSD_STARTUP_SUPPRESS_MS,
  OSD_VALUE_ANIMATION_MS,
  OSD_VALUE_ANIMATION_STEP_MS,
  clamp,
} from "../config"

type OsdKind = "volume" | "brightness"

type AudioSnapshot = {
  value: number
  percent: number
  muted: boolean
  icon: string
}

const { BOTTOM } = Astal.WindowAnchor

const [windowVisible, setWindowVisible] = createState(false)
const [revealed, setRevealed] = createState(false)
const [kind, setKind] = createState<OsdKind>("volume")
const [icon, setIcon] = createState("󰕾")
const [value, setValue] = createState(0)
const [muted, setMuted] = createState(false)

let initialized = false
let pollSourceId = 0
let hideSourceId = 0
let closeSourceId = 0
let valueAnimationSourceId = 0
let volumeBusy = false
let brightnessBusy = false
let lastVolumeKey = ""
let lastBrightnessPercent = -1
let startupSuppressUntil = 0
let volumeSuppressUntil = 0
let brightnessSuppressUntil = 0

function clearSource(sourceId: number) {
  if (sourceId === 0) return 0

  try {
    GLib.source_remove(sourceId)
  } catch {}

  return 0
}

function clearHideTimeout() {
  hideSourceId = clearSource(hideSourceId)
}

function clearCloseTimeout() {
  closeSourceId = clearSource(closeSourceId)
}

function clearValueAnimation() {
  valueAnimationSourceId = clearSource(valueAnimationSourceId)
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3)
}

function animateValue(nextValue: number) {
  const startValue = value()
  const targetValue = clamp(nextValue)

  if (Math.abs(startValue - targetValue) < 0.001) {
    clearValueAnimation()
    setValue(targetValue)
    return
  }

  clearValueAnimation()

  const startedAt = GLib.get_monotonic_time()
  const duration = OSD_VALUE_ANIMATION_MS * 1000

  valueAnimationSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_VALUE_ANIMATION_STEP_MS, () => {
    const elapsed = GLib.get_monotonic_time() - startedAt
    const progress = Math.min(1, elapsed / duration)
    const easedProgress = easeOutCubic(progress)
    const currentValue = startValue + (targetValue - startValue) * easedProgress

    setValue(currentValue)

    if (progress >= 1) {
      valueAnimationSourceId = 0
      setValue(targetValue)
      return GLib.SOURCE_REMOVE
    }

    return GLib.SOURCE_CONTINUE
  })
}

function pickVolumeIcon(volume: number, isMuted: boolean) {
  if (isMuted) return "󰖁"
  if (volume <= 0.01) return "󰝟"
  if (volume < 0.5) return "󰕿"
  return "󰕾"
}

function parseVolume(output: string): AudioSnapshot {
  const trimmed = output.trim()
  const isMuted = trimmed.includes("MUTED")
  const parsedValue = Number.parseFloat(trimmed.split(/\s+/)[1] ?? "0") || 0
  const nextValue = clamp(parsedValue)
  const percent = Math.round(nextValue * 100)

  return {
    value: nextValue,
    percent,
    muted: isMuted,
    icon: pickVolumeIcon(nextValue, isMuted),
  }
}

function parseBrightness(output: string) {
  const parsedValue = Number.parseFloat(output.trim()) || BRIGHTNESS_MIN
  const nextValue = clamp(parsedValue, BRIGHTNESS_MIN, 1)
  const percent = Math.round(nextValue * 100)

  return {
    value: nextValue,
    percent,
    icon: "󰃟",
  }
}

function isSuppressed(until: number) {
  return GLib.get_monotonic_time() < until
}

function suppressForBar(ms = OSD_BAR_SUPPRESS_MS) {
  return GLib.get_monotonic_time() + ms * 1000
}

export function suppressVolumeOsd(ms = OSD_BAR_SUPPRESS_MS) {
  volumeSuppressUntil = suppressForBar(ms)
}

export function suppressBrightnessOsd(ms = OSD_BAR_SUPPRESS_MS) {
  brightnessSuppressUntil = suppressForBar(ms)
}

async function isFullscreenActive() {
  try {
    const raw = await execAsync(["hyprctl", "-j", "activewindow"])
    const trimmed = raw.trim()
    if (!trimmed) return false

    const parsed = JSON.parse(trimmed) as { fullscreen?: unknown; fullscreenClient?: unknown } | null
    if (!parsed || typeof parsed !== "object") return false

    const fullscreen = parsed.fullscreen
    const fullscreenClient = parsed.fullscreenClient

    const matches = (value: unknown) => value === true || value === 1 || value === 2
    return matches(fullscreen) || matches(fullscreenClient)
  } catch (error) {
    console.error(error)
    return true
  }
}

async function shouldNotifyForExternalChange(kind: OsdKind) {
  if (GLib.get_monotonic_time() < startupSuppressUntil) return false
  if (kind === "volume" && isSuppressed(volumeSuppressUntil)) return false
  if (kind === "brightness" && isSuppressed(brightnessSuppressUntil)) return false
  return await isFullscreenActive()
}

function closeOsd() {
  clearHideTimeout()
  clearCloseTimeout()

  setRevealed(false)

  closeSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_REVEAL_DURATION_MS, () => {
    closeSourceId = 0

    if (!revealed()) setWindowVisible(false)

    return GLib.SOURCE_REMOVE
  })
}

function presentOsd(nextKind: OsdKind, nextValue: number, nextIcon: string, isMuted = false) {
  clearHideTimeout()
  clearCloseTimeout()

  setKind(nextKind)
  animateValue(nextValue)
  setIcon(nextIcon)
  setMuted(isMuted)

  if (!windowVisible()) {
    setWindowVisible(true)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      setRevealed(true)
      return GLib.SOURCE_REMOVE
    })
  } else {
    setRevealed(true)
  }

  hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_AUTO_HIDE_DELAY_MS, () => {
    hideSourceId = 0
    closeOsd()
    return GLib.SOURCE_REMOVE
  })
}

async function syncVolume(notify: boolean) {
  if (volumeBusy) return
  volumeBusy = true

  try {
    const output = await execAsync([
      "bash",
      "-lc",
      "wpctl get-volume @DEFAULT_AUDIO_SINK@ || echo 'Volume: 0'",
    ])

    const snapshot = parseVolume(output)
    const key = `${snapshot.percent}:${snapshot.muted ? 1 : 0}`

    if (!lastVolumeKey) {
      lastVolumeKey = key
      if (!notify) return
    }

    if (key !== lastVolumeKey) {
      lastVolumeKey = key

      if (notify && await shouldNotifyForExternalChange("volume")) {
        presentOsd("volume", snapshot.value, snapshot.icon, snapshot.muted)
      }
    }
  } catch (error) {
    console.error(error)
  } finally {
    volumeBusy = false
  }
}

async function syncBrightness(notify: boolean) {
  if (brightnessBusy) return
  brightnessBusy = true

  try {
    const output = await execAsync([
      "bash",
      "-lc",
      "brightnessctl -m 2>/dev/null | awk -F, '{gsub(/%/, \"\", $4); print $4/100}' || echo 0.05",
    ])

    const snapshot = parseBrightness(output)

    if (lastBrightnessPercent < 0) {
      lastBrightnessPercent = snapshot.percent
      if (!notify) return
    }

    if (snapshot.percent !== lastBrightnessPercent) {
      lastBrightnessPercent = snapshot.percent

      if (notify && await shouldNotifyForExternalChange("brightness")) {
        presentOsd("brightness", snapshot.value, snapshot.icon)
      }
    }
  } catch (error) {
    console.error(error)
  } finally {
    brightnessBusy = false
  }
}

export function initializeOsd() {
  if (initialized) return
  initialized = true
  startupSuppressUntil = GLib.get_monotonic_time() + OSD_STARTUP_SUPPRESS_MS * 1000

  void syncVolume(false)
  void syncBrightness(false)

  pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_POLL_INTERVAL_MS, () => {
    void syncVolume(true)
    void syncBrightness(true)
    return GLib.SOURCE_CONTINUE
  })
}

const title = createComputed(() => kind() === "volume" ? (muted() ? "Sound muted" : "Volume") : "Brightness")
const percent = createComputed(() => `${Math.round(value() * 100)}%`)

export function OsdWindow() {
  return (
    <window
      visible={windowVisible}
      namespace="obsidian-shell"
      class="osd-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.NONE}
      layer={Astal.Layer.OVERLAY}
      anchor={BOTTOM}
      $={(self) => {
        self.connect("destroy", () => {
          pollSourceId = clearSource(pollSourceId)
          hideSourceId = clearSource(hideSourceId)
          closeSourceId = clearSource(closeSourceId)
          valueAnimationSourceId = clearSource(valueAnimationSourceId)
          initialized = false
          volumeBusy = false
          brightnessBusy = false
          lastVolumeKey = ""
          lastBrightnessPercent = -1
          startupSuppressUntil = 0
          volumeSuppressUntil = 0
          brightnessSuppressUntil = 0
        })
      }}
    >
      <box
        class="osd-placement"
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.END}
        $={(self) => {
          self.set_margin_bottom(OSD_BOTTOM_MARGIN)
        }}
      >
        <revealer
          class="osd-revealer"
          revealChild={revealed}
          transitionType={Gtk.RevealerTransitionType.SLIDE_UP}
          transitionDuration={OSD_REVEAL_DURATION_MS}
        >
          <Gtk.Frame class="osd-frame" widthRequest={300}>
            <box class="osd-body" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
              <box class="osd-header" spacing={10} valign={Gtk.Align.CENTER}>
                <label class="osd-icon" label={icon} />
                <label class="osd-title" xalign={0} hexpand label={title} />
                <label class="osd-percent" label={percent} />
              </box>

              <slider
                class="slider-control osd-slider"
                sensitive={false}
                canFocus={false}
                hexpand
                drawValue={false}
                min={0}
                max={1}
                step={0.01}
                value={value}
              />
            </box>
          </Gtk.Frame>
        </revealer>
      </box>
    </window>
  )
}
