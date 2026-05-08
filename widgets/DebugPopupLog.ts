import Gio from "gi://Gio?version=2.0"
import GLib from "gi://GLib?version=2.0"

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
