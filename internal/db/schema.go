package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Schema defines the SQLite database schema for storing CS2 demo data.
// Uses modernc.org/sqlite which is a pure Go SQLite driver with no CGO dependencies.
const schema = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
	id TEXT PRIMARY KEY,
	map TEXT NOT NULL,
	tick_rate REAL NOT NULL,
	started_at TEXT
);

CREATE TABLE IF NOT EXISTS players (
	match_id TEXT NOT NULL,
	steamid TEXT NOT NULL,
	name TEXT NOT NULL,
	team TEXT,
	connected_midgame INTEGER DEFAULT 0,
	permanent_disconnect INTEGER DEFAULT 0,
	first_connect_round INTEGER,
	disconnect_round INTEGER,
	PRIMARY KEY(match_id, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS rounds (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	start_tick INTEGER NOT NULL,
	freeze_end_tick INTEGER,
	end_tick INTEGER NOT NULL,
	t_wins INTEGER NOT NULL DEFAULT 0,
	ct_wins INTEGER NOT NULL DEFAULT 0,
	winner TEXT,
	PRIMARY KEY(match_id, round_index),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS events (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	type TEXT NOT NULL,
	start_tick INTEGER NOT NULL,
	end_tick INTEGER,
	actor_steamid TEXT,
	victim_steamid TEXT,
	severity REAL,
	confidence REAL,
	meta_json TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS player_scores (
	match_id TEXT NOT NULL,
	steamid TEXT NOT NULL,
	team_kills INTEGER NOT NULL DEFAULT 0,
	team_damage REAL NOT NULL DEFAULT 0,
	team_flash_seconds REAL NOT NULL DEFAULT 0,
	afk_seconds REAL NOT NULL DEFAULT 0,
	body_block_seconds REAL NOT NULL DEFAULT 0,
	grief_score REAL NOT NULL DEFAULT 0,
	PRIMARY KEY(match_id, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	name TEXT,
	team TEXT,
	message TEXT NOT NULL,
	is_team_chat INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY(match_id, tick, steamid, message),
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);

CREATE TABLE IF NOT EXISTS player_positions (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	yaw REAL,
	team TEXT,
	health INTEGER,
	armor INTEGER,
	weapon TEXT,
	PRIMARY KEY(match_id, round_index, tick, steamid),
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_rounds_match_round ON rounds(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_steamid);
CREATE INDEX IF NOT EXISTS idx_events_victim ON events(victim_steamid);
CREATE INDEX IF NOT EXISTS idx_events_start_tick ON events(start_tick);
CREATE INDEX IF NOT EXISTS idx_events_match_round ON events(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_player_scores_match ON player_scores(match_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_match ON chat_messages(match_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_steamid ON chat_messages(match_id, steamid);
CREATE INDEX IF NOT EXISTS idx_chat_messages_round ON chat_messages(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tick ON chat_messages(match_id, tick);
CREATE INDEX IF NOT EXISTS idx_player_positions_match_round ON player_positions(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_player_positions_tick ON player_positions(match_id, round_index, tick);

CREATE TABLE IF NOT EXISTS grenade_positions (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	projectile_id INTEGER NOT NULL,
	grenade_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	thrower_steamid TEXT,
	thrower_name TEXT,
	thrower_team TEXT,
	PRIMARY KEY(match_id, round_index, tick, projectile_id),
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS grenade_events (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	projectile_id INTEGER NOT NULL,
	grenade_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	thrower_steamid TEXT,
	thrower_name TEXT,
	thrower_team TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id)
);

CREATE INDEX IF NOT EXISTS idx_grenade_positions_match_round ON grenade_positions(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_grenade_positions_tick ON grenade_positions(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_grenade_events_match_round ON grenade_events(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_grenade_events_tick ON grenade_events(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_grenade_events_type ON grenade_events(event_type);

CREATE TABLE IF NOT EXISTS shots (
	match_id TEXT NOT NULL,
	round_index INTEGER NOT NULL,
	tick INTEGER NOT NULL,
	steamid TEXT NOT NULL,
	weapon_name TEXT NOT NULL,
	x REAL NOT NULL,
	y REAL NOT NULL,
	z REAL NOT NULL,
	yaw REAL NOT NULL,
	pitch REAL,
	team TEXT,
	FOREIGN KEY(match_id) REFERENCES matches(id),
	FOREIGN KEY(match_id, steamid) REFERENCES players(match_id, steamid)
);

CREATE INDEX IF NOT EXISTS idx_shots_match_round ON shots(match_id, round_index);
CREATE INDEX IF NOT EXISTS idx_shots_tick ON shots(match_id, round_index, tick);
CREATE INDEX IF NOT EXISTS idx_shots_steamid ON shots(match_id, steamid);
`

// runMigrations runs database migrations to add new columns to existing tables.
func runMigrations(ctx context.Context, db *sql.DB) error {
	// Check if players table has connected_midgame column
	var hasConnectedMidgame bool
	checkColumnQuery := `SELECT COUNT(*) FROM pragma_table_info('players') WHERE name = 'connected_midgame'`
	var count int
	if err := db.QueryRowContext(ctx, checkColumnQuery).Scan(&count); err == nil {
		hasConnectedMidgame = count > 0
	}
	
	if !hasConnectedMidgame {
		_, err := db.ExecContext(ctx, `ALTER TABLE players ADD COLUMN connected_midgame INTEGER DEFAULT 0`)
		if err != nil && !strings.Contains(err.Error(), "duplicate column") {
			// Ignore "duplicate column" errors, but log others
			fmt.Printf("WARN: Failed to add connected_midgame column: %v\n", err)
		}
	}
	
	// Check if players table has permanent_disconnect column
	var hasPermanentDisconnect bool
	checkColumnQuery2 := `SELECT COUNT(*) FROM pragma_table_info('players') WHERE name = 'permanent_disconnect'`
	var count2 int
	if err := db.QueryRowContext(ctx, checkColumnQuery2).Scan(&count2); err == nil {
		hasPermanentDisconnect = count2 > 0
	}
	
	if !hasPermanentDisconnect {
		_, err := db.ExecContext(ctx, `ALTER TABLE players ADD COLUMN permanent_disconnect INTEGER DEFAULT 0`)
		if err != nil && !strings.Contains(err.Error(), "duplicate column") {
			// Ignore "duplicate column" errors, but log others
			fmt.Printf("WARN: Failed to add permanent_disconnect column: %v\n", err)
		}
	}
	
	// Check if players table has first_connect_round column
	var hasFirstConnectRound bool
	checkColumnQuery3 := `SELECT COUNT(*) FROM pragma_table_info('players') WHERE name = 'first_connect_round'`
	var count3 int
	if err := db.QueryRowContext(ctx, checkColumnQuery3).Scan(&count3); err == nil {
		hasFirstConnectRound = count3 > 0
	}
	
	if !hasFirstConnectRound {
		_, err := db.ExecContext(ctx, `ALTER TABLE players ADD COLUMN first_connect_round INTEGER`)
		if err != nil && !strings.Contains(err.Error(), "duplicate column") {
			// Ignore "duplicate column" errors, but log others
			fmt.Printf("WARN: Failed to add first_connect_round column: %v\n", err)
		}
	}
	
	// Check if players table has disconnect_round column
	var hasDisconnectRound bool
	checkColumnQuery4 := `SELECT COUNT(*) FROM pragma_table_info('players') WHERE name = 'disconnect_round'`
	var count4 int
	if err := db.QueryRowContext(ctx, checkColumnQuery4).Scan(&count4); err == nil {
		hasDisconnectRound = count4 > 0
	}
	
	if !hasDisconnectRound {
		_, err := db.ExecContext(ctx, `ALTER TABLE players ADD COLUMN disconnect_round INTEGER`)
		if err != nil && !strings.Contains(err.Error(), "duplicate column") {
			// Ignore "duplicate column" errors, but log others
			fmt.Printf("WARN: Failed to add disconnect_round column: %v\n", err)
		}
	}
	
	// Check if matches table has source column
	var hasSource bool
	checkColumnQuery5 := `SELECT COUNT(*) FROM pragma_table_info('matches') WHERE name = 'source'`
	var count5 int
	if err := db.QueryRowContext(ctx, checkColumnQuery5).Scan(&count5); err == nil {
		hasSource = count5 > 0
	}
	
	if !hasSource {
		_, err := db.ExecContext(ctx, `ALTER TABLE matches ADD COLUMN source TEXT`)
		if err != nil && !strings.Contains(err.Error(), "duplicate column") {
			// Ignore "duplicate column" errors, but log others
			fmt.Printf("WARN: Failed to add source column: %v\n", err)
		}
	}
	
	return nil
}

// InitSchema initializes the database schema.
// It creates all tables and indexes if they don't already exist.
func InitSchema(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("failed to initialize schema: %w", err)
	}
	
	// Run migrations for existing databases
	if err := runMigrations(ctx, db); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}
	
	return nil
}
