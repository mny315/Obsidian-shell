import Gio from "gi://Gio"
import type App from "ags/gtk4/app"
import { Astal } from "ags/gtk4"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

import { For, createComputed, createState } from "ags"
import { execAsync } from "ags/process"

import { FLOATING_POPUP_ANCHOR, POPUP_SCREEN_RIGHT, TOP_BAR_POPUP_MARGIN_TOP, isPointInsideWidget } from "./FloatingPopup"


type LaunchableApp = {
  id: string
  name: string
  description: string
  executable: string
  icon: Gio.Icon | null
  searchBlob: string
  appInfo: Gio.AppInfo
}

const LAUNCHER_TRIGGER_ICON = "󰀻"
const LAUNCHER_EMPTY_ICON = "󰦀"
const LAUNCHER_FALLBACK_ICON = "󰀻"

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

const INSTALLED_APPS = readApps()
const LAUNCHER_POPOVER_REVEAL_DURATION_MS = 340
const LAUNCHER_POPOVER_WIDTH = 392
const LAUNCHER_POPUP_MARGIN_END = POPUP_SCREEN_RIGHT

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error.trim()
  return "Failed to launch application"
}

function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`
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
  let popupPlacement: Gtk.Box | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let searchEntry: Gtk.SearchEntry | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)

  void bindBarHoverWatcher

  const [query, setQuery] = createState("")
  const [notice, setNotice] = createState<string | null>(null)

  const filteredApps = createComputed(() => {
    const value = normalizeText(query())
    if (!value) return INSTALLED_APPS
    return INSTALLED_APPS.filter((app) => app.searchBlob.includes(value))
  })

  const clearCloseTimeout = () => {
    if (closeTimeoutId !== 0) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = 0
    }
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
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
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LAUNCHER_POPOVER_REVEAL_DURATION_MS, () => {
        finishClosePopup()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    finishClosePopup()
  }

  const openPopup = () => {
    if (windowVisible()) return

    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    setNotice(null)
    setQuery("")
    if (searchEntry) searchEntry.set_text("")
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (popupRevealer) popupRevealer.revealChild = true
      searchEntry?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
  }

  const controller = { toggle: togglePopup, close: closePopup }
  launcherControllers.add(controller)

  const launchApp = async (app: LaunchableApp) => {
    setNotice(null)

    try {
      if (app.id) {
        await execAsync(["bash", "-lc", `gtk-launch ${shellQuote(app.id)}`])
      } else {
        const launched = app.appInfo.launch([], null)
        if (!launched) throw new Error("Failed to start application")
      }

      closePopup()
      return
    } catch (error) {
      try {
        const launched = app.appInfo.launch([], null)
        if (launched) {
          closePopup()
          return
        }
      } catch {}

      setNotice(formatError(error))
    }
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
        <label class="launcher-title" xalign={0} hexpand label="Applications" />
        <label class="launcher-count" label={filteredApps((list) => `${list.length}`)} />
      </box>

      <Gtk.ScrolledWindow
        class="launcher-list-wrap"
        vexpand
        minContentHeight={160}
        maxContentHeight={300}
        propagateNaturalHeight
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <For each={filteredApps}>
            {(app) => (
              <button class="flat launcher-app-button" onClicked={() => void launchApp(app)}>
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
            )}
          </For>

          <box
            class="launcher-empty"
            visible={filteredApps((list) => list.length === 0)}
            orientation={Gtk.Orientation.VERTICAL}
            spacing={4}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            vexpand
          >
            <label class="launcher-empty-icon launcher-material-icon" label={LAUNCHER_EMPTY_ICON} />
            <label class="launcher-empty-title" label="Nothing found" />
            <label class="launcher-empty-meta" label="Try another search query" />
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
      namespace={`launcher-popup-${monitor}`}
      class="widget-popup-window launcher-popup-window"
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
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          $={(self) => {
            popupPlacement = self
            self.set_margin_top(TOP_BAR_POPUP_MARGIN_TOP)
            self.set_margin_end(LAUNCHER_POPUP_MARGIN_END)
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.CROSSFADE}
            transitionDuration={LAUNCHER_POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame launcher-popover-window" widthRequest={LAUNCHER_POPOVER_WIDTH} $={(self) => (popupFrame = self)}>{popupContent}</box>
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
        tooltipText="Applications"
        onClicked={togglePopup}
        $={(self) => {
          trigger = self

          self.connect("destroy", () => {
            clearCloseTimeout()
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
