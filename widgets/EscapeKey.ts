import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"

export function attachEscapeKey(widget: Gtk.Widget, onEscape: () => void) {
  const controller = new Gtk.EventControllerKey()
  controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  controller.connect("key-pressed", (_controller, keyval) => {
    if (keyval !== Gdk.KEY_Escape) return false
    onEscape()
    return true
  })
  widget.add_controller(controller)
  return controller
}
