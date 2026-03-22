import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Mpris from "gi://AstalMpris"

import { With, createBinding, createComputed, createState } from "ags"

import { playerPinned, togglePlayerPinned } from "./PlayerPinState"

const mpris = Mpris.get_default()

type AnyPlayer = any

type PlayerInlineProps = {
  player: AnyPlayer
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
  visibleWhen?: (player: AnyPlayer | null) => boolean
  header?: any
}

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

function truncateText(value: string, limit?: number) {
  if (!limit || limit < 1) return value
  if (value.length <= limit) return value
  if (limit === 1) return "…"
  return `${value.slice(0, limit - 1)}…`
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
  visibleWhen = (player) => Boolean(player),
  header,
}: ActivePlayerWatcherProps) {
  const [activePlayer, setActivePlayer] = createState<AnyPlayer | null>(pickActivePlayer())

  return (
    <box
      class={rootClass}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={0}
      hexpand={fillWidth}
      halign={fillWidth ? Gtk.Align.FILL : Gtk.Align.START}
      visible={activePlayer((player) => visibleWhen(player))}
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
      {header}

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

export function PlayerInline({
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
  const playbackStatus = createBinding(player, "playback-status")

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
  const playPauseGlyph = playbackStatus((status) => isPlayingStatus(status) ? "󰏤" : "󰐊")

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
          tooltipText={meta}
          onClicked={() => invoke(player, ["raise"])}
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

export function PlayerDock({
  rootClass = "notification-player-shell",
  playerClass = "notification-player-inline",
  controlsClass = "section section-center section-player-controls notification-player-controls",
  metaClass = "notification-player-meta",
  buttonWidth = 352,
  showPinButton = false,
}: {
  rootClass?: string
  playerClass?: string
  controlsClass?: string
  metaClass?: string
  buttonWidth?: number
  showPinButton?: boolean
}) {
  const header = showPinButton ? (
    <box class="notification-player-toolbar" spacing={8} valign={Gtk.Align.CENTER}>
      <box hexpand />
      <button
        class="notification-action-button notification-player-pin-button"
        tooltipText={playerPinned((value) => value ? "Hide player from bar" : "Show player in bar")}
        onClicked={() => togglePlayerPinned()}
      >
        <label label={playerPinned((value) => value ? "Unpin" : "Pin")} />
      </button>
    </box>
  ) : undefined

  return (
    <ActivePlayerWatcher
      rootClass={rootClass}
      playerClass={playerClass}
      controlsClass={controlsClass}
      metaClass={metaClass}
      buttonWidth={buttonWidth}
      layout="vertical"
      centerText
      showMainIcon={false}
      textCharLimit={63}
      fillWidth
      header={header}
    />
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
