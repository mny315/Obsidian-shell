import Gtk from "gi://Gtk?version=4.0"
import { Astal } from "ags/gtk4"

import { attachEscapeKey } from "./EscapeKey"
import { debugPopupLog } from "./DebugPopupLog"
import { FLOATING_POPUP_ANCHOR, isPointInsideWidget } from "./FloatingPopup"

type PopupCloseGesture = "pressed" | "released"

type FloatingPopupWindowProps = {
  visible: boolean
  monitor: number
  windowClass: string
  placementClass?: string
  frameClass: string
  widthRequest?: number
  halign?: Gtk.Align
  valign?: Gtk.Align
  revealChild?: boolean
  transitionType: Gtk.RevealerTransitionType
  transitionDuration: number
  namespace?: string
  closeGesture?: PopupCloseGesture
  captureCloseGesture?: boolean
  onClose: () => void
  onWindowDestroy?: () => void
  onRoot?: (root: Gtk.Box | null) => void
  onPlacement?: (placement: Gtk.Box | null) => void
  onRevealer?: (revealer: Gtk.Revealer | null) => void
  onFrame?: (frame: Gtk.Box | null) => void
  children: any
}

export function FloatingPopupWindow({
  visible,
  monitor,
  windowClass,
  placementClass = "widget-popup-placement",
  frameClass,
  widthRequest,
  halign = Gtk.Align.END,
  valign = Gtk.Align.START,
  revealChild = false,
  transitionType,
  transitionDuration,
  namespace = "obsidian-shell",
  closeGesture = "pressed",
  captureCloseGesture = false,
  onClose,
  onWindowDestroy,
  onRoot,
  onPlacement,
  onRevealer,
  onFrame,
  children,
}: FloatingPopupWindowProps) {
  let placement: Gtk.Box | null = null
  let frame: Gtk.Box | null = null

  const closeIfOutside = (_gesture: Gtk.GestureClick, _nPress: number, x: number, y: number) => {
    const root = placement?.get_parent?.() as Gtk.Widget | null
    const inside = isPointInsideWidget(frame, root, x, y)
    // DEBUG_POPUP_LOG: outside-click diagnostics only; remove after bug is found.
    debugPopupLog(namespace, "outside-click", { x, y, inside, closeGesture, captureCloseGesture })
    if (inside) return
    onClose()
  }

  const gestureProps = closeGesture === "released"
    ? { onReleased: closeIfOutside }
    : { onPressed: closeIfOutside }

  return (
    <window
      visible={visible}
      monitor={monitor}
      namespace={namespace}
      class={windowClass}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={FLOATING_POPUP_ANCHOR}
      $={(self) => {
        self.connect("destroy", () => {
          debugPopupLog(namespace, "window destroy")
          placement = null
          frame = null
          onWindowDestroy?.()
          onPlacement?.(null)
          onRevealer?.(null)
          onFrame?.(null)
          onRoot?.(null)
        })
      }}
    >
      <box class="widget-popup-root" hexpand vexpand $={(self) => {
        self.set_focusable(true)
        attachEscapeKey(self, onClose)
        onRoot?.(self)
        debugPopupLog(namespace, "root ready")
      }}>
        <Gtk.GestureClick
          button={0}
          propagationPhase={captureCloseGesture ? Gtk.PropagationPhase.CAPTURE : Gtk.PropagationPhase.NONE}
          {...gestureProps}
        />

        <box
          class={placementClass}
          halign={halign}
          valign={valign}
          $={(self) => {
            placement = self
            onPlacement?.(self)
            debugPopupLog(namespace, "placement ready")
          }}
        >
          <revealer
            class="widget-popup-revealer"
            revealChild={revealChild}
            transitionType={transitionType}
            transitionDuration={transitionDuration}
            $={(self) => {
              onRevealer?.(self)
              debugPopupLog(namespace, "revealer ready", { revealed: self.get_reveal_child() })
            }}
          >
            <box class={frameClass} widthRequest={widthRequest} $={(self) => {
              frame = self
              onFrame?.(self)
              debugPopupLog(namespace, "frame ready")
            }}>
              {children}
            </box>
          </revealer>
        </box>
      </box>
    </window>
  )
}
