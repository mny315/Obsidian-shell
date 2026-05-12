import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { Astal } from "ags/gtk4"

const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

export const RIGHT_TOP_POPUP_ANCHOR = TOP | RIGHT
export const LEFT_TOP_POPUP_ANCHOR = TOP | LEFT
export const DEFAULT_POPUP_X = 12
export const DEFAULT_POPUP_Y = 53
export const TOP_BAR_POPUP_MARGIN_TOP = DEFAULT_POPUP_Y
export const POPUP_SCREEN_RIGHT = 15
const SCREEN_PADDING = 12

export type PopupAlign = "start" | "center" | "end"

type PopupPlacementOptions = {
  offsetX?: number
  offsetY?: number
  align?: PopupAlign
}

function toNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
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

type LayerWindowMargins = {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

function setLayerWindowMargin(window: unknown, edge: keyof LayerWindowMargins, value: number) {
  const layerWindow = window as Record<string, unknown> | null
  if (!layerWindow) return

  const margin = Math.max(0, Math.round(value))
  const property = `margin_${edge}`
  const setter = `set_margin_${edge}`

  try {
    const method = layerWindow[setter]
    if (typeof method === "function") {
      ;(method as (value: number) => void).call(layerWindow, margin)
      return
    }
  } catch {}

  try {
    layerWindow[property] = margin
  } catch {}
}

export function setLayerWindowMargins(window: unknown, margins: LayerWindowMargins) {
  if (typeof margins.top === "number") setLayerWindowMargin(window, "top", margins.top)
  if (typeof margins.right === "number") setLayerWindowMargin(window, "right", margins.right)
  if (typeof margins.bottom === "number") setLayerWindowMargin(window, "bottom", margins.bottom)
  if (typeof margins.left === "number") setLayerWindowMargin(window, "left", margins.left)
}

export function clipRoundedWidget(widget: Gtk.Widget | null) {
  if (!widget) return

  try {
    widget.set_overflow(Gtk.Overflow.HIDDEN)
  } catch {}
}

export function attachPopupFocusDismiss(widget: Gtk.Widget, onClose: () => void) {
  const controller = new Gtk.EventControllerFocus()
  let armed = false
  let disposed = false

  controller.connect("leave", () => {
    if (!armed || disposed) return
    onClose()
  })

  widget.add_controller(controller)

  try {
    widget.connect("destroy", () => {
      disposed = true
    })
  } catch {}

  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (disposed) return GLib.SOURCE_REMOVE
    try {
      widget.grab_focus()
    } catch {}
    armed = true
    return GLib.SOURCE_REMOVE
  })
}

export type TopEdgePlacementOptions = {
  top?: number
  right?: number
  left?: number
  align?: PopupAlign
}

export function placeLayerWindowAtTopEdge(
  trigger: Gtk.Widget | null,
  layerWindow: unknown,
  popup: Gtk.Widget | null,
  options: TopEdgePlacementOptions = {},
) {
  if (!layerWindow) return

  const align = options.align ?? "end"
  const top = options.top ?? TOP_BAR_POPUP_MARGIN_TOP
  const popupWidth = measureNaturalWidth(popup)
  let rootWidth = 0

  try {
    const root = trigger?.get_root?.() as Gtk.Widget | null
    rootWidth = toNumber(root?.get_width?.(), 0) || toNumber((root as any)?.get_allocated_width?.(), 0)
  } catch {}

  let left = options.left ?? DEFAULT_POPUP_X

  if (rootWidth > 0 && popupWidth > 0) {
    if (align === "end") {
      const right = options.right ?? POPUP_SCREEN_RIGHT
      left = rootWidth - popupWidth - right
    }
    else if (align === "center") {
      left = Math.floor((rootWidth - popupWidth) / 2)
    }
  }

  setLayerWindowMargins(layerWindow, {
    left: Math.max(0, left),
    top: Math.max(0, top),
  })
}

export type TopRightPlacementOptions = {
  top?: number
  right?: number
}

export function placeLayerWindowAtTopRight(
  layerWindow: unknown,
  options: TopRightPlacementOptions = {},
) {
  if (!layerWindow) return

  setLayerWindowMargins(layerWindow, {
    top: options.top ?? TOP_BAR_POPUP_MARGIN_TOP,
    right: options.right ?? POPUP_SCREEN_RIGHT,
  })
}

export function placeLayerWindowFromTrigger(
  trigger: Gtk.Widget | null,
  layerWindow: unknown,
  popup: Gtk.Widget | null,
  options: PopupPlacementOptions = {},
) {
  if (!layerWindow) return

  const offsetX = options.offsetX ?? 0
  const offsetY = options.offsetY ?? 0
  const align = options.align ?? "center"

  let x = DEFAULT_POPUP_X + offsetX
  let y = DEFAULT_POPUP_Y + offsetY

  try {
    const root = trigger?.get_root?.() as Gtk.Widget | null
    const result = trigger && root && typeof (trigger as any).compute_bounds === "function"
      ? (trigger as any).compute_bounds(root)
      : null

    const ok = Array.isArray(result) ? Boolean(result[0]) : false
    const rect = Array.isArray(result) ? result[1] : null

    if (ok && rect) {
      const left = toNumber(rect?.origin?.x ?? rect?.x)
      const top = toNumber(rect?.origin?.y ?? rect?.y)
      const width = toNumber(rect?.size?.width ?? rect?.width ?? trigger?.get_width?.())
      const height = toNumber(rect?.size?.height ?? rect?.height ?? trigger?.get_height?.())
      const popupWidth = measureNaturalWidth(popup)
      const rootWidth = toNumber(root?.get_width?.(), 0) || toNumber((root as any)?.get_allocated_width?.(), 0)

      if (align === "start") x = Math.round(left + offsetX)
      else if (align === "end") x = Math.round(left + width - popupWidth + offsetX)
      else x = Math.round(left + Math.floor((width - popupWidth) / 2) + offsetX)

      y = Math.round(top + height + offsetY)

      if (rootWidth > 0 && popupWidth > 0) {
        const minX = SCREEN_PADDING
        const maxX = Math.max(SCREEN_PADDING, rootWidth - popupWidth - SCREEN_PADDING)
        x = Math.min(Math.max(x, minX), maxX)
      }
    }
  } catch (error) {
    console.error(error)
  }

  setLayerWindowMargins(layerWindow, { left: x, top: y })
}

