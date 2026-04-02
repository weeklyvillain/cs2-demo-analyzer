# Parser Performance Optimization Design

**Date:** 2026-04-02  
**Goal:** Reduce database-mode demo parse time from ~25s to as fast as possible.  
**Scope:** Go parser binary only (`cmd/parser/`, `internal/parser/`, `internal/db/`). No changes to Electron/renderer.

---

## Problem

Database-mode parsing (~25s) is too slow. Root causes identified:

1. SQLite has no performance pragmas — every transaction fsyncs to disk (journal mode DELETE).
2. `InsertPlayerPositions` re-checks player existence on every batch (wasted queries).
3. `runtime.GC()` called manually after every buffer flush and every round — expensive.
4. SteamID string formatted via `fmt.Sprintf` every tick per player in the hot `FrameDone` handler.
5. Round and event inserts are one-at-a-time loops, not batched.
6. AFK and BodyBlock post-parse detection run serially with many small per-player DB queries per round.

---

## Design

### Section 1: SQLite Tuning (`internal/db/conn.go`)

Add performance pragmas immediately after opening the connection, before schema initialization:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -65536;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
```

- `journal_mode = WAL`: write-ahead logging eliminates per-transaction fsyncs, largest single speedup.
- `synchronous = NORMAL`: fsyncs only on WAL checkpoint, not every commit.
- `cache_size = -65536`: 64MB in-memory page cache.
- `temp_store = MEMORY`: temp tables in RAM instead of disk.
- `mmap_size = 268435456`: 256MB memory-mapped I/O for reads.

Also call `db.SetMaxOpenConns(1)` — SQLite is single-writer; multiple connections cause lock contention.

**Files changed:** `internal/db/conn.go`

---

### Section 2: Targeted Code Fixes

#### 2a. Remove redundant player check in `InsertPlayerPositions`

`writer.go:303-341` runs `INSERT OR IGNORE` for each unique player before every batch of 5000 positions. The parser already guarantees all players are inserted before positions. Delete this block.

**Files changed:** `internal/db/writer.go`

#### 2b. Strip all `runtime.GC()` calls

Manual GC calls in:
- `parser.go` — `flushBuffers` closure (after every buffer flush)
- `parser.go` — after every round in JSON mode
- `main.go` — after parsing completes

Remove all of them. Go's GC runs on its own schedule and manual calls add latency.

**Files changed:** `internal/parser/parser.go`, `cmd/parser/main.go`

#### 2c. Cache steamID strings in `FrameDone` hot path

`fmt.Sprintf("%d", player.SteamID64)` is called every tick per player (at `positionInterval` rate). Add a `map[uint64]string` (steamIDCache) populated on first encounter, reused on every subsequent tick.

**Files changed:** `internal/parser/parser.go`

#### 2d. Batch round inserts

Add `BatchInsertRounds(ctx context.Context, rounds []Round) error` to the writer. Wraps all round inserts in a single transaction. Replace the one-at-a-time loop in `main.go`.

**Files changed:** `internal/db/writer.go`, `cmd/parser/main.go`

#### 2e. Batch event inserts

Replace the one-at-a-time `InsertEvent` loop in `main.go` with the existing `BatchInsertEvents`. Collect all events into a slice first, then insert in one call.

**Files changed:** `cmd/parser/main.go`

---

### Section 3: Parallel Post-Parse Phase

#### 3a. Bulk position queries in AFK and BodyBlock

**AFK (`internal/parser/extractors/afk.go`):**  
Replace the per-player query pattern in `ProcessAFKFromDatabase` with a single query per round:

```sql
SELECT steamid, tick, x, y, z
FROM player_positions
WHERE match_id = ? AND round_index = ? AND tick >= ?
ORDER BY steamid, tick
```

Group rows by steamID in memory and run the existing AFK logic per player using the in-memory slice. This collapses N+1 queries per round into 1 query per round.

**BodyBlock (`internal/parser/extractors/body_block.go`):**  
Same restructure for `ProcessRoundFromDatabase` — one bulk position query per round, process all player pairs in memory.

**Files changed:** `internal/parser/extractors/afk.go`, `internal/parser/extractors/body_block.go`

#### 3b. Concurrent AFK and BodyBlock execution

After the bulk query restructure, run both detectors concurrently in `main.go`:

```go
var wg sync.WaitGroup
var afkEvents, bodyBlockEvents []extractors.Event
var afkErr, bodyBlockErr error

wg.Add(2)
go func() {
    defer wg.Done()
    afkExtractor := extractors.NewAFKExtractor(tickRate, dbConn)
    for _, round := range matchData.Rounds { ... }
    afkEvents = afkExtractor.GetEvents()
}()
go func() {
    defer wg.Done()
    bodyBlockExtractor := extractors.NewBodyBlockExtractor(tickRate, dbConn)
    for _, round := range matchData.Rounds { ... }
    bodyBlockEvents = bodyBlockExtractor.GetEvents()
}()
wg.Wait()

// check afkErr, bodyBlockErr
// BatchInsertEvents for both
```

Both goroutines only read from the DB (queries on `player_positions`), so concurrent reads are safe under WAL mode. Events are collected independently and written after `wg.Wait()`.

**Files changed:** `cmd/parser/main.go`

---

## Expected Impact

| Change | Estimated gain |
|--------|---------------|
| WAL + synchronous=NORMAL | ~40-50% off DB write time |
| Remove player pre-check per batch | ~5-10% off position insert time |
| Remove manual GC calls | ~5% off total |
| SteamID string cache | ~2-3% off FrameDone overhead |
| Batch round/event inserts | ~1-2% off post-parse |
| Bulk AFK/BodyBlock queries | ~30-40% off post-parse phase |
| Parallel AFK + BodyBlock | ~40-50% off post-parse phase |

Total: estimated 60-75% reduction in end-to-end parse time.

---

## Constraints

- No new npm or Go dependencies.
- Parser memory model (streaming to DB, no full accumulation) unchanged.
- All existing data written to DB (positions, grenades, shots, events, players, rounds) unchanged.
- AFK and BodyBlock correctness must be preserved — only query strategy changes, not detection logic.
