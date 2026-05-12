import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { Astal } from "ags/gtk4"
import { createState } from "ags"
import { createPoll } from "ags/time"

import { fallback } from "../config"
import { attachEscapeKey } from "./EscapeKey"
import { LEFT_TOP_POPUP_ANCHOR, attachPopupFocusDismiss, clipRoundedWidget, placeLayerWindowFromTrigger } from "./FloatingPopup"
import { closeOtherPopups, registerPopupController } from "./PopupRegistry"
import { attachShellTooltip } from "./ShellTooltip"
import { WallpaperWidgetButton } from "./WallpaperWidget"

const CALENDAR_POPOVER_REVEAL_DURATION_MS = 165
const CALENDAR_POPOVER_WIDTH = 318
const CALENDAR_POPOVER_OFFSET_X = -30
const CALENDAR_POPOVER_OFFSET_Y = 15

export function Clock({ monitor }: { monitor: number }) {
  let trigger: Gtk.Button | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let closeTimeoutId = 0
  let closingPopup = false
  const [windowVisible, setWindowVisible] = createState(false)
  const popupRegistryId = `calendar:${monitor}`

  const time = createPoll(
    fallback.clock,
    1000,
    ["bash", "-lc", "LC_TIME=C date '+%H:%M %a %b %-d'"],
  )

  const today = createPoll(
    "",
    60000,
    ["bash", "-lc", "LC_TIME=C date '+%A, %B %-d, %Y'"],
  )

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

  const syncPopupPosition = () => {
    placeLayerWindowFromTrigger(trigger, popupWindowRef, popupFrame, {
      align: "start",
      offsetX: CALENDAR_POPOVER_OFFSET_X,
      offsetY: CALENDAR_POPOVER_OFFSET_Y,
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
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALENDAR_POPOVER_REVEAL_DURATION_MS, () => {
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
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState("revealer missing after open")
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (closingPopup) return

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

  const popupWindow = (
    <window
      visible={windowVisible}
      monitor={monitor}
      defaultWidth={-1}
      defaultHeight={-1}
      resizable={false}
      namespace="obsidian-shell-calendar"
      class="widget-popup-window calendar-popup-window"
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
        <box class="widget-popup-placement" halign={Gtk.Align.START} valign={Gtk.Align.START}>
          <revealer
            class="widget-popup-revealer"
            revealChild={false}
            transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
            transitionDuration={CALENDAR_POPOVER_REVEAL_DURATION_MS}
            $={(self) => (popupRevealer = self)}
          >
            <box class="widget-popup-frame calendar-popover-window" widthRequest={CALENDAR_POPOVER_WIDTH} $={(self) => {
              clipRoundedWidget(self)
              popupFrame = self
            }}>
              <box class="calendar-popover" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
                <box class="calendar-header" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                  <label class="calendar-title" xalign={0} label="Calendar" />
                  <label class="calendar-date" xalign={0} label={today} />
                </box>

                <Gtk.Calendar
                  class="calendar-widget"
                  showDayNames
                  showHeading
                  showWeekNumbers
                />
              </box>
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )

  void popupWindow

  return (
    <box class="left-module-content clock-module-content" spacing={4} valign={Gtk.Align.CENTER}>
      <WallpaperWidgetButton monitor={monitor} />
      <button
        class="clock-trigger left-module-button"
        valign={Gtk.Align.CENTER}
        onClicked={togglePopup}
        $={(self) => {
          trigger = self
          attachShellTooltip(self, "Calendar")
          self.connect("destroy", () => {
            clearCloseTimeout()
            unregisterPopupController()
            closingPopup = false
            setWindowVisible(false)
          })
        }}
      >
        <box class="clock-trigger-content" spacing={4} valign={Gtk.Align.CENTER}>
          <label class="clock-icon" label={"󰅐"} />
          <label class="clock left-module-label" label={time} />
        </box>
      </button>
    </box>
  )
}
