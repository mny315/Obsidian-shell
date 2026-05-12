import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Bluetooth from "gi://AstalBluetooth"
import { Astal } from "ags/gtk4"
import { For, With, createBinding, createComputed, createState } from "ags"
import { timeout } from "ags/time"
import { attachEscapeKey } from "./EscapeKey"
import { RIGHT_TOP_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowAtTopRight } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"

const bluetooth = Bluetooth.get_default()

const BLUEZ_SERVICE = "org.bluez"
const BLUEZ_AGENT_MANAGER_PATH = "/org/bluez"
const BLUEZ_AGENT_MANAGER_IFACE = "org.bluez.AgentManager1"
const BLUEZ_DEVICE_IFACE = "org.bluez.Device1"
const DBUS_PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"
const BLUEZ_AGENT_PATH = "/io/astal/BluetoothAgent"
const BLUEZ_AGENT_CAPABILITY = "NoInputNoOutput"

const POPOVER_REVEAL_DURATION_MS = 165
const BLUETOOTH_POPOVER_WIDTH = 392
const BLUETOOTH_DISCOVERY_TIMEOUT_MS = 10000

const BLUEZ_AGENT_XML = `
<node>
  <interface name="org.bluez.Agent1">
    <method name="Release" />
    <method name="RequestPinCode">
      <arg type="o" direction="in" name="device" />
      <arg type="s" direction="out" name="pincode" />
    </method>
    <method name="DisplayPinCode">
      <arg type="o" direction="in" name="device" />
      <arg type="s" direction="in" name="pincode" />
    </method>
    <method name="RequestPasskey">
      <arg type="o" direction="in" name="device" />
      <arg type="u" direction="out" name="passkey" />
    </method>
    <method name="DisplayPasskey">
      <arg type="o" direction="in" name="device" />
      <arg type="u" direction="in" name="passkey" />
      <arg type="q" direction="in" name="entered" />
    </method>
    <method name="RequestConfirmation">
      <arg type="o" direction="in" name="device" />
      <arg type="u" direction="in" name="passkey" />
    </method>
    <method name="RequestAuthorization">
      <arg type="o" direction="in" name="device" />
    </method>
    <method name="AuthorizeService">
      <arg type="o" direction="in" name="device" />
      <arg type="s" direction="in" name="uuid" />
    </method>
    <method name="Cancel" />
  </interface>
</node>`

type ExportedDbusObject = Gio.DBusExportedObject & {
  export: (connection: Gio.DBusConnection, objectPath: string) => void
  unexport?: () => void
}

type BluetoothAgentState = {
  connection: Gio.DBusConnection | null
  connectionPromise: Promise<Gio.DBusConnection> | null
  exported: ExportedDbusObject | null
  registered: boolean
  registering: Promise<null> | null
  lastHardError: string | null
}

const bluetoothAgentState: BluetoothAgentState = {
  connection: null,
  connectionPromise: null,
  exported: null,
  registered: false,
  registering: null,
  lastHardError: null,
}

function promisifyIfPresent(proto: object, method: string, finish: string) {
  try {
    if (typeof Reflect.get(proto, method) === "function" && typeof Reflect.get(proto, finish) === "function") {
      Gio._promisify(proto as never, method, finish)
    }
  } catch {}
}

promisifyIfPresent(Bluetooth.Device.prototype, "connect_device", "connect_device_finish")
promisifyIfPresent(Bluetooth.Device.prototype, "disconnect_device", "disconnect_device_finish")

function triggerGlyph(powered: boolean, connected: boolean) {
  if (!powered) return "󰂲"
  if (connected) return "󰂱"
  return "󰂯"
}

function deviceGlyph(icon: string, name: string) {
  const value = `${icon ?? ""} ${name ?? ""}`.toLowerCase()
  if (value.includes("headset") || value.includes("headphone") || value.includes("earbud")) return "󰋋"
  if (value.includes("speaker") || value.includes("audio-card")) return "󰓃"
  if (value.includes("phone")) return "󰄜"
  if (value.includes("keyboard")) return "󰌌"
  if (value.includes("mouse")) return "󰍽"
  if (value.includes("gamepad") || value.includes("joystick") || value.includes("input-gaming")) return "󰮂"
  if (value.includes("watch")) return "󰢗"
  if (value.includes("computer") || value.includes("laptop")) return "󰌢"
  if (value.includes("printer")) return "󰐪"
  return "󰂯"
}

function batteryLabel(value: number) {
  if (value < 0) return ""
  const percent = Math.round(value * 100)
  return `${percent}%`
}

function deviceName(device: Bluetooth.Device) {
  return device.alias || device.name || device.address || "Unknown device"
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.length > 0) return error

  const maybeMessage = Reflect.get(error as object, "message")
  if (typeof maybeMessage === "string" && maybeMessage.length > 0) return maybeMessage

  return "Unknown error"
}

function getDbusRemoteErrorName(error: unknown) {
  try {
    const glibError = error as GLib.Error
    if (Gio.DBusError.is_remote_error(glibError)) {
      return Gio.DBusError.get_remote_error(glibError)
    }
  } catch {}

  return null
}

function getReadableDbusErrorMessage(error: unknown) {
  try {
    const glibError = error as GLib.Error
    if (Gio.DBusError.is_remote_error(glibError)) {
      Gio.DBusError.strip_remote_error(glibError)
      if (glibError.message) return glibError.message
    }
  } catch {}

  return formatError(error)
}

function isBonded(device: Bluetooth.Device) {
  return Boolean((device as Bluetooth.Device & { bonded?: boolean }).bonded)
}

function isKnownDevice(device: Bluetooth.Device) {
  return Boolean(device.paired || device.trusted || isBonded(device))
}

function canConnectWithoutPair(device: Bluetooth.Device) {
  return Boolean(device.paired || isBonded(device))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForConnectionState(device: Bluetooth.Device, expected: boolean, timeoutMs = 4000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (Boolean(device.connected) === expected) return true
    await sleep(intervalMs)
  }

  return Boolean(device.connected) === expected
}

async function waitForStableConnectionState(device: Bluetooth.Device, expected: boolean, timeoutMs = 8000, stableMs = 2000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let stableSince = 0

  while (Date.now() < deadline) {
    if (Boolean(device.connected) === expected) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= stableMs) return true
    } else {
      stableSince = 0
    }

    await sleep(intervalMs)
  }

  return false
}

async function waitForPairState(device: Bluetooth.Device, timeoutMs = 5000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (canConnectWithoutPair(device)) return true
    await sleep(intervalMs)
  }

  return canConnectWithoutPair(device)
}

function deviceSortScore(device: Bluetooth.Device) {
  if (device.connected) return 0
  if (isKnownDevice(device)) return 1
  return 2
}

function readDevices() {
  const list = bluetooth.get_devices?.() ?? bluetooth.devices ?? []
  return [...list] as Bluetooth.Device[]
}

function readAdapters() {
  const list = bluetooth.get_adapters?.() ?? bluetooth.adapters ?? []
  return [...list] as Bluetooth.Adapter[]
}

type Notice = { text: string }

type NoticeOptions = {
  durationMs?: number
}

type PairableDevice = Bluetooth.Device & {
  pair_device?: () => Promise<void> | void
  bonded?: boolean
}

class EmbeddedBluetoothAgent {
  Release() {
    bluetoothAgentState.lastHardError = null
  }

  RequestPinCode(_device: string) {
    throw new Error("This embedded Bluetooth agent does not support PIN entry")
  }

  DisplayPinCode(_device: string, _pincode: string) {}

  RequestPasskey(_device: string) {
    throw new Error("This embedded Bluetooth agent does not support passkey entry")
  }

  DisplayPasskey(_device: string, _passkey: number, _entered: number) {}

  RequestConfirmation(_device: string, _passkey: number) {}

  RequestAuthorization(_device: string) {}

  AuthorizeService(_device: string, _uuid: string) {}

  Cancel() {}
}

function getSystemBusConnectionAsync() {
  if (bluetoothAgentState.connection && !bluetoothAgentState.connection.is_closed()) {
    return Promise.resolve(bluetoothAgentState.connection)
  }

  if (bluetoothAgentState.connectionPromise) return bluetoothAgentState.connectionPromise

  bluetoothAgentState.connectionPromise = new Promise<Gio.DBusConnection>((resolve, reject) => {
    Gio.bus_get(Gio.BusType.SYSTEM, null, (_source, result) => {
      try {
        bluetoothAgentState.connection = Gio.bus_get_finish(result)
        bluetoothAgentState.connectionPromise = null
        resolve(bluetoothAgentState.connection)
      } catch (error) {
        bluetoothAgentState.connectionPromise = null
        reject(error)
      }
    })
  })

  return bluetoothAgentState.connectionPromise
}

function exportBluetoothAgent(connection: Gio.DBusConnection) {
  if (bluetoothAgentState.exported) return bluetoothAgentState.exported

  const exported = Gio.DBusExportedObject.wrapJSObject(
    BLUEZ_AGENT_XML,
    new EmbeddedBluetoothAgent(),
  ) as ExportedDbusObject

  exported.export(connection, BLUEZ_AGENT_PATH)
  bluetoothAgentState.exported = exported
  return exported
}

async function callBluezAgentManager(method: string, parameters: GLib.Variant) {
  const connection = await getSystemBusConnectionAsync()

  return new Promise<GLib.Variant | null>((resolve, reject) => {
    connection.call(
      BLUEZ_SERVICE,
      BLUEZ_AGENT_MANAGER_PATH,
      BLUEZ_AGENT_MANAGER_IFACE,
      method,
      parameters,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_connection, result) => {
        try {
          resolve(connection.call_finish(result))
        } catch (error) {
          reject(error)
        }
      },
    )
  })
}

function hasDbusError(error: unknown, name: string, messagePattern?: RegExp) {
  const remoteName = getDbusRemoteErrorName(error)
  if (remoteName === name) return true

  if (!messagePattern) return false
  return messagePattern.test(getReadableDbusErrorMessage(error))
}

function isAlreadyExistsError(error: unknown) {
  return hasDbusError(error, "org.bluez.Error.AlreadyExists", /AlreadyExists|already exists/)
}

function isAlreadyConnectedError(error: unknown) {
  return hasDbusError(error, "org.bluez.Error.AlreadyConnected", /AlreadyConnected|already connected/)
}

function isTransientConnectError(error: unknown) {
  const remoteName = getDbusRemoteErrorName(error)
  return remoteName === "org.bluez.Error.InProgress" || remoteName === "org.bluez.Error.NotReady" || remoteName === "org.bluez.Error.Failed"
}

async function ensureBluetoothAgent() {
  if (bluetoothAgentState.registered) return null
  if (bluetoothAgentState.registering) return bluetoothAgentState.registering

  bluetoothAgentState.registering = (async () => {
    try {
      const connection = await getSystemBusConnectionAsync()
      exportBluetoothAgent(connection)

      try {
        await callBluezAgentManager(
          "RegisterAgent",
          new GLib.Variant("(os)", [BLUEZ_AGENT_PATH, BLUEZ_AGENT_CAPABILITY]),
        )
        bluetoothAgentState.registered = true
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          bluetoothAgentState.registered = true
        } else {
          throw error
        }
      }

      try {
        await callBluezAgentManager(
          "RequestDefaultAgent",
          new GLib.Variant("(o)", [BLUEZ_AGENT_PATH]),
        )
      } catch {}

      bluetoothAgentState.lastHardError = null
      return null
    } catch (error) {
      const remoteName = getDbusRemoteErrorName(error)
      const readable = getReadableDbusErrorMessage(error)
      const message = remoteName ? `Bluetooth agent error: ${remoteName}: ${readable}` : `Bluetooth agent error: ${readable}`
      bluetoothAgentState.lastHardError = message
      console.warn(message)
      return null
    } finally {
      bluetoothAgentState.registering = null
    }
  })()

  return bluetoothAgentState.registering
}

async function runMaybePromise(value: Promise<void> | void) {
  await value
}

function deviceObjectPath(device: Bluetooth.Device) {
  const adapterPath = `${device.adapter ?? ""}`.trim()
  const address = `${device.address ?? ""}`.trim().replace(/:/g, "_")
  if (!adapterPath || !address) return null
  return `${adapterPath}/dev_${address}`
}

function callBluezObjectMethod(device: Bluetooth.Device, iface: string, method: string, parameters: GLib.Variant | null = null) {
  const objectPath = deviceObjectPath(device)
  if (!objectPath) return Promise.reject(new Error(`Could not resolve BlueZ object path for ${deviceName(device)}`))

  return getSystemBusConnectionAsync().then((connection) => new Promise<GLib.Variant | null>((resolve, reject) => {
    connection.call(
      BLUEZ_SERVICE,
      objectPath,
      iface,
      method,
      parameters,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_connection, result) => {
        try {
          resolve(connection.call_finish(result))
        } catch (error) {
          reject(error)
        }
      },
    )
  }))
}

function callBluezDeviceMethod(device: Bluetooth.Device, method: string, parameters: GLib.Variant | null = null) {
  return callBluezObjectMethod(device, BLUEZ_DEVICE_IFACE, method, parameters)
}

async function setBluezDeviceProperty(device: Bluetooth.Device, property: string, signature: string, value: unknown) {
  await callBluezObjectMethod(
    device,
    DBUS_PROPERTIES_IFACE,
    "Set",
    new GLib.Variant("(ssv)", [BLUEZ_DEVICE_IFACE, property, new GLib.Variant(signature, value)]),
  )
}

async function connectDeviceAsync(device: Bluetooth.Device) {
  await callBluezDeviceMethod(device, "Connect")
}

async function disconnectDeviceAsync(device: Bluetooth.Device) {
  await callBluezDeviceMethod(device, "Disconnect")
}

async function trustDevice(device: Bluetooth.Device) {
  if (device.trusted) return
  await setBluezDeviceProperty(device, "Trusted", "b", true)
}

async function connectDeviceWithRetry(device: Bluetooth.Device, forceConnect = false) {
  let lastError: unknown = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (forceConnect || !device.connected) await connectDeviceAsync(device)
      lastError = null
    } catch (error) {
      if (!isAlreadyConnectedError(error)) {
        lastError = error
        if (!isTransientConnectError(error) && attempt >= 1) throw error
      }
    }

    if (await waitForStableConnectionState(device, true, 6500, 2200)) return true
    await sleep(700)
  }

  if (lastError) throw lastError
  return false
}

async function pairDevice(device: Bluetooth.Device) {
  const d = device as PairableDevice

  if (typeof d.pair_device === "function") {
    await runMaybePromise(d.pair_device())
    return
  }

  await callBluezDeviceMethod(device, "Pair")
}

function BluetoothDeviceRow({
  device,
  getAdapter,
  setNotice,
  requestDeviceRefresh,
  requestAdapterRefresh,
}: {
  device: Bluetooth.Device
  getAdapter: () => Bluetooth.Adapter | null
  setNotice: (v: Notice | null, options?: NoticeOptions) => void
  requestDeviceRefresh: (delay?: number) => void
  requestAdapterRefresh: (delay?: number) => void
}) {
  const alias = createBinding(device, "alias")
  const icon = createBinding(device, "icon")
  const connected = createBinding(device, "connected")
  const connecting = createBinding(device, "connecting")
  const paired = createBinding(device, "paired")
  const trusted = createBinding(device, "trusted")
  const battery = createBinding(device, "battery-percentage")
  const [pairing, setPairing] = createState(false)
  const [pendingConnected, setPendingConnected] = createState<boolean | null>(null)

  const title = createComputed(() => alias() || device.name || device.address || "Bluetooth device")
  const glyph = createComputed(() => deviceGlyph(icon() || "", title()))
  const busy = createComputed(() => pairing() || connecting() || pendingConnected() !== null)
  const removable = createComputed(() => Boolean(device.address))
  const known = createComputed(() => Boolean(connected() || paired() || trusted() || isBonded(device)))
  const showPairButton = createComputed(() => !connected() && !paired() && !isBonded(device))

  const meta = createComputed(() => {
    if (pairing()) return "Pairing…"
    if (pendingConnected() === false && connected()) return "Disconnecting…"
    if ((connecting() || (pendingConnected() === true && !connected()))) return "Connecting…"

    const parts = [
      connected()
        ? "Connected"
        : (known() ? "Disconnected" : "Available"),
    ]

    const b = batteryLabel(battery())
    if (b) parts.push(b)
    return parts.join(" • ")
  })

  const toggleConnection = async (targetConnected = !connected(), onSettled?: () => void) => {
    try {
      if (targetConnected === connected()) return

      setPendingConnected(targetConnected)

      if (!targetConnected) {
        await disconnectDeviceAsync(device)
        requestDeviceRefresh(120)

        const disconnected = await waitForConnectionState(device, false, 2500)
        if (!disconnected) {
          setNotice({ text: `${deviceName(device)} did not disconnect` })
          requestDeviceRefresh()
        }
        return
      }

      await ensureBluetoothAgent()

      const adapter = getAdapter()
      if (adapter?.discovering) {
        adapter.stop_discovery()
        requestAdapterRefresh(0)
      }

      const needsPair = !canConnectWithoutPair(device)

      if (needsPair) {
        setPairing(true)
        await pairDevice(device)
        requestDeviceRefresh(150)
        await waitForPairState(device)
        await trustDevice(device)
        requestDeviceRefresh(150)
        await sleep(700)
      } else {
        await trustDevice(device).catch(() => null)
      }

      const didConnect = await connectDeviceWithRetry(device, needsPair)
      requestDeviceRefresh(120)

      if (!didConnect) {
        setNotice({ text: needsPair ? `${deviceName(device)} paired, but did not stay connected` : `${deviceName(device)} did not stay connected` })
        requestDeviceRefresh()
      }
    } catch (e) {
      setNotice({ text: formatError(e) })
      requestDeviceRefresh()
    } finally {
      setPairing(false)
      setPendingConnected(null)

      if (onSettled) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          onSettled()
          return GLib.SOURCE_REMOVE
        })
      }
    }
  }

  const runDetachedConnection = (targetConnected: boolean, onSettled?: () => void) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      void toggleConnection(targetConnected, onSettled)
      return GLib.SOURCE_REMOVE
    })
  }

  return (
    <box class="network-row-shell" spacing={10} valign={Gtk.Align.CENTER}>
      <label class="network-row-icon" label={glyph} />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
        <label class="network-row-title" xalign={0} label={title} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={26} />
        <label class="network-row-meta" xalign={0} label={meta} />
      </box>
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <button
          class="network-row-button bluetooth-pair-button"
          visible={showPairButton}
          sensitive={busy((v) => !v)}
          valign={Gtk.Align.CENTER}
          $={(self) => {
            self.set_focusable(false)
          }}
          onClicked={() => {
            runDetachedConnection(true)
          }}
        >
          <label class="bluetooth-pair-button-label" label={pairing((v) => v ? "Pairing…" : "Pair")} />
        </button>
        <Gtk.Switch
          class="network-toggle bluetooth-device-switch"
          visible={showPairButton((v) => !v)}
          sensitive={busy((v) => !v)}
          valign={Gtk.Align.CENTER}
          halign={Gtk.Align.END}
          $={(self) => {
            let syncingSwitch = false

            const syncSwitch = () => {
              const displayConnected = pendingConnected() ?? Boolean(device.connected)
              if (self.get_active() === displayConnected) return

              syncingSwitch = true
              self.set_active(displayConnected)
              syncingSwitch = false
            }

            syncSwitch()

            const connectedId = device.connect("notify::connected", syncSwitch)

            self.connect("notify::active", () => {
              if (syncingSwitch) return

              const targetConnected = self.get_active()
              if (busy()) {
                syncSwitch()
                return
              }

              if (targetConnected === Boolean(device.connected)) {
                setPendingConnected(null)
                return
              }

              setPendingConnected(targetConnected)
              runDetachedConnection(targetConnected, syncSwitch)
            })

            self.connect("destroy", () => {
              device.disconnect(connectedId)
            })
          }}
        />
        <button
          class="flat network-icon-button"
          visible={removable}
          sensitive={busy((v) => !v)}
          onClicked={() => {
            const adapter = getAdapter()
            if (!adapter) return
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              try {
                adapter.remove_device(device)
                requestDeviceRefresh(120)
              } catch (e) {
                setNotice({ text: formatError(e) })
                requestDeviceRefresh()
              }
              return GLib.SOURCE_REMOVE
            })
          }}
        >
          <label class="network-icon-button-label" label={"󰅖"} />
        </button>
      </box>
    </box>
  )
}

export function BluetoothControl({
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
  let popupRevealer: Gtk.Revealer | null = null
  let popupRoot: Gtk.Box | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `bluetooth:${monitor}`

  let deviceRefreshTimer: { cancel: () => void } | null = null
  let adapterRefreshTimer: { cancel: () => void } | null = null
  let discoveryTimeoutTimer: { cancel: () => void } | null = null
  const powered = createBinding(bluetooth, "is-powered")
  const connected = createBinding(bluetooth, "is-connected")
  const [notice, setNotice] = createState<Notice | null>(null)
  let noticeTimer: { cancel: () => void } | null = null
  const [deviceList, setDeviceList] = createState<Bluetooth.Device[]>(readDevices())

  const clearNoticeTimer = () => {
    noticeTimer?.cancel()
    noticeTimer = null
  }

  const presentNotice = (value: Notice | null, options: NoticeOptions = {}) => {
    clearNoticeTimer()
    setNotice(value)

    if (!value || value.text.trim().length === 0) return

    const durationMs = options.durationMs ?? 4200
    if (durationMs <= 0) return

    noticeTimer = timeout(durationMs, () => {
      noticeTimer = null
      setNotice((current) => current?.text === value.text ? null : current)
    })
  }
  const [adapterList, setAdapterList] = createState<Bluetooth.Adapter[]>(readAdapters())

  const syncDevices = () => setDeviceList(readDevices())
  const syncAdapters = () => setAdapterList(readAdapters())

  const requestDeviceRefresh = (delay = 0) => {
    deviceRefreshTimer?.cancel()
    deviceRefreshTimer = timeout(delay, () => {
      deviceRefreshTimer = null
      syncDevices()
    })
  }

  const requestAdapterRefresh = (delay = 0) => {
    adapterRefreshTimer?.cancel()
    adapterRefreshTimer = timeout(delay, () => {
      adapterRefreshTimer = null
      syncAdapters()
    })
  }

  const clearDiscoveryTimeout = () => {
    discoveryTimeoutTimer?.cancel()
    discoveryTimeoutTimer = null
  }

  const scheduleDiscoveryTimeout = (adapter: Bluetooth.Adapter | null, delay = BLUETOOTH_DISCOVERY_TIMEOUT_MS) => {
    clearDiscoveryTimeout()
    if (!adapter?.discovering) return

    discoveryTimeoutTimer = timeout(delay, () => {
      discoveryTimeoutTimer = null

      try {
        if (adapter.discovering) {
          adapter.stop_discovery()
          requestAdapterRefresh(0)
          requestDeviceRefresh(200)
        }
      } catch (e) {
        presentNotice({ text: formatError(e) })
        requestAdapterRefresh()
      }
    })
  }

  const sortedDevices = createComputed(() => [...deviceList()].sort((a, b) => deviceSortScore(a) - deviceSortScore(b)))
  const triggerIcon = createComputed(() => triggerGlyph(powered(), connected()))

  const connectedDeviceNames = createComputed(() => sortedDevices()
    .filter((device) => device.connected)
    .map((device) => deviceName(device)))

  const triggerTooltip = createComputed(() => {
    const adapter = adapterList()[0] ?? null
    const status = !powered()
      ? "Bluetooth off"
      : adapter?.discovering
        ? "Bluetooth scanning"
        : connected()
          ? "Bluetooth connected"
          : "Bluetooth on"

    const lines = [status]
    const devices = connectedDeviceNames()

    if (devices.length > 0) lines.push(devices.join(", "))

    return lines.join("\n")
  })

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
        console.warn(`Bluetooth action failed: ${formatError(error)}`)
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
      right: POPUP_SCREEN_RIGHT + 10,
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
    void ensureBluetoothAgent()
    presentNotice(null)
    requestDeviceRefresh(0)
    requestAdapterRefresh(0)
    scheduleDiscoveryTimeout(readAdapters()[0] ?? null)
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

  const popoverContent = (
    <box class="network-popover bluetooth-popover" orientation={Gtk.Orientation.VERTICAL} spacing={10} widthRequest={BLUETOOTH_POPOVER_WIDTH}>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
        <box class="network-header" spacing={8} valign={Gtk.Align.CENTER} visible={createComputed(() => adapterList().length === 0)}>
          <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
            <label class="network-header-title" xalign={0} label="Bluetooth" />
            <label class="network-header-meta" xalign={0} label="Unavailable" />
          </box>
          <box class="network-header-actions" spacing={6} valign={Gtk.Align.CENTER}>
            <button class="flat network-icon-button" sensitive={false} valign={Gtk.Align.CENTER}>
              <label class="network-icon-button-label" label={"󰑐"} />
            </button>
            <Gtk.Switch class="network-toggle bluetooth-toggle" sensitive={false} valign={Gtk.Align.CENTER} halign={Gtk.Align.END} />
          </box>
        </box>

        <With value={createComputed(() => adapterList()[0] ?? null)}>
          {(adapter) => {
            if (!adapter) return null

            const adapterPowered = createBinding(adapter, "powered")
            const adapterDiscovering = createBinding(adapter, "discovering")
            const adapterMeta = createComputed(() => {
              if (!adapterPowered()) return "Off"
              if (adapterDiscovering()) return "Scanning…"
              return "Ready"
            })

            return (
              <box class="network-header" spacing={8} valign={Gtk.Align.CENTER}>
                <box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
                  <label class="network-header-title" xalign={0} label={createBinding(adapter, "alias")} />
                  <label class="network-header-meta" xalign={0} label={adapterMeta} />
                </box>
                <box class="network-header-actions" spacing={6} valign={Gtk.Align.CENTER}>
                  <button class="flat network-icon-button" valign={Gtk.Align.CENTER} onClicked={() => {
                    deferAction(() => {
                      try {
                        if (adapter.discovering) {
                          clearDiscoveryTimeout()
                          adapter.stop_discovery()
                        } else {
                          adapter.start_discovery()
                          scheduleDiscoveryTimeout(adapter)
                        }
                        requestAdapterRefresh(0)
                      } catch (e) {
                        presentNotice({ text: formatError(e) })
                        requestAdapterRefresh()
                      }
                    })
                  }}>
                    <label class="network-icon-button-label" label={"󰑐"} />
                  </button>
                  <Gtk.Switch class="network-toggle bluetooth-toggle" valign={Gtk.Align.CENTER} halign={Gtk.Align.END} $={(self) => {
                    let pendingPowered: boolean | null = null
                    let syncingSwitch = false

                    const syncSwitch = () => {
                      const isPowered = pendingPowered ?? Boolean(adapter.powered)
                      if (self.get_active() === isPowered) return

                      syncingSwitch = true
                      self.set_active(isPowered)
                      syncingSwitch = false
                    }

                    syncSwitch()

                    const poweredId = adapter.connect("notify::powered", () => {
                      pendingPowered = null
                      syncSwitch()
                    })

                    self.connect("notify::active", () => {
                      if (syncingSwitch) return

                      if (pendingPowered !== null) {
                        syncSwitch()
                        return
                      }

                      const targetPowered = self.get_active()
                      if (targetPowered === Boolean(adapter.powered)) return

                      pendingPowered = targetPowered
                      deferAction(async () => {
                        try {
                          adapter.powered = targetPowered
                          requestAdapterRefresh(120)
                        } finally {
                          pendingPowered = null
                          GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            syncSwitch()
                            return GLib.SOURCE_REMOVE
                          })
                        }
                      })
                    })

                    self.connect("destroy", () => {
                      adapter.disconnect(poweredId)
                    })
                  }} />
                </box>
              </box>
            )
          }}
        </With>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} vexpand>
        <label class="network-section-title" xalign={0} label="Devices" />
        <box class="network-list-capsule" orientation={Gtk.Orientation.VERTICAL} vexpand>
          <Gtk.ScrolledWindow class="network-list-scroller" vexpand minContentHeight={120} maxContentHeight={220} propagateNaturalHeight>
            <box class="network-list-inner" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
              <For each={sortedDevices}>
                {(device) => (
                  <BluetoothDeviceRow
                    device={device}
                    getAdapter={() => adapterList()[0] ?? null}
                    setNotice={presentNotice}
                    requestDeviceRefresh={requestDeviceRefresh}
                    requestAdapterRefresh={requestAdapterRefresh}
                  />
                )}
              </For>
            </box>
          </Gtk.ScrolledWindow>
        </box>
      </box>

      <With value={notice}>
        {(value) => value && (
          <label class="network-section-title network-notice" xalign={0} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={42} lines={1} wrap={false} label={value.text} $={(self) => attachShellTooltip(self, () => value.text)} />
        )}
      </With>
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-bluetooth"
      class="widget-popup-window bluetooth-popup-window"
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
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame bluetooth-popover-window" widthRequest={BLUETOOTH_POPOVER_WIDTH} $={(self) => {
              clipRoundedWidget(self)
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
    <box class="network-shell" valign={Gtk.Align.CENTER}>
      <button class="bluetooth-trigger" valign={Gtk.Align.CENTER} onClicked={() => {
        togglePopup()
      }} $={(self) => {
        attachShellTooltip(self, triggerTooltip)
        trigger = self

        void ensureBluetoothAgent()

        syncDevices()
        syncAdapters()

        const adapterNotifyIds = new Map<Bluetooth.Adapter, number>()

        const syncAdapterWatchers = () => {
          const currentAdapters = readAdapters()

          for (const [adapter, id] of adapterNotifyIds) {
            if (!currentAdapters.includes(adapter)) {
              adapter.disconnect(id)
              adapterNotifyIds.delete(adapter)
            }
          }

          for (const adapter of currentAdapters) {
            if (adapterNotifyIds.has(adapter)) continue
            const id = adapter.connect("notify::discovering", () => {
              if (adapter.discovering) scheduleDiscoveryTimeout(adapter)
              else clearDiscoveryTimeout()
              requestAdapterRefresh(0)
              requestDeviceRefresh(200)
            })
            adapterNotifyIds.set(adapter, id)
          }
        }

        const notifyDevicesId = bluetooth.connect("notify::devices", () => requestDeviceRefresh())
        const notifyAdaptersId = bluetooth.connect("notify::adapters", () => {
          syncAdapterWatchers()
          requestAdapterRefresh()
          scheduleDiscoveryTimeout(readAdapters()[0] ?? null)
        })
        const deviceAddedId = bluetooth.connect("device-added", () => requestDeviceRefresh())
        const deviceRemovedId = bluetooth.connect("device-removed", () => requestDeviceRefresh(120))
        const adapterAddedId = bluetooth.connect("adapter-added", () => {
          syncAdapterWatchers()
          requestAdapterRefresh()
          scheduleDiscoveryTimeout(readAdapters()[0] ?? null)
        })
        const adapterRemovedId = bluetooth.connect("adapter-removed", () => {
          syncAdapterWatchers()
          clearDiscoveryTimeout()
          requestAdapterRefresh(120)
        })

        syncAdapterWatchers()
        scheduleDiscoveryTimeout(readAdapters()[0] ?? null)

        self.connect("destroy", () => {
          unregisterPopupController()
          bluetooth.disconnect(notifyDevicesId)
          bluetooth.disconnect(notifyAdaptersId)
          bluetooth.disconnect(deviceAddedId)
          bluetooth.disconnect(deviceRemovedId)
          bluetooth.disconnect(adapterAddedId)
          bluetooth.disconnect(adapterRemovedId)
          for (const [adapter, id] of adapterNotifyIds) adapter.disconnect(id)
          adapterNotifyIds.clear()
          deviceRefreshTimer?.cancel()
          adapterRefreshTimer?.cancel()
          clearNoticeTimer()
          clearDiscoveryTimeout()
          clearCloseTimeout()
          closingPopup = false
          setWindowVisible(false)
        })
      }}>
        <label class="module-icon" label={triggerIcon} />
      </button>
    </box>
  )
}
