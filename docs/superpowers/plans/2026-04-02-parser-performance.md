# Parser Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce database-mode demo parse time from ~25s to as fast as possible via SQLite tuning, hot-path fixes, and parallel post-parse processing.

**Architecture:** Three independent improvement areas applied in sequence: (1) SQLite WAL + pragmas for dramatically faster writes, (2) targeted code fixes removing wasted work in hot paths and post-parse, (3) concurrent AFK + BodyBlock detection with bulk DB queries instead of per-player round-trips.

**Tech Stack:** Go, `modernc.org/sqlite` (pure-Go SQLite driver), `database/sql`, `sync.WaitGroup`

**Spec:** `docs/superpowers/specs/2026-04-02-parser-performance-design.md`

---

## File Map

| File | Changes |
|------|---------|
| `internal/db/conn.go` | Add WAL pragmas + `SetMaxOpenConns(1)` |
| `internal/db/writer.go` | Remove per-batch player check in `InsertPlayerPositions`; add `BatchInsertRounds` |
| `internal/parser/parser.go` | Remove `runtime.GC()` calls; add steamID string cache in `FrameDone` |
| `cmd/parser/main.go` | Remove `runtime.GC()` calls; use `BatchInsertRounds`; batch event inserts; parallel AFK+BodyBlock |
| `internal/parser/extractors/afk.go` | Hoist disconnect query to once per match; replace per-player position queries with one bulk query per round |
| `internal/db/conn_test.go` | New: verify WAL mode is set after Open |
| `internal/db/writer_test.go` | New: test BatchInsertRounds |

---

## Task 1: SQLite WAL Pragmas + MaxOpenConns

**Files:**
- Modify: `internal/db/conn.go`
- Create: `internal/db/conn_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/db/conn_test.go`:

```go
package db

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenEnablesWAL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")

	ctx := context.Background()
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()
	defer os.Remove(path)

	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("failed to query journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Errorf("expected journal_mode=wal, got %q", mode)
	}

	var sync string
	if err := db.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&sync); err != nil {
		t.Fatalf("failed to query synchronous: %v", err)
	}
	// synchronous=NORMAL returns "1"
	if sync != "1" {
		t.Errorf("expected synchronous=1 (NORMAL), got %q", sync)
	}
}

func TestOpenMaxOneConnection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")

	ctx := context.Background()
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()

	stats := db.Stats()
	if stats.MaxOpenConnections != 1 {
		t.Errorf("expected MaxOpenConnections=1, got %d", stats.MaxOpenConnections)
	}
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go test ./internal/db/... -run "TestOpenEnablesWAL|TestOpenMaxOneConnection" -v
```

Expected: FAIL — journal_mode is `delete`, not `wal`.

- [ ] **Step 3: Add WAL pragmas and MaxOpenConns to `conn.go`**

Read `internal/db/conn.go` first, then replace the `Open` function body with:

```go
func Open(ctx context.Context, path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// SQLite is single-writer — one connection avoids lock contention
	db.SetMaxOpenConns(1)

	// Enable foreign keys
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Performance pragmas
	pragmas := []string{
		"PRAGMA journal_mode = WAL",          // write-ahead log — biggest write speedup
		"PRAGMA synchronous = NORMAL",        // fsync only on WAL checkpoint, not every commit
		"PRAGMA cache_size = -65536",         // 64MB in-memory page cache
		"PRAGMA temp_store = MEMORY",         // temp tables in RAM
		"PRAGMA mmap_size = 268435456",       // 256MB memory-mapped I/O
	}
	for _, pragma := range pragmas {
		if _, err := db.ExecContext(ctx, pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("failed to set pragma (%s): %w", pragma, err)
		}
	}

	// Initialize schema
	if err := InitSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go test ./internal/db/... -run "TestOpenEnablesWAL|TestOpenMaxOneConnection" -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add internal/db/conn.go internal/db/conn_test.go && git commit -m "perf: enable SQLite WAL mode and performance pragmas"
```

---

## Task 2: Remove Redundant Player Check + Add BatchInsertRounds

**Files:**
- Modify: `internal/db/writer.go`
- Create: `internal/db/writer_test.go`

- [ ] **Step 1: Write failing test for BatchInsertRounds**

Create `internal/db/writer_test.go`:

```go
package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func setupTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	ctx := context.Background()
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("failed to open test DB: %v", err)
	}
	return db, func() { db.Close() }
}

func TestBatchInsertRounds(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()

	ctx := context.Background()
	w := NewWriter(db)

	// Insert a match first (foreign key requirement)
	if err := w.InsertMatch(ctx, Match{ID: "m1", Map: "de_dust2", TickRate: 64}); err != nil {
		t.Fatalf("InsertMatch: %v", err)
	}

	winner := "T"
	freezeEnd := 500
	rounds := []Round{
		{MatchID: "m1", RoundIndex: 0, StartTick: 100, FreezeEndTick: &freezeEnd, EndTick: 2000, TWins: 0, CTWins: 0, Winner: &winner},
		{MatchID: "m1", RoundIndex: 1, StartTick: 2100, FreezeEndTick: nil, EndTick: 4000, TWins: 1, CTWins: 0, Winner: nil},
	}

	if err := w.BatchInsertRounds(ctx, rounds); err != nil {
		t.Fatalf("BatchInsertRounds failed: %v", err)
	}

	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM rounds WHERE match_id = 'm1'").Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 rounds, got %d", count)
	}
}
```

Note: you'll need to add `"database/sql"` to the import block of `writer_test.go`.

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go test ./internal/db/... -run "TestBatchInsertRounds" -v
```

Expected: FAIL — `BatchInsertRounds` does not exist yet.

- [ ] **Step 3: Remove redundant player pre-check in InsertPlayerPositions**

In `internal/db/writer.go`, find and delete the block from line ~303 to ~341 (the `playerSet`/`playerKeys` block that inserts players before positions). The function after this removal should go directly from checking `len(positions) == 0` to beginning the transaction and preparing the position insert statement.

The result should look like:

```go
func (w *Writer) InsertPlayerPositions(ctx context.Context, positions []PlayerPosition) error {
	if len(positions) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT OR REPLACE INTO player_positions (
			match_id, round_index, tick, steamid, x, y, z, yaw, view_dir_x, view_dir_y, team, health, armor, weapon
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, pos := range positions {
		_, err := stmt.ExecContext(ctx,
			pos.MatchID, pos.RoundIndex, pos.Tick, pos.SteamID,
			pos.X, pos.Y, pos.Z,
			pos.Yaw, pos.ViewDirX, pos.ViewDirY,
			pos.Team, pos.Health, pos.Armor, pos.Weapon,
		)
		if err != nil {
			return fmt.Errorf("failed to insert player position: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Add BatchInsertRounds to writer.go**

Add this method after `InsertRound` in `internal/db/writer.go`:

```go
// BatchInsertRounds inserts multiple rounds in a single transaction.
func (w *Writer) BatchInsertRounds(ctx context.Context, rounds []Round) error {
	if len(rounds) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT OR REPLACE INTO rounds (match_id, round_index, start_tick, freeze_end_tick, end_tick, t_wins, ct_wins, winner)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("failed to prepare round statement: %w", err)
	}
	defer stmt.Close()

	for _, r := range rounds {
		if _, err := stmt.ExecContext(ctx, r.MatchID, r.RoundIndex, r.StartTick, r.FreezeEndTick, r.EndTick, r.TWins, r.CTWins, r.Winner); err != nil {
			return fmt.Errorf("failed to insert round %d: %w", r.RoundIndex, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	return nil
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go test ./internal/db/... -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add internal/db/writer.go internal/db/writer_test.go && git commit -m "perf: remove redundant player pre-check in InsertPlayerPositions; add BatchInsertRounds"
```

---

## Task 3: Remove Manual runtime.GC() Calls

**Files:**
- Modify: `internal/parser/parser.go`
- Modify: `cmd/parser/main.go`

No new tests needed — this is a removal of incorrect optimization. Build must compile cleanly.

- [ ] **Step 1: Remove GC calls from parser.go**

In `internal/parser/parser.go`, find and delete every occurrence of `runtime.GC()`. There are two:
1. Inside the `flushBuffers` closure (after flushing inferno positions, ~line 335)
2. After `afkExtractor.ClearEvents()` at round end in JSON mode (~line 906)

Also remove the `"runtime"` import if it's no longer used after removing GC calls. Check whether `runtime.GC()` or any other `runtime.*` call remains — if none remain, remove the `"runtime"` import line.

- [ ] **Step 2: Remove GC calls from main.go**

In `cmd/parser/main.go`, find and delete every occurrence of `runtime.GC()`. These appear:
1. After `p.Close()` in `runJSON` (~line 218)
2. After chunk flush in the event processing loop in `runJSON` (~line 318)
3. After the final chunk write in `runJSON` (~line 334)
4. After `p.Close()` in `run` (~line 453)

Also remove the `"runtime"` import from `main.go` if no other `runtime.*` calls remain (check for `runtime.ReadMemStats` in `getMemoryUsage` — if that function still exists, keep the import).

- [ ] **Step 3: Build to confirm no compilation errors**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build ./...
```

Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add internal/parser/parser.go cmd/parser/main.go && git commit -m "perf: remove manual runtime.GC() calls — let Go GC manage itself"
```

---

## Task 4: Cache SteamID Strings in FrameDone Hot Path

**Files:**
- Modify: `internal/parser/parser.go`

- [ ] **Step 1: Add steamID cache map before the FrameDone handler**

In `internal/parser/parser.go`, find the line that declares `lastPositionTick` just before the `FrameDone` handler (~line 1605). Add the cache map declaration directly after it:

```go
lastPositionTick := 0
steamIDCache := make(map[uint64]string) // cache to avoid fmt.Sprintf on every tick
```

- [ ] **Step 2: Replace fmt.Sprintf calls inside the FrameDone handler**

Inside the `FrameDone` event handler, find every occurrence of:
```go
steamID := fmt.Sprintf("%d", player.SteamID64)
```

Replace each one with a cache lookup:
```go
steamID, ok := steamIDCache[player.SteamID64]
if !ok {
    steamID = fmt.Sprintf("%d", player.SteamID64)
    steamIDCache[player.SteamID64] = steamID
}
```

There are two occurrences inside the FrameDone handler — one in the player position loop and potentially one in the grenade thrower section. Apply the replacement to all of them within the FrameDone closure.

- [ ] **Step 3: Build to confirm no compilation errors**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build ./...
```

Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add internal/parser/parser.go && git commit -m "perf: cache steamID string formatting in FrameDone hot path"
```

---

## Task 5: Batch Round and Event Inserts in main.go

**Files:**
- Modify: `cmd/parser/main.go`

- [ ] **Step 1: Replace one-at-a-time round inserts with BatchInsertRounds**

In `cmd/parser/main.go`, the `run` function has two places where rounds are stored one-at-a-time in a `for` loop calling `writer.InsertRound(ctx, round)` — one in the RAM-only path (~line 507) and one in the streaming path (~line 801).

Replace each loop with a batch approach. For the streaming path, replace:

```go
// Store rounds
output.Log("info", fmt.Sprintf("Storing %d rounds...", len(matchData.Rounds)))
for _, roundData := range matchData.Rounds {
    round := db.Round{
        MatchID:       actualMatchID,
        RoundIndex:    roundData.RoundIndex,
        StartTick:     roundData.StartTick,
        FreezeEndTick: roundData.FreezeEndTick,
        EndTick:       roundData.EndTick,
        TWins:         roundData.TWins,
        CTWins:        roundData.CTWins,
        Winner:        roundData.Winner,
    }
    if err := writer.InsertRound(ctx, round); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to insert round %d: %v", roundData.RoundIndex, err))
    }
}
```

With:

```go
// Store rounds
output.Log("info", fmt.Sprintf("Storing %d rounds...", len(matchData.Rounds)))
dbRounds := make([]db.Round, 0, len(matchData.Rounds))
for _, roundData := range matchData.Rounds {
    dbRounds = append(dbRounds, db.Round{
        MatchID:       actualMatchID,
        RoundIndex:    roundData.RoundIndex,
        StartTick:     roundData.StartTick,
        FreezeEndTick: roundData.FreezeEndTick,
        EndTick:       roundData.EndTick,
        TWins:         roundData.TWins,
        CTWins:        roundData.CTWins,
        Winner:        roundData.Winner,
    })
}
if err := writer.BatchInsertRounds(ctx, dbRounds); err != nil {
    output.Log("warn", fmt.Sprintf("Failed to batch insert rounds: %v", err))
}
```

Apply the same replacement in the RAM-only path.

- [ ] **Step 2: Replace one-at-a-time event inserts with BatchInsertEvents**

In `cmd/parser/main.go`, both the RAM-only path (~line 526) and streaming path (~line 820) have loops that call `writer.InsertEvent(ctx, event)` one-at-a-time. Replace each with a collect-then-batch approach.

For the streaming path, replace:

```go
// Store events
output.Log("info", fmt.Sprintf("Storing %d events...", len(matchData.Events)))
eventCount := 0
for _, eventData := range matchData.Events {
    event := db.Event{
        MatchID:       actualMatchID,
        RoundIndex:    eventData.RoundIndex,
        Type:          eventData.Type,
        StartTick:     eventData.StartTick,
        EndTick:       eventData.EndTick,
        ActorSteamID:  eventData.ActorSteamID,
        VictimSteamID: eventData.VictimSteamID,
        Severity:      &eventData.Severity,
        Confidence:    &eventData.Confidence,
        MetaJSON:      eventData.MetaJSON,
    }
    if err := writer.InsertEvent(ctx, event); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to insert event %s: %v", eventData.Type, err))
    } else {
        eventCount++
        if eventCount%10 == 0 {
            output.Log("info", fmt.Sprintf("Inserted %d events...", eventCount))
        }
    }
}
output.Log("info", fmt.Sprintf("Stored %d events", eventCount))
```

With:

```go
// Store events
output.Log("info", fmt.Sprintf("Storing %d events...", len(matchData.Events)))
dbEvents := make([]db.Event, 0, len(matchData.Events))
for _, eventData := range matchData.Events {
    dbEvents = append(dbEvents, db.Event{
        MatchID:       actualMatchID,
        RoundIndex:    eventData.RoundIndex,
        Type:          eventData.Type,
        StartTick:     eventData.StartTick,
        EndTick:       eventData.EndTick,
        ActorSteamID:  eventData.ActorSteamID,
        VictimSteamID: eventData.VictimSteamID,
        Severity:      &eventData.Severity,
        Confidence:    &eventData.Confidence,
        MetaJSON:      eventData.MetaJSON,
    })
}
if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
    output.Log("warn", fmt.Sprintf("Failed to batch insert events: %v", err))
} else {
    output.Log("info", fmt.Sprintf("Stored %d events", len(dbEvents)))
}
```

Apply the same replacement in the RAM-only path.

- [ ] **Step 3: Build to confirm no compilation errors**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build ./...
```

Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add cmd/parser/main.go && git commit -m "perf: batch round and event inserts instead of one-at-a-time"
```

---

## Task 6: AFK Bulk Query Restructure

**Files:**
- Modify: `internal/parser/extractors/afk.go`

The current `ProcessAFKFromDatabase` does:
1. One disconnect query per call (queries ALL match disconnects — repeated N times for N rounds)
2. One death query per round — fine
3. One distinct-players query per round — fine
4. **Per player:** one point-in-time position query at freeze end + one fallback query — this is the N×P bottleneck
5. One bulk positions query per round — already good

We fix points 1 and 4.

- [ ] **Step 1: Add LoadDisconnectEvents method to AFKExtractor**

In `internal/parser/extractors/afk.go`, add a field to `AFKExtractor` to cache disconnect intervals, and add a method to load them once per match. Find the struct definition and add the field:

```go
type AFKExtractor struct {
    // ... existing fields ...
    disconnectIntervals map[string][]struct{ start, end int } // cached per-match
    disconnectsLoaded   bool
}
```

Then add the method after `NewAFKExtractor`:

```go
// LoadDisconnectEvents pre-loads all disconnect events for a match into memory.
// Call this once before processing rounds to avoid repeated queries.
func (e *AFKExtractor) LoadDisconnectEvents(matchID string) error {
    if e.db == nil || e.disconnectsLoaded {
        return nil
    }
    e.disconnectIntervals = make(map[string][]struct{ start, end int })
    e.disconnectsLoaded = true

    query := `
        SELECT actor_steamid, start_tick, end_tick, round_index
        FROM events
        WHERE match_id = ? AND type = 'DISCONNECT' AND actor_steamid IS NOT NULL
        ORDER BY start_tick
    `
    rows, err := e.db.Query(query, matchID)
    if err != nil {
        return nil // silently skip — no disconnect data
    }
    defer rows.Close()

    for rows.Next() {
        var steamID string
        var startTick, roundIndex int
        var endTick sql.NullInt64
        if err := rows.Scan(&steamID, &startTick, &endTick, &roundIndex); err != nil {
            continue
        }
        // We store intervals keyed by steamID; callers filter by round
        e.disconnectIntervals[steamID] = append(e.disconnectIntervals[steamID], struct{ start, end int }{
            start: startTick,
            end:   func() int {
                if endTick.Valid {
                    return int(endTick.Int64)
                }
                return math.MaxInt32 // still disconnected
            }(),
        })
    }
    return nil
}
```

- [ ] **Step 2: Replace disconnect query inside ProcessAFKFromDatabase with cached data**

In `ProcessAFKFromDatabase`, find the block that runs `disconnectQuery` and builds `disconnectIntervals` (roughly lines 341-378). Replace it with a reference to the cached data:

```go
// Use pre-loaded disconnect intervals (loaded once per match via LoadDisconnectEvents)
// Fall back to empty map if not loaded (e.g. in tests)
disconnectIntervals := e.disconnectIntervals
if disconnectIntervals == nil {
    disconnectIntervals = make(map[string][]struct{ start, end int })
}
```

Remove the `disconnectQuery`, `disconnectRows`, and all the rows-scanning code that populated the old local `disconnectIntervals`. The `isPlayerDisconnectedOrDead` helper that uses `disconnectIntervals` remains unchanged.

- [ ] **Step 3: Replace per-player position queries with one bulk initial-position query**

In `ProcessAFKFromDatabase`, after the distinct-players query loop that populates `playerStates`, there is a per-player block that runs:
- `queryPos` — exact position at freeze end
- `queryFirst` fallback — first position >= freeze end

Replace this entire per-player query section with a single bulk query that gets the first position at or after freeze end for all players at once:

```go
// Bulk query: first position at or after freezeEndTick for all players in this round
initPosQuery := `
    SELECT p.steamid, p.tick, p.x, p.y, p.z
    FROM player_positions p
    INNER JOIN (
        SELECT steamid, MIN(tick) AS min_tick
        FROM player_positions
        WHERE match_id = ? AND round_index = ? AND tick >= ?
        GROUP BY steamid
    ) first ON p.steamid = first.steamid AND p.tick = first.min_tick
    WHERE p.match_id = ? AND p.round_index = ?
`
initRows, err := e.db.Query(initPosQuery, matchID, roundIndex, freezeEndTick, matchID, roundIndex)
if err != nil {
    return fmt.Errorf("failed to query initial positions: %w", err)
}
defer initRows.Close()

playerStates := make(map[string]*afkPlayerState)
for initRows.Next() {
    var steamID string
    var tick int
    var x, y, z float64
    if err := initRows.Scan(&steamID, &tick, &x, &y, &z); err != nil {
        continue
    }
    if isPlayerDisconnectedOrDead(steamID, freezeEndTick) {
        continue
    }
    playerStates[steamID] = &afkPlayerState{
        steamID:          steamID,
        lastPosition:     &position{X: x, Y: y, Z: z},
        lastPositionTick: tick,
    }
}
initRows.Close()
```

Remove the old `SELECT DISTINCT steamid` query and its loop, and the per-player `queryPos` / `queryFirst` block entirely. The bulk positions query (`posQuery`) that follows and processes positions tick-by-tick remains unchanged.

- [ ] **Step 4: Update callers in main.go to call LoadDisconnectEvents once**

In `cmd/parser/main.go`, find both places that create an `AFKExtractor` and call `ProcessAFKFromDatabase` in a round loop (streaming path ~line 998, and RAM-only path ~line 624). In each place, add a `LoadDisconnectEvents` call before the round loop:

```go
afkExtractor := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
if err := afkExtractor.LoadDisconnectEvents(actualMatchID); err != nil {
    output.Log("warn", fmt.Sprintf("Failed to load disconnect events: %v", err))
}
for _, roundData := range matchData.Rounds {
    // ... existing ProcessAFKFromDatabase call ...
}
```

- [ ] **Step 5: Build to confirm no compilation errors**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build ./...
```

Expected: builds with no errors.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add internal/parser/extractors/afk.go cmd/parser/main.go && git commit -m "perf: replace per-player AFK position queries with bulk queries; hoist disconnect query"
```

---

## Task 7: Parallel AFK + BodyBlock Post-Parse

**Files:**
- Modify: `cmd/parser/main.go`

AFK and BodyBlock both only read from `player_positions`. Under WAL mode (enabled in Task 1), concurrent reads are safe. We run them as two goroutines and write results after both finish.

- [ ] **Step 1: Refactor streaming-mode post-parse into parallel goroutines**

In `cmd/parser/main.go`, in the `run` function's streaming-mode branch (the `} else {` block after RAM-only mode), find the sequential AFK and BodyBlock sections. Replace them with:

```go
// Run AFK and BodyBlock detection concurrently — both are read-only on player_positions
var wg sync.WaitGroup
var afkEvents, bodyBlockEvents []extractors.Event
var afkErr, bodyBlockErr error

wg.Add(2)

go func() {
    defer wg.Done()
    ext := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
    if err := ext.LoadDisconnectEvents(actualMatchID); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to load disconnect events for AFK: %v", err))
    }
    for _, roundData := range matchData.Rounds {
        if roundData.FreezeEndTick == nil {
            continue
        }
        if err := ext.ProcessAFKFromDatabase(actualMatchID, roundData.RoundIndex, *roundData.FreezeEndTick, roundData.EndTick); err != nil {
            output.Log("warn", fmt.Sprintf("AFK round %d: %v", roundData.RoundIndex, err))
        }
    }
    afkEvents = ext.GetEvents()
}()

go func() {
    defer wg.Done()
    ext := extractors.NewBodyBlockExtractor(matchData.TickRate, dbConn)
    for _, roundData := range matchData.Rounds {
        ext.ProcessRoundFromDatabase(actualMatchID, roundData.RoundIndex, roundData.StartTick, roundData.EndTick)
    }
    bodyBlockEvents = ext.GetEvents()
}()

wg.Wait()

// Write AFK events
if len(afkEvents) > 0 {
    output.Log("info", fmt.Sprintf("Found %d AFK events", len(afkEvents)))
    dbAFKEvents := make([]db.Event, 0, len(afkEvents))
    for _, e := range afkEvents {
        dbAFKEvents = append(dbAFKEvents, db.Event{
            MatchID:       actualMatchID,
            RoundIndex:    e.RoundIndex,
            Type:          e.Type,
            StartTick:     e.StartTick,
            EndTick:       e.EndTick,
            ActorSteamID:  e.ActorSteamID,
            VictimSteamID: e.VictimSteamID,
            Severity:      &e.Severity,
            Confidence:    &e.Confidence,
            MetaJSON:      e.MetaJSON,
        })
    }
    if err := writer.BatchInsertEvents(ctx, dbAFKEvents); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to batch insert AFK events: %v", err))
    } else {
        output.Log("info", fmt.Sprintf("Stored %d AFK events", len(afkEvents)))
    }
}

// Write BodyBlock events
if len(bodyBlockEvents) > 0 {
    output.Log("info", fmt.Sprintf("Found %d body blocking events", len(bodyBlockEvents)))
    dbBodyEvents := make([]db.Event, 0, len(bodyBlockEvents))
    for _, e := range bodyBlockEvents {
        dbBodyEvents = append(dbBodyEvents, db.Event{
            MatchID:       actualMatchID,
            RoundIndex:    e.RoundIndex,
            Type:          e.Type,
            StartTick:     e.StartTick,
            EndTick:       e.EndTick,
            ActorSteamID:  e.ActorSteamID,
            VictimSteamID: e.VictimSteamID,
            Severity:      &e.Severity,
            Confidence:    &e.Confidence,
            MetaJSON:      e.MetaJSON,
        })
    }
    if err := writer.BatchInsertEvents(ctx, dbBodyEvents); err != nil {
        output.Log("warn", fmt.Sprintf("Failed to batch insert body blocking events: %v", err))
    } else {
        output.Log("info", fmt.Sprintf("Stored %d body blocking events", len(bodyBlockEvents)))
    }
}
_ = afkErr
_ = bodyBlockErr
```

Make sure `"sync"` is imported in `main.go`. Add it to the import block if not already present.

- [ ] **Step 2: Build to confirm no compilation errors**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build ./...
```

Expected: builds with no errors.

- [ ] **Step 3: Run all tests**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go test ./...
```

Expected: all tests PASS.

- [ ] **Step 4: Build the parser binary**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && go build -o bin/parser.exe ./cmd/parser
```

Expected: `bin/parser.exe` created with no errors.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Filip\Downloads\cs-griefer-electron" && git add cmd/parser/main.go && git commit -m "perf: run AFK and BodyBlock detection concurrently after parsing"
```

---

## Verification

After all tasks complete, parse a real demo and compare times:

```bash
# Time a parse (replace path with a real .dem file)
Measure-Command { & ".\bin\parser.exe" --demo "path\to\demo.dem" --out "test_out.db" --match-id "test" --mode database }
```

Expected: parse time significantly lower than baseline ~25s.
