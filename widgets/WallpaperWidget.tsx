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

const WALLPAPER_DIR = GLib.build_filenamev([GLib.get_home_dir(), "Pictures", "Wallpaper"])
const WALLPAPER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])
const GRID_COLUMNS = 3
const CARD_WIDTH = 144
const CARD_HEIGHT = 84
const PREVIEW_LOAD_WIDTH = CARD_WIDTH * 2
const PREVIEW_LOAD_HEIGHT = CARD_HEIGHT * 2
const GRID_GAP = 8
const SCROLLER_WIDTH = GRID_COLUMNS * CARD_WIDTH + GRID_GAP * (GRID_COLUMNS - 1)
const GRID_VISIBLE_ROWS = 4
const SCROLLER_HEIGHT = CARD_HEIGHT * GRID_VISIBLE_ROWS + GRID_GAP * (GRID_VISIBLE_ROWS - 1) + 40
const POPOVER_WIDTH = SCROLLER_WIDTH + 24
const WALLPAPER_POPOVER_REVEAL_DURATION_MS = 220
const WALLPAPER_POPOVER_OFFSET_Y = 20
const WALLPAPER_PREWARM_COUNT = 9
const wallpaperTextureCache = new Map<string, Gdk.Texture | null>()

function getWallpaperTexture(path: string) {
  if (wallpaperTextureCache.has(path)) return wallpaperTextureCache.get(path) ?? null

  try {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
      path,
      PREVIEW_LOAD_WIDTH,
      PREVIEW_LOAD_HEIGHT,
      true,
    )
    const texture = Gdk.Texture.new_for_pixbuf(pixbuf)
    wallpaperTextureCache.set(path, texture)
    return texture
  } catch (error) {
    console.error(error)
    wallpaperTextureCache.set(path, null)
    return null
  }
}

function listWallpapers(): WallpaperItem[] {
  try {
    const dir = Gio.File.new_for_path(WALLPAPER_DIR)
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
        path: GLib.build_filenamev([WALLPAPER_DIR, name]),
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
  const isActive = createComputed(() => activePath() === item.path)

  return (
    <button
      class="flat wallpaper-card"
      widthRequest={CARD_WIDTH}
      heightRequest={CARD_HEIGHT}
      onClicked={() => onApply(item)}
    >
      <box class="wallpaper-card-inner" widthRequest={CARD_WIDTH} heightRequest={CARD_HEIGHT} valign={Gtk.Align.FILL}>
        <box
          class={isActive((active) => active
            ? "wallpaper-thumb-wrap wallpaper-thumb-wrap-active"
            : "wallpaper-thumb-wrap")}
          widthRequest={CARD_WIDTH}
          heightRequest={CARD_HEIGHT}
          valign={Gtk.Align.START}
        >
          <Gtk.Picture
            class="wallpaper-thumb"
            widthRequest={CARD_WIDTH}
            heightRequest={CARD_HEIGHT}
            hexpand
            vexpand
            $={(self) => {
              let idleId = 0

              self.set_content_fit(Gtk.ContentFit.COVER)
              self.set_can_shrink(true)
              self.set_halign(Gtk.Align.FILL)
              self.set_valign(Gtk.Align.FILL)
              self.set_size_request(CARD_WIDTH, CARD_HEIGHT)

              const cachedTexture = getWallpaperTexture(item.path)
              if (cachedTexture) {
                self.set_paintable(cachedTexture)
              } else {
                idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                  idleId = 0
                  const texture = getWallpaperTexture(item.path)
                  if (texture) self.set_paintable(texture)
                  return GLib.SOURCE_REMOVE
                })
              }

              self.connect("destroy", () => {
                if (idleId !== 0) GLib.source_remove(idleId)
              })
            }}
          />
        </box>
      </box>
    </button>
  )
}

export function WallpaperWidgetButton({ monitor }: { monitor: number }) {
  const [wallpapers, setWallpapers] = createState<WallpaperItem[]>(listWallpapers())
  const [notice, setNotice] = createState<string | null>(null)
  const [refreshing, setRefreshing] = createState(false)
  const [applying, setApplying] = createState(false)
  const [activePath, setActivePath] = createState("")

  const countLabel = createComputed(() => `${wallpapers().length}`)
  let previewWarmupSourceId = 0

  const cancelPreviewWarmup = () => {
    if (previewWarmupSourceId !== 0) {
      GLib.source_remove(previewWarmupSourceId)
      previewWarmupSourceId = 0
    }
  }

  const schedulePreviewWarmup = (items: WallpaperItem[]) => {
    cancelPreviewWarmup()

    const targets = items.slice(0, WALLPAPER_PREWARM_COUNT)
    let index = 0

    previewWarmupSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
      const next = targets[index++]
      if (!next) {
        previewWarmupSourceId = 0
        return GLib.SOURCE_REMOVE
      }

      getWallpaperTexture(next.path)
      return GLib.SOURCE_CONTINUE
    })
  }

  const settleUiFrame = () => new Promise<void>((resolve) => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })

  const syncActiveWallpaper = async () => {
    try {
      const output = await execAsync(["bash", "-lc", "swww query 2>/dev/null || true"])
      const currentPaths = parseCurrentWallpaperPaths(String(output ?? ""))
      if (currentPaths.size === 1) {
        const [onlyPath] = [...currentPaths]
        setActivePath(onlyPath ?? "")
      }
    } catch (error) {
      console.error(error)
    }
  }

  const runWallpaperApplyCommand = async (path: string) => {
    const commands = [
      [
        "swww",
        "img",
        "--transition-type",
        "fade",
        "--transition-duration",
        "0.55",
        "--transition-fps",
        "120",
        "--transition-step",
        "90",
        "--transition-bezier",
        ".25,1,.35,1",
        path,
      ],
      [
        "swww",
        "img",
        "--transition-type",
        "fade",
        "--transition-duration",
        "0.45",
        "--transition-fps",
        "90",
        "--transition-step",
        "80",
        path,
      ],
      ["swww", "img", "--transition-type", "fade", "--transition-duration", "0.35", path],
      ["swww", "img", path],
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
      const items = listWallpapers()
      setWallpapers(items)
      schedulePreviewWarmup(items)
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

  const refreshBusy = createComputed(() => refreshing() || applying())
  const noticeVisible = createComputed(() => (notice() ?? "").trim().length > 0)

  const popoverContent = (
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
            tooltipText={WALLPAPER_DIR}
            label="~/Pictures/Wallpaper"
          />
        </box>

        <button
          class="flat wallpaper-refresh-button"
          tooltipText="Reload wallpapers folder"
          sensitive={refreshBusy((value) => !value)}
          onClicked={() => void refreshWallpapers()}
        >
          <label class="wallpaper-refresh-icon" label={"󰑐"} />
        </button>
      </box>

      <box class="wallpaper-gallery-frame" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
        <box visible={wallpapers((items) => items.length > 0)}>
          <Gtk.ScrolledWindow
            class="wallpaper-list-wrap"
            widthRequest={SCROLLER_WIDTH}
            minContentWidth={SCROLLER_WIDTH}
            minContentHeight={SCROLLER_HEIGHT}
            maxContentHeight={SCROLLER_HEIGHT}
            propagateNaturalHeight={false}
            propagateNaturalWidth={false}
            $={(self) => {
              self.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            }}
          >
            <Gtk.FlowBox
              class="wallpaper-grid"
              $={(self) => {
                self.set_selection_mode(Gtk.SelectionMode.NONE)
                self.set_homogeneous(true)
                self.set_column_spacing(GRID_GAP)
                self.set_row_spacing(GRID_GAP)
                self.set_min_children_per_line(GRID_COLUMNS)
                self.set_max_children_per_line(GRID_COLUMNS)
                self.set_activate_on_single_click(false)
              }}
            >
              <For each={wallpapers}>
                {(item) => (
                  <WallpaperPreview
                    item={item}
                    activePath={activePath}
                    onApply={(selected) => void applyWallpaper(selected)}
                  />
                )}
              </For>
            </Gtk.FlowBox>
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
            <label class="wallpaper-empty-meta" label="Put PNG, JPG or WEBP files into ~/Pictures/Wallpaper" />
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
  let closeTimeoutId = 0
  let applyingCleanupTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

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
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const closePopup = () => {
    if (closingPopup || !windowVisible()) return

    closingPopup = true

    if (popupRevealer?.get_reveal_child()) {
      popupRevealer.revealChild = false
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WALLPAPER_POPOVER_REVEAL_DURATION_MS, () => {
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const openPopup = () => {
    if (windowVisible()) {
      syncPopupPosition()
      return
    }

    clearCloseTimeout()
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
    >
      <box class="widget-popup-root" hexpand vexpand $={(self) => {
        popupRoot = self
        self.set_focusable(true)
        attachEscapeKey(self, closePopup)
      }}>
        <Gtk.GestureClick
          button={0}
          onPressed={(_, _nPress, x, y) => {
            const root = popupPlacement?.get_parent?.() as Gtk.Widget | null
            if (isPointInsideWidget(popupFrame, root, x, y)) return
            closePopup()
          }}
        />

        <box
          class="widget-popup-placement"
          halign={Gtk.Align.START}
          valign={Gtk.Align.START}
          $={(self) => (popupPlacement = self)}
        >

          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
            transitionDuration={WALLPAPER_POPOVER_REVEAL_DURATION_MS}
            $={(revealer) => (popupRevealer = revealer)}
          >
            <box class="widget-popup-frame wallpaper-popover-window" widthRequest={POPOVER_WIDTH} $={(self) => (popupFrame = self)}>
              {popoverContent}
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

        schedulePreviewWarmup(wallpapers())
        void syncActiveWallpaper()
        self.connect("destroy", () => {
          cancelPreviewWarmup()
          clearCloseTimeout()
          closingPopup = false
          setWindowVisible(false)
        })
      }}
    >
      <label class="wallpaper-trigger-icon" label={"󰸉"} />
    </button>
  )
}
