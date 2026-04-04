import Gtk from "gi://Gtk?version=4.0"
import { Astal } from "ags/gtk4"

const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

export const FLOATING_POPUP_ANCHOR = TOP | LEFT | RIGHT | BOTTOM
export const DEFAULT_POPUP_X = 12
export const DEFAULT_POPUP_Y = 53
export const TOP_BAR_POPUP_MARGIN_TOP = DEFAULT_POPUP_Y + 20
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

function measureRootWidth(widget: Gtk.Widget | null) {
  try {
    const root = widget?.get_root?.() as Gtk.Widget | null
    return toNumber(root?.get_width?.(), 0) || toNumber((root as any)?.get_allocated_width?.(), 0)
  } catch {
    return 0
  }
}

export function placePopupFromTrigger(
  trigger: Gtk.Widget | null,
  placement: Gtk.Widget | null,
  popup: Gtk.Widget | null,
  options: PopupPlacementOptions = {},
) {
  if (!placement) return

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
      const rootWidth = measureRootWidth(placement)

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

  placement.set_margin_start(Math.max(0, x))
  placement.set_margin_top(Math.max(0, y))
}


export function isPointInsideWidget(
  widget: Gtk.Widget | null,
  root: Gtk.Widget | null,
  x: number,
  y: number,
) {
  if (!widget || !root) return false

  try {
    const result = typeof (widget as any).compute_bounds === "function"
      ? (widget as any).compute_bounds(root)
      : null

    const ok = Array.isArray(result) ? Boolean(result[0]) : false
    const rect = Array.isArray(result) ? result[1] : null
    if (!ok || !rect) return false

    const left = toNumber(rect?.origin?.x ?? rect?.x)
    const top = toNumber(rect?.origin?.y ?? rect?.y)
    const width = toNumber(rect?.size?.width ?? rect?.width ?? widget?.get_width?.())
    const height = toNumber(rect?.size?.height ?? rect?.height ?? widget?.get_height?.())

    return x >= left && x <= left + width && y >= top && y <= top + height
  } catch {
    return false
  }
}
