import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { For, createState } from "ags"


type WorkspaceChip = {
  key: string
  className: string
  coreClassName: string
  tooltip: string
  onActivate: () => void
}


type NiriWorkspace = {
  id: number
  idx: number
  name: string | null
  output: string | null
  is_urgent: boolean
  is_active: boolean
  is_focused: boolean
  active_window_id: number | null
}

function compactText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function getMonitorConnectorName(index: number) {
  try {
    const display = Gdk.Display.get_default()
    const monitors = display?.get_monitors()
    const monitor = monitors?.get_item(index) as (Gdk.Monitor & Record<string, unknown>) | null
    if (!monitor) return null

    const dynamicMonitor = monitor as Record<string, unknown> & {
      get_connector?: () => string | null
      get_model?: () => string | null
    }

    const candidates = [
      typeof dynamicMonitor.get_connector === "function" ? dynamicMonitor.get_connector() : null,
      typeof dynamicMonitor.connector === "string" ? dynamicMonitor.connector : null,
      typeof dynamicMonitor.get_model === "function" ? dynamicMonitor.get_model() : null,
      typeof dynamicMonitor.model === "string" ? dynamicMonitor.model : null,
    ]

    for (const candidate of candidates) {
      const text = compactText(candidate)
      if (text) return text
    }
  } catch (error) {
    console.error(error)
  }

  return null
}

function workspaceChipClass({ active, focused, urgent, occupied }: { active: boolean; focused: boolean; urgent: boolean; occupied: boolean }) {
  const classes = ["workspace-chip"]
  if (occupied) classes.push("occupied")
  if (active) classes.push("active")
  if (focused) classes.push("focused")
  if (urgent) classes.push("urgent")
  return classes.join(" ")
}

function workspaceChipCoreClass({ active, focused, urgent, occupied }: { active: boolean; focused: boolean; urgent: boolean; occupied: boolean }) {
  const classes = ["workspace-chip-core"]
  if (occupied) classes.push("occupied")
  if (active) classes.push("active")
  if (focused) classes.push("focused")
  if (urgent) classes.push("urgent")
  return classes.join(" ")
}

function workspaceChipLabel(id: number, fallbackName: string | null) {
  const fallback = compactText(fallbackName)
  if (Number.isFinite(id) && id > 0) return `${id}`
  if (fallback) return fallback.slice(0, 3).toUpperCase()
  return "?"
}

function workspaceChipTooltip(label: string, name: string | null, active: boolean, focused: boolean, urgent: boolean, occupied: boolean) {
  const parts = [`Workspace ${label}`]
  const title = compactText(name)
  if (title && title !== label) parts.push(title)
  if (focused) parts.push("focused")
  else if (active) parts.push("active")
  if (occupied) parts.push("occupied")
  if (urgent) parts.push("urgent")
  return parts.join(" • ")
}

function arrayFromUnknown<T>(value: unknown): T[] {
  if (!value) return []
  if (Array.isArray(value)) return [...value] as T[]

  try {
    if (typeof (value as Iterable<T>)[Symbol.iterator] === "function") {
      return Array.from(value as Iterable<T>)
    }
  } catch {}

  try {
    const length = Number((value as { length?: number }).length)
    if (Number.isFinite(length) && length >= 0) {
      return Array.from(value as ArrayLike<T>)
    }
  } catch {}

  return []
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

function readLineUtf8Async(stream: Gio.DataInputStream) {
  return new Promise<string | null>((resolve, reject) => {
    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      try {
        const [line] = stream.read_line_finish_utf8(result)
        resolve(line)
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

async function sendNiriRequest(request: unknown) {
  const socketPath = compactText(GLib.getenv("NIRI_SOCKET"))
  if (!socketPath) return null

  let connection: Gio.SocketConnection | null = null
  let stream: Gio.DataInputStream | null = null

  try {
    const client = new Gio.SocketClient()
    const address = Gio.UnixSocketAddress.new(socketPath)
    connection = await connectSocketAsync(client, address)

    const output = connection.get_output_stream()
    output.write_all(encodeUtf8(`${JSON.stringify(request)}\n`), null)
    output.flush(null)
    connection.get_socket()?.shutdown(false, true)

    stream = new Gio.DataInputStream({
      base_stream: connection.get_input_stream(),
      close_base_stream: true,
    })

    const replyLine = await readLineUtf8Async(stream)
    if (replyLine === null) return null

    const payload = JSON.parse(replyLine)
    if (payload && typeof payload === "object" && "Err" in (payload as Record<string, unknown>)) {
      throw new Error(`niri ipc error: ${JSON.stringify((payload as { Err?: unknown }).Err)}`)
    }

    return payload
  } finally {
    closeNiriConnection(connection, stream)
  }
}

function normalizeNiriWorkspace(raw: unknown): NiriWorkspace | null {
  if (!raw || typeof raw !== "object") return null

  const workspace = raw as Record<string, unknown>
  const id = Number(workspace.id)
  const idx = Number(workspace.idx)

  if (!Number.isFinite(id) || !Number.isFinite(idx)) return null

  return {
    id,
    idx,
    name: compactText(workspace.name) || null,
    output: compactText(workspace.output) || null,
    is_urgent: Boolean(workspace.is_urgent),
    is_active: Boolean(workspace.is_active),
    is_focused: Boolean(workspace.is_focused),
    active_window_id: workspace.active_window_id == null ? null : Number(workspace.active_window_id),
  }
}

function niriWorkspaceItems(workspaces: NiriWorkspace[], monitor: number) {
  const targetOutput = getMonitorConnectorName(monitor)

  let filtered = targetOutput
    ? workspaces.filter((workspace) => workspace.output === targetOutput)
    : [...workspaces]

  if (filtered.length === 0) filtered = workspaces.filter((workspace) => workspace.is_active || workspace.is_focused)
  if (filtered.length === 0) filtered = [...workspaces]

  return filtered
    .filter((workspace) => workspace.idx > 0)
    .sort((a, b) => a.idx - b.idx)
    .map<WorkspaceChip>((workspace) => {
      const label = `${workspace.idx}`
      const state = {
        active: workspace.is_active,
        focused: workspace.is_focused,
        urgent: workspace.is_urgent,
        occupied: workspace.active_window_id !== null,
      }

      return {
        key: `niri-${workspace.id}`,
        className: workspaceChipClass(state),
        coreClassName: workspaceChipCoreClass(state),
        tooltip: workspaceChipTooltip(
          label,
          workspace.name,
          workspace.is_active,
          workspace.is_focused,
          workspace.is_urgent,
          workspace.active_window_id !== null,
        ),
        onActivate: () => {
          void sendNiriRequest({
            Action: {
              FocusWorkspace: {
                reference: { Id: workspace.id },
              },
            },
          }).catch(console.error)
        },
      }
    })
}

function getHyprlandMonitors(hyprland: Record<string, unknown>) {
  try {
    const getMonitors = hyprland.get_monitors as (() => unknown) | undefined
    if (typeof getMonitors === "function") return arrayFromUnknown(getMonitors())
  } catch {}

  return arrayFromUnknown(hyprland.monitors)
}

function getHyprlandWorkspaces(hyprland: Record<string, unknown>) {
  try {
    const getWorkspaces = hyprland.get_workspaces as (() => unknown) | undefined
    if (typeof getWorkspaces === "function") return arrayFromUnknown(getWorkspaces())
  } catch {}

  return arrayFromUnknown(hyprland.workspaces)
}

function getHyprWorkspaceId(workspace: Record<string, unknown>) {
  try {
    const getId = workspace.get_id as (() => number) | undefined
    if (typeof getId === "function") return Number(getId())
  } catch {}

  return Number(workspace.id)
}

function getHyprWorkspaceName(workspace: Record<string, unknown>) {
  try {
    const getName = workspace.get_name as (() => string | null) | undefined
    if (typeof getName === "function") return compactText(getName()) || null
  } catch {}

  return compactText(workspace.name) || null
}

function getHyprWorkspaceMonitorName(workspace: Record<string, unknown>) {
  try {
    const getMonitor = workspace.get_monitor as (() => Record<string, unknown> | null) | undefined
    const monitor = typeof getMonitor === "function" ? getMonitor() : (workspace.monitor as Record<string, unknown> | null)
    if (!monitor) return null

    const getName = monitor.get_name as (() => string | null) | undefined
    if (typeof getName === "function") return compactText(getName()) || null
    return compactText(monitor.name) || null
  } catch {
    return null
  }
}

function getHyprWorkspaceClients(workspace: Record<string, unknown>) {
  try {
    const getClients = workspace.get_clients as (() => unknown) | undefined
    if (typeof getClients === "function") return arrayFromUnknown(getClients())
  } catch {}

  return arrayFromUnknown(workspace.clients)
}

function getHyprMonitorName(monitor: Record<string, unknown>) {
  try {
    const getName = monitor.get_name as (() => string | null) | undefined
    if (typeof getName === "function") return compactText(getName()) || null
  } catch {}

  return compactText(monitor.name) || null
}

function getHyprMonitorActiveWorkspaceId(monitor: Record<string, unknown>) {
  try {
    const getActiveWorkspace = monitor.get_active_workspace as (() => Record<string, unknown> | null) | undefined
    const workspace = typeof getActiveWorkspace === "function"
      ? getActiveWorkspace()
      : (monitor["active-workspace"] as Record<string, unknown> | null) ?? (monitor.active_workspace as Record<string, unknown> | null)

    if (!workspace) return null
    const id = getHyprWorkspaceId(workspace)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

function getHyprFocusedWorkspaceId(hyprland: Record<string, unknown>) {
  try {
    const getFocusedWorkspace = hyprland.get_focused_workspace as (() => Record<string, unknown> | null) | undefined
    const workspace = typeof getFocusedWorkspace === "function"
      ? getFocusedWorkspace()
      : (hyprland["focused-workspace"] as Record<string, unknown> | null) ?? (hyprland.focused_workspace as Record<string, unknown> | null)

    if (!workspace) return null
    const id = getHyprWorkspaceId(workspace)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

function hyprlandWorkspaceItems(hyprland: Record<string, unknown>, monitor: number) {
  const targetMonitorName = getMonitorConnectorName(monitor)
  const monitors = getHyprlandMonitors(hyprland)
  const workspaces = getHyprlandWorkspaces(hyprland) as Array<Record<string, unknown>>
  const focusedWorkspaceId = getHyprFocusedWorkspaceId(hyprland)

  const activeWorkspaceByMonitor = new Map<string, number>()
  for (const entry of monitors as Array<Record<string, unknown>>) {
    const name = getHyprMonitorName(entry)
    const activeId = getHyprMonitorActiveWorkspaceId(entry)
    if (name && activeId !== null) activeWorkspaceByMonitor.set(name, activeId)
  }

  let filtered = targetMonitorName
    ? workspaces.filter((workspace) => getHyprWorkspaceMonitorName(workspace) === targetMonitorName)
    : [...workspaces]

  if (filtered.length === 0 && focusedWorkspaceId !== null) {
    filtered = workspaces.filter((workspace) => getHyprWorkspaceId(workspace) === focusedWorkspaceId)
  }

  if (filtered.length === 0) filtered = [...workspaces]

  return filtered
    .filter((workspace) => {
      const id = getHyprWorkspaceId(workspace)
      return Number.isFinite(id) && id > 0
    })
    .sort((a, b) => getHyprWorkspaceId(a) - getHyprWorkspaceId(b))
    .map<WorkspaceChip>((workspace) => {
      const id = getHyprWorkspaceId(workspace)
      const name = getHyprWorkspaceName(workspace)
      const monitorName = getHyprWorkspaceMonitorName(workspace)
      const activeId = monitorName ? activeWorkspaceByMonitor.get(monitorName) ?? null : null
      const focused = focusedWorkspaceId === id
      const active = activeId === id || focused
      const occupied = getHyprWorkspaceClients(workspace).length > 0
      const urgent = false
      const label = workspaceChipLabel(id, name)

      const state = { active, focused, urgent, occupied }

      return {
        key: `hypr-${id}`,
        className: workspaceChipClass(state),
        coreClassName: workspaceChipCoreClass(state),
        tooltip: workspaceChipTooltip(label, name, active, focused, urgent, occupied),
        onActivate: () => {
          try {
            const focus = workspace.focus as (() => void) | undefined
            if (typeof focus === "function") {
              focus.call(workspace)
              return
            }
          } catch (error) {
            console.error(error)
          }

          const messageAsync = hyprland.message_async as ((msg: string, cancellable?: Gio.Cancellable | null) => Promise<string>) | undefined
          if (typeof messageAsync === "function") {
            void messageAsync(`dispatch workspace ${id}`, null).catch(console.error)
          }
        },
      }
    })
}

async function initializeHyprland(monitor: number, setItems: (value: WorkspaceChip[]) => void, setVisible: (value: boolean) => void) {
  const { default: Hyprland } = await import("gi://AstalHyprland?version=0.1")
  const hyprland = Hyprland.get_default() as Record<string, unknown>

  const sync = () => {
    try {
      const next = hyprlandWorkspaceItems(hyprland, monitor)
      setItems(next)
      setVisible(next.length > 0)
    } catch (error) {
      console.error(error)
      setItems([])
      setVisible(false)
    }
  }

  sync()

  const signalIds = [
    hyprland.connect("event", sync),
    hyprland.connect("notify::workspaces", sync),
    hyprland.connect("notify::focused-workspace", sync),
    hyprland.connect("notify::monitors", sync),
    hyprland.connect("client-added", sync),
    hyprland.connect("client-removed", sync),
    hyprland.connect("client-moved", sync),
    hyprland.connect("workspace-added", sync),
    hyprland.connect("workspace-removed", sync),
    hyprland.connect("monitor-added", sync),
    hyprland.connect("monitor-removed", sync),
  ]

  return () => {
    for (const signalId of signalIds) {
      try {
        hyprland.disconnect(signalId)
      } catch {}
    }
  }
}

async function initializeNiri(monitor: number, setItems: (value: WorkspaceChip[]) => void, setVisible: (value: boolean) => void) {
  const socketPath = compactText(GLib.getenv("NIRI_SOCKET"))
  if (!socketPath) return () => {}

  let stopped = false
  let reconnectId = 0
  let connection: Gio.SocketConnection | null = null
  let stream: Gio.DataInputStream | null = null
  let knownWorkspaces: NiriWorkspace[] = []

  const sync = () => {
    const next = niriWorkspaceItems(knownWorkspaces, monitor)
    setItems(next)
    setVisible(next.length > 0)
  }

  const scheduleReconnect = () => {
    if (stopped || reconnectId !== 0) return

    reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      reconnectId = 0
      void startStream()
      return GLib.SOURCE_REMOVE
    })
  }

  const handleEventLine = (line: string) => {
    const event = JSON.parse(line) as Record<string, unknown>

    const workspacesChanged = (event.WorkspacesChanged as { workspaces?: unknown } | undefined)?.workspaces
    if (Array.isArray(workspacesChanged)) {
      knownWorkspaces = workspacesChanged
        .map((workspace) => normalizeNiriWorkspace(workspace))
        .filter((workspace): workspace is NiriWorkspace => workspace !== null)
      sync()
      return
    }

    const activated = event.WorkspaceActivated as { id?: unknown; focused?: unknown } | undefined
    if (activated && Number.isFinite(Number(activated.id))) {
      const id = Number(activated.id)
      const focused = Boolean(activated.focused)
      const target = knownWorkspaces.find((workspace) => workspace.id === id)

      if (target) {
        const output = target.output
        for (const workspace of knownWorkspaces) {
          if (output && workspace.output === output) workspace.is_active = false
          if (focused) workspace.is_focused = false
        }

        target.is_active = true
        target.is_focused = focused
        sync()
      }
      return
    }

    const urgency = event.WorkspaceUrgencyChanged as { id?: unknown; urgent?: unknown } | undefined
    if (urgency && Number.isFinite(Number(urgency.id))) {
      const target = knownWorkspaces.find((workspace) => workspace.id === Number(urgency.id))
      if (target) {
        target.is_urgent = Boolean(urgency.urgent)
        sync()
      }
      return
    }

    const activeWindow = event.WorkspaceActiveWindowChanged as { workspace_id?: unknown; active_window_id?: unknown } | undefined
    if (activeWindow && Number.isFinite(Number(activeWindow.workspace_id))) {
      const target = knownWorkspaces.find((workspace) => workspace.id === Number(activeWindow.workspace_id))
      if (target) {
        target.active_window_id = activeWindow.active_window_id == null ? null : Number(activeWindow.active_window_id)
        sync()
      }
    }
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
      output.write_all(encodeUtf8(`${JSON.stringify("EventStream")}\n`), null)
      output.flush(null)
      connection.get_socket()?.shutdown(false, true)

      stream = new Gio.DataInputStream({
        base_stream: connection.get_input_stream(),
        close_base_stream: true,
      })

      const replyLine = await readLineUtf8Async(stream)
      if (replyLine === null) throw new Error("niri event stream closed before reply")

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

    if (reconnectId !== 0) {
      GLib.source_remove(reconnectId)
      reconnectId = 0
    }

    closeNiriConnection(connection, stream)
    connection = null
    stream = null
  }
}

export function WorkspaceIndicator({ monitor }: { monitor: number }) {
  const [items, setItems] = createState<WorkspaceChip[]>([])
  const [visible, setVisible] = createState(false)

  return (
    <box
      class="section section-center workspace-indicator-shell"
      spacing={0}
      valign={Gtk.Align.CENTER}
      visible={visible}
      $={(self) => {
        let cleanup: (() => void) | undefined
        let destroyed = false

        const start = async () => {
          try {
            if (GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")) {
              cleanup = await initializeHyprland(monitor, setItems, setVisible)
              if (destroyed) cleanup?.()
              return
            }

            if (GLib.getenv("NIRI_SOCKET")) {
              cleanup = await initializeNiri(monitor, setItems, setVisible)
              if (destroyed) cleanup?.()
              return
            }
          } catch (error) {
            console.error(error)
            setItems([])
            setVisible(false)
          }
        }

        void start().catch(console.error)

        self.connect("destroy", () => {
          destroyed = true
          try {
            cleanup?.()
          } catch (error) {
            console.error(error)
          }
        })
      }}
    >
      <box class="workspace-indicator" spacing={6} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER}>
        <For each={items}>
          {(item) => (
            <button
              class={item.className}
              tooltipText={item.tooltip}
              valign={Gtk.Align.CENTER}
              onClicked={item.onActivate}
            >
              <box class={item.coreClassName} valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER} />
            </button>
          )}
        </For>
      </box>
    </box>
  )
}
