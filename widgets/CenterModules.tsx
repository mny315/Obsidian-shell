import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Mpris from "gi://AstalMpris"
import { With, createBinding, createComputed, createState } from "ags"


const mpris = Mpris.get_default()

type AnyPlayer = any

function playerList(): AnyPlayer[] {
  try {
    if (typeof mpris.get_players === "function") {
      const players = mpris.get_players()
      if (Array.isArray(players)) return players
    }
  } catch {}

  try {
    if (Array.isArray((mpris as any).players)) return (mpris as any).players
  } catch {}

  return []
}

function readStatus(player: AnyPlayer): unknown {
  try {
    if (typeof player.get_playback_status === "function") return player.get_playback_status()
  } catch {}

  try {
    return player.playbackStatus ?? player.playback_status ?? player["playback-status"]
  } catch {}

  return null
}

function normalizeStatus(status: unknown) {
  if (status === 0) return "playing"
  if (status === 1) return "paused"
  if (status === 2) return "stopped"
  return `${status ?? ""}`.toLowerCase()
}

function isPlayingStatus(status: unknown) {
  return normalizeStatus(status).includes("playing")
}

function playerRank(player: AnyPlayer) {
  const status = normalizeStatus(readStatus(player))
  if (status.includes("playing")) return 3
  if (status.includes("paused")) return 2
  return 1
}

function pickActivePlayer() {
  const players = playerList()
  let bestPlayer: AnyPlayer | null = null
  let bestRank = -1

  for (const player of players) {
    try {
      const available = player.available ?? player.get_available?.() ?? true
      if (!available) continue

      const rank = playerRank(player)
      if (rank > bestRank) {
        bestPlayer = player
        bestRank = rank
      }
    } catch {}
  }

  return bestPlayer
}

function invoke(player: AnyPlayer, methods: string[]) {
  for (const method of methods) {
    try {
      if (typeof player?.[method] === "function") {
        player[method]()
        return
      }
    } catch (error) {
      console.error(error)
      return
    }
  }
}

function PlayerCompact({ player }: { player: AnyPlayer }) {
  const title = createBinding(player, "title")
  const artist = createBinding(player, "artist")
  const identity = createBinding(player, "identity")
  const canGoPrevious = createBinding(player, "can-go-previous")
  const canGoNext = createBinding(player, "can-go-next")
  const canControl = createBinding(player, "can-control")
  const playbackStatus = createBinding(player, "playback-status")

  const meta = createComputed(() => {
    const titleText = `${title() ?? ""}`.trim()
    const artistText = `${artist() ?? ""}`.trim()
    const identityText = `${identity() ?? ""}`.trim()

    if (titleText && artistText) return `${artistText} — ${titleText}`
    if (titleText) return titleText
    if (artistText) return artistText
    if (identityText) return identityText
    return "Now playing"
  })

  const playPauseGlyph = playbackStatus((status) => isPlayingStatus(status) ? "󰏤" : "󰐊")

  return (
    <box
      class="center-player-wrap"
      spacing={6}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
    >
      <box
        class="section section-center section-player-meta"
        spacing={0}
        hexpand={true}
        halign={Gtk.Align.FILL}
      >
        <button
          class="flat player-main-button"
          hexpand={true}
          halign={Gtk.Align.FILL}
          tooltipText={meta}
          onClicked={() => invoke(player, ["raise"])}
        >
          <box class="player-main-content" spacing={8} valign={Gtk.Align.CENTER}>
            <label class="player-main-icon" label={"󰎇"} />
            <label
              class="player-main-label"
              label={meta}
              ellipsize={Pango.EllipsizeMode.END}
              widthChars={25}
              maxWidthChars={25}
              xalign={0}
            />
          </box>
        </button>
      </box>

      <box class="section section-center section-player-controls" spacing={2}>
        <button
          class="flat player-transport-button"
          sensitive={canGoPrevious((value) => Boolean(value))}
          onClicked={() => invoke(player, ["previous"])}
        >
          <label class="player-transport-icon" label={"󰒮"} />
        </button>

        <button
          class="flat player-transport-button player-transport-primary"
          sensitive={canControl((value) => Boolean(value))}
          onClicked={() => invoke(player, ["play_pause"])}
        >
          <label class="player-transport-icon" label={playPauseGlyph} />
        </button>

        <button
          class="flat player-transport-button"
          sensitive={canGoNext((value) => Boolean(value))}
          onClicked={() => invoke(player, ["next"])}
        >
          <label class="player-transport-icon" label={"󰒭"} />
        </button>
      </box>
    </box>
  )
}

export function CenterModules() {
  const [activePlayer, setActivePlayer] = createState<AnyPlayer | null>(pickActivePlayer())

  return (
    <box
      class="center-slot"
      hexpand
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        const managerSignalIds: Array<number> = []
        const playerSignalIds: Array<[AnyPlayer, number]> = []

        const disconnectPlayers = () => {
          for (const [player, id] of playerSignalIds.splice(0)) {
            try {
              player.disconnect(id)
            } catch {}
          }
        }

        const sync = () => {
          setActivePlayer(pickActivePlayer())
        }

        const watchPlayers = () => {
          disconnectPlayers()

          for (const player of playerList()) {
            for (const signal of [
              "notify::playback-status",
              "notify::available",
              "notify::title",
              "notify::artist",
              "notify::can-go-next",
              "notify::can-go-previous",
              "notify::can-control",
            ]) {
              try {
                playerSignalIds.push([player, player.connect(signal, sync)])
              } catch {}
            }
          }

          sync()
        }

        for (const signal of ["notify::players", "player-added", "player-closed", "items-changed"]) {
          try {
            managerSignalIds.push(mpris.connect(signal, watchPlayers))
          } catch {}
        }

        watchPlayers()

        self.connect("destroy", () => {
          disconnectPlayers()
          for (const id of managerSignalIds) {
            try {
              mpris.disconnect(id)
            } catch {}
          }
        })
      }}
    >
      <With value={activePlayer}>
        {(player) => player && <PlayerCompact player={player} />}
      </With>
    </box>
  )
}
