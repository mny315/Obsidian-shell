import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Notifd from "gi://AstalNotifd"

import { For, With, createState } from "ags"
import { idle } from "ags/time"
import { Astal } from "ags/gtk4"

import { WIDGET_AUTO_CLOSE_DELAY_MS } from "../config"
import { PlayerDock } from "./PlayerInline"
import {
  FLOATING_POPUP_ANCHOR,
  POPUP_SCREEN_RIGHT,
  TOP_BAR_POPUP_MARGIN_TOP,
  isPointInsideWidget,
} from "./FloatingPopup"

const notifd = Notifd.get_default()

const HISTORY_WIDTH = 520
const HISTORY_MIN_HEIGHT = 480
const HISTORY_MAX_HEIGHT = 1280
const HISTORY_REVEAL_DURATION_MS = 260
const HISTORY_FADE_DURATION_MS = 170
const HISTORY_FADE_DELAY_MS = 36
const HISTORY_HIDE_SLIDE_DELAY_MS = 24

const TOAST_WIDTH = 414
const TOAST_GAP = 10
const TOAST_MARGIN_END = POPUP_SCREEN_RIGHT
const TOAST_MARGIN_BOTTOM = 12
const TOAST_REVEAL_DURATION_MS = 240
const IGNORED_SLIDE_DURATION_MS = 220
const IGNORED_FADE_DURATION_MS = 160
const IGNORED_FADE_DELAY_MS = 28
const IGNORED_HIDE_SLIDE_DELAY_MS = 16
const TOAST_WINDOW_ANCHOR = Astal.WindowAnchor.RIGHT | Astal.WindowAnchor.BOTTOM

// Use a quiet bell by default and switch to the ringing bell only while unresolved notifications exist.
// Both glyphs are from the classic MDI webfont range for compatibility with older font builds.
const IDLE_NOTIFICATION_GLYPH = "󰂜"
const ACTIVE_NOTIFICATION_GLYPH = "󰂟"
const DND_LABEL = "DND"
const IGNORED_APPS_LABEL = "Ignored"

let notifdInitialized = false
const popupTimeouts = new Map<number, number>()
const popupHideAnimationTimeouts = new Map<number, number>()

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), "ags"])
const DISMISSED_NOTIFICATIONS_PATH = GLib.build_filenamev([CACHE_DIR, "dismissed-notifications.json"])
const IGNORED_NOTIFICATION_APPS_PATH = GLib.build_filenamev([CACHE_DIR, "ignored-notification-apps.json"])

let dismissedIdsLoaded = false
const dismissedIds = new Set<number>()

let ignoredAppsLoaded = false
const ignoredApps = new Map<string, string>()

export type NotificationActionSnapshot = {
  id: string
  label: string
}

export type NotificationSnapshot = {
  id: number
  summary: string
  body: string
  appName: string
  appIcon: string
  time: number
  actions: NotificationActionSnapshot[]
}

type IgnoredAppSnapshot = {
  key: string
  label: string
}

type NotificationGroupSnapshot = {
  key: string
  label: string
  icon: string
  latestTime: number
  items: NotificationSnapshot[]
}

const [history, setHistory] = createState<NotificationSnapshot[]>([])
const [popupVisibleIds, setPopupVisibleIds] = createState<number[]>([])
const [popupRenderIds, setPopupRenderIds] = createState<number[]>([])
const [dontDisturbState, setDontDisturbState] = createState(false)
const [ignoredAppsState, setIgnoredAppsState] = createState<IgnoredAppSnapshot[]>([])
const [ignoredManagerOpen, setIgnoredManagerOpen] = createState(false)

function ensureDismissedIdsLoaded() {
  if (dismissedIdsLoaded) return
  dismissedIdsLoaded = true

  try {
    const [ok, contents] = GLib.file_get_contents(DISMISSED_NOTIFICATIONS_PATH)
    if (!ok || !contents) return

    const parsed = JSON.parse(new TextDecoder().decode(contents))
    if (!Array.isArray(parsed)) return

    for (const value of parsed) {
      if (typeof value === "number" && Number.isFinite(value)) dismissedIds.add(value)
    }
  } catch {}
}

function saveDismissedIds() {
  ensureDismissedIdsLoaded()

  try {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755)
    GLib.file_set_contents(DISMISSED_NOTIFICATIONS_PATH, JSON.stringify([...dismissedIds]))
  } catch {}
}

function pruneDismissedIds(liveIds: number[]) {
  ensureDismissedIdsLoaded()

  const liveSet = new Set(liveIds)
  let changed = false

  for (const id of [...dismissedIds]) {
    if (!liveSet.has(id)) {
      dismissedIds.delete(id)
      changed = true
    }
  }

  if (changed) saveDismissedIds()
}

function markDismissedIds(ids: number[]) {
  ensureDismissedIdsLoaded()

  let changed = false
  for (const id of ids) {
    if (!dismissedIds.has(id)) {
      dismissedIds.add(id)
      changed = true
    }
  }

  if (changed) saveDismissedIds()
}

function unmarkDismissedId(id: number) {
  ensureDismissedIdsLoaded()
  if (!dismissedIds.delete(id)) return
  saveDismissedIds()
}

function isDismissedId(id: number) {
  ensureDismissedIdsLoaded()
  return dismissedIds.has(id)
}

function normalizeAppKey(appName: string) {
  return appName.trim().replace(/\s+/g, " ").toLowerCase()
}

function displayAppName(appName: string) {
  const value = appName.trim().replace(/\s+/g, " ")
  return value.length > 0 ? value : "Unknown app"
}

function syncIgnoredAppsState() {
  setIgnoredAppsState(
    [...ignoredApps.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
  )
}

function ensureIgnoredAppsLoaded() {
  if (ignoredAppsLoaded) return
  ignoredAppsLoaded = true

  try {
    const [ok, contents] = GLib.file_get_contents(IGNORED_NOTIFICATION_APPS_PATH)
    if (!ok || !contents) {
      syncIgnoredAppsState()
      return
    }

    const parsed = JSON.parse(new TextDecoder().decode(contents))
    if (!Array.isArray(parsed)) {
      syncIgnoredAppsState()
      return
    }

    for (const value of parsed) {
      if (typeof value === "string") {
        const label = displayAppName(value)
        const key = normalizeAppKey(label)
        if (key) ignoredApps.set(key, label)
        continue
      }

      if (value && typeof value === "object") {
        const label = displayAppName(String((value as any).label ?? (value as any).key ?? ""))
        const key = normalizeAppKey(String((value as any).key ?? label))
        if (key) ignoredApps.set(key, label)
      }
    }
  } catch {}

  syncIgnoredAppsState()
}

function saveIgnoredApps() {
  ensureIgnoredAppsLoaded()

  try {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755)
    GLib.file_set_contents(
      IGNORED_NOTIFICATION_APPS_PATH,
      JSON.stringify([...ignoredApps.entries()].map(([key, label]) => ({ key, label }))),
    )
  } catch {}

  syncIgnoredAppsState()
}

function isIgnoredAppName(appName: string) {
  ensureIgnoredAppsLoaded()
  const key = normalizeAppKey(displayAppName(appName))
  return key.length > 0 && ignoredApps.has(key)
}

function removeNotificationsForAppKey(appKey: string) {
  const matchingIds = history()
    .filter((entry) => normalizeAppKey(displayAppName(entry.appName)) === appKey)
    .map((entry) => entry.id)

  if (matchingIds.length > 0) {
    const matchingSet = new Set(matchingIds)

    for (const id of matchingIds) clearPopupTimeout(id)
    for (const id of matchingIds) dropPopup(id)
    setHistory((prev) => prev.filter((entry) => !matchingSet.has(entry.id)))
  }

  try {
    const liveNotifications = notifd.get_notifications?.() ?? notifd.notifications ?? []
    if (!Array.isArray(liveNotifications)) return

    for (const notification of liveNotifications) {
      const snapshot = snapshotNotification(notification)
      if (normalizeAppKey(displayAppName(snapshot.appName)) !== appKey) continue
      dismissNotification(snapshot.id)
    }
  } catch {}
}

function ignoreApp(appName: string) {
  ensureIgnoredAppsLoaded()

  const label = displayAppName(appName)
  const key = normalizeAppKey(label)
  if (!key) return

  ignoredApps.set(key, label)
  saveIgnoredApps()
  removeNotificationsForAppKey(key)
}

function unignoreApp(appKey: string) {
  ensureIgnoredAppsLoaded()
  if (!ignoredApps.delete(appKey)) return
  saveIgnoredApps()
}

function readDontDisturb() {
  return Boolean(getProp(notifd, "dontDisturb", "dont_disturb", "dont-disturb"))
}

function setDontDisturb(enabled: boolean) {
  const writers = [
    () => notifd.set_dont_disturb?.(enabled),
    () => notifd.setDontDisturb?.(enabled),
    () => { if ("dontDisturb" in (notifd as any)) (notifd as any).dontDisturb = enabled; else throw new Error("no dontDisturb property") },
    () => { if ("dont_disturb" in (notifd as any)) (notifd as any).dont_disturb = enabled; else throw new Error("no dont_disturb property") },
    () => { if (typeof (notifd as any).set_property === "function") (notifd as any).set_property("dont-disturb", enabled); else throw new Error("no set_property") },
    () => { if (typeof (notifd as any).set_property === "function") (notifd as any).set_property("dontDisturb", enabled); else throw new Error("no set_property") },
  ]

  for (const write of writers) {
    try {
      write()
      setDontDisturbState(readDontDisturb())
      return
    } catch {}
  }

  setDontDisturbState(enabled)
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function getProp(obj: any, ...keys: string[]) {
  for (const key of keys) {
    try {
      if (obj?.[key] !== undefined && obj?.[key] !== null) return obj[key]
    } catch {}
  }

  return undefined
}

function getActions(notification: any): NotificationActionSnapshot[] {
  const actions = getProp(notification, "actions")
  if (!Array.isArray(actions)) return []

  return actions.map((action: any, index: number) => ({
    id: safeString(getProp(action, "id"), `action-${index}`),
    label: safeString(getProp(action, "label"), "Action"),
  }))
}

function snapshotNotification(notification: any): NotificationSnapshot {
  return {
    id: safeNumber(getProp(notification, "id")),
    summary: safeString(getProp(notification, "summary")),
    body: safeString(getProp(notification, "body")),
    appName: safeString(getProp(notification, "appName", "app_name", "app-name")),
    appIcon: safeString(getProp(notification, "appIcon", "app_icon", "app-icon")),
    time: safeNumber(getProp(notification, "time"), Date.now()),
    actions: getActions(notification),
  }
}

function updateHistoryEntry(next: NotificationSnapshot) {
  if (isIgnoredAppName(next.appName)) return

  setHistory((prev) => {
    const filtered = prev.filter((entry) => entry.id !== next.id)
    return [next, ...filtered].slice(0, 80)
  })
}

function clearPopupTimeout(id: number) {
  const timeoutId = popupTimeouts.get(id)
  if (!timeoutId) return

  try {
    GLib.source_remove(timeoutId)
  } catch {}

  popupTimeouts.delete(id)
}

function clearPopupHideAnimationTimeout(id: number) {
  const timeoutId = popupHideAnimationTimeouts.get(id)
  if (!timeoutId) return

  try {
    GLib.source_remove(timeoutId)
  } catch {}

  popupHideAnimationTimeouts.delete(id)
}

function dropPopup(id: number) {
  clearPopupTimeout(id)
  clearPopupHideAnimationTimeout(id)
  setPopupVisibleIds((prev) => prev.filter((entry) => entry !== id))
  setPopupRenderIds((prev) => prev.filter((entry) => entry !== id))
}

function hidePopup(id: number) {
  clearPopupTimeout(id)
  clearPopupHideAnimationTimeout(id)
  setPopupVisibleIds((prev) => prev.filter((entry) => entry !== id))

  const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_REVEAL_DURATION_MS, () => {
    popupHideAnimationTimeouts.delete(id)
    setPopupRenderIds((prev) => prev.filter((entry) => entry !== id))
    return GLib.SOURCE_REMOVE
  })

  popupHideAnimationTimeouts.set(id, sourceId)
}

function schedulePopupHide(id: number, timeout = WIDGET_AUTO_CLOSE_DELAY_MS) {
  clearPopupTimeout(id)

  const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
    hidePopup(id)
    return GLib.SOURCE_REMOVE
  })

  popupTimeouts.set(id, sourceId)
}

function showPopup(id: number) {
  const snapshot = history().find((entry) => entry.id === id)
  if (snapshot && isIgnoredAppName(snapshot.appName)) return

  clearPopupHideAnimationTimeout(id)

  let evictedIds: number[] = []

  setPopupRenderIds((prev) => {
    const next = [id, ...prev.filter((entry) => entry !== id)].slice(0, 5)
    evictedIds = prev.filter((entry) => !next.includes(entry))
    return next
  })

  setPopupVisibleIds((prev) => [id, ...prev.filter((entry) => entry !== id)].slice(0, 5))

  for (const evictedId of evictedIds) dropPopup(evictedId)
  schedulePopupHide(id)
}

function setupNotifd() {
  if (notifdInitialized) return
  notifdInitialized = true

  ensureDismissedIdsLoaded()
  ensureIgnoredAppsLoaded()
  setDontDisturbState(readDontDisturb())

  const syncDontDisturbState = () => setDontDisturbState(readDontDisturb())
  for (const signal of ["notify::dont-disturb", "notify::dont_disturb", "notify::dontDisturb"]) {
    try {
      notifd.connect(signal, syncDontDisturbState)
    } catch {}
  }

  try {
    const liveNotifications = notifd.get_notifications?.() ?? notifd.notifications ?? []
    if (Array.isArray(liveNotifications)) {
      const liveIds = liveNotifications
        .map((notification: any) => safeNumber(getProp(notification, "id")))
        .filter((id: number) => id > 0)

      pruneDismissedIds(liveIds)

      for (const notification of liveNotifications) {
        const snapshot = snapshotNotification(notification)
        if (isDismissedId(snapshot.id)) continue
        if (isIgnoredAppName(snapshot.appName)) {
          dismissNotification(snapshot.id)
          continue
        }
        updateHistoryEntry(snapshot)
      }
    }
  } catch {}

  notifd.connect("notified", (_self: any, id: number) => {
    if (isDismissedId(id)) return

    const notification = notifd.get_notification(id)
    if (!notification) return

    const snapshot = snapshotNotification(notification)
    if (isIgnoredAppName(snapshot.appName)) {
      dismissNotification(id)
      return
    }

    updateHistoryEntry(snapshot)

    const dontDisturb = Boolean(getProp(notifd, "dontDisturb", "dont_disturb", "dont-disturb"))
    if (!dontDisturb) showPopup(id)
  })

  notifd.connect("resolved", (_self: any, id: number) => {
    hidePopup(id)
    unmarkDismissedId(id)

    const notification = notifd.get_notification(id)
    if (notification) updateHistoryEntry(snapshotNotification(notification))
  })
}

function getLiveNotification(id: number) {
  try {
    return notifd.get_notification(id)
  } catch {
    return null
  }
}

function formatTime(timestamp: number) {
  try {
    const date = GLib.DateTime.new_from_unix_local(Math.floor(timestamp / 1000))
    return date?.format("%H:%M") ?? "--:--"
  } catch {
    return "--:--"
  }
}

function iconNameFromNotification(snapshot: NotificationSnapshot) {
  const icon = snapshot.appIcon.trim()
  if (icon) return icon
  return "dialog-information-symbolic"
}

function invokeAction(notification: any, actionId: string) {
  if (!notification) return

  try {
    notification.invoke(actionId)
    return
  } catch {}

  try {
    const actions = notification.actions
    if (!Array.isArray(actions)) return

    const action = actions.find((entry: any) => safeString(getProp(entry, "id")) === actionId)
    action?.invoke?.()
  } catch {}
}

function dismissNotification(id: number) {
  const notification = getLiveNotification(id)

  try {
    notification?.dismiss?.()
    return
  } catch {}

  try {
    notification?.close?.()
    return
  } catch {}

  try {
    notifd.dismiss?.(id)
    return
  } catch {}

  try {
    notifd.resolve?.(id)
  } catch {}
}

function escapeMarkup(text: string) {
  return GLib.markup_escape_text(text ?? "", -1)
}

function configureNotificationLabel(
  self: Gtk.Label,
  text: string,
  {
    wrap = false,
    compact = false,
    singleLine = false,
    maxWidthChars = 0,
    xalign = 0,
  }: {
    wrap?: boolean
    compact?: boolean
    singleLine?: boolean
    maxWidthChars?: number
    xalign?: number
  },
) {
  self.set_xalign(xalign)
  self.set_wrap(wrap)
  self.set_ellipsize(compact ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE)
  self.set_single_line_mode(singleLine)

  if (wrap) self.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
  if (maxWidthChars > 0) self.set_max_width_chars(maxWidthChars)

  if (!compact) {
    self.set_use_markup(true)
    self.set_markup(`<span line_height="1.15">${escapeMarkup(text)}</span>`)
    return
  }

  self.set_use_markup(false)
  self.set_label(text)
}

function groupNotifications(items: NotificationSnapshot[]) {
  const groups = new Map<string, NotificationGroupSnapshot>()
  const ordered: NotificationGroupSnapshot[] = []

  for (const item of items) {
    const label = displayAppName(item.appName)
    const key = normalizeAppKey(label)
    let group = groups.get(key)

    if (!group) {
      group = {
        key,
        label,
        icon: iconNameFromNotification(item),
        latestTime: item.time,
        items: [],
      }

      groups.set(key, group)
      ordered.push(group)
    }

    group.items.push(item)
    if (item.time > group.latestTime) group.latestTime = item.time
    if (!group.icon && item.appIcon.trim().length > 0) group.icon = iconNameFromNotification(item)
  }

  return ordered.sort((a, b) => b.latestTime - a.latestTime)
}

function NotificationCard({
  snapshot,
  compact = false,
  grouped = false,
  showAppName = true,
}: {
  snapshot: NotificationSnapshot
  compact?: boolean
  grouped?: boolean
  showAppName?: boolean
}) {
  const actions = snapshot.actions
  const hasBody = snapshot.body.trim().length > 0
  const summaryText = snapshot.summary.trim()
  const className = compact
    ? "notification-card notification-toast-card"
    : grouped
      ? "notification-card notification-group-item"
      : "notification-card notification-history-card"

  return (
    <box
      class={className}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={grouped ? 6 : 8}
    >
      <box class="notification-content-row" spacing={grouped ? 0 : 10} valign={Gtk.Align.START}>
        <image
          class="notification-app-icon"
          iconName={iconNameFromNotification(snapshot)}
          pixelSize={18}
          valign={Gtk.Align.START}
          visible={!grouped}
        />

        <box class="notification-text-stack" orientation={Gtk.Orientation.VERTICAL} spacing={5} hexpand>
          <box class="notification-summary-row" spacing={8} hexpand>
            <label
              class="notification-summary"
              hexpand
              visible={summaryText.length > 0}
              $={(self) => configureNotificationLabel(self, summaryText.length > 0 ? summaryText : "Notification", {
                wrap: !compact,
                compact,
                singleLine: compact,
                maxWidthChars: compact ? 26 : 0,
              })}
            />
            <label
              class="notification-time"
              $={(self) => configureNotificationLabel(self, formatTime(snapshot.time), {
                compact,
                singleLine: true,
                xalign: 1,
              })}
            />
          </box>

          <label
            class="notification-app-name"
            visible={showAppName && snapshot.appName.trim().length > 0}
            $={(self) => configureNotificationLabel(self, displayAppName(snapshot.appName), {
              compact,
              singleLine: true,
              maxWidthChars: compact ? 36 : 0,
            })}
          />

          <label
            class="notification-body"
            visible={hasBody}
            $={(self) => configureNotificationLabel(self, snapshot.body, {
              wrap: !compact,
              compact,
              singleLine: compact,
              maxWidthChars: compact ? 36 : 0,
            })}
          />
        </box>
      </box>

      <box class="notification-actions" spacing={6} visible={actions.length > 0}>
        <For each={() => actions}>
          {(action) => (
            <button
              class="notification-action-button"
              onClicked={() => invokeAction(getLiveNotification(snapshot.id), action.id)}
            >
              <label label={action.label} />
            </button>
          )}
        </For>
      </box>
    </box>
  )
}

function NotificationGroup({ group }: { group: NotificationGroupSnapshot }) {
  return (
    <box class="notification-app-group" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <box class="notification-app-group-header" spacing={10} valign={Gtk.Align.CENTER}>
        <image
          class="notification-app-icon notification-group-icon"
          iconName={group.icon}
          pixelSize={18}
          valign={Gtk.Align.CENTER}
        />

        <box class="notification-app-group-meta" orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <box class="notification-app-group-title-row" spacing={8} valign={Gtk.Align.CENTER}>
            <label class="notification-app-group-title" xalign={0} hexpand label={group.label} />
            <label class="notification-app-group-time" label={formatTime(group.latestTime)} />
          </box>
          <label
            class="notification-app-group-count"
            xalign={0}
            label={group.items.length === 1 ? "1 notification" : `${group.items.length} notifications`}
          />
        </box>

        <button
          class="notification-action-button notification-inline-manage-button"
          tooltipText={`Ignore ${group.label}`}
          onClicked={() => ignoreApp(group.label)}
        >
          <label label="Ignore" />
        </button>
      </box>

      <box class="notification-group-items" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <For each={() => group.items}>
          {(item) => <NotificationCard snapshot={item} grouped showAppName={false} />}
        </For>
      </box>
    </box>
  )
}

function NotificationToastWindow({ monitor }: { monitor: number }) {
  return (
    <window
      visible={popupRenderIds((list) => list.length > 0)}
      monitor={monitor}
      namespace="obsidian-shell"
      class="widget-popup-window notification-toast-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.NONE}
      anchor={TOAST_WINDOW_ANCHOR}
    >
      <box
        class="notification-toast-placement"
        orientation={Gtk.Orientation.VERTICAL}
        spacing={TOAST_GAP}
        halign={Gtk.Align.END}
        valign={Gtk.Align.END}
        $={(self) => {
          self.set_margin_end(TOAST_MARGIN_END)
          self.set_margin_bottom(TOAST_MARGIN_BOTTOM)
        }}
      >
        <For each={popupRenderIds}>
          {(id) => (
            <revealer
              class="widget-popup-revealer"
              revealChild={popupVisibleIds((list) => list.includes(id))}
              transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
              transitionDuration={TOAST_REVEAL_DURATION_MS}
              $={(self) => idle(() => (self.revealChild = true))}
            >
              <box class="notification-toast-frame" widthRequest={TOAST_WIDTH}>
                <With value={history}>
                  {(items) => {
                    const snapshot = items.find((entry) => entry.id === id)
                    return snapshot ? <NotificationCard snapshot={snapshot} compact /> : <box />
                  }}
                </With>
              </box>
            </revealer>
          )}
        </For>
      </box>
    </window>
  )
}

export function Notifications({ monitor }: { monitor: number }) {
  setupNotifd()

  let trigger: Gtk.Button | null = null
  let popupPlacement: Gtk.Box | null = null
  let popupSlideRevealer: Gtk.Revealer | null = null
  let popupFadeRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let closeTimeoutId = 0
  let popupFadeTimeoutId = 0
  let popupSlideTimeoutId = 0
  let ignoredSlideRevealer: Gtk.Revealer | null = null
  let ignoredFadeRevealer: Gtk.Revealer | null = null
  let ignoredFadeTimeoutId = 0
  let ignoredSlideTimeoutId = 0
  let closingPopup = false

  const [windowVisible, setWindowVisible] = createState(false)

  const clearSource = (sourceId: number) => {
    if (sourceId === 0) return 0

    try {
      GLib.source_remove(sourceId)
    } catch {}

    return 0
  }

  const clearCloseTimeout = () => {
    closeTimeoutId = clearSource(closeTimeoutId)
  }

  const clearPopupAnimationTimeouts = () => {
    popupFadeTimeoutId = clearSource(popupFadeTimeoutId)
    popupSlideTimeoutId = clearSource(popupSlideTimeoutId)
  }

  const clearIgnoredAnimationTimeouts = () => {
    ignoredFadeTimeoutId = clearSource(ignoredFadeTimeoutId)
    ignoredSlideTimeoutId = clearSource(ignoredSlideTimeoutId)
  }

  const setTriggerOpen = (open: boolean) => {
    if (!trigger) return
    if (open) trigger.add_css_class("widget-trigger-open")
    else trigger.remove_css_class("widget-trigger-open")
  }

  const finishClosePopup = () => {
    clearCloseTimeout()
    clearPopupAnimationTimeouts()
    closingPopup = false
    setWindowVisible(false)
    setTriggerOpen(false)
  }

  const setPopupOpen = (open: boolean) => {
    clearPopupAnimationTimeouts()

    if (open) {
      if (popupFadeRevealer) popupFadeRevealer.revealChild = false

      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (popupSlideRevealer) popupSlideRevealer.revealChild = true

        popupFadeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HISTORY_FADE_DELAY_MS, () => {
          popupFadeTimeoutId = 0
          if (popupFadeRevealer) popupFadeRevealer.revealChild = true
          return GLib.SOURCE_REMOVE
        })

        return GLib.SOURCE_REMOVE
      })
      return
    }

    if (popupFadeRevealer) popupFadeRevealer.revealChild = false

    popupSlideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HISTORY_HIDE_SLIDE_DELAY_MS, () => {
      popupSlideTimeoutId = 0
      if (popupSlideRevealer) popupSlideRevealer.revealChild = false
      return GLib.SOURCE_REMOVE
    })
  }

  const closePopup = () => {
    if (closingPopup || !windowVisible()) return

    closingPopup = true

    if (popupSlideRevealer?.get_reveal_child()) {
      setPopupOpen(false)
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HISTORY_REVEAL_DURATION_MS, () => {
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
    clearPopupAnimationTimeouts()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    setPopupOpen(true)
  }

  const setIgnoredOpen = (open: boolean) => {
    clearIgnoredAnimationTimeouts()
    setIgnoredManagerOpen(open)

    if (open) {
      if (ignoredFadeRevealer) ignoredFadeRevealer.revealChild = false

      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (ignoredSlideRevealer) ignoredSlideRevealer.revealChild = true

        ignoredFadeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IGNORED_FADE_DELAY_MS, () => {
          ignoredFadeTimeoutId = 0
          if (ignoredFadeRevealer) ignoredFadeRevealer.revealChild = true
          return GLib.SOURCE_REMOVE
        })

        return GLib.SOURCE_REMOVE
      })
      return
    }

    if (ignoredFadeRevealer) ignoredFadeRevealer.revealChild = false

    ignoredSlideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IGNORED_HIDE_SLIDE_DELAY_MS, () => {
      ignoredSlideTimeoutId = 0
      if (ignoredSlideRevealer) ignoredSlideRevealer.revealChild = false
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (windowVisible()) closePopup()
    else openPopup()
  }

  const unresolvedCount = history((items) => items.filter((entry) => Boolean(getLiveNotification(entry.id))).length)
  const bellTooltip = unresolvedCount((count) => (count > 0 ? `Notifications (${count})` : "Notifications"))
  const bellGlyph = unresolvedCount((count) => (count > 0 ? ACTIVE_NOTIFICATION_GLYPH : IDLE_NOTIFICATION_GLYPH))
  const hasItems = history((items) => items.length > 0)

  const popupContent = (
    <box class="notification-history-shell" orientation={Gtk.Orientation.VERTICAL} spacing={8} hexpand>
      <box class="notification-history-panel" orientation={Gtk.Orientation.VERTICAL} spacing={10} hexpand halign={Gtk.Align.FILL}>
        <box
          class="notification-history-content"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={0}
          heightRequest={HISTORY_MIN_HEIGHT}
        >
          <With value={history}>
            {(items) => {
              const groups = groupNotifications(items)

              return (
                items.length === 0 ? (
                  <box
                    class="notification-history-empty"
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={0}
                    hexpand
                    halign={Gtk.Align.FILL}
                    valign={Gtk.Align.FILL}
                    vexpand
                  >
                    <box vexpand />
                    <box
                      class="notification-history-empty-center"
                      orientation={Gtk.Orientation.VERTICAL}
                      spacing={8}
                      halign={Gtk.Align.CENTER}
                      valign={Gtk.Align.CENTER}
                    >
                      <label class="module-icon notification-empty-glyph" halign={Gtk.Align.CENTER} label={bellGlyph} />
                      <label class="notification-empty-title" xalign={0.5} halign={Gtk.Align.CENTER} label="No notifications yet" />
                    </box>
                    <box vexpand />
                  </box>
                ) : (
                  <Gtk.ScrolledWindow
                    class="notification-history-scroll"
                    hscrollbarPolicy={Gtk.PolicyType.NEVER}
                    vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
                    minContentHeight={0}
                    maxContentHeight={HISTORY_MAX_HEIGHT}
                    propagateNaturalHeight
                    overlayScrolling
                    vexpand
                  >
                    <box class="notification-history-list" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                      <For each={() => groups}>{(group) => <NotificationGroup group={group} />}</For>
                    </box>
                  </Gtk.ScrolledWindow>
                )
              )
            }}
          </With>
        </box>
      </box>

      <box class="notification-history-topbar notification-history-header" spacing={8}>
        <label class="module-icon notification-header-glyph" label={bellGlyph} />
        <label class="notification-history-title" hexpand xalign={0} halign={Gtk.Align.FILL} label="Notifications" />
        <box class="notification-header-actions" spacing={8} halign={Gtk.Align.END}>
          <button
            class={ignoredManagerOpen()
              ? "flat notification-dnd-button notification-dnd-button-active"
              : "flat notification-dnd-button"}
            tooltipText={ignoredAppsState((apps) => apps.length > 0 ? `Ignored apps (${apps.length})` : "Ignored apps")}
            onClicked={() => setIgnoredOpen(!ignoredManagerOpen())}
          >
            <label class="notification-dnd-label" label={IGNORED_APPS_LABEL} />
          </button>

          <button
            class={dontDisturbState((enabled) => enabled ? "flat notification-dnd-button notification-dnd-button-active" : "flat notification-dnd-button")}
            tooltipText={dontDisturbState((enabled) => enabled ? "Disable Do Not Disturb" : "Enable Do Not Disturb")}
            onClicked={() => setDontDisturb(!dontDisturbState())}
          >
            <label class="notification-dnd-label" label={DND_LABEL} />
          </button>

          <button
            class="flat notification-clear-button"
            tooltipText={hasItems((present) => present ? "Clear history" : "Already empty")}
            sensitive={hasItems}
            onClicked={() => {
              const ids = history().map((entry) => entry.id)
              if (ids.length === 0) return

              markDismissedIds(ids)
              for (const id of ids) dismissNotification(id)
              for (const id of ids) dropPopup(id)
              setHistory([])
            }}
          >
            <label class="notification-clear-label" label="Clear" />
          </button>
        </box>
      </box>

      <revealer
        class="notification-ignored-revealer"
        revealChild={false}
        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        transitionDuration={IGNORED_SLIDE_DURATION_MS}
        $={(self) => {
          ignoredSlideRevealer = self
          self.revealChild = ignoredManagerOpen()
        }}
      >
        <revealer
          class="notification-ignored-fade-revealer"
          revealChild={false}
          transitionType={Gtk.RevealerTransitionType.CROSSFADE}
          transitionDuration={IGNORED_FADE_DURATION_MS}
          $={(self) => {
            ignoredFadeRevealer = self
            self.revealChild = ignoredManagerOpen()
          }}
        >
          <box class="notification-ignored-panel" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
            <With value={ignoredAppsState}>
              {(apps) => (
                <box class="notification-ignored-content" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                  <box class="notification-ignored-header" spacing={8} valign={Gtk.Align.CENTER}>
                    <label class="notification-ignored-title" xalign={0} hexpand label="Ignored apps" />
                    <label
                      class="notification-ignored-count"
                      label={apps.length === 1 ? "1 app" : `${apps.length} apps`}
                    />
                  </box>

                  {
                    apps.length === 0 ? (
                      <label class="notification-ignored-empty" xalign={0} label="No ignored apps" />
                    ) : (
                      <box class="notification-ignored-list" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                        <For each={() => apps}>
                          {(app) => (
                            <box class="notification-ignored-row" spacing={10} valign={Gtk.Align.CENTER}>
                              <label class="notification-ignored-app" xalign={0} hexpand label={app.label} />
                              <button
                                class="notification-action-button notification-inline-manage-button"
                                tooltipText={`Stop ignoring ${app.label}`}
                                onClicked={() => unignoreApp(app.key)}
                              >
                                <label label="Remove" />
                              </button>
                            </box>
                          )}
                        </For>
                      </box>
                    )
                  }
                </box>
              )}
            </With>
          </box>
        </revealer>
      </revealer>

      <PlayerDock showPinButton />
    </box>
  )

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      namespace="obsidian-shell"
      class="widget-popup-window notification-history-window"
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
    >
      <box class="widget-popup-root" hexpand vexpand>
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
          class="widget-popup-placement notification-history-placement"
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.START}
          $={(self) => {
            popupPlacement = self
            self.set_margin_top(TOP_BAR_POPUP_MARGIN_TOP)
          }}
        >
          <revealer
            class="widget-popup-revealer notification-history-slide-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
            transitionDuration={HISTORY_REVEAL_DURATION_MS}
            $={(self) => (popupSlideRevealer = self)}
          >
            <revealer
              class="notification-history-fade-revealer"
              revealChild={false}
              transitionType={Gtk.RevealerTransitionType.CROSSFADE}
              transitionDuration={HISTORY_FADE_DURATION_MS}
              $={(self) => (popupFadeRevealer = self)}
            >
              <box
                class="widget-popup-frame notification-history-frame"
                widthRequest={HISTORY_WIDTH}
                $={(self) => (popupFrame = self)}
              >
                {popupContent}
              </box>
            </revealer>
          </revealer>
        </box>
      </box>
    </window>
  )

  const toastWindow = <NotificationToastWindow monitor={monitor} />

  void popupWindow
  void toastWindow

  return (
    <box class="notification-center-shell" valign={Gtk.Align.CENTER}>
      <button
        class="notification-center-trigger"
        valign={Gtk.Align.CENTER}
        tooltipText={bellTooltip}
        onClicked={togglePopup}
        $={(self) => {
          trigger = self

          self.connect("destroy", () => {
            clearCloseTimeout()
            clearPopupAnimationTimeouts()
            clearIgnoredAnimationTimeouts()
            closingPopup = false
            setWindowVisible(false)
            setTriggerOpen(false)
          })
        }}
      >
        <label class="module-icon notification-center-glyph" label={bellGlyph} />
      </button>
    </box>
  )
}
