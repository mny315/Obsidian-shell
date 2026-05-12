type PopupController = {
  close: () => void
}

const popupControllers = new Map<string, PopupController>()

export function registerPopupController(id: string, controller: PopupController) {
  popupControllers.set(id, controller)

  return () => {
    const current = popupControllers.get(id)
    if (current === controller) {
      popupControllers.delete(id)
    }
  }
}

export function closeOtherPopups(activeId: string) {
  for (const [id, controller] of popupControllers) {
    if (id === activeId) continue

    try {
      controller.close()
    } catch (error) {
      console.error(error)
    }
  }
}

