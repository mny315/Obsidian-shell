import Gtk from "gi://Gtk?version=4.0"

import { WorkspaceIndicator } from "./WorkspaceIndicator"

export function CenterModules({ monitor }: { monitor: number }) {
  return (
    <box class="center-slot" hexpand halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
      <WorkspaceIndicator monitor={monitor} />
    </box>
  )
}
