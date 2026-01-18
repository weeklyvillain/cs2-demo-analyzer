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

	// Enable foreign keys
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Initialize schema
	if err := InitSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}

