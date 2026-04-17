import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import AstalNetwork from "gi://AstalNetwork"

import { Astal } from "ags/gtk4"
import { createComputed, createState } from "ags"
import { execAsync } from "ags/process"
import { timeout } from "ags/time"
import { sendShellNotification } from "./ShellNotifications"
import { attachEscapeKey } from "./EscapeKey"
import { FLOATING_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, TOP_BAR_POPUP_MARGIN_TOP, isPointInsideWidget } from "./FloatingPopup"

const POPOVER_REVEAL_DURATION_MS = 165
const NETWORK_POPOVER_WIDTH = 392
const NETWORK_POPUP_MARGIN_END = POPUP_SCREEN_RIGHT
const BAR_WIFI_ICON = "󰤨"
const BAR_WIFI_OFF_ICON = "󰖪"

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
  desktop?: boolean
  durationMs?: number
  urgency?: "low" | "normal" | "critical"
  summary?: string
  iconName?: string
  replaceKey?: string
}

const network = AstalNetwork.get_default()
const wifiDevice = network.get_wifi()

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
  button.set_tooltip_text(tooltip)
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
  button.set_tooltip_text(title)
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
    button.set_tooltip_text(title)
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

function securityText(flags: number) {
  return flags === 0 ? "open" : "secured"
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
        presentStatus(result.text || "Import failed", {
          desktop: true,
          urgency: "normal",
          summary: "WireGuard import failed",
          iconName: "network-vpn-symbolic",
          replaceKey: "network-status",
        })
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
  let popupPlacement: Gtk.Box | null = null
  let wifiListBox: Gtk.Box | null = null
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

  let wifiEnabled = false
  let syncingWifiSwitch = false
  let pendingSecureNetwork: WifiNetwork | null = null
  let refreshDebounce: { cancel: () => void } | null = null
  let statusTimer: { cancel: () => void } | null = null

  const [icon, setIcon] = createState("󰖪")
  const [title, setTitle] = createState("Network")
  const [meta, setMeta] = createState("Loading…")
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

  const finishClosePopup = () => {
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const closePopup = () => {
    if (closingPopup || !windowVisible()) return

    closingPopup = true

    if (popupRevealer?.get_reveal_child()) {
      popupRevealer.revealChild = false
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPOVER_REVEAL_DURATION_MS, () => {
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const openPopup = () => {
    if (windowVisible()) return

    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (popupRevealer) popupRevealer.revealChild = true
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
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
      statusLabel.set_tooltip_text(safeText)
      statusLabel.set_visible(Boolean(safeText))
    }

    if (!safeText) return

    if (options.desktop ?? false) {
      void sendShellNotification({
        appName: "AGS Network",
        summary: options.summary ?? "Network",
        body: safeText,
        iconName: options.iconName ?? "network-wireless-symbolic",
        urgency: options.urgency ?? "normal",
        expireTimeoutMs: options.durationMs ?? 4200,
        replaceKey: options.replaceKey ?? "network-status",
        category: "network",
      }).catch((error) => {
        console.warn(`Network desktop notification failed: ${errorText(error)}`)
      })
    }

    const durationMs = options.durationMs ?? 4200
    if (durationMs <= 0) return

    statusTimer = timeout(durationMs, () => {
      statusTimer = null
      if (statusLabel && statusLabel.get_label() === safeText) {
        statusLabel.set_label("")
        statusLabel.set_tooltip_text("")
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

  const renderWifiList = (networks: WifiNetwork[]) => {
    clearChildren(wifiListBox)
    if (!wifiListBox) return
    if (!wifiEnabled) {
      wifiListBox.append(makeLabel("Wi‑Fi is disabled", "network-empty"))
      return
    }
    if (networks.length === 0) {
      wifiListBox.append(makeLabel("No networks found", "network-empty"))
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
          presentStatus(active ? `Starting ${profile.name}…` : `Stopping ${profile.name}…`, { desktop: false, durationMs: 0 })
          const result = await execResult(["nmcli", "connection", active ? "up" : "down", "uuid", profile.uuid])
          if (result.ok) presentStatus("")
          else presentStatus(result.text || "Failed", {
            desktop: true,
            urgency: "normal",
            summary: active ? "WireGuard start failed" : "WireGuard stop failed",
            iconName: "network-vpn-symbolic",
            replaceKey: "network-status",
          })
          await refresh()
        })
      })
      wgListBox.append(makeRowWithAction("󰦝", profile.name, profile.active ? "active" : "inactive", [toggle], null, "󰅖", "network-icon-button", "Delete", () => deferAction(() => deleteWireGuard(profile))))
    }
  }

  const refresh = async () => {
    if (!wifiDevice) return
    const [wgProfiles, savedConnections] = await Promise.all([getWireGuardProfiles(), getSavedWifiConnections()])
    const wgActive = wgProfiles.some(p => p.active)
    const enabled = wifiDevice.get_enabled()
    wifiEnabled = enabled
    syncWifiSwitch(enabled)
    rescanButton?.set_sensitive(enabled)

    if (!enabled) {
      setIcon(BAR_WIFI_OFF_ICON)
      setTitle("Network")
      setMeta(wgActive ? "Radio off • VPN" : "Radio off")
      renderWifiList([])
    } else {
      const activeAp = wifiDevice.get_active_access_point()
      const networks = uniqueWifiNetworks((wifiDevice.get_access_points() || []).map(ap => ({
        inUse: activeAp ? ap.get_bssid() === activeAp.get_bssid() : false,
        ssid: ap.get_ssid() || "",
        signal: ap.get_strength() || 0,
        security: securityText(ap.get_flags()),
        saved: savedConnections.has(ap.get_ssid() || ""),
      })))
      const current = networks.find(n => n.inUse)
      setIcon(current ? wifiSignalIcon(current.signal) : BAR_WIFI_ICON)
      setTitle(current?.ssid || "Wi‑Fi")
      setMeta(`${current ? current.signal + "%" : "Ready"}${wgActive ? " • VPN" : ""}`)
      renderWifiList(networks)
    }
    renderWireGuardList(wgProfiles)
  }

  const scheduleRefresh = (delay = 200) => {
    refreshDebounce?.cancel()
    refreshDebounce = timeout(delay, () => {
      refreshDebounce = null
      void refresh()
    })
  }

  const waitForWifiConnection = async (ssid: string, timeoutMs = 8000, intervalMs = 250) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const activeSsid = wifiDevice?.get_active_access_point?.()?.get_ssid?.() || ""
      if (activeSsid === ssid) return true
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    const activeSsid = wifiDevice?.get_active_access_point?.()?.get_ssid?.() || ""
    return activeSsid === ssid
  }

  const connectToWifi = async (network: WifiNetwork, password = "") => {
    hidePasswordPrompt()
    presentStatus(`Connecting to ${network.ssid}…`, { desktop: false, durationMs: 0 })
    const cmd = ["nmcli", "--wait", "0", "dev", "wifi", "connect", network.ssid]
    if (password) cmd.push("password", password)
    const result = await execResult(cmd)
    if (!result.ok) {
      presentStatus(result.text || "Failed", {
        desktop: true,
        urgency: "normal",
        summary: "Wi‑Fi connection failed",
        iconName: "network-wireless-symbolic",
        replaceKey: "network-status",
      })
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

    presentStatus(`Timed out while connecting to ${network.ssid}` , {
      desktop: true,
      urgency: "normal",
      summary: "Wi‑Fi connection failed",
      iconName: "network-wireless-symbolic",
      replaceKey: "network-status",
    })
    scheduleRefresh(100)
  }

  const forgetWifi = async (network: WifiNetwork) => {
    const uuids = (await getSavedWifiConnections()).get(network.ssid) ?? []
    for (const uuid of uuids) {
      const result = await execResult(["nmcli", "connection", "delete", "uuid", uuid])
      if (!result.ok) {
        presentStatus(result.text || `Failed to forget ${network.ssid}`, {
          desktop: true,
          urgency: "normal",
          summary: "Wi‑Fi forget failed",
          iconName: "network-wireless-symbolic",
          replaceKey: "network-status",
        })
        break
      }
    }
    scheduleRefresh(100)
  }

  const deleteWireGuard = async (profile: WireGuardProfile) => {
    const result = await execResult(["nmcli", "connection", "delete", "uuid", profile.uuid])
    if (!result.ok) {
      presentStatus(result.text || `Failed to delete ${profile.name}`, {
        desktop: true,
        urgency: "normal",
        summary: "WireGuard delete failed",
        iconName: "network-vpn-symbolic",
        replaceKey: "network-status",
      })
    }
    scheduleRefresh(100)
  }

  const rescanBtn = makeIconButton("󰑐", "network-icon-button", "Rescan", () => {
    if (wifiEnabled && wifiDevice) {
      deferAction(() => {
        wifiDevice.scan()
        presentStatus("Scanning…", { desktop: false, durationMs: 1200 })
        timeout(1200, () => { presentStatus(""); void refresh() })
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
        <Gtk.Switch class="network-toggle" valign={Gtk.Align.CENTER} halign={Gtk.Align.END} $={(self) => {
          wifiSwitch = self
          self.connect("notify::active", () => {
            if (syncingWifiSwitch || !wifiDevice) return

            const enabled = self.get_active()
            wifiEnabled = enabled
            rescanButton?.set_sensitive(enabled)

            deferAction(() => {
              wifiDevice.set_enabled(enabled)
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

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
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
      namespace="obsidian-shell"
      class="widget-popup-window network-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      anchor={FLOATING_POPUP_ANCHOR}
      $={(self) => {
        self.connect("destroy", () => {
          popupPlacement = null
          popupRevealer = null
          popupFrame = null
          popupRoot = null
        })
      }}
    >
      <box class="widget-popup-root" hexpand vexpand $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachEscapeKey(self, closePopup)
      }}>
        <Gtk.GestureClick
          button={0}
          propagationPhase={Gtk.PropagationPhase.CAPTURE}
          onReleased={(_, _nPress, x, y) => {
            const root = popupPlacement?.get_parent?.() as Gtk.Widget | null
            if (isPointInsideWidget(popupFrame, root, x, y)) return
            closePopup()
          }}
        />

        <box
          class="widget-popup-placement"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          $={(self) => {
            popupPlacement = self
            self.set_margin_top(TOP_BAR_POPUP_MARGIN_TOP)
            self.set_margin_end(NETWORK_POPUP_MARGIN_END)
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame network-popover-window" widthRequest={NETWORK_POPOVER_WIDTH} $={(self) => (popupFrame = self)}>
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
      void refresh()
      wifiDevice?.connect("notify::access-points", () => scheduleRefresh(100))
    }}>
      <button class="network-trigger" valign={Gtk.Align.CENTER} tooltipText={triggerTooltip} onClicked={togglePopup} $={(self) => {
        trigger = self

        self.connect("destroy", () => {
          clearCloseTimeout()
          clearStatusTimer()
          closingPopup = false
          setWindowVisible(false)
        })
      }}>
        <label class="module-icon network-trigger-icon" label={icon} />
      </button>
    </box>
  )
}
