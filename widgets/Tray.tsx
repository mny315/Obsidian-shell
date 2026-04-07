import { createBinding, For } from "ags"

import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import AstalTray from "gi://AstalTray?version=0.1"

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
          try {
            item.activate(x, y)
          } catch {
            item.activate(0, 0)
          }
        }}
      />

      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={() => {
          try {
            menu?.popup()
          } catch {}
        }}
      />

      <Gtk.PopoverMenu
        $={(self) => {
          menu = self
          self.add_css_class("tray-menu-popover-window")
          self.set_has_arrow(false)
          self.set_offset(0, 5)
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
    <box class="section tray-capsule" visible={items((list) => list.length > 0)}>
      <For each={items}>{(item) => <TrayItem item={item} />}</For>
    </box>
  )
}
