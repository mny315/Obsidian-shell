import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createState } from "ags"
import { execAsync } from "ags/process"

const STATE_HOME = (() => {
  const configured = GLib.getenv("XDG_STATE_HOME")?.trim() ?? ""
  if (configured.length > 0 && GLib.path_is_absolute(configured)) return configured
  return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"])
})()

const MATUGEN_STATE_DIR = GLib.build_filenamev([STATE_HOME, "ags"])
const MATUGEN_SETTINGS_PATH = GLib.build_filenamev([MATUGEN_STATE_DIR, "matugen-theme.json"])
const MATUGEN_BIN = GLib.find_program_in_path("matugen")?.trim() ?? ""
const CSS_PROVIDER_PRIORITY = (Gtk as any).STYLE_PROVIDER_PRIORITY_USER ?? 800

type MatugenMode = "dark" | "light"

type MatugenSettings = {
  enabled?: boolean
  wallpaper?: string
  mode?: MatugenMode
  css?: string
  sourceColor?: string
}

type MatugenApplyResult = {
  ok: boolean
  message: string
}

const themeProvider = new Gtk.CssProvider()
let themeProviderAdded = false
let themeWatchConfigured = false
let interfaceColorSchemeSettings: Gio.Settings | null = null
let refreshSerial = 0
let refreshQueued = false

function isExistingFilePath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || !GLib.path_is_absolute(trimmed)) return false

  try {
    return Gio.File.new_for_path(trimmed).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.REGULAR
  } catch {
    return false
  }
}

function readMatugenSettings() {
  try {
    const [ok, contents] = GLib.file_get_contents(MATUGEN_SETTINGS_PATH)
    if (!ok || !contents) return {} as MatugenSettings

    const parsed = JSON.parse(new TextDecoder().decode(contents)) as MatugenSettings
    const wallpaper = parsed?.wallpaper?.trim() ?? ""
    const mode = parsed?.mode === "light" ? "light" : parsed?.mode === "dark" ? "dark" : undefined
    const css = typeof parsed?.css === "string" ? parsed.css : undefined
    const sourceColor = typeof parsed?.sourceColor === "string" ? parsed.sourceColor : undefined

    return {
      enabled: parsed?.enabled === true,
      wallpaper: isExistingFilePath(wallpaper) ? wallpaper : undefined,
      mode,
      css,
      sourceColor,
    } satisfies MatugenSettings
  } catch {
    return {} as MatugenSettings
  }
}

function saveMatugenSettings(nextPatch: Partial<MatugenSettings>) {
  try {
    const current = readMatugenSettings()
    const next: MatugenSettings = {
      ...current,
      ...nextPatch,
    }

    GLib.mkdir_with_parents(MATUGEN_STATE_DIR, 0o700)
    GLib.file_set_contents(MATUGEN_SETTINGS_PATH, JSON.stringify(next))
  } catch (error) {
    console.error(error)
  }
}

const initialMatugenSettings = readMatugenSettings()
export const [matugenThemeEnabled, setMatugenThemeEnabled] = createState(initialMatugenSettings.enabled === true)
export const [matugenThemeBusy, setMatugenThemeBusy] = createState(false)
export const [matugenThemeStatus, setMatugenThemeStatus] = createState("")

export function matugenThemeAvailable() {
  return true
}

function getInterfaceColorScheme() {
  try {
    const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
    return settings.get_string("color-scheme")
  } catch {
    return ""
  }
}

function getPreferredMatugenMode(): MatugenMode {
  const colorScheme = getInterfaceColorScheme().toLowerCase()
  if (colorScheme.includes("light")) return "light"
  if (colorScheme.includes("dark")) return "dark"

  try {
    const settings = Gtk.Settings.get_default()
    if ((settings as any)?.gtk_application_prefer_dark_theme === true) return "dark"
  } catch {
  }

  return "dark"
}

function ensureProvider() {
  if (themeProviderAdded) return

  const display = Gdk.Display.get_default()
  if (!display) return

  Gtk.StyleContext.add_provider_for_display(display, themeProvider, CSS_PROVIDER_PRIORITY)
  themeProviderAdded = true
}

function loadThemeCss(css: string) {
  ensureProvider()

  if (!themeProviderAdded) {
    console.warn("[matugen] GTK display is not ready; CSS provider was not attached")
    return false
  }

  try {
    if (typeof (themeProvider as any).load_from_string === "function") {
      ;(themeProvider as any).load_from_string(css)
      return true
    }

    if (typeof (themeProvider as any).load_from_data === "function") {
      try {
        ;(themeProvider as any).load_from_data(css)
        return true
      } catch {
        ;(themeProvider as any).load_from_data(css, -1)
        return true
      }
    }

    console.warn("[matugen] Gtk.CssProvider has no load_from_string/load_from_data method")
  } catch (error) {
    console.error("[matugen] failed to load generated CSS", error)
  }

  return false
}

function clearThemeCss() {
  loadThemeCss("")
}

function extractJson(output: string) {
  const trimmed = output.trim()
  if (!trimmed) throw new Error("matugen returned empty output")

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("matugen did not return JSON")

  return JSON.parse(trimmed.slice(start, end + 1))
}

function normalizeHex(value: unknown) {
  if (typeof value !== "string") return ""

  const trimmed = value.trim()
  const hexMatch = trimmed.match(/^#?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/)
  if (!hexMatch) return ""

  const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`
  return hex.slice(0, 7).toLowerCase()
}

function readColorLeaf(value: unknown): string {
  const direct = normalizeHex(value)
  if (direct) return direct

  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>

  for (const key of ["hex", "color", "default", "value"]) {
    const nested = normalizeHex(record[key])
    if (nested) return nested
  }

  return ""
}

function colorFromRecord(record: unknown, key: string, mode: MatugenMode) {
  if (!record || typeof record !== "object") return ""
  const colors = record as Record<string, unknown>

  const modeRecord = colors[mode]
  if (modeRecord && typeof modeRecord === "object") {
    const fromMode = readColorLeaf((modeRecord as Record<string, unknown>)[key])
    if (fromMode) return fromMode
  }

  const keyRecord = colors[key]
  const fromKey = readColorLeaf(keyRecord)
  if (fromKey) return fromKey

  if (keyRecord && typeof keyRecord === "object") {
    const nested = keyRecord as Record<string, unknown>
    for (const variant of [mode, "default", mode === "dark" ? "light" : "dark"]) {
      const fromVariant = readColorLeaf(nested[variant])
      if (fromVariant) return fromVariant
    }
  }

  return ""
}

function readPaletteColor(json: unknown, key: string, mode: MatugenMode) {
  if (!json || typeof json !== "object") return ""
  const root = json as Record<string, unknown>

  for (const candidate of [root["colors"], root["scheme"], root["palette"], root]) {
    const color = colorFromRecord(candidate, key, mode)
    if (color) return color
  }

  return ""
}

function readSourceColor(json: unknown, mode: MatugenMode) {
  if (!json || typeof json !== "object") return ""
  const root = json as Record<string, unknown>

  for (const key of ["source_color", "sourceColor", "source", "primary"]) {
    const color = readPaletteColor(root, key, mode) || readColorLeaf(root[key])
    if (color) return color
  }

  return ""
}

function cssColor(value: string, fallback: string) {
  return normalizeHex(value) || fallback
}

type RgbColor = {
  r: number
  g: number
  b: number
}

function hexToRgb(value: string): RgbColor | null {
  const hex = normalizeHex(value)
  if (!hex) return null

  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function componentToHex(value: number) {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0")
}

function rgbToHex({ r, g, b }: RgbColor) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`
}

function mixHex(base: string, overlay: string, amount: number) {
  const baseRgb = hexToRgb(base)
  const overlayRgb = hexToRgb(overlay)
  if (!baseRgb || !overlayRgb) return base

  const clamped = Math.min(1, Math.max(0, amount))
  return rgbToHex({
    r: baseRgb.r * (1 - clamped) + overlayRgb.r * clamped,
    g: baseRgb.g * (1 - clamped) + overlayRgb.g * clamped,
    b: baseRgb.b * (1 - clamped) + overlayRgb.b * clamped,
  })
}

function rgbToHsl({ r, g, b }: RgbColor) {
  const rf = r / 255
  const gf = g / 255
  const bf = b / 255
  const max = Math.max(rf, gf, bf)
  const min = Math.min(rf, gf, bf)
  const lightness = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l: lightness }

  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = 0

  if (max === rf) hue = (gf - bf) / delta + (gf < bf ? 6 : 0)
  else if (max === gf) hue = (bf - rf) / delta + 2
  else hue = (rf - gf) / delta + 4

  return { h: hue * 60, s: saturation, l: lightness }
}

function hueToRgb(p: number, q: number, t: number) {
  let next = t
  if (next < 0) next += 1
  if (next > 1) next -= 1
  if (next < 1 / 6) return p + (q - p) * 6 * next
  if (next < 1 / 2) return q
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6
  return p
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const h = (((hue % 360) + 360) % 360) / 360
  const s = Math.min(1, Math.max(0, saturation))
  const l = Math.min(1, Math.max(0, lightness))

  if (s <= 0) {
    const gray = l * 255
    return rgbToHex({ r: gray, g: gray, b: gray })
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  return rgbToHex({
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255,
  })
}

function getPixelByte(pixels: unknown, offset: number) {
  const record = pixels as any
  const direct = record?.[offset]
  if (typeof direct === "number") return direct

  const getter = record?.get
  if (typeof getter === "function") {
    const value = getter.call(record, offset)
    if (typeof value === "number") return value
  }

  return 0
}

function extractSourceColorFromImage(path: string) {
  try {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, 96, true)
    const width = pixbuf.get_width()
    const height = pixbuf.get_height()
    const rowstride = pixbuf.get_rowstride()
    const channels = pixbuf.get_n_channels()
    const pixels = pixbuf.get_pixels()
    const buckets = new Map<number, { count: number, r: number, g: number, b: number, saturation: number, lightness: number }>()
    let totalCount = 0
    let totalR = 0
    let totalG = 0
    let totalB = 0

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = y * rowstride + x * channels
        const alpha = channels >= 4 ? getPixelByte(pixels, offset + 3) : 255
        if (alpha < 96) continue

        const r = getPixelByte(pixels, offset)
        const g = getPixelByte(pixels, offset + 1)
        const b = getPixelByte(pixels, offset + 2)
        const hsl = rgbToHsl({ r, g, b })

        totalCount += 1
        totalR += r
        totalG += g
        totalB += b

        if (hsl.l < 0.08 || hsl.l > 0.94 || hsl.s < 0.08) continue

        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, saturation: 0, lightness: 0 }
        bucket.count += 1
        bucket.r += r
        bucket.g += g
        bucket.b += b
        bucket.saturation += hsl.s
        bucket.lightness += hsl.l
        buckets.set(key, bucket)
      }
    }

    let best: { count: number, r: number, g: number, b: number, saturation: number, lightness: number } | null = null
    let bestScore = -1

    for (const bucket of buckets.values()) {
      const avgSaturation = bucket.saturation / Math.max(1, bucket.count)
      const avgLightness = bucket.lightness / Math.max(1, bucket.count)
      const midLightnessScore = 1 - Math.abs(avgLightness - 0.52)
      const score = bucket.count * (0.75 + avgSaturation * 2.2) * (0.65 + midLightnessScore)

      if (score > bestScore) {
        bestScore = score
        best = bucket
      }
    }

    if (best && best.count > 0) {
      return rgbToHex({
        r: best.r / best.count,
        g: best.g / best.count,
        b: best.b / best.count,
      })
    }

    if (totalCount > 0) {
      return rgbToHex({
        r: totalR / totalCount,
        g: totalG / totalCount,
        b: totalB / totalCount,
      })
    }
  } catch (error) {
    console.warn("[matugen] failed to extract source color from wallpaper", error)
  }

  return "#6750a4"
}

function buildFallbackModePalette(sourceColor: string, mode: MatugenMode) {
  const rgb = hexToRgb(sourceColor) ?? { r: 103, g: 80, b: 164 }
  const hsl = rgbToHsl(rgb)
  const hue = hsl.h
  const saturation = Math.max(0.34, Math.min(0.78, hsl.s * 0.88 + 0.12))

  if (mode === "light") {
    const primary = hslToHex(hue, saturation, 0.38)
    const primaryContainer = hslToHex(hue, Math.min(0.72, saturation * 0.74), 0.90)
    const surface = "#fffbfe"
    const surfaceVariant = hslToHex(hue, 0.12, 0.88)

    return {
      background: surface,
      error: "#ba1a1a",
      on_background: "#1c1b1f",
      on_error: "#ffffff",
      on_primary: "#ffffff",
      on_primary_container: hslToHex(hue, saturation, 0.13),
      on_secondary: "#ffffff",
      on_secondary_container: hslToHex(hue + 18, 0.30, 0.15),
      on_surface: "#1c1b1f",
      on_surface_variant: hslToHex(hue, 0.13, 0.30),
      outline: hslToHex(hue, 0.10, 0.48),
      outline_variant: hslToHex(hue, 0.12, 0.78),
      primary,
      primary_container: primaryContainer,
      scrim: "#000000",
      secondary: hslToHex(hue + 18, 0.28, 0.40),
      secondary_container: hslToHex(hue + 18, 0.24, 0.88),
      shadow: "#000000",
      source_color: sourceColor,
      surface,
      surface_container: hslToHex(hue, 0.08, 0.95),
      surface_container_high: hslToHex(hue, 0.08, 0.93),
      surface_container_highest: hslToHex(hue, 0.08, 0.91),
      surface_container_low: hslToHex(hue, 0.08, 0.97),
      surface_container_lowest: "#ffffff",
      surface_dim: hslToHex(hue, 0.07, 0.87),
      surface_variant: surfaceVariant,
      tertiary: hslToHex(hue + 58, 0.34, 0.42),
      tertiary_container: hslToHex(hue + 58, 0.30, 0.89),
    }
  }

  const primary = hslToHex(hue, Math.min(0.82, saturation * 0.82), 0.78)
  const primaryContainer = hslToHex(hue, Math.min(0.70, saturation * 0.74), 0.30)
  const surface = "#1c1b1f"
  const surfaceVariant = hslToHex(hue, 0.12, 0.28)

  return {
    background: surface,
    error: "#ffb4ab",
    on_background: "#e6e1e5",
    on_error: "#690005",
    on_primary: hslToHex(hue, saturation, 0.17),
    on_primary_container: hslToHex(hue, Math.min(0.72, saturation * 0.74), 0.90),
    on_secondary: hslToHex(hue + 18, 0.30, 0.18),
    on_secondary_container: hslToHex(hue + 18, 0.24, 0.88),
    on_surface: "#e6e1e5",
    on_surface_variant: hslToHex(hue, 0.13, 0.78),
    outline: hslToHex(hue, 0.10, 0.58),
    outline_variant: hslToHex(hue, 0.12, 0.30),
    primary,
    primary_container: primaryContainer,
    scrim: "#000000",
    secondary: hslToHex(hue + 18, 0.26, 0.78),
    secondary_container: hslToHex(hue + 18, 0.24, 0.32),
    shadow: "#000000",
    source_color: sourceColor,
    surface,
    surface_container: hslToHex(hue, 0.08, 0.14),
    surface_container_high: hslToHex(hue, 0.08, 0.17),
    surface_container_highest: hslToHex(hue, 0.08, 0.20),
    surface_container_low: hslToHex(hue, 0.08, 0.12),
    surface_container_lowest: hslToHex(hue, 0.08, 0.08),
    surface_dim: hslToHex(hue, 0.07, 0.11),
    surface_variant: surfaceVariant,
    tertiary: hslToHex(hue + 58, 0.34, 0.80),
    tertiary_container: hslToHex(hue + 58, 0.30, 0.33),
  }
}

function buildFallbackPaletteJson(sourceColor: string) {
  const source = normalizeHex(sourceColor) || "#6750a4"
  return {
    colors: {
      dark: buildFallbackModePalette(source, "dark"),
      light: buildFallbackModePalette(source, "light"),
    },
  }
}

function buildMatugenCss(json: unknown, mode: MatugenMode) {
  const color = (name: string, fallback: string) => cssColor(readPaletteColor(json, name, mode), fallback)

  const fallback = mode === "light"
    ? {
        bg: "#fffbfe",
        surface: "#fffbfe",
        surfaceVariant: "#e7e0ec",
        card: "#f4eff4",
        fg: "#1c1b1f",
        muted: "#49454f",
        outline: "#79747e",
        outlineVariant: "#cac4d0",
        primary: "#6750a4",
        onPrimary: "#ffffff",
        primaryContainer: "#eaddff",
        onPrimaryContainer: "#21005d",
        secondary: "#625b71",
        tertiary: "#7d5260",
        error: "#ba1a1a",
      }
    : {
        bg: "#1c1b1f",
        surface: "#1c1b1f",
        surfaceVariant: "#49454f",
        card: "#211f26",
        fg: "#e6e1e5",
        muted: "#cac4d0",
        outline: "#938f99",
        outlineVariant: "#49454f",
        primary: "#d0bcff",
        onPrimary: "#381e72",
        primaryContainer: "#4f378b",
        onPrimaryContainer: "#eaddff",
        secondary: "#ccc2dc",
        tertiary: "#efb8c8",
        error: "#ffb4ab",
      }

  const bg = color("background", fallback.bg)
  const surface = color("surface", fallback.surface)
  const surfaceDim = color("surface_dim", surface)
  const surfaceContainerLowest = color("surface_container_lowest", bg)
  const surfaceContainerLow = color("surface_container_low", fallback.card)
  const surfaceContainer = color("surface_container", surfaceContainerLow)
  const surfaceContainerHigh = color("surface_container_high", surfaceContainer)
  const surfaceContainerHighest = color("surface_container_highest", surfaceContainerHigh)
  const surfaceVariant = color("surface_variant", fallback.surfaceVariant)
  const fg = color("on_surface", fallback.fg)
  const muted = color("on_surface_variant", fallback.muted)
  const outline = color("outline", fallback.outline)
  const outlineVariant = color("outline_variant", fallback.outlineVariant)
  const primary = color("primary", fallback.primary)
  const onPrimary = color("on_primary", fallback.onPrimary)
  const primaryContainer = color("primary_container", fallback.primaryContainer)
  const onPrimaryContainer = color("on_primary_container", fallback.onPrimaryContainer)
  const secondary = color("secondary", fallback.secondary)
  const tertiary = color("tertiary", fallback.tertiary)
  const error = color("error", fallback.error)
  const sourceColor = cssColor(readSourceColor(json, mode), primary)

  const shellTint = mixHex(surface, primary, 0.10)
  const panelTint = mixHex(surfaceContainer, primary, 0.08)
  const cardTint = mixHex(surfaceContainerHigh, primary, 0.07)
  const popupTint = mixHex(surfaceContainerLow, primary, 0.07)
  const glassBg = `alpha(${shellTint},0.68)`
  const popupBg = `alpha(${popupTint},0.56)`
  const cardBg = `alpha(${cardTint},0.46)`
  const hoverBg = `alpha(${primary},0.16)`
  const activeBg = `alpha(${primary},0.24)`
  const buttonHoverBg = "alpha(@fg,0.05)"
  const buttonActiveBg = "alpha(@fg,0.09)"

  return {
    css: `
@define-color fg ${fg};
@define-color matugen_bg ${bg};
@define-color matugen_surface ${surface};
@define-color matugen_surface_dim ${surfaceDim};
@define-color matugen_surface_lowest ${surfaceContainerLowest};
@define-color matugen_surface_low ${surfaceContainerLow};
@define-color matugen_surface_mid ${surfaceContainer};
@define-color matugen_surface_high ${surfaceContainerHigh};
@define-color matugen_surface_highest ${surfaceContainerHighest};
@define-color matugen_surface_variant ${surfaceVariant};
@define-color matugen_muted ${muted};
@define-color matugen_outline ${outline};
@define-color matugen_outline_variant ${outlineVariant};
@define-color matugen_primary ${primary};
@define-color matugen_on_primary ${onPrimary};
@define-color matugen_primary_container ${primaryContainer};
@define-color matugen_on_primary_container ${onPrimaryContainer};
@define-color matugen_secondary ${secondary};
@define-color matugen_tertiary ${tertiary};
@define-color matugen_error ${error};
@define-color matugen_source ${sourceColor};

* {
  color: @fg;
}

.audio-thread-area {
  color: @matugen_primary;
}

.bar-shell {
  background: ${glassBg};
  color: @fg;
  border-color: alpha(@matugen_primary,0.34);
  box-shadow: inset 0 1px 0 alpha(@matugen_primary,0.22),inset 0 -1px 0 alpha(@matugen_outline,0.08);
}

.section {
  background: alpha(${panelTint},0.50);
  border-color: alpha(@matugen_primary,0.18);
  box-shadow: inset 0 1px 0 alpha(@matugen_primary,0.14),inset 0 -1px 0 alpha(@matugen_bg,0.10),0 4px 12px alpha(@matugen_bg,0.14);
}

.inline-panel,
.power-panel {
  background: alpha(${panelTint},0.58);
  border-color: alpha(@matugen_primary,0.20);
  box-shadow: inset 0 1px 0 alpha(@matugen_primary,0.16),inset 0 -1px 0 alpha(@matugen_bg,0.08),0 6px 18px alpha(@matugen_bg,0.14);
}

box.widget-popup-frame,
.widget-popup-frame,
.network-popover-window,
.bluetooth-popover-window,
.launcher-popover-window,
.wallpaper-popover-window,
.calendar-popover-window,
.audio-popover-window,
popover.bluetooth-popover-window contents,
popover.network-popover-window contents,
popover.launcher-popover-window contents,
popover.wallpaper-popover-window contents,
popover.tray-menu-popover-window contents {
  background: ${popupBg};
  background-color: ${popupBg};
  color: @fg;
  border-color: alpha(@matugen_primary,0.22);
}

.launcher-search-shell,
.wallpaper-gallery-frame,
calendar.calendar-widget,
calendar.calendar-widget.view,
.calendar-widget,
.osd-frame,
.shell-tooltip-frame {
  background: alpha(${cardTint},0.42);
  background-color: alpha(${cardTint},0.42);
  border-color: alpha(@matugen_outline,0.18);
  box-shadow: inset 0 1px 0 alpha(@matugen_primary,0.10),inset 0 -1px 0 alpha(@matugen_bg,0.06);
}

.launcher-list-wrap,
.launcher-list-wrap > viewport,
.launcher-list-wrap viewport,
.launcher-list-wrap viewport > *,
.launcher-list-content,
.network-list-capsule,
.network-list-capsule > viewport,
.network-list-capsule viewport,
.network-list-capsule viewport > *,
.network-list-scroller,
.network-list-scroller > viewport,
.network-list-scroller viewport,
.network-list-scroller viewport > *,
.network-list-inner,
.audio-list-capsule,
.audio-list-capsule > viewport,
.audio-list-capsule viewport,
.audio-list-capsule viewport > *,
.audio-list-scroller,
.audio-list-scroller > viewport,
.audio-list-scroller viewport,
.audio-list-scroller viewport > *,
.audio-list-inner,
.audio-sink-main,
.audio-sink-main > *,
.audio-sink-body,
.audio-sink-body > *,
.audio-sink-content,
.audio-sink-content > * {
  background: transparent;
  background-color: transparent;
  background-image: none;
  border: none;
  box-shadow: none;
}

.network-row-shell,
.network-row-current,
.audio-sink-row,
.audio-sink-current,
button.network-row-button,
.launcher-app-card,
.wallpaper-empty,
.network-password-box {
  background: ${cardBg};
  background-color: ${cardBg};
  border-color: alpha(@matugen_outline,0.14);
}

.audio-sink-main,
.audio-sink-main:hover,
.audio-sink-main:active,
.audio-sink-main:focus,
.audio-sink-body,
.audio-sink-content {
  background: transparent;
  background-color: transparent;
  background-image: none;
  border: none;
  box-shadow: none;
}

.tray-item:hover,
.quick-toggle:hover,
.panel-icon-button:hover,
.power-action:hover,
button.bluetooth-trigger:hover,
menubutton.bluetooth-trigger > button.toggle:hover,
.network-trigger:hover,
menubutton.network-trigger > button.toggle:hover,
button.network-icon-button:hover,
.player-main-button:hover,
.player-transport-button:hover,
.clock-trigger:hover,
button.layout-indicator:hover,
button.wallpaper-refresh-button:hover,
button.network-row-button:hover,
button.bluetooth-pair-button:hover,
button.audio-sink-side-button:hover,
button.launcher-app-side-button:hover,
button.hidden-toggle:hover,
button.launcher-hidden-toggle:hover,
button.audio-hidden-toggle:hover {
  background: ${buttonHoverBg};
  background-color: ${buttonHoverBg};
}

.quick-toggle:active,
.panel-icon-button:active,
.power-action:active,
button.bluetooth-trigger:active,
menubutton.bluetooth-trigger > button.toggle:active,
menubutton.bluetooth-trigger > button.toggle:checked,
.network-trigger:active,
menubutton.network-trigger > button.toggle:active,
menubutton.network-trigger > button.toggle:checked,
button.network-icon-button:active,
.player-main-button:active,
.player-transport-button:active,
.clock-trigger:active,
button.layout-indicator:active,
button.wallpaper-refresh-button:active,
button.wallpaper-refresh-button.wallpaper-refresh-button-active,
button.network-row-button:active,
button.bluetooth-pair-button:active,
button.audio-sink-side-button:active,
button.launcher-app-side-button:active,
button.hidden-toggle:active,
button.launcher-hidden-toggle:active,
button.audio-hidden-toggle:active {
  background: ${buttonActiveBg};
  background-color: ${buttonActiveBg};
}

button.network-icon-button:not(:hover):not(:active):not(:focus):not(:focus-visible):not(:checked) {
  background: transparent;
  background-color: transparent;
  background-image: none;
  border-color: transparent;
  box-shadow: none;
  outline: none;
}

button.network-icon-button:hover,
button.network-icon-button:focus,
button.network-icon-button:focus-visible {
  background: ${buttonHoverBg};
  background-color: ${buttonHoverBg};
  background-image: none;
  border-color: transparent;
  box-shadow: none;
  outline: none;
}

button.network-icon-button:active,
button.network-icon-button:checked {
  background: ${buttonActiveBg};
  background-color: ${buttonActiveBg};
  background-image: none;
  border-color: transparent;
  box-shadow: none;
  outline: none;
}

button.workspace-chip.active,
button.workspace-chip.focused,
.workspace-chip-core.active,
.workspace-chip-core.focused,
.workspace-indicator.focused,
.workspace-indicator.active,
.workspace-indicator-shell .focused,
.workspace-indicator-shell .active,
.network-row-status,
.audio-sink-status,
.launcher-notice,
.network-notice,
.wallpaper-count {
  color: @matugen_primary;
}

.network-row-meta,
.audio-sink-meta,
.launcher-app-meta,
.wallpaper-path,
.calendar-date,
.network-header-meta,
.audio-header-meta,
.osd-percent {
  color: @matugen_muted;
}

scale.slider-control trough,
scale.slider-control > trough,
scale.osd-slider trough,
scale.osd-slider > trough {
  background: alpha(@fg,0.16);
  background-color: alpha(@fg,0.16);
}

scale.slider-control highlight,
scale.slider-control fill,
scale.slider-control > trough > highlight,
scale.slider-control > trough > fill,
scale.osd-slider highlight,
scale.osd-slider fill,
scale.osd-slider > trough > highlight,
scale.osd-slider > trough > fill {
  background: alpha(@matugen_primary,0.92);
  background-color: alpha(@matugen_primary,0.92);
}

calendar.calendar-widget button:hover,
.calendar-widget button:hover,
calendar.calendar-widget grid label.today,
.calendar-widget grid label.today,
calendar.calendar-widget grid label:selected,
.calendar-widget grid label:selected {
  background: ${activeBg};
  background-color: ${activeBg};
  color: @fg;
}

.workspace-chip-core {
  background: alpha(@fg,0.24);
}

.workspace-chip-core.occupied {
  background: alpha(@fg,0.42);
}

.workspace-chip-core.active,
.workspace-chip-core.focused {
  background: alpha(@matugen_primary,0.96);
}

.workspace-chip-core.urgent {
  background: alpha(@matugen_error,0.92);
}

entry.launcher-search,
entry.launcher-search > text {
  color: @fg;
}

entry.launcher-search selection,
text selection,
label selection {
  background: alpha(@matugen_primary,0.30);
  color: @fg;
}

button.player-transport-button:disabled,
button.player-transport-button:disabled:hover,
button.player-transport-button:disabled:active,
button.player-transport-button:disabled label.player-transport-icon {
  color: alpha(@fg,0.42);
}

.urgent {
  color: @matugen_error;
}

.wallpaper-thumb-wrap-active,
.wallpaper-thumb-active {
  border-color: alpha(@matugen_primary,0.52);
}
`.trim(),
    sourceColor,
  }
}

async function runMatugenJson(path: string, mode: MatugenMode) {
  const sourceColor = extractSourceColorFromImage(path)

  if (!MATUGEN_BIN) {
    console.warn(`[matugen] matugen is not available; using internal palette fallback from ${sourceColor}`)
    return buildFallbackPaletteJson(sourceColor)
  }

  const imageCommands = [
    [MATUGEN_BIN, "image", path, "--source-color-index", "0", "--json", "hex", "--dry-run"],
    [MATUGEN_BIN, "image", path, "--source-color-index", "0", "--json", "hex", "--old-json-output", "--dry-run"],
    [MATUGEN_BIN, "image", path, "--json", "hex", "--dry-run"],
    [MATUGEN_BIN, "image", path, "--json", "hex"],
  ]

  const colorCommands = [
    [MATUGEN_BIN, "color", "hex", sourceColor, "--json", "hex", "--dry-run"],
    [MATUGEN_BIN, "color", "hex", sourceColor, "--json", "hex", "--old-json-output", "--dry-run"],
    [MATUGEN_BIN, "color", "hex", sourceColor, "--json", "hex"],
  ]

  for (const commandGroup of [imageCommands, colorCommands]) {
    for (const command of commandGroup) {
      try {
        const output = await execAsync(command)
        const json = extractJson(String(output ?? ""))
        const primary = readPaletteColor(json, "primary", mode)
        if (!primary) throw new Error(`matugen JSON has no ${mode}.primary color`)
        return json
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : String(error)
        console.warn(`[matugen] command failed: ${command.map((part) => `'${part}'`).join(" ")} :: ${message}`)
      }
    }
  }

  console.warn(`[matugen] all matugen commands failed; using internal palette fallback from ${sourceColor}`)
  return buildFallbackPaletteJson(sourceColor)
}

async function applyMatugenTheme(path: string, mode = getPreferredMatugenMode()): Promise<MatugenApplyResult> {
  if (!isExistingFilePath(path)) return { ok: false, message: "Apply a wallpaper first" }

  const serial = ++refreshSerial
  setMatugenThemeBusy(true)
  setMatugenThemeStatus("Generating colors")

  try {
    const json = await runMatugenJson(path, mode)
    if (serial !== refreshSerial) return { ok: false, message: "Matugen refresh superseded" }

    const { css, sourceColor } = buildMatugenCss(json, mode)
    if (!loadThemeCss(css)) throw new Error("failed to apply generated GTK CSS")
    saveMatugenSettings({ enabled: true, wallpaper: path, mode, css, sourceColor })
    setMatugenThemeEnabled(true)
    setMatugenThemeStatus(`Matugen ${mode}`)
    console.log(`[matugen] colors updated (${mode}, source ${sourceColor})`)
    return { ok: true, message: `Matugen colors updated (${mode})` }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "matugen failed"
    console.error(`[matugen] ${message}`, error)
    setMatugenThemeStatus(message)
    return { ok: false, message }
  } finally {
    if (serial === refreshSerial) setMatugenThemeBusy(false)
  }
}

export async function refreshMatugenTheme(path?: string): Promise<MatugenApplyResult> {
  const saved = readMatugenSettings()
  const wallpaper = (path?.trim() || saved.wallpaper || "").trim()
  return applyMatugenTheme(wallpaper)
}

export async function enableMatugenThemeForWallpaper(path: string): Promise<MatugenApplyResult> {
  return applyMatugenTheme(path)
}

export function disableMatugenTheme() {
  refreshSerial += 1
  clearThemeCss()
  saveMatugenSettings({ enabled: false, css: "" })
  setMatugenThemeEnabled(false)
  setMatugenThemeBusy(false)
  setMatugenThemeStatus("Matugen disabled")
}

export async function toggleMatugenThemeForWallpaper(path: string): Promise<MatugenApplyResult> {
  if (matugenThemeEnabled()) {
    disableMatugenTheme()
    return { ok: true, message: "Matugen colors disabled" }
  }

  return enableMatugenThemeForWallpaper(path)
}

function queueMatugenRefresh() {
  if (refreshQueued) return
  refreshQueued = true

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
    refreshQueued = false
    if (!matugenThemeEnabled()) return GLib.SOURCE_REMOVE
    void refreshMatugenTheme()
    return GLib.SOURCE_REMOVE
  })
}

function configureThemeWatch() {
  if (themeWatchConfigured) return
  themeWatchConfigured = true

  try {
    const settings = Gtk.Settings.get_default()
    settings?.connect("notify::gtk-theme-name", queueMatugenRefresh)
    settings?.connect("notify::gtk-application-prefer-dark-theme", queueMatugenRefresh)
  } catch {
  }

  try {
    interfaceColorSchemeSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
    interfaceColorSchemeSettings.connect("changed::color-scheme", queueMatugenRefresh)
  } catch {
  }
}

export function initializeMatugenTheme() {
  configureThemeWatch()

  const saved = readMatugenSettings()
  if (!saved.enabled) return

  setMatugenThemeEnabled(true)

  if (saved.css && saved.css.trim().length > 0) {
    loadThemeCss(saved.css)
    setMatugenThemeStatus(saved.mode ? `Matugen ${saved.mode}` : "Matugen")
  }

  if (saved.wallpaper) {
    void refreshMatugenTheme(saved.wallpaper)
  }
}
