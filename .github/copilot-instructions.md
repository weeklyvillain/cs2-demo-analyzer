# CS2 Demo Analyzer - Copilot Instructions

## Project Overview

**CS2 Demo Analyzer** is an Electron desktop application that parses Counter-Strike 2 demo files to detect griefing behavior. The architecture combines:
- **Electron** (main + preload processes) for UI/native integration
- **React + TypeScript + Vite** (renderer) for the UI
- **Go 1.21+** for a high-performance backend parser that streams data directly to SQLite

### Technology Stack
- **Frontend**: React 18, TypeScript, Tailwind CSS, Lucide icons
- **Desktop**: Electron 28, electron-builder for packaging
- **Backend**: Go parser (separate CLI binary), SQLite 3 for data persistence
- **Build**: Vite for renderer, tsc for main process, node-gyp for native addons

## Critical Architecture Decisions

### 1. **Go Parser as External Executable**
The parser is a **separate Go binary** (`cmd/parser/main.go`) spawned as a child process, NOT embedded:
- **Why**: Supports both CLI usage and IPC communication; easier to update independently
- **Key Files**: 
  - [cmd/parser/main.go](cmd/parser/main.go#L80) - Main CLI with `--demo`, `--out`, `--mode` flags
  - [electron/main.ts](electron/main.ts#L1) - Spawns parser via `spawn()` on parse requests
- **Build requirement**: `go build -o bin/parser.exe ./cmd/parser` (Windows) must complete before npm run dev
- **Parser modes**: 
  - `database`: Streams events to SQLite (primary)
  - `json`: Streams events to NDJSON file with memory-conscious chunking

### 2. **IPC Boundary Pattern**
Strict separation between Electron contexts via **preload.ts expose**:
- **Never** access `ipcRenderer` directly from renderer components
- **Always** use `window.electronAPI.*` (defined in [electron/preload.ts](electron/preload.ts#L1))
- Each API method is a promise-based RPC: `await electronAPI.parseDemo({demoPath})`
- Preload acts as security boundary: contextIsolation=true, sandbox=true

### 3. **Parser Memory Optimization**
The parser processes demos in **streaming mode** to prevent memory bloat:
- **Critical fix**: MatchData accumulation was causing 8-10GB bloat in database mode
- **Solution** (already implemented): 
  - Checks `writer != nil` before appending to MatchData slices
  - Data flows directly to DB buffers, never duplicated in memory
  - JSON mode uses external sorting for events (chunked 10K events per file)
- **Reference**: [MEMORY_OPTIMIZATION_SUMMARY.md](MEMORY_OPTIMIZATION_SUMMARY.md) + [cmd/parser/memory_logger.go](cmd/parser/memory_logger.go)
- **Monitor**: Memory issues? Check parser logs for "HeapAlloc" entries every 5 seconds

### 4. **Overlay Window Synchronization**
Overlay runs as a **separate BrowserWindow** that stays on top of CS2:
- **Sync method**: Win32 `SetWinEventHook` tracks CS2 window position in real-time
- **Key files**: 
  - [electron/overlaySync.ts](electron/overlaySync.ts) - Bounds tracking + throttling (~60fps)
  - [electron/cs2OverlayTracker.ts](electron/cs2OverlayTracker.ts) - Detects when CS2 window moves/minimizes
- **Z-order trick**: Uses `setAlwaysOnTop(true, 'screen-saver', 1)` for highest level
- **Event routing**: Overlay communicates incidents back to main via IPC, renderer shows IncidentPanel

## Developer Workflows

### Build & Run
```bash
# 1. Ensure Go parser is built first
go mod tidy
go build -o bin/parser.exe ./cmd/parser  # Windows

# 2. Install npm dependencies
npm install

# 3. Start dev server (Vite + Electron with hot reload)
npm run dev

# 4. Package for distribution
npm run package:win  # or :mac, :linux
```

### Build Chain Dependencies
- `npm run dev:vite` starts Vite on port 5173
- `npm run dev:electron` waits for port 5173, then launches Electron (reads .env for PARSER_PATH)
- **DO NOT** run in parallel; concurrently manages order
- Hot reload works for renderer; main process needs manual restart

### Testing Parser Locally
```bash
# Parse a demo to SQLite database
./bin/parser -demo "path/to/demo.dem" -out "output.db" -mode database

# Parse to JSON (for debugging)
./bin/parser -demo "path/to/demo.dem" -output "events.ndjson" -mode json -steam-ids "steamid1,steamid2"
```

## Code Patterns & Conventions

### IPC Handler Pattern
All Electron IPC handlers follow this structure in [electron/main.ts](electron/main.ts#L1):
```typescript
ipcMain.handle('feature:action', async (event, arg1, arg2) => {
  try {
    // Validate inputs
    // Call internal service
    // Return result or throw error
    return { success: true, data: result }
  } catch (err) {
    logger.error('feature:action', err)
    throw new Error('User-friendly message')
  }
})
```

### Parser Spawning Pattern
```typescript
// Always use spawnSync for blocking, spawn for async with listeners
parserProcess = spawn(parserPath, [
  '--demo', demoPath,
  '--out', dbPath,
  '--mode', 'database',
  '--steam-ids', steamIds.join(',')
])
// Listen to stdout for progress: "progress:10000" means 10K events parsed
// Listen to stderr for errors
// Handle 'exit' with code check (0=success, 1=error)
```

### React Component Structure
- **Screens** ([src/components/\*Screen.tsx](src/components)): Full-page views (MatchesScreen, SettingsScreen, etc.)
- **Panels** ([src/components/\*Panel.tsx](src/components)): Reusable sub-components (IncidentPanel shows griefing events)
- **Data flow**: Components call `window.electronAPI.*()` to fetch data, store in local useState
- **No external state management**: Simple local state; prefer prop drilling over Redux

### TypeScript Patterns
- **Type bridge**: [src/types/electron.d.ts](src/types/electron.d.ts) declares all IPC APIs
- **Keep in sync**: When adding new ipcMain.handle() in main.ts, update electron.d.ts immediately
- **Strict mode**: tsconfig.json enables strict null checks and noImplicitAny

## Integration Points & External Dependencies

### CS2 Game Integration
- **Game info file**: Reads `gameinfo.gi` to detect CS2 installation
- **Demo loading**: Uses `con_runcommand` via CS2 console to load demo at tick
- **Plugin hooks**: Optional CS2 plugin for real-time event capture (see [electron/cs2-plugin.ts](electron/cs2-plugin.ts))

### Native Addon (node-gyp)
- **Path**: [electron/native-addon/](electron/native-addon/)
- **Purpose**: Window hooking for overlay synchronization
- **Build**: `npm run build:addon` (automatic on `npm run build`)
- **Only rebuild if**: Modifying native sync code or Windows API calls

### Database: SQLite
- **CLI tool**: Go uses github.com/mattn/go-sqlite3 for writes
- **Renderer queries**: Uses built-in SQL runner in [electron/main.ts](electron/main.ts#L1) via IPC
- **Schema**: Auto-created by parser (tables: Rounds, Events, Grenades, Chat, Positions, etc.)
- **Location**: `~/.cs2-demo-analyzer/matches/{matchId}.db`

### External Services
- **Auto-updates**: electron-updater polls GitHub releases
- **Voice extraction** (optional): Requires ffmpeg in PATH, creates WAV files per round
- **Waveform generation**: Uses audiowaveform CLI binary if available

## Project-Specific Conventions

### File Naming
- **Electron main process**: lowercase + dash (e.g., `commandLog.ts`, `cs2-plugin.ts`)
- **React components**: PascalCase + feature (e.g., `IncidentPanel.tsx`, `MatchesScreen.tsx`)
- **Go packages**: lowercase (e.g., `internal/parser`, `internal/db`)

### Error Handling
- **Preload/IPC**: Always wrap in try-catch, return error objects with `{ success: false, error: '...' }`
- **React components**: Use error boundaries for parser failures, show user-friendly toast notifications
- **Go parser**: Exit with code 1 on error, log to stderr (main.ts captures this)

### Logging
- **Renderer**: Use console.log (visible in DevTools)
- **Main process**: Write to `~/.cs2-demo-analyzer/logs/` (electron-log manages rotation)
- **Go parser**: Stdout for progress ("progress:X"), stderr for errors, optionally memory logs

### Configuration
- **App settings**: Stored in `~/.cs2-demo-analyzer/settings.db` (SQLite)
- **API**: `await electronAPI.getSetting(key)` / `await electronAPI.setSetting(key, value)`
- **Common keys**: `demo_path`, `parser_path`, `enable_overlay`, `enable_db_viewer`, `hotkey`

## When Adding Features

1. **Add parser output?** Modify Go parser → update streaming buffers → update IPC handler → update electron.d.ts
2. **Add UI screen?** Create [src/components/MyScreen.tsx](src/components) → add to App.tsx screen union → wire IPC calls
3. **Add main process service?** Create [electron/myService.ts](electron) → export functions → call from IPC handlers
4. **Update parser binary location?** Edit PARSER_PATH env var or hardcoded path in main.ts (search "parser.exe")
5. **Modify database schema?** Update Go parser's db.* types → parser handles schema creation automatically

## Troubleshooting Checklist

- **Parser not found**: Check `PARSER_PATH` env var or `bin/parser.exe` exists
- **IPC call returns undefined**: Verify preload.ts exposes the API AND main.ts has `ipcMain.handle()` for it
- **Memory bloat while parsing**: Check parser logs for "HeapAlloc"; likely event filtering is ineffective
- **Overlay not syncing to CS2**: Verify win32 hook is active (check cs2OverlayTracker logs), try restart app
- **SQLite locked errors**: Multiple parser instances writing same DB; check for orphaned processes
