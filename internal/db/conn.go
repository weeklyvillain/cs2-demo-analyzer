package db

import (
	"context"
	"database/sql"
	"fmt"
	_ "modernc.org/sqlite" // SQLite driver (pure Go, no CGO)
)

// Open opens a SQLite database connection and initializes the schema.
// The database file will be created if it doesn't exist.
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
		"PRAGMA journal_mode = WAL",    // write-ahead log — biggest write speedup
		"PRAGMA synchronous = NORMAL",  // fsync only on WAL checkpoint, not every commit
		"PRAGMA cache_size = -65536",   // 64MB in-memory page cache
		"PRAGMA temp_store = MEMORY",   // temp tables in RAM
		"PRAGMA mmap_size = 268435456", // 256MB memory-mapped I/O
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

