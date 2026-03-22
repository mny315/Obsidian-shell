import Gtk from "gi://Gtk?version=4.0"

import { Notifications } from "./Notifications"

export function CenterModules({ monitor }: { monitor: number }) {
  return (
    <box class="center-slot" hexpand halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
      <box class="section section-center center-notification-shell" spacing={0}>
        <Notifications monitor={monitor} />
      </box>
    </box>
  )
}
