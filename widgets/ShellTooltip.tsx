import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"

import { createComputed, createState } from "ags"
import { Astal } from "ags/gtk4"

import { clipRoundedWidget, setLayerWindowMargins } from "./FloatingPopup"

const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

const TOOLTIP_SHOW_DELAY_MS = 420
const TOOLTIP_HIDE_DELAY_MS = 80
const TOOLTIP_GAP = 8
const SCREEN_PADDING = 12

type TooltipSource = string | null | undefined | (() => string | null | undefined)

type TooltipOptions = {
  markup?: boolean
  offsetY?: number
}

const [tooltipVisible, setTooltipVisible] = createState(false)
const [tooltipMonitor, setTooltipMonitor] = createState(0)
const [tooltipText, setTooltipText] = createState("")
const [tooltipUsesMarkup, setTooltipUsesMarkup] = createState(false)

const tooltipWindows = new Map<number, unknown>()
let tooltipFrame: Gtk.Widget | null = null
let activeTarget: Gtk.Widget | null = null
let showSourceId = 0
let hideSourceId = 0
let placementSourceId = 0
let activeSerial = 0

const sourceByWidget = new WeakMap<Gtk.Widget, TooltipSource>()
const optionsByWidget = new WeakMap<Gtk.Widget, TooltipOptions>()

function clearSource(id: number) {
  if (id === 0) return 0

  try {
    GLib.source_remove(id)
  } catch {}

  return 0
}

function resolveTooltip(source: TooltipSource) {
  try {
    const value = typeof source === "function" ? source() : source
    return String(value ?? "").trim()
  } catch (error) {
    console.error(error)
    return ""
  }
}

function toNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function readMethodNumber(object: unknown, methodName: string, fallback = 0) {
  try {
    const method = (object as Record<string, unknown> | null)?.[methodName]
    if (typeof method === "function") return toNumber((method as () => unknown).call(object), fallback)
  } catch {}

  return fallback
}

function readPropertyNumber(object: unknown, propertyName: string, fallback = 0) {
  try {
    return toNumber((object as Record<string, unknown> | null)?.[propertyName], fallback)
  } catch {
    return fallback
  }
}

function readLayerNumber(object: unknown, propertyName: string, getterName: string, fallback = 0) {
  const getter = readMethodNumber(object, getterName, Number.NaN)
  if (Number.isFinite(getter)) return getter
  return readPropertyNumber(object, propertyName, fallback)
}

function measureNaturalWidth(widget: Gtk.Widget | null) {
  if (!widget) return 0

  try {
    const measured = typeof (widget as any).measure === "function"
      ? (widget as any).measure(Gtk.Orientation.HORIZONTAL, -1)
      : null

    if (Array.isArray(measured)) {
      return toNumber(measured[1], 0) || toNumber(measured[0], 0)
    }
  } catch {}

  try {
    return toNumber((widget as any).get_width?.(), 0)
      || toNumber((widget as any).get_allocated_width?.(), 0)
  } catch {
    return 0
  }
}

function measureNaturalHeight(widget: Gtk.Widget | null) {
  if (!widget) return 0

  try {
    const measured = typeof (widget as any).measure === "function"
      ? (widget as any).measure(Gtk.Orientation.VERTICAL, -1)
      : null

    if (Array.isArray(measured)) {
      return toNumber(measured[1], 0) || toNumber(measured[0], 0)
    }
  } catch {}

  try {
    return toNumber((widget as any).get_height?.(), 0)
      || toNumber((widget as any).get_allocated_height?.(), 0)
  } catch {
    return 0
  }
}

function monitorGeometry(index: number) {
  const display = Gdk.Display.get_default()
  const monitors = display?.get_monitors?.()
  const monitor = monitors?.get_item?.(Math.max(0, index)) as Gdk.Monitor | null
  const geometry = monitor?.get_geometry?.()

  return {
    x: toNumber(geometry?.x, 0),
    y: toNumber(geometry?.y, 0),
    width: toNumber(geometry?.width, 0),
    height: toNumber(geometry?.height, 0),
  }
}

function readRootMonitor(root: Gtk.Widget | null) {
  const value = readLayerNumber(root, "monitor", "get_monitor", Number.NaN)
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function readRootOffset(root: Gtk.Widget | null, monitor: number) {
  const geometry = monitorGeometry(monitor)
  const rootWidth = toNumber((root as any)?.get_width?.(), 0)
    || toNumber((root as any)?.get_allocated_width?.(), 0)
  const rootHeight = toNumber((root as any)?.get_height?.(), 0)
    || toNumber((root as any)?.get_allocated_height?.(), 0)

  const marginLeft = readLayerNumber(root, "margin_left", "get_margin_left", 0)
  const marginRight = readLayerNumber(root, "margin_right", "get_margin_right", 0)
  const marginTop = readLayerNumber(root, "margin_top", "get_margin_top", 0)
  const marginBottom = readLayerNumber(root, "margin_bottom", "get_margin_bottom", 0)
  const anchor = readLayerNumber(root, "anchor", "get_anchor", TOP | LEFT)

  const anchoredLeft = (anchor & LEFT) !== 0
  const anchoredRight = (anchor & RIGHT) !== 0
  const anchoredTop = (anchor & TOP) !== 0
  const anchoredBottom = (anchor & BOTTOM) !== 0

  let x = geometry.x + marginLeft
  let y = geometry.y + marginTop

  if (anchoredRight && !anchoredLeft && geometry.width > 0 && rootWidth > 0) {
    x = geometry.x + geometry.width - rootWidth - marginRight
  }

  if (anchoredBottom && !anchoredTop && geometry.height > 0 && rootHeight > 0) {
    y = geometry.y + geometry.height - rootHeight - marginBottom
  }

  return { x, y, geometry }
}

function widgetHasCssClass(widget: Gtk.Widget | null, cssClass: string) {
  try {
    return Boolean(widget && typeof (widget as any).has_css_class === "function" && (widget as any).has_css_class(cssClass))
  } catch {
    return false
  }
}

function widgetOrParentHasCssClass(widget: Gtk.Widget | null, cssClasses: string[]) {
  let current: Gtk.Widget | null = widget

  for (let depth = 0; current && depth < 16; depth += 1) {
    for (const cssClass of cssClasses) {
      if (widgetHasCssClass(current, cssClass)) return true
    }

    try {
      current = current.get_parent?.() as Gtk.Widget | null
    } catch {
      current = null
    }
  }

  return false
}

function implicitTooltipOffsetY(target: Gtk.Widget) {
  if (widgetOrParentHasCssClass(target, [
    "workspace-indicator-shell",
    "workspace-indicator",
    "workspace-chip",
  ])) return 6

  if (widgetOrParentHasCssClass(target, [
    "tray-capsule",
    "tray-item",
  ])) return -1

  if (widgetOrParentHasCssClass(target, [
    "right-side-wrap",
    "bar-end",
    "section-right-main",
    "controls-shell",
  ])) return 2

  return 0
}

function placeTooltip(target: Gtk.Widget | null) {
  if (!target) return

  try {
    const root = target.get_root?.() as Gtk.Widget | null
    const result = root && typeof (target as any).compute_bounds === "function"
      ? (target as any).compute_bounds(root)
      : null

    const ok = Array.isArray(result) ? Boolean(result[0]) : false
    const rect = Array.isArray(result) ? result[1] : null
    if (!ok || !rect) return

    const monitor = readRootMonitor(root)
    const layerWindow = tooltipWindows.get(monitor)
    if (!layerWindow) return

    const { x: rootX, y: rootY, geometry } = readRootOffset(root, monitor)
    const targetX = rootX + toNumber(rect?.origin?.x ?? rect?.x, 0)
    const targetY = rootY + toNumber(rect?.origin?.y ?? rect?.y, 0)
    const targetWidth = toNumber(rect?.size?.width ?? rect?.width ?? target.get_width?.(), 0)
    const targetHeight = toNumber(rect?.size?.height ?? rect?.height ?? target.get_height?.(), 0)

    const tooltipWidth = Math.max(1, measureNaturalWidth(tooltipFrame))
    const tooltipHeight = Math.max(1, measureNaturalHeight(tooltipFrame))
    const monitorWidth = geometry.width > 0 ? geometry.width : readMethodNumber(root, "get_width", tooltipWidth + SCREEN_PADDING * 2)
    const monitorHeight = geometry.height > 0 ? geometry.height : readMethodNumber(root, "get_height", tooltipHeight + SCREEN_PADDING * 2)

    let left = Math.round(targetX - geometry.x + Math.floor((targetWidth - tooltipWidth) / 2))
    const options = optionsByWidget.get(target) ?? {}
    const offsetY = Math.round(toNumber(options.offsetY, 0) + implicitTooltipOffsetY(target))

    let top = Math.round(targetY - geometry.y + targetHeight + TOOLTIP_GAP + offsetY)

    left = Math.min(Math.max(left, SCREEN_PADDING), Math.max(SCREEN_PADDING, monitorWidth - tooltipWidth - SCREEN_PADDING))
    top = Math.min(Math.max(top, SCREEN_PADDING), Math.max(SCREEN_PADDING, monitorHeight - tooltipHeight - SCREEN_PADDING))

    setTooltipMonitor(monitor)
    setLayerWindowMargins(layerWindow, { left, top })
  } catch (error) {
    console.error(error)
  }
}

function queuePlacement(target: Gtk.Widget | null) {
  placementSourceId = clearSource(placementSourceId)
  placeTooltip(target)
  placementSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    placementSourceId = 0
    placeTooltip(target)
    return GLib.SOURCE_REMOVE
  })
}

function hideTooltip(target?: Gtk.Widget | null) {
  if (target && activeTarget && target !== activeTarget) return

  activeSerial += 1
  activeTarget = null
  showSourceId = clearSource(showSourceId)
  placementSourceId = clearSource(placementSourceId)

  hideSourceId = clearSource(hideSourceId)
  hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_HIDE_DELAY_MS, () => {
    hideSourceId = 0
    setTooltipVisible(false)
    return GLib.SOURCE_REMOVE
  })
}

function showTooltip(target: Gtk.Widget, source: TooltipSource, options: TooltipOptions) {
  const text = resolveTooltip(source)
  if (!text) {
    hideTooltip(target)
    return
  }

  hideSourceId = clearSource(hideSourceId)
  activeTarget = target
  setTooltipText(text)
  setTooltipUsesMarkup(Boolean(options.markup))
  queuePlacement(target)
  setTooltipVisible(true)
}

function scheduleTooltip(target: Gtk.Widget) {
  const source = sourceByWidget.get(target)
  const options = optionsByWidget.get(target) ?? {}
  if (!source) return

  activeSerial += 1
  const serial = activeSerial
  showSourceId = clearSource(showSourceId)
  hideSourceId = clearSource(hideSourceId)

  showSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
    showSourceId = 0
    if (serial !== activeSerial) return GLib.SOURCE_REMOVE
    showTooltip(target, source, options)
    return GLib.SOURCE_REMOVE
  })
}

export function attachShellTooltip(widget: Gtk.Widget, source: TooltipSource, options: TooltipOptions = {}) {
  sourceByWidget.set(widget, source)
  optionsByWidget.set(widget, options)

  try {
    widget.set_tooltip_text(null)
    widget.set_tooltip_markup(null)
    widget.set_has_tooltip(false)
  } catch {}

  const motion = new Gtk.EventControllerMotion()
  motion.connect("enter", () => scheduleTooltip(widget))
  motion.connect("leave", () => hideTooltip(widget))
  widget.add_controller(motion)

  const focus = new Gtk.EventControllerFocus()
  focus.connect("leave", () => hideTooltip(widget))
  widget.add_controller(focus)

  widget.connect("destroy", () => {
    sourceByWidget.delete(widget)
    optionsByWidget.delete(widget)
    hideTooltip(widget)
  })
}

export function ShellTooltipWindow({ monitor }: { monitor: number }) {
  const visibleForMonitor = createComputed(() => tooltipVisible() && tooltipMonitor() === monitor)

  return (
    <window
      visible={visibleForMonitor}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-tooltip"
      class="widget-popup-window shell-tooltip-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.NONE}
      layer={Astal.Layer.OVERLAY}
      anchor={TOP | LEFT}
      $={(self) => {
        tooltipWindows.set(monitor, self)
        self.connect("destroy", () => {
          tooltipWindows.delete(monitor)
          tooltipFrame = null
          activeTarget = null
          showSourceId = clearSource(showSourceId)
          hideSourceId = clearSource(hideSourceId)
          placementSourceId = clearSource(placementSourceId)
        })
      }}
    >
      <box class="widget-popup-frame shell-tooltip-frame" $={(self) => {
        tooltipFrame = self
        clipRoundedWidget(self)
      }}>
        <label class="shell-tooltip-label" label={tooltipText} useMarkup={tooltipUsesMarkup} xalign={0} justify={Gtk.Justification.LEFT} />
      </box>
    </window>
  )
}
