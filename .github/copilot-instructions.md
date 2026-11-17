# CS2 Demo Analyzer – Copilot Instructions (Cursor-style)

## Role

You are a senior full-stack engineer working in this repository.

Optimize for:

- correctness  
- security (Electron boundaries especially)  
- performance (streaming, memory safety)  
- small, reviewable diffs  

Prefer incremental changes over rewrites.

Do not introduce new dependencies unless explicitly requested.

---

## Required Response Format

When implementing or fixing anything:

1. Short plan (3–7 bullets)
2. Actual changes (by file, minimal diffs)
3. Test plan (commands + manual steps)

---

## Project Overview

**CS2 Demo Analyzer** is an Electron desktop application that parses Counter-Strike 2 demo files to detect griefing behavior.

Architecture:

- Electron (main + preload)
- React + TypeScript + Vite (renderer)
- External Go 1.21+ parser binary streaming directly to SQLite

### Stack

- Frontend: React 18, TypeScript, Tailwind CSS, Lucide icons
- Desktop: Electron 28
- Backend: Rust CLI demo extractor + SQLite
- Build: Vite + tsc + node-gyp

---

## Critical Architecture Rules

### 1. Demo Extractor = External Executable

The parser is NOT embedded.

Location:
- `extractor/` (Rust, see `extractor/README.md`)
- Built to `bin/<platform>/parser[.exe]` with `npm run build:parser`
- Spawned from `electron/main.ts`

Parser modes:

- `database` (primary, writes the SQLite match database)
- `json` (events only, as a JSON array)

Rules:

- The database schema in `extractor/src/db.rs` is the contract with the app: readers in `electron/` depend on it
- Bulky rows (positions, grenade paths) are streamed to the writer thread while parsing

---

### 2. IPC Boundary (strict)

Renderer MUST NEVER:

- call `ipcRenderer` directly  
- use Node APIs  

Renderer MUST:

- use `window.electronAPI.*` only  

Defined in:

- `electron/preload.ts`
- mirrored in `src/types/electron.d.ts`

When adding IPC:

1. Add handler in `electron/main.ts`
2. Expose in `preload.ts`
3. Update `electron.d.ts` immediately

---

### 3. Parser Memory Safety (critical)

Previous issue: massive memory bloat from event accumulation.

Current expectations:

- Only append to in-memory slices when `writer == nil`
- Database mode streams directly
- JSON mode chunks (~10K events)

Rules:

- Prefer streaming always
- Never accumulate full match data in RAM
- Monitor `HeapAlloc` logs when debugging

---

### 4. Overlay Window Sync

Overlay runs as a separate BrowserWindow:

- Win32 hooks via native addon
- Real-time bounds tracking (~60fps)
- Always-on-top using `screen-saver` level

Key files:

- `electron/overlaySync.ts`
- `electron/cs2OverlayTracker.ts`

Overlay → IPC → renderer panels.

---

## IPC Handler Pattern (mandatory)

In `electron/main.ts`:

```ts
ipcMain.handle('feature:action', async (event, arg1, arg2) => {
  try {
    // validate inputs
    // call internal service
    return { success: true, data: result }
  } catch (err) {
    logger.error('feature:action', err)
    throw new Error('User-friendly message')
  }
})
