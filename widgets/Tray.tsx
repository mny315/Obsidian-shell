import { createBinding, For } from "ags"

import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import AstalTray from "gi://AstalTray?version=0.1"

import { TOP_BAR_POPUP_MARGIN_TOP } from "./FloatingPopup"
import { attachShellTooltip } from "./ShellTooltip"

const TRAY_MENU_FALLBACK_OFFSET_Y = 30
const TRAY_MENU_RAISE_Y = 5

function toNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function syncTrayMenuOffset(trigger: Gtk.Widget | null, menu: Gtk.PopoverMenu | null) {
  if (!menu) return

  let offsetY = TRAY_MENU_FALLBACK_OFFSET_Y

  try {
    const root = trigger?.get_root?.() as Gtk.Widget | null
    const result = trigger && root && typeof (trigger as any).compute_bounds === "function"
      ? (trigger as any).compute_bounds(root)
      : null

    const ok = Array.isArray(result) ? Boolean(result[0]) : false
    const rect = Array.isArray(result) ? result[1] : null

    if (ok && rect) {
      const top = toNumber(rect?.origin?.y ?? rect?.y)
      const height = toNumber(rect?.size?.height ?? rect?.height ?? trigger?.get_height?.())
      offsetY = TOP_BAR_POPUP_MARGIN_TOP - Math.round(top + height)
    }
  } catch {}

  try {
    menu.set_offset(0, Math.max(0, Math.round(offsetY - TRAY_MENU_RAISE_Y)))
  } catch {}
}

function TrayItem({ item }: { item: any }) {
  let trigger: Gtk.Box | null = null
  let menu: Gtk.PopoverMenu | null = null
  let image: Gtk.Image | null = null

  return (
    <box
      class="tray-item"
      $={(self) => {
        attachShellTooltip(self, () => item.tooltipMarkup ?? item.tooltip_markup ?? "", { markup: true })
        trigger = self

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

        }

        sync()
        const id = item.connect("notify", sync)
        self.connect("destroy", () => {
          trigger = null
          item.disconnect(id)
        })
      }}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_PRIMARY}
        onPressed={(_, _nPress, x, y) => {
          try {
            item.activate(x, y)
          } catch (error) {
            try {
              item.activate(0, 0)
            } catch (retryError) {
            }
          }
        }}
      />

      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={() => {
          try {
            syncTrayMenuOffset(trigger, menu)
            menu?.popup()
          } catch (error) {
          }
        }}
      />

      <Gtk.PopoverMenu
        $={(self) => {
          menu = self
          self.add_css_class("tray-menu-popover-window")
          self.set_has_arrow(false)
          self.set_position(Gtk.PositionType.BOTTOM)
          syncTrayMenuOffset(trigger, menu)
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
    >
      <For each={items}>{(item) => <TrayItem item={item} />}</For>
    </box>
  )
}
