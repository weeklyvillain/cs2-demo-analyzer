# CS2 Version Tag

**Date:** 2026-04-21

## Problem

When a demo is parsed it captures the CS2 build number it was recorded on. If that build is older than the current CS2 release, the user should know — stale demos may have different behaviour, map layouts, or scoring context. Currently no version info is shown anywhere in the UI.

## Goal

Show a small "Outdated" tag on match cards and in the match detail header when a demo's build number differs from the latest CS2 release. Hovering the tag shows both build numbers in a tooltip.

## Approach

Fetch the latest CS2 build once on startup via the Steam public API (no auth required). Store it in memory in the main process and expose it via IPC. Parse `BuildNum` from `CDemoFileHeader` during demo parsing and persist it in the match's `meta` table. Compare in the renderer and render a badge where relevant.

---

## Implementation

### 1. Go parser — capture `BuildNum`

In `internal/parser/parser.go`, inside `ParseWithDB`, register a net message handler for `*msg.CDemoFileHeader`:

```go
p.parser.RegisterNetMessageHandler(func(h *msg.CDemoFileHeader) {
    if h != nil {
        buildNum = h.GetBuildNum()
    }
})
```

After parsing completes, write to the `meta` table:

```
INSERT OR REPLACE INTO meta (key, value) VALUES ('build_num', '<buildNum>')
```

This follows the exact same pattern as `demo_path`. No schema migration needed — `meta` is already a key/value table present in all match DBs.

### 2. Main process — fetch latest CS2 build on startup

In `electron/main.ts`, after `app.whenReady()`, fetch:

```
GET https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid=730&version=0
```

Response shape:
```json
{ "response": { "success": true, "up_to_date": false, "version_is_listable": true, "required_version": 14100 } }
```

`required_version` is the current build number. Cache it in a module-level variable `let latestCS2Build: number | null = null`. On fetch failure (network error, timeout, bad response) leave it as `null` — no tag shown.

**IPC handler:** `version:getLatestCS2Build` → returns `latestCS2Build` (number | null).

**Timeout:** 5 seconds. No retry. Silent failure.

### 3. Main process — include `buildNum` in match info

In `electron/matchesService.ts`, `MatchInfo` gains:
```ts
buildNum: number | null
```

When building match info, query:
```sql
SELECT value FROM meta WHERE key = 'build_num'
```
Parse as integer. If the key is absent or parsing fails, set `null`.

### 4. IPC & types

- `electron/preload.ts`: expose `getLatestCS2Build: () => Promise<number | null>`
- `src/types/electron.d.ts`: add `getLatestCS2Build(): Promise<number | null>`
- `src/types/matches.ts`: `Match` gains `buildNum: number | null`

### 5. Renderer — state

In `MatchesScreen`, on mount:
```ts
const build = await window.electronAPI.getLatestCS2Build()
setLatestCS2Build(build)  // number | null
```

Pass `latestCS2Build` down to `MatchListPanel` and `MatchDetailsHeader`.

### 6. UI — match list card (`MatchListPanel`)

Condition: `match.buildNum && latestCS2Build && match.buildNum !== latestCS2Build`

Render a badge in the top-right of the card thumbnail area:
```tsx
<div
  className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black"
  title={`Demo build: #${match.buildNum} · Current: #${latestCS2Build}`}
>
  Outdated
</div>
```

Position conflicts: the existing checkmark badge is top-left, so top-right is clear.

### 7. UI — match detail header (`MatchDetailsHeader`)

`MatchDetailsHeader` receives `buildNum: number | null` and `latestCS2Build: number | null` as props.

Inline in the info row, after the score:
```tsx
{buildNum && latestCS2Build && buildNum !== latestCS2Build && (
  <div
    className="px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black cursor-default"
    title={`Demo build: #${buildNum} · Current: #${latestCS2Build}`}
  >
    Outdated
  </div>
)}
```

---

## Error handling

| Failure | Behaviour |
|---------|-----------|
| Steam API unreachable | `latestCS2Build = null`, no tags shown |
| Demo has no `build_num` in meta | `match.buildNum = null`, no tag shown |
| Build numbers match | No tag shown |

## What is not in scope

- Caching the fetched version to disk between sessions
- Re-fetching the version after startup
- Filtering or sorting by version
- Any UI beyond the badge and tooltip
