# Spec: .dem File Association

**Date:** 2026-04-18  
**Status:** Approved

## Overview

Register the app as a handler for `.dem` files so that double-clicking a demo file in the OS file browser launches the app and silently queues the file for parsing — identical to drag-and-drop or the "Add Demo" button, but initiated externally.

## Scope

- All three platforms: Windows, macOS, Linux
- Silent queueing: no forced navigation, no modal popup (runs in background via existing minimized parse flow)
- Queues alongside any in-progress parse (does not interrupt)
- Context menu entries (Windows Explorer right-click): out of scope, deferred

---

## Architecture

### 1. File Association Registration (`package.json`)

Add `fileAssociations` to the electron-builder `build` config:

```json
"fileAssociations": [
  {
    "ext": "dem",
    "name": "CS2 Demo File",
    "role": "Viewer"
  }
]
```

electron-builder handles platform-specific registration:
- **Windows:** NSIS installer writes registry keys associating `.dem` with the app
- **macOS:** `Info.plist` `CFBundleDocumentTypes` entry
- **Linux:** `.desktop` file with `MimeType=application/x-dem`

### 2. Main Process (`electron/main.ts`)

Three entry points for receiving a `.dem` path, all converging on a shared helper:

```
handleDemoOpen(filePath: string)
  → validates .dem extension + file exists
  → if mainWindow ready: mainWindow.webContents.send('demo:openFile', filePath)
  → if mainWindow not yet ready: buffer in pendingDemoPath[], flush on 'ready-to-show'
```

**Entry point A — Cold start (all platforms)**  
After `app.whenReady()`, inspect `process.argv` for a `.dem` argument (skip Electron internal args). Call `handleDemoOpen` if found. Buffering handles the case where the main window hasn't appeared yet.

**Entry point B — Already running, Windows/Linux**  
Use `app.requestSingleInstanceLock()`. In the `second-instance` handler, extract `.dem` path from the incoming `argv` array. Call `handleDemoOpen`. Also call `mainWindow.focus()` to bring the app to front.

**Entry point C — Already running, macOS**  
`app.on('open-file', (event, filePath) => { event.preventDefault(); handleDemoOpen(filePath) })`. Must be registered before `app.whenReady()` to catch early events.

### 3. Preload (`electron/preload.ts`)

Expose one new listener on `contextBridge`:

```typescript
onDemoOpen: (cb: (filePath: string) => void) =>
  ipcRenderer.on('demo:openFile', (_, filePath) => cb(filePath))
```

### 4. Type Definitions (`src/types/electron.d.ts`)

Add to `ElectronAPI`:

```typescript
onDemoOpen: (cb: (filePath: string) => void => void
```

### 5. App.tsx

- Add `pendingDemos: string[]` state (initially `[]`).
- On mount, subscribe: `window.electronAPI.onDemoOpen(path => setPendingDemos(prev => [...prev, path]))`.
- Pass two new props to `MatchesScreen`:
  - `pendingDemos: string[]`
  - `onPendingDemosConsumed: () => void` — resets state to `[]`

### 6. MatchesScreen

Accept `pendingDemos?: string[]` and `onPendingDemosConsumed?: () => void`.

Add a `useEffect` watching `pendingDemos`:
- When non-empty, merge into `demosToParse` (append, not replace)
- Set `showParsingModal = false` (minimized — parsing runs in background)
- Call `onPendingDemosConsumed()` to clear App.tsx state

If `ParsingModal` is already active with an in-progress queue, the new paths append to `demosToParse` and are picked up by the existing sequential/parallel loop naturally.

---

## Data Flow

```
OS double-click .dem
  → Electron launches (or second-instance/open-file event fires)
  → handleDemoOpen(filePath) in main.ts
  → IPC push: 'demo:openFile' → renderer
  → App.tsx: pendingDemos state updated
  → MatchesScreen useEffect: paths merged into demosToParse, modal minimized
  → ParsingModal: parses in background, emits progress events as normal
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| App not running, double-click | Cold start, `process.argv` check after `whenReady` |
| App running, user on Settings screen | Path buffered in App.tsx `pendingDemos`; consumed when user navigates to Matches |
| Already parsing, new file opened | Appended to queue, parsed after current job(s) |
| Invalid path / non-.dem extension | `handleDemoOpen` validates and silently ignores |
| File doesn't exist on disk | `handleDemoOpen` validates and silently ignores |
| Multiple files opened at once (macOS) | `open-file` fires once per file; each goes through `handleDemoOpen` |

---

## Out of Scope

- Windows Explorer right-click context menu entries (deferred)
- Auto-navigation to Matches screen on file open
