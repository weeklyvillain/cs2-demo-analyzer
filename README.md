# CS2 Demo Analyzer

Electron desktop application for parsing CS2 demo files and detecting griefing behavior.

## Tech Stack

- **Electron** - Desktop app framework
- **Vite + React + TypeScript** - Renderer UI
- **TypeScript** - Main process
- **Tailwind CSS** - Styling
- **Rust demo extractor** - Parses demos into a SQLite match database (separate executable, see `extractor/`)

## Project Structure

```
.
├── electron/          # Main process TypeScript
│   ├── main.ts       # Main process entry
│   └── preload.ts    # Preload script for IPC
├── src/              # Renderer React app
│   ├── components/   # React components
│   ├── utils/        # Utilities (NDJSON parser, etc.)
│   └── types/        # TypeScript type definitions
├── resources/        # App resources (icons, parser binaries)
└── dist/             # Build output
```

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- Rust toolchain (https://rustup.rs), only needed to rebuild the demo extractor

### Install Dependencies

```bash
npm install
```

### Build the Demo Extractor

Demos are parsed by a separate executable written in Rust (`extractor/`). A
Windows build is checked in at `bin/win/parser.exe`, so this step is only
needed after changing the extractor or on another platform:

```bash
npm run build:parser
```

This runs `cargo build --release` and copies the binary to
`bin/<platform>/parser` (`bin/win/parser.exe` on Windows), which is where the
app looks for it in development. To use a binary somewhere else, set the
`PARSER_PATH` environment variable:

```bash
export PARSER_PATH=/path/to/parser
```

See `extractor/README.md` for how the extractor is organised and how to check
its output against the previous Go parser.

### Run Development Server

```bash
npm run dev
```

This will:
- Start Vite dev server on port 5173
- Launch Electron with hot reload

## Building

### Build for Development

```bash
npm run build
```

This builds both the renderer (Vite) and main process (TypeScript).

### Package for Distribution

```bash
# Package for current platform
npm run package

# Package for specific platform
npm run package:win
npm run package:mac
npm run package:linux
```

**Note:** If you encounter code signing errors on Windows:

1. **Code signing is disabled** via environment variable (`CSC_IDENTITY_AUTO_DISCOVERY=false`) to avoid permission issues
2. **If you still get signing errors**, clear the cache:
   ```bash
   npm run clear-cache
   ```
   Or manually delete: `%LOCALAPPDATA%\electron-builder\Cache`

3. **For production builds**, you can enable code signing by:
   - Removing the `CSC_IDENTITY_AUTO_DISCOVERY=false` from package scripts
   - Setting up proper code signing certificates
   - Or setting environment variables for signing credentials

## Packaging the Demo Extractor

`electron-builder` copies the `bin/` directory into the packaged app, so the
extractor binary for the target platform has to be in `bin/<platform>/` before
packaging. The release workflow does this with `npm run build:parser` on each
platform's runner.

## Features

### Current

- ✅ Select demo file via file dialog
- ✅ Parse demo with progress tracking
- ✅ Real-time log console
- ✅ Progress bar with stage/round/tick info
- ✅ Match browsing and viewing
- ✅ Player score visualization
- ✅ Event filtering and search
- ✅ Chat log viewing with player filtering
- ✅ CS2 demo viewer integration
- ✅ Database integrity checks
- ✅ Match cap management
- ✅ DB Viewer for diagnostics

## Storage & Cleanup

### Database Structure

Each parsed match is stored as a separate SQLite database file in `app.getPath("userData")/matches/`. The database contains:

- **meta table**: Stores metadata including `demo_path`, `demo_sha1` (optional), and `created_at_iso`
- **matches table**: Match information (id, map, tick_rate, started_at)
- **players table**: Player information
- **rounds table**: Round data
- **events table**: Detected griefing events
- **player_scores table**: Calculated grief scores
- **chat_messages table**: Chat logs with player names and teams

### Startup Integrity Check

On app startup, the application automatically:

1. Scans all SQLite files in the matches folder
2. For each database:
   - Reads `demo_path` from the `meta` table
   - Checks if the demo file exists on disk
   - If the demo is missing or the database is corrupt, it's marked as "orphan"
3. Based on settings:
   - **Auto cleanup ON (default)**: Orphan databases are automatically deleted
   - **Auto cleanup OFF**: Orphan matches are marked as "Missing demo" in the UI

### Match Cap

You can limit the number of stored matches to prevent unlimited storage growth:

1. Enable "Begränsa antal sparade matcher" in Settings
2. Set the maximum number of matches (default: 10)
3. When a new match is parsed:
   - The app lists all matches sorted by `created_at_iso` (oldest first)
   - If count > N, the oldest matches are deleted until count == N
4. When you change the cap to a lower value, matches are trimmed immediately

### Clear All Matches

In Settings → Danger Zone, you can delete all stored matches:

1. Click "Ta bort alla matcher"
2. Confirm the action (this cannot be undone)
3. All SQLite files in the matches folder are deleted

## DB Viewer

The DB Viewer provides direct access to match databases for diagnostics and inspection:

### Features

- **Table List**: View all tables in a selected match database
- **Table Info**: See schema (CREATE TABLE) and row count for each table
- **Query Runner**: Execute read-only SQL queries (SELECT and PRAGMA table_info only)

### Security

- Only SELECT and PRAGMA table_info queries are allowed
- INSERT, UPDATE, DELETE, DROP, and other write operations are blocked
- LIMIT 200 is automatically added to SELECT queries if not specified

### Usage

1. Navigate to "DB Viewer" in the sidebar
2. Select a match from the dropdown
3. Click on a table to view its schema and row count
4. Use the query runner to execute custom SELECT queries

**Example queries:**
```sql
SELECT * FROM matches LIMIT 10
SELECT COUNT(*) FROM events WHERE type = 'team_kill'
PRAGMA table_info(players)
```

## IPC Communication

The app uses strongly-typed IPC between renderer and main process:

**Renderer → Main:**
- `dialog:openFile` - Open file dialog
- `parser:parse` - Start parsing demo
- `parser:stop` - Stop parser

**Main → Renderer:**
- `parser:message` - NDJSON messages from parser
- `parser:log` - Stderr log lines
- `parser:exit` - Parser process exit
- `parser:error` - Parser errors

## Styling

The app uses a dark theme with the following colors:

- **Primary**: `#1e2124` - Main background
- **Secondary**: `#282b30` - Sidebar background
- **Surface**: `#36393e` - Card/panel background
- **Border**: `#424549` - Border color
- **Accent**: `#d07a2d` - Buttons, progress, highlights

## Troubleshooting

### Parser Not Found

If you see "Parser not found" error:

1. Check that the parser binary exists at the expected path
2. For dev: Ensure the binary is at `bin/<platform>/parser` (`bin/win/parser.exe` on Windows); `npm run build:parser` puts it there. Or set `PARSER_PATH`
3. For prod: Ensure the binary is in `bin/<platform>/` before packaging

### Parser Crashes / Panic Errors

If you see "parser crashed" or panic errors:

1. **Try a different demo file** - The demo may be corrupted or incomplete
2. **Verify demo format** - Ensure it's a CS2 demo (`.dem`), not CS:GO
3. **Check demo file size** - Very small files (< 1MB) may be incomplete
4. **Re-download the demo** - The file may have been corrupted during download
5. **Check demoinfocs version** - Consider updating if a newer version is available

**Note:** Some demo files may be incompatible with demoinfocs v4.0.0. If crashes persist with multiple valid CS2 demos, consider checking the demoinfocs GitHub repository for known issues.

### Build Errors

- Ensure all dependencies are installed: `npm install`
- Clear build cache: Delete `dist/` and `dist-electron/` folders
- Rebuild: `npm run build`

## License

MIT
