import GLib from "gi://GLib"

import { createState } from "ags"

const STATE_HOME = (() => {
  const configured = GLib.getenv("XDG_STATE_HOME")?.trim() ?? ""
  if (configured.length > 0 && GLib.path_is_absolute(configured)) return configured
  return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"])
})()

const STATE_DIR = GLib.build_filenamev([STATE_HOME, "ags"])
const PLAYER_PIN_STATE_PATH = GLib.build_filenamev([STATE_DIR, "player-pin-state.json"])

type PlayerPinStateSnapshot = {
  pinned?: boolean
}

function readPlayerPinnedState() {
  try {
    const [ok, contents] = GLib.file_get_contents(PLAYER_PIN_STATE_PATH)
    if (!ok || !contents) return false

    const parsed = JSON.parse(new TextDecoder().decode(contents)) as boolean | PlayerPinStateSnapshot
    if (typeof parsed === "boolean") return parsed
    return Boolean(parsed?.pinned)
  } catch {
    return false
  }
}

function savePlayerPinnedState(value: boolean) {
  try {
    GLib.mkdir_with_parents(STATE_DIR, 0o700)
    GLib.file_set_contents(PLAYER_PIN_STATE_PATH, JSON.stringify({ pinned: value }))
  } catch {}
}

const [playerPinned, setPlayerPinnedState] = createState(readPlayerPinnedState())

function resolveNextPinnedValue(value: boolean | ((value: boolean) => boolean)) {
  const current = Boolean(playerPinned())
  return typeof value === "function" ? Boolean(value(current)) : Boolean(value)
}

export { playerPinned }

export function setPlayerPinned(value: boolean | ((value: boolean) => boolean)) {
  const nextValue = resolveNextPinnedValue(value)
  if (nextValue === Boolean(playerPinned())) return

  setPlayerPinnedState(nextValue)
  savePlayerPinnedState(nextValue)
}

export function togglePlayerPinned() {
  setPlayerPinned((value) => !value)
}
