export const BRIGHTNESS_MIN = 0.05
export const BRIGHTNESS_STEP = 0.05
export const VOLUME_STEP = 0.05
export const WIDGET_AUTO_CLOSE_DELAY_MS = 5000
export const REVEALER_HIDE_DELAY_MS = WIDGET_AUTO_CLOSE_DELAY_MS

export const OSD_POLL_INTERVAL_MS = 200
export const OSD_AUTO_HIDE_DELAY_MS = 1200
export const OSD_REVEAL_DURATION_MS = 220
export const OSD_VALUE_ANIMATION_MS = 180
export const OSD_VALUE_ANIMATION_STEP_MS = 16
export const OSD_STARTUP_SUPPRESS_MS = 1500
export const OSD_BOTTOM_MARGIN = 140
export const OSD_BAR_SUPPRESS_MS = 900
export const fallback = {
  clock: "--:--",
} as const

export function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v))
}
