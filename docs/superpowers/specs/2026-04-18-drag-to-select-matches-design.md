# Drag-to-Select Matches — Design Spec

**Date:** 2026-04-18

## Goal

Allow the user to hold Ctrl and click-drag over the match grid to select multiple match cards simultaneously, making bulk deletion faster.

## Behavior

- Hold **Ctrl + left-click drag** anywhere on the match grid to draw a rubber-band selection rectangle.
- All cards whose bounding boxes overlap the selection rectangle are added to `selectedMatches` when the mouse is released.
- Multiple Ctrl+drag operations are **additive** — a second drag adds to the existing selection rather than replacing it.
- **Ctrl+click** on individual cards continues to work as before (toggles a single card).
- The box only renders if the cursor moves more than **4px** from the drag origin, so Ctrl+clicks do not accidentally show a selection box.
- Once cards are selected, the existing delete flow is used: a "Delete selected" button appears in the toolbar → confirmation modal → `deleteMatches` IPC call.

## Implementation — `MatchListPanel.tsx`

### New state

```ts
const [dragBox, setDragBox] = useState<{
  startX: number; startY: number; curX: number; curY: number
} | null>(null)
```

### New prop on `MatchListPanel`

```ts
onAddToSelection: (matchIds: string[]) => void
```

Added to `MatchListPanelProps` and wired in `MatchesScreen` as:

```ts
onAddToSelection={(ids) =>
  setSelectedMatches((prev) => new Set([...prev, ...ids]))
}
```

### Grid wrapper changes

The grid `div` gains `position: relative` and a `onMouseDown` handler:

```ts
onMouseDown={(e) => {
  if (!e.ctrlKey || e.button !== 0) return
  e.preventDefault()
  setDragBox({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
}}
```

### Global mouse listeners (attached while drag is active)

```ts
useEffect(() => {
  if (!dragBox) return

  const onMove = (e: MouseEvent) => {
    setDragBox((prev) => prev ? { ...prev, curX: e.clientX, curY: e.clientY } : null)
  }

  const onUp = () => {
    if (!dragBox) return
    const selRect = {
      left:   Math.min(dragBox.startX, dragBox.curX),
      top:    Math.min(dragBox.startY, dragBox.curY),
      right:  Math.max(dragBox.startX, dragBox.curX),
      bottom: Math.max(dragBox.startY, dragBox.curY),
    }
    const moved = Math.abs(dragBox.curX - dragBox.startX) > 4
                || Math.abs(dragBox.curY - dragBox.startY) > 4
    if (moved) {
      const cards = document.querySelectorAll<HTMLElement>('[data-match-id]')
      const hit: string[] = []
      cards.forEach((el) => {
        const r = el.getBoundingClientRect()
        const overlaps =
          r.left < selRect.right  && r.right  > selRect.left &&
          r.top  < selRect.bottom && r.bottom > selRect.top
        if (overlaps) hit.push(el.dataset.matchId!)
      })
      if (hit.length > 0) onAddToSelection(hit)
    }
    setDragBox(null)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  return () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
}, [dragBox, onAddToSelection])
```

### Card markup

Each card outer `div` gets `data-match-id={match.id}`.

### Selection rectangle overlay

Rendered inside the grid wrapper when `dragBox` is active and moved >4px:

```tsx
{dragBox && (Math.abs(dragBox.curX - dragBox.startX) > 4 || Math.abs(dragBox.curY - dragBox.startY) > 4) && (
  <div
    style={{
      position: 'fixed',
      left:   Math.min(dragBox.startX, dragBox.curX),
      top:    Math.min(dragBox.startY, dragBox.curY),
      width:  Math.abs(dragBox.curX - dragBox.startX),
      height: Math.abs(dragBox.curY - dragBox.startY),
      border: '2px dashed #3b82f6',
      background: 'rgba(59,130,246,0.08)',
      pointerEvents: 'none',
      zIndex: 100,
      borderRadius: 4,
    }}
  />
)}
```

## Files changed

| File | Change |
|------|--------|
| `src/components/MatchListPanel.tsx` | Add `dragBox` state, `onAddToSelection` prop, mouse handlers, `data-match-id` attrs, overlay div |
| `src/components/MatchesScreen.tsx` | Wire `onAddToSelection` prop |

## Out of scope

- Touch / trackpad selection
- Scroll-while-dragging to expand selection beyond the visible viewport
