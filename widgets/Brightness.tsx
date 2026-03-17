import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"

import { createState } from "ags"
import { execAsync } from "ags/process"

import { BRIGHTNESS_MIN, BRIGHTNESS_STEP, clamp } from "../config"

function parseBrightness(out: string) {
  return clamp(Number.parseFloat(out.trim()) || BRIGHTNESS_MIN, BRIGHTNESS_MIN, 1)
}

export function BrightnessControl({
  onToggle,
  bindRevealer,
}: {
  onToggle: () => void
  bindRevealer: (self: Gtk.Revealer) => void
}) {
  const [current, setCurrent] = createState(BRIGHTNESS_MIN)

  const percent = current((v) => `${Math.round(v * 100)}%`)

  const syncBrightness = async () => {
    try {
      const out = await execAsync([
        "bash",
        "-lc",
        "brightnessctl -m 2>/dev/null | awk -F, '{gsub(/%/, \"\", $4); print $4/100}' || echo 0.05",
      ])
      setCurrent(parseBrightness(out))
    } catch (err) {
      console.error(err)
    }
  }

  const setBrightness = (nextValue: number) => {
    const next = clamp(nextValue, BRIGHTNESS_MIN, 1)
    setCurrent(next)

    void execAsync([
      "bash",
      "-lc",
      `brightnessctl set ${Math.round(next * 100)}%`,
    ]).catch(console.error)
  }

  const adjustBrightness = (delta: number) => {
    setCurrent((prev) => {
      const next = clamp(prev + delta, BRIGHTNESS_MIN, 1)

      void execAsync([
        "bash",
        "-lc",
        `brightnessctl set ${Math.round(next * 100)}%`,
      ]).catch(console.error)

      return next
    })
  }

  return (
    <box
      class="quick-control inline-control"
      spacing={6}
      hexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        void syncBrightness()

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          void syncBrightness()
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
          <label class="module-icon brightness-icon" label={"󰃟"} />
          <slider
            class="slider-control"
            hexpand
            min={BRIGHTNESS_MIN}
            max={1}
            step={0.01}
            value={current}
            onChangeValue={({ value }) => {
              setBrightness(value)
            }}
          />
          <label class="slider-value" label={percent} />
        </box>
      </revealer>

      <button class="icon-button quick-toggle flat" valign={Gtk.Align.CENTER} onClicked={onToggle}>
        <Gtk.EventControllerScroll
          flags={Gtk.EventControllerScrollFlags.VERTICAL}
          onScroll={(_, _dx, dy) => {
            if (dy < 0) adjustBrightness(BRIGHTNESS_STEP)
            else if (dy > 0) adjustBrightness(-BRIGHTNESS_STEP)
            return true
          }}
        />
        <label class="module-icon brightness-icon" label={"󰃟"} />
      </button>
    </box>
  )
}
