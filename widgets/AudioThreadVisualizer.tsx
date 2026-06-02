import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import AstalCava from "gi://AstalCava"

import { createComputed, createState } from "ags"
import { Astal } from "ags/gtk4"
import { AGS_STATE_DIR, WALLPAPER_SETTINGS_PATH } from "../config"

const { BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const CAVA_BARS = 128
const VISUALIZER_FPS = 75
const VISUALIZER_FRAME_MS = Math.round(1000 / VISUALIZER_FPS)
const VISUALIZER_MIN_HEIGHT = 120
const VISUALIZER_SCREEN_FRACTION = 0.20
const LEVEL_ATTACK = 0.82
const LEVEL_RELEASE = 0.46
const SPATIAL_SMOOTHING_PASSES = 1
const INPUT_NOISE_FLOOR = 0.018

let cava: any = null

const [audioThreadVisualizerEnabled, setAudioThreadVisualizerEnabledState] = createState(readAudioThreadVisualizerEnabled())
const drawingAreas = new Set<Gtk.DrawingArea>()
let targetLevels = new Array<number>(CAVA_BARS).fill(0)
let renderLevels = new Array<number>(CAVA_BARS).fill(0)
let frameSourceId = 0
let cavaNotifyId = 0
let themeWatchConfigured = false

function clearSource(sourceId: number) {
  if (sourceId === 0) return 0

  try {
    GLib.source_remove(sourceId)
  } catch {}

  return 0
}

function readSettingsObject() {
  try {
    const [ok, contents] = GLib.file_get_contents(WALLPAPER_SETTINGS_PATH)
    if (!ok || !contents) return {} as Record<string, unknown>

    const parsed = JSON.parse(new TextDecoder().decode(contents))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {} as Record<string, unknown>
  }
}

function readAudioThreadVisualizerEnabled() {
  const value = readSettingsObject().audioThreadVisualizerEnabled
  return typeof value === "boolean" ? value : false
}

function saveAudioThreadVisualizerEnabled(enabled: boolean) {
  try {
    const next = {
      ...readSettingsObject(),
      audioThreadVisualizerEnabled: enabled,
    }

    GLib.mkdir_with_parents(AGS_STATE_DIR, 0o700)
    GLib.file_set_contents(WALLPAPER_SETTINGS_PATH, JSON.stringify(next))
  } catch (error) {
    console.error(error)
  }
}

function asNumberArray(raw: unknown) {
  if (!raw) return [] as number[]
  if (Array.isArray(raw)) return raw.map((value) => Number(value)).filter(Number.isFinite)

  try {
    const iterable = raw as Iterable<unknown>
    if (typeof iterable?.[Symbol.iterator] === "function") {
      return Array.from(iterable, (value) => Number(value)).filter(Number.isFinite)
    }
  } catch {}

  const indexed = raw as { length?: number; get_length?: () => number; get?: (index: number) => unknown; [index: number]: unknown }
  const length = typeof indexed.length === "number" ? indexed.length : (indexed.get_length?.() ?? 0)
  const values: number[] = []

  for (let index = 0; index < length; index += 1) {
    const rawValue = typeof indexed.get === "function" ? indexed.get(index) : indexed[index]
    const value = Number(rawValue)
    values.push(Number.isFinite(value) ? value : 0)
  }

  return values
}

function normalizeCavaValues(values: number[]) {
  const next = new Array<number>(CAVA_BARS).fill(0)
  const limit = Math.min(CAVA_BARS, values.length)

  for (let index = 0; index < limit; index += 1) {
    const value = Math.max(0, Math.min(1, values[index] ?? 0))
    next[index] = value <= INPUT_NOISE_FLOOR ? 0 : (value - INPUT_NOISE_FLOOR) / (1 - INPUT_NOISE_FLOOR)
  }

  return next
}

function getPipewireInput() {
  return (AstalCava as any).Input?.PIPEWIRE ?? 2
}

function getCava() {
  if (cava) return cava

  try {
    const CavaClass = (AstalCava as any).Cava
    if (typeof CavaClass !== "function") throw new Error("AstalCava.Cava constructor is not available")

    cava = new CavaClass({
      active: false,
      bars: CAVA_BARS,
      framerate: VISUALIZER_FPS,
      autosens: true,
      stereo: false,
      noise_reduction: 0.42,
      input: getPipewireInput(),
    })
  } catch (error) {
    console.error(error)
    cava = null
  }

  return cava
}

function readCavaValues() {
  if (!cava) return

  try {
    const raw = cava.values ?? cava.get_values?.()
    targetLevels = normalizeCavaValues(asNumberArray(raw))
  } catch (error) {
    console.error(error)
  }
}

function queueVisualizerDraw() {
  for (const area of drawingAreas) {
    try {
      area.queue_draw()
    } catch {}
  }
}

function ensureThemeRedrawWatch() {
  if (themeWatchConfigured) return
  themeWatchConfigured = true

  try {
    const settings = Gtk.Settings.get_default()
    settings?.connect("notify::gtk-theme-name", queueVisualizerDraw)
    settings?.connect("notify::gtk-application-prefer-dark-theme", queueVisualizerDraw)
  } catch {}
}

function clampColorChannel(value: unknown, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(1, numeric))
}

function readAudioThreadColor(area: Gtk.DrawingArea) {
  try {
    const color = (area as any).get_style_context?.()?.get_color?.()
    if (color) {
      return {
        red: clampColorChannel(color.red, 1),
        green: clampColorChannel(color.green, 1),
        blue: clampColorChannel(color.blue, 1),
        alpha: clampColorChannel(color.alpha, 1),
      }
    }
  } catch {}

  return { red: 1, green: 1, blue: 1, alpha: 1 }
}

function setAudioThreadSource(cr: any, color: ReturnType<typeof readAudioThreadColor>, alpha: number) {
  cr.setSourceRGBA(color.red, color.green, color.blue, Math.max(0, Math.min(1, alpha * color.alpha)))
}

function stepLevels() {
  let active = false

  for (let index = 0; index < renderLevels.length; index += 1) {
    const current = renderLevels[index] ?? 0
    const target = targetLevels[index] ?? 0
    const speed = target > current ? LEVEL_ATTACK : LEVEL_RELEASE
    const next = current + (target - current) * speed
    renderLevels[index] = Math.abs(next) < 0.001 ? 0 : next
    if (renderLevels[index] > 0.003 || target > 0.003) active = true
  }

  queueVisualizerDraw()
  return active
}

function startFrameClock() {
  if (frameSourceId !== 0) return

  frameSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VISUALIZER_FRAME_MS, () => {
    const active = stepLevels()

    if (!audioThreadVisualizerEnabled() && !active) {
      frameSourceId = 0
      return GLib.SOURCE_REMOVE
    }

    return GLib.SOURCE_CONTINUE
  })
}

function resetLevels() {
  targetLevels = new Array<number>(CAVA_BARS).fill(0)
  renderLevels = new Array<number>(CAVA_BARS).fill(0)
  queueVisualizerDraw()
}

function startCava() {
  const cavaInstance = getCava()
  if (!cavaInstance) return

  try {
    if (cavaNotifyId === 0) {
      cavaNotifyId = cavaInstance.connect("notify::values", () => {
        readCavaValues()
        startFrameClock()
      })
    }

    cavaInstance.set_active?.(true)
    readCavaValues()
    startFrameClock()
  } catch (error) {
    console.error(error)
  }
}

function stopCava(reset: boolean) {
  if (!cava) {
    if (reset) resetLevels()
    return
  }

  try {
    cava.set_active?.(false)
  } catch (error) {
    console.error(error)
  }

  if (reset) resetLevels()
}

function setAudioThreadVisualizerEnabled(enabled: boolean) {
  if (enabled === Boolean(audioThreadVisualizerEnabled())) return

  setAudioThreadVisualizerEnabledState(enabled)
  saveAudioThreadVisualizerEnabled(enabled)

  if (enabled) startCava()
  else stopCava(true)
}

function toggleAudioThreadVisualizer() {
  setAudioThreadVisualizerEnabled(!audioThreadVisualizerEnabled())
}

function readMonitorGeometry(monitorIndex: number) {
  try {
    const display = Gdk.Display.get_default()
    const monitors = display?.get_monitors()
    const monitor = monitors?.get_item(monitorIndex) as Gdk.Monitor | null
    const geometry = monitor?.get_geometry?.()
    const screenWidth = Math.max(1, geometry?.width ?? 1920)
    const screenHeight = Math.max(1, geometry?.height ?? 1080)

    return {
      width: screenWidth,
      height: Math.max(VISUALIZER_MIN_HEIGHT, Math.round(screenHeight * VISUALIZER_SCREEN_FRACTION)),
    }
  } catch {
    return { width: 1920, height: 216 }
  }
}

function smoothLevels(levels: number[]) {
  let smoothed = levels.slice()

  for (let pass = 0; pass < SPATIAL_SMOOTHING_PASSES; pass += 1) {
    smoothed = smoothed.map((value, index) => {
      const previous = smoothed[Math.max(0, index - 1)] ?? value
      const next = smoothed[Math.min(smoothed.length - 1, index + 1)] ?? value
      return previous * 0.12 + value * 0.76 + next * 0.12
    })
  }

  return smoothed
}

function drawAudioThread(area: Gtk.DrawingArea, cr: any, width: number, height: number) {
  if (width <= 2 || height <= 2) return

  const color = readAudioThreadColor(area)
  const levels = smoothLevels(renderLevels)
  const count = levels.length
  const bottom = height - 3
  const amplitude = Math.max(1, height * 0.86)
  const points = levels.map((level, index) => {
    const x = count <= 1 ? 0 : (index / (count - 1)) * width
    const lifted = Math.pow(Math.max(0, Math.min(1, level)), 0.68) * amplitude
    const y = bottom - lifted
    return { x, y }
  })

  const drawCurve = () => {
    const firstPoint = points[0]
    if (!firstPoint) return

    cr.moveTo(firstPoint.x, firstPoint.y)

    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[Math.max(0, index - 1)] ?? points[index]
      const p1 = points[index]
      const p2 = points[index + 1]
      const p3 = points[Math.min(points.length - 1, index + 2)] ?? p2

      if (!p0 || !p1 || !p2 || !p3) continue

      const cp1x = p1.x + (p2.x - p0.x) / 6
      const cp1y = p1.y + (p2.y - p0.y) / 6
      const cp2x = p2.x - (p3.x - p1.x) / 6
      const cp2y = p2.y - (p3.y - p1.y) / 6
      cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
    }
  }

  cr.save()
  cr.setLineCap(1)
  cr.setLineJoin(1)

  drawCurve()
  setAudioThreadSource(cr, color, 0.10)
  cr.setLineWidth(14)
  cr.stroke()

  drawCurve()
  setAudioThreadSource(cr, color, 0.22)
  cr.setLineWidth(6)
  cr.stroke()

  drawCurve()
  setAudioThreadSource(cr, color, 0.86)
  cr.setLineWidth(2.2)
  cr.stroke()

  drawCurve()
  cr.lineTo(width, height)
  cr.lineTo(0, height)
  cr.closePath()
  setAudioThreadSource(cr, color, 0.035)
  cr.fill()

  cr.restore()
}

export { audioThreadVisualizerEnabled, toggleAudioThreadVisualizer }

export function AudioThreadVisualizerWindow({ monitor }: { monitor: number }) {
  const geometry = readMonitorGeometry(monitor)
  const { width, height } = geometry
  const visibleForMonitor = createComputed(() => Boolean(audioThreadVisualizerEnabled()))

  return (
    <window
      visible={visibleForMonitor}
      monitor={monitor}
      defaultWidth={width}
      defaultHeight={height}
      resizable={false}
      namespace="desktop-audio-thread"
      class="audio-thread-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.NONE}
      layer={Astal.Layer.BOTTOM}
      anchor={BOTTOM | LEFT | RIGHT}
      $={(self) => {
        try {
          self.set_default_size(width, height)
          self.set_margin_bottom(0)
          self.set_can_target(false)
          self.set_focusable(false)
        } catch {}

        if (audioThreadVisualizerEnabled()) startCava()
      }}
    >
      <box
        class="audio-thread-root"
        widthRequest={width}
        heightRequest={height}
        hexpand
        vexpand={false}
        halign={Gtk.Align.FILL}
        valign={Gtk.Align.END}
        $={(self) => {
          self.set_can_target(false)
          self.set_focusable(false)
        }}
      >
        <Gtk.DrawingArea
          class="audio-thread-area"
          widthRequest={width}
          heightRequest={height}
          hexpand
          vexpand={false}
          halign={Gtk.Align.FILL}
          valign={Gtk.Align.FILL}
          $={(self) => {
            self.set_draw_func(drawAudioThread)
            self.set_content_width(width)
            self.set_content_height(height)
            self.set_can_target(false)
            self.set_focusable(false)

            drawingAreas.add(self)
            ensureThemeRedrawWatch()
            if (audioThreadVisualizerEnabled()) startCava()

            self.connect("destroy", () => {
              drawingAreas.delete(self)
              if (drawingAreas.size === 0) {
                stopCava(false)
                frameSourceId = clearSource(frameSourceId)

                if (cava && cavaNotifyId !== 0) {
                  try {
                    cava.disconnect(cavaNotifyId)
                  } catch {}
                  cavaNotifyId = 0
                }
              }
            })
          }}
        />
      </box>
    </window>
  )
}
