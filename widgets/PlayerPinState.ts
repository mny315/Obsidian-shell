import { createState } from "ags"

const [playerPinned, setPlayerPinned] = createState(false)

export { playerPinned, setPlayerPinned }

export function togglePlayerPinned() {
  setPlayerPinned((value) => !value)
}
