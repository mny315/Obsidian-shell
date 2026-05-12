import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { Astal } from "ags/gtk4"
import { For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import { VOLUME_STEP, clamp } from "../config"
import { suppressVolumeOsd } from "./Osd"
import { attachEscapeKey } from "./EscapeKey"
import {
  DEFAULT_POPUP_Y,
  RIGHT_TOP_POPUP_ANCHOR,
  POPUP_SCREEN_RIGHT,
  attachPopupFocusDismiss,
  clipRoundedWidget,
  placeLayerWindowAtTopRight,
} from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"

const AUDIO_POPOVER_WIDTH = 392
const AUDIO_LIST_MAX_HEIGHT = 242
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
  keys: string[]
  persistKeys: string[]
  name: string
  rawName: string
  meta: string
  current: boolean
  icon: string
}

type ParsedSinkInfo = Omit<SinkInfo, "key" | "keys" | "persistKeys"> & {
  nodeName: string
}

type WpctlProperties = Record<string, string>

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

function normalizeSinkKeyPart(value: string) {
  return value
    .replace(/\s*\[vol:[^\]]*\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function stableSinkKeyBase(rawName: string) {
  return normalizeSinkKeyPart(cleanupSinkName(rawName)) || normalizeSinkKeyPart(rawName)
}

function buildSinkKey(rawName: string, duplicateIndex: number) {
  const base = stableSinkKeyBase(rawName)
  return duplicateIndex > 1 ? `${base}#${duplicateIndex}` : base
}

function migrateLegacySinkKey(key: string) {
  return key.replace(/^\d+:/, "")
}

function normalizeHiddenSinkKeys(keys: string[]) {
  return [...new Set(keys.map((key) => migrateLegacySinkKey(key).trim()).filter(Boolean))].sort()
}

function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

function sinkHiddenByKeys(sink: SinkInfo, hidden: string[]) {
  const hiddenSet = new Set(hidden)
  return sink.keys.some((key) => hiddenSet.has(key))
}

function expandHiddenSinkKeysForCurrentSinks(hidden: string[], sinks: SinkInfo[]) {
  const next = new Set(hidden)
  for (const sink of sinks) {
    if (!sinkHiddenByKeys(sink, hidden)) continue
    for (const key of sink.persistKeys) next.add(key)
  }
  return [...next].sort()
}

type ParsedWpctlSinkLine = {
  id: string
  rawName: string
  current: boolean
}

function parseWpctlSinkLines(status: string): ParsedWpctlSinkLine[] {
  const lines = status.split("\n")
  const sinks: ParsedWpctlSinkLine[] = []
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
    sinks.push({ id, rawName: rawName.trim(), current: star === "*" })
  }

  return sinks
}

function parseSinksFromStatus(status: string, nameStatus = ""): ParsedSinkInfo[] {
  const namedById = new Map(parseWpctlSinkLines(nameStatus).map((sink) => [sink.id, sink.rawName]))

  return parseWpctlSinkLines(status).map((sink) => {
    const name = cleanupSinkName(sink.rawName)
    const nodeName = namedById.get(sink.id) ?? ""
    return {
      id: sink.id,
      name,
      rawName: sink.rawName,
      nodeName,
      meta: sinkTypeText(sink.rawName || name),
      current: sink.current,
      icon: sinkIcon(sink.rawName || name),
    }
  })
}

function parseWpctlProperties(output: string): WpctlProperties {
  const properties: WpctlProperties = {}

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(?:\*\s*)?([A-Za-z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*$/)
    if (!match) continue
    const [, key = "", doubleQuoted = "", singleQuoted = "", plain = ""] = match
    const value = (doubleQuoted || singleQuoted || plain).trim()
    if (key && value) properties[key] = value
  }

  return properties
}

async function getSinkProperties(id: string): Promise<WpctlProperties> {
  try {
    return parseWpctlProperties(String(await execAsync(["bash", "-lc", `wpctl inspect -a ${id}`])))
  } catch {
    return {}
  }
}

function normalizedPropertyValue(value: string) {
  return value
    .replace(/\s*\[vol:[^\]]*\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function sinkIdentityCandidates(sink: ParsedSinkInfo, properties: WpctlProperties) {
  const stableKeys: string[] = []
  const legacyKeys: string[] = []
  const pushStable = (kind: string, value: string) => {
    const normalized = normalizedPropertyValue(value)
    if (normalized) stableKeys.push(`${kind}:${normalized}`)
  }
  const pushLegacy = (value: string) => {
    const normalized = stableSinkKeyBase(value)
    if (normalized) legacyKeys.push(normalized)
  }

  const nodeName = properties["node.name"] || sink.nodeName || ""
  const deviceName = properties["device.name"] ?? ""
  const alsaPath = properties["api.alsa.path"] ?? ""
  const alsaCardName = properties["alsa.card_name"] ?? properties["device.product.name"] ?? ""
  const profile = properties["device.profile.name"] ?? properties["api.alsa.pcm.stream"] ?? ""
  const bluezAddress = properties["api.bluez5.address"] ?? properties["bluez5.address"] ?? ""
  const deviceSerial = properties["device.serial"] ?? ""
  const busId = properties["device.bus-id"] ?? properties["device.bus-path"] ?? properties["device.bus_path"] ?? ""

  pushStable("node", nodeName)
  if (deviceName) pushStable("device-node", [deviceName, profile || nodeName].filter(Boolean).join("|"))
  if (alsaPath) pushStable("alsa-path", [alsaPath, profile || nodeName || alsaCardName].filter(Boolean).join("|"))
  if (bluezAddress) pushStable("bluez", [bluezAddress, profile || nodeName].filter(Boolean).join("|"))
  if (deviceSerial && nodeName) pushStable("serial-node", `${deviceSerial}|${nodeName}`)
  if (busId && nodeName) pushStable("bus-node", `${busId}|${nodeName}`)
  pushLegacy(sink.rawName)

  return {
    stableKeys: [...new Set(stableKeys.filter(Boolean))],
    legacyKeys: [...new Set(legacyKeys.filter(Boolean))],
  }
}

async function parseSinks(status: string, nameStatus = ""): Promise<SinkInfo[]> {
  const sinks = parseSinksFromStatus(status, nameStatus)
  const sinkProperties = await Promise.all(sinks.map((sink) => getSinkProperties(sink.id)))
  const nameCounts = new Map<string, number>()
  const legacyKeyCounts = new Map<string, number>()
  const stableCandidateCounts = new Map<string, number>()
  const rawCandidates = sinks.map((sink, index) => sinkIdentityCandidates(sink, sinkProperties[index] ?? {}))

  for (const sink of sinks) nameCounts.set(sink.name, (nameCounts.get(sink.name) ?? 0) + 1)
  for (const candidates of rawCandidates) {
    for (const candidate of candidates.stableKeys) stableCandidateCounts.set(candidate, (stableCandidateCounts.get(candidate) ?? 0) + 1)
  }

  return sinks.map((sink, index) => {
    const legacyKeyBase = stableSinkKeyBase(sink.rawName)
    const duplicateIndex = (legacyKeyCounts.get(legacyKeyBase) ?? 0) + 1
    legacyKeyCounts.set(legacyKeyBase, duplicateIndex)

    const candidates = rawCandidates[index] ?? { stableKeys: [], legacyKeys: [] }
    const stableKeys = candidates.stableKeys.filter((key) => (stableCandidateCounts.get(key) ?? 0) === 1)
    const legacyKey = buildSinkKey(sink.rawName, duplicateIndex)
    const legacyKeys = [...new Set([...candidates.legacyKeys, legacyKey].filter(Boolean))]
    const persistKeys = stableKeys.length > 0 ? stableKeys : legacyKeys
    const keys = [...new Set([...persistKeys, ...legacyKeys].filter(Boolean))]

    return {
      ...sink,
      key: keys[0] ?? legacyKey,
      keys,
      persistKeys,
      meta: (nameCounts.get(sink.name) ?? 0) > 1 ? `${sink.meta} · ${sink.nodeName || sink.id}` : sink.meta,
    }
  })
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

async function getWpctlStatus(useNodeNames = false) {
  try {
    return String(await execAsync(["bash", "-lc", useNodeNames ? "wpctl status -n" : "wpctl status"])).trim()
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
  let popupWindowRef: Gtk.Window | null = null
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

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const syncDevicesPopupPosition = () => {
    placeLayerWindowAtTopRight(popupWindowRef, {
      top: DEFAULT_POPUP_Y,
      right: POPUP_SCREEN_RIGHT,
    })
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
    const [status, nameStatus, hidden] = await Promise.all([getWpctlStatus(), getWpctlStatus(true), readHiddenSinkKeys()])
    const parsedSinks = await parseSinks(status, nameStatus)
    const normalizedHidden = normalizeHiddenSinkKeys(hidden)
    const expandedHidden = expandHiddenSinkKeysForCurrentSinks(normalizedHidden, parsedSinks)

    setAllSinks(parsedSinks)
    setHiddenSinkKeys(expandedHidden)
    setStatusText(parsedSinks.length > 0 ? `${parsedSinks.length} outputs` : "No sinks found")
    if (!sameStringList(expandedHidden, normalizeHiddenSinkKeys(hidden))) await writeHiddenSinkKeys(expandedHidden)
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
    if (showHidden()) return list.filter((sink) => sinkHiddenByKeys(sink, hidden))
    return list.filter((sink) => !sinkHiddenByKeys(sink, hidden))
  })
  const hiddenCount = createComputed(() => allSinks().filter((sink) => sinkHiddenByKeys(sink, hiddenSinkKeys())).length)
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
    const sinkKeys = new Set(sink.keys)
    const next = normalizeHiddenSinkKeys(hiddenSinkKeys().filter((key) => !sinkKeys.has(key)))
    setHiddenSinkKeys(next)
    await writeHiddenSinkKeys(next).catch(console.error)
    await syncSinks()
  }

  const hideSink = async (sink: SinkInfo) => {
    if (sink.current) return
    const next = normalizeHiddenSinkKeys([...hiddenSinkKeys(), ...sink.persistKeys])
    setHiddenSinkKeys(next)
    await writeHiddenSinkKeys(next).catch(console.error)
    await syncSinks()
  }

  const openDevicesPopup = () => {
    if (windowVisible()) {
      if (closingPopup || !isDevicesPopupRevealed()) resetStaleDevicesPopupState("open requested while visible but not revealed")
      else {
        syncDevicesPopupPosition()
        return
      }
    }

    closeOtherPopups(popupRegistryId)
    clearCloseTimeout()
    closingPopup = false
    syncDevicesPopupPosition()
    setWindowVisible(true)
    setTriggerOpen(true)
    setShowHidden(false)
    void refresh()

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncDevicesPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStaleDevicesPopupState("revealer missing after open")
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const toggleDevicesPopup = () => {
    if (closingPopup) {
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
            vscrollbarPolicy={Gtk.PolicyType.NEVER}
            kineticScrolling
            propagateNaturalHeight
            minContentHeight={96}
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
                    visible={showHidden() || !sink.current}
                    onClicked={() => (showHidden() ? restoreSink(sink) : hideSink(sink))}
                    valign={Gtk.Align.CENTER}
                    $={(self) => attachShellTooltip(self, () => showHidden() ? "Restore output" : "Hide output")}
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
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-audio-devices"
      class="widget-popup-window audio-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={RIGHT_TOP_POPUP_ANCHOR}
      $={(self) => {
        popupWindowRef = self
        try {
          self.set_default_size(-1, -1)
        } catch {}
        self.connect("destroy", () => {
          popupWindowRef = null
          popupRevealer = null
          popupFrame = null
          popupRoot = null
          popupPlacement = null
        })
      }}
    >
      <box class="widget-popup-root" $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachPopupFocusDismiss(self, closeDevicesPopup)
        attachEscapeKey(self, closeDevicesPopup)
      }}>
        <box
          class="widget-popup-placement"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          $={(self) => {
            popupPlacement = self
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame network-popover-window audio-popover-window" widthRequest={AUDIO_POPOVER_WIDTH} $={(self) => {
              clipRoundedWidget(self)
              popupFrame = self
            }}>
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
          if (refreshTimer) GLib.source_remove(refreshTimer)
          if (flashTimeoutId) GLib.source_remove(flashTimeoutId)
          clearCloseTimeout()
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
          <button class="icon-button panel-icon-button flat" valign={Gtk.Align.CENTER} onClicked={toggleMute} $={(self) => attachShellTooltip(self, muteTooltip)}>
            <label class="module-icon" label={icon} />
          </button>
          <slider class="slider-control" hexpand min={0} max={1} step={0.01} value={current} onChangeValue={({ value }) => setVolume(value)} />
          <label class="slider-value" label={percent} />
        </box>
      </revealer>

      <button class="icon-button quick-toggle audio-trigger flat" valign={Gtk.Align.CENTER} onClicked={() => {
        onToggle()
      }} $={(self) => {
        trigger = self
        attachShellTooltip(self, triggerTooltip)
      }}>
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
