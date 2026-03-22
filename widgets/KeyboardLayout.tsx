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
    [["french", "fran\u00e7ais", "francais", "fr"], "FR"],
    [["spanish", "espa\u00f1ol", "espanol", "es"], "ES"],
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

  return null
}

function pickNiriActiveLayout(layouts: NiriKeyboardLayouts | null) {
  if (!layouts) return null

  const names = Array.isArray(layouts.names) ? layouts.names : []
  const idx = typeof layouts.current_idx === "number" ? layouts.current_idx : 0

  if (idx >= 0 && idx < names.length) return names[idx] ?? null
  return names[0] ?? null
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
  let knownLayouts: string[] = []

  try {
    const raw = await execAsync(["niri", "msg", "--json", "keyboard-layouts"])
    const layouts = parseNiriLayouts(JSON.parse(raw))
    knownLayouts = Array.isArray(layouts?.names) ? layouts?.names ?? [] : []

    const active = pickNiriActiveLayout(layouts)
    if (active) setLabel(compactLayoutName(active))
  } catch (error) {
    console.error(error)
  }

  const process = Gio.Subprocess.new(
    ["niri", "msg", "--json", "event-stream"],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
  )

  const stdout = process.get_stdout_pipe()
  if (!stdout) {
    return () => {
      try {
        process.force_exit()
      } catch {}
    }
  }

  const stream = new Gio.DataInputStream({
    base_stream: stdout,
    close_base_stream: true,
  })

  let stopped = false

  const handleLine = (line: string) => {
    try {
      const event = JSON.parse(line)

      const layoutsChanged = (event as { KeyboardLayoutsChanged?: { keyboard_layouts?: unknown } }).KeyboardLayoutsChanged
      if (layoutsChanged?.keyboard_layouts) {
        const layouts = parseNiriLayouts(layoutsChanged.keyboard_layouts)
        if (layouts?.names) knownLayouts = layouts.names

        const active = pickNiriActiveLayout(layouts)
        if (active) setLabel(compactLayoutName(active))
        return
      }

      const switched = (event as { KeyboardLayoutSwitched?: { idx?: number } }).KeyboardLayoutSwitched
      if (typeof switched?.idx === "number" && switched.idx >= 0 && switched.idx < knownLayouts.length) {
        const active = knownLayouts[switched.idx]
        if (active) setLabel(compactLayoutName(active))
      }
    } catch (error) {
      console.error(error)
    }
  }

  const readNext = () => {
    if (stopped) return

    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      if (stopped) return

      try {
        const [line] = stream.read_line_finish_utf8(result)

        if (line === null) return

        if (line.trim().length > 0) handleLine(line)
        readNext()
      } catch (error) {
        console.error(error)
      }
    })
  }

  readNext()

  process.wait_async(null, (_source, result) => {
    try {
      process.wait_finish(result)
    } catch (error) {
      if (!stopped) console.error(error)
    }
  })

  return () => {
    stopped = true

    try {
      stream.close(null)
    } catch {}

    try {
      process.force_exit()
    } catch {}
  }
}

export function KeyboardLayout() {
  const [label, setLabel] = createState("--")
  const [visible, setVisible] = createState(false)

  return (
    <box
      class="layout-indicator"
      spacing={6}
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
      <label class="layout-separator" label="•" />
      <label class="layout-label left-module-label" label={label} />
    </box>
  )
}
