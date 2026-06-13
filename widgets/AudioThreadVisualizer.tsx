import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import AstalCava from "gi://AstalCava"

import { createComputed, createState } from "ags"
import { Astal } from "ags/gtk4"
import { AGS_STATE_DIR, WALLPAPER_SETTINGS_PATH } from "../config"

const { BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

const CAVA_BARS = 72
const VISUALIZER_FPS = 48
const VISUALIZER_FRAME_MS = Math.round(1000 / VISUALIZER_FPS)
const VISUALIZER_MIN_HEIGHT = 120
const VISUALIZER_SCREEN_FRACTION = 0.20
const LEVEL_ATTACK = 0.82
const LEVEL_RELEASE = 0.46
const SPATIAL_SMOOTHING_PASSES = 1
const INPUT_NOISE_FLOOR = 0.018
const SILENCE_HIDE_DELAY_MS = 5000

type AudioThreadColor = { red: number; green: number; blue: number; alpha: number }

let cava: any = null

const [audioThreadVisualizerEnabled, setAudioThreadVisualizerEnabledState] = createState(readAudioThreadVisualizerEnabled())
const drawingAreas = new Set<Gtk.DrawingArea>()
let targetLevels = new Array<number>(CAVA_BARS).fill(0)
let inputLevels = new Array<number>(CAVA_BARS).fill(0)
let renderLevels = new Array<number>(CAVA_BARS).fill(0)
let smoothedLevels = new Array<number>(CAVA_BARS).fill(0)
let curveY = new Array<number>(CAVA_BARS).fill(0)
let curveX = new Array<number>(CAVA_BARS).fill(0)
let curveXWidth = 0
let frameSourceId = 0
let silenceReleaseSourceId = 0
let silenceReleaseInProgress = false
let cavaNotifyId = 0
let themeWatchConfigured = false
let cachedAudioThreadColor: AudioThreadColor | null = null

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
  for (let index = 0; index < CAVA_BARS; index += 1) {
    const value = Math.max(0, Math.min(1, values[index] ?? 0))
    inputLevels[index] = value <= INPUT_NOISE_FLOOR ? 0 : (value - INPUT_NOISE_FLOOR) / (1 - INPUT_NOISE_FLOOR)
  }

  return inputLevels
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

function hasVisibleLevel(levels: number[], threshold = 0.003) {
  for (const level of levels) {
    if ((level ?? 0) > threshold) return true
  }

  return false
}

function setTargetLevels(levels: number[]) {
  for (let index = 0; index < CAVA_BARS; index += 1) {
    targetLevels[index] = levels[index] ?? 0
  }
}

function clearTargetLevels() {
  for (let index = 0; index < CAVA_BARS; index += 1) {
    targetLevels[index] = 0
  }
}

function cancelSilenceReleaseTimer() {
  silenceReleaseSourceId = clearSource(silenceReleaseSourceId)
  silenceReleaseInProgress = false
}

function scheduleSilenceRelease() {
  if (silenceReleaseSourceId !== 0) return

  frameSourceId = clearSource(frameSourceId)

  silenceReleaseSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SILENCE_HIDE_DELAY_MS, () => {
    silenceReleaseSourceId = 0
    silenceReleaseInProgress = true
    clearTargetLevels()
    startFrameClock()
    return GLib.SOURCE_REMOVE
  })
}

function readCavaValues() {
  if (!cava) return false

  try {
    const raw = cava.values ?? cava.get_values?.()
    const nextLevels = normalizeCavaValues(asNumberArray(raw))

    if (hasVisibleLevel(nextLevels)) {
      cancelSilenceReleaseTimer()
      setTargetLevels(nextLevels)
      return true
    }

    if (silenceReleaseInProgress) {
      setTargetLevels(nextLevels)
    } else if (hasVisibleLevel(renderLevels) || hasVisibleLevel(targetLevels)) {
      scheduleSilenceRelease()
    } else {
      setTargetLevels(nextLevels)
    }
  } catch (error) {
    console.error(error)
  }

  return false
}

function queueVisualizerDraw() {
  for (const area of drawingAreas) {
    try {
      area.queue_draw()
    } catch {}
  }
}

function invalidateAudioThreadColor() {
  cachedAudioThreadColor = null
  queueVisualizerDraw()
}

function ensureThemeRedrawWatch() {
  if (themeWatchConfigured) return
  themeWatchConfigured = true

  try {
    const settings = Gtk.Settings.get_default()
    settings?.connect("notify::gtk-theme-name", invalidateAudioThreadColor)
    settings?.connect("notify::gtk-application-prefer-dark-theme", invalidateAudioThreadColor)
  } catch {}
}

function clampColorChannel(value: unknown, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(1, numeric))
}

function readAudioThreadColor(area: Gtk.DrawingArea): AudioThreadColor {
  if (cachedAudioThreadColor) return cachedAudioThreadColor

  try {
    const color = (area as any).get_style_context?.()?.get_color?.()
    if (color) {
      cachedAudioThreadColor = {
        red: clampColorChannel(color.red, 1),
        green: clampColorChannel(color.green, 1),
        blue: clampColorChannel(color.blue, 1),
        alpha: clampColorChannel(color.alpha, 1),
      }
      return cachedAudioThreadColor
    }
  } catch {}

  cachedAudioThreadColor = { red: 1, green: 1, blue: 1, alpha: 1 }
  return cachedAudioThreadColor
}

function setAudioThreadSource(cr: any, color: AudioThreadColor, alpha: number) {
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

    if (!active) {
      frameSourceId = 0
      silenceReleaseInProgress = false
      return GLib.SOURCE_REMOVE
    }

    return GLib.SOURCE_CONTINUE
  })
}

function resetLevels() {
  cancelSilenceReleaseTimer()
  targetLevels.fill(0)
  inputLevels.fill(0)
  renderLevels.fill(0)
  queueVisualizerDraw()
}

function startCava() {
  const cavaInstance = getCava()
  if (!cavaInstance) return

  try {
    if (cavaNotifyId === 0) {
      cavaNotifyId = cavaInstance.connect("notify::values", () => {
        if (readCavaValues()) startFrameClock()
      })
    }

    cavaInstance.set_active?.(true)
    if (readCavaValues()) startFrameClock()
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

function ensureReusableBuffers() {
  if (smoothedLevels.length !== CAVA_BARS) smoothedLevels = new Array<number>(CAVA_BARS).fill(0)
  if (curveY.length !== CAVA_BARS) curveY = new Array<number>(CAVA_BARS).fill(0)
  if (curveX.length !== CAVA_BARS) {
    curveX = new Array<number>(CAVA_BARS).fill(0)
    curveXWidth = 0
  }
}

function updateCurveX(width: number, count: number) {
  ensureReusableBuffers()
  if (curveXWidth === width && curveX.length === count) return curveX

  const xScale = count <= 1 ? 0 : width / (count - 1)
  for (let index = 0; index < count; index += 1) {
    curveX[index] = index * xScale
  }
  curveXWidth = width
  return curveX
}

function updateSmoothedLevels() {
  ensureReusableBuffers()

  if (SPATIAL_SMOOTHING_PASSES <= 0) {
    for (let index = 0; index < CAVA_BARS; index += 1) {
      smoothedLevels[index] = renderLevels[index] ?? 0
    }
    return smoothedLevels
  }

  for (let index = 0; index < CAVA_BARS; index += 1) {
    const value = renderLevels[index] ?? 0
    const previous = renderLevels[Math.max(0, index - 1)] ?? value
    const next = renderLevels[Math.min(CAVA_BARS - 1, index + 1)] ?? value
    smoothedLevels[index] = previous * 0.12 + value * 0.76 + next * 0.12
  }

  return smoothedLevels
}

function drawCurve(cr: any, width: number, yValues: number[], count: number) {
  if (count <= 0) return

  const xValues = updateCurveX(width, count)
  cr.moveTo(0, yValues[0] ?? 0)

  for (let index = 0; index < count - 1; index += 1) {
    const p0Index = Math.max(0, index - 1)
    const p1Index = index
    const p2Index = index + 1
    const p3Index = Math.min(count - 1, index + 2)

    const p0x = xValues[p0Index] ?? 0
    const p1x = xValues[p1Index] ?? 0
    const p2x = xValues[p2Index] ?? 0
    const p3x = xValues[p3Index] ?? p2x
    const p0y = yValues[p0Index] ?? 0
    const p1y = yValues[p1Index] ?? 0
    const p2y = yValues[p2Index] ?? 0
    const p3y = yValues[p3Index] ?? p2y

    const cp1x = p1x + (p2x - p0x) / 6
    const cp1y = p1y + (p2y - p0y) / 6
    const cp2x = p2x - (p3x - p1x) / 6
    const cp2y = p2y - (p3y - p1y) / 6
    cr.curveTo(cp1x, cp1y, cp2x, cp2y, p2x, p2y)
  }
}

function drawAudioThread(area: Gtk.DrawingArea, cr: any, width: number, height: number) {
  if (width <= 2 || height <= 2) return

  const color = readAudioThreadColor(area)
  const levels = updateSmoothedLevels()
  const count = levels.length
  const bottom = height - 3
  const amplitude = Math.max(1, height * 0.86)

  ensureReusableBuffers()
  for (let index = 0; index < count; index += 1) {
    const level = Math.max(0, Math.min(1, levels[index] ?? 0))
    curveY[index] = bottom - Math.pow(level, 0.68) * amplitude
  }

  cr.save()
  cr.setLineCap(1)
  cr.setLineJoin(1)

  drawCurve(cr, width, curveY, count)
  cr.lineTo(width, height)
  cr.lineTo(0, height)
  cr.closePath()
  setAudioThreadSource(cr, color, 0.028)
  cr.fill()

  drawCurve(cr, width, curveY, count)
  setAudioThreadSource(cr, color, 0.18)
  cr.setLineWidth(7)
  cr.stroke()

  drawCurve(cr, width, curveY, count)
  setAudioThreadSource(cr, color, 0.86)
  cr.setLineWidth(2.1)
  cr.stroke()

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
                silenceReleaseSourceId = clearSource(silenceReleaseSourceId)
                silenceReleaseInProgress = false

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
