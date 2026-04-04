import Gtk from "gi://Gtk?version=4.0"

import { createComputed } from "ags"

export function PowerControl({
  onToggle,
  bindRevealer,
  onRun,
}: {
  onToggle: () => void
  bindRevealer: (self: Gtk.Revealer) => void
  onRun: (command: string) => void
}) {
  const triggerTooltip = createComputed(() => "Power menu")

  return (
    <box
      class="quick-control inline-control"
      spacing={6}
      hexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
    >
      <revealer
        class="inline-revealer"
        revealChild={false}
        transitionType={Gtk.RevealerTransitionType.SLIDE_LEFT}
        transitionDuration={300}
        hexpand={false}
        halign={Gtk.Align.START}
        valign={Gtk.Align.CENTER}
        $={bindRevealer}
      >
        <box
          class="inline-panel power-panel"
          spacing={6}
          hexpand={false}
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
        >
          <button
            class="power-action flat"
            tooltipText={"Lock session"}
            onClicked={() => {
              onRun("hyprlock")
            }}
          >
            <box spacing={8}>
              <label class="power-action-icon" label={"󰌾"} />
              <label class="power-action-label" label="Lock" />
            </box>
          </button>

          <button
            class="power-action flat"
            tooltipText={"Reboot system"}
            onClicked={() => {
              onRun("systemctl reboot")
            }}
          >
            <box spacing={8}>
              <label class="power-action-icon" label={"󰜉"} />
              <label class="power-action-label" label="Reboot" />
            </box>
          </button>

          <button
            class="power-action flat"
            tooltipText={"Shut down system"}
            onClicked={() => {
              onRun("systemctl poweroff")
            }}
          >
            <box spacing={8}>
              <label class="power-action-icon" label={"󰐥"} />
              <label class="power-action-label" label="Shut Down" />
            </box>
          </button>
        </box>
      </revealer>

      <button class="icon-button quick-toggle power-toggle flat" valign={Gtk.Align.CENTER} tooltipText={triggerTooltip} onClicked={onToggle}>
        <label class="module-icon" label={"󰐥"} />
      </button>
    </box>
  )
}
