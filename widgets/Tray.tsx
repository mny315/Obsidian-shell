import { createBinding, For } from "ags"

import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import AstalTray from "gi://AstalTray?version=0.1"

import { debugPopupLog } from "./DebugPopupLog"

// DEBUG_POPUP_LOG: temporary tray diagnostics. Safe to remove together with
// widgets/DebugPopupLog.ts after the intermittent click/popup bug is found.
function trayItemSnapshot(item: any, menu: Gtk.PopoverMenu | null, image: Gtk.Image | null = null) {
  let id = ""
  let title = ""
  let tooltip = ""
  let iconName = ""
  let hasGicon = false
  let hasMenuModel = false
  let hasActionGroup = false
  let visible: boolean | undefined = undefined

  try { id = String(item.id ?? item.itemId ?? item.busName ?? item.bus_name ?? "") } catch {}
  try { title = String(item.title ?? item.name ?? "") } catch {}
  try { tooltip = String(item.tooltipMarkup ?? item.tooltip_markup ?? "") } catch {}
  try { iconName = String(item.iconName ?? item.icon_name ?? "") } catch {}
  try { hasGicon = Boolean(item.gicon) } catch {}
  try { hasMenuModel = Boolean(item.menuModel ?? item.menu_model ?? menu?.menuModel) } catch {}
  try { hasActionGroup = Boolean(item.actionGroup ?? item.action_group) } catch {}
  try { visible = image?.visible } catch {}

  return { id, title, tooltip, iconName, hasGicon, hasMenuModel, hasActionGroup, imageVisible: visible }
}

function TrayItem({ item }: { item: any }) {
  let menu: Gtk.PopoverMenu | null = null
  let image: Gtk.Image | null = null

  return (
    <box
      class="tray-item"
      tooltipMarkup={item.tooltipMarkup ?? ""}
      $={(self) => {
        const sync = () => {
          try {
            self.insert_action_group("dbusmenu", item.actionGroup ?? item.action_group ?? null)
          } catch {}

          try {
            if (menu) menu.menuModel = item.menuModel ?? item.menu_model ?? null
          } catch {}

          let hasIcon = false
          try {
            if (image) {
              if (item.gicon) {
                image.set_from_gicon(item.gicon)
                hasIcon = true
              } else if (item.iconName ?? item.icon_name) {
                image.set_from_icon_name(item.iconName ?? item.icon_name)
                hasIcon = true
              } else {
                image.clear()
              }
            }
          } catch {}

          self.visible = hasIcon

          debugPopupLog("tray", "sync", { ...trayItemSnapshot(item, menu, image), hasIcon })

          try {
            self.tooltipMarkup = item.tooltipMarkup ?? item.tooltip_markup ?? ""
          } catch {}
        }

        sync()
        const id = item.connect("notify", sync)
        self.connect("destroy", () => item.disconnect(id))
      }}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_PRIMARY}
        onPressed={(_, _nPress, x, y) => {
          debugPopupLog("tray", "primary pressed", { ...trayItemSnapshot(item, menu, image), x, y })
          try {
            item.activate(x, y)
            debugPopupLog("tray", "primary activate ok", trayItemSnapshot(item, menu, image))
          } catch (error) {
            debugPopupLog("tray", "primary activate failed; retry 0,0", { ...trayItemSnapshot(item, menu, image), error: String(error) })
            try {
              item.activate(0, 0)
              debugPopupLog("tray", "primary activate retry ok", trayItemSnapshot(item, menu, image))
            } catch (retryError) {
              debugPopupLog("tray", "primary activate retry failed", { ...trayItemSnapshot(item, menu, image), error: String(retryError) })
            }
          }
        }}
      />

      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={() => {
          debugPopupLog("tray", "secondary pressed", trayItemSnapshot(item, menu, image))
          try {
            menu?.popup()
            debugPopupLog("tray", "secondary menu popup ok", trayItemSnapshot(item, menu, image))
          } catch (error) {
            debugPopupLog("tray", "secondary menu popup failed", { ...trayItemSnapshot(item, menu, image), error: String(error) })
          }
        }}
      />

      <Gtk.PopoverMenu
        $={(self) => {
          menu = self
          self.add_css_class("tray-menu-popover-window")
          self.set_has_arrow(false)
          self.set_offset(0, 5)
          debugPopupLog("tray", "popover ready", trayItemSnapshot(item, menu, image))
        }}
      />

      <image
        $={(self) => (image = self)}
        pixelSize={18}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
        hexpand={true}
        vexpand={true}
      />
    </box>
  )
}

export function Tray() {
  const tray = AstalTray.get_default()
  const items = createBinding(tray, "items")

  return (
    <box class="section tray-capsule" visible={items((list) => list.length > 0)}
      $={() => debugPopupLog("tray", "capsule ready")}
    >
      <For each={items}>{(item) => <TrayItem item={item} />}</For>
    </box>
  )
}
