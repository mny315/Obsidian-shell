import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { Astal } from "ags/gtk4"

import { For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"
import { attachEscapeKey } from "./EscapeKey"
import { FLOATING_POPUP_ANCHOR, isPointInsideWidget, placePopupFromTrigger } from "./FloatingPopup"

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
const WALLPAPER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])
const STATE_HOME = (() => {
  const configured = GLib.getenv("XDG_STATE_HOME")?.trim() ?? ""
  if (configured.length > 0 && GLib.path_is_absolute(configured)) return configured
  return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"])
})()
const WALLPAPER_STATE_DIR = GLib.build_filenamev([STATE_HOME, "ags"])
const WALLPAPER_SETTINGS_PATH = GLib.build_filenamev([WALLPAPER_STATE_DIR, "wallpaper-widget.json"])
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
const WALLPAPER_POPOVER_OFFSET_Y = 20
const WALLPAPER_INITIAL_VISIBLE_ITEMS = GRID_COLUMNS * GRID_VISIBLE_ROWS
const WALLPAPER_LOAD_MORE_ITEMS = GRID_COLUMNS * 2
const WALLPAPER_LOAD_MORE_THRESHOLD = CARD_HEIGHT + GRID_GAP
const WALLPAPER_TEXTURE_QUEUE_INTERVAL_MS = 12
const WALLPAPER_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), "obsidian-shell", "wallpaper-thumbs"])
const wallpaperTextureCache = new Map<string, Gdk.Texture | null>()
const wallpaperThumbnailPathCache = new Map<string, string>()
const wallpaperTextureSubscribers = new Map<string, Set<(texture: Gdk.Texture | null) => void>>()
const wallpaperTextureQueued = new Set<string>()
const wallpaperTextureQueue: string[] = []
let wallpaperTextureQueueSourceId = 0
let wallpaperThumbnailBuildGeneration = 0
const SWWW_BIN = GLib.find_program_in_path("swww")?.trim() ?? ""

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

  const key = GLib.compute_checksum_for_string(
    GLib.ChecksumType.SHA256,
    `${path}:${etag}:${CARD_WIDTH}x${CARD_HEIGHT}`,
    -1,
  )

  const thumbnailPath = GLib.build_filenamev([WALLPAPER_CACHE_DIR, `${key}.png`])
  wallpaperThumbnailPathCache.set(path, thumbnailPath)
  return thumbnailPath
}

function generateWallpaperThumbnail(path: string, thumbnailPath: string) {
  if (!ensureWallpaperCacheDir()) return null

  try {
    const source = GdkPixbuf.Pixbuf.new_from_file(path)
    const sourceWidth = source.get_width()
    const sourceHeight = source.get_height()

    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error(`Invalid image size for ${path}`)

    const scale = Math.max(CARD_WIDTH / sourceWidth, CARD_HEIGHT / sourceHeight)
    const scaledWidth = Math.max(CARD_WIDTH, Math.round(sourceWidth * scale))
    const scaledHeight = Math.max(CARD_HEIGHT, Math.round(sourceHeight * scale))
    const scaled = source.scale_simple(scaledWidth, scaledHeight, GdkPixbuf.InterpType.BILINEAR)

    if (!scaled) throw new Error(`Failed to scale preview for ${path}`)

    const cropX = Math.max(0, Math.floor((scaledWidth - CARD_WIDTH) / 2))
    const cropY = Math.max(0, Math.floor((scaledHeight - CARD_HEIGHT) / 2))
    const cropped = scaled.new_subpixbuf(cropX, cropY, CARD_WIDTH, CARD_HEIGHT)

    const tempPath = `${thumbnailPath}.tmp`
    cropped.savev(tempPath, "png", [], [])
    GLib.rename(tempPath, thumbnailPath)

    return thumbnailPath
  } catch (error) {
    console.error(error)
    return null
  }
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
      generateWallpaperThumbnail(item.path, thumbnailPath)
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

    return {
      directory: isAbsoluteDirectory(directory) ? directory : undefined,
      currentWallpaper: isExistingFilePath(currentWallpaper) ? currentWallpaper : undefined,
    } satisfies WallpaperWidgetSettings
  } catch {
    return {} as WallpaperWidgetSettings
  }
}

function readWallpaperDirectory() {
  return readWallpaperSettings().directory ?? DEFAULT_WALLPAPER_DIR
}

function saveWallpaperSettings(nextPatch: Partial<WallpaperWidgetSettings>) {
  try {
    const current = readWallpaperSettings()
    const next: WallpaperWidgetSettings = {
      ...current,
      ...nextPatch,
    }

    GLib.mkdir_with_parents(WALLPAPER_STATE_DIR, 0o700)
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

function listWallpapers(wallpaperDir: string): WallpaperItem[] {
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
      const lower = name.toLowerCase()
      const matchesImage = [...WALLPAPER_EXTENSIONS].some((ext) => lower.endsWith(ext))
      if (!matchesImage) continue

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

function chunkWallpapers(items: WallpaperItem[], chunkSize: number) {
  const rows: WallpaperItem[][] = []

  for (let index = 0; index < items.length; index += chunkSize) {
    rows.push(items.slice(index, index + chunkSize))
  }

  return rows
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

function WallpaperPreview({
  item,
  activePath,
  onApply,
}: {
  item: WallpaperItem
  activePath: () => string
  onApply: (item: WallpaperItem) => void
}) {
  const [hovered, setHovered] = createState(false)
  const wrapClass = createComputed(() => {
    const classes = ["wallpaper-thumb-wrap"]

    if (activePath() === item.path) classes.push("wallpaper-thumb-wrap-active")
    if (hovered()) classes.push("wallpaper-thumb-wrap-hover")

    return classes.join(" ")
  })

  const pictureClass = createComputed(() => {
    const classes = ["wallpaper-thumb"]

    if (activePath() === item.path) classes.push("wallpaper-thumb-active")
    if (hovered()) classes.push("wallpaper-thumb-hover")

    return classes.join(" ")
  })

  return (
    <button
      class="flat wallpaper-card"
      widthRequest={CARD_WIDTH}
      heightRequest={CARD_HEIGHT}
      hexpand={false}
      vexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
      onClicked={() => onApply(item)}
      $={(self) => {
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => setHovered(true))
        motion.connect("leave", () => setHovered(false))
        self.add_controller(motion)

        self.set_has_frame(false)
        self.set_focus_on_click(false)
        self.set_focusable(false)
        self.set_can_target(true)
        self.set_can_shrink(true)
        self.set_halign(Gtk.Align.START)
        self.set_valign(Gtk.Align.START)
        self.set_size_request(CARD_WIDTH, CARD_HEIGHT)
      }}
    >
      <box
        class={wrapClass}
        widthRequest={CARD_WIDTH}
        heightRequest={CARD_HEIGHT}
        hexpand={false}
        vexpand={false}
        halign={Gtk.Align.START}
        valign={Gtk.Align.START}
        overflow={Gtk.Overflow.HIDDEN}
      >

        <Gtk.Picture
          class={pictureClass}
          widthRequest={CARD_WIDTH}
          heightRequest={CARD_HEIGHT}
          hexpand={false}
          vexpand={false}
          halign={Gtk.Align.FILL}
          valign={Gtk.Align.FILL}
          $={(self) => {
            let cancelTextureRequest = () => {}
            let destroyed = false

            self.set_content_fit(Gtk.ContentFit.COVER)
            self.set_can_shrink(true)
            self.set_halign(Gtk.Align.FILL)
            self.set_valign(Gtk.Align.FILL)
            self.set_hexpand(false)
            self.set_vexpand(false)
            self.set_size_request(CARD_WIDTH, CARD_HEIGHT)

            const beginTextureLoad = () => {
              cancelTextureRequest()
              self.set_paintable(null)

              const cachedTexture = wallpaperTextureCache.get(item.path)
              if (cachedTexture !== undefined) {
                if (cachedTexture) self.set_paintable(cachedTexture)
                return
              }

              if (!getExistingWallpaperThumbnail(item.path)) return

              cancelTextureRequest = requestWallpaperTexture(item.path, (texture) => {
                cancelTextureRequest = () => {}
                if (destroyed || !texture) return
                self.set_paintable(texture)
              })
            }

            const cancelPendingTextureLoad = () => {
              cancelTextureRequest()
              cancelTextureRequest = () => {}
            }

            self.connect("map", beginTextureLoad)
            self.connect("unmap", cancelPendingTextureLoad)
            self.connect("destroy", () => {
              destroyed = true
              cancelPendingTextureLoad()
            })
          }}
        />
      </box>
    </button>
  )
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
  const visibleWallpapers = createComputed(() => wallpapers().slice(0, visibleCount()))
  const wallpaperRows = createComputed(() => chunkWallpapers(visibleWallpapers(), GRID_COLUMNS))
  const wallpaperPathLabel = createComputed(() => formatWallpaperDirectory(wallpaperDir()))
  const emptyMetaLabel = createComputed(() => `Put PNG, JPG or WEBP files into ${formatWallpaperDirectory(wallpaperDir())}`)

  const resetVisibleWallpapers = (items: WallpaperItem[] = wallpapers()) => {
    setVisibleCount(Math.min(items.length, WALLPAPER_INITIAL_VISIBLE_ITEMS))
  }

  const loadMoreWallpapers = () => {
    const total = wallpapers().length
    if (visibleCount() >= total) return
    setVisibleCount((current) => Math.min(total, current + WALLPAPER_LOAD_MORE_ITEMS))
  }

  const settleUiFrame = () => new Promise<void>((resolve) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })

  const syncActiveWallpaper = async () => {
    const savedPath = readWallpaperSettings().currentWallpaper ?? ""

    if (!SWWW_BIN) {
      setActivePath(savedPath)
      return
    }

    try {
      const output = await execAsync([SWWW_BIN, "query"])
      const currentPaths = parseCurrentWallpaperPaths(String(output ?? ""))
      if (currentPaths.size === 1) {
        const [onlyPath] = [...currentPaths]
        setActivePath(onlyPath ?? "")
        return
      }
    } catch {
      // Ignore missing daemon / query failures silently to avoid log spam on startup.
    }

    setActivePath(savedPath)
  }

  const runWallpaperApplyCommand = async (path: string) => {
    if (!SWWW_BIN) {
      throw new Error("swww is not available in PATH")
    }

    const commands = [
      [
        SWWW_BIN,
        "img",
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
        path,
      ],
      [
        SWWW_BIN,
        "img",
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
        path,
      ],
      [
        SWWW_BIN,
        "img",
        "--transition-type",
        "simple",
        "--transition-duration",
        "0.7",
        "--transition-fps",
        "120",
        "--transition-step",
        "8",
        path,
      ],
      [SWWW_BIN, "img", path],
    ]

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

  const refreshWallpapers = async () => {
    if (refreshing() || applying()) return

    await settleUiFrame()
    setRefreshing(true)
    setNotice(null)

    try {
      resetWallpaperTexturePipeline()
      const items = listWallpapers(wallpaperDir())
      setWallpapers(items)
      resetVisibleWallpapers(items)

      if (items.length === 0) {
        setNotice("Reloaded 0")
        return
      }

      setNotice(`Building previews 0/${items.length}`)
      const completed = await buildWallpaperThumbnails(items, (done, total) => {
        setNotice(`Building previews ${done}/${total}`)
      })

      if (!completed) return

      wallpaperTextureCache.clear()
      setWallpapers([...items])
      resetVisibleWallpapers(items)
      setNotice(`Reloaded ${items.length}`)
    } catch (error) {
      setNotice(formatError(error))
    } finally {
      setRefreshing(false)
    }
  }

  const applyWallpaper = async (item: WallpaperItem) => {
    if (refreshing() || applying()) return

    if (activePath() === item.path) {
      setNotice("Wallpaper already active")
      return
    }

    await settleUiFrame()
    setApplying(true)
    clearApplyingCleanupTimeout()

    try {
      await runWallpaperApplyCommand(item.path)
      saveWallpaperSettings({ currentWallpaper: item.path })
      setActivePath(item.path)
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

  const refreshBusy = createComputed(() => refreshing() || applying())
  const noticeVisible = createComputed(() => (notice() ?? "").trim().length > 0)

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
          <label
            class="wallpaper-path"
            xalign={0}
            ellipsize={Pango.EllipsizeMode.MIDDLE}
            maxWidthChars={44}
            tooltipText={wallpaperDir}
            label={wallpaperPathLabel}
          />
        </box>

        <box class="wallpaper-header-actions" spacing={6} valign={Gtk.Align.START}>
          <button
            class="flat wallpaper-refresh-button"
            tooltipText="Choose wallpapers folder"
            sensitive={refreshBusy((value) => !value)}
            onClicked={chooseWallpaperDirectory}
          >
            <label class="wallpaper-refresh-icon" label={"󰉋"} />
          </button>

          <button
            class="flat wallpaper-refresh-button"
            tooltipText="Reload wallpapers folder"
            sensitive={refreshBusy((value) => !value)}
            onClicked={() => void refreshWallpapers()}
          >
            <label class="wallpaper-refresh-icon" label={"󰑐"} />
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
            vexpand={false}
            hexpand={false}
            valign={Gtk.Align.START}
            halign={Gtk.Align.START}
            $={(self) => {
              self.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

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
                adjustment.disconnect(valueChangedId)
                adjustment.disconnect(changedId)
              })
            }}
          >
            <box
              class="wallpaper-grid-rows"
              orientation={Gtk.Orientation.VERTICAL}
              spacing={GRID_GAP}
              widthRequest={SCROLLER_WIDTH}
              hexpand={false}
              vexpand={false}
              halign={Gtk.Align.START}
              valign={Gtk.Align.START}
            >
              <For each={wallpaperRows}>
                {(row) => (
                  <box
                    class="wallpaper-grid-row"
                    spacing={GRID_GAP}
                    hexpand={false}
                    vexpand={false}
                    halign={Gtk.Align.START}
                    valign={Gtk.Align.START}
                  >
                    <For each={() => row}>
                      {(item) => (
                        <WallpaperPreview
                          item={item}
                          activePath={activePath}
                          onApply={(selected) => void applyWallpaper(selected)}
                        />
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
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

      <box
        class="wallpaper-notice-wrap"
        hexpand
        halign={Gtk.Align.FILL}
        visible={noticeVisible}
      >
        <label
          class="wallpaper-notice-label"
          hexpand
          xalign={0}
          ellipsize={Pango.EllipsizeMode.END}
          label={notice((value) => value ?? "")}
        />
      </box>
    </box>
  )

  let trigger: Gtk.Button | null = null
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let applyingCleanupTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)

  const clearApplyingCleanupTimeout = () => {
    if (applyingCleanupTimeoutId !== 0) {
      GLib.source_remove(applyingCleanupTimeoutId)
      applyingCleanupTimeoutId = 0
    }
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const syncPopupPosition = () => {
    placePopupFromTrigger(trigger, popupPlacement, popupFrame, {
      offsetX: -10,
      offsetY: WALLPAPER_POPOVER_OFFSET_Y,
      align: "start",
    })
  }

  const finishClosePopup = () => {
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const closePopup = () => {
    if (closingPopup || !windowVisible()) return

    closingPopup = true

    if (popupRevealer?.get_reveal_child()) {
      popupRevealer.revealChild = false
      if (!popupRevealer.get_child_revealed()) finishClosePopup()
      return
    }

    finishClosePopup()
  }

  const openPopup = () => {
    if (windowVisible()) {
      syncPopupPosition()
      return
    }

    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
  }

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      namespace="obsidian-shell"
      class="widget-popup-window wallpaper-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.EXCLUSIVE}
      anchor={FLOATING_POPUP_ANCHOR}
      $={(self) => {
        self.connect("destroy", () => {
          popupPlacement = null
          popupRevealer = null
          popupFrame = null
          popupRoot = null
        })
      }}
    >
      <box class="widget-popup-root" hexpand vexpand $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachEscapeKey(self, closePopup)
      }}>
        <Gtk.GestureClick
          button={0}
          propagationPhase={Gtk.PropagationPhase.CAPTURE}
          onReleased={(_, _nPress, x, y) => {
            const root = popupPlacement?.get_parent?.() as Gtk.Widget | null
            if (isPointInsideWidget(popupFrame, root, x, y)) return
            closePopup()
          }}
        />

        <box
          class="widget-popup-placement"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          overflow={Gtk.Overflow.HIDDEN}
          $={(self) => (popupPlacement = self)}
        >

          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.CROSSFADE}
            transitionDuration={WALLPAPER_POPOVER_REVEAL_DURATION_MS}
            overflow={Gtk.Overflow.HIDDEN}
            $={(revealer) => {
              popupRevealer = revealer

              const childRevealedId = revealer.connect("notify::child-revealed", () => {
                if (!revealer.get_reveal_child() && !revealer.get_child_revealed() && closingPopup) {
                  finishClosePopup()
                }
              })

              revealer.connect("destroy", () => {
                revealer.disconnect(childRevealedId)
              })
            }}
          >
            <box
              class="widget-popup-frame wallpaper-popover-window"
              widthRequest={POPOVER_WIDTH}
              overflow={Gtk.Overflow.HIDDEN}
              $={(self) => {
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
    <button
      class="wallpaper-widget-trigger left-module-button"
      tooltipText="Wallpapers"
      onClicked={togglePopup}
      $={(self) => {
        trigger = self

        void syncActiveWallpaper()
        self.connect("destroy", () => {
          clearApplyingCleanupTimeout()
          resetWallpaperTexturePipeline()
          closingPopup = false
          setWindowVisible(false)
        })
      }}
    >
      <label class="wallpaper-trigger-icon" label={"󰸉"} />
    </button>
  )
}
