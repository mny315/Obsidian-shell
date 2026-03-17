import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createState } from "ags"
import { execAsync } from "ags/process"

import { VOLUME_STEP, clamp } from "../config"

function pickIcon(volume: number, muted: boolean) {
  if (muted) return "󰖁"
  if (volume <= 0.01) return "󰝟"
  if (volume < 0.5) return "󰕿"
  return "󰕾"
}

function parseVolume(out: string) {
  const muted = out.includes("MUTED")
  const volume = clamp(Number.parseFloat(out.trim().split(/\s+/)[1] ?? "0") || 0)
  return { volume, muted, icon: pickIcon(volume, muted) }
}

export function AudioControl({
  onToggle,
  bindRevealer,
}: {
  onToggle: () => void
  bindRevealer: (self: Gtk.Revealer) => void
}) {
  const [current, setCurrent] = createState(0)
  const [muted, setMuted] = createState(false)
  const [icon, setIcon] = createState("󰕾")

  const percent = current((v) => `${Math.round(v * 100)}%`)

  const syncVolume = async () => {
    try {
      const out = await execAsync([
        "bash",
        "-lc",
        "wpctl get-volume @DEFAULT_AUDIO_SINK@ || echo 'Volume: 0'",
      ])

      const parsed = parseVolume(out)
      setCurrent(parsed.volume)
      setMuted(parsed.muted)
      setIcon(parsed.icon)
    } catch (err) {
      console.error(err)
    }
  }

  const setVolume = (nextValue: number) => {
    const next = clamp(nextValue)

    setCurrent(next)
    setMuted(false)
    setIcon(pickIcon(next, false))

    void execAsync([
      "bash",
      "-lc",
      `wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ ${next.toFixed(2)}`,
    ]).catch(console.error)
  }

  const adjustVolume = (delta: number) => {
    setCurrent((prev) => {
      const next = clamp(prev + delta)

      setMuted(false)
      setIcon(pickIcon(next, false))

      void execAsync([
        "bash",
        "-lc",
        `wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ ${next.toFixed(2)}`,
      ]).catch(console.error)

      return next
    })
  }

  const toggleMute = () => {
    void execAsync([
      "bash",
      "-lc",
      "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle",
    ])
      .then(() => syncVolume())
      .catch(console.error)
  }

  return (
    <box
      class="quick-control inline-control"
      spacing={6}
      hexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        void syncVolume()

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          void syncVolume()
          return GLib.SOURCE_CONTINUE
        })

        self.connect("destroy", () => {
          if (id) GLib.source_remove(id)
        })
      }}
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
          class="inline-panel slider-panel"
          spacing={8}
          hexpand={false}
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
        >
          <button
            class="icon-button panel-icon-button flat"
            valign={Gtk.Align.CENTER}
            onClicked={toggleMute}
          >
            <label class="module-icon" label={icon} />
          </button>

          <slider
            class="slider-control"
            hexpand
            min={0}
            max={1}
            step={0.01}
            value={current}
            onChangeValue={({ value }) => {
              setVolume(value)
            }}
          />

          <label class="slider-value" label={percent} />
        </box>
      </revealer>

      <button class="icon-button quick-toggle flat" valign={Gtk.Align.CENTER} onClicked={onToggle}>
        <Gtk.EventControllerScroll
          flags={Gtk.EventControllerScrollFlags.VERTICAL}
          onScroll={(_, _dx, dy) => {
            if (dy < 0) adjustVolume(VOLUME_STEP)
            else if (dy > 0) adjustVolume(-VOLUME_STEP)
            return true
          }}
        />
        <label class="module-icon" label={icon} />
      </button>
    </box>
  )
}
