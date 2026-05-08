import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { Astal } from "ags/gtk4"
import { For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import { VOLUME_STEP, clamp } from "../config"
import { suppressVolumeOsd } from "./Osd"
import { attachEscapeKey } from "./EscapeKey"
import { FLOATING_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, TOP_BAR_POPUP_MARGIN_TOP, isPointInsideWidget } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"

const AUDIO_POPOVER_WIDTH = 392
const AUDIO_LIST_MAX_HEIGHT = 220
const AUDIO_POPUP_MARGIN_END = POPUP_SCREEN_RIGHT
const POPOVER_REVEAL_DURATION_MS = 165
const STATE_HOME = (() => {
  const configured = GLib.getenv("XDG_STATE_HOME")?.trim() ?? ""
  if (configured.length > 0 && GLib.path_is_absolute(configured)) return configured
  return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"])
})()
const AUDIO_STATE_DIR = GLib.build_filenamev([STATE_HOME, "ags"])
const HIDDEN_SINKS_PATH = GLib.build_filenamev([AUDIO_STATE_DIR, "audio-hidden-sinks.json"])

const AUDIO_HIDE_ICON = "󰛑"
const AUDIO_RESTORE_ICON = "󰗡"

type SinkInfo = {
  id: string
  key: string
  name: string
  rawName: string
  meta: string
  current: boolean
  icon: string
}

function pickIcon(volume: number, muted: boolean) {
  if (muted) return "󰖁"
  if (volume <= 0.01) return "󰝟"
  if (volume < 0.5) return "󰕿"
  return "󰕾"
}

function sinkIcon(name: string) {
  const value = name.toLowerCase()
  if (value.includes("hyperx") || value.includes("headset") || value.includes("headphone") || value.includes("earbud")) return "󰋋"
  if (value.includes("hdmi") || value.includes("displayport") || value.includes("dp")) return "󰽟"
  if (value.includes("spdif") || value.includes("iec958") || value.includes("optical")) return "󰓃"
  if (value.includes("speaker") || value.includes("analog")) return "󰓃"
  return "󰕾"
}

function sinkTypeText(name: string) {
  const value = name.toLowerCase()
  if (value.includes("hyperx") || value.includes("headset") || value.includes("headphone") || value.includes("earbud")) return "Headset"
  if (value.includes("hdmi") || value.includes("displayport") || value.includes("dp")) return "HDMI / DisplayPort"
  if (value.includes("spdif") || value.includes("iec958") || value.includes("optical")) return "SPDIF / optical"
  if (value.includes("speaker") || value.includes("analog")) return "Analog output"
  return "Audio output"
}

function parseVolume(out: string) {
  const muted = out.includes("MUTED")
  const volume = clamp(Number.parseFloat(out.trim().split(/\s+/)[1] ?? "0") || 0)
  return { volume, muted, icon: pickIcon(volume, muted) }
}

function cleanupSinkName(raw: string) {
  const withoutVolume = raw.replace(/\s*\[vol:[^\]]*\]\s*/gi, " ")
  const withoutPipeWire = withoutVolume.replace(/\bpipewire\s+node\b/gi, " ")
  const simplified = withoutPipeWire
    .replace(/^alsa_output\.|^bluez_output\.|^\S+\.alsa\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b(output|monitor|sink|pci|usb|pro audio)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()

  return simplified || withoutVolume.trim() || raw.trim()
}

function buildSinkKey(id: string, rawName: string) {
  return `${id}:${cleanupSinkName(rawName).toLowerCase()}`
}

function parseSinks(status: string): SinkInfo[] {
  const lines = status.split("\n")
  const sinks: SinkInfo[] = []
  let inSinks = false

  for (const line of lines) {
    if (/Sinks:/i.test(line)) {
      inSinks = true
      continue
    }
    if (inSinks && /^\s*[├└]─\s/.test(line)) break
    if (!inSinks) continue

    const match = line.match(/^\s*│\s*(\*?)\s*(\d+)\.\s+(.+?)\s*(?:\[vol:[^\]]*\])?\s*$/i)
    if (!match) continue

    const [, star = "", id = "", rawName = ""] = match
    const name = cleanupSinkName(rawName)
    sinks.push({
      id,
      key: buildSinkKey(id, rawName),
      name,
      rawName,
      meta: sinkTypeText(rawName || name),
      current: star === "*",
      icon: sinkIcon(rawName || name),
    })
  }

  const counts = new Map<string, number>()
  for (const sink of sinks) counts.set(sink.name, (counts.get(sink.name) ?? 0) + 1)

  return sinks.map((sink) => ({
    ...sink,
    meta: (counts.get(sink.name) ?? 0) > 1 ? `${sink.meta} · ID ${sink.id}` : sink.meta,
  }))
}

function parseActiveStreams(status: string) {
  const ids: string[] = []
  let inStreams = false

  for (const line of status.split("\n")) {
    if (/Sink Inputs:/i.test(line)) {
      inStreams = true
      continue
    }
    if (inStreams && /^\s*[├└]─\s/.test(line)) break
    if (!inStreams) continue

    const match = line.match(/^\s*│\s*(?:\*\s*)?(\d+)\./)
    if (match?.[1]) ids.push(match[1])
  }

  return ids
}

async function getWpctlStatus() {
  try {
    return String(await execAsync(["bash", "-lc", "wpctl status"])).trim()
  } catch {
    return ""
  }
}

async function readHiddenSinkKeys() {
  try {
    const [ok, contents] = GLib.file_get_contents(HIDDEN_SINKS_PATH)
    if (!ok || !contents) return []

    const parsed = JSON.parse(new TextDecoder().decode(contents))
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []
  } catch {
    return []
  }
}

async function writeHiddenSinkKeys(keys: string[]) {
  try {
    GLib.mkdir_with_parents(AUDIO_STATE_DIR, 0o700)
    GLib.file_set_contents(HIDDEN_SINKS_PATH, JSON.stringify([...new Set(keys)].sort()))
  } catch (error) {
    console.error(error)
  }
}

export function AudioControl({
  monitor,
  onToggle,
  bindRevealer,
}: {
  monitor: number
  onToggle: () => void
  bindRevealer: (self: Gtk.Revealer) => void
}) {
  const [current, setCurrent] = createState(0)
  const [muted, setMuted] = createState(false)
  const [icon, setIcon] = createState("󰕾")
  const [showPercent, setShowPercent] = createState(false)
  const [hiddenSinkKeys, setHiddenSinkKeys] = createState<string[]>([])
  const [statusText, setStatusText] = createState("Output devices")
  const [showHidden, setShowHidden] = createState(false)
  const [allSinks, setAllSinks] = createState<SinkInfo[]>([])
  const [windowVisible, setWindowVisible] = createState(false)

  let flashTimeoutId: number | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let popupPlacement: Gtk.Box | null = null
  let trigger: Gtk.Button | null = null
  let refreshTimer = 0
  let closeTimeoutId = 0
  let closingPopup = false

  const popupRegistryId = `audio-devices-${monitor}`

  const isOpen = () => Boolean(windowVisible())

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const finishCloseDevicesPopup = () => {
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
    setShowHidden(false)
  }

  const isDevicesPopupRevealed = () => Boolean(popupRevealer?.get_reveal_child())

  const resetStaleDevicesPopupState = (reason: string) => {
    console.warn(`[popup:${popupRegistryId}] reset stale state: ${reason}`)
    finishCloseDevicesPopup()
  }

  const closeDevicesPopup = () => {
    if (!windowVisible()) {
      closingPopup = false
      setTriggerOpen(false)
      return
    }

    if (closingPopup) {
      finishCloseDevicesPopup()
      return
    }

    closingPopup = true

    if (isDevicesPopupRevealed()) {
      popupRevealer!.revealChild = false
      clearCloseTimeout()
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPOVER_REVEAL_DURATION_MS, () => {
        closeTimeoutId = 0
        finishCloseDevicesPopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishCloseDevicesPopup()
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

  const syncSinks = async () => {
    const [status, hidden] = await Promise.all([getWpctlStatus(), readHiddenSinkKeys()])
    const parsedSinks = parseSinks(status)
    const validKeys = new Set(parsedSinks.map((sink) => sink.key))
    const validHidden = hidden.filter((key) => validKeys.has(key))

    setAllSinks(parsedSinks)
    setHiddenSinkKeys(validHidden)
    setStatusText(parsedSinks.length > 0 ? `${parsedSinks.length} outputs` : "No sinks found")
    if (validHidden.length !== hidden.length) await writeHiddenSinkKeys(validHidden)
  }

  const syncVolume = async () => {
    try {
      const out = await execAsync(["bash", "-lc", "wpctl get-volume @DEFAULT_AUDIO_SINK@ || echo 'Volume: 0'"])
      const parsed = parseVolume(out)
      setCurrent(parsed.volume)
      setMuted(parsed.muted)
      setIcon(parsed.icon)
    } catch (err) {
      console.error(err)
    }
  }

  const refresh = async () => {
    await Promise.all([syncVolume(), syncSinks()])
  }

  const percent = current((v) => `${Math.round(v * 100)}%`)
  const visibleSinks = createComputed(() => {
    const hidden = hiddenSinkKeys()
    const list = allSinks()
    if (showHidden()) return list.filter((sink) => hidden.includes(sink.key) && !sink.current)
    return list.filter((sink) => !hidden.includes(sink.key) || sink.current)
  })
  const hiddenCount = createComputed(() => allSinks().filter((sink) => hiddenSinkKeys().includes(sink.key) && !sink.current).length)
  const hiddenToggleVisible = createComputed(() => hiddenCount() > 0 || showHidden())
  const hiddenToggleLabel = createComputed(() => showHidden() ? "Back" : `Hidden ${hiddenCount()}`)
  const listTitle = createComputed(() => showHidden() ? `Hidden outputs ${hiddenCount()}` : "Audio outputs")
  const currentSinkName = createComputed(() => allSinks().find((sink) => sink.current)?.name ?? "Audio output")
  const triggerLabel = createComputed(() => showPercent() ? `${Math.round(current() * 100)}%` : icon())
  const triggerTooltip = createComputed(() => {
    const value = Math.round(current() * 100)
    return `${muted() ? "Muted" : "Sound"} ${value}% • LMB volume • RMB devices • ${currentSinkName()}`
  })
  const muteTooltip = createComputed(() => muted() ? "Unmute sound" : "Mute sound")

  const setVolume = (nextValue: number) => {
    const next = clamp(nextValue)
    suppressVolumeOsd()
    setCurrent(next)
    setMuted(false)
    setIcon(pickIcon(next, false))
    void execAsync(["bash", "-lc", `wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ ${next.toFixed(2)}`]).catch(console.error)
  }

  const adjustVolume = (delta: number) => {
    setCurrent((prev) => {
      const next = clamp(prev + delta)
      suppressVolumeOsd()
      setMuted(false)
      setIcon(pickIcon(next, false))
      void execAsync(["bash", "-lc", `wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ ${next.toFixed(2)}`]).catch(console.error)
      return next
    })
  }

  const toggleMute = () => {
    suppressVolumeOsd()
    void execAsync(["bash", "-lc", "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"])
      .then(() => syncVolume())
      .catch(console.error)
  }

  const chooseSink = async (sink: SinkInfo) => {
    setStatusText(`Switching to ${sink.name}`)
    const status = await getWpctlStatus()
    const streams = parseActiveStreams(status)
    const moveStreams = streams.map((id) => `wpctl move ${id} ${sink.id}`).join("; ")
    await execAsync(["bash", "-lc", `wpctl set-default ${sink.id}${moveStreams ? `; ${moveStreams}` : ""}`]).catch(console.error)
    await refresh()
  }

  const restoreSink = async (sink: SinkInfo) => {
    const next = hiddenSinkKeys().filter((key) => key !== sink.key)
    setHiddenSinkKeys(next)
    await writeHiddenSinkKeys(next).catch(console.error)
    await syncSinks()
  }

  const hideSink = async (sink: SinkInfo) => {
    if (sink.current) return
    const next = [...new Set([...hiddenSinkKeys(), sink.key])]
    setHiddenSinkKeys(next)
    await writeHiddenSinkKeys(next).catch(console.error)
    await syncSinks()
  }

  const openDevicesPopup = () => {
    if (windowVisible()) {
      if (closingPopup || !isDevicesPopupRevealed()) resetStaleDevicesPopupState("open requested while visible but not revealed")
      else return
    }

    closeOtherPopups(popupRegistryId)
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    setShowHidden(false)
    void refresh()

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStaleDevicesPopupState("revealer missing after open")
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const toggleDevicesPopup = () => {
    if (closingPopup) {
      resetStaleDevicesPopupState("toggle requested while closing")
      openDevicesPopup()
      return
    }

    if (windowVisible()) {
      if (!isDevicesPopupRevealed()) {
        resetStaleDevicesPopupState("toggle requested while visible but not revealed")
        openDevicesPopup()
        return
      }

      closeDevicesPopup()
      return
    }

    openDevicesPopup()
  }

  const unregisterPopupController = registerPopupController(popupRegistryId, { close: closeDevicesPopup })

  const popupContent = (
    <box class="network-popover audio-popover" orientation={Gtk.Orientation.VERTICAL} spacing={10} widthRequest={AUDIO_POPOVER_WIDTH}>
      <box class="network-header audio-header" spacing={8} valign={Gtk.Align.CENTER}>
        <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
          <label class="network-header-title audio-header-title" xalign={0} label={listTitle} ellipsize={Pango.EllipsizeMode.END} />
          <label class="network-header-meta audio-header-meta" xalign={0} label={statusText} />
        </box>
        <button
          class="flat launcher-hidden-toggle"
          valign={Gtk.Align.CENTER}
          vexpand={false}
          visible={hiddenToggleVisible}
          onClicked={() => setShowHidden((value) => !value)}
        >
          <label label={hiddenToggleLabel} />
        </button>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <label class="network-section-title" label={showHidden((value) => value ? "Hidden" : "Outputs")} xalign={0} />
        <box class="network-list-capsule audio-list-capsule" orientation={Gtk.Orientation.VERTICAL}>
          <Gtk.ScrolledWindow
            class="network-list-scroller audio-list-scroller"
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
            kineticScrolling
            propagateNaturalHeight
            maxContentHeight={AUDIO_LIST_MAX_HEIGHT}
          >
            <box class="network-list-inner audio-list-inner" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
              <For each={visibleSinks}>{(sink) => (
                <box class={sink.current ? "network-row-shell audio-sink-row audio-sink-current" : "network-row-shell audio-sink-row"} orientation={Gtk.Orientation.HORIZONTAL} spacing={4} hexpand valign={Gtk.Align.CENTER}>
                  <button class="flat audio-sink-main" hexpand halign={Gtk.Align.FILL} onClicked={() => chooseSink(sink)}>
                    <box class="network-row-body audio-sink-body" orientation={Gtk.Orientation.HORIZONTAL} spacing={10} hexpand valign={Gtk.Align.CENTER}>
                      <label class="network-row-icon audio-sink-icon" label={sink.icon} />
                      <box class="audio-sink-content" orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
                        <label class="network-row-title audio-sink-name" xalign={0} label={sink.name} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={28} />
                        <label
                          class="network-row-meta audio-sink-meta"
                          xalign={0}
                          label={showHidden() ? "Hidden output" : sink.meta}
                          ellipsize={Pango.EllipsizeMode.END}
                          maxWidthChars={38}
                        />
                      </box>
                      <label class="network-row-status audio-sink-status" label={sink.current ? "󰄬" : ""} />
                    </box>
                  </button>
                  <button
                    class="flat network-icon-button audio-sink-side-button"
                    tooltipText={showHidden() ? "Restore output" : "Hide output"}
                    visible={showHidden() || !sink.current}
                    onClicked={() => (showHidden() ? restoreSink(sink) : hideSink(sink))}
                    valign={Gtk.Align.CENTER}
                  >
                    <label class="network-icon-button-label" label={showHidden() ? AUDIO_RESTORE_ICON : AUDIO_HIDE_ICON} />
                  </button>
                </box>
              )}</For>

              <box
                visible={visibleSinks((list) => list.length === 0)}
                orientation={Gtk.Orientation.VERTICAL}
                halign={Gtk.Align.CENTER}
                valign={Gtk.Align.CENTER}
                vexpand
              >
                <label class="network-empty" label={showHidden((value) => value ? "No hidden outputs" : "No sinks found")} />
              </box>
            </box>
          </Gtk.ScrolledWindow>
        </box>
      </box>
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      namespace="obsidian-shell-audio-devices"
      class="widget-popup-window audio-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
      $={(self) => {
        self.connect("destroy", () => {
          popupRevealer = null
          popupFrame = null
          popupRoot = null
          popupPlacement = null
        })
      }}
    >
      <box class="widget-popup-root" hexpand vexpand $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachEscapeKey(self, closeDevicesPopup)
      }}>
        <Gtk.GestureClick
          button={0}
          propagationPhase={Gtk.PropagationPhase.CAPTURE}
          onReleased={(_, _nPress, x, y) => {
            const root = popupPlacement?.get_parent?.() as Gtk.Widget | null
            if (isPointInsideWidget(popupFrame, root, x, y)) return
            closeDevicesPopup()
          }}
        />

        <box
          class="widget-popup-placement"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          $={(self) => {
            popupPlacement = self
            self.set_margin_top(TOP_BAR_POPUP_MARGIN_TOP)
            self.set_margin_end(AUDIO_POPUP_MARGIN_END)
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame network-popover-window audio-popover-window" widthRequest={AUDIO_POPOVER_WIDTH} $={(self) => (popupFrame = self)}>
              {popupContent}
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <box
      class="quick-control inline-control audio-shell"
      spacing={6}
      hexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        void refresh()
        refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          void refresh()
          return GLib.SOURCE_CONTINUE
        })
        self.connect("destroy", () => {
          unregisterPopupController()
          clearCloseTimeout()
          if (refreshTimer) GLib.source_remove(refreshTimer)
          if (flashTimeoutId) GLib.source_remove(flashTimeoutId)
          closingPopup = false
          setWindowVisible(false)
          setTriggerOpen(false)
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
        <box class="inline-panel slider-panel" spacing={8} hexpand={false} halign={Gtk.Align.START} valign={Gtk.Align.CENTER}>
          <button class="icon-button panel-icon-button flat" valign={Gtk.Align.CENTER} tooltipText={muteTooltip} onClicked={toggleMute}>
            <label class="module-icon" label={icon} />
          </button>
          <slider class="slider-control" hexpand min={0} max={1} step={0.01} value={current} onChangeValue={({ value }) => setVolume(value)} />
          <label class="slider-value" label={percent} />
        </box>
      </revealer>

      <button class="icon-button quick-toggle audio-trigger flat" valign={Gtk.Align.CENTER} tooltipText={triggerTooltip} onClicked={onToggle} $={(self) => (trigger = self)}>
        <Gtk.GestureClick button={3} propagationPhase={Gtk.PropagationPhase.CAPTURE} onReleased={toggleDevicesPopup} />
        <Gtk.EventControllerScroll
          flags={Gtk.EventControllerScrollFlags.VERTICAL}
          onScroll={(_, _dx, dy) => {
            if (dy < 0) adjustVolume(VOLUME_STEP)
            else if (dy > 0) adjustVolume(-VOLUME_STEP)
            flashPercent()
            return true
          }}
        />
        <label class={showPercent((shown) => shown ? "module-percent volume-percent" : "module-icon")} label={triggerLabel} />
      </button>
    </box>
  )
}
