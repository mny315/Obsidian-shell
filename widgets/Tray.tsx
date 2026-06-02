import { createBinding, For } from "ags"

import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango?version=1.0"
import PangoCairo from "gi://PangoCairo?version=1.0"
import AstalTray from "gi://AstalTray?version=0.1"

import { TOP_BAR_POPUP_MARGIN_TOP } from "./FloatingPopup"
import { applyShellTextFont, attachShellTooltip } from "./ShellTooltip"

const TRAY_MENU_FALLBACK_OFFSET_Y = 30
const TRAY_MENU_RAISE_Y = 5

function toNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

const TRAY_MENU_TEXT_OVERSCAN_X = 2
const TRAY_MENU_TEXT_PADDING_TOP = 3
const TRAY_MENU_TEXT_PADDING_BOTTOM = 4

const trayMenuPatchedLabels = new WeakSet<Gtk.Widget>()
const trayMenuLabelAreas = new WeakMap<Gtk.Widget, Gtk.DrawingArea>()
const trayMenuPatchSourceIds = new WeakMap<Gtk.PopoverMenu, number>()
let openTrayMenu: Gtk.PopoverMenu | null = null

function clearSource(id: number) {
  if (id === 0) return 0

  try {
    GLib.source_remove(id)
  } catch {}

  return 0
}

function setCairoSourceFromWidgetColor(widget: Gtk.Widget, cr: any) {
  try {
    const color = (widget as any).get_color?.()
    if (color) {
      cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha)
      return
    }
  } catch {}

  try {
    const color = (widget as any).get_style_context?.()?.get_color?.()
    if (color) {
      cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha)
      return
    }
  } catch {}

  cr.setSourceRGBA(1, 1, 1, 1)
}

function readLabelText(label: Gtk.Widget) {
  try {
    const text = (label as any).get_text?.()
    if (typeof text === "string") return text
  } catch {}

  try {
    const text = (label as any).get_label?.()
    if (typeof text === "string") return text
  } catch {}

  return ""
}

function labelUsesMarkup(label: Gtk.Widget) {
  try {
    return Boolean((label as any).get_use_markup?.())
  } catch {
    return false
  }
}

function readRectNumber(rect: any, key: string) {
  return toNumber(rect?.[key], 0)
}

function readLayoutPixelExtents(layout: Pango.Layout) {
  try {
    const extents = (layout as any).get_pixel_extents?.()
    const ink = Array.isArray(extents) ? extents[0] : null
    const logical = Array.isArray(extents) ? extents[1] : null

    if (ink || logical) {
      return {
        inkX: readRectNumber(ink, "x"),
        inkY: readRectNumber(ink, "y"),
        inkWidth: Math.max(1, readRectNumber(ink, "width")),
        inkHeight: Math.max(1, readRectNumber(ink, "height")),
        logicalWidth: Math.max(1, readRectNumber(logical, "width")),
        logicalHeight: Math.max(1, readRectNumber(logical, "height")),
      }
    }
  } catch {}

  try {
    const size = layout.get_pixel_size()
    if (Array.isArray(size)) {
      return {
        inkX: 0,
        inkY: 0,
        inkWidth: Math.max(1, toNumber(size[0], 1)),
        inkHeight: Math.max(1, toNumber(size[1], 1)),
        logicalWidth: Math.max(1, toNumber(size[0], 1)),
        logicalHeight: Math.max(1, toNumber(size[1], 1)),
      }
    }
  } catch {}

  return {
    inkX: 0,
    inkY: 0,
    inkWidth: 1,
    inkHeight: 1,
    logicalWidth: 1,
    logicalHeight: 1,
  }
}

function createTrayMenuTextLayout(area: Gtk.DrawingArea, sourceLabel: Gtk.Widget, text: string) {
  const layout = area.create_pango_layout("")
  applyShellTextFont(layout, area)

  try {
    const attributes = (sourceLabel as any).get_attributes?.()
    if (attributes) layout.set_attributes(attributes)
  } catch {}

  try {
    layout.set_single_paragraph_mode(true)
  } catch {}

  try {
    const ellipsize = (sourceLabel as any).get_ellipsize?.()
    if (ellipsize !== undefined && ellipsize !== null) layout.set_ellipsize(ellipsize)
    else layout.set_ellipsize(Pango.EllipsizeMode.NONE)
  } catch {}

  try {
    if (labelUsesMarkup(sourceLabel)) layout.set_markup(text, -1)
    else layout.set_text(text, -1)
  } catch {
    layout.set_text(text, -1)
  }

  return layout
}

function measureTrayMenuText(area: Gtk.DrawingArea, sourceLabel: Gtk.Widget, text: string) {
  if (!text) return { width: 1, height: 1 }

  const layout = createTrayMenuTextLayout(area, sourceLabel, text)
  const extents = readLayoutPixelExtents(layout)
  const leftOverscan = Math.max(0, -extents.inkX)
  const topOverscan = Math.max(0, -extents.inkY)

  return {
    width: Math.max(1, Math.max(extents.logicalWidth, extents.inkWidth + leftOverscan) + TRAY_MENU_TEXT_OVERSCAN_X * 2),
    height: Math.max(1, Math.max(extents.logicalHeight, extents.inkHeight + topOverscan) + TRAY_MENU_TEXT_PADDING_TOP + TRAY_MENU_TEXT_PADDING_BOTTOM),
  }
}

function syncTrayMenuTextArea(area: Gtk.DrawingArea, sourceLabel: Gtk.Widget) {
  const text = readLabelText(sourceLabel)
  const { width, height } = measureTrayMenuText(area, sourceLabel, text)

  try {
    area.set_content_width(width)
    area.set_content_height(height)
  } catch {}

  try {
    area.queue_resize()
    area.queue_draw()
  } catch {}
}

function drawTrayMenuText(area: Gtk.DrawingArea, cr: any, width: number, height: number, sourceLabel: Gtk.Widget) {
  const text = readLabelText(sourceLabel)
  if (!text) return

  const layout = createTrayMenuTextLayout(area, sourceLabel, text)
  const extents = readLayoutPixelExtents(layout)
  const layoutWidth = Math.max(extents.logicalWidth, extents.inkWidth + Math.max(0, -extents.inkX))
  const layoutHeight = Math.max(extents.logicalHeight, extents.inkHeight + Math.max(0, -extents.inkY))

  let sourceXalign = 0
  let sourceYalign = 0.5

  try {
    sourceXalign = toNumber((sourceLabel as any).get_xalign?.(), 0)
  } catch {}

  try {
    sourceYalign = toNumber((sourceLabel as any).get_yalign?.(), 0.5)
  } catch {}

  const x = Math.max(0, Math.round((width - layoutWidth) * sourceXalign) + TRAY_MENU_TEXT_OVERSCAN_X - Math.min(0, extents.inkX))
  const y = Math.max(0, Math.round((height - layoutHeight) * sourceYalign) + TRAY_MENU_TEXT_PADDING_TOP - Math.min(0, extents.inkY))

  try {
    cr.save()
    setCairoSourceFromWidgetColor(area, cr)
    cr.moveTo(x, y)
    PangoCairo.show_layout(cr, layout)
    cr.restore()
  } catch (error) {
    console.error(error)
  }
}

function copyTrayMenuLabelSizing(sourceLabel: Gtk.Widget, area: Gtk.DrawingArea) {
  try {
    area.set_halign(sourceLabel.get_halign?.() ?? Gtk.Align.START)
  } catch {}

  try {
    area.set_valign(sourceLabel.get_valign?.() ?? Gtk.Align.CENTER)
  } catch {}

  try {
    area.set_hexpand(Boolean(sourceLabel.get_hexpand?.()))
  } catch {}

  try {
    area.set_vexpand(Boolean(sourceLabel.get_vexpand?.()))
  } catch {}

  try {
    const classes = (sourceLabel as any).get_css_classes?.()
    if (Array.isArray(classes)) {
      for (const cssClass of classes) area.add_css_class(cssClass)
    }
  } catch {}

  area.add_css_class("tray-menu-pango-label")

  try {
    ;(area as any).set_focusable?.(false)
  } catch {}

  try {
    ;(area as any).set_can_target?.(false)
  } catch {}
}

function removeTrayMenuNativeLabel(sourceLabel: Gtk.Widget, replacement: Gtk.Widget) {
  const parent = sourceLabel.get_parent?.() as Gtk.Widget | null
  if (!parent) return

  try {
    if (parent instanceof Gtk.Box) {
      parent.remove(sourceLabel)
      return
    }
  } catch {}

  try {
    const remove = (parent as any).remove
    if (typeof remove === "function") {
      remove.call(parent, sourceLabel)
      return
    }
  } catch {}

  try {
    if (parent instanceof Gtk.Button && (parent as any).get_child?.() === sourceLabel) {
      parent.set_child(replacement)
      return
    }
  } catch {}

  try {
    ;(sourceLabel as any).unparent?.()
  } catch {}
}

function replaceTrayMenuNativeLabel(sourceLabel: Gtk.Widget, area: Gtk.DrawingArea) {
  const parent = sourceLabel.get_parent?.() as Gtk.Widget | null
  if (!parent) return false

  try {
    if (parent instanceof Gtk.Button && (parent as any).get_child?.() === sourceLabel) {
      parent.set_child(area)
      return true
    }
  } catch {}

  try {
    const insertAfter = (area as any).insert_after
    if (typeof insertAfter === "function") {
      insertAfter.call(area, parent, sourceLabel)
      removeTrayMenuNativeLabel(sourceLabel, area)
      return true
    }
  } catch {}

  try {
    if (parent instanceof Gtk.Box) {
      parent.insert_child_after(area, sourceLabel)
      removeTrayMenuNativeLabel(sourceLabel, area)
      return true
    }
  } catch {}

  return false
}

function patchTrayMenuLabel(sourceLabel: Gtk.Widget) {
  if (trayMenuPatchedLabels.has(sourceLabel)) return

  const text = readLabelText(sourceLabel)
  if (!text) return

  const area = new Gtk.DrawingArea({
    hexpand: false,
    vexpand: false,
    halign: Gtk.Align.START,
    valign: Gtk.Align.CENTER,
  })

  copyTrayMenuLabelSizing(sourceLabel, area)
  area.set_draw_func((self, cr, width, height) => drawTrayMenuText(self, cr, width, height, sourceLabel))
  syncTrayMenuTextArea(area, sourceLabel)

  if (!replaceTrayMenuNativeLabel(sourceLabel, area)) return

  trayMenuPatchedLabels.add(sourceLabel)
  trayMenuLabelAreas.set(sourceLabel, area)

  try {
    sourceLabel.connect("notify::label", () => syncTrayMenuTextArea(area, sourceLabel))
  } catch {}

  try {
    sourceLabel.connect("notify::use-markup", () => syncTrayMenuTextArea(area, sourceLabel))
  } catch {}

  try {
    sourceLabel.connect("notify::attributes", () => syncTrayMenuTextArea(area, sourceLabel))
  } catch {}

  try {
    sourceLabel.connect("destroy", () => {
      trayMenuLabelAreas.delete(sourceLabel)
    })
  } catch {}
}

function walkTrayMenuWidgets(widget: Gtk.Widget | null, callback: (widget: Gtk.Widget) => void) {
  if (!widget) return

  callback(widget)

  let child: Gtk.Widget | null = null
  try {
    child = widget.get_first_child?.() as Gtk.Widget | null
  } catch {
    child = null
  }

  while (child) {
    const next = (() => {
      try {
        return child?.get_next_sibling?.() as Gtk.Widget | null
      } catch {
        return null
      }
    })()

    walkTrayMenuWidgets(child, callback)
    child = next
  }
}

function patchTrayMenuText(menu: Gtk.PopoverMenu | null) {
  if (!menu) return

  walkTrayMenuWidgets(menu, (widget) => {
    if (widget instanceof Gtk.Label) patchTrayMenuLabel(widget)
  })
}

function queueTrayMenuTextPatch(menu: Gtk.PopoverMenu | null) {
  if (!menu) return

  const previousSourceId = trayMenuPatchSourceIds.get(menu) ?? 0
  clearSource(previousSourceId)

  const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    trayMenuPatchSourceIds.delete(menu)
    patchTrayMenuText(menu)
    return GLib.SOURCE_REMOVE
  })

  trayMenuPatchSourceIds.set(menu, sourceId)
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

function showTrayMenu(menu: Gtk.PopoverMenu | null) {
  if (!menu) return

  if (openTrayMenu && openTrayMenu !== menu) {
    try {
      openTrayMenu.popdown()
    } catch {}
  }

  openTrayMenu = menu
  menu.popup()
}

function forgetTrayMenu(menu: Gtk.PopoverMenu) {
  if (openTrayMenu === menu) openTrayMenu = null
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
            if (menu) {
              menu.menuModel = item.menuModel ?? item.menu_model ?? null
              queueTrayMenuTextPatch(menu)
            }
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
            queueTrayMenuTextPatch(menu)
            showTrayMenu(menu)
            queueTrayMenuTextPatch(menu)
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
          queueTrayMenuTextPatch(self)

          try {
            self.connect("map", () => queueTrayMenuTextPatch(self))
          } catch {}

          try {
            self.connect("notify::visible", () => {
              if (!self.get_visible()) forgetTrayMenu(self)
              queueTrayMenuTextPatch(self)
            })
          } catch {}

          try {
            self.connect("closed", () => forgetTrayMenu(self))
          } catch {}

          try {
            self.connect("destroy", () => forgetTrayMenu(self))
          } catch {}
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
