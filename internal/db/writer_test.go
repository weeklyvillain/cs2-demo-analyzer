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
