import Gio from "gi://Gio"
import GLib from "gi://GLib"

type NotificationUrgency = "low" | "normal" | "critical"

type SendShellNotificationParams = {
  appName?: string
  summary: string
  body?: string
  iconName?: string
  urgency?: NotificationUrgency
  expireTimeoutMs?: number
  replaceKey?: string
  category?: string
}

const NOTIFICATIONS_SERVICE = "org.freedesktop.Notifications"
const NOTIFICATIONS_PATH = "/org/freedesktop/Notifications"
const NOTIFICATIONS_IFACE = "org.freedesktop.Notifications"

let sessionBus: Gio.DBusConnection | null = null
let sessionBusPromise: Promise<Gio.DBusConnection> | null = null
const replacementIds = new Map<string, number>()

function getSessionBusAsync() {
  if (sessionBus && !sessionBus.is_closed()) return Promise.resolve(sessionBus)
  if (sessionBusPromise) return sessionBusPromise

  sessionBusPromise = new Promise<Gio.DBusConnection>((resolve, reject) => {
    Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
      try {
        sessionBus = Gio.bus_get_finish(result)
        sessionBusPromise = null
        resolve(sessionBus)
      } catch (error) {
        sessionBusPromise = null
        reject(error)
      }
    })
  })

  return sessionBusPromise
}

function urgencyByte(urgency: NotificationUrgency) {
  switch (urgency) {
    case "low":
      return 0
    case "critical":
      return 2
    default:
      return 1
  }
}

export async function sendShellNotification({
  appName = "AGS",
  summary,
  body = "",
  iconName = "dialog-information-symbolic",
  urgency = "normal",
  expireTimeoutMs = 4200,
  replaceKey,
  category,
}: SendShellNotificationParams) {
  const safeSummary = summary.trim()
  const safeBody = body.trim()
  if (safeSummary.length === 0 && safeBody.length === 0) return 0

  const hints: Record<string, GLib.Variant> = {
    urgency: new GLib.Variant("y", urgencyByte(urgency)),
  }

  if (category && category.trim().length > 0) {
    hints.category = new GLib.Variant("s", category.trim())
  }

  const replacesId = replaceKey ? (replacementIds.get(replaceKey) ?? 0) : 0

  const connection = await getSessionBusAsync()

  const result = await new Promise<GLib.Variant>((resolve, reject) => {
    connection.call(
      NOTIFICATIONS_SERVICE,
      NOTIFICATIONS_PATH,
      NOTIFICATIONS_IFACE,
      "Notify",
      new GLib.Variant("(susssasa{sv}i)", [
        appName,
        replacesId,
        iconName,
        safeSummary,
        safeBody,
        [],
        hints,
        expireTimeoutMs,
      ]),
      new GLib.VariantType("(u)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (_conn, res) => {
        try {
          resolve(connection.call_finish(res))
        } catch (error) {
          reject(error)
        }
      },
    )
  })

  const [id] = result.deepUnpack() as [number]
  if (replaceKey && typeof id === "number" && id > 0) replacementIds.set(replaceKey, id)
  return id
}
