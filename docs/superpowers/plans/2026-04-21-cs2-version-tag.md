# CS2 Version Tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an "Outdated" badge (with tooltip showing both build numbers) on match cards and in the match detail header when a demo's CS2 build number differs from the latest release.

**Architecture:** Go parser captures `BuildNum` from `CDemoFileHeader` proto message and stores it in each match's `meta` table. On startup, the Electron main process fetches the current CS2 build from the Steam public API and caches it in memory. The renderer fetches it once via IPC, stores it in state, and compares against each match's `buildNum` to conditionally render badges.

**Tech Stack:** Go (demoinfocs-golang v5), Electron (TypeScript), React 18, Tailwind CSS, SQLite (sql.js in renderer, modernc/sqlite in Go)

---

### Task 1: Add `BuildNum` to Go MatchData and parser

**Files:**
- Modify: `internal/parser/parser.go`

- [ ] **Step 1: Add `BuildNum` field to `MatchData` struct**

In `internal/parser/parser.go`, find the `MatchData` struct (~line 34). Add `BuildNum` after `Source`:

```go
// MatchData contains extracted match information.
type MatchData struct {
	Map              string
	TickRate         float64
	StartedAt        *time.Time
	Source           string
	BuildNum         int32  // CS2 build number from CDemoFileHeader
	Players          []PlayerData
	Rounds           []RoundData
	Events           []extractors.Event
	ChatMessages     []ChatMessageData
	Positions        []PlayerPositionData
	GrenadePositions []GrenadePositionData
	GrenadeEvents    []GrenadeEventData
	Shots            []ShotData
	InfernoPositions []InfernoPositionData
}
```

- [ ] **Step 2: Declare `buildNum` local variable near the other tracking vars**

In `ParseWithDB`, find the block starting with `var mapName string` (~line 439). Add `buildNum` declaration alongside:

```go
var mapName string
var serverName string
var buildNum int32
```

- [ ] **Step 3: Register `CDemoFileHeader` net message handler**

Directly after the existing `CSVCMsg_ServerInfo` handler (~line 597), add:

```go
// Capture CS2 build number from demo file header
p.parser.RegisterNetMessageHandler(func(h *msg.CDemoFileHeader) {
	if h != nil {
		buildNum = h.GetBuildNum()
	}
})
```

- [ ] **Step 4: Assign `BuildNum` to data before returning**

Find the block near line 3128 where `data.Source` is set:

```go
demoFileName := filepath.Base(p.path)
data.Source = getDemoSource(serverName, demoFileName)
```

Add the BuildNum assignment right after `data.Source`:

```go
data.BuildNum = buildNum
```

- [ ] **Step 5: Verify the code compiles**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add internal/parser/parser.go
git commit -m "feat(parser): capture BuildNum from CDemoFileHeader"
```

---

### Task 2: Store `build_num` in match meta table

**Files:**
- Modify: `cmd/parser/main.go`

- [ ] **Step 1: Write `build_num` to meta after parsing completes**

In `cmd/parser/main.go`, find the `run()` function's metadata-writing block (~line 1109):

```go
// Store metadata
if err := writer.SetMeta(ctx, "demo_path", demoPath); err != nil {
    output.Log("warn", fmt.Sprintf("Failed to store demo_path meta: %v", err))
}
```

Add `build_num` storage directly after `demo_path`:

```go
// Store metadata
if err := writer.SetMeta(ctx, "demo_path", demoPath); err != nil {
    output.Log("warn", fmt.Sprintf("Failed to store demo_path meta: %v", err))
}
if matchData.BuildNum > 0 {
    if err := writer.SetMeta(ctx, "build_num", fmt.Sprintf("%d", matchData.BuildNum)); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to store build_num meta: %v", err))
    }
}
```

- [ ] **Step 2: Verify `fmt` is already imported**

```bash
grep '"fmt"' cmd/parser/main.go
```

Expected: matches found. If not, add `"fmt"` to the import block.

- [ ] **Step 3: Compile**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add cmd/parser/main.go
git commit -m "feat(parser): store build_num in match meta table"
```

---

### Task 3: Read `buildNum` from match DB in matchesService

**Files:**
- Modify: `electron/matchesService.ts`

- [ ] **Step 1: Add `buildNum` to `MatchInfo` interface**

Find the `MatchInfo` interface (~line 10):

```ts
export interface MatchInfo {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
}
```

Add `buildNum`:

```ts
export interface MatchInfo {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
  buildNum: number | null
}
```

- [ ] **Step 2: Read `build_num` from meta in `loadOneMatchInfo`**

Find the section in `loadOneMatchInfo` that reads from the `meta` table (~line 218). It currently reads `demo_path` and `created_at_iso`:

```ts
if (row[0] === 'demo_path') demoPath = row[1] || null
if (row[0] === 'created_at_iso') createdAtIso = row[1] || null
```

Add `build_num` alongside these:

```ts
let buildNum: number | null = null
// ...inside the meta loop:
if (row[0] === 'demo_path') demoPath = row[1] || null
if (row[0] === 'created_at_iso') createdAtIso = row[1] || null
if (row[0] === 'build_num') {
  const parsed = parseInt(row[1], 10)
  if (!isNaN(parsed) && parsed > 0) buildNum = parsed
}
```

Note: declare `let buildNum: number | null = null` before the meta try/catch block, so it stays in scope for the return statement.

- [ ] **Step 3: Include `buildNum` in the returned object**

Find the return statement (~line 275):

```ts
return {
  id: matchId,
  map: matchResult.map || matchId,
  startedAt: matchResult.started_at || null,
  playerCount: playerCount || 0,
  demoPath: demoPath || null,
  isMissingDemo,
  createdAtIso: createdAtIso || null,
  source: matchResult.source,
}
```

Add `buildNum`:

```ts
return {
  id: matchId,
  map: matchResult.map || matchId,
  startedAt: matchResult.started_at || null,
  playerCount: playerCount || 0,
  demoPath: demoPath || null,
  isMissingDemo,
  createdAtIso: createdAtIso || null,
  source: matchResult.source,
  buildNum,
}
```

- [ ] **Step 4: Commit**

```bash
git add electron/matchesService.ts
git commit -m "feat(service): read build_num from match meta table"
```

---

### Task 4: Fetch latest CS2 build on startup in main process

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add module-level cache variable**

Near the top of `electron/main.ts`, after existing module-level variable declarations, add:

```ts
let latestCS2Build: number | null = null
```

- [ ] **Step 2: Fetch CS2 build in `app.whenReady()`**

Inside `app.whenReady().then(async () => {` (~line 777), after the protocol handlers but before `createWindow()`, add:

```ts
// Fetch latest CS2 build number from Steam API (fire-and-forget, silent failure)
;(async () => {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      'https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid=730&version=0',
      { signal: controller.signal }
    )
    clearTimeout(timeout)
    if (res.ok) {
      const json = await res.json() as { response?: { required_version?: number } }
      const ver = json?.response?.required_version
      if (typeof ver === 'number' && ver > 0) {
        latestCS2Build = ver
        console.log(`[CS2Version] Latest build: ${latestCS2Build}`)
      }
    }
  } catch {
    console.log('[CS2Version] Failed to fetch latest CS2 build (offline?)')
  }
})()
```

- [ ] **Step 3: Add IPC handler for `version:getLatestCS2Build`**

Find where the `app:getInfo` IPC handler lives (~line 3824). Add the new handler nearby (outside `whenReady`, same pattern as other `ipcMain.handle` calls):

```ts
ipcMain.handle('version:getLatestCS2Build', async () => {
  return latestCS2Build
})
```

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(main): fetch latest CS2 build on startup, expose via IPC"
```

---

### Task 5: Wire up IPC bridge and update TypeScript types

**Files:**
- Modify: `electron/preload.ts`
- Modify: `src/types/electron.d.ts`
- Modify: `src/types/matches.ts`

- [ ] **Step 1: Expose `getLatestCS2Build` in preload**

In `electron/preload.ts`, inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` block, add after the existing CS2 launch methods:

```ts
// CS2 version check
getLatestCS2Build: () => ipcRenderer.invoke('version:getLatestCS2Build'),
```

- [ ] **Step 2: Add `getLatestCS2Build` to electron type declaration**

In `src/types/electron.d.ts`, find the `listMatches` line (~line 17). Add `getLatestCS2Build` alongside the other methods:

```ts
getLatestCS2Build(): Promise<number | null>
```

Also update the `listMatches` return type to include `buildNum` (it's an inline type on that line):

```ts
listMatches: () => Promise<Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null; source?: string | null; buildNum: number | null }>>
```

Also find the `onMatchesList` callback type (~line 152) and add `buildNum: number | null` to its array element type:

```ts
onMatchesList: (callback: (matches: Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null; source?: string | null; buildNum: number | null }>) => void) => void
```

- [ ] **Step 3: Add `buildNum` to the `Match` type**

In `src/types/matches.ts`, find the `Match` interface:

```ts
export interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
}
```

Add `buildNum`:

```ts
export interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
  buildNum?: number | null
}
```

- [ ] **Step 4: Commit**

```bash
git add electron/preload.ts src/types/electron.d.ts src/types/matches.ts
git commit -m "feat(types): add buildNum to Match and getLatestCS2Build IPC"
```

---

### Task 6: Fetch latest build in renderer and thread through to children

**Files:**
- Modify: `src/components/MatchesScreen.tsx`

- [ ] **Step 1: Add `latestCS2Build` state**

In `MatchesScreen`, after the existing `useState` declarations (~line 56), add:

```ts
const [latestCS2Build, setLatestCS2Build] = useState<number | null>(null)
```

- [ ] **Step 2: Fetch on mount**

Add a `useEffect` after the existing state declarations:

```ts
useEffect(() => {
  window.electronAPI.getLatestCS2Build().then((build) => {
    setLatestCS2Build(build)
  }).catch(() => {
    // Offline or IPC failure — no badge shown
  })
}, [])
```

- [ ] **Step 3: Pass `latestCS2Build` to `MatchListPanel`**

Find the `<MatchListPanel` usage (~line 680). Add the prop:

```tsx
<MatchListPanel
  matches={matches}
  sortedMatches={sortedMatches}
  matchStats={matchStats}
  loading={loading}
  searchQuery={searchQuery}
  setSearchQuery={setSearchQuery}
  sortField={sortField}
  setSortField={setSortField}
  sortDirection={sortDirection}
  setSortDirection={setSortDirection}
  selectedMatches={selectedMatches}
  showDeleteModal={showDeleteModal}
  setShowDeleteModal={setShowDeleteModal}
  deleting={deleting}
  enableDbViewer={enableDbViewer}
  latestCS2Build={latestCS2Build}
  onMatchClick={(matchId) => handleMatchClick(matchId)}
  onContextMenuAction={(action, match) => handleContextMenuAction(action, match)}
  onToggleMatchSelection={(matchId) => toggleMatchSelection(matchId)}
  onAddToSelection={handleAddToSelection}
  onClearSelection={() => setSelectedMatches(new Set())}
  onDeleteSelected={handleDeleteSelected}
  onAddDemo={handleAddDemo}
/>
```

- [ ] **Step 4: Pass `buildNum` and `latestCS2Build` to `MatchDetailsHeader`**

Find the `<MatchDetailsHeader` usage (~line 721). The currently-selected match's `buildNum` needs to be looked up. Find it from the `matches` array:

```tsx
const selectedMatchData = matches.find((m) => m.id === selectedMatch) ?? null
```

Place this lookup just before the `<MatchDetailsHeader` JSX (or derive it from existing state). Then pass the props:

```tsx
<MatchDetailsHeader
  selectedMatch={selectedMatch}
  matchStats={matchStats}
  rounds={rounds}
  tickRate={tickRate}
  allPlayers={allPlayers}
  demoPath={demoPath}
  activeTab={activeTab}
  setActiveTab={setActiveTab}
  hasRadarForCurrentMap={hasRadarForCurrentMap}
  onWatchInCS2={handleWatchInCS2}
  onOpenExportPanel={() => setShowExportPanel(true)}
  onFetchChatMessages={fetchChatMessages}
  buildNum={selectedMatchData?.buildNum ?? null}
  latestCS2Build={latestCS2Build}
/>
```

- [ ] **Step 5: Commit**

```bash
git add src/components/MatchesScreen.tsx
git commit -m "feat(renderer): fetch latest CS2 build on mount, pass to children"
```

---

### Task 7: Add "Outdated" badge to match list cards

**Files:**
- Modify: `src/components/MatchListPanel.tsx`

- [ ] **Step 1: Add `latestCS2Build` to `MatchListPanelProps`**

Find the `MatchListPanelProps` interface (~line 134). Add the new prop:

```ts
export interface MatchListPanelProps {
  matches: Match[]
  sortedMatches: Match[]
  matchStats: Map<string, MatchStats>
  loading: boolean
  searchQuery: string
  setSearchQuery: (q: string) => void
  sortField: 'id' | 'length' | 'map' | 'date'
  setSortField: (f: 'id' | 'length' | 'map' | 'date') => void
  sortDirection: 'asc' | 'desc'
  setSortDirection: (d: 'asc' | 'desc') => void
  selectedMatches: Set<string>
  showDeleteModal: boolean
  setShowDeleteModal: (v: boolean) => void
  deleting: boolean
  enableDbViewer: boolean
  latestCS2Build: number | null
  onMatchClick: (matchId: string) => void
  onContextMenuAction: (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => void
  onToggleMatchSelection: (matchId: string) => void
  onAddToSelection: (matchIds: string[]) => void
  onClearSelection: () => void
  onDeleteSelected: () => void
  onAddDemo: () => void
}
```

- [ ] **Step 2: Destructure `latestCS2Build` in the component function signature**

Find the `export default function MatchListPanel({` function (~line 159). Add `latestCS2Build` to the destructured props:

```ts
export default function MatchListPanel({
  matches,
  sortedMatches,
  matchStats,
  loading,
  searchQuery,
  setSearchQuery,
  sortField,
  setSortField,
  sortDirection,
  setSortDirection,
  selectedMatches,
  showDeleteModal,
  setShowDeleteModal,
  deleting,
  enableDbViewer,
  latestCS2Build,
  onMatchClick,
  onContextMenuAction,
  onToggleMatchSelection,
  onAddToSelection,
  onClearSelection,
  onDeleteSelected,
  onAddDemo,
}: MatchListPanelProps) {
```

- [ ] **Step 3: Add the "Outdated" badge inside the card thumbnail area**

Find the card thumbnail `<div>` (~line 488):

```tsx
<div className="relative h-64 bg-surface overflow-hidden w-full">
  <LazyMapThumbnail ... />
  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
    ...
  </div>
</div>
```

Add the badge inside that `div`, after the gradient overlay and before the bottom info row:

```tsx
<div className="relative h-64 bg-surface overflow-hidden w-full">
  <LazyMapThumbnail
    thumbnail={thumbnail}
    alt={match.map || t('matches.unknownMap')}
    className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-300"
  />
  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
  {match.buildNum && latestCS2Build && match.buildNum !== latestCS2Build && (
    <div
      className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black"
      title={`Demo build: #${match.buildNum} · Current: #${latestCS2Build}`}
    >
      Outdated
    </div>
  )}
  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
    ...
  </div>
</div>
```

- [ ] **Step 4: Commit**

```bash
git add src/components/MatchListPanel.tsx
git commit -m "feat(ui): add Outdated badge to match list cards"
```

---

### Task 8: Add "Outdated" badge to match detail header

**Files:**
- Modify: `src/components/MatchDetailsHeader.tsx`

- [ ] **Step 1: Add `buildNum` and `latestCS2Build` to `MatchDetailsHeaderProps`**

Find the `MatchDetailsHeaderProps` interface (~line 5). Add:

```ts
interface MatchDetailsHeaderProps {
  selectedMatch: string
  matchStats: Map<string, MatchStats>
  rounds: Round[]
  tickRate: number
  allPlayers: Player[]
  demoPath: string | null
  activeTab: ActiveTab
  setActiveTab: (tab: ActiveTab) => void
  hasRadarForCurrentMap: boolean
  buildNum: number | null
  latestCS2Build: number | null
  onWatchInCS2: () => void
  onOpenExportPanel: () => void
  onFetchChatMessages: (matchId: string) => void
}
```

- [ ] **Step 2: Destructure the new props**

Find the `export default function MatchDetailsHeader({` signature (~line 20). Add `buildNum` and `latestCS2Build`:

```ts
export default function MatchDetailsHeader({
  selectedMatch,
  matchStats,
  rounds,
  tickRate,
  allPlayers,
  demoPath,
  activeTab,
  setActiveTab,
  hasRadarForCurrentMap,
  buildNum,
  latestCS2Build,
  onWatchInCS2,
  onOpenExportPanel,
  onFetchChatMessages,
}: MatchDetailsHeaderProps) {
```

- [ ] **Step 3: Add the badge inline in the info row**

Find the info row's score block (~line 84). After the closing `})()}` of the score IIFE, add the badge:

```tsx
{/* Outdated badge */}
{buildNum && latestCS2Build && buildNum !== latestCS2Build && (
  <div
    className="px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black cursor-default"
    title={`Demo build: #${buildNum} · Current: #${latestCS2Build}`}
  >
    Outdated
  </div>
)}
```

This block goes inside the `<div className="flex items-center gap-4 text-sm text-gray-400">` that contains the time/rounds/players/score items.

- [ ] **Step 4: Commit**

```bash
git add src/components/MatchDetailsHeader.tsx
git commit -m "feat(ui): add Outdated badge to match detail header"
```

---

### Task 9: Build and verify end-to-end

- [ ] **Step 1: Build Go parser**

```bash
go build -o bin/parser.exe ./cmd/parser
```

Expected: `bin/parser.exe` produced, no errors.

- [ ] **Step 2: Build Electron TypeScript**

```bash
npm run build:electron
```

Expected: no TypeScript errors.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev
```

Expected: app launches with no console errors.

- [ ] **Step 4: Verify badge logic manually**

1. Open the app.
2. Open DevTools (Ctrl+Shift+I), run in console: `await window.electronAPI.getLatestCS2Build()` — should return a number (e.g. `14152`).
3. Parse a demo. Reopen the app (or refresh). Check the match card — if the demo's build number differs from latest, the amber "Outdated" badge should appear in the top-right of the thumbnail.
4. Click the match — the "Outdated" badge should appear inline in the header info row.
5. Hover either badge — tooltip should show `Demo build: #XXXXX · Current: #YYYYY`.

- [ ] **Step 5: Final commit if any fixups were made**

```bash
git add -p
git commit -m "fix: address CS2 version tag review fixups"
```
