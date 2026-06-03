import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { Astal } from "ags/gtk4"

import { createComputed, createState } from "ags"
import { execAsync, subprocess } from "ags/process"
import { AGS_STATE_DIR, WALLPAPER_SETTINGS_PATH } from "../config"
import { attachEscapeKey } from "./EscapeKey"
import { playerPinned, togglePlayerPinned } from "./PlayerPinState"
import { LEFT_TOP_POPUP_ANCHOR, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowFromTrigger } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"
import { audioThreadVisualizerEnabled, toggleAudioThreadVisualizer } from "./AudioThreadVisualizer"
import { workspaceIndicatorVisible, toggleWorkspaceIndicatorVisible } from "./WorkspaceIndicatorState"

type WallpaperItem = {
  name: string
  path: string
}

function isExistingDirectoryPath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || !GLib.path_is_absolute(trimmed)) return false

  try {
    return Gio.File.new_for_path(trimmed).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY
  } catch {
    return false
  }
}

function getDefaultPicturesDir() {
  const candidates = [
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES)?.trim() ?? "",
    GLib.build_filenamev([GLib.get_home_dir(), "Pictures"]),
    GLib.get_home_dir(),
  ]

  for (const candidate of candidates) {
    if (isExistingDirectoryPath(candidate)) return candidate
  }

  return GLib.get_home_dir()
}

const DEFAULT_WALLPAPER_DIR = getDefaultPicturesDir()
const WALLPAPER_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])
const WALLPAPER_VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"])
const WALLPAPER_EXTENSIONS = new Set([...WALLPAPER_IMAGE_EXTENSIONS, ...WALLPAPER_VIDEO_EXTENSIONS])
const GRID_COLUMNS = 3
const CARD_WIDTH = 144
const CARD_HEIGHT = 84
const GRID_GAP = 8
const SCROLLER_WIDTH = GRID_COLUMNS * CARD_WIDTH + GRID_GAP * (GRID_COLUMNS - 1)
const GRID_VISIBLE_ROWS = 6
const SCROLLER_HEIGHT = CARD_HEIGHT * GRID_VISIBLE_ROWS + GRID_GAP * (GRID_VISIBLE_ROWS - 1)
const SCROLLER_MIN_HEIGHT = CARD_HEIGHT * 2 + GRID_GAP
const POPOVER_WIDTH = SCROLLER_WIDTH + 24
const WALLPAPER_POPOVER_REVEAL_DURATION_MS = 165
const WALLPAPER_POPOVER_OFFSET_Y = 15
const WALLPAPER_INITIAL_VISIBLE_ITEMS = GRID_COLUMNS * GRID_VISIBLE_ROWS
const WALLPAPER_LOAD_MORE_ITEMS = GRID_COLUMNS * 2
const WALLPAPER_LOAD_MORE_THRESHOLD = CARD_HEIGHT + GRID_GAP
const WALLPAPER_SMOOTH_SCROLL_STEP = 72
const WALLPAPER_SMOOTH_SCROLL_TIME_CONSTANT_MS = 58
const WALLPAPER_SMOOTH_SCROLL_MAX_FRAME_MS = 24
const WALLPAPER_SMOOTH_SCROLL_SNAP_DISTANCE = 0.35
const WALLPAPER_TEXTURE_QUEUE_INTERVAL_MS = 12
const WALLPAPER_THUMBNAIL_VERSION = "cover-fill-v3"
const WALLPAPER_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), "obsidian-shell", "wallpaper-thumbs"])
const WALLPAPER_VIDEO_STILL_VERSION = "live-still-v1"
const WALLPAPER_VIDEO_TRANSITION_MS = 900
const WALLPAPER_VIDEO_HANDOFF_MS = 240
const wallpaperTextureCache = new Map<string, Gdk.Texture | null>()
const wallpaperThumbnailPathCache = new Map<string, string>()
const wallpaperTextureSubscribers = new Map<string, Set<(texture: Gdk.Texture | null) => void>>()
const wallpaperTextureQueued = new Set<string>()
const wallpaperTextureQueue: string[] = []
let wallpaperTextureQueueSourceId = 0
let wallpaperThumbnailBuildGeneration = 0
const WALLPAPER_CLI_BIN = GLib.find_program_in_path("awww")?.trim() ?? ""
const WALLPAPER_DAEMON_BIN = GLib.find_program_in_path("awww-daemon")?.trim() ?? ""
const FFMPEG_BIN = GLib.find_program_in_path("ffmpeg")?.trim() ?? ""
const MPVPAPER_BIN = GLib.find_program_in_path("mpvpaper")?.trim() ?? ""
const PKILL_BIN = GLib.find_program_in_path("pkill")?.trim() ?? ""
const PGREP_BIN = GLib.find_program_in_path("pgrep")?.trim() ?? ""
const MPVPAPER_OUTPUT = GLib.getenv("OBSIDIAN_SHELL_MPVPAPER_OUTPUT")?.trim() || "ALL"
const MPVPAPER_DEFAULT_OPTIONS = "config=no no-audio loop-file=inf hwdec=auto-safe terminal=no input-terminal=no input-default-bindings=no osc=no osd-level=0"
const MPVPAPER_FORCED_OPTIONS = ["config=no"]
const STATIC_WALLPAPER_DAEMON_NAMES = ["awww-daemon"]
const LIVE_WALLPAPER_PROCESS_NAMES = ["mpvpaper"]
const WALLPAPER_BACKEND_SETTLE_MS = 120
const WALLPAPER_STATIC_TRANSITION_ARGS = [
  "--transition-type",
  "grow",
  "--transition-pos",
  "center",
  "--transition-duration",
  "0.9",
  "--transition-fps",
  "120",
  "--transition-step",
  "28",
]
let liveWallpaperProcess: ReturnType<typeof subprocess> | null = null
let liveWallpaperPath = ""
let wallpaperStartupRestoreStarted = false

function resetWallpaperTexturePipeline() {
  wallpaperThumbnailBuildGeneration += 1

  if (wallpaperTextureQueueSourceId !== 0) {
    GLib.source_remove(wallpaperTextureQueueSourceId)
    wallpaperTextureQueueSourceId = 0
  }

  wallpaperTextureQueue.length = 0
  wallpaperTextureQueued.clear()
  wallpaperTextureSubscribers.clear()
  wallpaperTextureCache.clear()
  wallpaperThumbnailPathCache.clear()
}

function pumpWallpaperTextureQueue() {
  if (wallpaperTextureQueueSourceId !== 0) return

  wallpaperTextureQueueSourceId = GLib.timeout_add(GLib.PRIORITY_LOW, WALLPAPER_TEXTURE_QUEUE_INTERVAL_MS, () => {
    wallpaperTextureQueueSourceId = 0

    while (wallpaperTextureQueue.length > 0) {
      const path = wallpaperTextureQueue.shift()
      if (!path) continue

      wallpaperTextureQueued.delete(path)

      const subscribers = wallpaperTextureSubscribers.get(path)
      if (!subscribers || subscribers.size === 0) continue

      const texture = getWallpaperTexture(path)
      const pendingSubscribers = wallpaperTextureSubscribers.get(path)
      wallpaperTextureSubscribers.delete(path)

      for (const subscriber of pendingSubscribers ?? []) {
        try {
          subscriber(texture)
        } catch (error) {
          console.error(error)
        }
      }

      break
    }

    if (wallpaperTextureQueue.length > 0) pumpWallpaperTextureQueue()
    return GLib.SOURCE_REMOVE
  })
}

function requestWallpaperTexture(path: string, onReady: (texture: Gdk.Texture | null) => void) {
  if (wallpaperTextureCache.has(path)) {
    onReady(wallpaperTextureCache.get(path) ?? null)
    return () => {}
  }

  let subscribers = wallpaperTextureSubscribers.get(path)
  if (!subscribers) {
    subscribers = new Set()
    wallpaperTextureSubscribers.set(path, subscribers)
  }

  subscribers.add(onReady)

  if (!wallpaperTextureQueued.has(path)) {
    wallpaperTextureQueued.add(path)
    wallpaperTextureQueue.push(path)
    pumpWallpaperTextureQueue()
  }

  return () => {
    const currentSubscribers = wallpaperTextureSubscribers.get(path)
    if (!currentSubscribers) return
    currentSubscribers.delete(onReady)
    if (currentSubscribers.size === 0) wallpaperTextureSubscribers.delete(path)
  }
}

function ensureWallpaperCacheDir() {
  try {
    GLib.mkdir_with_parents(WALLPAPER_CACHE_DIR, 0o755)
    return true
  } catch (error) {
    console.error(error)
    return false
  }
}

function getWallpaperThumbnailPath(path: string) {
  const cachedPath = wallpaperThumbnailPathCache.get(path)
  if (cachedPath) return cachedPath

  let etag = ""

  try {
    const info = Gio.File.new_for_path(path).query_info(
      "etag::value,time::modified,standard::size",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const size = info.get_size()
    const modified = info.get_attribute_uint64("time::modified")
    etag = info.get_etag() ?? `${size}:${modified}`
  } catch (error) {
    console.error(error)
  }

  const thumbnailVersion = isVideoWallpaperPath(path)
    ? `${WALLPAPER_THUMBNAIL_VERSION}:video-widget-play-v1`
    : WALLPAPER_THUMBNAIL_VERSION

  const key = GLib.compute_checksum_for_string(
    GLib.ChecksumType.SHA256,
    `${path}:${etag}:${CARD_WIDTH}x${CARD_HEIGHT}:${thumbnailVersion}`,
    -1,
  )

  const thumbnailPath = GLib.build_filenamev([WALLPAPER_CACHE_DIR, `${key}.png`])
  wallpaperThumbnailPathCache.set(path, thumbnailPath)
  return thumbnailPath
}

function getWallpaperFileCacheKey(path: string, version: string) {
  let etag = ""

  try {
    const info = Gio.File.new_for_path(path).query_info(
      "etag::value,time::modified,standard::size",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const size = info.get_size()
    const modified = info.get_attribute_uint64("time::modified")
    etag = info.get_etag() ?? `${size}:${modified}`
  } catch (error) {
    console.error(error)
  }

  return GLib.compute_checksum_for_string(
    GLib.ChecksumType.SHA256,
    `${path}:${etag}:${version}`,
    -1,
  )
}

function getWallpaperVideoStillPath(path: string) {
  const key = getWallpaperFileCacheKey(path, WALLPAPER_VIDEO_STILL_VERSION)
  return GLib.build_filenamev([WALLPAPER_CACHE_DIR, `${key}.still.png`])
}

function getWallpaperExtension(path: string) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  return dot >= 0 ? lower.slice(dot) : ""
}

function isImageWallpaperPath(path: string) {
  return WALLPAPER_IMAGE_EXTENSIONS.has(getWallpaperExtension(path))
}

function isVideoWallpaperPath(path: string) {
  return WALLPAPER_VIDEO_EXTENSIONS.has(getWallpaperExtension(path))
}

function isSupportedWallpaperPath(path: string) {
  return WALLPAPER_EXTENSIONS.has(getWallpaperExtension(path))
}

function isMpvpaperForbiddenOption(option: string) {
  const normalized = option.trim().replace(/^--/, "")
  if (!normalized) return true

  const name = normalized.split("=", 1)[0] ?? ""
  return name === "vo" || name === "config" || name === "config-dir"
}

function getMpvpaperOptions() {
  const configured = GLib.getenv("OBSIDIAN_SHELL_MPVPAPER_OPTIONS")?.trim() ?? ""
  const rawOptions = (configured.length > 0 ? configured : MPVPAPER_DEFAULT_OPTIONS)
    .split(/\s+/)
    .map((option) => option.trim())
    .filter((option) => !isMpvpaperForbiddenOption(option))

  return [...MPVPAPER_FORCED_OPTIONS, ...rawOptions].join(" ")
}

function removeFileIfExists(path: string) {
  try {
    if (Gio.File.new_for_path(path).query_exists(null)) GLib.unlink(path)
  } catch {
  }
}

function generateImageWallpaperThumbnail(path: string, thumbnailPath: string) {
  if (!ensureWallpaperCacheDir()) return null

  const tempPath = `${thumbnailPath}.tmp.png`
  removeFileIfExists(tempPath)

  try {
    const source = GdkPixbuf.Pixbuf.new_from_file(path)
    const sourceWidth = source.get_width()
    const sourceHeight = source.get_height()

    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error(`Invalid image size for ${path}`)

    const thumbnailAspect = CARD_WIDTH / CARD_HEIGHT
    const sourceAspect = sourceWidth / sourceHeight
    const zoom = 1.03

    let cropWidth = sourceWidth
    let cropHeight = sourceHeight

    if (sourceAspect > thumbnailAspect) {
      cropWidth = Math.max(1, Math.round(sourceHeight * thumbnailAspect / zoom))
      cropHeight = sourceHeight
    } else {
      cropWidth = sourceWidth
      cropHeight = Math.max(1, Math.round(sourceWidth / thumbnailAspect / zoom))
    }

    const cropX = Math.max(0, Math.floor((sourceWidth - cropWidth) / 2))
    const cropY = Math.max(0, Math.floor((sourceHeight - cropHeight) / 2))
    const cropped = source.new_subpixbuf(cropX, cropY, cropWidth, cropHeight)
    const thumbnail = cropped.scale_simple(CARD_WIDTH, CARD_HEIGHT, GdkPixbuf.InterpType.BILINEAR)

    if (!thumbnail) throw new Error(`Failed to scale preview for ${path}`)

    thumbnail.savev(tempPath, "png", [], [])
    GLib.rename(tempPath, thumbnailPath)

    return thumbnailPath
  } catch (error) {
    removeFileIfExists(tempPath)
    console.error(error)
    return null
  }
}

async function generateVideoWallpaperThumbnail(path: string, thumbnailPath: string) {
  if (!ensureWallpaperCacheDir()) return null
  if (!FFMPEG_BIN) return null

  const tempPath = `${thumbnailPath}.tmp.png`
  const videoFilter = `scale=${CARD_WIDTH}:${CARD_HEIGHT}:force_original_aspect_ratio=increase,crop=${CARD_WIDTH}:${CARD_HEIGHT}`
  const makeCommand = (seekBeforeInput: boolean) => {
    const command = [
      FFMPEG_BIN,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
    ]

    if (seekBeforeInput) {
      command.push("-ss", "00:00:01")
    }

    command.push(
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      videoFilter,
      tempPath,
    )

    return command
  }

  const commands = [
    makeCommand(true),
    makeCommand(false),
  ]

  let lastError: unknown = null

  for (const command of commands) {
    removeFileIfExists(tempPath)

    try {
      await execAsync(command)
      if (!Gio.File.new_for_path(tempPath).query_exists(null)) throw new Error(`ffmpeg did not create preview for ${path}`)
      GLib.rename(tempPath, thumbnailPath)
      return thumbnailPath
    } catch (error) {
      lastError = error
      removeFileIfExists(tempPath)
    }
  }

  console.error(lastError ?? new Error(`Failed to create video preview for ${path}`))
  return null
}

async function generateWallpaperThumbnail(path: string, thumbnailPath: string) {
  if (isVideoWallpaperPath(path)) return generateVideoWallpaperThumbnail(path, thumbnailPath)
  if (isImageWallpaperPath(path)) return generateImageWallpaperThumbnail(path, thumbnailPath)
  return null
}

async function generateVideoWallpaperStill(path: string, stillPath: string) {
  if (!ensureWallpaperCacheDir()) return null
  if (!FFMPEG_BIN) return null

  const tempPath = `${stillPath}.tmp.png`
  const commands = [
    [
      FFMPEG_BIN,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "00:00:00.050",
      "-i",
      path,
      "-frames:v",
      "1",
      tempPath,
    ],
    [
      FFMPEG_BIN,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path,
      "-frames:v",
      "1",
      tempPath,
    ],
    [
      FFMPEG_BIN,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      path,
      "-frames:v",
      "1",
      tempPath,
    ],
  ]

  let lastError: unknown = null

  for (const command of commands) {
    removeFileIfExists(tempPath)

    try {
      await execAsync(command)
      if (!Gio.File.new_for_path(tempPath).query_exists(null)) throw new Error(`ffmpeg did not create live wallpaper still for ${path}`)
      GLib.rename(tempPath, stillPath)
      return stillPath
    } catch (error) {
      lastError = error
      removeFileIfExists(tempPath)
    }
  }

  console.error(lastError ?? new Error(`Failed to create live wallpaper still for ${path}`))
  return null
}

async function ensureVideoWallpaperStill(path: string) {
  if (!isVideoWallpaperPath(path)) return null

  const stillPath = getWallpaperVideoStillPath(path)
  if (Gio.File.new_for_path(stillPath).query_exists(null)) return stillPath

  return generateVideoWallpaperStill(path, stillPath)
}

function getExistingWallpaperThumbnail(path: string) {
  const thumbnailPath = getWallpaperThumbnailPath(path)
  return Gio.File.new_for_path(thumbnailPath).query_exists(null) ? thumbnailPath : null
}

function yieldLowPriorityFrame() {
  return new Promise<void>((resolve) => {
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

async function buildWallpaperThumbnails(
  items: WallpaperItem[],
  onProgress?: (done: number, total: number) => void,
) {
  const total = items.length
  const buildGeneration = ++wallpaperThumbnailBuildGeneration

  for (let index = 0; index < items.length; index += 1) {
    if (buildGeneration !== wallpaperThumbnailBuildGeneration) return false

    const item = items[index]
    const thumbnailPath = getWallpaperThumbnailPath(item.path)
    if (!Gio.File.new_for_path(thumbnailPath).query_exists(null)) {
      await generateWallpaperThumbnail(item.path, thumbnailPath)
    }

    onProgress?.(index + 1, total)
    await yieldLowPriorityFrame()
  }

  return buildGeneration === wallpaperThumbnailBuildGeneration
}

function getWallpaperTexture(path: string) {
  if (wallpaperTextureCache.has(path)) return wallpaperTextureCache.get(path) ?? null

  try {
    const thumbnailPath = getExistingWallpaperThumbnail(path)
    if (!thumbnailPath) {
      wallpaperTextureCache.set(path, null)
      return null
    }

    const texture = Gdk.Texture.new_from_filename(thumbnailPath)
    wallpaperTextureCache.set(path, texture)
    return texture
  } catch (error) {
    console.error(error)
    wallpaperTextureCache.set(path, null)
    return null
  }
}

type WallpaperWidgetSettings = {
  directory?: string
  currentWallpaper?: string
  audioThreadVisualizerEnabled?: boolean
}

function isAbsoluteDirectory(path: string) {
  return isExistingDirectoryPath(path)
}

function isExistingFilePath(path: string) {
  const trimmed = path.trim()
  if (!trimmed || !GLib.path_is_absolute(trimmed)) return false

  try {
    return Gio.File.new_for_path(trimmed).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.REGULAR
  } catch {
    return false
  }
}

function readWallpaperSettings() {
  try {
    const [ok, contents] = GLib.file_get_contents(WALLPAPER_SETTINGS_PATH)
    if (!ok || !contents) return {} as WallpaperWidgetSettings

    const parsed = JSON.parse(new TextDecoder().decode(contents)) as WallpaperWidgetSettings | string
    if (typeof parsed === "string") {
      return isAbsoluteDirectory(parsed) ? { directory: parsed.trim() } : ({} as WallpaperWidgetSettings)
    }

    const directory = parsed?.directory?.trim() ?? ""
    const currentWallpaper = parsed?.currentWallpaper?.trim() ?? ""
    const audioThreadVisualizerEnabled = typeof parsed?.audioThreadVisualizerEnabled === "boolean"
      ? parsed.audioThreadVisualizerEnabled
      : undefined

    return {
      directory: isAbsoluteDirectory(directory) ? directory : undefined,
      currentWallpaper: isExistingFilePath(currentWallpaper) ? currentWallpaper : undefined,
      audioThreadVisualizerEnabled,
    } satisfies WallpaperWidgetSettings
  } catch {
    return {} as WallpaperWidgetSettings
  }
}

function saveWallpaperSettings(nextPatch: Partial<WallpaperWidgetSettings>) {
  try {
    const current = readWallpaperSettings()
    const next: WallpaperWidgetSettings = {
      ...current,
      ...nextPatch,
    }

    GLib.mkdir_with_parents(AGS_STATE_DIR, 0o700)
    GLib.file_set_contents(WALLPAPER_SETTINGS_PATH, JSON.stringify(next))
  } catch (error) {
    console.error(error)
  }
}

function formatWallpaperDirectory(path: string) {
  const homeDir = GLib.get_home_dir()
  if (path === homeDir) return "~"
  if (path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`
  return path
}

function listWallpaperFiles(wallpaperDir: string): WallpaperItem[] {
  try {
    const dir = Gio.File.new_for_path(wallpaperDir)
    const enumerator = dir.enumerate_children(
      "standard::name,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )

    const items: WallpaperItem[] = []

    while (true) {
      const info = enumerator.next_file(null)
      if (!info) break
      if (info.get_file_type() !== Gio.FileType.REGULAR) continue

      const name = info.get_name()
      if (!isSupportedWallpaperPath(name)) continue

      items.push({
        name,
        path: GLib.build_filenamev([wallpaperDir, name]),
      })
    }

    enumerator.close(null)

    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }))
  } catch (error) {
    console.error(error)
    return []
  }
}

function listWallpapers(wallpaperDir: string): WallpaperItem[] {
  return listWallpaperFiles(wallpaperDir).filter((item) => getExistingWallpaperThumbnail(item.path) !== null)
}

function chunkWallpapers(items: WallpaperItem[], chunkSize: number) {
  const rows: WallpaperItem[][] = []

  for (let index = 0; index < items.length; index += chunkSize) {
    rows.push(items.slice(index, index + chunkSize))
  }

  return rows
}

function sameWallpaperItems(left: WallpaperItem[], right: WallpaperItem[]) {
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.path !== right[index]?.path) return false
  }

  return true
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error.trim()
  return "Action failed"
}

function parseCurrentWallpaperPaths(output: string) {
  const paths = new Set<string>()

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const currentMatch = line.match(/currently displaying:\s*(.+)$/i)
    if (currentMatch) {
      const value = currentMatch[1].trim()
      if (value.startsWith("/")) paths.add(value)
      continue
    }

    const legacyMatch = line.match(/image:\s*(.+)$/i)
    if (legacyMatch) {
      const value = legacyMatch[1].trim()
      if (value.startsWith("/")) paths.add(value)
    }
  }

  return paths
}

function delayMs(ms: number) {
  return new Promise<void>((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

function isTrackedLiveWallpaperRunning(path?: string) {
  return Boolean(liveWallpaperProcess && (!path || liveWallpaperPath === path))
}

function terminateTrackedLiveWallpaper() {
  const proc = liveWallpaperProcess
  liveWallpaperProcess = null
  liveWallpaperPath = ""

  if (!proc) return

  const subprocessLike = proc as {
    force_exit?: () => void
    kill?: () => void
    send_signal?: (signal: number) => void
  }

  try {
    if (typeof subprocessLike.force_exit === "function") subprocessLike.force_exit()
    else if (typeof subprocessLike.kill === "function") subprocessLike.kill()
    else if (typeof subprocessLike.send_signal === "function") subprocessLike.send_signal(15)
  } catch (error) {
    console.error(error)
  }
}

async function isExactProcessNameRunning(processName: string) {
  if (!PGREP_BIN) return false

  try {
    await execAsync([PGREP_BIN, "-x", processName])
    return true
  } catch {
    return false
  }
}

async function waitForExactProcessNameToExit(processName: string) {
  if (!PGREP_BIN) {
    await delayMs(WALLPAPER_BACKEND_SETTLE_MS)
    return
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!(await isExactProcessNameRunning(processName))) return
    await delayMs(WALLPAPER_BACKEND_SETTLE_MS)
  }
}

async function pkillExactProcessName(processName: string, signal = "-TERM") {
  if (!PKILL_BIN) return

  try {
    await execAsync([PKILL_BIN, signal, "-x", processName])
  } catch {
  }
}

async function stopLiveWallpaperProcesses() {
  terminateTrackedLiveWallpaper()

  for (const processName of LIVE_WALLPAPER_PROCESS_NAMES) {
    await pkillExactProcessName(processName, "-TERM")
    await waitForExactProcessNameToExit(processName)

    if (await isExactProcessNameRunning(processName)) {
      await pkillExactProcessName(processName, "-KILL")
      await waitForExactProcessNameToExit(processName)
    }
  }
}

async function stopStaticWallpaperDaemons() {
  for (const daemonName of STATIC_WALLPAPER_DAEMON_NAMES) {
    await pkillExactProcessName(daemonName, "-TERM")
    await waitForExactProcessNameToExit(daemonName)

    if (await isExactProcessNameRunning(daemonName)) {
      await pkillExactProcessName(daemonName, "-KILL")
      await waitForExactProcessNameToExit(daemonName)
    }
  }
}

async function startLiveWallpaperProcess(path: string) {
  if (!MPVPAPER_BIN) throw new Error("mpvpaper is required for live wallpapers")

  let stderr = ""
  const command = [MPVPAPER_BIN, "-o", getMpvpaperOptions(), MPVPAPER_OUTPUT, path]
  const proc = subprocess({
    cmd: command,
    err: (error) => {
      stderr += String(error)
      console.error(error)
    },
  })

  liveWallpaperProcess = proc
  liveWallpaperPath = path

  await new Promise<void>((resolve, reject) => {
    let settled = false

    proc.connect("exit", (_self, code: number, signaled: boolean) => {
      if (liveWallpaperProcess === proc) {
        liveWallpaperProcess = null
        liveWallpaperPath = ""
      }

      if (settled) return
      settled = true

      const details = stderr.trim()
      reject(new Error(`mpvpaper exited with code ${code}${signaled ? " (signaled)" : ""}${details ? `: ${details}` : ""}`))
    })

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
      if (!settled) {
        settled = true
        resolve()
      }

      return GLib.SOURCE_REMOVE
    })
  })
}

function addCssClasses(widget: Gtk.Widget, classes: string) {
  for (const klass of classes.split(/\s+/)) {
    if (klass) widget.add_css_class(klass)
  }
}

function createWallpaperPreview(
  item: WallpaperItem,
  isActive: boolean,
  onApply: (item: WallpaperItem) => void,
) {
  let cancelTextureRequest = () => {}
  let destroyed = false

  const picture = new Gtk.Picture()
  addCssClasses(picture, "wallpaper-thumb")
  picture.set_content_fit(Gtk.ContentFit.COVER)
  picture.set_can_shrink(false)
  picture.set_overflow(Gtk.Overflow.HIDDEN)
  picture.set_halign(Gtk.Align.FILL)
  picture.set_valign(Gtk.Align.FILL)
  picture.set_hexpand(false)
  picture.set_vexpand(false)
  picture.set_size_request(CARD_WIDTH, CARD_HEIGHT)

  const thumbStack = new Gtk.Fixed({
    hexpand: false,
    vexpand: false,
    halign: Gtk.Align.START,
    valign: Gtk.Align.START,
  })
  addCssClasses(thumbStack, "wallpaper-thumb-stack")
  thumbStack.set_overflow(Gtk.Overflow.HIDDEN)
  thumbStack.set_size_request(CARD_WIDTH, CARD_HEIGHT)
  thumbStack.put(picture, 0, 0)

  if (isVideoWallpaperPath(item.path)) {
    const playIcon = new Gtk.Label({
      label: "󰐊",
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
    })
    addCssClasses(playIcon, "wallpaper-video-play-icon")
    playIcon.set_can_target(false)
    thumbStack.put(playIcon, 8, 6)
  }

  const wrap = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: false,
    vexpand: false,
    halign: Gtk.Align.START,
    valign: Gtk.Align.START,
  })
  addCssClasses(wrap, "wallpaper-thumb-wrap")
  wrap.set_overflow(Gtk.Overflow.HIDDEN)
  wrap.set_size_request(CARD_WIDTH, CARD_HEIGHT)
  wrap.append(thumbStack)

  const button = new Gtk.Button({
    child: wrap,
    hexpand: false,
    vexpand: false,
    halign: Gtk.Align.START,
    valign: Gtk.Align.START,
  })
  addCssClasses(button, "flat wallpaper-card")
  button.set_has_frame(false)
  button.set_focus_on_click(false)
  button.set_focusable(false)
  button.set_can_target(true)
  button.set_can_shrink(false)
  button.set_overflow(Gtk.Overflow.HIDDEN)
  button.set_size_request(CARD_WIDTH, CARD_HEIGHT)

  if (isActive) {
    wrap.add_css_class("wallpaper-thumb-wrap-active")
    picture.add_css_class("wallpaper-thumb-active")
  }

  const beginTextureLoad = () => {
    cancelTextureRequest()
    picture.set_paintable(null)

    const cachedTexture = wallpaperTextureCache.get(item.path)
    if (cachedTexture !== undefined) {
      if (cachedTexture) picture.set_paintable(cachedTexture)
      return
    }

    if (!getExistingWallpaperThumbnail(item.path)) return

    cancelTextureRequest = requestWallpaperTexture(item.path, (texture) => {
      cancelTextureRequest = () => {}
      if (destroyed || !texture) return
      picture.set_paintable(texture)
    })
  }

  const cancelPendingTextureLoad = () => {
    cancelTextureRequest()
    cancelTextureRequest = () => {}
  }

  button.connect("clicked", () => onApply(item))
  picture.connect("map", beginTextureLoad)
  picture.connect("unmap", cancelPendingTextureLoad)
  picture.connect("destroy", () => {
    destroyed = true
    cancelPendingTextureLoad()
  })

  return button
}

export function WallpaperWidgetButton({ monitor }: { monitor: number }) {
  const initialSettings = readWallpaperSettings()
  const [wallpaperDir, setWallpaperDir] = createState(initialSettings.directory ?? DEFAULT_WALLPAPER_DIR)
  const [wallpapers, setWallpapers] = createState<WallpaperItem[]>(listWallpapers(wallpaperDir()))
  const [notice, setNotice] = createState<string | null>(null)
  const [refreshing, setRefreshing] = createState(false)
  const [applying, setApplying] = createState(false)
  const [activePath, setActivePath] = createState(initialSettings.currentWallpaper ?? "")

  const countLabel = createComputed(() => `${wallpapers().length}`)
  const [visibleCount, setVisibleCount] = createState(WALLPAPER_INITIAL_VISIBLE_ITEMS)
  const emptyMetaLabel = createComputed(() => `Put PNG, JPG, WEBP, MP4, MKV, WEBM or MOV files into ${formatWallpaperDirectory(wallpaperDir())}`)

  let wallpaperGridRef: Gtk.Box | null = null
  let wallpaperGridRenderSourceId = 0
  let wallpaperGridRenderedCount = 0
  let wallpaperScrollWindow: Gtk.ScrolledWindow | null = null
  let wallpaperScrollAnimationTickId = 0
  let wallpaperScrollAnimationWidget: Gtk.Widget | null = null
  let wallpaperScrollLastFrameTimeUs = 0
  let wallpaperScrollTarget = 0

  const clearWallpaperGridRender = () => {
    if (wallpaperGridRenderSourceId === 0) return
    GLib.source_remove(wallpaperGridRenderSourceId)
    wallpaperGridRenderSourceId = 0
  }

  const stopWallpaperSmoothScroll = () => {
    if (wallpaperScrollAnimationTickId === 0) return

    const tickId = wallpaperScrollAnimationTickId
    const tickWidget = wallpaperScrollAnimationWidget
    wallpaperScrollAnimationTickId = 0
    wallpaperScrollAnimationWidget = null
    wallpaperScrollLastFrameTimeUs = 0

    try {
      tickWidget?.remove_tick_callback(tickId)
    } catch (error) {
      console.error(error)
    }
  }

  const finishWallpaperSmoothScroll = (adjustment: Gtk.Adjustment) => {
    adjustment.set_value(wallpaperScrollTarget)
    wallpaperScrollAnimationTickId = 0
    wallpaperScrollAnimationWidget = null
    wallpaperScrollLastFrameTimeUs = 0
  }

  const animateWallpaperScroll = (dy: number) => {
    const scroller = wallpaperScrollWindow
    const adjustment = scroller?.get_vadjustment()
    if (!scroller || !adjustment) return false

    const lower = adjustment.get_lower()
    const upper = Math.max(lower, adjustment.get_upper() - adjustment.get_page_size())
    if (upper <= lower) return false

    const current = adjustment.get_value()
    const delta = dy * WALLPAPER_SMOOTH_SCROLL_STEP
    const base = wallpaperScrollAnimationTickId !== 0 ? wallpaperScrollTarget : current
    wallpaperScrollTarget = Math.max(lower, Math.min(upper, base + delta))

    if (wallpaperScrollAnimationTickId !== 0) return true

    wallpaperScrollLastFrameTimeUs = scroller.get_frame_clock()?.get_frame_time() ?? 0
    wallpaperScrollAnimationWidget = scroller
    wallpaperScrollAnimationTickId = scroller.add_tick_callback((_widget, frameClock) => {
      const nextCurrent = adjustment.get_value()
      const nextLower = adjustment.get_lower()
      const nextUpper = Math.max(nextLower, adjustment.get_upper() - adjustment.get_page_size())
      wallpaperScrollTarget = Math.max(nextLower, Math.min(nextUpper, wallpaperScrollTarget))

      const distance = wallpaperScrollTarget - nextCurrent
      if (Math.abs(distance) <= WALLPAPER_SMOOTH_SCROLL_SNAP_DISTANCE) {
        finishWallpaperSmoothScroll(adjustment)
        return false
      }

      const frameTimeUs = frameClock.get_frame_time()
      const elapsedMs = wallpaperScrollLastFrameTimeUs > 0
        ? Math.max(0, Math.min(WALLPAPER_SMOOTH_SCROLL_MAX_FRAME_MS, (frameTimeUs - wallpaperScrollLastFrameTimeUs) / 1000))
        : 1000 / 300
      wallpaperScrollLastFrameTimeUs = frameTimeUs

      const progress = 1 - Math.exp(-elapsedMs / WALLPAPER_SMOOTH_SCROLL_TIME_CONSTANT_MS)
      adjustment.set_value(nextCurrent + distance * progress)
      return true
    })

    return true
  }

  const clearWallpaperGridChildren = (grid: Gtk.Box) => {
    let child = grid.get_first_child()

    while (child) {
      const next = child.get_next_sibling()
      grid.remove(child)
      child = next
    }

    wallpaperGridRenderedCount = 0
  }

  const appendWallpaperGridRows = (startIndex: number, endIndex: number) => {
    const grid = wallpaperGridRef
    if (!grid || endIndex <= startIndex) return false

    const rows = chunkWallpapers(wallpapers().slice(startIndex, endIndex), GRID_COLUMNS)

    for (const row of rows) {
      const rowBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: GRID_GAP,
        hexpand: false,
        vexpand: false,
        halign: Gtk.Align.START,
        valign: Gtk.Align.START,
      })

      rowBox.add_css_class("wallpaper-grid-row")

      for (const item of row) {
        rowBox.append(createWallpaperPreview(
          item,
          activePath() === item.path,
          (selected) => void applyWallpaper(selected),
        ))
      }

      grid.append(rowBox)
    }

    wallpaperGridRenderedCount = endIndex
    return true
  }

  const renderWallpaperGrid = () => {
    const grid = wallpaperGridRef
    if (!grid) return

    clearWallpaperGridChildren(grid)
    appendWallpaperGridRows(0, visibleCount())
  }

  const scheduleWallpaperGridRender = () => {
    if (wallpaperGridRenderSourceId !== 0) return

    wallpaperGridRenderSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      wallpaperGridRenderSourceId = 0
      renderWallpaperGrid()
      return GLib.SOURCE_REMOVE
    })
  }

  const setActiveWallpaperPath = (path: string) => {
    setActivePath(path)
    scheduleWallpaperGridRender()
  }

  const resetVisibleWallpapers = (items: WallpaperItem[] = wallpapers()) => {
    setVisibleCount(Math.min(items.length, WALLPAPER_INITIAL_VISIBLE_ITEMS))
    scheduleWallpaperGridRender()
  }

  const loadMoreWallpapers = () => {
    const total = wallpapers().length
    const currentCount = visibleCount()
    if (currentCount >= total) return

    const nextCount = Math.min(total, currentCount + WALLPAPER_LOAD_MORE_ITEMS)
    setVisibleCount(nextCount)

    if (wallpaperGridRenderSourceId === 0 && wallpaperGridRenderedCount === currentCount) {
      appendWallpaperGridRows(currentCount, nextCount)
      return
    }

    scheduleWallpaperGridRender()
  }

  const settleUiFrame = () => new Promise<void>((resolve) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })

  const syncActiveWallpaper = async () => {
    const savedPath = readWallpaperSettings().currentWallpaper ?? ""

    if (isTrackedLiveWallpaperRunning()) {
      setActiveWallpaperPath(liveWallpaperPath)
      return
    }

    if (!WALLPAPER_CLI_BIN) {
      setActiveWallpaperPath(savedPath)
      return
    }

    try {
      const output = await execAsync([WALLPAPER_CLI_BIN, "query"])
      const currentPaths = parseCurrentWallpaperPaths(String(output ?? ""))
      if (currentPaths.size === 1) {
        const [onlyPath] = [...currentPaths]
        setActiveWallpaperPath(onlyPath ?? "")
        return
      }
    } catch {
    }

    setActiveWallpaperPath(savedPath)
  }

  const ensureStaticWallpaperDaemon = async () => {
    if (!WALLPAPER_DAEMON_BIN) return false

    try {
      await execAsync([WALLPAPER_CLI_BIN, "query"])
      return true
    } catch {
    }

    try {
      void execAsync([WALLPAPER_DAEMON_BIN])
    } catch {
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise<void>((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
          resolve()
          return GLib.SOURCE_REMOVE
        })
      })

      try {
        await execAsync([WALLPAPER_CLI_BIN, "query"])
        return true
      } catch {
      }
    }

    return false
  }

  const runStaticWallpaperApplyCommand = async (path: string, animated = true) => {
    if (!WALLPAPER_CLI_BIN) {
      throw new Error("awww is not available in PATH")
    }

    await ensureStaticWallpaperDaemon()

    const commands = animated
      ? [
        [WALLPAPER_CLI_BIN, "img", path, ...WALLPAPER_STATIC_TRANSITION_ARGS],
        [
          WALLPAPER_CLI_BIN,
          "img",
          path,
          "--transition-type",
          "outer",
          "--transition-pos",
          "center",
          "--transition-duration",
          "0.8",
          "--transition-fps",
          "120",
          "--transition-step",
          "24",
        ],
        [
          WALLPAPER_CLI_BIN,
          "img",
          path,
          "--transition-type",
          "simple",
          "--transition-duration",
          "0.7",
          "--transition-fps",
          "120",
          "--transition-step",
          "8",
        ],
        [WALLPAPER_CLI_BIN, "img", path],
      ]
      : [[WALLPAPER_CLI_BIN, "img", path]]

    let lastError: unknown = null

    for (const command of commands) {
      try {
        await execAsync(command)
        return
      } catch (error) {
        lastError = error
      }
    }

    throw lastError ?? new Error("Failed to apply wallpaper")
  }

  const prepareLiveWallpaperTransitionFrame = async (path: string) => {
    const stillPath = await ensureVideoWallpaperStill(path)
    if (!stillPath || !WALLPAPER_CLI_BIN) return false

    try {
      await runStaticWallpaperApplyCommand(stillPath)
      await delayMs(WALLPAPER_VIDEO_TRANSITION_MS)
      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }

  const prepareStaticWallpaperReturnFrame = async () => {
    const currentLivePath = liveWallpaperPath
    if (!currentLivePath || !WALLPAPER_CLI_BIN) return false

    const stillPath = await ensureVideoWallpaperStill(currentLivePath)
    if (!stillPath) return false

    try {
      await runStaticWallpaperApplyCommand(stillPath, false)
      await delayMs(WALLPAPER_BACKEND_SETTLE_MS)
      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }

  const runWallpaperApplyCommand = async (path: string) => {
    if (isVideoWallpaperPath(path)) {
      if (isTrackedLiveWallpaperRunning(path)) return
      if (!MPVPAPER_BIN) throw new Error("mpvpaper is required for live wallpapers")

      if (isTrackedLiveWallpaperRunning()) {
        await prepareStaticWallpaperReturnFrame()
      }

      await stopLiveWallpaperProcesses()
      const animatedHandoff = await prepareLiveWallpaperTransitionFrame(path)
      await startLiveWallpaperProcess(path)
      if (animatedHandoff) await delayMs(WALLPAPER_VIDEO_HANDOFF_MS)
      await stopStaticWallpaperDaemons()
      return
    }

    if (!WALLPAPER_CLI_BIN) {
      throw new Error("awww is not available in PATH")
    }

    if (isTrackedLiveWallpaperRunning()) {
      await prepareStaticWallpaperReturnFrame()
    }

    await stopLiveWallpaperProcesses()
    await runStaticWallpaperApplyCommand(path)
  }

  const restoreSavedWallpaperOnce = () => {
    if (wallpaperStartupRestoreStarted) return
    wallpaperStartupRestoreStarted = true

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
      void (async () => {
        const savedPath = readWallpaperSettings().currentWallpaper ?? ""
        if (!savedPath) return

        try {
          await runWallpaperApplyCommand(savedPath)
          setActiveWallpaperPath(savedPath)
        } catch (error) {
          console.error(error)
        }
      })()

      return GLib.SOURCE_REMOVE
    })
  }

  const refreshWallpapers = async () => {
    if (refreshing() || applying()) return

    await settleUiFrame()
    setRefreshing(true)
    setNotice(null)

    try {
      resetWallpaperTexturePipeline()
      const items = listWallpaperFiles(wallpaperDir())

      if (items.length === 0) {
        setWallpapers([])
        resetVisibleWallpapers([])
        setNotice("Reloaded 0")
        return
      }

      const completed = await buildWallpaperThumbnails(items)

      if (!completed) return

      wallpaperTextureCache.clear()
      const readyItems = items.filter((item) => getExistingWallpaperThumbnail(item.path) !== null)
      if (!sameWallpaperItems(wallpapers(), readyItems)) {
        setWallpapers(readyItems)
        resetVisibleWallpapers(readyItems)
      }
      setNotice(readyItems.length === items.length ? `Reloaded ${readyItems.length}` : `Reloaded ${readyItems.length}/${items.length}`)
    } catch (error) {
      setNotice(formatError(error))
    } finally {
      setRefreshing(false)
    }
  }

  const applyWallpaper = async (item: WallpaperItem) => {
    if (refreshing() || applying()) return

    if (activePath() === item.path && isVideoWallpaperPath(item.path) && isTrackedLiveWallpaperRunning(item.path)) {
      setNotice("Wallpaper already active")
      return
    }

    await settleUiFrame()
    setApplying(true)
    clearApplyingCleanupTimeout()

    try {
      await runWallpaperApplyCommand(item.path)
      saveWallpaperSettings({ currentWallpaper: item.path })
      setActiveWallpaperPath(item.path)

      applyingCleanupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
        setNotice("Wallpaper applied")
        applyingCleanupTimeoutId = 0
        return GLib.SOURCE_REMOVE
      })
    } catch (error) {
      setNotice(formatError(error))
    } finally {
      setApplying(false)
    }
  }

  const chooseWallpaperDirectory = () => {
    if (refreshing() || applying()) return

    const chooser = new Gtk.FileChooserNative({
      title: "Choose wallpapers folder",
      action: Gtk.FileChooserAction.SELECT_FOLDER,
      acceptLabel: "Select",
      cancelLabel: "Cancel",
      modal: true,
    })

    const currentDir = wallpaperDir().trim()
    const initialDir = isAbsoluteDirectory(currentDir) ? currentDir : DEFAULT_WALLPAPER_DIR
    chooser.set_current_folder(Gio.File.new_for_path(initialDir))

    chooser.connect("response", async (_self, response) => {
      try {
        if (response !== Gtk.ResponseType.ACCEPT) return

        const selectedPath = chooser.get_file()?.get_path()?.trim() ?? ""
        if (!isAbsoluteDirectory(selectedPath)) {
          setNotice("Choose a valid folder")
          return
        }

        if (selectedPath === wallpaperDir()) {
          setNotice("Folder already selected")
          return
        }

        await settleUiFrame()
        setRefreshing(true)
        setNotice(null)

        resetWallpaperTexturePipeline()
        saveWallpaperSettings({ directory: selectedPath })
        setWallpaperDir(selectedPath)
        const items = listWallpapers(selectedPath)
        setWallpapers(items)
        resetVisibleWallpapers(items)
        setNotice(`Folder set: ${formatWallpaperDirectory(selectedPath)} · hit reload to build previews`)
      } catch (error) {
        setNotice(formatError(error))
      } finally {
        setRefreshing(false)
        chooser.destroy()
      }
    })

    chooser.show()
  }

  const noticeText = createComputed(() => (notice() ?? "").trim())
  const folderTooltip = createComputed(() => noticeText().length > 0 ? noticeText() : "Choose wallpapers folder")
  const reloadTooltip = createComputed(() => noticeText().length > 0 ? noticeText() : "Reload wallpapers folder")
  const prepareHeaderActionButton = (self: Gtk.Button) => {
    self.set_focus_on_click(false)
    self.set_focusable(false)
  }

  const createPopoverContent = () => (
    <box
      class="wallpaper-popover"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={10}
      widthRequest={POPOVER_WIDTH}
    >
      <box class="wallpaper-header" spacing={10} valign={Gtk.Align.START}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <box class="wallpaper-header-top" spacing={8} valign={Gtk.Align.CENTER}>
            <label class="wallpaper-header-icon" label={"󰸉"} />
            <label class="wallpaper-title" xalign={0} label="Wallpapers" />
            <label class="wallpaper-count" label={countLabel} />
          </box>
          <box class="wallpaper-path-actions" spacing={0} valign={Gtk.Align.CENTER} halign={Gtk.Align.START}>
            <button
              class="flat wallpaper-refresh-button"
              onClicked={chooseWallpaperDirectory}
              $={(self) => {
                prepareHeaderActionButton(self)
                attachShellTooltip(self, folderTooltip)
              }}
            >
              <label class="wallpaper-refresh-icon" label={"󰉋"} />
            </button>

            <button
              class="flat wallpaper-refresh-button"
              onClicked={() => void refreshWallpapers()}
              $={(self) => {
                prepareHeaderActionButton(self)
                attachShellTooltip(self, reloadTooltip)
              }}
            >
              <label class="wallpaper-refresh-icon" label={"󰑐"} />
            </button>
          </box>
        </box>

        <box class="wallpaper-header-actions" spacing={6} halign={Gtk.Align.END} valign={Gtk.Align.START}>
          <button
            class={audioThreadVisualizerEnabled((value) => value
              ? "flat wallpaper-refresh-button wallpaper-refresh-button-active"
              : "flat wallpaper-refresh-button")}
            onClicked={() => toggleAudioThreadVisualizer()}
            $={(self) => {
              prepareHeaderActionButton(self)
              attachShellTooltip(self, () => audioThreadVisualizerEnabled() ? "Disable bottom audio thread" : "Enable bottom audio thread")
            }}
          >
            <label class="wallpaper-refresh-icon" label={"󰺢"} />
          </button>

          <button
            class={workspaceIndicatorVisible((value) => value
              ? "flat wallpaper-refresh-button wallpaper-refresh-button-active"
              : "flat wallpaper-refresh-button")}
            onClicked={() => toggleWorkspaceIndicatorVisible()}
            $={(self) => {
              prepareHeaderActionButton(self)
              attachShellTooltip(self, () => workspaceIndicatorVisible() ? "Hide workspace indicator" : "Show workspace indicator")
            }}
          >
            <label class="wallpaper-refresh-icon" label={"󰕰"} />
          </button>

          <button
            class={playerPinned((value) => value
              ? "flat wallpaper-refresh-button wallpaper-refresh-button-active"
              : "flat wallpaper-refresh-button")}
            onClicked={() => togglePlayerPinned()}
            $={(self) => {
              prepareHeaderActionButton(self)
              attachShellTooltip(self, () => playerPinned() ? "Hide player in bar" : "Show player in bar")
            }}
          >
            <label class="wallpaper-refresh-icon" label={playerPinned((value) => value ? "󰎇" : "󰎈")} />
          </button>

        </box>
      </box>

      <box class="wallpaper-gallery-frame" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
        <box visible={wallpapers((items) => items.length > 0)}>
          <Gtk.ScrolledWindow
            class="wallpaper-list-wrap"
            widthRequest={SCROLLER_WIDTH}
            minContentWidth={SCROLLER_WIDTH}
            minContentHeight={SCROLLER_MIN_HEIGHT}
            maxContentHeight={SCROLLER_HEIGHT}
            propagateNaturalHeight={true}
            propagateNaturalWidth={false}
            kineticScrolling={false}
            vexpand={false}
            hexpand={false}
            valign={Gtk.Align.START}
            halign={Gtk.Align.START}
            $={(self) => {
              wallpaperScrollWindow = self
              self.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
              self.set_kinetic_scrolling(false)

              const adjustment = self.get_vadjustment()
              const maybeLoadMore = () => {
                const remaining = adjustment.get_upper() - adjustment.get_page_size() - adjustment.get_value()
                if (remaining <= WALLPAPER_LOAD_MORE_THRESHOLD) loadMoreWallpapers()
              }

              const valueChangedId = adjustment.connect("value-changed", maybeLoadMore)
              const changedId = adjustment.connect("changed", maybeLoadMore)

              GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                maybeLoadMore()
                return GLib.SOURCE_REMOVE
              })

              self.connect("destroy", () => {
                if (wallpaperScrollWindow === self) wallpaperScrollWindow = null
                stopWallpaperSmoothScroll()
                adjustment.disconnect(valueChangedId)
                adjustment.disconnect(changedId)
              })
            }}
          >
            <Gtk.EventControllerScroll
              flags={Gtk.EventControllerScrollFlags.VERTICAL}
              onScroll={(_, _dx, dy) => {
                if (Math.abs(dy) < 0.0001) return false
                return animateWallpaperScroll(dy)
              }}
            />
            <box
              class="wallpaper-grid-rows"
              orientation={Gtk.Orientation.VERTICAL}
              spacing={GRID_GAP}
              widthRequest={SCROLLER_WIDTH}
              hexpand={false}
              vexpand={false}
              halign={Gtk.Align.START}
              valign={Gtk.Align.START}
              $={(self) => {
                wallpaperGridRef = self
                scheduleWallpaperGridRender()

                self.connect("destroy", () => {
                  if (wallpaperGridRef === self) wallpaperGridRef = null
                  clearWallpaperGridRender()
                })
              }}
            />
          </Gtk.ScrolledWindow>
        </box>

        <box
          class="wallpaper-empty-wrap"
          visible={wallpapers((items) => items.length === 0)}
          widthRequest={SCROLLER_WIDTH}
          heightRequest={SCROLLER_HEIGHT}
        >
          <box
            class="wallpaper-empty"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            hexpand
            vexpand
          >
            <label class="wallpaper-empty-icon" label={"󰸉"} />
            <label class="wallpaper-empty-title" label="No wallpapers found" />
            <label class="wallpaper-empty-meta" wrap={true} justify={Gtk.Justification.CENTER} maxWidthChars={40} label={emptyMetaLabel} />
          </box>
        </box>
      </box>

    </box>
  )

  let trigger: Gtk.ToggleButton | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let closeTimeoutId = 0
  let applyingCleanupTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `wallpaper:${monitor}`
  const clearApplyingCleanupTimeout = () => {
    if (applyingCleanupTimeoutId !== 0) {
      GLib.source_remove(applyingCleanupTimeoutId)
      applyingCleanupTimeoutId = 0
    }
  }

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger || trigger.active === open) return
    trigger.active = open
  }

  const syncPopupPosition = () => {
    placeLayerWindowFromTrigger(trigger, popupWindowRef, popupFrame, {
      offsetX: -10,
      offsetY: WALLPAPER_POPOVER_OFFSET_Y,
      align: "start",
    })
  }

  const finishClosePopup = () => {
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const isPopupRevealed = () => Boolean(popupRevealer?.get_reveal_child())

  const resetStalePopupState = () => {
    finishClosePopup()
  }

  const closePopup = () => {
    if (!windowVisible()) {
      closingPopup = false
      setTriggerOpen(false)
      return
    }

    if (closingPopup) {
      finishClosePopup()
      return
    }

    closingPopup = true

    if (isPopupRevealed()) {
      popupRevealer!.revealChild = false
      clearCloseTimeout()
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WALLPAPER_POPOVER_REVEAL_DURATION_MS, () => {
        closeTimeoutId = 0
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const unregisterPopupController = registerPopupController(popupRegistryId, { close: closePopup })

  const openPopup = () => {
    if (windowVisible()) {
      if (closingPopup || !isPopupRevealed()) resetStalePopupState()
      else {
        syncPopupPosition()
        return
      }
    }

    closeOtherPopups(popupRegistryId)
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState()
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (closingPopup) {
      return
    }

    if (windowVisible()) {
      if (!isPopupRevealed()) {
        resetStalePopupState()
        openPopup()
        return
      }

      closePopup()
      return
    }

    openPopup()
  }

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-wallpaper"
      class="widget-popup-window wallpaper-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={LEFT_TOP_POPUP_ANCHOR}
      $={(self) => {
        popupWindowRef = self
        try {
          self.set_default_size(-1, -1)
        } catch {}
        self.connect("destroy", () => {
          unregisterPopupController()
          popupWindowRef = null
          popupRevealer = null
          popupFrame = null
          popupRoot = null
        })
      }}
    >
      <box class="widget-popup-root" $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachPopupFocusDismiss(self, closePopup)
        attachEscapeKey(self, closePopup)
      }}>
        <box
          class="widget-popup-placement"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={WALLPAPER_POPOVER_REVEAL_DURATION_MS}
            $={(self) => {
              popupRevealer = self
            }}
          >
            <box
              class="widget-popup-frame wallpaper-popover-window"
              widthRequest={POPOVER_WIDTH}
              $={(self) => {
                clipRoundedWidget(self)
                popupFrame = self
              }}
            >
              {createPopoverContent()}
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <Gtk.ToggleButton
      class="wallpaper-widget-trigger left-module-button"
      onClicked={() => {
        togglePopup()
      }}
      $={(self) => {
        trigger = self
        attachShellTooltip(self, "Wallpapers")

        void syncActiveWallpaper()
        restoreSavedWallpaperOnce()
        self.connect("destroy", () => {
          clearCloseTimeout()
          clearApplyingCleanupTimeout()
          resetWallpaperTexturePipeline()
          closingPopup = false
          setWindowVisible(false)
        })
      }}
    >
      <label class="wallpaper-trigger-icon" label={"󰸉"} />
    </Gtk.ToggleButton>
  )
}
