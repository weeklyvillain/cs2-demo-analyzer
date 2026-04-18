# Drag-to-Select Matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users hold Ctrl and drag over the match grid to rubber-band-select multiple cards for bulk deletion.

**Architecture:** All drag logic lives in `MatchListPanel.tsx` — new `dragBox` state tracks the in-progress rectangle, global `mousemove`/`mouseup` listeners compute card intersections on release, and a new `onAddToSelection` prop propagates the hit IDs up to `MatchesScreen`. The overlay rectangle is a `position:fixed` div rendered at client coordinates, so it works regardless of scroll position.

**Tech Stack:** React 18, TypeScript, Tailwind CSS (existing stack — no new deps)

---

### Task 1: Add `onAddToSelection` prop to `MatchListPanel`

**Files:**
- Modify: `src/components/MatchListPanel.tsx`
- Modify: `src/components/MatchesScreen.tsx`

- [ ] **Step 1: Add prop to the interface in `MatchListPanel.tsx`**

In `src/components/MatchListPanel.tsx`, add `onAddToSelection` to `MatchListPanelProps` (after `onToggleMatchSelection` around line 147):

```ts
onAddToSelection: (matchIds: string[]) => void
```

- [ ] **Step 2: Destructure the prop in the component function**

In the destructured parameter list of `MatchListPanel` (around line 170), add:

```ts
onAddToSelection,
```

- [ ] **Step 3: Wire up `onAddToSelection` in `MatchesScreen.tsx`**

In `src/components/MatchesScreen.tsx`, find the `<MatchListPanel` JSX block (around line 676). Add the new prop:

```tsx
onAddToSelection={(ids) =>
  setSelectedMatches((prev) => new Set([...prev, ...ids]))
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build:vite 2>&1 | tail -20
```

Expected: no type errors. Fix any before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/components/MatchListPanel.tsx src/components/MatchesScreen.tsx
git commit -m "feat: add onAddToSelection prop to MatchListPanel"
```

---

### Task 2: Add `data-match-id` attribute to each card

**Files:**
- Modify: `src/components/MatchListPanel.tsx`

- [ ] **Step 1: Find the card outer `div`**

In `src/components/MatchListPanel.tsx`, around line 356, find:

```tsx
<div
  key={match.id}
  onContextMenu={(e) => handleContextMenu(e, match)}
  className={`bg-secondary rounded-lg border-2 overflow-hidden ...`}
>
```

- [ ] **Step 2: Add the `data-match-id` attribute**

```tsx
<div
  key={match.id}
  data-match-id={match.id}
  onContextMenu={(e) => handleContextMenu(e, match)}
  className={`bg-secondary rounded-lg border-2 overflow-hidden transition-all hover:shadow-xl group flex flex-col relative box-border ${
    isSelected
      ? 'border-accent'
      : 'border-transparent hover:border-accent/50'
  }`}
>
```

- [ ] **Step 3: Verify in dev tools**

Start dev server (`npm run dev`) and open DevTools → Elements. Confirm each match card `div` has `data-match-id="<matchId>"`.

- [ ] **Step 4: Commit**

```bash
git add src/components/MatchListPanel.tsx
git commit -m "feat: add data-match-id attribute to match cards"
```

---

### Task 3: Add drag-box state and global mouse listeners

**Files:**
- Modify: `src/components/MatchListPanel.tsx`

- [ ] **Step 1: Add the `dragBox` state**

At the top of the `MatchListPanel` function body, after the existing `const [contextMenu, ...]` state (around line 175), add:

```ts
const [dragBox, setDragBox] = useState<{
  startX: number
  startY: number
  curX: number
  curY: number
} | null>(null)
```

- [ ] **Step 2: Add the `useEffect` for global mouse listeners**

After the existing `useEffect` that closes the context menu on outside click (around line 197), add:

```ts
useEffect(() => {
  if (!dragBox) return

  const onMove = (e: MouseEvent) => {
    setDragBox((prev) =>
      prev ? { ...prev, curX: e.clientX, curY: e.clientY } : null
    )
  }

  const onUp = () => {
    setDragBox((prev) => {
      if (!prev) return null
      const moved =
        Math.abs(prev.curX - prev.startX) > 4 ||
        Math.abs(prev.curY - prev.startY) > 4
      if (moved) {
        const selRect = {
          left:   Math.min(prev.startX, prev.curX),
          top:    Math.min(prev.startY, prev.curY),
          right:  Math.max(prev.startX, prev.curX),
          bottom: Math.max(prev.startY, prev.curY),
        }
        const cards = document.querySelectorAll<HTMLElement>('[data-match-id]')
        const hit: string[] = []
        cards.forEach((el) => {
          const r = el.getBoundingClientRect()
          const overlaps =
            r.left < selRect.right &&
            r.right > selRect.left &&
            r.top < selRect.bottom &&
            r.bottom > selRect.top
          if (overlaps) hit.push(el.dataset.matchId!)
        })
        if (hit.length > 0) onAddToSelection(hit)
      }
      return null
    })
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  return () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
}, [dragBox, onAddToSelection])
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build:vite 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/MatchListPanel.tsx
git commit -m "feat: add drag-box state and mouse listener effect"
```

---

### Task 4: Wire `onMouseDown` to the grid wrapper

**Files:**
- Modify: `src/components/MatchListPanel.tsx`

- [ ] **Step 1: Find the grid wrapper `div`**

Around line 350 in `src/components/MatchListPanel.tsx`:

```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4">
```

- [ ] **Step 2: Add `onMouseDown` and `position: relative`**

Replace that opening tag with:

```tsx
<div
  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4 relative"
  onMouseDown={(e) => {
    if (!e.ctrlKey || e.button !== 0) return
    e.preventDefault()
    setDragBox({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
  }}
>
```

- [ ] **Step 3: Manual smoke-test**

Run `npm run dev`. Hold Ctrl and click-drag over the grid. Open DevTools Console — no errors should appear. Selection state won't be visible yet (overlay comes in Task 5), but `onAddToSelection` should fire on mouse-up. Add a temporary `console.log` inside `onAddToSelection` in `MatchesScreen.tsx` to confirm IDs are logged:

```ts
onAddToSelection={(ids) => {
  console.log('drag selected:', ids)
  setSelectedMatches((prev) => new Set([...prev, ...ids]))
}}
```

Drag over a few cards, release — confirm IDs appear in console.

- [ ] **Step 4: Remove the temporary console.log from `MatchesScreen.tsx`**

Revert the `onAddToSelection` callback to:

```ts
onAddToSelection={(ids) =>
  setSelectedMatches((prev) => new Set([...prev, ...ids]))
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/MatchListPanel.tsx src/components/MatchesScreen.tsx
git commit -m "feat: trigger drag-select on Ctrl+mousedown over match grid"
```

---

### Task 5: Render the rubber-band selection overlay

**Files:**
- Modify: `src/components/MatchListPanel.tsx`

- [ ] **Step 1: Find the return JSX in `MatchListPanel`**

The component returns `<>...</>`. The selection overlay should be the last element inside the fragment, after the context menu and delete modal.

- [ ] **Step 2: Add the overlay**

At the very end of the returned fragment, before the closing `</>`, add:

```tsx
{/* Rubber-band drag-select overlay */}
{dragBox &&
  (Math.abs(dragBox.curX - dragBox.startX) > 4 ||
    Math.abs(dragBox.curY - dragBox.startY) > 4) && (
  <div
    style={{
      position: 'fixed',
      left:     Math.min(dragBox.startX, dragBox.curX),
      top:      Math.min(dragBox.startY, dragBox.curY),
      width:    Math.abs(dragBox.curX - dragBox.startX),
      height:   Math.abs(dragBox.curY - dragBox.startY),
      border:   '2px dashed #3b82f6',
      background: 'rgba(59,130,246,0.08)',
      pointerEvents: 'none',
      zIndex:   100,
      borderRadius: 4,
    }}
  />
)}
```

- [ ] **Step 3: Manual test — overlay renders correctly**

Run `npm run dev`. Hold Ctrl and drag over the grid. Confirm:
- Blue dashed rectangle follows the cursor
- Rectangle does not appear on plain Ctrl+click (no drag movement)
- Rectangle disappears on mouse-up
- Cards the rectangle covers become selected (blue border + checkmark)

- [ ] **Step 4: Manual test — additive selection**

1. Ctrl+drag to select a group of cards in the top row → release
2. Ctrl+drag to select a second group in the bottom row → release
3. Confirm both groups remain selected (second drag adds, not replaces)
4. Click "Delete selected" button → confirm correct count in modal

- [ ] **Step 5: Manual test — Ctrl+click still works**

Ctrl+click an individual card — confirm it toggles without showing the drag overlay.

- [ ] **Step 6: Commit**

```bash
git add src/components/MatchListPanel.tsx
git commit -m "feat: render rubber-band selection overlay during Ctrl+drag"
```

---

## Self-Review

**Spec coverage:**
- ✅ Ctrl+drag draws rubber-band box → Tasks 3, 4, 5
- ✅ Overlapping cards selected on release → Task 3 (`onUp` handler)
- ✅ Additive (multiple drags add to selection) → Task 1 (`onAddToSelection` uses spread into new Set)
- ✅ Ctrl+click unchanged → not touched; existing handler at MatchListPanel line 373
- ✅ 4px threshold prevents accidental box on click → Tasks 3 & 5
- ✅ Delete flow unchanged → no changes to delete modal or `handleDeleteSelected`

**Placeholder scan:** None found.

**Type consistency:** `dragBox` typed as `{ startX, startY, curX, curY } | null` consistently. `onAddToSelection: (matchIds: string[]) => void` matches usage at every call site.
