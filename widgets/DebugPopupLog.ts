import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"
import Gtk from "gi://Gtk?version=4.0"

// DEBUG_POPUP_LOG: temporary diagnostic logger for intermittent dead popup buttons.
// Writes to ~/obsidian-shell-debug.log because production/autostart wrappers can send
// stdout/stderr to /dev/null. Remove this whole file and every DEBUG_POPUP_LOG import/call
// after the bug is found.
const DEBUG_POPUP_LOG_PATH = GLib.build_filenamev([GLib.get_home_dir(), "obsidian-shell-debug.log"])
const DEBUG_POPUP_MAX_BYTES = 5 * 1024 * 1024

let debugPopupSequence = 0
let debugPopupLogInitialized = false
const textEncoder = new TextEncoder()

function safeValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function safeAppend(path: string, line: string) {
  const file = Gio.File.new_for_path(path)

  try {
    const info = file.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null)
    if (info.get_size() > DEBUG_POPUP_MAX_BYTES) {
      file.replace_contents(
        textEncoder.encode(`===== obsidian-shell debug log rotated ${new Date().toISOString()} =====\n`),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      )
    }
  } catch {}

  const stream = file.append_to(Gio.FileCreateFlags.NONE, null)
  try {
    stream.write_all(textEncoder.encode(line), null)
  } finally {
    stream.close(null)
  }
}

export function debugPopupLog(scope: string, message: string, state: Record<string, unknown> = {}) {
  // DEBUG_POPUP_LOG: keep this logger non-fatal. Debug logging must never break the shell.
  try {
    if (!debugPopupLogInitialized) {
      debugPopupLogInitialized = true
      safeAppend(DEBUG_POPUP_LOG_PATH, `\n===== obsidian-shell debug start ${new Date().toISOString()} pid=${GLib.get_prgname() ?? "unknown"} =====\n`)
    }

    const details = Object.entries(state)
      .map(([key, value]) => `${key}=${safeValue(value)}`)
      .join(" ")

    const line = `${new Date().toISOString()} #${++debugPopupSequence} [${scope}] ${message}${details ? ` ${details}` : ""}\n`
    safeAppend(DEBUG_POPUP_LOG_PATH, line)
  } catch {}
}

export function debugPopupSnapshot(args: {
  windowVisible?: unknown
  closingPopup?: unknown
  revealed?: unknown
  hasRoot?: unknown
  hasPlacement?: unknown
  hasFrame?: unknown
  hasRevealer?: unknown
  hasTrigger?: unknown
  triggerOpen?: unknown
  closeTimeoutId?: unknown
  extra?: Record<string, unknown>
}) {
  return {
    visible: args.windowVisible,
    closing: args.closingPopup,
    revealed: args.revealed,
    root: args.hasRoot,
    placement: args.hasPlacement,
    frame: args.hasFrame,
    revealer: args.hasRevealer,
    trigger: args.hasTrigger,
    triggerOpen: args.triggerOpen,
    closeTimeoutId: args.closeTimeoutId,
    ...(args.extra ?? {}),
  }
}


function callNumber(widget: any, name: string) {
  try {
    const value = widget?.[name]?.()
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function callBoolean(widget: any, name: string) {
  try {
    const value = widget?.[name]?.()
    return typeof value === "boolean" ? value : undefined
  } catch {
    return undefined
  }
}

function safeWidgetClass(widget: Gtk.Widget | null | undefined) {
  try {
    return String((widget as any)?.constructor?.name ?? "")
  } catch {
    return ""
  }
}

function boundsSnapshot(widget: Gtk.Widget | null | undefined, root: Gtk.Widget | null | undefined) {
  if (!widget || !root) return { ok: false }

  try {
    const result = typeof (widget as any).compute_bounds === "function"
      ? (widget as any).compute_bounds(root)
      : null
    const ok = Array.isArray(result) ? Boolean(result[0]) : false
    const rect = Array.isArray(result) ? result[1] : null

    if (!ok || !rect) return { ok }

    const left = rect?.origin?.x ?? rect?.x
    const top = rect?.origin?.y ?? rect?.y
    const width = rect?.size?.width ?? rect?.width
    const height = rect?.size?.height ?? rect?.height

    return { ok, left, top, width, height }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export function debugWidgetSnapshot(
  widget: Gtk.Widget | null | undefined,
  root: Gtk.Widget | null | undefined = undefined,
) {
  // DEBUG_POPUP_LOG: widget geometry/mapping snapshot. Remove together with debug logger.
  return {
    exists: Boolean(widget),
    klass: safeWidgetClass(widget),
    visible: callBoolean(widget as any, "get_visible"),
    mapped: callBoolean(widget as any, "get_mapped"),
    realized: callBoolean(widget as any, "get_realized"),
    sensitive: callBoolean(widget as any, "get_sensitive"),
    canTarget: callBoolean(widget as any, "get_can_target"),
    focusable: callBoolean(widget as any, "get_focusable"),
    opacity: callNumber(widget as any, "get_opacity"),
    width: callNumber(widget as any, "get_width"),
    height: callNumber(widget as any, "get_height"),
    allocatedWidth: callNumber(widget as any, "get_allocated_width"),
    allocatedHeight: callNumber(widget as any, "get_allocated_height"),
    marginStart: callNumber(widget as any, "get_margin_start"),
    marginTop: callNumber(widget as any, "get_margin_top"),
    marginEnd: callNumber(widget as any, "get_margin_end"),
    marginBottom: callNumber(widget as any, "get_margin_bottom"),
    bounds: boundsSnapshot(widget, root),
  }
}

export function debugWidgetMap(scope: string, name: string, widget: Gtk.Widget | null | undefined, root?: Gtk.Widget | null | undefined) {
  debugPopupLog(scope, `${name} geometry`, debugWidgetSnapshot(widget, root))
}
