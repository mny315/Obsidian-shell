import Gio from "gi://Gio"
import type App from "ags/gtk4/app"
import { Astal } from "ags/gtk4"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { For, createComputed, createState } from "ags"
import { attachEscapeKey } from "./EscapeKey"
import { LEFT_TOP_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowAtTopEdge } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"

type LaunchableApp = {
  key: string
  id: string
  name: string
  description: string
  executable: string
  icon: Gio.Icon | null
  searchBlob: string
  appInfo: Gio.AppInfo
}

const LAUNCHER_TRIGGER_ICON = "󰀻"
const LAUNCHER_FALLBACK_ICON = "󰀻"
const LAUNCHER_HIDE_ICON = "󰛑"
const LAUNCHER_RESTORE_ICON = "󰗡"

const STATE_HOME = (() => {
  const configured = GLib.getenv("XDG_STATE_HOME")?.trim() ?? ""
  if (configured.length > 0 && GLib.path_is_absolute(configured)) return configured
  return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"])
})()

const LAUNCHER_STATE_DIR = GLib.build_filenamev([STATE_HOME, "ags"])
const HIDDEN_APPS_STATE_PATH = GLib.build_filenamev([LAUNCHER_STATE_DIR, "hidden-launcher-apps.json"])

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

function buildAppKey(id: string, name: string, executable: string) {
  const normalizedId = safeText(id)
  if (normalizedId) return `id:${normalizedId}`

  const normalizedExecutable = safeText(executable)
  const normalizedName = safeText(name)
  return `fallback:${normalizedExecutable}::${normalizedName}`
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
    GLib.mkdir_with_parents(LAUNCHER_STATE_DIR, 0o700)
    GLib.file_set_contents(HIDDEN_APPS_STATE_PATH, JSON.stringify(keys))
  } catch {}
}

function readApps(): LaunchableApp[] {
  const seen = new Set<string>()
  const apps: LaunchableApp[] = []

  for (const info of Gio.AppInfo.get_all()) {
    try {
      if (!info.should_show()) continue
    } catch {
      continue
    }

    const name = safeText(info.get_display_name?.() ?? info.get_name?.())
    if (!name) continue

    const id = safeText(info.get_id?.())
    const executable = safeText(info.get_executable?.())
    const description = getDescription(info)
    const keywords = getKeywords(info)
    const dedupeKey = `${id}::${name}::${executable}`

    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    apps.push({
      key: buildAppKey(id, name, executable),
      id,
      name,
      description,
      executable,
      icon: info.get_icon?.() ?? null,
      searchBlob: normalizeText([name, description, executable, keywords, id].filter(Boolean).join(" ")),
      appInfo: info,
    })
  }

  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return apps
}

const APP_LIST_REFRESH_DEBOUNCE_MS = 180
const LAUNCHER_POPOVER_REVEAL_DURATION_MS = 170
const LAUNCHER_POPOVER_WIDTH = 392

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

export function AppLauncherControl({
  monitor,
  bindBarHoverWatcher,
}: {
  monitor: number
  bindBarHoverWatcher?: (watcher: (hovered: boolean) => void) => void
} = {
  monitor: 0,
}) {
  let trigger: Gtk.Button | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let searchEntry: Gtk.SearchEntry | null = null
  let launcherScrollWindow: Gtk.ScrolledWindow | null = null
  let scrollAnimationId = 0
  let scrollTarget = 0
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `launcher:${monitor}`

  void bindBarHoverWatcher

  const [query, setQuery] = createState("")
  const [notice, setNotice] = createState<string | null>(null)
  const [installedApps, setInstalledApps] = createState<LaunchableApp[]>(readApps())
  const [hiddenAppKeys, setHiddenAppKeysState] = createState<string[]>(readHiddenAppKeys())
  let appDirectoryMonitors: Gio.FileMonitor[] = []
  let appRefreshTimeoutId = 0
  const [showHiddenApps, setShowHiddenApps] = createState(false)

  const hiddenAppKeySet = createComputed(() => new Set(hiddenAppKeys()))
  const visibleApps = createComputed(() => installedApps().filter((app) => !hiddenAppKeySet().has(app.key)))
  const hiddenApps = createComputed(() => installedApps().filter((app) => hiddenAppKeySet().has(app.key)))
  const hiddenAppsCount = createComputed(() => hiddenApps().length)
  const hiddenToggleVisible = createComputed(() => hiddenAppsCount() > 0 || showHiddenApps())
  const hiddenToggleLabel = createComputed(() => (showHiddenApps() ? "Back" : `Hidden ${hiddenAppsCount()}`))
  const filteredApps = createComputed(() => {
    const source = showHiddenApps() ? hiddenApps() : visibleApps()
    const value = normalizeText(query())
    if (!value) return source
    return source.filter((app) => app.searchBlob.includes(value))
  })
  const launcherTitle = createComputed(() => {
    const count = filteredApps().length
    return showHiddenApps() ? `Hidden applications ${count}` : `Applications ${count}`
  })

  const clearAppRefreshTimeout = () => {
    if (appRefreshTimeoutId !== 0) {
      GLib.source_remove(appRefreshTimeoutId)
      appRefreshTimeoutId = 0
    }
  }

  const refreshInstalledApps = () => {
    const nextApps = readApps()
    setInstalledApps(nextApps)

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

  const stopSmoothScroll = () => {
    if (scrollAnimationId !== 0) {
      GLib.source_remove(scrollAnimationId)
      scrollAnimationId = 0
    }
  }

  const animateLauncherScroll = (dy: number) => {
    const adjustment = launcherScrollWindow?.get_vadjustment()
    if (!adjustment) return

    const lower = adjustment.get_lower()
    const upper = adjustment.get_upper() - adjustment.get_page_size()
    const current = adjustment.get_value()
    const delta = dy * 72

    scrollTarget = Math.max(lower, Math.min(upper, (scrollAnimationId !== 0 ? scrollTarget : current) + delta))
    if (scrollAnimationId !== 0) return

    scrollAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 / 60, () => {
      const nextCurrent = adjustment.get_value()
      const nextValue = nextCurrent + (scrollTarget - nextCurrent) * 0.26

      if (Math.abs(scrollTarget - nextCurrent) <= 0.8) {
        adjustment.set_value(scrollTarget)
        scrollAnimationId = 0
        return GLib.SOURCE_REMOVE
      }

      adjustment.set_value(nextValue)
      return GLib.SOURCE_CONTINUE
    })
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
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

  const resetStalePopupState = (reason: string) => {
    console.warn(`[popup:${popupRegistryId}] reset stale state: ${reason}`)
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
      if (closingPopup || !isPopupRevealed()) resetStalePopupState("open requested while visible but not revealed")
      else {
        syncPopupPosition()
        return
      }
    }

    closeOtherPopups(popupRegistryId)
    clearCloseTimeout()
    closingPopup = false
    refreshInstalledApps()
    setWindowVisible(true)
    setTriggerOpen(true)
    setNotice(null)
    setShowHiddenApps(false)
    setQuery("")
    if (searchEntry) searchEntry.set_text("")
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState("revealer missing after open")
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
        resetStalePopupState("toggle requested while visible but not revealed")
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
    setHiddenAppKeys((current) => [...current, app.key])
  }

  const restoreApp = (app: LaunchableApp) => {
    setHiddenAppKeys((current) => current.filter((key) => key !== app.key))
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
          class="flat launcher-hidden-toggle"
          visible={hiddenToggleVisible}
          onClicked={() => setShowHiddenApps((value) => !value)}
        >
          <label label={hiddenToggleLabel} />
        </button>
      </box>

      <Gtk.ScrolledWindow
        class="launcher-list-wrap"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        kineticScrolling
        vexpand
        minContentHeight={160}
        maxContentHeight={300}
        propagateNaturalHeight
        $={(self) => {
          launcherScrollWindow = self
          self.connect("destroy", () => {
            launcherScrollWindow = null
            stopSmoothScroll()
          })
        }}
      >
        <Gtk.EventControllerScroll
          flags={Gtk.EventControllerScrollFlags.VERTICAL}
          onScroll={(_, _dx, dy) => {
            if (Math.abs(dy) < 0.0001) return false
            animateLauncherScroll(dy)
            return true
          }}
        />
        <box class="launcher-list-content" orientation={Gtk.Orientation.VERTICAL} spacing={4} marginEnd={6}>
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
                  onClicked={() => (showHiddenApps() ? restoreApp(app) : hideApp(app))}
                  valign={Gtk.Align.CENTER}
                  $={(self) => attachShellTooltip(self, () => showHiddenApps() ? "Restore application" : "Hide application")}
                >
                  <label
                    class="launcher-side-icon launcher-material-icon"
                    label={showHiddenApps() ? LAUNCHER_RESTORE_ICON : LAUNCHER_HIDE_ICON}
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
          popupPlacement = null
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
          $={(self) => {
            popupPlacement = self
          }}
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
      <button
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
            stopSmoothScroll()
            unregisterPopupController()
            launcherControllers.delete(controller)
            closingPopup = false
            setWindowVisible(false)
          })
        }}
      >
        <label class="launcher-trigger-icon launcher-material-icon" label={LAUNCHER_TRIGGER_ICON} />
      </button>
    </box>
  )
}
