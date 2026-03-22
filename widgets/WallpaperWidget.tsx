import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { Astal } from "ags/gtk4"

import { For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"
import { FLOATING_POPUP_ANCHOR, isPointInsideWidget, placePopupFromTrigger } from "./FloatingPopup"

type WallpaperItem = {
  name: string
  path: string
}

type TimerConfigState = {
  lockMinutes: number
  idleMinutes: number
}

type TimerKind = "lock" | "idle"

const WALLPAPER_DIR = GLib.build_filenamev([GLib.get_home_dir(), "Pictures", "Wallpaper"])
const HYPRIDLE_CONF = GLib.build_filenamev([GLib.get_home_dir(), ".config", "hypr", "hypridle.conf"])
const WALLPAPER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])
const GRID_COLUMNS = 3
const CARD_WIDTH = 144
const CARD_HEIGHT = 84
const PREVIEW_LOAD_WIDTH = CARD_WIDTH * 2
const PREVIEW_LOAD_HEIGHT = CARD_HEIGHT * 2
const GRID_GAP = 8
const SCROLLER_WIDTH = GRID_COLUMNS * CARD_WIDTH + GRID_GAP * (GRID_COLUMNS - 1)
const SCROLLER_HEIGHT = CARD_HEIGHT * 2 + GRID_GAP + 40
const POPOVER_WIDTH = SCROLLER_WIDTH + 24
const WALLPAPER_POPOVER_REVEAL_DURATION_MS = 220
const WALLPAPER_POPOVER_OFFSET_Y = 20
const WALLPAPER_PREWARM_COUNT = 9
const TIMERS_REVEAL_DURATION_MS = 240
const LOCK_MATCHERS = ["loginctl lock-session", "pidof hyprlock || hyprlock", "hyprlock"]
const IDLE_MATCHERS = ["hyprctl dispatch dpms off", "niri msg action power-off-monitors"]
const LOCK_FALLBACK_MINUTES = 5
const IDLE_FALLBACK_MINUTES = 6

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

function readTextFile(path: string) {
  try {
    const [, bytes] = GLib.file_get_contents(path)
    return new TextDecoder().decode(bytes as Uint8Array)
  } catch (error) {
    console.error(error)
    return ""
  }
}

function writeTextFile(path: string, text: string) {
  GLib.file_set_contents(path, text)
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

function findListenerTimeout(config: string, matchers: string[]) {
  const listeners = config.match(/listener\s*\{[\s\S]*?\}/g) ?? []

  for (const listener of listeners) {
    if (!matchers.some((matcher) => listener.includes(matcher))) continue

    const timeoutMatch = listener.match(/timeout\s*=\s*(\d+)/)
    if (timeoutMatch) return Number(timeoutMatch[1])
  }

  return null
}

function replaceListenerTimeout(config: string, matchers: string[], seconds: number) {
  let replaced = false

  const nextConfig = config.replace(/listener\s*\{[\s\S]*?\}/g, (listener) => {
    if (replaced) return listener
    if (!matchers.some((matcher) => listener.includes(matcher))) return listener
    if (!/timeout\s*=\s*\d+/.test(listener)) return listener

    replaced = true
    return listener.replace(/timeout\s*=\s*\d+/, `timeout = ${seconds}`)
  })

  return replaced ? nextConfig : null
}

function loadTimerConfig(): TimerConfigState {
  const config = readTextFile(HYPRIDLE_CONF)
  const lockSeconds = findListenerTimeout(config, LOCK_MATCHERS)
  const idleSeconds = findListenerTimeout(config, IDLE_MATCHERS)

  return {
    lockMinutes: Math.max(1, Math.round((lockSeconds ?? LOCK_FALLBACK_MINUTES * 60) / 60)),
    idleMinutes: Math.max(1, Math.round((idleSeconds ?? IDLE_FALLBACK_MINUTES * 60) / 60)),
  }
}

async function restartHypridle() {
  await execAsync([
    "bash",
    "-lc",
    "systemctl --user restart hypridle.service >/dev/null 2>&1 || (pkill -x hypridle >/dev/null 2>&1 || true; nohup hypridle >/dev/null 2>&1 &)",
  ])
}

function TimerRow({
  icon,
  title,
  subtitle,
  value,
  onDecrease,
  onIncrease,
  onApply,
  busy,
}: {
  icon: string
  title: string
  subtitle: string
  value: () => number
  onDecrease: () => void
  onIncrease: () => void
  onApply: () => void
  busy: () => boolean
}) {
  return (
    <box class="wallpaper-timer-row" spacing={10} valign={Gtk.Align.CENTER}>
      <box class="wallpaper-timer-meta" spacing={8} valign={Gtk.Align.CENTER} hexpand>
        <label class="wallpaper-timer-icon" label={icon} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <label class="wallpaper-timer-title" xalign={0} label={title} />
          <label class="wallpaper-timer-subtitle" xalign={0} label={subtitle} />
        </box>
      </box>

      <box class="wallpaper-timer-controls" spacing={8} valign={Gtk.Align.CENTER}>
        <button
          class="flat wallpaper-stepper-button"
          sensitive={busy((value) => !value)}
          onClicked={onDecrease}
        >
          <label class="wallpaper-stepper-icon" label={"󰍴"} />
        </button>

        <box class="wallpaper-timer-value-box" valign={Gtk.Align.CENTER}>
          <label class="wallpaper-timer-value" label={value((minutes) => `${minutes} min`)} />
        </box>

        <button
          class="flat wallpaper-stepper-button"
          sensitive={busy((value) => !value)}
          onClicked={onIncrease}
        >
          <label class="wallpaper-stepper-icon" label={"󰐕"} />
        </button>

        <button
          class="flat wallpaper-timer-apply"
          sensitive={busy((value) => !value)}
          onClicked={onApply}
        >
          <label class="wallpaper-timer-apply-label" label="Apply" />
        </button>
      </box>
    </box>
  )
}

function TimerDivider() {
  return <box class="wallpaper-timer-divider" />
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
  const initialTimers = loadTimerConfig()

  const [wallpapers, setWallpapers] = createState<WallpaperItem[]>(listWallpapers())
  const [notice, setNotice] = createState<string | null>(null)
  const [refreshing, setRefreshing] = createState(false)
  const [applying, setApplying] = createState(false)
  const [savingTimerKind, setSavingTimerKind] = createState<TimerKind | null>(null)
  const [activePath, setActivePath] = createState("")
  const [lockMinutes, setLockMinutes] = createState(initialTimers.lockMinutes)
  const [idleMinutes, setIdleMinutes] = createState(initialTimers.idleMinutes)
  const [timersExpanded, setTimersExpanded] = createState(false)

  const countLabel = createComputed(() => `${wallpapers().length}`)
  const timersSummary = createComputed(() => `Lock ${lockMinutes()} min · Idle ${idleMinutes()} min`)
  const timersChevronLabel = createComputed(() => timersExpanded() ? "▴" : "▾")
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

  const reloadTimerValues = () => {
    const nextTimers = loadTimerConfig()
    setLockMinutes(nextTimers.lockMinutes)
    setIdleMinutes(nextTimers.idleMinutes)
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
      reloadTimerValues()
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

  const saveTimer = async (kind: TimerKind) => {
    if (savingTimerKind() || applying() || refreshing()) return

    await settleUiFrame()
    setSavingTimerKind(kind)

    const targetLabel = kind === "lock" ? "Lock" : "Display idle"
    const matchers = kind === "lock" ? LOCK_MATCHERS : IDLE_MATCHERS
    const minutes = kind === "lock" ? lockMinutes() : idleMinutes()

    try {
      const config = readTextFile(HYPRIDLE_CONF)
      if (!config.trim()) {
        setNotice(`Missing ${HYPRIDLE_CONF}`)
        return
      }

      const updatedConfig = replaceListenerTimeout(config, matchers, minutes * 60)
      if (!updatedConfig) {
        setNotice(`${targetLabel} listener not found`)
        return
      }

      writeTextFile(HYPRIDLE_CONF, updatedConfig)
      await restartHypridle()
      setNotice(`${targetLabel} timer: ${minutes} min`)
    } catch (error) {
      setNotice(formatError(error))
    } finally {
      setSavingTimerKind(null)
    }
  }

  const refreshBusy = createComputed(() => refreshing() || applying())
  const lockTimerBusy = createComputed(() => savingTimerKind() === "lock" || refreshing() || applying())
  const idleTimerBusy = createComputed(() => savingTimerKind() === "idle" || refreshing() || applying())
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
        class={timersExpanded((open) => open
          ? "wallpaper-timeout-shell wallpaper-timeout-shell-open"
          : "wallpaper-timeout-shell")}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={0}
        widthRequest={SCROLLER_WIDTH}
      >
        <button
          class="flat wallpaper-timeout-capsule"
          tooltipText={timersExpanded((open) => open ? "Collapse timeout controls" : "Expand timeout controls")}
          onClicked={() => setTimersExpanded((open) => !open)}
        >
          <box class="wallpaper-timeout-summary" spacing={10} hexpand valign={Gtk.Align.CENTER}>
            <label class="wallpaper-timeout-icon" label={"󰒲"} />

            <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
              <label class="wallpaper-timeout-title" xalign={0} label="Timeouts" />
              <label class="wallpaper-timeout-subtitle" xalign={0} label={timersSummary} />
            </box>

            <label class="wallpaper-timeout-chevron" label={timersChevronLabel} />
          </box>
        </button>

        <revealer
          class="wallpaper-timeout-revealer"
          revealChild={timersExpanded}
          transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
          transitionDuration={TIMERS_REVEAL_DURATION_MS}
        >
          <box class="wallpaper-timeout-content" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
            <box class="wallpaper-timers" orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand>
              <TimerRow
                icon={"󰌾"}
                title="Lock timer"
                subtitle="Lock timeout"
                value={lockMinutes}
                busy={lockTimerBusy}
                onDecrease={() => setLockMinutes((value) => Math.max(1, value - 1))}
                onIncrease={() => setLockMinutes((value) => Math.min(240, value + 1))}
                onApply={() => void saveTimer("lock")}
              />

              <TimerDivider />

              <TimerRow
                icon={"󰒲"}
                title="Display timer"
                subtitle="Display off timeout"
                value={idleMinutes}
                busy={idleTimerBusy}
                onDecrease={() => setIdleMinutes((value) => Math.max(1, value - 1))}
                onIncrease={() => setIdleMinutes((value) => Math.min(240, value + 1))}
                onApply={() => void saveTimer("idle")}
              />
            </box>
          </box>
        </revealer>
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
  let popupAnchor: Gtk.Box | null = null
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
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
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
    >
      <box class="widget-popup-root" hexpand vexpand>
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
