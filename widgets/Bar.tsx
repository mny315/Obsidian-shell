import Gio from "gi://Gio"
import GLib from "gi://GLib"

import { idle } from "ags/time"
import { Astal } from "ags/gtk4"

import Gtk from "gi://Gtk?version=4.0"
import Gtk4LayerShell from "gi://Gtk4LayerShell?version=1.0"
import Gdk from "gi://Gdk?version=4.0"
import Cairo from "cairo"

import { LeftModules } from "./LeftModules"
import { Tray } from "./Tray"
import { CenterModules } from "./CenterModules"
import { RightModules } from "./RightModules"
import { clipRoundedWidget } from "./FloatingPopup"

const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
const FULLSCREEN_SIZE_TOLERANCE = 3
const BAR_ANIMATION_MS = 260
const BAR_VISIBLE_TOP_MARGIN = 4
const BAR_FALLBACK_HEIGHT = 40
const BAR_HIDE_EXTRA_PX = 3

type NiriWorkspace = {
  id: number
  output: string | null
  is_active: boolean
  is_focused: boolean
  active_window_id: number | null
}

type NiriWindowLayout = {
  tile_size: [number, number]
}

type NiriWindow = {
  id: number
  workspace_id: number | null
  is_focused: boolean
  layout: NiriWindowLayout
}

function compactText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
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

function monitorInfo(index: number) {
  try {
    const display = Gdk.Display.get_default()
    const monitors = display?.get_monitors()
    const monitor = monitors?.get_item(index) as (Gdk.Monitor & Record<string, unknown>) | null
    if (!monitor) return null

    const dynamicMonitor = monitor as Record<string, unknown> & {
      get_connector?: () => string | null
      get_model?: () => string | null
    }
    const geometry = monitor.get_geometry()
    const names = [
      typeof dynamicMonitor.get_connector === "function" ? dynamicMonitor.get_connector() : null,
      typeof dynamicMonitor.connector === "string" ? dynamicMonitor.connector : null,
      typeof dynamicMonitor.get_model === "function" ? dynamicMonitor.get_model() : null,
      typeof dynamicMonitor.model === "string" ? dynamicMonitor.model : null,
    ]

    return {
      output: names.map(compactText).find(Boolean) ?? null,
      width: Number(geometry.width),
      height: Number(geometry.height),
      monitorCount: Number(monitors?.get_n_items() ?? 1),
    }
  } catch (error) {
    console.error(error)
    return null
  }
}

function normalizePair(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null
  const first = Number(raw[0])
  const second = Number(raw[1])
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null
  return [first, second]
}

function normalizeNiriWorkspace(raw: unknown): NiriWorkspace | null {
  if (!raw || typeof raw !== "object") return null
  const workspace = raw as Record<string, unknown>
  const id = Number(workspace.id)
  if (!Number.isFinite(id)) return null

  const activeWindowId = workspace.active_window_id == null ? null : Number(workspace.active_window_id)
  return {
    id,
    output: compactText(workspace.output) || null,
    is_active: Boolean(workspace.is_active),
    is_focused: Boolean(workspace.is_focused),
    active_window_id: activeWindowId !== null && Number.isFinite(activeWindowId) ? activeWindowId : null,
  }
}

function normalizeNiriLayout(raw: unknown): NiriWindowLayout | null {
  if (!raw || typeof raw !== "object") return null
  const layout = raw as Record<string, unknown>
  const tileSize = normalizePair(layout.tile_size)
  if (!tileSize) return null
  return { tile_size: tileSize }
}

function normalizeNiriWindow(raw: unknown): NiriWindow | null {
  if (!raw || typeof raw !== "object") return null
  const window = raw as Record<string, unknown>
  const id = Number(window.id)
  const layout = normalizeNiriLayout(window.layout)
  if (!Number.isFinite(id) || !layout) return null

  const workspaceId = window.workspace_id == null ? null : Number(window.workspace_id)
  return {
    id,
    workspace_id: workspaceId !== null && Number.isFinite(workspaceId) ? workspaceId : null,
    is_focused: Boolean(window.is_focused),
    layout,
  }
}

function windowFillsMonitor(window: NiriWindow, width: number, height: number) {
  const [tileWidth, tileHeight] = window.layout.tile_size
  return (
    Math.abs(tileWidth - width) <= FULLSCREEN_SIZE_TOLERANCE &&
    Math.abs(tileHeight - height) <= FULLSCREEN_SIZE_TOLERANCE
  )
}

async function initializeNiriFullscreenWatcher(monitor: number, onChanged: (fullscreen: boolean) => void) {
  const socketPath = compactText(GLib.getenv("NIRI_SOCKET"))
  if (!socketPath) {
    onChanged(false)
    return () => {}
  }

  let stopped = false
  let reconnectId = 0
  let connection: Gio.SocketConnection | null = null
  let stream: Gio.DataInputStream | null = null
  let knownWorkspaces: NiriWorkspace[] = []
  const knownWindows = new Map<number, NiriWindow>()
  let lastFullscreen: boolean | null = null

  const sync = () => {
    const info = monitorInfo(monitor)
    if (!info || info.width <= 0 || info.height <= 0) {
      if (lastFullscreen !== false) {
        lastFullscreen = false
        onChanged(false)
      }
      return
    }

    let candidates = info.output
      ? knownWorkspaces.filter((workspace) => workspace.output === info.output)
      : []

    if (candidates.length === 0 && info.monitorCount <= 1) {
      candidates = knownWorkspaces
    }

    const workspace =
      candidates.find((item) => item.is_active) ??
      candidates.find((item) => item.is_focused) ??
      null

    let activeWindow = workspace?.active_window_id == null
      ? null
      : knownWindows.get(workspace.active_window_id) ?? null

    if (!activeWindow && workspace) {
      activeWindow = [...knownWindows.values()].find((window) =>
        window.workspace_id === workspace.id && window.is_focused
      ) ?? null
    }

    const fullscreen = Boolean(
      activeWindow && windowFillsMonitor(activeWindow, info.width, info.height)
    )

    if (lastFullscreen !== fullscreen) {
      lastFullscreen = fullscreen
      onChanged(fullscreen)
    }
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
        .map(normalizeNiriWorkspace)
        .filter((workspace): workspace is NiriWorkspace => workspace !== null)
      sync()
      return
    }

    const activated = event.WorkspaceActivated as { id?: unknown; focused?: unknown } | undefined
    if (activated && Number.isFinite(Number(activated.id))) {
      const target = knownWorkspaces.find((workspace) => workspace.id === Number(activated.id))
      if (target) {
        for (const workspace of knownWorkspaces) {
          if (target.output && workspace.output === target.output) workspace.is_active = false
          if (Boolean(activated.focused)) workspace.is_focused = false
        }
        target.is_active = true
        target.is_focused = Boolean(activated.focused)
        sync()
      }
      return
    }

    const activeWindowChanged = event.WorkspaceActiveWindowChanged as {
      workspace_id?: unknown
      active_window_id?: unknown
    } | undefined
    if (activeWindowChanged && Number.isFinite(Number(activeWindowChanged.workspace_id))) {
      const workspace = knownWorkspaces.find(
        (item) => item.id === Number(activeWindowChanged.workspace_id)
      )
      if (workspace) {
        const id = activeWindowChanged.active_window_id == null
          ? null
          : Number(activeWindowChanged.active_window_id)
        workspace.active_window_id = id !== null && Number.isFinite(id) ? id : null
        sync()
      }
      return
    }

    const windowsChanged = (event.WindowsChanged as { windows?: unknown } | undefined)?.windows
    if (Array.isArray(windowsChanged)) {
      knownWindows.clear()
      for (const rawWindow of windowsChanged) {
        const window = normalizeNiriWindow(rawWindow)
        if (window) knownWindows.set(window.id, window)
      }
      sync()
      return
    }

    const openedOrChanged = (event.WindowOpenedOrChanged as { window?: unknown } | undefined)?.window
    if (openedOrChanged) {
      const window = normalizeNiriWindow(openedOrChanged)
      if (window) {
        if (window.is_focused) {
          for (const candidate of knownWindows.values()) candidate.is_focused = false
        }
        knownWindows.set(window.id, window)
        sync()
      }
      return
    }

    const closed = event.WindowClosed as { id?: unknown } | undefined
    if (closed && Number.isFinite(Number(closed.id))) {
      const id = Number(closed.id)
      knownWindows.delete(id)
      for (const workspace of knownWorkspaces) {
        if (workspace.active_window_id === id) workspace.active_window_id = null
      }
      sync()
      return
    }

    const focusChanged = event.WindowFocusChanged as { id?: unknown } | undefined
    if (focusChanged) {
      const focusedId = focusChanged.id == null ? null : Number(focusChanged.id)
      for (const window of knownWindows.values()) {
        window.is_focused = focusedId !== null && Number.isFinite(focusedId) && window.id === focusedId
      }
      sync()
      return
    }

    const layoutChanges = (event.WindowLayoutsChanged as { changes?: unknown } | undefined)?.changes
    if (Array.isArray(layoutChanges)) {
      for (const change of layoutChanges) {
        if (!Array.isArray(change) || change.length < 2) continue
        const id = Number(change[0])
        const layout = normalizeNiriLayout(change[1])
        const window = knownWindows.get(id)
        if (window && layout) window.layout = layout
      }
      sync()
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

export function Bar({ monitor }: { monitor: number }) {
  let barHoverHandlers = {
    onEnter: () => {},
    onLeave: () => {},
  }
  let barShell: Gtk.Widget | null = null
  let barWindow: Gtk.Window | null = null
  const emptyInputRegion = new Cairo.Region()
  let inputEnabled = true
  let closing = false
  let closeTimeoutId = 0
  let animationSourceId = 0
  let animationWidget: Gtk.Widget | null = null
  let currentTopMargin = BAR_VISIBLE_TOP_MARGIN
  let fullscreen = false
  let visibilityInitialized = false
  let cleanupNiri: (() => void) | undefined
  let destroyed = false

  const removeSource = (id: number) => {
    if (id === 0) return
    try {
      GLib.source_remove(id)
    } catch {}
  }

  const cancelAnimation = () => {
    if (animationSourceId !== 0) {
      try {
        animationWidget?.remove_tick_callback(animationSourceId)
      } catch {}
    }
    animationSourceId = 0
    animationWidget = null
  }

  const applyInputRegion = () => {
    try {
      const surface = barWindow?.get_surface()
      if (!surface) return
      surface.set_input_region(inputEnabled ? null : emptyInputRegion)
    } catch (error) {
      console.error(error)
    }
  }

  const setInputEnabled = (enabled: boolean) => {
    inputEnabled = enabled
    applyInputRegion()
  }

  const setLayerMargin = (edge: number, value: number) => {
    if (!barWindow) return
    const rounded = Math.round(value)

    try {
      Gtk4LayerShell.set_margin(barWindow, edge, rounded)
      return
    } catch (error) {
      // Astal normally ships with gtk4-layer-shell. Keep a GTK fallback so
      // a missing GI binding does not leave the bar permanently misplaced.
      console.error(error)
    }

    try {
      if (edge === Gtk4LayerShell.Edge.TOP) barWindow.set_margin_top(rounded)
      else if (edge === Gtk4LayerShell.Edge.LEFT) barWindow.set_margin_left(rounded)
      else if (edge === Gtk4LayerShell.Edge.RIGHT) barWindow.set_margin_right(rounded)
      else if (edge === Gtk4LayerShell.Edge.BOTTOM) barWindow.set_margin_bottom(rounded)
    } catch (error) {
      console.error(error)
    }
  }

  const setTopMargin = (value: number) => {
    currentTopMargin = value
    setLayerMargin(Gtk4LayerShell.Edge.TOP, value)
  }

  const hiddenTopMargin = () => {
    let height = BAR_FALLBACK_HEIGHT
    try {
      height = Math.max(height, Number(barShell?.get_allocated_height() ?? 0))
    } catch {}
    return -(height + BAR_HIDE_EXTRA_PX)
  }

  const easeOutCubic = (progress: number) => 1 - Math.pow(1 - progress, 3)

  const animateSurfaceTo = (targetMargin: number, enableInputWhenDone: boolean) => {
    if (!barWindow) return

    cancelAnimation()
    const fromMargin = currentTopMargin

    if (Math.abs(targetMargin - fromMargin) < 0.5) {
      setTopMargin(targetMargin)
      if (enableInputWhenDone && !fullscreen) {
        setInputEnabled(true)
      }
      return
    }

    // Initialize the animation timestamp inside the first tick. Reading
    // get_frame_time() before the callback can return the last frame from
    // before the bar went off-screen, making the entrance jump to 100%.
    let startedAtUs: number | null = null
    animationWidget = barWindow
    animationSourceId = barWindow.add_tick_callback((_widget, frameClock) => {
      if (destroyed || !barWindow) {
        animationSourceId = 0
        animationWidget = null
        return false
      }

      const frameTimeUs = frameClock.get_frame_time()
      if (startedAtUs === null) startedAtUs = frameTimeUs

      const elapsedMs = Math.max(0, (frameTimeUs - startedAtUs) / 1000)
      const progress = Math.min(1, elapsedMs / BAR_ANIMATION_MS)
      const eased = easeOutCubic(progress)
      setTopMargin(fromMargin + (targetMargin - fromMargin) * eased)

      // Tick callbacks schedule frame updates but do not guarantee a repaint.
      // Queue one so every layer-shell margin update is committed promptly.
      barWindow.queue_draw()

      if (progress < 1) return true

      animationSourceId = 0
      animationWidget = null
      setTopMargin(targetMargin)

      if (enableInputWhenDone && !fullscreen) {
        setInputEnabled(true)
      }
      return false
    })
  }

  const showBar = () => {
    if (!barWindow) return

    cancelAnimation()
    setInputEnabled(false)

    // The layer surface stays mapped while hidden, so entrance animation can
    // always start immediately from its current off-screen margin.
    animateSurfaceTo(BAR_VISIBLE_TOP_MARGIN, true)
  }

  const hideBar = () => {
    if (!barWindow) return

    setInputEnabled(false)

    // Keep the layer surface mapped and move it fully above the output.
    // Unmapping/remapping occasionally lets the compositor present the bar
    // only after the entrance animation has already completed.
    animateSurfaceTo(hiddenTopMargin(), false)
  }

  const applyVisibility = () => {
    if (!barWindow) return

    if (!visibilityInitialized) {
      visibilityInitialized = true

      // The window is mapped off-screen from its very first frame. Recalculate
      // the hidden margin after layout, then use the regular fullscreen exit
      // path so startup and normal entrance animations stay identical.
      setInputEnabled(false)
      setTopMargin(hiddenTopMargin())

      if (!fullscreen) showBar()
      return
    }

    if (fullscreen) hideBar()
    else showBar()
  }

  const startNiriWatcher = async () => {
    cleanupNiri = await initializeNiriFullscreenWatcher(monitor, (value) => {
      fullscreen = value
      applyVisibility()
    })
    if (destroyed) cleanupNiri?.()
  }

  return (
    <window
      visible
      monitor={monitor}
      namespace="obsidian-shell-bar"
      class="bar-window"
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={TOP | LEFT | RIGHT}
      $={(self) => {
        barWindow = self as Gtk.Window

        // Keep the bar outside the output before GTK presents its first frame.
        // BAR_FALLBACK_HEIGHT is used here because the child is not allocated yet;
        // applyVisibility() corrects the margin once the real height is known.
        setTopMargin(-(BAR_FALLBACK_HEIGHT + BAR_HIDE_EXTRA_PX))
        setInputEnabled(false)
        setLayerMargin(Gtk4LayerShell.Edge.LEFT, 9)
        setLayerMargin(Gtk4LayerShell.Edge.RIGHT, 9)
        setLayerMargin(Gtk4LayerShell.Edge.BOTTOM, 0)

        idle(() => {
          applyInputRegion()
          applyVisibility()
          void startNiriWatcher().catch(console.error)
        })

        self.connect("destroy", () => {
          destroyed = true
          barWindow = null
          cancelAnimation()
          removeSource(closeTimeoutId)
          closeTimeoutId = 0
          try {
            cleanupNiri?.()
          } catch (error) {
            console.error(error)
          }
        })

        self.connect("close-request", () => {
          if (closing) return false

          closing = true
          cancelAnimation()
          setInputEnabled(false)
          animateSurfaceTo(hiddenTopMargin(), false)

          closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_ANIMATION_MS, () => {
            closeTimeoutId = 0
            self.close()
            return GLib.SOURCE_REMOVE
          })
          return true
        })
      }}
    >
      <box class="bar-motion-wrap" hexpand>
        <centerbox
          class="bar-shell"
          hexpand
          $={(self) => {
            barShell = self
            clipRoundedWidget(self)
          }}
        >
          <Gtk.EventControllerMotion
            onEnter={() => barHoverHandlers.onEnter()}
            onLeave={() => barHoverHandlers.onLeave()}
          />

          <box class="bar-start" $type="start" valign={Gtk.Align.CENTER}>
            <LeftModules monitor={monitor} />
          </box>

          <box class="bar-center" hexpand $type="center" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
            <CenterModules monitor={monitor} />
          </box>

          <box
            $type="end"
            class="bar-end right-side-wrap"
            spacing={0}
            hexpand={false}
            halign={Gtk.Align.END}
            valign={Gtk.Align.CENTER}
          >
            <Tray />
            <RightModules monitor={monitor} bindBarHoverHandlers={(handlers) => (barHoverHandlers = handlers)} />
          </box>
        </centerbox>
      </box>
    </window>
  )
}
