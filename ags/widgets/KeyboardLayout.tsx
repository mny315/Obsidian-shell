import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"

import { createState } from "ags"
import { execAsync } from "ags/process"

type NiriKeyboardLayouts = {
  names?: string[]
  current_idx?: number
}

function compactLayoutName(name: string | null | undefined) {
  if (!name) return "--"

  const raw = name.trim()
  if (!raw) return "--"

  const lower = raw.toLowerCase()

  const known: Array<[string[], string]> = [
    [["english", "us", "qwerty"], "US"],
    [["russian", "ru"], "RU"],
    [["ukrainian", "ukraine", "ua"], "UA"],
    [["german", "deutsch", "de"], "DE"],
    [["french", "français", "francais", "fr"], "FR"],
    [["spanish", "español", "espanol", "es"], "ES"],
    [["italian", "italiano", "it"], "IT"],
    [["polish", "polski", "pl"], "PL"],
    [["czech", "cs", "cz"], "CZ"],
    [["turkish", "tr"], "TR"],
    [["dutch", "nederlands", "nl"], "NL"],
  ]

  for (const [aliases, code] of known) {
    if (aliases.some((alias) => lower === alias || lower.startsWith(`${alias} `) || lower.startsWith(`${alias} (`))) {
      return code
    }
  }

  if (/^[a-z]{2}$/i.test(raw)) return raw.toUpperCase()

  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim()

  if (!normalized) return "--"

  const words = normalized.split(/\s+/)
  const first = words[0] ?? ""

  if (first.length >= 2) return first.slice(0, 2).toUpperCase()

  return raw.slice(0, 2).toUpperCase()
}

function parseHyprDevicesLayout(raw: string | null | undefined) {
  if (typeof raw !== "string") return null

  const trimmed = raw.trim()
  if (!trimmed) return null

  const jsonStartCandidates = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0)
  const jsonStart = jsonStartCandidates.length > 0 ? Math.min(...jsonStartCandidates) : -1

  if (jsonStart < 0) {
    console.warn(`Hyprland devices reply is not JSON: ${trimmed.slice(0, 200)}`)
    return null
  }

  const candidate = trimmed.slice(jsonStart)

  try {
    const parsed = JSON.parse(candidate)
    const keyboards = Array.isArray(parsed?.keyboards) ? parsed.keyboards : []
    const mainKeyboard = keyboards.find((keyboard) => keyboard?.main) ?? keyboards[0]
    const activeKeymap = mainKeyboard?.active_keymap
    return typeof activeKeymap === "string" ? activeKeymap : null
  } catch (error) {
    console.error(`Failed to parse Hyprland devices JSON: ${candidate.slice(0, 200)}`)
    console.error(error)
    return null
  }
}

async function getHyprDevicesLayout(hyprland: { message_async: (msg: string, cancellable?: Gio.Cancellable | null) => Promise<string> }) {
  try {
    const raw = await hyprland.message_async("j/devices", null)
    const active = parseHyprDevicesLayout(raw)
    if (active) return active
  } catch (error) {
    console.error(error)
  }

  try {
    const raw = await execAsync(["hyprctl", "-j", "devices"])
    const active = parseHyprDevicesLayout(raw)
    if (active) return active
  } catch (error) {
    console.error(error)
  }

  return null
}

function parseNiriLayouts(payload: unknown): NiriKeyboardLayouts | null {
  if (!payload || typeof payload !== "object") return null

  const candidate = payload as NiriKeyboardLayouts
  if (Array.isArray(candidate.names)) return candidate

  if ("Ok" in (payload as Record<string, unknown>)) {
    const ok = (payload as { Ok?: unknown }).Ok
    if (ok && typeof ok === "object" && "KeyboardLayouts" in (ok as Record<string, unknown>)) {
      return parseNiriLayouts((ok as { KeyboardLayouts?: unknown }).KeyboardLayouts)
    }
  }

  if ("KeyboardLayouts" in (payload as Record<string, unknown>)) {
    return parseNiriLayouts((payload as { KeyboardLayouts?: unknown }).KeyboardLayouts)
  }

  return null
}

function pickNiriActiveLayout(layouts: NiriKeyboardLayouts | null) {
  if (!layouts) return null

  const names = Array.isArray(layouts.names) ? layouts.names : []
  const idx = typeof layouts.current_idx === "number" ? layouts.current_idx : 0

  if (idx >= 0 && idx < names.length) return names[idx] ?? null
  return names[0] ?? null
}

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

function connectSocketAsync(client: Gio.SocketClient, address: Gio.SocketConnectable) {
  return new Promise<Gio.SocketConnection>((resolve, reject) => {
    client.connect_async(address, null, (_source, result) => {
      try {
        resolve(client.connect_finish(result))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function closeNiriConnection(connection: Gio.SocketConnection | null, stream: Gio.DataInputStream | null) {
  try {
    stream?.close(null)
  } catch {}

  try {
    connection?.close(null)
  } catch {}
}

async function initializeHyprland(setLabel: (next: string | ((prev: string) => string)) => void) {
  const { default: Hyprland } = await import("gi://AstalHyprland?version=0.1")
  const hyprland = Hyprland.get_default()

  try {
    const active = await getHyprDevicesLayout(hyprland)
    if (active) setLabel(compactLayoutName(active))
  } catch (error) {
    console.error(error)
  }

  const signalId = hyprland.connect("keyboard-layout", (_self, _keyboard: string, layout: string) => {
    setLabel(compactLayoutName(layout))
  })

  return () => {
    try {
      hyprland.disconnect(signalId)
    } catch {}
  }
}

async function initializeNiri(setLabel: (next: string | ((prev: string) => string)) => void) {
  const socketPath = GLib.getenv("NIRI_SOCKET")
  if (!socketPath) return () => {}

  let knownLayouts: string[] = []
  let stopped = false
  let reconnectId = 0
  let connection: Gio.SocketConnection | null = null
  let stream: Gio.DataInputStream | null = null

  const applyLayouts = (payload: unknown) => {
    const layouts = parseNiriLayouts(payload)
    if (!layouts) return

    if (Array.isArray(layouts.names)) knownLayouts = layouts.names

    const active = pickNiriActiveLayout(layouts)
    if (active) setLabel(compactLayoutName(active))
  }

  const handleEventLine = (line: string) => {
    const event = JSON.parse(line)

    const layoutsChanged = (event as { KeyboardLayoutsChanged?: { keyboard_layouts?: unknown } }).KeyboardLayoutsChanged
    if (layoutsChanged?.keyboard_layouts) {
      applyLayouts(layoutsChanged.keyboard_layouts)
      return
    }

    const switched = (event as { KeyboardLayoutSwitched?: { idx?: number } }).KeyboardLayoutSwitched
    if (typeof switched?.idx === "number" && switched.idx >= 0 && switched.idx < knownLayouts.length) {
      const active = knownLayouts[switched.idx]
      if (active) setLabel(compactLayoutName(active))
    }
  }

  const scheduleReconnect = () => {
    if (stopped || reconnectId) return

    reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      reconnectId = 0
      void startStream()
      return GLib.SOURCE_REMOVE
    })
  }

  const readNext = () => {
    if (stopped || !stream) return

    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      if (stopped || !stream) return

      try {
        const [line] = stream.read_line_finish_utf8(result)

        if (line === null) {
          closeNiriConnection(connection, stream)
          connection = null
          stream = null
          scheduleReconnect()
          return
        }

        if (line.trim().length > 0) handleEventLine(line)
        readNext()
      } catch (error) {
        console.error(error)
        closeNiriConnection(connection, stream)
        connection = null
        stream = null
        scheduleReconnect()
      }
    })
  }

  const startStream = async () => {
    if (stopped) return

    closeNiriConnection(connection, stream)
    connection = null
    stream = null

    try {
      const client = new Gio.SocketClient()
      const address = Gio.UnixSocketAddress.new(socketPath)
      connection = await connectSocketAsync(client, address)

      const output = connection.get_output_stream()
      const socket = connection.get_socket()
      output.write_all(encodeUtf8(`${JSON.stringify("EventStream")}\n`), null)
      output.flush(null)
      socket?.shutdown(false, true)

      stream = new Gio.DataInputStream({
        base_stream: connection.get_input_stream(),
        close_base_stream: true,
      })

      const replyLine = await new Promise<string | null>((resolve, reject) => {
        stream?.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
          try {
            if (!stream) {
              resolve(null)
              return
            }

            const [line] = stream.read_line_finish_utf8(result)
            resolve(line)
          } catch (error) {
            reject(error)
          }
        })
      })

      if (replyLine === null) {
        throw new Error("niri event stream closed before reply")
      }

      const reply = JSON.parse(replyLine)
      if (reply && typeof reply === "object" && "Err" in (reply as Record<string, unknown>)) {
        throw new Error(`niri event stream error: ${JSON.stringify((reply as { Err?: unknown }).Err)}`)
      }

      readNext()
    } catch (error) {
      console.error(error)
      closeNiriConnection(connection, stream)
      connection = null
      stream = null
      scheduleReconnect()
    }
  }

  void startStream()

  return () => {
    stopped = true

    if (reconnectId) {
      GLib.source_remove(reconnectId)
      reconnectId = 0
    }

    closeNiriConnection(connection, stream)
    connection = null
    stream = null
  }
}

export function KeyboardLayout() {
  const [label, setLabel] = createState("--")
  const [visible, setVisible] = createState(false)

  return (
    <box
      class="section section-center left-module-shell left-status-shell"
      spacing={0}
      visible={visible}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        let cleanup: (() => void) | undefined

        const start = async () => {
          try {
            if (GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")) {
              setVisible(true)
              cleanup = await initializeHyprland(setLabel)
              return
            }

            if (GLib.getenv("NIRI_SOCKET")) {
              setVisible(true)
              cleanup = await initializeNiri(setLabel)
              return
            }
          } catch (error) {
            console.error(error)
          }
        }

        void start().catch(console.error)

        self.connect("destroy", () => {
          try {
            cleanup?.()
          } catch (error) {
            console.error(error)
          }
        })
      }}
    >
      <box
        class="layout-indicator left-module-button left-module-content left-status-content"
        spacing={0}
        valign={Gtk.Align.CENTER}
        halign={Gtk.Align.CENTER}
      >
        <label class="layout-label left-module-label" label={label} />
      </box>
    </box>
  )
}
