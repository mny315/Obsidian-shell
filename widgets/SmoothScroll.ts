import Gtk from "gi://Gtk?version=4.0"

type SmoothScrollOptions = {
  step?: number
  timeConstantMs?: number
  maxFrameMs?: number
  snapDistance?: number
}

const DEFAULT_SMOOTH_SCROLL_STEP = 72
const DEFAULT_SMOOTH_SCROLL_TIME_CONSTANT_MS = 58
const DEFAULT_SMOOTH_SCROLL_MAX_FRAME_MS = 24
const DEFAULT_SMOOTH_SCROLL_SNAP_DISTANCE = 0.35

export function attachSmoothVerticalScroll(scroller: Gtk.ScrolledWindow, options: SmoothScrollOptions = {}) {
  const step = options.step ?? DEFAULT_SMOOTH_SCROLL_STEP
  const timeConstantMs = options.timeConstantMs ?? DEFAULT_SMOOTH_SCROLL_TIME_CONSTANT_MS
  const maxFrameMs = options.maxFrameMs ?? DEFAULT_SMOOTH_SCROLL_MAX_FRAME_MS
  const snapDistance = options.snapDistance ?? DEFAULT_SMOOTH_SCROLL_SNAP_DISTANCE

  let animationTickId = 0
  let animationWidget: Gtk.Widget | null = null
  let lastFrameTimeUs = 0
  let target = 0

  const stop = () => {
    if (animationTickId === 0) return

    const tickId = animationTickId
    const tickWidget = animationWidget
    animationTickId = 0
    animationWidget = null
    lastFrameTimeUs = 0

    try {
      tickWidget?.remove_tick_callback(tickId)
    } catch {}
  }

  const finish = (adjustment: Gtk.Adjustment) => {
    adjustment.set_value(target)
    animationTickId = 0
    animationWidget = null
    lastFrameTimeUs = 0
  }

  const animate = (dy: number) => {
    const adjustment = scroller.get_vadjustment()
    if (!adjustment) return false

    const lower = adjustment.get_lower()
    const upper = Math.max(lower, adjustment.get_upper() - adjustment.get_page_size())
    if (upper <= lower) return false

    const current = adjustment.get_value()
    const base = animationTickId !== 0 ? target : current
    target = Math.max(lower, Math.min(upper, base + dy * step))

    if (animationTickId !== 0) return true

    lastFrameTimeUs = scroller.get_frame_clock()?.get_frame_time() ?? 0
    animationWidget = scroller
    animationTickId = scroller.add_tick_callback((_widget, frameClock) => {
      const nextCurrent = adjustment.get_value()
      const nextLower = adjustment.get_lower()
      const nextUpper = Math.max(nextLower, adjustment.get_upper() - adjustment.get_page_size())
      target = Math.max(nextLower, Math.min(nextUpper, target))

      const distance = target - nextCurrent
      if (Math.abs(distance) <= snapDistance) {
        finish(adjustment)
        return false
      }

      const frameTimeUs = frameClock.get_frame_time()
      const elapsedMs = lastFrameTimeUs > 0
        ? Math.max(0, Math.min(maxFrameMs, (frameTimeUs - lastFrameTimeUs) / 1000))
        : 1000 / 300
      lastFrameTimeUs = frameTimeUs

      const progress = 1 - Math.exp(-elapsedMs / timeConstantMs)
      adjustment.set_value(nextCurrent + distance * progress)
      return true
    })

    return true
  }

  scroller.set_kinetic_scrolling(false)

  const controller = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
  controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  controller.connect("scroll", (_controller, _dx, dy) => {
    if (Math.abs(dy) < 0.0001) return false
    return animate(dy)
  })
  scroller.add_controller(controller)

  const destroyId = scroller.connect("destroy", () => stop())

  return () => {
    stop()

    try {
      scroller.disconnect(destroyId)
    } catch {}

    try {
      scroller.remove_controller(controller)
    } catch {}
  }
}
