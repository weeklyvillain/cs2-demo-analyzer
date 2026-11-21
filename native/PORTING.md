# Native app (Rust + GPUI)

A full native rewrite of the Electron app, built on [GPUI](https://www.gpui.rs) via
[gpui-kit](https://gpui-kit.com) (`gpui-component`). The UI is Rust code with a
Tailwind-like styling API, rendered straight to the GPU. It has no webview and
no Node.

It reads the same data folder as the Electron app (`%APPDATA%/cs-griefer-electron`), so
both apps can run side by side until this one covers everything.

```powershell
cd native
cargo run --release
```

`CS2DA_DATA_DIR` points it at another data folder.

## Layout

| Crate | What it holds |
| --- | --- |
| `crates/core` (`cs2da-core`) | Data layer: paths, settings, match databases (rusqlite, read-only, no full-file loads). No UI. |
| `crates/app` (`cs2da`) | The GPUI app: `shell.rs` (title bar, sidebar, routing), one module per screen, `theme.rs` (palette from `tailwind.config.js`). |

The demo parser stays in `../extractor` for now. A later step turns it into a library
crate in this workspace and calls it in-process instead of spawning `parser.exe`.

## First measurements (release build, this machine, 23 matches / 1.3 GB)

| | Electron 1.0.72 | Native preview |
| --- | --- | --- |
| Time to first frame | 1.5–3 s of fixed splash/update delays, plus Chromium startup | ~0.26 s |
| Listing matches | Reads every `.sqlite` fully into sql.js (1.3 GB) | 15–22 ms |
| Opening a match summary | Reads the whole file again | ~3 ms |
| RAM after startup | Several Chromium processes | ~64 MB working set, one process |
| Binary | Electron + Chromium | 19 MB exe |

## Parser speed (extractor/)

- Database: the two per-tick tables are `WITHOUT ROWID` and four redundant indexes are gone. The write tail went 0.41 s → 0.10 s and match files are ~38% smaller (identical data).
- Parallel decoding (`vendor/source2-demo/src/parser/demo/parallel.rs`): worker threads pre-decode entity messages chunk by chunk (chunks start at full packets); the main thread applies them in order and re-checks each entity's class, falling back to decoding itself on any mismatch. `--threads 1` is the old sequential path.
- Parity: `extractor/parity/parallel_parity.py` compares every table, sequential vs parallel — identical on 44 demos so far.
- 361 MB demo: 2.05 s → 1.33 s end to end; peak memory is ~150–250 MB higher while parsing. Electron uses the same `bin/win/parser.exe`, so it gets the speedup too once that binary ships.

## Porting checklist

Electron sources are on `master` under `src/` (React) and `electron/` (main process).

- [x] Window chrome: custom title bar, sidebar navigation, theme
- [x] Match grid like `MatchListPanel`: map-art cards (`resources/maps`), gradient, map name, source logo (`resources/sources`), match ID, rounds, duration, Team A/B score, players; responsive columns; missing-demo badge
- [x] Match view with "Back to Matches": header (map art, date, rounds, duration, score, build)
- [x] Match grid sort defaults from Settings (`default_sort_field` / `default_sort_direction`)
- [x] Match grid search (id/map/source, "Showing x of y") and sort (date/id/duration/map, click again to flip)
- [x] Match card right-click menu: Open folder, Reparse, Show in DB Viewer (when enabled, jumps there with the match selected), Show Parser Logs (copy to clipboard), Select/Deselect, Delete
- [x] Multi-select: Ctrl+click, Ctrl+drag rubber band, selection bar (count, Deselect All, Delete Selected), Esc / Delete / Enter keys, delete confirmation
- Removed on purpose: the "Old Version" badge (and its Steam build lookup); my own "Demo missing" badge, which Electron doesn't have
- Note: the "{plural}" in match counts uses es/er per language (Electron used one ending for both, so it read "4 matcher" in English)
- [x] Overview like `MatchesOverviewTab`: 7 summary cards + AFK (sort, min duration, auto-lowered threshold), Disconnects (reasons, reconnects), Team kills, Team damage, Team flashes (min blind), Economy (money grid + details dialog with equipment), Body block; thresholds start from the Settings defaults
- [x] Watch in CS2 (`cs2da-core::cs2_launch`, `cs2_watch.rs`): header button, Overview / Rounds / player-window event buttons, Watch POV, copy commands, "Load different demo?" confirm; tested end to end with real CS2. Waits for CS2's console and confirms the demo loaded (Electron's fixed 3 s delay failed here)
- [x] Player window: View in 2D buttons (Electron tick rules: event start, Economy → round freeze end); Steam profile link for unnamed players on the Players tab
- [x] `--play-demo <file>` (Explorer "Play in CS2"): plays straight in CS2, also when handed to a running app
- [x] Players tab: Team A/B columns, CS colour dots, mid-game join / permanent leave markers, stats
- [x] Players tab actions: Player modal (event sections, economy details), Extract Voice per player (greyed out for silent players via `--list`), Team Voice; Watch POV shown disabled until CS2 launching lands
- [x] Rounds tab: collapsible round cards, winner/score/duration, grief events with time, actor → victim, damage
- [x] 2D viewer (`matches/viewer2d/`, `cs2da-core::replay`): radar (Flat/Original, floors Auto/Upper/Lower), players with view direction/health/name/weapon, deaths, trails, grenade paths, smokes with timers, fire polygons, blasts, grief markers, score bug, kill feed, side panels, zoom/pan/follow, play/pause (Space), speed, timeline with rounds and event markers; tab hidden when the map has no radar
- [x] "View in 2D" buttons on Rounds and Overview events (5 s lead-in, clamped to round start)
- Note: "View in 2D" switches to the 2D tab and seeks (Electron opens a separate single-round dialog)
- [x] Chat tab: player filter, copy one / copy all, disconnect reasons appended (`disconnectReason.ts` ported)
- [x] Voice (`cs2da-core::voice`, `voice/`): extraction with cs2-voice-extractor, playback with scrolling waveform, seek, ±skip (`voice_skip_time`), volume, speed, keyboard shortcuts, temp cleanup; Team Voice with synced per-player tracks, mute/volume, speaking status; stats tracked like Electron
- Skipped on purpose: transcription (whisper)
- Note: speed changes pitch (rodio), unlike HTML audio
- [x] Parsing (`cs2da-core::parser` + `parsing.rs`): runs the extractor with Electron's options (position interval), NDJSON progress/logs, queue with parallel parsing (`parallel_parsing_*`), parsing dialog (progress, console log, Run in background, Stop → Abort & Delete), sidebar progress ring with Open/Stop, parser logs stored in `parser_logs`, stats + map count, match cap after each parse
- [x] Add Demo button + drag-and-drop `.dem` onto the Matches screen; grid refreshes after each parse
- [x] Parsing runs in-process: the extractor is a library (`extractor/src/lib.rs`, `Reporter` trait for log/progress/cancel) that `cs2da-core::parser` calls on a background thread; Stop is a cancel flag. Output is identical to `parser.exe` (table-by-table check), speed is the same (361 MB demo 1.37 s vs 1.33 s), memory goes ~80 → 140 MB while parsing and back to ~90 MB. `parser.exe` is now a thin CLI over the same library with byte-identical output, so the Electron app keeps working.
- Settings removed from the native app: RAM-only parsing (the Rust extractor always streams), Transcription (skipped), auto-update on startup (returns with the native updater). The values stay in settings.sqlite, so the Electron app is unaffected.
- Trade-off: a parser crash that isn't a Rust panic (e.g. stack overflow) would now take the app down instead of just the parse.
- Note: confirming "Abort & Delete" after the parse already finished keeps the finished match (Electron deletes it).
- [x] Unparsed Demos page: scan watched folders, skip parsed demos, search, sort name/date/size + direction, select all / per row, Parse Selected, parse one, Show in folder, refresh after the queue finishes
- [x] Demo folder watcher (`watcher.rs`, `notify`, non-recursive, 2 s debounce like Electron): Unparsed Demos refreshes when a .dem appears or disappears; re-watches when the folders change in Settings
- [x] Startup integrity check: unreadable match DBs deleted, and with `auto_cleanup_missing_demos` (default on) matches whose demo is gone; locked files are skipped
- [x] Toasts (`toast.rs`, Electron `ToastStack`): "Demo parsed: …" / "Failed to parse: …" for every parse, info toast for "select demos first"
- Not needed: demo inbox / demo sync (the files are empty on master)
- [x] Stats screen (`stats.sqlite`, same update rules as `electron/stats.ts` in `cs2da-core::stats`, reset with confirm)
- [x] Settings screen: every Electron section on the same `settings.sqlite` keys; folder pickers, match cap trimming, delete-all with confirm, storage usage, live language switch
- [x] CS2 install detection (`cs2da-core::cs2`, ported from cs23d: registry → `libraryfolders.vdf` → default library folders); fills `cs2_path` at startup and via Settings → Detect
- [x] DB viewer: match/table browser, schema + row count, 100-row preview, query runner with Electron's SELECT/PRAGMA-only rule and auto `LIMIT 200`; sidebar entry only when `enable_db_viewer` is on
- [x] CS2 overlay in pure Rust (`overlay/`: `win32.rs` replaces the C++ window tracker via the `windows` crate; tracker, events list, incident panel, View offender/victim, debug command panel, global hotkeys with the recorder in Settings). Gated on Settings → Enable overlay like Electron; Watch in CS2 starts tracking and sends the match's incident; one shared command log for the debug panel. Tested against a stand-in window, not a live CS2 session.
- [x] CS2 console command sender (`cs2da-core::netcon`, Electron `CS2CommandSender`)
- [~] Translations: `translations.json` extracted from `translations.ts` (en + sv), `t()`/`tf()` in `i18n.rs`; ported screens use it. Language is stored in settings.sqlite `language` (Electron used localStorage). Language picker comes with Settings.
- [x] Single instance + `.dem` arguments (`instance.rs`): launching with .dem files parses them; a second launch hands its files to the running app over 127.0.0.1 and exits; `CS2DA_MULTI_INSTANCE=1` disables it for testing
- [x] Register the `.dem` file association and the "Play in CS2" shell verb (`installer/installer.nsi`)
- [x] "What's New" (`whats_new.rs`, `cs2da-core::releases`): GitHub release notes as Markdown, shown once after an update (`last_seen_version`), and from Settings → App info; same fallback text as Electron
- Note: raw HTML in release notes (e.g. embedded screenshots) isn't rendered
- [x] App logo in the sidebar and app icon/version info embedded in the exe (`build.rs`, `resources/icon.ico`)
- [x] Steam profile link for players without a name in chat
- Skipped on purpose: HLAE recording, clip export, transcription; splash screen (startup is fast enough not to need one)
- Installer: `installer/` (written, not yet built or tested). Still to do: release workflow, native auto-updater, "install specific version"
