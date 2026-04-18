# .dem File Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the app as a `.dem` file handler so double-clicking a demo file launches the app and silently queues it for parsing — identical to drag-and-drop but initiated from the OS.

**Architecture:** Main process handles three entry points (cold start argv, `second-instance` for Windows/Linux, `open-file` for macOS) via a shared `handleDemoOpen` helper that buffers paths until the window is ready, then sends an IPC push event to the renderer. App.tsx accumulates received paths in state and passes them as props to MatchesScreen, which merges them into the existing parse queue (minimized/background).

**Tech Stack:** Electron (main process IPC, app events), React/TypeScript (renderer state/props), electron-builder (file association registration in `package.json`)

---

## Files

| File | Change |
|------|--------|
| `package.json` | Add `fileAssociations` to electron-builder build config |
| `electron/main.ts` | Add `pendingDemoPaths` buffer, `handleDemoOpen` helper, `requestSingleInstanceLock`, `second-instance` handler, `open-file` handler, cold-start argv check, flush on `ready-to-show` |
| `electron/preload.ts` | Add `onDemoOpen` listener |
| `src/types/electron.d.ts` | Add `onDemoOpen` to `ElectronAPI` interface |
| `src/App.tsx` | Add `pendingDemos` state + `onDemoOpen` subscription + props to `MatchesScreen` |
| `src/components/MatchesScreen.tsx` | Add `MatchesScreenProps`, accept `pendingDemos` + `onPendingDemosConsumed`, add `useEffect` to consume pending demos |

---

## Task 1: Register file association in `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `fileAssociations` to build config**

In `package.json`, add a top-level `fileAssociations` array inside the `"build"` object, after the `"publish"` block:

```json
"fileAssociations": [
  {
    "ext": "dem",
    "name": "CS2 Demo File",
    "role": "Viewer",
    "mimeType": "application/x-csgo-demo"
  }
]
```

The full `"build"` object should end like:
```json
    "publish": [
      {
        "provider": "github",
        "owner": "weeklyvillain",
        "repo": "cs2-demo-analyzer"
      }
    ],
    "fileAssociations": [
      {
        "ext": "dem",
        "name": "CS2 Demo File",
        "role": "Viewer",
        "mimeType": "application/x-csgo-demo"
      }
    ]
  }
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "build: register .dem file association"
```

---

## Task 2: Add `handleDemoOpen` helper and buffer to `electron/main.ts`

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add module-level buffer after existing `let` declarations (around line 25)**

After `let overlayWindow: BrowserWindow | null = null`, add:

```typescript
/** Paths buffered before mainWindow is ready to receive IPC. */
const pendingDemoPaths: string[] = []
```

- [ ] **Step 2: Add `handleDemoOpen` helper function**

After the `pendingDemoPaths` declaration, add:

```typescript
/** Validate and route a .dem path to the renderer, buffering if window not ready. */
function handleDemoOpen(filePath: string): void {
  if (!filePath || !filePath.toLowerCase().endsWith('.dem')) return
  if (!fs.existsSync(filePath)) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('demo:openFile', filePath)
  } else {
    pendingDemoPaths.push(filePath)
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat: add handleDemoOpen helper with buffer"
```

---

## Task 3: Handle macOS `open-file` and single-instance lock in `electron/main.ts`

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add macOS `open-file` handler before `app.whenReady()`**

Find the line `app.whenReady().then(async () => {` (around line 682). Directly above it, add:

```typescript
// macOS: file opened via Finder (fires before and after app is ready)
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  handleDemoOpen(filePath)
})
```

- [ ] **Step 2: Add `requestSingleInstanceLock` and `second-instance` handler**

Directly above the `app.on('open-file', ...)` block you just added (still before `app.whenReady()`), add:

```typescript
// Windows/Linux: prevent second instance, receive file path from it instead
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, argv) => {
    // argv[0] is the executable, argv[1] may be '--' or the file path
    const demPath = argv.find(arg => arg.toLowerCase().endsWith('.dem'))
    if (demPath) handleDemoOpen(demPath)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat: handle second-instance and open-file for .dem paths"
```

---

## Task 4: Cold-start argv check and buffer flush in `electron/main.ts`

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add cold-start argv check inside `app.whenReady()`**

Inside `app.whenReady().then(async () => {`, after the existing `protocol.registerFileProtocol` calls (around line 695), add:

```typescript
// Cold start: check if a .dem file was passed as CLI argument
// process.argv[0] = node/electron, process.argv[1] = script or '--', rest = user args
const coldStartDemo = process.argv.slice(1).find(arg => arg.toLowerCase().endsWith('.dem'))
if (coldStartDemo) {
  handleDemoOpen(coldStartDemo)
}
```

- [ ] **Step 2: Flush buffer after `ready-to-show`**

Find the `mainWindow.once('ready-to-show', () => {` block (around line 217). Inside it, after the existing `mainWindow.webContents.send('matches:cleanup', ...)` block (after line 232), add the flush before the closing `}`  of the `if (mainWindow)` block:

```typescript
      // Flush any .dem paths received before window was ready
      for (const filePath of pendingDemoPaths.splice(0)) {
        mainWindow.webContents.send('demo:openFile', filePath)
      }
```

The full `ready-to-show` block should look like:
```typescript
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show()
      // Close splash if it exists
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
        splashWindow = null
      }
      // Notify main window about cleanup if there were deleted databases
      if (startupCleanupDeleted.length > 0) {
        mainWindow.webContents.send('matches:cleanup', {
          deleted: startupCleanupDeleted.length,
          details: startupCleanupDeleted,
        })
      }
      // Flush any .dem paths received before window was ready
      for (const filePath of pendingDemoPaths.splice(0)) {
        mainWindow.webContents.send('demo:openFile', filePath)
      }
    }
  })
```

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat: cold-start argv check and buffer flush for .dem file open"
```

---

## Task 5: Expose `onDemoOpen` in preload and types

**Files:**
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`

- [ ] **Step 1: Add `onDemoOpen` to preload**

In `electron/preload.ts`, in the `contextBridge.exposeInMainWorld('electronAPI', {` object, find the `// Listeners (return unsubscribe so callers can remove only their own listener)` comment (around line 134). Add the new listener before it:

```typescript
  // Demo file association
  onDemoOpen: (callback: (filePath: string) => void) => {
    const wrapper = (_: unknown, filePath: string) => callback(filePath)
    ipcRenderer.on('demo:openFile', wrapper)
    return () => ipcRenderer.removeListener('demo:openFile', wrapper)
  },
```

- [ ] **Step 2: Add `onDemoOpen` to `ElectronAPI` interface**

In `src/types/electron.d.ts`, find `onParserMessage` (around line 141) and add before it:

```typescript
  onDemoOpen: (callback: (filePath: string) => void) => () => void
```

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts src/types/electron.d.ts
git commit -m "feat: expose onDemoOpen via contextBridge"
```

---

## Task 6: Wire `pendingDemos` state in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `pendingDemos` state**

In `src/App.tsx`, find the existing state declarations inside `function App()` (around line 20). Add after `const [appVersion, setAppVersion] = useState<string>('')`:

```typescript
  const [pendingDemos, setPendingDemos] = useState<string[]>([])
```

- [ ] **Step 2: Subscribe to `onDemoOpen`**

Add a new `useEffect` after the existing `onParserDone` effect (after line 42):

```typescript
  // Queue .dem files opened via OS file association
  useEffect(() => {
    if (!window.electronAPI) return
    const unsub = window.electronAPI.onDemoOpen((filePath) => {
      setPendingDemos((prev) => [...prev, filePath])
    })
    return unsub
  }, [])
```

- [ ] **Step 3: Pass props to `MatchesScreen`**

Find the line `{currentScreen === 'matches' && <MatchesScreen />}` (around line 132). Replace it with:

```tsx
          {currentScreen === 'matches' && (
            <MatchesScreen
              pendingDemos={pendingDemos}
              onPendingDemosConsumed={() => setPendingDemos([])}
            />
          )}
```

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: accumulate file-association demo paths in App.tsx"
```

---

## Task 7: Consume `pendingDemos` in `MatchesScreen`

**Files:**
- Modify: `src/components/MatchesScreen.tsx`

- [ ] **Step 1: Add props interface**

In `src/components/MatchesScreen.tsx`, directly before `function MatchesScreen() {` (line 24), add:

```typescript
interface MatchesScreenProps {
  pendingDemos?: string[]
  onPendingDemosConsumed?: () => void
}
```

- [ ] **Step 2: Destructure props**

Change the function signature from:
```typescript
function MatchesScreen() {
```
to:
```typescript
function MatchesScreen({ pendingDemos = [], onPendingDemosConsumed }: MatchesScreenProps) {
```

- [ ] **Step 3: Add ref to track current `demoToParse`**

In `MatchesScreen`, find the existing `const [demoToParse, setDemoToParse] = useState<string | null>(null)` line (around line 63). After it, add:

```typescript
  const demoToParseRef = useRef<string | null>(null)
  demoToParseRef.current = demoToParse
```

`useRef` is already imported — confirm it's in the existing `import { useState, useEffect, useRef } from 'react'` at the top of the file.

- [ ] **Step 4: Add `useEffect` to consume pending demos**

After the existing `useEffect` that loads the DB viewer setting (around line 96), add:

```typescript
  // Consume demos received via OS file association (queued silently in background)
  useEffect(() => {
    if (!pendingDemos || pendingDemos.length === 0) return
    if (demoToParseRef.current !== null) {
      // Already parsing — append all new paths to the queue
      setDemosToParse((prev) => [...prev, ...pendingDemos])
    } else {
      // Nothing parsing yet — start queue minimized (background)
      setDemoToParse(pendingDemos[0])
      setDemosToParse(pendingDemos.slice(1))
    }
    // Do NOT set showParsingModal=true — runs silently in background
    onPendingDemosConsumed?.()
  }, [pendingDemos, onPendingDemosConsumed])
```

- [ ] **Step 5: Commit**

```bash
git add src/components/MatchesScreen.tsx
git commit -m "feat: consume file-association demo paths in MatchesScreen"
```

---

## Task 8: Build verification

- [ ] **Step 1: TypeScript check**

```bash
npm run build:electron
```

Expected: no TypeScript errors. Fix any type mismatches before continuing.

- [ ] **Step 2: Vite build check**

```bash
npm run build:vite
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test (dev mode)**

```bash
npm run dev
```

With the dev server running, open a terminal and run:

```bash
# Windows
"./node_modules/.bin/electron" . "path/to/some/match.dem"
```

Expected: app launches, `ParsingModal` starts running in background (minimized), toast notification appears when parse completes.

- [ ] **Step 4: Commit if any fixes were made during verification**

```bash
git add -A
git commit -m "fix: address build errors from file association feature"
```
