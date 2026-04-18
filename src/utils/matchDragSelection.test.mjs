import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DRAG_SELECTION_THRESHOLD_PX,
  getDragSelectionRect,
  getOverlappingMatchIds,
  hasDragSelectionMovement,
  isDragSelectionIgnoredTagName,
} from './matchDragSelection.ts'

test('hasDragSelectionMovement only starts selection after movement exceeds threshold', () => {
  assert.equal(
    hasDragSelectionMovement({
      startX: 100,
      startY: 100,
      curX: 103,
      curY: 104,
    }),
    false
  )

  assert.equal(
    hasDragSelectionMovement({
      startX: 100,
      startY: 100,
      curX: 106,
      curY: 100,
    }),
    true
  )

  assert.equal(DRAG_SELECTION_THRESHOLD_PX, 4)
})

test('getDragSelectionRect normalizes reverse drags into a selection rectangle', () => {
  assert.deepEqual(
    getDragSelectionRect({
      startX: 400,
      startY: 320,
      curX: 250,
      curY: 120,
    }),
    {
      left: 250,
      top: 120,
      right: 400,
      bottom: 320,
    }
  )
})

test('getOverlappingMatchIds returns every card touched by the drag rectangle', () => {
  const selectionRect = {
    left: 120,
    top: 100,
    right: 320,
    bottom: 280,
  }

  assert.deepEqual(
    getOverlappingMatchIds(
      [
        { matchId: 'left-card', left: 80, top: 120, right: 180, bottom: 220 },
        { matchId: 'middle-card', left: 200, top: 100, right: 300, bottom: 200 },
        { matchId: 'outside-card', left: 340, top: 120, right: 440, bottom: 220 },
      ],
      selectionRect
    ),
    ['left-card', 'middle-card']
  )
})

test('isDragSelectionIgnoredTagName keeps cards draggable while excluding form controls', () => {
  assert.equal(isDragSelectionIgnoredTagName('button'), false)
  assert.equal(isDragSelectionIgnoredTagName('div'), false)
  assert.equal(isDragSelectionIgnoredTagName('input'), true)
  assert.equal(isDragSelectionIgnoredTagName('textarea'), true)
})
