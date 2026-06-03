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
const CALENDAR_POPOVER_WIDTH = 296
const CALENDAR_POPOVER_OFFSET_X = -20
const CALENDAR_POPOVER_OFFSET_Y = 13
const CALENDAR_PAGE_TRANSITION_MS = 185

const CALENDAR_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const CALENDAR_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function addClasses(widget: Gtk.Widget, classes: string) {
  for (const klass of classes.split(/\s+/)) {
    if (klass) widget.add_css_class(klass)
  }
}

function clearBox(box: Gtk.Box) {
  let child = box.get_first_child()
  while (child) {
    const next = child.get_next_sibling()
    box.remove(child)
    child = next
  }
}

function clampDay(year: number, month: number, day: number) {
  return Math.min(day, new Date(year, month + 1, 0).getDate())
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function createCalendarNavButton(label: string, tooltip: string, onClick: () => void) {
  const button = new Gtk.Button({
    child: new Gtk.Label({ label, xalign: 0.5 }),
    valign: Gtk.Align.CENTER,
  })
  addClasses(button, "flat calendar-nav-button")
  attachShellTooltip(button, tooltip)
  button.connect("clicked", onClick)
  return button
}

function createCalendarDayCell(
  date: Date,
  visibleMonth: number,
  today: Date,
  selected: Date,
  onSelect: (date: Date) => void,
) {
  const label = new Gtk.Label({
    label: `${date.getDate()}`,
    xalign: 0.5,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })
  addClasses(label, "calendar-day-label")

  if (date.getMonth() !== visibleMonth) addClasses(label, "other-month")
  if (sameDay(date, today)) addClasses(label, "today")
  if (sameDay(date, selected)) addClasses(label, "selected")

  const button = new Gtk.Button({
    child: label,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })
  addClasses(button, "flat calendar-day-button")
  button.connect("clicked", () => onSelect(date))
  return button
}

function renderCalendarMonthGrid(
  container: Gtk.Box,
  year: number,
  month: number,
  selected: Date,
  onSelect: (date: Date) => void,
) {
  clearBox(container)

  const today = new Date()

  const header = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 2,
    halign: Gtk.Align.CENTER,
  })
  addClasses(header, "calendar-grid-row calendar-day-name-row")

  for (const dayName of CALENDAR_DAY_NAMES) {
    const label = new Gtk.Label({ label: dayName, xalign: 0.5 })
    addClasses(label, "calendar-day-name")
    header.append(label)
  }

  container.append(header)

  const firstWeekday = new Date(year, month, 1).getDay()

  for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
    const row = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 2,
      halign: Gtk.Align.CENTER,
    })
    addClasses(row, "calendar-grid-row")

    const rowStartOffset = 1 - firstWeekday + rowIndex * 7

    for (let column = 0; column < 7; column++) {
      const date = new Date(year, month, rowStartOffset + column)
      row.append(createCalendarDayCell(date, month, today, selected, onSelect))
    }

    container.append(row)
  }
}

function createCalendarMonthView() {
  const root = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 5,
  })
  root.set_overflow(Gtk.Overflow.HIDDEN)
  addClasses(root, "calendar-widget custom-calendar-widget")

  const initial = new Date()
  let visibleYear = initial.getFullYear()
  let visibleMonth = initial.getMonth()
  let selected = new Date(visibleYear, visibleMonth, initial.getDate())
  let activePage = 0

  const monthLabel = new Gtk.Label({
    label: CALENDAR_MONTH_NAMES[visibleMonth],
    xalign: 0.5,
    hexpand: true,
  })
  addClasses(monthLabel, "calendar-heading-label calendar-month-label")

  const yearLabel = new Gtk.Label({
    label: `${visibleYear}`,
    xalign: 0.5,
  })
  addClasses(yearLabel, "calendar-heading-label calendar-year-label")

  const pages = [0, 1].map(() => {
    const page = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 0,
    })
    addClasses(page, "calendar-month-page")
    return page
  })

  const stack = new Gtk.Stack({
    transitionDuration: CALENDAR_PAGE_TRANSITION_MS,
    transitionType: Gtk.StackTransitionType.CROSSFADE,
  })
  stack.set_overflow(Gtk.Overflow.HIDDEN)
  addClasses(stack, "calendar-month-stack")
  stack.add_named(pages[0], "page-a")
  stack.add_named(pages[1], "page-b")
  stack.set_visible_child(pages[0])

  const updateHeading = () => {
    monthLabel.set_label(CALENDAR_MONTH_NAMES[visibleMonth])
    yearLabel.set_label(`${visibleYear}`)
  }

  const showMonth = (direction: number) => {
    updateHeading()

    const targetPage = 1 - activePage
    renderCalendarMonthGrid(pages[targetPage], visibleYear, visibleMonth, selected, selectDate)

    if (direction > 0) stack.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT)
    else if (direction < 0) stack.set_transition_type(Gtk.StackTransitionType.SLIDE_RIGHT)
    else stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)

    activePage = targetPage
    stack.set_visible_child(pages[activePage])
  }

  const setVisibleDate = (year: number, month: number, direction: number) => {
    visibleYear = year
    visibleMonth = month

    const clampedDay = clampDay(visibleYear, visibleMonth, selected.getDate())
    selected = new Date(visibleYear, visibleMonth, clampedDay)
    showMonth(direction)
  }

  function selectDate(date: Date) {
    const nextDirection = date.getFullYear() > visibleYear
      || (date.getFullYear() === visibleYear && date.getMonth() > visibleMonth)
      ? 1
      : date.getFullYear() < visibleYear
        || (date.getFullYear() === visibleYear && date.getMonth() < visibleMonth)
        ? -1
        : 0

    selected = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    visibleYear = date.getFullYear()
    visibleMonth = date.getMonth()
    showMonth(nextDirection)
  }

  const shiftMonth = (delta: number) => {
    const next = new Date(visibleYear, visibleMonth + delta, 1)
    setVisibleDate(next.getFullYear(), next.getMonth(), delta > 0 ? 1 : -1)
  }

  const shiftYear = (delta: number) => {
    setVisibleDate(visibleYear + delta, visibleMonth, delta > 0 ? 1 : -1)
  }

  const nav = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 2,
    hexpand: true,
    valign: Gtk.Align.CENTER,
  })
  addClasses(nav, "calendar-nav")

  nav.append(createCalendarNavButton("‹", "Previous month", () => shiftMonth(-1)))
  nav.append(monthLabel)
  nav.append(createCalendarNavButton("›", "Next month", () => shiftMonth(1)))
  nav.append(createCalendarNavButton("‹", "Previous year", () => shiftYear(-1)))
  nav.append(yearLabel)
  nav.append(createCalendarNavButton("›", "Next year", () => shiftYear(1)))

  renderCalendarMonthGrid(pages[0], visibleYear, visibleMonth, selected, selectDate)

  root.append(nav)
  root.append(stack)

  return root
}

export function Clock({ monitor }: { monitor: number }) {
  let trigger: Gtk.ToggleButton | null = null
  let popupWindowRef: Gtk.Window | null = null
  let popupRevealer: Gtk.Revealer | null = null
  let popupFrame: Gtk.Box | null = null
  let popupRoot: Gtk.Box | null = null
  let calendarSlot: Gtk.Box | null = null
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
    if (!trigger || trigger.active === open) return
    trigger.active = open
  }

  const syncPopupPosition = () => {
    placeLayerWindowFromTrigger(trigger, popupWindowRef, popupFrame, {
      align: "start",
      offsetX: CALENDAR_POPOVER_OFFSET_X,
      offsetY: CALENDAR_POPOVER_OFFSET_Y,
    })
  }

  const resetCalendarView = () => {
    if (!calendarSlot) return
    clearBox(calendarSlot)
    calendarSlot.append(createCalendarMonthView())
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
      if (closingPopup || !isPopupRevealed()) resetStalePopupState()
      else {
        syncPopupPosition()
        return
      }
    }

    closeOtherPopups(popupRegistryId)
    resetCalendarView()
    clearCloseTimeout()
    closingPopup = false
    setWindowVisible(true)
    setTriggerOpen(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!windowVisible() || closingPopup) return GLib.SOURCE_REMOVE
      syncPopupPosition()
      if (popupRevealer) popupRevealer.revealChild = true
      else resetStalePopupState()
      popupRoot?.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }

  const togglePopup = () => {
    if (closingPopup) return

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
          calendarSlot = null
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
              <box class="calendar-popover" orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                <box class="calendar-header" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                  <label class="calendar-title" xalign={0} label="Calendar" />
                  <label class="calendar-date" xalign={0} label={today} />
                </box>

                <box class="calendar-widget-slot" $={(self) => {
                  calendarSlot = self
                  resetCalendarView()
                }} />
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
      <Gtk.ToggleButton
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
      </Gtk.ToggleButton>
    </box>
  )
}
