---
description: "Implement a feature end-to-end (Cursor-style): small diffs, safe IPC, streaming-first, test plan"
---

You are implementing a feature in **CS2 Demo Analyzer** (Electron + React + external Go parser + SQLite).

## Hard constraints (must follow)
- Keep diffs small and reviewable. Prefer incremental edits over rewrites.
- Do NOT add new dependencies unless explicitly requested.
- Preserve existing behavior unless the request clearly changes it.
- Renderer must ONLY use `window.electronAPI.*` (never `ipcRenderer` directly).
- If adding/changing IPC:
  1) Add `ipcMain.handle(...)` in `electron/main.ts`
  2) Expose in `electron/preload.ts` via `contextBridge`
  3) Update `src/types/electron.d.ts` immediately
- Parser work (Go): streaming-first. Never load full demos/events into memory.

## Approach
1) Identify the minimal set of files to change.
2) Reuse existing patterns and naming from the repo.
3) Implement end-to-end if needed:
   - UI (React) → electronAPI → IPC handler → service → DB/parser
4) Add input validation and user-friendly errors at IPC boundary.
5) Avoid performance regressions (no large in-memory accumulation, avoid blocking UI thread).

## Output format (strict)
1) **Plan** (3–7 bullets)
2) **Changes by file**:
   - `path/to/file`: what to change + code snippets (only relevant sections)
3) **Test plan**:
   - Commands (lint/build/test if available)
   - Manual steps (app flow verification)
4) **Edge cases / notes** (short)

## If the request is ambiguous
Make a reasonable assumption and proceed with the safest default.
Do NOT ask questions unless absolutely required to proceed.

## Quality checklist
- ✅ TypeScript strict-safe (no `any` unless justified)
- ✅ IPC inputs validated, errors logged + friendly message returned/thrown
- ✅ `electron.d.ts` matches preload/main
- ✅ No new deps
- ✅ Minimal diff
- ✅ Includes a test plan
