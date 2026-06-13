import Gio from "gi://Gio"
import type App from "ags/gtk4/app"
import { Astal } from "ags/gtk4"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { For, createComputed, createState } from "ags"
import { AGS_STATE_DIR } from "../config"
import { attachEscapeKey } from "./EscapeKey"
import { LEFT_TOP_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowAtTopEdge } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"
import { attachSmoothVerticalScroll } from "./SmoothScroll"

type LaunchableApp = {
  key: string
  id: string
  name: string
  description: string
  executable: string
  categories: string[]
  shouldShow: boolean
  icon: Gio.Icon | null
  searchBlob: string
  appInfo: Gio.AppInfo
}

type LauncherCategoryId = "all" | "internet" | "media" | "office" | "games" | "development" | "system"

type LauncherCategory = {
  id: LauncherCategoryId
  label: string
  matches: string[]
}

const LAUNCHER_CATEGORIES: LauncherCategory[] = [
  { id: "all", label: "All", matches: [] },
  { id: "internet", label: "Web", matches: ["Network", "WebBrowser", "Email", "Chat", "InstantMessaging", "FileTransfer", "P2P"] },
  { id: "media", label: "Media", matches: ["AudioVideo", "Audio", "Video", "Player", "Recorder", "Music", "Photography", "Graphics"] },
  { id: "office", label: "Office", matches: ["Office", "WordProcessor", "Spreadsheet", "Presentation", "Calendar", "ContactManagement", "Education", "Science"] },
  { id: "games", label: "Games", matches: ["Game"] },
  { id: "development", label: "Dev", matches: ["Development", "IDE", "TextEditor", "Debugger", "GUIDesigner", "Profiling", "RevisionControl"] },
  { id: "system", label: "System", matches: ["System", "Settings", "Utility", "Security", "Monitor", "TerminalEmulator", "FileManager"] },
]

const LAUNCHER_TRIGGER_ICON = "󰀻"
const LAUNCHER_FALLBACK_ICON = "󰀻"
const LAUNCHER_HIDE_ICON = "󰛑"
const LAUNCHER_RESTORE_ICON = "󰗡"

const HIDDEN_APPS_STATE_PATH = GLib.build_filenamev([AGS_STATE_DIR, "hidden-launcher-apps.json"])

const launcherControllers = new Set<{ toggle: () => void; close: () => void }>()
let requestHandlerRegistered = false

export function registerAppLauncherRequestHandler(app: typeof App) {
  if (requestHandlerRegistered) return
  requestHandlerRegistered = true

  app.connect("request", (_app, request, respond) => {
    const parts = Array.isArray(request) ? request.map(String) : []
    const [scope, action] = parts

    if (scope !== "launcher") return

    const controller = [...launcherControllers][0]
    if (!controller) {
      respond("launcher unavailable")
      return
    }

    switch (action) {
      case "toggle":
        controller.toggle()
        respond("ok")
        return
      case "close":
        controller.close()
        respond("ok")
        return
      default:
        respond("unknown action")
        return
    }
  })
}

function normalizeText(text: string) {
  return text.normalize("NFKD").toLowerCase().replace(/\s+/g, " ").trim()
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function getDescription(info: Gio.AppInfo) {
  try {
    return safeText((info as Gio.DesktopAppInfo).get_description?.())
  } catch {
    return ""
  }
}

function getKeywords(info: Gio.AppInfo) {
  try {
    const raw = (info as Gio.DesktopAppInfo).get_keywords?.()
    return Array.isArray(raw) ? raw.filter(Boolean).join(" ") : ""
  } catch {
    return ""
  }
}

function getCategories(info: Gio.AppInfo) {
  try {
    const raw = (info as Gio.DesktopAppInfo).get_categories?.()
    if (Array.isArray(raw)) return raw.map(safeText).filter(Boolean)
    if (typeof raw !== "string") return []

    return raw.split(";").map(safeText).filter(Boolean)
  } catch {
    return []
  }
}

function buildAppKey(id: string, name: string, executable: string) {
  const normalizedId = safeText(id)
  if (normalizedId) return `id:${normalizedId}`

  const normalizedExecutable = safeText(executable)
  const normalizedName = safeText(name)
  return `fallback:${normalizedExecutable}::${normalizedName}`
}

function getShouldShow(info: Gio.AppInfo) {
  try {
    return info.should_show()
  } catch {
    return false
  }
}

function readHiddenAppKeys() {
  try {
    const [ok, contents] = GLib.file_get_contents(HIDDEN_APPS_STATE_PATH)
    if (!ok || !contents) return []

    const parsed = JSON.parse(new TextDecoder().decode(contents))
    if (!Array.isArray(parsed)) return []

    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  } catch {
    return []
  }
}

function saveHiddenAppKeys(keys: string[]) {
  try {
    GLib.mkdir_with_parents(AGS_STATE_DIR, 0o700)
    GLib.file_set_contents(HIDDEN_APPS_STATE_PATH, JSON.stringify(keys))
  } catch {}
}

function readApps(): LaunchableApp[] {
  const seen = new Set<string>()
  const apps: LaunchableApp[] = []

  for (const info of Gio.AppInfo.get_all()) {
    const shouldShow = getShouldShow(info)
    const name = safeText(info.get_display_name?.() ?? info.get_name?.())
    if (!name) continue

    const id = safeText(info.get_id?.())
    const executable = safeText(info.get_executable?.())
    const description = getDescription(info)
    const keywords = getKeywords(info)
    const categories = getCategories(info)
    const dedupeKey = `${id}::${name}::${executable}`

    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    apps.push({
      key: buildAppKey(id, name, executable),
      id,
      name,
      description,
      executable,
      categories,
      shouldShow,
      icon: info.get_icon?.() ?? null,
      searchBlob: normalizeText([name, description, executable, keywords, id, categories.join(" ")].filter(Boolean).join(" ")),
      appInfo: info,
    })
  }

  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return apps
}

let launcherAppsCache: LaunchableApp[] | null = null
const launcherAppsSubscribers = new Set<(apps: LaunchableApp[]) => void>()

function getCachedApps() {
  if (!launcherAppsCache) launcherAppsCache = readApps()
  return launcherAppsCache
}

function refreshCachedApps() {
  launcherAppsCache = readApps()

  for (const subscriber of launcherAppsSubscribers) {
    try {
      subscriber(launcherAppsCache)
    } catch {}
  }

  return launcherAppsCache
}

function subscribeCachedApps(subscriber: (apps: LaunchableApp[]) => void) {
  launcherAppsSubscribers.add(subscriber)
  return () => launcherAppsSubscribers.delete(subscriber)
}

const APP_LIST_REFRESH_DEBOUNCE_MS = 180
const LAUNCHER_POPOVER_REVEAL_DURATION_MS = 170
const LAUNCHER_LIST_SWITCH_ANIMATION_MS = 150
const LAUNCHER_POPOVER_WIDTH = 392
const LAUNCHER_LIST_HEIGHT = 300

function getApplicationMonitorRoots() {
  const roots = new Set<string>()
  const dataDirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]

  for (const dir of dataDirs) {
    const normalized = safeText(dir)
    if (!normalized || !GLib.path_is_absolute(normalized)) continue

    roots.add(normalized)
    roots.add(GLib.build_filenamev([normalized, "applications"]))
  }

  return [...roots]
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error.trim()
  return "Failed to launch application"
}

function getLauncherCategory(id: LauncherCategoryId) {
  return LAUNCHER_CATEGORIES.find((category) => category.id === id) ?? LAUNCHER_CATEGORIES[0]
}

const LAUNCHER_CATEGORY_PRIORITY: LauncherCategoryId[] = ["games", "development", "internet", "media", "office", "system"]

function getAppPrimaryCategory(app: LaunchableApp): LauncherCategoryId | null {
  const appCategories = new Set(app.categories.map((value) => value.toLowerCase()))

  for (const categoryId of LAUNCHER_CATEGORY_PRIORITY) {
    const category = getLauncherCategory(categoryId)
    if (category.matches.some((value) => appCategories.has(value.toLowerCase()))) return categoryId
  }

  return null
}

function appMatchesCategory(app: LaunchableApp, categoryId: LauncherCategoryId) {
  if (categoryId === "all") return true
  return getAppPrimaryCategory(app) === categoryId
}

export function AppLauncherControl({
  monitor,
  bindBarHoverWatcher,
}: {
  monitor: number
  bindBarHoverWatcher?: (watcher: (hovered: boolean) => void) => void
} = {
  monitor: 0,
}) {
  let trigger: Gtk.ToggleButton | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let searchEntry: Gtk.SearchEntry | null = null
  let launcherScrollWindow: Gtk.ScrolledWindow | null = null
  let launcherListContent: Gtk.Box | null = null
  let launcherSmoothScrollCleanup: (() => void) | null = null
  let launcherListAnimationTimeoutId = 0
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `launcher:${monitor}`

  void bindBarHoverWatcher

  const [query, setQuery] = createState("")
  const [notice, setNotice] = createState<string | null>(null)
  const [installedApps, setInstalledApps] = createState<LaunchableApp[]>(getCachedApps())
  const [hiddenAppKeys, setHiddenAppKeysState] = createState<string[]>(readHiddenAppKeys())
  const [selectedCategory, setSelectedCategory] = createState<LauncherCategoryId>("all")
  const [renderedCategory, setRenderedCategory] = createState<LauncherCategoryId>("all")
  const unsubscribeCachedApps = subscribeCachedApps(setInstalledApps)
  let appDirectoryMonitors: Gio.FileMonitor[] = []
  let appRefreshTimeoutId = 0
  const [showHiddenApps, setShowHiddenApps] = createState(false)

  const hiddenAppKeySet = createComputed(() => new Set(hiddenAppKeys()))
  const normalizedQuery = createComputed(() => normalizeText(query()))
  const visibleApps = createComputed(() => installedApps().filter((app) => app.shouldShow && !hiddenAppKeySet().has(app.key)))
  const hiddenApps = createComputed(() => installedApps().filter((app) => hiddenAppKeySet().has(app.key)))
  const hiddenAppsCount = createComputed(() => hiddenApps().length)
  const hiddenToggleVisible = createComputed(() => hiddenAppsCount() > 0 || showHiddenApps())
  const hiddenToggleLabel = createComputed(() => (showHiddenApps() ? "Back" : `Hidden ${hiddenAppsCount()}`))
  const filteredApps = createComputed(() => {
    const category = renderedCategory()
    const value = normalizedQuery()
    const source = showHiddenApps() ? hiddenApps() : value ? installedApps() : visibleApps()
    const categoryApps = source.filter((app) => appMatchesCategory(app, category))
    if (!value) return categoryApps
    return categoryApps.filter((app) => app.searchBlob.includes(value))
  })
  const launcherTitle = createComputed(() => {
    const count = filteredApps().length
    if (showHiddenApps()) return `Hidden applications ${count}`

    const category = renderedCategory()
    const title = category === "all" ? "Applications" : getLauncherCategory(category).label
    return `${title} ${count}`
  })

  const clearAppRefreshTimeout = () => {
    if (appRefreshTimeoutId !== 0) {
      GLib.source_remove(appRefreshTimeoutId)
      appRefreshTimeoutId = 0
    }
  }

  const refreshInstalledApps = () => {
    const nextApps = refreshCachedApps()

    const validKeys = new Set(nextApps.map((app) => app.key))
    setHiddenAppKeys((current) => current.filter((key) => validKeys.has(key)))
  }

  const scheduleInstalledAppsRefresh = () => {
    if (appRefreshTimeoutId !== 0) return

    appRefreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, APP_LIST_REFRESH_DEBOUNCE_MS, () => {
      appRefreshTimeoutId = 0
      refreshInstalledApps()
      return GLib.SOURCE_REMOVE
    })
  }

  const destroyApplicationDirectoryMonitors = () => {
    for (const monitor of appDirectoryMonitors) {
      try {
        monitor.cancel()
      } catch {}
    }

    appDirectoryMonitors = []
  }

  const rebuildApplicationDirectoryMonitors = () => {
    destroyApplicationDirectoryMonitors()

    for (const path of getApplicationMonitorRoots()) {
      try {
        const file = Gio.File.new_for_path(path)
        const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
        monitor.set_rate_limit(APP_LIST_REFRESH_DEBOUNCE_MS)
        monitor.connect("changed", () => {
          scheduleInstalledAppsRefresh()
          rebuildApplicationDirectoryMonitors()
        })
        appDirectoryMonitors.push(monitor)
      } catch {}
    }
  }

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const clearLauncherListAnimationTimeout = () => {
    if (launcherListAnimationTimeoutId !== 0) {
      GLib.source_remove(launcherListAnimationTimeoutId)
      launcherListAnimationTimeoutId = 0
    }
  }

  const replayLauncherListSwitchAnimation = () => {
    const target = launcherListContent
    if (!target) return

    clearLauncherListAnimationTimeout()
    target.remove_css_class("launcher-list-switching")

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const nextTarget = launcherListContent
      if (!nextTarget) return GLib.SOURCE_REMOVE

      nextTarget.remove_css_class("launcher-list-switching")
      nextTarget.add_css_class("launcher-list-switching")
      launcherListAnimationTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNCHER_LIST_SWITCH_ANIMATION_MS, () => {
        launcherListAnimationTimeoutId = 0
        launcherListContent?.remove_css_class("launcher-list-switching")
        return GLib.SOURCE_REMOVE
      })

      return GLib.SOURCE_REMOVE
    })
  }

  const detachLauncherSmoothScroll = () => {
    launcherSmoothScrollCleanup?.()
    launcherSmoothScrollCleanup = null
  }

  const clampLauncherScrollValue = (value: number, adjustment: Gtk.Adjustment) => {
    const lower = adjustment.get_lower()
    const upper = Math.max(lower, adjustment.get_upper() - adjustment.get_page_size())
    return Math.max(lower, Math.min(upper, value))
  }

  const restoreLauncherScrollValue = (value: number) => {
    detachLauncherSmoothScroll()

    const adjustment = launcherScrollWindow?.get_vadjustment()
    if (adjustment) adjustment.set_value(clampLauncherScrollValue(value, adjustment))

    if (launcherScrollWindow) launcherSmoothScrollCleanup = attachSmoothVerticalScroll(launcherScrollWindow)
  }

  const preserveLauncherScrollDuring = (update: () => void) => {
    const adjustment = launcherScrollWindow?.get_vadjustment()
    const scrollValue = adjustment?.get_value() ?? 0

    update()
    restoreLauncherScrollValue(scrollValue)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      restoreLauncherScrollValue(scrollValue)
      return GLib.SOURCE_REMOVE
    })
  }

  const scrollLauncherListToTop = () => {
    const adjustment = launcherScrollWindow?.get_vadjustment()
    if (!adjustment) return

    restoreLauncherScrollValue(adjustment.get_lower())
  }

  const selectCategory = (category: LauncherCategoryId) => {
    if (selectedCategory() === category && renderedCategory() === category) return

    setSelectedCategory(category)
    setRenderedCategory(category)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      scrollLauncherListToTop()
      return GLib.SOURCE_REMOVE
    })
  }

  const toggleHiddenAppsView = () => {
    setShowHiddenApps((value) => !value)
    replayLauncherListSwitchAnimation()
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger || trigger.active === open) return
    trigger.active = open
  }

  const syncPopupPosition = () => {
    placeLayerWindowAtTopEdge(trigger, popupWindowRef, popupFrame, {
      align: "end",
      right: POPUP_SCREEN_RIGHT,
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
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNCHER_POPOVER_REVEAL_DURATION_MS, () => {
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
    setNotice(null)
    setShowHiddenApps(false)
    setSelectedCategory("all")
    setRenderedCategory("all")
    setQuery("")
    if (searchEntry) searchEntry.set_text("")
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState()
      popupRoot?.grab_focus()
      searchEntry?.grab_focus()
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

  const controller = { toggle: togglePopup, close: closePopup }
  launcherControllers.add(controller)
  rebuildApplicationDirectoryMonitors()

  const spawnGtkLaunch = (id: string) => {
    try {
      const [started] = GLib.spawn_async(null, ["gtk-launch", id], null, GLib.SpawnFlags.SEARCH_PATH, null)
      if (!started) throw new Error("Failed to start application")
      return true
    } catch (error) {
      console.warn(formatError(error))
      return false
    }
  }

  const launchApp = (app: LaunchableApp) => {
    setNotice(null)
    closePopup()

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      try {
        const launched = app.appInfo.launch([], null)
        if (!launched && app.id) spawnGtkLaunch(app.id)
        else if (!launched) console.warn("Failed to start application")
      } catch (error) {
        if (app.id) spawnGtkLaunch(app.id)
        else console.warn(formatError(error))
      }

      return GLib.SOURCE_REMOVE
    })
  }

  const setHiddenAppKeys = (value: string[] | ((value: string[]) => string[])) => {
    const current = hiddenAppKeys()
    const resolved = typeof value === "function" ? value(current) : value
    const next = [...new Set(resolved.map((entry) => entry.trim()).filter(Boolean))]
    setHiddenAppKeysState(next)
    saveHiddenAppKeys(next)
  }

  const hideApp = (app: LaunchableApp) => {
    preserveLauncherScrollDuring(() => {
      setHiddenAppKeys((current) => [...current, app.key])
    })
  }

  const restoreApp = (app: LaunchableApp) => {
    preserveLauncherScrollDuring(() => {
      setHiddenAppKeys((current) => current.filter((key) => key !== app.key))
    })
  }

  const openFirstMatch = () => {
    const first = filteredApps()[0]
    if (first) void launchApp(first)
  }

  const popupContent = (
    <box class="launcher-popover" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <box class="launcher-search-shell" spacing={8} valign={Gtk.Align.CENTER}>
        <Gtk.SearchEntry
          class="launcher-search"
          hexpand
          placeholderText="Search applications"
          $={(self) => {
            searchEntry = self
            self.connect("search-changed", () => setQuery(self.get_text()))
            self.connect("activate", openFirstMatch)
          }}
        />
      </box>

      <box class="launcher-header" spacing={8} valign={Gtk.Align.CENTER}>
        <label class="launcher-title" xalign={0} hexpand label={launcherTitle} />
        <button
          class="flat hidden-toggle launcher-hidden-toggle"
          valign={Gtk.Align.CENTER}
          vexpand={false}
          visible={hiddenToggleVisible}
          onClicked={toggleHiddenAppsView}
        >
          <label class="hidden-toggle-label" valign={Gtk.Align.CENTER} label={hiddenToggleLabel} />
        </button>
      </box>

      <Gtk.ScrolledWindow
        class="launcher-list-wrap"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        kineticScrolling={false}
        vexpand={false}
        heightRequest={LAUNCHER_LIST_HEIGHT}
        minContentHeight={LAUNCHER_LIST_HEIGHT}
        maxContentHeight={LAUNCHER_LIST_HEIGHT}
        propagateNaturalHeight={false}
        propagateNaturalWidth={false}
        $={(self) => {
          launcherScrollWindow = self
          launcherSmoothScrollCleanup = attachSmoothVerticalScroll(self)
          self.connect("destroy", () => {
            launcherScrollWindow = null
            detachLauncherSmoothScroll()
          })
        }}
      >
        <box
          class="launcher-list-content"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={4}
          marginEnd={6}
          $={(self) => {
            launcherListContent = self
            self.connect("destroy", () => {
              if (launcherListContent === self) launcherListContent = null
              clearLauncherListAnimationTimeout()
            })
          }}
        >
          <For each={filteredApps}>
            {(app) => (
              <box class="launcher-app-card" hexpand spacing={0} valign={Gtk.Align.CENTER}>
                <button class="flat launcher-app-main" hexpand onClicked={() => void launchApp(app)}>
                  <box class="launcher-app-row" spacing={10} hexpand valign={Gtk.Align.CENTER}>
                    <box class="launcher-app-icon-wrap" valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER}>
                      <image
                        class="launcher-app-icon"
                        visible={Boolean(app.icon)}
                        gicon={app.icon}
                        pixelSize={40}
                        halign={Gtk.Align.CENTER}
                        valign={Gtk.Align.CENTER}
                      />
                      <label
                        class="launcher-app-fallback"
                        visible={!app.icon}
                        label={LAUNCHER_FALLBACK_ICON}
                        halign={Gtk.Align.CENTER}
                        valign={Gtk.Align.CENTER}
                      />
                    </box>

                    <box class="launcher-app-content" orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
                      <label
                        class="launcher-app-title"
                        xalign={0}
                        label={app.name}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={28}
                      />
                      <label
                        class="launcher-app-meta"
                        xalign={0}
                        label={app.description || app.executable || app.id || "Desktop application"}
                        ellipsize={Pango.EllipsizeMode.END}
                        maxWidthChars={42}
                      />
                    </box>
                  </box>
                </button>

                <button
                  class="flat launcher-app-side-button"
                  onClicked={() => (hiddenAppKeySet().has(app.key) ? restoreApp(app) : hideApp(app))}
                  valign={Gtk.Align.CENTER}
                  $={(self) => attachShellTooltip(self, () => hiddenAppKeySet().has(app.key) ? "Restore application" : "Hide application")}
                >
                  <label
                    class="launcher-side-icon launcher-material-icon"
                    label={hiddenAppKeys((keys) => keys.includes(app.key) ? LAUNCHER_RESTORE_ICON : LAUNCHER_HIDE_ICON)}
                  />
                </button>
              </box>
            )}
          </For>

          <box
            visible={filteredApps((list) => list.length === 0)}
            orientation={Gtk.Orientation.VERTICAL}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            vexpand
          >
            <label class="launcher-empty-title" label={showHiddenApps((value) => (value ? "No hidden applications" : "Nothing found"))} />
          </box>
        </box>
      </Gtk.ScrolledWindow>

      <box class="launcher-category-bar" spacing={6} valign={Gtk.Align.CENTER}>
        <For each={() => LAUNCHER_CATEGORIES}>
          {(category) => (
            <Gtk.ToggleButton
              class="flat launcher-category-button"
              active={selectedCategory((value) => value === category.id)}
              onClicked={() => selectCategory(category.id)}
            >
              <label class="launcher-category-label" label={category.label} />
            </Gtk.ToggleButton>
          )}
        </For>
      </box>

      <label
        class="launcher-notice"
        visible={notice((value) => Boolean(value))}
        xalign={0}
        wrap
        label={notice((value) => value ?? "")}
      />
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-launcher"
      class="widget-popup-window launcher-popup-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={LEFT_TOP_POPUP_ANCHOR}
      $={(self) => {
        popupWindowRef = self
        try {
          self.set_default_size(-1, -1)
        } catch {}
        self.connect("destroy", () => {
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
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            transitionDuration={LAUNCHER_POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame launcher-popover-window" widthRequest={LAUNCHER_POPOVER_WIDTH} $={(self) => {
              clipRoundedWidget(self)
              popupFrame = self
            }}>{popupContent}</box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <box class="launcher-shell" valign={Gtk.Align.CENTER}>
      <Gtk.ToggleButton
        class="app-launcher-trigger"
        valign={Gtk.Align.CENTER}
        onClicked={() => {
          togglePopup()
        }}
        $={(self) => {
          trigger = self
          attachShellTooltip(self, "Applications")

          self.connect("destroy", () => {
            clearCloseTimeout()
            clearAppRefreshTimeout()
            destroyApplicationDirectoryMonitors()
            detachLauncherSmoothScroll()
            unsubscribeCachedApps()
            unregisterPopupController()
            launcherControllers.delete(controller)
            closingPopup = false
            setWindowVisible(false)
          })
        }}
      >
        <label class="launcher-trigger-icon launcher-material-icon" label={LAUNCHER_TRIGGER_ICON} />
      </Gtk.ToggleButton>
    </box>
  )
}
