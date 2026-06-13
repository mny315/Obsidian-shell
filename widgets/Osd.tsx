import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createComputed, createState } from "ags"
import { Astal } from "ags/gtk4"
import { execAsync, subprocess } from "ags/process"

import { clipRoundedWidget, setLayerWindowMargins } from "./FloatingPopup"

import {
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

type AudioSnapshot = {
  value: number
  percent: number
  muted: boolean
  icon: string
}

type SignalBinding = {
  target: any
  id: number
}

const { BOTTOM } = Astal.WindowAnchor
const OSD_VOLUME_NOTIFY_DEBOUNCE_MS = 24
const OSD_FALLBACK_POLL_INTERVAL_MS = Math.max(OSD_POLL_INTERVAL_MS, 1500)
const OSD_PW_DUMP_DEBOUNCE_MS = 80

const [windowVisible, setWindowVisible] = createState(false)
const [icon, setIcon] = createState("󰕾")
const [value, setValue] = createState(0)
const [muted, setMuted] = createState(false)

let initialized = false
let fallbackPollSourceId = 0
let hideSourceId = 0
let valueAnimationSourceId = 0
let osdWindow: Gtk.Widget | null = null
let osdRevealer: Gtk.Revealer | null = null
let closingOsd = false
let closeAnimationSourceId = 0
let volumeBusy = false
let lastVolumeKey = ""
let startupSuppressUntil = 0
let volumeSuppressUntil = 0
let volumeNotifyDebounceId = 0
let pendingVolumeSnapshot: AudioSnapshot | null = null
let wireplumberReady = false
let wireplumberSignals: SignalBinding[] = []
let currentSpeaker: any = null
let currentSpeakerSignals: SignalBinding[] = []
let pwDumpProcess: ReturnType<typeof subprocess> | null = null
let pwDumpDebounceId = 0

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

function makeSnapshot(nextValue: number, isMuted: boolean): AudioSnapshot {
  const clampedValue = clamp(nextValue)

  return {
    value: clampedValue,
    percent: Math.round(clampedValue * 100),
    muted: isMuted,
    icon: pickVolumeIcon(clampedValue, isMuted),
  }
}

function parseVolume(output: string): AudioSnapshot {
  const trimmed = output.trim()
  const isMuted = trimmed.includes("MUTED")
  const parsedValue = Number.parseFloat(trimmed.split(/\s+/)[1] ?? "0") || 0
  return makeSnapshot(parsedValue, isMuted)
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

export function suppressBrightnessOsd(_ms = OSD_BAR_SUPPRESS_MS) {}

function shouldNotifyForExternalVolumeChange() {
  if (GLib.get_monotonic_time() < startupSuppressUntil) return false
  if (isSuppressed(volumeSuppressUntil)) return false
  return true
}

function setOsdFramePresented(presented: boolean) {
  if (!osdRevealer) return

  try {
    osdRevealer.set_reveal_child(presented)
    return
  } catch {}

  try {
    ;(osdRevealer as any).reveal_child = presented
    return
  } catch {}

  try {
    ;(osdRevealer as any).revealChild = presented
  } catch {}
}

function getOsdFrameRevealChild() {
  if (!osdRevealer) return false

  try {
    return osdRevealer.get_reveal_child()
  } catch {}

  try {
    return Boolean((osdRevealer as any).reveal_child)
  } catch {}

  try {
    return Boolean((osdRevealer as any).revealChild)
  } catch {}

  return false
}

function hideOsdWindowNow() {
  closeAnimationSourceId = clearSource(closeAnimationSourceId)
  setOsdFramePresented(false)
  setWindowVisible(false)
}

function showOsdWindowNow() {
  setWindowVisible(true)
}

function finishCloseOsd() {
  clearHideTimeout()
  clearSource(closeAnimationSourceId)
  closeAnimationSourceId = 0
  closingOsd = false
  hideOsdWindowNow()
}

function closeOsd() {
  clearHideTimeout()

  if (!windowVisible()) {
    closingOsd = false
    setOsdFramePresented(false)
    return
  }

  if (closingOsd) return

  closingOsd = true

  if (!getOsdFrameRevealChild()) {
    finishCloseOsd()
    return
  }

  setOsdFramePresented(false)
  closeAnimationSourceId = clearSource(closeAnimationSourceId)
  closeAnimationSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_REVEAL_DURATION_MS, () => {
    closeAnimationSourceId = 0
    finishCloseOsd()
    return GLib.SOURCE_REMOVE
  })
}

function slideOsdInWhenMapped() {
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (!windowVisible() || closingOsd) return GLib.SOURCE_REMOVE
    setOsdFramePresented(true)
    return GLib.SOURCE_REMOVE
  })
}

function presentOsd(nextValue: number, nextIcon: string, isMuted = false) {
  clearHideTimeout()
  closeAnimationSourceId = clearSource(closeAnimationSourceId)
  closingOsd = false

  animateValue(nextValue)
  setIcon(nextIcon)
  setMuted(isMuted)

  if (!windowVisible()) {
    setOsdFramePresented(false)
    showOsdWindowNow()
    slideOsdInWhenMapped()
  } else {
    setOsdFramePresented(true)
  }

  hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_AUTO_HIDE_DELAY_MS, () => {
    hideSourceId = 0
    closeOsd()
    return GLib.SOURCE_REMOVE
  })
}

function scheduleVolumeOsd(snapshot: AudioSnapshot) {
  pendingVolumeSnapshot = snapshot
  volumeNotifyDebounceId = clearSource(volumeNotifyDebounceId)

  volumeNotifyDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OSD_VOLUME_NOTIFY_DEBOUNCE_MS, () => {
    volumeNotifyDebounceId = 0
    const nextSnapshot = pendingVolumeSnapshot
    pendingVolumeSnapshot = null

    if (nextSnapshot && shouldNotifyForExternalVolumeChange()) {
      presentOsd(nextSnapshot.value, nextSnapshot.icon, nextSnapshot.muted)
    }

    return GLib.SOURCE_REMOVE
  })
}

function applyVolumeSnapshot(snapshot: AudioSnapshot, notify: boolean) {
  const key = `${snapshot.percent}:${snapshot.muted ? 1 : 0}`

  if (!lastVolumeKey) {
    lastVolumeKey = key
    setValue(snapshot.value)
    setIcon(snapshot.icon)
    setMuted(snapshot.muted)
    return
  }

  if (key === lastVolumeKey) return

  lastVolumeKey = key
  setIcon(snapshot.icon)
  setMuted(snapshot.muted)

  if (notify && shouldNotifyForExternalVolumeChange()) {
    scheduleVolumeOsd(snapshot)
  } else {
    setValue(snapshot.value)
  }
}

async function syncVolumeFromWpctl(notify: boolean) {
  if (volumeBusy) return
  volumeBusy = true

  try {
    const output = await execAsync(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"])
    applyVolumeSnapshot(parseVolume(output), notify)
  } catch (error) {
    console.error(error)
  } finally {
    volumeBusy = false
  }
}

function readGObjectValue(target: any, getter: string, property: string, fallback: unknown) {
  try {
    if (target && typeof target[getter] === "function") return target[getter]()
  } catch {}

  try {
    if (target && property in target) return target[property]
  } catch {}

  try {
    if (target && typeof target.get_property === "function") return target.get_property(property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`))
  } catch {}

  return fallback
}

function getDefaultSpeaker(wp: any, audio: any) {
  try {
    if (audio && typeof audio.get_default_speaker === "function") return audio.get_default_speaker()
  } catch {}

  try {
    if (audio?.defaultSpeaker) return audio.defaultSpeaker
  } catch {}

  try {
    if (wp && typeof wp.get_default_speaker === "function") return wp.get_default_speaker()
  } catch {}

  try {
    if (wp?.defaultSpeaker) return wp.defaultSpeaker
  } catch {}

  return null
}

function readSpeakerSnapshot(speaker: any): AudioSnapshot | null {
  if (!speaker) return null

  const rawVolume = Number(readGObjectValue(speaker, "get_volume", "volume", 0))
  const rawMuted = Boolean(readGObjectValue(speaker, "get_mute", "mute", false))

  if (!Number.isFinite(rawVolume)) return null
  return makeSnapshot(rawVolume, rawMuted)
}

function disconnectBindings(bindings: SignalBinding[]) {
  for (const binding of bindings) {
    try {
      binding.target.disconnect(binding.id)
    } catch {}
  }

  bindings.length = 0
}

function connectSignal(bindings: SignalBinding[], target: any, signal: string, callback: (...args: any[]) => void) {
  if (!target || typeof target.connect !== "function") return

  try {
    const id = target.connect(signal, callback)
    if (typeof id === "number" && id > 0) bindings.push({ target, id })
  } catch {}
}

function bindWireplumberSpeaker(wp: any, audio: any, notify: boolean) {
  disconnectBindings(currentSpeakerSignals)

  const speaker = getDefaultSpeaker(wp, audio)
  currentSpeaker = speaker

  const snapshot = readSpeakerSnapshot(speaker)
  if (snapshot) applyVolumeSnapshot(snapshot, notify)

  if (!speaker) return

  const onSpeakerChanged = () => {
    const nextSnapshot = readSpeakerSnapshot(currentSpeaker)
    if (nextSnapshot) applyVolumeSnapshot(nextSnapshot, true)
  }

  connectSignal(currentSpeakerSignals, speaker, "notify::volume", onSpeakerChanged)
  connectSignal(currentSpeakerSignals, speaker, "notify::mute", onSpeakerChanged)
  connectSignal(currentSpeakerSignals, speaker, "params-changed", onSpeakerChanged)
}

async function startWireplumberBackend() {
  try {
    const moduleName = "gi://AstalWp?version=0.1"
    const module = await import(moduleName)
    const AstalWp = (module as any).default ?? module
    const wp = AstalWp.get_default?.() ?? AstalWp.Wp?.get_default?.()
    const audio = wp?.get_audio?.() ?? wp?.audio

    if (!wp || !audio) return false

    wireplumberReady = true

    const rebind = () => bindWireplumberSpeaker(wp, audio, true)
    connectSignal(wireplumberSignals, wp, "ready", () => bindWireplumberSpeaker(wp, audio, false))
    connectSignal(wireplumberSignals, wp, "notify::default-speaker", rebind)
    connectSignal(wireplumberSignals, audio, "notify::default-speaker", rebind)
    connectSignal(wireplumberSignals, audio, "speaker-added", rebind)
    connectSignal(wireplumberSignals, audio, "speaker-removed", rebind)

    bindWireplumberSpeaker(wp, audio, false)
    return true
  } catch {
    wireplumberReady = false
    return false
  }
}

function looksLikeUsefulPwDumpEvent(text: string) {
  const lower = text.toLowerCase()

  if (lower.includes("default.audio.sink")) return true
  if (!lower.includes("volume") && !lower.includes("mute")) return false
  if (lower.includes("audio/sink") || lower.includes("alsa_output") || lower.includes("bluez_output")) return true
  if (lower.includes("channelvolumes") || lower.includes("channel volumes")) return true

  return false
}

function schedulePwDumpVolumeSync() {
  pwDumpDebounceId = clearSource(pwDumpDebounceId)

  pwDumpDebounceId = GLib.timeout_add(GLib.PRIORITY_LOW, OSD_PW_DUMP_DEBOUNCE_MS, () => {
    pwDumpDebounceId = 0
    void syncVolumeFromWpctl(true)
    return GLib.SOURCE_REMOVE
  })
}

function startPwDumpBackend() {
  try {
    pwDumpProcess = subprocess({
      cmd: ["pw-dump", "-m", "-N"],
      out: (chunk) => {
        if (looksLikeUsefulPwDumpEvent(String(chunk))) schedulePwDumpVolumeSync()
      },
      err: (chunk) => {
        const message = String(chunk).trim()
        if (message) console.error(message)
      },
    })

    try {
      pwDumpProcess.connect("exit", () => {
        pwDumpProcess = null
        pwDumpDebounceId = clearSource(pwDumpDebounceId)

        if (initialized && !wireplumberReady && fallbackPollSourceId === 0) {
          startFallbackPolling()
        }
      })
    } catch {}

    void syncVolumeFromWpctl(false)
    return true
  } catch {
    pwDumpProcess = null
    return false
  }
}

function startFallbackPolling() {
  void syncVolumeFromWpctl(false)

  fallbackPollSourceId = GLib.timeout_add(GLib.PRIORITY_LOW, OSD_FALLBACK_POLL_INTERVAL_MS, () => {
    void syncVolumeFromWpctl(true)
    return GLib.SOURCE_CONTINUE
  })
}

function stopPwDumpBackend() {
  const proc = pwDumpProcess as any
  pwDumpProcess = null

  if (!proc) return

  try {
    if (typeof proc.force_exit === "function") proc.force_exit()
    else if (typeof proc.kill === "function") proc.kill()
    else if (typeof proc.send_signal === "function") proc.send_signal(15)
  } catch {}
}

export function initializeOsd() {
  if (initialized) return
  initialized = true
  startupSuppressUntil = GLib.get_monotonic_time() + OSD_STARTUP_SUPPRESS_MS * 1000

  void startWireplumberBackend().then((started) => {
    if (!initialized || started) return
    if (startPwDumpBackend()) return
    startFallbackPolling()
  })
}

const title = createComputed(() => muted() ? "Sound muted" : "Volume")
const percent = createComputed(() => `${Math.round(value() * 100)}%`)

export function OsdWindow() {
  return (
    <window
      visible={windowVisible}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-osd"
      class="osd-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.NONE}
      layer={Astal.Layer.OVERLAY}
      anchor={BOTTOM}
      $={(self) => {
        try {
          self.set_default_size(-1, -1)
          self.set_can_target(false)
          self.set_focusable(false)
        } catch {}
        osdWindow = self
        setLayerWindowMargins(self, { bottom: OSD_BOTTOM_MARGIN })
        self.connect("destroy", () => {
          initialized = false
          fallbackPollSourceId = clearSource(fallbackPollSourceId)
          hideSourceId = clearSource(hideSourceId)
          valueAnimationSourceId = clearSource(valueAnimationSourceId)
          closeAnimationSourceId = clearSource(closeAnimationSourceId)
          volumeNotifyDebounceId = clearSource(volumeNotifyDebounceId)
          pwDumpDebounceId = clearSource(pwDumpDebounceId)
          disconnectBindings(wireplumberSignals)
          disconnectBindings(currentSpeakerSignals)
          stopPwDumpBackend()
          volumeBusy = false
          lastVolumeKey = ""
          startupSuppressUntil = 0
          volumeSuppressUntil = 0
          pendingVolumeSnapshot = null
          wireplumberReady = false
          currentSpeaker = null
          osdWindow = null
          osdRevealer = null
          closingOsd = false
          setWindowVisible(false)
        })
      }}
    >
      <box
        class="osd-placement"
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.END}
        $={(self) => {
          self.set_can_target(false)
          self.set_focusable(false)
        }}
      >
        <revealer
          class="osd-revealer"
          revealChild={false}
          transitionType={Gtk.RevealerTransitionType.SLIDE_UP}
          transitionDuration={OSD_REVEAL_DURATION_MS}
          $={(self) => {
            osdRevealer = self
            self.set_can_target(false)
            self.set_focusable(false)

            try {
              self.set_valign(Gtk.Align.END)
            } catch {}
          }}
        >
          <box
            class="osd-frame"
            widthRequest={300}
            heightRequest={82}
            $={(self) => {
              self.set_can_target(false)
              self.set_focusable(false)
              clipRoundedWidget(self)
            }}
          >
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
          </box>
        </revealer>
      </box>
    </window>
  )
}
