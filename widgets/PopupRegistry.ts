import { debugPopupLog } from "./DebugPopupLog"

// DEBUG_POPUP_LOG: temporary imports/calls in this file are diagnostic only.

type PopupController = {
  close: () => void
}

const popupControllers = new Map<string, PopupController>()

export function registerPopupController(id: string, controller: PopupController) {
  popupControllers.set(id, controller)
  debugPopupLog("registry", "register", { id, ids: [...popupControllers.keys()] })

  return () => {
    const current = popupControllers.get(id)
    if (current === controller) {
      popupControllers.delete(id)
      debugPopupLog("registry", "unregister", { id, ids: [...popupControllers.keys()] })
    }
  }
}

export function closeOtherPopups(activeId: string) {
  debugPopupLog("registry", "closeOtherPopups", { activeId, ids: [...popupControllers.keys()] })
  for (const [id, controller] of popupControllers) {
    if (id === activeId) continue

    try {
      controller.close()
    } catch (error) {
      console.error(error)
    }
  }
}

export function closeAllPopups() {
  debugPopupLog("registry", "closeAllPopups", { ids: [...popupControllers.keys()] })
  for (const controller of popupControllers.values()) {
    try {
      controller.close()
    } catch (error) {
      console.error(error)
    }
  }
}
