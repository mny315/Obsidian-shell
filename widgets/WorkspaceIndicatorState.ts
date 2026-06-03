import GLib from "gi://GLib"

import { createState } from "ags"
import { AGS_STATE_DIR } from "../config"

const WORKSPACE_INDICATOR_STATE_PATH = GLib.build_filenamev([AGS_STATE_DIR, "workspace-indicator-state.json"])

type WorkspaceIndicatorStateSnapshot = {
  visible?: boolean
}

function readWorkspaceIndicatorVisibleState() {
  try {
    const [ok, contents] = GLib.file_get_contents(WORKSPACE_INDICATOR_STATE_PATH)
    if (!ok || !contents) return false

    const parsed = JSON.parse(new TextDecoder().decode(contents)) as boolean | WorkspaceIndicatorStateSnapshot
    if (typeof parsed === "boolean") return parsed
    return Boolean(parsed?.visible)
  } catch {
    return false
  }
}

function saveWorkspaceIndicatorVisibleState(value: boolean) {
  try {
    GLib.mkdir_with_parents(AGS_STATE_DIR, 0o700)
    GLib.file_set_contents(WORKSPACE_INDICATOR_STATE_PATH, JSON.stringify({ visible: value }))
  } catch {}
}

const [workspaceIndicatorVisible, setWorkspaceIndicatorVisibleState] = createState(readWorkspaceIndicatorVisibleState())

function resolveNextVisibleValue(value: boolean | ((value: boolean) => boolean)) {
  const current = Boolean(workspaceIndicatorVisible())
  return typeof value === "function" ? Boolean(value(current)) : Boolean(value)
}

export { workspaceIndicatorVisible }

function setWorkspaceIndicatorVisible(value: boolean | ((value: boolean) => boolean)) {
  const nextValue = resolveNextVisibleValue(value)
  if (nextValue === Boolean(workspaceIndicatorVisible())) return

  setWorkspaceIndicatorVisibleState(nextValue)
  saveWorkspaceIndicatorVisibleState(nextValue)
}

export function toggleWorkspaceIndicatorVisible() {
  setWorkspaceIndicatorVisible((value) => !value)
}
