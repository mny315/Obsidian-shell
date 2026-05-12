import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import AstalNetwork from "gi://AstalNetwork"

import { Astal } from "ags/gtk4"
import { createComputed, createState } from "ags"
import { execAsync } from "ags/process"
import { timeout } from "ags/time"
import { attachEscapeKey } from "./EscapeKey"
import { RIGHT_TOP_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowAtTopRight } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"

const POPOVER_REVEAL_DURATION_MS = 165
const NETWORK_POPOVER_WIDTH = 392
const NETWORK_STARTUP_DELAY_MS = 700
const WIFI_DEVICE_RETRY_DELAY_MS = 350
const WIFI_DEVICE_RETRY_LIMIT = 12
const WIFI_SCAN_SETTLE_DELAY_MS = 1600
const BAR_WIFI_ICON = "󰤨"
const BAR_WIFI_OFF_ICON = "󰖪"
const VLESS_SERVICE_NAME = "sing-box.service"

type WifiNetwork = {
  inUse: boolean
  ssid: string
  signal: number
  security: string
  saved: boolean
}

type WireGuardProfile = {
  uuid: string
  name: string
  active: boolean
}

type Command = string[]

type LabelOptions = {
  xalign?: number
  hexpand?: boolean
  ellipsize?: Pango.EllipsizeMode
  maxWidthChars?: number
  singleLine?: boolean
  wrap?: boolean
}

type NoticeOptions = {
  durationMs?: number
}

type SignalSource = {
  connect: (signal: string, callback: () => void) => number
  disconnect: (id: number) => void
}

type AstalAccessPoint = SignalSource & {
  ssid?: string | null
  strength?: number
  requiresPassword?: boolean
  requires_password?: boolean
  bssid?: string
  get_path?: () => string
  getPath?: () => string
}

type AstalWifi = SignalSource & {
  enabled?: boolean
  accessPoints?: AstalAccessPoint[]
  access_points?: AstalAccessPoint[]
  activeAccessPoint?: AstalAccessPoint | null
  active_access_point?: AstalAccessPoint | null
  ssid?: string | null
  strength?: number
  scan?: () => void
  get_access_points?: () => unknown
  get_active_access_point?: () => AstalAccessPoint | null
}

type AstalNetworkService = SignalSource & {
  client?: SignalSource
  wifi?: AstalWifi | null
  get_client?: () => SignalSource | null
  get_wifi?: () => AstalWifi | null
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => {
    timeout(ms, () => resolve())
  })
}

function errorText(error: unknown) {
  return typeof error === "string"
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : String(error).trim()
}

async function execText(command: Command) {
  try {
    return String(await execAsync(command)).trim()
  } catch {
    return ""
  }
}

async function execResult(command: Command) {
  try {
    const out = await execAsync(command)
    return {
      ok: true,
      text: String(out).trim(),
    }
  } catch (error) {
    return {
      ok: false,
      text: errorText(error),
    }
  }
}

async function isNetworkManagerReady() {
  return Boolean(await execText(["nmcli", "-t", "-f", "STATE", "general", "status"]))
}

async function getSystemdActiveState(unit: string) {
  return (await execText(["systemctl", "show", unit, "--property=ActiveState", "--value"])).trim()
}

async function getVlessServiceActive() {
  return (await getSystemdActiveState(VLESS_SERVICE_NAME)) === "active"
}

function appendServiceMeta(base: string, wireGuardActive: boolean, vlessActive: boolean) {
  const markers = [vlessActive ? "VLESS" : "", wireGuardActive ? "WireGuard" : ""].filter(Boolean)
  return markers.length > 0 ? `${base} • ${markers.join(" • ")}` : base
}

async function getNmcliWifiEnabled() {
  const out = (await execText(["nmcli", "-t", "-f", "WIFI", "general", "status"])).toLowerCase()
  return out === "enabled"
}

function getAstalNetwork() {
  try {
    return AstalNetwork.get_default() as AstalNetworkService
  } catch (error) {
    console.warn(`AstalNetwork unavailable: ${errorText(error)}`)
    return null
  }
}

function getAstalWifi() {
  const network = getAstalNetwork()
  return network?.get_wifi?.() ?? network?.wifi ?? null
}

function getAstalClient() {
  const network = getAstalNetwork()
  return network?.get_client?.() ?? network?.client ?? null
}

function getAstalWifiEnabled(wifi = getAstalWifi()) {
  if (!wifi || typeof wifi.enabled !== "boolean") return null
  return wifi.enabled
}

async function getWifiEnabled() {
  const astalEnabled = getAstalWifiEnabled()
  if (astalEnabled !== null) return astalEnabled
  return getNmcliWifiEnabled()
}

function setAstalWifiEnabled(enabled: boolean) {
  const wifi = getAstalWifi()
  if (!wifi) return false
  try {
    wifi.enabled = enabled
    return true
  } catch (error) {
    console.warn(`Astal Wi‑Fi toggle failed: ${errorText(error)}`)
    return false
  }
}

function accessPointPath(accessPoint: AstalAccessPoint | null | undefined) {
  if (!accessPoint) return ""
  try {
    return accessPoint.get_path?.() ?? accessPoint.getPath?.() ?? ""
  } catch {
    return ""
  }
}

function accessPointSsid(accessPoint: AstalAccessPoint | null | undefined) {
  return accessPoint?.ssid?.trim() ?? ""
}

function accessPointSignal(accessPoint: AstalAccessPoint | null | undefined) {
  const strength = Number(accessPoint?.strength ?? 0)
  if (!Number.isFinite(strength)) return 0
  return Math.max(0, Math.min(100, Math.round(strength)))
}

function accessPointSecurityText(accessPoint: AstalAccessPoint | null | undefined) {
  const requiresPassword = Boolean(accessPoint?.requiresPassword ?? accessPoint?.requires_password ?? false)
  return requiresPassword ? "secured" : "open"
}

function getAstalActiveAccessPoint(wifi: AstalWifi | null | undefined) {
  if (!wifi) return null
  try {
    return wifi.get_active_access_point?.() ?? wifi.activeAccessPoint ?? wifi.active_access_point ?? null
  } catch {
    return null
  }
}

function asArray<T>(value: unknown) {
  if (!value) return [] as T[]
  if (Array.isArray(value)) return value as T[]
  if (typeof (value as Iterable<T>)[Symbol.iterator] === "function") return Array.from(value as Iterable<T>)
  return [] as T[]
}

function getAstalAccessPoints(wifi: AstalWifi | null | undefined) {
  if (!wifi) return []
  try {
    const points = wifi.get_access_points?.() ?? wifi.accessPoints ?? wifi.access_points ?? []
    return asArray<AstalAccessPoint>(points)
  } catch (error) {
    console.warn(`Astal Wi‑Fi access point read failed: ${errorText(error)}`)
    return []
  }
}

function getWifiNetworks(savedConnections: Map<string, string[]>) {
  const wifi = getAstalWifi()
  const activeAccessPoint = getAstalActiveAccessPoint(wifi)
  const activePath = accessPointPath(activeAccessPoint)
  const activeBssid = activeAccessPoint?.bssid ?? ""
  const networks = getAstalAccessPoints(wifi).map((accessPoint) => {
    const ssid = accessPointSsid(accessPoint)
    const path = accessPointPath(accessPoint)
    const bssid = accessPoint.bssid ?? ""
    return {
      inUse: Boolean(activeAccessPoint && (accessPoint === activeAccessPoint || (activePath && path === activePath) || (activeBssid && bssid === activeBssid))),
      ssid,
      signal: accessPointSignal(accessPoint),
      security: accessPointSecurityText(accessPoint),
      saved: savedConnections.has(ssid),
    }
  })

  const activeSsid = accessPointSsid(activeAccessPoint) || wifi?.ssid?.trim() || ""
  if (activeSsid && !networks.some(network => network.inUse || network.ssid === activeSsid)) {
    networks.push({
      inUse: true,
      ssid: activeSsid,
      signal: accessPointSignal(activeAccessPoint) || accessPointSignal(wifi as unknown as AstalAccessPoint),
      security: accessPointSecurityText(activeAccessPoint),
      saved: savedConnections.has(activeSsid),
    })
  }

  return uniqueWifiNetworks(networks)
}

function scanWifiNetworks() {
  const wifi = getAstalWifi()
  if (!wifi?.scan) return false
  try {
    wifi.scan()
    return true
  } catch (error) {
    console.warn(`Astal Wi‑Fi scan failed: ${errorText(error)}`)
    return false
  }
}

async function getActiveWifiSsid() {
  const wifi = getAstalWifi()
  const activeSsid = accessPointSsid(getAstalActiveAccessPoint(wifi)) || wifi?.ssid?.trim() || ""
  if (activeSsid) return activeSsid

  const out = await execText(["nmcli", "-t", "-e", "yes", "-f", "NAME,TYPE", "connection", "show", "--active"])
  for (const line of out.split("\n")) {
    const [ssid = "", type = ""] = splitNmcliEscaped(line)
    if (type === "802-11-wireless") return ssid
  }
  return ""
}

function splitNmcliEscaped(raw: string) {
  const fields: string[] = []
  let current = ""
  let escape = false

  for (const ch of raw) {
    if (escape) {
      current += ch
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === ":") {
      fields.push(current)
      current = ""
      continue
    }
    current += ch
  }
  fields.push(current)
  return fields.map((value) => value.trim())
}

function clearChildren(box: Gtk.Box | null) {
  if (!box) return
  let child = box.get_first_child()
  while (child) {
    const next = child.get_next_sibling()
    box.remove(child)
    child = next
  }
}

function addClasses(widget: Gtk.Widget, classes: string) {
  for (const klass of classes.split(/\s+/)) {
    if (klass) widget.add_css_class(klass)
  }
}

function makeLabel(text: string, classes: string, options: LabelOptions = {}) {
  const label = new Gtk.Label({
    label: text,
    xalign: options.xalign ?? 0,
    hexpand: options.hexpand ?? true,
    wrap: options.wrap ?? false,
  })
  addClasses(label, classes)
  label.set_ellipsize(options.ellipsize ?? Pango.EllipsizeMode.NONE)
  label.set_single_line_mode(options.singleLine ?? false)
  if (options.maxWidthChars) {
    label.set_max_width_chars(options.maxWidthChars)
  }
  return label
}

function makeIconLabel(icon: string, classes: string) {
  const label = new Gtk.Label({
    label: icon,
    xalign: 0.5,
    valign: Gtk.Align.CENTER,
  })
  addClasses(label, classes)
  return label
}

function makeIconButton(
  icon: string,
  classes: string,
  tooltip: string,
  onClick: () => void,
  sensitive = true,
) {
  const button = new Gtk.Button({
    child: makeIconLabel(icon, "network-icon-button-label"),
    sensitive,
    valign: Gtk.Align.CENTER,
  })
  attachShellTooltip(button, () => tooltip)
  addClasses(button, `flat ${classes}`)
  button.connect("clicked", onClick)
  return button
}

function makeToggle(
  active: boolean,
  classes: string,
  onToggle: (active: boolean) => void,
) {
  const toggle = new Gtk.Switch({
    active,
    valign: Gtk.Align.CENTER,
    halign: Gtk.Align.END,
  })
  addClasses(toggle, classes)
  toggle.connect("notify::active", () => {
    onToggle(toggle.get_active())
  })
  return toggle
}

function makeRowBody(
  icon: string,
  title: string,
  meta: string,
  trailing: Gtk.Widget[] = [],
) {
  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 10,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  })
  addClasses(row, "network-row-body")

  row.append(makeIconLabel(icon, "network-row-icon"))

  const info = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  })

  info.append(
    makeLabel(title, "network-row-title", {
      singleLine: true,
      ellipsize: Pango.EllipsizeMode.END,
      maxWidthChars: 28,
    }),
  )

  info.append(
    makeLabel(meta, "network-row-meta", {
      singleLine: true,
      ellipsize: Pango.EllipsizeMode.END,
      maxWidthChars: 40,
    }),
  )

  const trailingBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  })

  for (const widget of trailing) {
    trailingBox.append(widget)
  }

  row.append(info)
  row.append(trailingBox)
  return row
}

function makeInfoRow(
  icon: string,
  title: string,
  meta: string,
  trailing: Gtk.Widget[] = [],
) {
  const row = new Gtk.Box({
    child: makeRowBody(icon, title, meta, trailing),
  })
  addClasses(row, "network-row-shell")
  return row
}

function makeRowButton(
  icon: string,
  title: string,
  meta: string,
  trailing: Gtk.Widget[] = [],
  onClick: () => void,
) {
  const button = new Gtk.Button({
    child: makeRowBody(icon, title, meta, trailing),
    hexpand: true,
    halign: Gtk.Align.FILL,
  })
  attachShellTooltip(button, () => title)
  addClasses(button, "flat network-row-shell")
  button.connect("clicked", onClick)
  return button
}

function makeRowWithAction(
  icon: string,
  title: string,
  meta: string,
  trailing: Gtk.Widget[] = [],
  onClick: (() => void) | null,
  actionIcon: string,
  actionClasses: string,
  actionTooltip: string,
  onAction: () => void,
  sensitive = true,
) {
  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 4,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  })
  addClasses(row, "network-row-shell")

  const body = makeRowBody(icon, title, meta, trailing)
  let main: Gtk.Widget

  if (onClick) {
    const button = new Gtk.Button({
      child: body,
      hexpand: true,
      halign: Gtk.Align.FILL,
    })
    attachShellTooltip(button, () => title)
    addClasses(button, "flat")
    button.connect("clicked", onClick)
    main = button
  } else {
    main = body
  }

  const action = makeIconButton(
    actionIcon,
    actionClasses,
    actionTooltip,
    onAction,
    sensitive,
  )

  row.append(main)
  row.append(action)
  return row
}

function uniqueWifiNetworks(networks: WifiNetwork[]) {
  const best = new Map<string, WifiNetwork>()
  for (const network of networks) {
    const key = network.ssid
    if (!key) continue
    const current = best.get(key)
    if (!current || (network.inUse && !current.inUse) || (!current.inUse && network.signal > current.signal)) {
      best.set(key, network)
    }
  }
  return Array.from(best.values()).sort((a, b) => {
    if (a.inUse !== b.inUse) return a.inUse ? -1 : 1
    return b.signal - a.signal
  })
}

function wifiSignalIcon(signal: number) {
  if (signal >= 80) return "󰤨"
  if (signal >= 60) return "󰤥"
  if (signal >= 40) return "󰤢"
  if (signal >= 20) return "󰤟"
  return "󰤮"
}

function configNameFromPath(path: string) {
  return path.split("/").pop()?.replace(/\.conf$/i, "").trim() ?? ""
}

function parseWireGuardImportResult(text: string) {
  const uuidMatch = text.match(/\(([0-9a-fA-F-]{36})\)/) ?? text.match(/uuid\s+([0-9a-fA-F-]{36})/i)
  const nameMatch = text.match(/Connection ['"]([^'"]+)['"]/i)
  return {
    uuid: uuidMatch?.[1]?.trim() ?? "",
    name: nameMatch?.[1]?.trim() ?? "",
  }
}

function importWireGuard(
  refresh: () => Promise<void>,
  presentStatus: (text: string, options?: NoticeOptions) => void,
) {
  const chooser = new Gtk.FileChooserNative({
    title: "Import WireGuard profile",
    action: Gtk.FileChooserAction.OPEN,
    acceptLabel: "Open",
    cancelLabel: "Cancel",
    modal: true,
  })
  const filter = new Gtk.FileFilter()
  filter.set_name("WireGuard (*.conf)")
  filter.add_pattern("*.conf")
  chooser.add_filter(filter)
  chooser.connect("response", async (_self, response) => {
    try {
      if (response !== Gtk.ResponseType.ACCEPT) return
      const path = chooser.get_file()?.get_path()?.trim()
      if (!path) return
      const result = await execResult(["nmcli", "connection", "import", "type", "wireguard", "file", path])
      if (!result.ok) {
        presentStatus(result.text || "Import failed")
        await refresh()
        return
      }
      const imported = parseWireGuardImportResult(result.text)
      const desiredName = configNameFromPath(path)
      if (desiredName && imported.name !== desiredName) {
        const target = imported.uuid ? ["uuid", imported.uuid] : [imported.name]
        await execResult(["nmcli", "connection", "modify", ...target, "connection.id", desiredName])
      }
      presentStatus("")
      await refresh()
    } finally {
      chooser.destroy()
    }
  })
  chooser.show()
}

export function NetworkControl({
  monitor,
  bindBarHoverWatcher,
}: {
  monitor: number
  bindBarHoverWatcher?: (watcher: (hovered: boolean) => void) => void
} = {
  monitor: 0,
}) {
  let trigger: Gtk.Button | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupPlacement: Gtk.Box | null = null
  let wifiListBox: Gtk.Box | null = null
  let wifiSectionBox: Gtk.Box | null = null
  let wgListBox: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let wifiSwitch: Gtk.Switch | null = null
  let passwordBox: Gtk.Box | null = null
  let passwordTitleLabel: Gtk.Label | null = null
  let passwordEntry: Gtk.Entry | null = null
  let statusLabel: Gtk.Label | null = null
  let rescanButton: Gtk.Button | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `network:${monitor}`

  let wifiEnabled = false
  let syncingWifiSwitch = false
  let pendingSecureNetwork: WifiNetwork | null = null
  let refreshDebounce: { cancel: () => void } | null = null
  let statusTimer: { cancel: () => void } | null = null
  let networkSignalIds: Array<[SignalSource, number]> = []
  let wifiSignalSource: SignalSource | null = null
  let startupRefreshId = 0
  let steadyRefreshId = 0
  let refreshInFlight = false
  let refreshAgain = false
  let firstRefresh = true
  let wifiDeviceRetryCount = 0

  const [icon, setIcon] = createState("󰖪")
  const [title, setTitle] = createState("Network")
  const [meta, setMeta] = createState("Loading…")
  const [vlessActive, setVlessActive] = createState(false)
  const [vlessBusy, setVlessBusy] = createState(false)
  const triggerTooltip = createComputed(() => `${title()} • ${meta()}`)

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  void bindBarHoverWatcher

  const deferAction = (fn: () => void | Promise<void>) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      Promise.resolve(fn()).catch((error) => {
        console.warn(`Network action failed: ${errorText(error)}`)
      })
      return GLib.SOURCE_REMOVE
    })
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const syncPopupPosition = () => {
    placeLayerWindowAtTopRight(popupWindowRef, {
      right: POPUP_SCREEN_RIGHT,
    })
  }

  const finishClosePopup = () => {
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const isPopupRevealed = () => Boolean(popupRevealer?.get_reveal_child())

  const resetStalePopupState = (reason: string) => {
    console.warn(`[popup:${popupRegistryId}] reset stale state: ${reason}`)
    finishClosePopup()
  }

  const closePopup = () => {
    if (!windowVisible()) {
      closingPopup = false
      setTriggerOpen(false)
      return
    }

    if (closingPopup) {
      finishClosePopup()
      return
    }

    closingPopup = true

    if (isPopupRevealed()) {
      popupRevealer!.revealChild = false
      clearCloseTimeout()
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPOVER_REVEAL_DURATION_MS, () => {
        closeTimeoutId = 0
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const unregisterPopupController = registerPopupController(popupRegistryId, { close: closePopup })

  const openPopup = () => {
    if (windowVisible()) {
      if (closingPopup || !isPopupRevealed()) resetStalePopupState("open requested while visible but not revealed")
      else {
        syncPopupPosition()
        return
      }
    }

    closeOtherPopups(popupRegistryId)
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)

    scheduleRefresh(0)

    deferAction(async () => {
      if (!(await getWifiEnabled())) return
      if (scanWifiNetworks()) {
        presentStatus("Scanning networks…", { durationMs: WIFI_SCAN_SETTLE_DELAY_MS })
        scheduleRefresh(WIFI_SCAN_SETTLE_DELAY_MS)
      }
    })

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState("revealer missing after open")
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (closingPopup) {
      return
    }

    if (windowVisible()) {
      if (!isPopupRevealed()) {
        resetStalePopupState("toggle requested while visible but not revealed")
        openPopup()
        return
      }

      closePopup()
      return
    }

    openPopup()
  }

  const clearStatusTimer = () => {
    statusTimer?.cancel()
    statusTimer = null
  }

  const presentStatus = (text: string, options: NoticeOptions = {}) => {
    const safeText = text.trim()
    clearStatusTimer()

    if (statusLabel) {
      statusLabel.set_label(safeText)
      statusLabel.set_visible(Boolean(safeText))
    }

    if (!safeText) return

    const durationMs = options.durationMs ?? 4200
    if (durationMs <= 0) return

    statusTimer = timeout(durationMs, () => {
      statusTimer = null
      if (statusLabel && statusLabel.get_label() === safeText) {
        statusLabel.set_label("")
        statusLabel.set_visible(false)
      }
    })
  }

  const hidePasswordPrompt = () => {
    pendingSecureNetwork = null
    passwordEntry?.set_text("")
    passwordBox?.set_visible(false)
  }

  const showPasswordPrompt = (network: WifiNetwork) => {
    pendingSecureNetwork = network
    passwordTitleLabel?.set_label(network.ssid)
    passwordBox?.set_visible(true)
    passwordEntry?.grab_focus()
  }

  const syncWifiSwitch = (enabled: boolean) => {
    if (!wifiSwitch) return
    if (wifiSwitch.get_active() === enabled) return

    syncingWifiSwitch = true
    wifiSwitch.set_active(enabled)
    syncingWifiSwitch = false
  }

  const getSavedWifiConnections = async () => {
    const out = await execText(["nmcli", "-t", "-e", "yes", "-f", "UUID,NAME,TYPE", "connection", "show"])
    const saved = new Map<string, string[]>()
    for (const line of out.split("\n")) {
      const [uuid = "", name = "", type = ""] = splitNmcliEscaped(line)
      if (type !== "802-11-wireless" || !uuid || !name) continue
      const current = saved.get(name) ?? []
      current.push(uuid)
      saved.set(name, current)
    }
    return saved
  }

  const getWireGuardProfiles = async () => {
    const [allOut, activeOut] = await Promise.all([
      execText(["nmcli", "-t", "-e", "yes", "-f", "UUID,NAME,TYPE", "connection", "show"]),
      execText(["nmcli", "-t", "-e", "yes", "-f", "UUID,TYPE", "connection", "show", "--active"]),
    ])
    const activeUuids = new Set(activeOut.split("\n").map(l => splitNmcliEscaped(l)).filter(([, t]) => t === "wireguard").map(([u]) => u))
    return allOut.split("\n").map(l => splitNmcliEscaped(l)).filter(([, , t]) => t === "wireguard").map(([u, n]) => ({
      uuid: u,
      name: n,
      active: activeUuids.has(u),
    })).sort((a, b) => a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name))
  }

  const renderWifiList = (networks: WifiNetwork[], emptyText = "Scanning networks…") => {
    clearChildren(wifiListBox)
    wifiSectionBox?.set_visible(wifiEnabled)
    if (!wifiListBox) return
    if (!wifiEnabled) return
    if (networks.length === 0) {
      wifiListBox.append(makeLabel(emptyText, "network-empty"))
      return
    }
    for (const network of networks) {
      const metaStr = `${network.signal}% • ${network.security}${network.saved ? " • saved" : ""}`
      const rowIcon = wifiSignalIcon(network.signal)
      if (network.inUse) {
        const row = network.saved
          ? makeRowWithAction(rowIcon, network.ssid, metaStr, [makeIconLabel("󰗠", "network-row-status")], null, "󰅖", "network-icon-button", `Forget ${network.ssid}`, () => deferAction(() => forgetWifi(network)))
          : makeInfoRow(rowIcon, network.ssid, metaStr, [makeIconLabel("󰗠", "network-row-status")])
        row.add_css_class("network-row-current")
        wifiListBox.append(row)
      } else if (network.security === "secured" && !network.saved) {
        wifiListBox.append(makeRowButton(rowIcon, network.ssid, metaStr, [makeIconLabel("󰌾", "network-row-status")], () => showPasswordPrompt(network)))
      } else if (network.saved) {
        wifiListBox.append(makeRowWithAction(rowIcon, network.ssid, metaStr, [], () => deferAction(() => connectToWifi(network)), "󰅖", "network-icon-button", "Forget", () => deferAction(() => forgetWifi(network))))
      } else {
        wifiListBox.append(makeRowButton(rowIcon, network.ssid, metaStr, [], () => deferAction(() => connectToWifi(network))))
      }
    }
  }

  const renderWireGuardList = (profiles: WireGuardProfile[]) => {
    clearChildren(wgListBox)
    if (!wgListBox) return
    if (profiles.length === 0) {
      wgListBox.append(makeLabel("No VPN profiles", "network-empty"))
      return
    }
    for (const profile of profiles) {
      const toggle = makeToggle(profile.active, "network-toggle", (active) => {
        deferAction(async () => {
          presentStatus(active ? `Starting ${profile.name}…` : `Stopping ${profile.name}…`, { durationMs: 0 })
          const result = await execResult(["nmcli", "connection", active ? "up" : "down", "uuid", profile.uuid])
          if (result.ok) presentStatus("")
          else presentStatus(result.text || "Failed")
          await refresh()
        })
      })
      wgListBox.append(makeRowWithAction("󰦝", profile.name, profile.active ? "active" : "inactive", [toggle], null, "󰅖", "network-icon-button", "Delete", () => deferAction(() => deleteWireGuard(profile))))
    }
  }

  const refresh = async () => {
    if (refreshInFlight) {
      refreshAgain = true
      return
    }

    refreshInFlight = true

    try {
      if (firstRefresh) {
        firstRefresh = false
        await waitMs(NETWORK_STARTUP_DELAY_MS)
      }

      const nmReady = await isNetworkManagerReady()
      const [wgProfiles, savedConnections, serviceActive] = await Promise.all([getWireGuardProfiles(), getSavedWifiConnections(), getVlessServiceActive()])
      const wgActive = wgProfiles.some(p => p.active)
      setVlessActive(serviceActive)

      if (!nmReady) {
        wifiDeviceRetryCount = 0
        wifiEnabled = false
        syncWifiSwitch(false)
        rescanButton?.set_sensitive(false)
        setIcon(BAR_WIFI_OFF_ICON)
        setTitle("Network")
        setMeta(appendServiceMeta("NetworkManager starting…", wgActive, serviceActive))
        renderWifiList([], "NetworkManager is starting…")
        renderWireGuardList(wgProfiles)
        return
      }

      const wifi = getAstalWifi()

      if (!wifi && wifiDeviceRetryCount < WIFI_DEVICE_RETRY_LIMIT) {
        wifiDeviceRetryCount += 1
        const enabled = await getWifiEnabled()
        wifiEnabled = enabled
        syncWifiSwitch(enabled)
        rescanButton?.set_sensitive(false)
        setIcon(enabled ? BAR_WIFI_ICON : BAR_WIFI_OFF_ICON)
        setTitle(enabled ? "Wi‑Fi" : "Network")
        setMeta(appendServiceMeta(enabled ? "Wi‑Fi device starting…" : "Wi‑Fi off", wgActive, serviceActive))
        renderWifiList([], enabled ? "Wi‑Fi device starting…" : "Wi‑Fi off")
        renderWireGuardList(wgProfiles)
        scheduleRefresh(WIFI_DEVICE_RETRY_DELAY_MS)
        return
      }

      const [enabled, networks] = await Promise.all([getWifiEnabled(), getWifiNetworks(savedConnections)])
      wifiDeviceRetryCount = wifi ? 0 : wifiDeviceRetryCount
      wifiEnabled = enabled
      syncWifiSwitch(enabled)
      rescanButton?.set_sensitive(enabled && Boolean(wifi?.scan))

      if (!wifi) {
        setIcon(BAR_WIFI_OFF_ICON)
        setTitle("Network")
        setMeta(appendServiceMeta("No Wi‑Fi device", wgActive, serviceActive))
        renderWifiList([], "No Wi‑Fi device")
        renderWireGuardList(wgProfiles)
        return
      }

      if (!enabled) {
        setIcon(BAR_WIFI_OFF_ICON)
        setTitle("Network")
        setMeta(appendServiceMeta("Wi‑Fi off", wgActive, serviceActive))
        renderWifiList([])
      } else {
        const current = networks.find(n => n.inUse)
        setIcon(current ? wifiSignalIcon(current.signal) : BAR_WIFI_ICON)
        setTitle(current?.ssid || "Wi‑Fi")
        setMeta(appendServiceMeta(current ? current.signal + "%" : "Ready", wgActive, serviceActive))
        renderWifiList(networks)
      }

      renderWireGuardList(wgProfiles)
    } finally {
      refreshInFlight = false
      if (refreshAgain) {
        refreshAgain = false
        scheduleRefresh(100)
      }
    }
  }

  const scheduleRefresh = (delay = 200) => {
    refreshDebounce?.cancel()
    refreshDebounce = timeout(delay, () => {
      refreshDebounce = null
      void refresh()
    })
  }

  const connectNetworkSignals = () => {
    if (networkSignalIds.length > 0) return

    const refreshNow = () => scheduleRefresh(100)

    const connectSignal = (source: SignalSource | null | undefined, signal: string, callback = refreshNow) => {
      if (!source) return
      try {
        networkSignalIds.push([source, source.connect(signal, callback)])
      } catch (error) {
        console.warn(`Network signal ${signal} setup failed: ${errorText(error)}`)
      }
    }

    const connectWifiSignals = () => {
      const wifi = getAstalWifi()
      if (!wifi || wifi === wifiSignalSource) return
      wifiSignalSource = wifi
      connectSignal(wifi, "access-point-added")
      connectSignal(wifi, "access-point-removed")
      connectSignal(wifi, "notify::access-points")
      connectSignal(wifi, "notify::active-access-point")
      connectSignal(wifi, "notify::enabled")
      connectSignal(wifi, "notify::scanning")
      connectSignal(wifi, "state-changed")
    }

    try {
      const astalNetwork = getAstalNetwork()
      connectSignal(astalNetwork, "notify", () => {
        connectWifiSignals()
        refreshNow()
      })
      connectSignal(getAstalClient(), "notify")
      connectWifiSignals()
    } catch (error) {
      console.warn(`Network signal setup failed: ${errorText(error)}`)
    }

    if (startupRefreshId === 0) {
      let startupTicks = 0
      startupRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        startupTicks += 1
        scheduleRefresh(0)
        if (startupTicks >= 30) {
          startupRefreshId = 0
          return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
      })
    }

    if (steadyRefreshId === 0) {
      steadyRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
        scheduleRefresh(0)
        return GLib.SOURCE_CONTINUE
      })
    }
  }

  const disconnectNetworkSignals = () => {
    for (const [source, id] of networkSignalIds) {
      try {
        source.disconnect(id)
      } catch {
      }
    }

    networkSignalIds = []
    wifiSignalSource = null

    if (startupRefreshId !== 0) {
      GLib.source_remove(startupRefreshId)
      startupRefreshId = 0
    }

    if (steadyRefreshId !== 0) {
      GLib.source_remove(steadyRefreshId)
      steadyRefreshId = 0
    }
  }

  const waitForWifiConnection = async (ssid: string, timeoutMs = 8000, intervalMs = 250) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const activeSsid = await getActiveWifiSsid()
      if (activeSsid === ssid) return true
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    const activeSsid = await getActiveWifiSsid()
    return activeSsid === ssid
  }

  const connectToWifi = async (network: WifiNetwork, password = "") => {
    hidePasswordPrompt()
    presentStatus(`Connecting to ${network.ssid}…`, { durationMs: 0 })
    const cmd = ["nmcli", "--wait", "0", "dev", "wifi", "connect", network.ssid]
    if (password) cmd.push("password", password)
    const result = await execResult(cmd)
    if (!result.ok) {
      presentStatus(result.text || "Failed")
      scheduleRefresh(100)
      return
    }

    scheduleRefresh(100)
    const connected = await waitForWifiConnection(network.ssid)
    if (connected) {
      presentStatus("")
      scheduleRefresh(100)
      return
    }

    presentStatus(`Timed out while connecting to ${network.ssid}`)
    scheduleRefresh(100)
  }

  const forgetWifi = async (network: WifiNetwork) => {
    const uuids = (await getSavedWifiConnections()).get(network.ssid) ?? []
    for (const uuid of uuids) {
      const result = await execResult(["nmcli", "connection", "delete", "uuid", uuid])
      if (!result.ok) {
        presentStatus(result.text || `Failed to forget ${network.ssid}`)
        break
      }
    }
    scheduleRefresh(100)
  }

  const deleteWireGuard = async (profile: WireGuardProfile) => {
    const result = await execResult(["nmcli", "connection", "delete", "uuid", profile.uuid])
    if (!result.ok) {
      presentStatus(result.text || `Failed to delete ${profile.name}`)
    }
    scheduleRefresh(100)
  }

  const toggleVless = async () => {
    if (vlessBusy()) return

    setVlessBusy(true)
    try {
      const active = await getVlessServiceActive()
      setVlessActive(active)
      presentStatus(active ? "Stopping VLESS…" : "Starting VLESS…", { durationMs: 0 })

      const result = await execResult(["systemctl", "--no-ask-password", active ? "stop" : "start", VLESS_SERVICE_NAME])
      if (!result.ok) {
        presentStatus(result.text || "Failed to change VLESS state")
        await refresh()
        return
      }

      presentStatus("")
      await refresh()
    } finally {
      setVlessBusy(false)
    }
  }

  const vlessBtn = (
    <button
      class={vlessActive((active) => active
        ? "flat network-icon-button network-vless-button network-vless-button-active"
        : "flat network-icon-button network-vless-button")}
      onClicked={() => deferAction(toggleVless)}
      $={(self) => {
        self.set_focus_on_click(false)
        self.set_focusable(false)
        attachShellTooltip(self, () => vlessBusy() ? "Switching VLESS…" : vlessActive() ? "Stop VLESS" : "Start VLESS")
      }}
    >
      <label class="network-icon-button-label network-vless-icon" label={vlessActive((active) => active ? "󰌾" : "󰌿")} />
    </button>
  )

  const rescanBtn = makeIconButton("󰑐", "network-icon-button", "Rescan", () => {
    if (wifiEnabled) {
      deferAction(async () => {
        presentStatus("Scanning networks…", { durationMs: WIFI_SCAN_SETTLE_DELAY_MS })
        if (!scanWifiNetworks()) await execResult(["nmcli", "device", "wifi", "rescan"])
        timeout(WIFI_SCAN_SETTLE_DELAY_MS, () => { presentStatus(""); scheduleRefresh(0) })
      })
    }
  })

  const popoverContent = (
    <box class="network-popover" orientation={Gtk.Orientation.VERTICAL} spacing={10} widthRequest={NETWORK_POPOVER_WIDTH}>
      <box class="network-header" spacing={8}>
        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
          <label class="network-header-title" xalign={0} label={title} ellipsize={Pango.EllipsizeMode.END} />
          <label class="network-header-meta" xalign={0} label={meta} />
        </box>
        {rescanBtn}
        {vlessBtn}
        <Gtk.Switch class="network-toggle" valign={Gtk.Align.CENTER} halign={Gtk.Align.END} $={(self) => {
          wifiSwitch = self
          self.connect("notify::active", () => {
            if (syncingWifiSwitch) return

            const enabled = self.get_active()
            wifiEnabled = enabled
            rescanButton?.set_sensitive(enabled)
            if (!enabled) {
              hidePasswordPrompt()
              setIcon(BAR_WIFI_OFF_ICON)
              setTitle("Network")
              setMeta("Wi‑Fi off")
              presentStatus("")
            } else {
              setIcon(BAR_WIFI_ICON)
              setTitle("Wi‑Fi")
              setMeta("Scanning networks…")
            }
            renderWifiList([], "Scanning networks…")

            deferAction(async () => {
              const result = setAstalWifiEnabled(enabled)
                ? { ok: true, text: "" }
                : await execResult(["nmcli", "radio", "wifi", enabled ? "on" : "off"])
              if (!result.ok) presentStatus(result.text || "Failed to change Wi‑Fi state")
              scheduleRefresh(100)
            })
          })
        }} />
      </box>

      <box class="network-password-box" orientation={Gtk.Orientation.VERTICAL} spacing={8} visible={false} $={(self) => passwordBox = self}>
        <label class="network-row-title" xalign={0} $={(self) => passwordTitleLabel = self} />
        <Gtk.Entry visibility={false} placeholderText="Password" $={(self) => {
          passwordEntry = self
          self.connect("activate", () => deferAction(() => connectToWifi(pendingSecureNetwork!, passwordEntry?.get_text())))
        }} />
        <box spacing={8} halign={Gtk.Align.END}>
          <button class="flat network-password-action" onClicked={hidePasswordPrompt} label="Cancel" />
          <button class="flat network-password-action" onClicked={() => deferAction(() => connectToWifi(pendingSecureNetwork!, passwordEntry?.get_text()))} label="Connect" />
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} $={(self) => {
        wifiSectionBox = self
        self.set_visible(wifiEnabled)
      }}>
        <label class="network-section-title" label="Wi‑Fi" xalign={0} />
        <box class="network-list-capsule" orientation={Gtk.Orientation.VERTICAL}>
          <Gtk.ScrolledWindow
            class="network-list-scroller"
            propagateNaturalHeight
            maxContentHeight={220}
          >
            <box class="network-list-inner" orientation={Gtk.Orientation.VERTICAL} spacing={0} $={(self) => wifiListBox = self} />
          </Gtk.ScrolledWindow>
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <box spacing={8}>
          <label class="network-section-title" hexpand label="WireGuard" xalign={0} />
          {makeIconButton("󰈠", "network-icon-button", "Import", () => {
            closePopup()
            importWireGuard(refresh, presentStatus)
          })}
        </box>
        <box class="network-list-capsule" orientation={Gtk.Orientation.VERTICAL}>
          <box class="network-list-inner" orientation={Gtk.Orientation.VERTICAL} spacing={0} $={(self) => wgListBox = self} />
        </box>
      </box>

      <label
        class="network-section-title network-notice"
        xalign={0}
        visible={false}
        $={(self) => {
          statusLabel = self
          attachShellTooltip(self, () => self.get_label())
          self.set_single_line_mode(true)
          self.set_wrap(false)
          self.set_max_width_chars(42)
          self.set_lines(1)
          self.set_ellipsize(Pango.EllipsizeMode.END)
        }}
      />
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-network"
      class="widget-popup-window network-popup-window"
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
          popupPlacement = null
          popupRevealer = null
          popupFrame = null
          popupRoot = null
        })
      }}
    >
      <box class="widget-popup-root" $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachPopupFocusDismiss(self, closePopup)
        attachEscapeKey(self, closePopup)
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
            <box class="widget-popup-frame network-popover-window" widthRequest={NETWORK_POPOVER_WIDTH} $={(self) => {
              clipRoundedWidget(self)
              popupFrame = self
            }}>
              {popoverContent}
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <box class="network-shell" valign={Gtk.Align.CENTER} $={(self) => {
      void self
      rescanButton = rescanBtn
      connectNetworkSignals()
      void refresh()
    }}>
      <button class="network-trigger" valign={Gtk.Align.CENTER} onClicked={() => {
        togglePopup()
      }} $={(self) => {
        attachShellTooltip(self, triggerTooltip)
        trigger = self

        self.connect("destroy", () => {
          unregisterPopupController()
          clearCloseTimeout()
          clearStatusTimer()
          refreshDebounce?.cancel()
          refreshDebounce = null
          disconnectNetworkSignals()
          closingPopup = false
          setWindowVisible(false)
        })
      }}>
        <label class="module-icon network-trigger-icon" label={icon} />
      </button>
    </box>
  )
}
