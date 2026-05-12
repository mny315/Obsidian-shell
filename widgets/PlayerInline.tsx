import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Mpris from "gi://AstalMpris"

import { With, createBinding, createComputed, createState } from "ags"
import { attachShellTooltip } from "./ShellTooltip"

const mpris = Mpris.get_default()

type Player = any

type PlayerInlineProps = {
  player: Player
  rootClass?: string
  controlsClass?: string
  metaClass?: string
  buttonWidth?: number
  layout?: "horizontal" | "vertical"
  centerText?: boolean
  showMainIcon?: boolean
  textCharLimit?: number
  fillWidth?: boolean
}

type ActivePlayerWatcherProps = {
  rootClass: string
  playerClass: string
  controlsClass: string
  metaClass: string
  buttonWidth?: number
  layout: "horizontal" | "vertical"
  centerText: boolean
  showMainIcon: boolean
  textCharLimit?: number
  fillWidth: boolean
}

type PlayerAction = "previous" | "play_pause" | "next" | "raise"

function players() {
  try {
    const list = mpris.get_players()
    return Array.isArray(list) ? list.filter(Boolean) : []
  } catch (error) {
    console.error(error)
    return []
  }
}

function playbackStatus(player: Player) {
  try {
    return player.get_playback_status()
  } catch {
    return null
  }
}

function isPlayingStatus(status: unknown) {
  return status === Mpris.PlaybackStatus.PLAYING || `${status ?? ""}`.toLowerCase() === "playing"
}

function isPausedStatus(status: unknown) {
  return status === Mpris.PlaybackStatus.PAUSED || `${status ?? ""}`.toLowerCase() === "paused"
}

function isAvailable(player: Player) {
  try {
    return Boolean(player.get_available())
  } catch {
    return false
  }
}

function busName(player: Player) {
  try {
    return `${player.get_bus_name() ?? ""}`
  } catch {
    return ""
  }
}

function samePlayer(left: Player | null, right: Player | null) {
  if (!left || !right) return false
  if (left === right) return true

  const leftBusName = busName(left)
  const rightBusName = busName(right)
  return Boolean(leftBusName && rightBusName && leftBusName === rightBusName)
}

function currentVersionOf(player: Player | null, list: Player[]) {
  if (!player) return null
  return list.find((candidate) => samePlayer(candidate, player)) ?? null
}

function pickActivePlayer(previousPlayer: Player | null = null) {
  const list = players().filter(isAvailable)
  const previous = currentVersionOf(previousPlayer, list)

  if (previous && isPlayingStatus(playbackStatus(previous))) return previous

  const playing = list.find((player) => isPlayingStatus(playbackStatus(player)))
  if (playing) return playing

  if (previous && isPausedStatus(playbackStatus(previous))) return previous

  return list.find((player) => isPausedStatus(playbackStatus(player))) ?? null
}

function truncateText(value: string, limit?: number) {
  if (!limit || limit < 1) return value
  if (value.length <= limit) return value
  if (limit === 1) return "…"
  return `${value.slice(0, limit - 1)}…`
}

function callPlayer(player: Player, action: PlayerAction) {
  try {
    player[action]()
  } catch (error) {
    console.error(error)
  }
}

function connectSignal(object: Player, signal: string, callback: () => void) {
  try {
    return object.connect(signal, callback)
  } catch {
    return 0
  }
}

function disconnectSignal(object: Player, id: number) {
  if (!id) return

  try {
    object.disconnect(id)
  } catch {}
}

function ActivePlayerWatcher({
  rootClass,
  playerClass,
  controlsClass,
  metaClass,
  buttonWidth,
  layout,
  centerText,
  showMainIcon,
  textCharLimit,
  fillWidth,
}: ActivePlayerWatcherProps) {
  const initialPlayer = pickActivePlayer()
  const [activePlayer, setActivePlayer] = createState<Player | null>(initialPlayer)

  return (
    <box
      class={rootClass}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={0}
      hexpand={fillWidth}
      halign={fillWidth ? Gtk.Align.FILL : Gtk.Align.START}
      visible={activePlayer((player) => Boolean(player))}
      $={(self) => {
        const managerSignalIds: number[] = []
        const playerSignalIds: Array<[Player, number]> = []
        let lastActivePlayer: Player | null = initialPlayer

        const sync = () => {
          const nextPlayer = pickActivePlayer(lastActivePlayer)
          lastActivePlayer = nextPlayer
          setActivePlayer(nextPlayer)
        }

        const disconnectPlayers = () => {
          for (const [player, id] of playerSignalIds.splice(0)) disconnectSignal(player, id)
        }

        const watchPlayers = () => {
          disconnectPlayers()

          for (const player of players()) {
            for (const signal of [
              "notify::available",
              "notify::playback-status",
              "notify::can-control",
              "notify::can-go-next",
              "notify::can-go-previous",
            ]) {
              const id = connectSignal(player, signal, sync)
              if (id) playerSignalIds.push([player, id])
            }
          }

          sync()
        }

        for (const signal of ["notify::players", "player-added", "player-closed", "items-changed"]) {
          const id = connectSignal(mpris, signal, watchPlayers)
          if (id) managerSignalIds.push(id)
        }

        watchPlayers()

        self.connect("destroy", () => {
          disconnectPlayers()
          for (const id of managerSignalIds) disconnectSignal(mpris, id)
        })
      }}
    >
      <With value={activePlayer}>
        {(player) => (
          player ? (
            <PlayerInline
              player={player}
              rootClass={playerClass}
              controlsClass={controlsClass}
              metaClass={metaClass}
              buttonWidth={buttonWidth}
              layout={layout}
              centerText={centerText}
              showMainIcon={showMainIcon}
              textCharLimit={textCharLimit}
              fillWidth={fillWidth}
            />
          ) : <box />
        )}
      </With>
    </box>
  )
}

function PlayerInline({
  player,
  rootClass = "left-player-inline",
  controlsClass = "section section-center section-player-controls left-player-controls",
  metaClass = "section section-center section-player-meta left-player-meta",
  buttonWidth,
  layout = "horizontal",
  centerText = false,
  showMainIcon = true,
  textCharLimit,
  fillWidth = false,
}: PlayerInlineProps) {
  const title = createBinding(player, "title")
  const artist = createBinding(player, "artist")
  const identity = createBinding(player, "identity")
  const canGoPrevious = createBinding(player, "can-go-previous")
  const canGoNext = createBinding(player, "can-go-next")
  const canControl = createBinding(player, "can-control")
  const playbackStatusBinding = createBinding(player, "playback-status")

  const verticalLayout = layout === "vertical"

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

  const displayMeta = createComputed(() => truncateText(meta(), textCharLimit))
  const playPauseGlyph = playbackStatusBinding((status) => isPlayingStatus(status) ? "󰏤" : "󰐊")

  return (
    <box
      class={rootClass}
      orientation={verticalLayout ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL}
      spacing={verticalLayout ? 8 : 0}
      valign={Gtk.Align.CENTER}
      halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.FILL}
      hexpand={fillWidth}
    >
      <box
        class={controlsClass}
        spacing={0}
        hexpand={fillWidth}
        halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.START}
      >
        <box spacing={2} halign={Gtk.Align.CENTER} hexpand={fillWidth}>
          <button
            class="flat player-transport-button"
            sensitive={canGoPrevious((value) => Boolean(value))}
            onClicked={() => callPlayer(player, "previous")}
          >
            <label class="player-transport-icon" label={"󰒮"} />
          </button>

          <button
            class="flat player-transport-button player-transport-primary"
            sensitive={canControl((value) => Boolean(value))}
            onClicked={() => callPlayer(player, "play_pause")}
          >
            <label class="player-transport-icon" label={playPauseGlyph} />
          </button>

          <button
            class="flat player-transport-button"
            sensitive={canGoNext((value) => Boolean(value))}
            onClicked={() => callPlayer(player, "next")}
          >
            <label class="player-transport-icon" label={"󰒭"} />
          </button>
        </box>
      </box>

      <box
        class={metaClass}
        spacing={0}
        hexpand={fillWidth}
        halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.START}
      >
        <button
          class="flat player-main-button"
          widthRequest={fillWidth ? -1 : (buttonWidth ?? -1)}
          hexpand={fillWidth}
          halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.START}
          onClicked={() => callPlayer(player, "raise")}
          $={(self) => attachShellTooltip(self, meta)}
        >
          <box
            class={centerText ? "player-main-content player-main-content-centered" : "player-main-content"}
            spacing={showMainIcon ? 8 : 0}
            valign={Gtk.Align.CENTER}
            halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.FILL}
            hexpand={fillWidth}
          >
            <label class="player-main-icon" label={"󰎇"} visible={showMainIcon} />
            <label
              class={centerText ? "player-main-label player-main-label-centered" : "player-main-label"}
              label={displayMeta}
              ellipsize={Pango.EllipsizeMode.END}
              xalign={centerText ? 0.5 : 0}
              hexpand={fillWidth}
              halign={fillWidth ? Gtk.Align.FILL : centerText ? Gtk.Align.CENTER : Gtk.Align.START}
            />
          </box>
        </button>
      </box>
    </box>
  )
}

export function PinnedPlayerBar() {
  return (
    <ActivePlayerWatcher
      rootClass="section section-center pinned-player-shell"
      playerClass="pinned-player-inline"
      controlsClass="pinned-player-controls"
      metaClass="pinned-player-meta"
      buttonWidth={undefined}
      layout="horizontal"
      centerText={false}
      showMainIcon={false}
      textCharLimit={80}
      fillWidth={false}
    />
  )
}
