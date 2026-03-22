import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Bluetooth from "gi://AstalBluetooth"
import { Astal } from "ags/gtk4"
import { For, With, createBinding, createComputed, createState } from "ags"
import { timeout } from "ags/time"
import { FLOATING_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, TOP_BAR_POPUP_MARGIN_TOP, isPointInsideWidget } from "./FloatingPopup"

const bluetooth = Bluetooth.get_default()

const BLUEZ_SERVICE = "org.bluez"
const BLUEZ_AGENT_MANAGER_PATH = "/org/bluez"
const BLUEZ_AGENT_MANAGER_IFACE = "org.bluez.AgentManager1"
const BLUEZ_AGENT_PATH = "/io/astal/BluetoothAgent"
const BLUEZ_AGENT_CAPABILITY = "NoInputNoOutput"

const POPOVER_REVEAL_DURATION_MS = 165
const BLUETOOTH_POPOVER_WIDTH = 392
const BLUETOOTH_POPUP_MARGIN_END = POPUP_SCREEN_RIGHT + 10
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
  exported: ExportedDbusObject | null
  registered: boolean
  lastHardError: string | null
}

const bluetoothAgentState: BluetoothAgentState = {
  connection: null,
  exported: null,
  registered: false,
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
promisifyIfPresent(Bluetooth.Device.prototype, "pair", "pair_finish")
promisifyIfPresent(Bluetooth.Device.prototype, "pair_device", "pair_device_finish")
promisifyIfPresent(Bluetooth.Device.prototype, "cancel_pairing", "cancel_pairing_finish")

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

type PairableDevice = Bluetooth.Device & {
  pair?: () => Promise<void> | void
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

function getSystemBusConnection() {
  if (bluetoothAgentState.connection && !bluetoothAgentState.connection.is_closed()) {
    return bluetoothAgentState.connection
  }

  bluetoothAgentState.connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
  return bluetoothAgentState.connection
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

function callBluezAgentManager(method: string, parameters: GLib.Variant) {
  const connection = getSystemBusConnection()
  return connection.call_sync(
    BLUEZ_SERVICE,
    BLUEZ_AGENT_MANAGER_PATH,
    BLUEZ_AGENT_MANAGER_IFACE,
    method,
    parameters,
    null,
    Gio.DBusCallFlags.NONE,
    -1,
    null,
  )
}

function isAlreadyExistsError(error: unknown) {
  const remoteName = getDbusRemoteErrorName(error)
  if (remoteName === "org.bluez.Error.AlreadyExists") return true

  const message = getReadableDbusErrorMessage(error)
  return message.includes("AlreadyExists") || message.includes("already exists")
}

function ensureBluetoothAgent() {
  try {
    if (bluetoothAgentState.registered) return null

    const connection = getSystemBusConnection()
    exportBluetoothAgent(connection)

    try {
      callBluezAgentManager(
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
      callBluezAgentManager(
        "RequestDefaultAgent",
        new GLib.Variant("(o)", [BLUEZ_AGENT_PATH]),
      )
    } catch {

    }

    bluetoothAgentState.lastHardError = null
    return null
  } catch (error) {
    const remoteName = getDbusRemoteErrorName(error)
    const readable = getReadableDbusErrorMessage(error)
    const message = remoteName ? `Bluetooth agent error: ${remoteName}: ${readable}` : `Bluetooth agent error: ${readable}`
    bluetoothAgentState.lastHardError = message
    console.warn(message)
    return null
  }
}

async function runMaybePromise(value: Promise<void> | void) {
  await value
}

async function pairDevice(device: Bluetooth.Device) {
  const d = device as PairableDevice

  if (typeof d.pair === "function") {
    await runMaybePromise(d.pair())
    return
  }

  if (typeof d.pair_device === "function") {
    await runMaybePromise(d.pair_device())
    return
  }

  throw new Error("No pairing method exposed by AstalBluetooth on this system")
}

function BluetoothDeviceRow({
  device,
  getAdapter,
  setNotice,
  requestDeviceRefresh,
}: {
  device: Bluetooth.Device
  getAdapter: () => Bluetooth.Adapter | null
  setNotice: (v: Notice | null) => void
  requestDeviceRefresh: (delay?: number) => void
}) {
  const alias = createBinding(device, "alias")
  const icon = createBinding(device, "icon")
  const connected = createBinding(device, "connected")
  const connecting = createBinding(device, "connecting")
  const paired = createBinding(device, "paired")
  const trusted = createBinding(device, "trusted")
  const battery = createBinding(device, "battery-percentage")
  const [pairing, setPairing] = createState(false)

  const title = createComputed(() => alias() || device.name || device.address || "Bluetooth device")
  const glyph = createComputed(() => deviceGlyph(icon() || "", title()))
  const busy = createComputed(() => pairing() || connecting())
  const removable = createComputed(() => Boolean(device.address))
  const known = createComputed(() => Boolean(connected() || paired() || trusted() || isBonded(device)))
  const canConnect = createComputed(() => canConnectWithoutPair(device))

  const meta = createComputed(() => {
    if (pairing()) return "Pairing…"
    if (connecting()) return canConnect() ? "Connecting…" : "Pairing…"

    const parts = [
      connected()
        ? "Connected"
        : (known() ? "Disconnected" : "Available"),
    ]

    if (!connected() && paired()) parts.push("Paired")
    if (!connected() && trusted()) parts.push("Trusted")
    if (!connected() && isBonded(device)) parts.push("Bonded")

    const b = batteryLabel(battery())
    if (b) parts.push(b)
    return parts.join(" • ")
  })

  const toggleConnection = async () => {
    try {
      if (connected()) {
        await device.disconnect_device()
        requestDeviceRefresh(120)
        return
      }

      ensureBluetoothAgent()

      const needsPair = !canConnectWithoutPair(device)

      if (needsPair) {
        setPairing(true)
        await pairDevice(device)
        requestDeviceRefresh(150)
        await sleep(900)
      }

      if (!device.trusted) {
        device.trusted = true
      }

      if (!device.connected) {
        await device.connect_device()
      }

      requestDeviceRefresh(120)
    } catch (e) {
      setNotice({ text: formatError(e) })
      requestDeviceRefresh()
    } finally {
      setPairing(false)
    }
  }

  return (
    <box class="network-row-shell" spacing={10} valign={Gtk.Align.CENTER}>
      <label class="network-row-icon" label={glyph} />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
        <label class="network-row-title" xalign={0} label={title} ellipsize={Pango.EllipsizeMode.END} maxWidthChars={26} />
        <label class="network-row-meta" xalign={0} label={meta} />
      </box>
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <Gtk.Switch
          class="network-toggle bluetooth-device-switch"
          active={connected}
          state={connected}
          sensitive={busy((v) => !v)}
          $={(self) => self.connect("state-set", () => {
            if (self.active !== connected()) {
              toggleConnection().catch(e => setNotice({ text: formatError(e) }))
            }
            return true
          })}
        />
        <button
          class="flat network-icon-button"
          visible={removable}
          sensitive={busy((v) => !v)}
          onClicked={() => {
            try {
              const adapter = getAdapter()
              if (!adapter) return
              adapter.remove_device(device)
              requestDeviceRefresh(120)
            } catch (e) {
              setNotice({ text: formatError(e) })
              requestDeviceRefresh()
            }
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
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  let deviceRefreshTimer: { cancel: () => void } | null = null
  let adapterRefreshTimer: { cancel: () => void } | null = null
  let discoveryTimeoutTimer: { cancel: () => void } | null = null
  const powered = createBinding(bluetooth, "is-powered")
  const connected = createBinding(bluetooth, "is-connected")
  const [notice, setNotice] = createState<Notice | null>(null)
  const [deviceList, setDeviceList] = createState<Bluetooth.Device[]>(readDevices())
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
        setNotice({ text: formatError(e) })
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
    ensureBluetoothAgent()
    requestDeviceRefresh(0)
    requestAdapterRefresh(0)
    scheduleDiscoveryTimeout(readAdapters()[0] ?? null)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (popupRevealer) popupRevealer.revealChild = true
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
  }

  const popoverContent = (
    <box class="network-popover bluetooth-popover" orientation={Gtk.Orientation.VERTICAL} spacing={10} widthRequest={BLUETOOTH_POPOVER_WIDTH}>
      <With value={createComputed(() => adapterList()[0] ?? null)}>
        {(adapter) => adapter && (
          <box class="network-header" spacing={8}>
            <box orientation={Gtk.Orientation.VERTICAL} hexpand>
              <label class="network-header-title" xalign={0} label={createBinding(adapter, "alias")} />
              <label class="network-header-meta" xalign={0} label={createBinding(adapter, "discovering")((d) => d ? "Scanning…" : "Visible")} />
            </box>
            <button class="flat network-icon-button" onClicked={() => {
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
                setNotice({ text: formatError(e) })
                requestAdapterRefresh()
              }
            }}>
              <label class="network-icon-button-label" label={"󰑐"} />
            </button>
            <Gtk.Switch class="network-toggle bluetooth-toggle" active={createBinding(adapter, "powered")} $={(self) => self.connect("state-set", () => {
              adapter.powered = !adapter.powered
              return true
            })} />
          </box>
        )}
      </With>

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
                    setNotice={setNotice}
                    requestDeviceRefresh={requestDeviceRefresh}
                  />
                )}
              </For>
            </box>
          </Gtk.ScrolledWindow>
        </box>
      </box>

      <With value={notice}>
        {(value) => value && (
          <label class="network-section-title" xalign={0} wrap label={value.text} />
        )}
      </With>
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      namespace="obsidian-shell"
      class="widget-popup-window bluetooth-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
    >
      <box class="widget-popup-root" hexpand vexpand>
        <Gtk.GestureClick
          button={0}
          onPressed={(_, _nPress, x, y) => {
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
            self.set_margin_end(BLUETOOTH_POPUP_MARGIN_END)
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame bluetooth-popover-window" widthRequest={BLUETOOTH_POPOVER_WIDTH} $={(self) => (popupFrame = self)}>
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
      <button class="bluetooth-trigger" valign={Gtk.Align.CENTER} tooltipText={triggerTooltip} onClicked={togglePopup} $={(self) => {
        trigger = self

        ensureBluetoothAgent()

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
