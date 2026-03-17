import { Clock } from "./Clock"
import { MetricsMenu } from "./Metrics"

export function LeftModules({ monitor }: { monitor: number }) {
  return (
    <box class="left-side-wrap" spacing={0}>
      <box class="section section-center section-player-meta left-module-shell" spacing={0}>
        <Clock monitor={monitor} />
      </box>

      <box class="section section-center section-player-meta left-module-shell" spacing={0}>
        <MetricsMenu monitor={monitor} />
      </box>
    </box>
  )
}
