export interface DragSelectionBox {
  startX: number
  startY: number
  curX: number
  curY: number
}

export interface DragSelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MatchCardBounds {
  matchId: string
  left: number
  top: number
  right: number
  bottom: number
}

export const DRAG_SELECTION_THRESHOLD_PX = 4
export const DRAG_SELECTION_IGNORED_TAG_NAMES = new Set([
  'a',
  'input',
  'label',
  'option',
  'select',
  'textarea',
])

export function hasDragSelectionMovement(dragBox: DragSelectionBox): boolean {
  return (
    Math.abs(dragBox.curX - dragBox.startX) > DRAG_SELECTION_THRESHOLD_PX ||
    Math.abs(dragBox.curY - dragBox.startY) > DRAG_SELECTION_THRESHOLD_PX
  )
}

export function getDragSelectionRect(dragBox: DragSelectionBox): DragSelectionRect {
  return {
    left: Math.min(dragBox.startX, dragBox.curX),
    top: Math.min(dragBox.startY, dragBox.curY),
    right: Math.max(dragBox.startX, dragBox.curX),
    bottom: Math.max(dragBox.startY, dragBox.curY),
  }
}

export function getOverlappingMatchIds(
  matchCards: MatchCardBounds[],
  selectionRect: DragSelectionRect
): string[] {
  return matchCards
    .filter((card) =>
      card.left < selectionRect.right &&
      card.right > selectionRect.left &&
      card.top < selectionRect.bottom &&
      card.bottom > selectionRect.top
    )
    .map((card) => card.matchId)
}

export function isDragSelectionIgnoredTagName(tagName: string): boolean {
  return DRAG_SELECTION_IGNORED_TAG_NAMES.has(tagName.toLowerCase())
}
