package db

import (
	"context"
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
