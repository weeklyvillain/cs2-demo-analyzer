package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Writer provides methods to write CS2 demo data to the database.
type Writer struct {
	db *sql.DB
}

// NewWriter creates a new database writer.
func NewWriter(db *sql.DB) *Writer {
	return &Writer{db: db}
}

// Match represents a CS2 match.
type Match struct {
	ID        string
	Map       string
	TickRate  float64
	StartedAt *time.Time
	Source    *string // Demo source (e.g., "faceit", "valve", "unknown")
}

// Player represents a player in a match.
type Player struct {
	MatchID            string
	SteamID            string
	Name               string
	Team               string // "A" or "B" (Team A/Team B)
	ConnectedMidgame   bool   // True if player connected after round 1
	PermanentDisconnect bool   // True if player disconnected and never returned
	FirstConnectRound  *int   // Round index when player first connected (nil if round 0)
	DisconnectRound    *int   // Round index when player disconnected (nil if never disconnected)
}

// Round represents a round in a match.
type Round struct {
	MatchID       string
	RoundIndex    int
	StartTick     int
	FreezeEndTick *int // Optional, may be estimated
	EndTick       int
	TWins         int
	CTWins        int
	Winner        *string // "T" or "CT"
}

// Event represents an event that occurred during a match.
type Event struct {
	MatchID       string
	RoundIndex    int
	Type          string
	StartTick     int
	EndTick       *int
	ActorSteamID  *string
	VictimSteamID *string
	Severity      *float64
	Confidence    *float64
	MetaJSON      *string // JSON string for additional metadata
}

// InsertMatch inserts or replaces a match record.
func (w *Writer) InsertMatch(ctx context.Context, m Match) error {
	query := `
		INSERT OR REPLACE INTO matches (id, map, tick_rate, started_at, source)
		VALUES (?, ?, ?, ?, ?)
	`
	var startedAt *string
	if m.StartedAt != nil {
		s := m.StartedAt.Format(time.RFC3339)
		startedAt = &s
	}
	_, err := w.db.ExecContext(ctx, query, m.ID, m.Map, m.TickRate, startedAt, m.Source)
	if err != nil {
		return fmt.Errorf("failed to insert match: %w", err)
	}
	return nil
}

// InsertPlayer inserts or replaces a player record.
func (w *Writer) InsertPlayer(ctx context.Context, p Player) error {
	connectedMidgame := 0
	if p.ConnectedMidgame {
		connectedMidgame = 1
	}
	permanentDisconnect := 0
	if p.PermanentDisconnect {
		permanentDisconnect = 1
	}
	
	query := `
		INSERT OR REPLACE INTO players (match_id, steamid, name, team, connected_midgame, permanent_disconnect, first_connect_round, disconnect_round)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := w.db.ExecContext(ctx, query, p.MatchID, p.SteamID, p.Name, p.Team, connectedMidgame, permanentDisconnect, p.FirstConnectRound, p.DisconnectRound)
	if err != nil {
		return fmt.Errorf("failed to insert player: %w", err)
	}
	return nil
}

// InsertRound inserts or replaces a round record.
func (w *Writer) InsertRound(ctx context.Context, r Round) error {
	query := `
		INSERT OR REPLACE INTO rounds (
			match_id, round_index, start_tick, freeze_end_tick, end_tick,
			t_wins, ct_wins, winner
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := w.db.ExecContext(ctx, query,
		r.MatchID, r.RoundIndex, r.StartTick, r.FreezeEndTick, r.EndTick,
		r.TWins, r.CTWins, r.Winner,
	)
	if err != nil {
		return fmt.Errorf("failed to insert round: %w", err)
	}
	return nil
}

// InsertEvent inserts an event record.
func (w *Writer) InsertEvent(ctx context.Context, e Event) error {
	query := `
		INSERT INTO events (
			match_id, round_index, type, start_tick, end_tick,
			actor_steamid, victim_steamid, severity, confidence, meta_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := w.db.ExecContext(ctx, query,
		e.MatchID, e.RoundIndex, e.Type, e.StartTick, e.EndTick,
		e.ActorSteamID, e.VictimSteamID, e.Severity, e.Confidence, e.MetaJSON,
	)
	if err != nil {
		return fmt.Errorf("failed to insert event: %w", err)
	}
	return nil
}

// SetMeta sets a metadata key-value pair.
func (w *Writer) SetMeta(ctx context.Context, key, value string) error {
	query := `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`
	_, err := w.db.ExecContext(ctx, query, key, value)
	if err != nil {
		return fmt.Errorf("failed to set meta: %w", err)
	}
	return nil
}

// BatchInsertEvents inserts multiple events in a single transaction.
func (w *Writer) BatchInsertEvents(ctx context.Context, events []Event) error {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT INTO events (
			match_id, round_index, type, start_tick, end_tick,
			actor_steamid, victim_steamid, severity, confidence, meta_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, e := range events {
		_, err := stmt.ExecContext(ctx,
			e.MatchID, e.RoundIndex, e.Type, e.StartTick, e.EndTick,
			e.ActorSteamID, e.VictimSteamID, e.Severity, e.Confidence, e.MetaJSON,
		)
		if err != nil {
			return fmt.Errorf("failed to insert event: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// InsertPlayerScore inserts or replaces a player score record.
func (w *Writer) InsertPlayerScore(ctx context.Context, score PlayerScore) error {
	query := `
		INSERT OR REPLACE INTO player_scores (
			match_id, steamid, team_kills, team_damage, team_flash_seconds,
			afk_seconds, body_block_seconds, grief_score
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := w.db.ExecContext(ctx, query,
		score.MatchID, score.SteamID, score.TeamKills, score.TeamDamage,
		score.TeamFlashSeconds, score.AFKSeconds, score.BodyBlockSeconds,
		score.GriefScore,
	)
	if err != nil {
		return fmt.Errorf("failed to insert player score: %w", err)
	}
	return nil
}

// ChatMessage represents a chat message in a match.
type ChatMessage struct {
	MatchID    string
	RoundIndex int
	Tick       int
	SteamID    string
	Name       *string // Optional player name
	Team       *string // Optional team ("T" or "CT")
	Message    string
	IsTeamChat bool
}

// InsertChatMessages inserts multiple chat messages in a transaction.
func (w *Writer) InsertChatMessages(ctx context.Context, messages []ChatMessage) error {
	if len(messages) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT OR IGNORE INTO chat_messages (
			match_id, round_index, tick, steamid, name, team, message, is_team_chat
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, msg := range messages {
		isTeamChat := 0
		if msg.IsTeamChat {
			isTeamChat = 1
		}
		_, err := stmt.ExecContext(ctx,
			msg.MatchID, msg.RoundIndex, msg.Tick, msg.SteamID, msg.Name, msg.Team, msg.Message, isTeamChat,
		)
		if err != nil {
			return fmt.Errorf("failed to insert chat message: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// PlayerPosition represents a player's position at a specific tick.
type PlayerPosition struct {
	MatchID    string
	RoundIndex int
	Tick       int
	SteamID    string
	X          float64
	Y          float64
	Z          float64
	Yaw        *float64 // View angle (yaw) in degrees
	Team       *string // "T" or "CT"
	Health     *int
	Armor      *int
	Weapon     *string
}

// InsertPlayerPositions inserts multiple player positions in a transaction.
// It ensures all players exist in the database before inserting positions to satisfy foreign key constraints.
func (w *Writer) InsertPlayerPositions(ctx context.Context, positions []PlayerPosition) error {
	if len(positions) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// First, ensure all players exist in the database
	// Collect unique (match_id, steamid) pairs
	playerSet := make(map[string]bool) // key: "match_id|steamid"
	playerKeys := make([]struct {
		MatchID string
		SteamID string
	}, 0)
	
	for _, pos := range positions {
		key := pos.MatchID + "|" + pos.SteamID
		if !playerSet[key] {
			playerSet[key] = true
			playerKeys = append(playerKeys, struct {
				MatchID string
				SteamID string
			}{pos.MatchID, pos.SteamID})
		}
	}

	// Insert missing players with default names
	// Use INSERT OR IGNORE to avoid errors if player already exists
	playerQuery := `
		INSERT OR IGNORE INTO players (match_id, steamid, name, team)
		VALUES (?, ?, ?, ?)
	`
	playerStmt, err := tx.PrepareContext(ctx, playerQuery)
	if err != nil {
		return fmt.Errorf("failed to prepare player statement: %w", err)
	}
	defer playerStmt.Close()

	for _, pk := range playerKeys {
		// Use default name if player doesn't exist
		defaultName := fmt.Sprintf("Player_%s", pk.SteamID)
		_, err := playerStmt.ExecContext(ctx, pk.MatchID, pk.SteamID, defaultName, nil)
		if err != nil {
			return fmt.Errorf("failed to ensure player exists %s/%s: %w", pk.MatchID, pk.SteamID, err)
		}
	}

	// Now insert positions
	query := `
		INSERT OR REPLACE INTO player_positions (
			match_id, round_index, tick, steamid, x, y, z, yaw, team, health, armor, weapon
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, pos := range positions {
		_, err := stmt.ExecContext(ctx,
			pos.MatchID, pos.RoundIndex, pos.Tick, pos.SteamID, pos.X, pos.Y, pos.Z, pos.Yaw, pos.Team,
			pos.Health, pos.Armor, pos.Weapon,
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

// GrenadePosition represents a grenade's position at a specific tick.
type GrenadePosition struct {
	MatchID        string
	RoundIndex     int
	Tick           int
	ProjectileID   uint64
	GrenadeName    string
	X              float64
	Y              float64
	Z              float64
	ThrowerSteamID *string
	ThrowerName    *string
	ThrowerTeam    *string
}

// GrenadeEvent represents a grenade event (explosion, smoke start, etc.)
type GrenadeEvent struct {
	MatchID        string
	RoundIndex     int
	Tick           int
	EventType      string
	ProjectileID   uint64
	GrenadeName    string
	X              float64
	Y              float64
	Z              float64
	ThrowerSteamID *string
	ThrowerName    *string
	ThrowerTeam    *string
}

// InsertGrenadePositions inserts multiple grenade positions in a transaction.
func (w *Writer) InsertGrenadePositions(ctx context.Context, positions []GrenadePosition) error {
	if len(positions) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT OR REPLACE INTO grenade_positions (
			match_id, round_index, tick, projectile_id, grenade_name,
			x, y, z, thrower_steamid, thrower_name, thrower_team
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, pos := range positions {
		_, err := stmt.ExecContext(ctx,
			pos.MatchID, pos.RoundIndex, pos.Tick, int64(pos.ProjectileID), pos.GrenadeName,
			pos.X, pos.Y, pos.Z, pos.ThrowerSteamID, pos.ThrowerName, pos.ThrowerTeam,
		)
		if err != nil {
			return fmt.Errorf("failed to insert grenade position: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// InsertGrenadeEvents inserts multiple grenade events in a transaction.
func (w *Writer) InsertGrenadeEvents(ctx context.Context, events []GrenadeEvent) error {
	if len(events) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT INTO grenade_events (
			match_id, round_index, tick, event_type, projectile_id, grenade_name,
			x, y, z, thrower_steamid, thrower_name, thrower_team
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, e := range events {
		_, err := stmt.ExecContext(ctx,
			e.MatchID, e.RoundIndex, e.Tick, e.EventType, int64(e.ProjectileID), e.GrenadeName,
			e.X, e.Y, e.Z, e.ThrowerSteamID, e.ThrowerName, e.ThrowerTeam,
		)
		if err != nil {
			return fmt.Errorf("failed to insert grenade event: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// MetaJSON creates a JSON string from a map for use in Event.MetaJSON.
func MetaJSON(m map[string]interface{}) (*string, error) {
	if m == nil || len(m) == 0 {
		return nil, nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal meta JSON: %w", err)
	}
	s := string(data)
	return &s, nil
}

// Shot represents a weapon fire event.
type Shot struct {
	MatchID    string
	RoundIndex int
	Tick       int
	SteamID    string
	WeaponName string
	X          float64
	Y          float64
	Z          float64
	Yaw        float64
	Pitch      *float64
	Team       *string
}

// InsertShots inserts multiple shots in a transaction.
func (w *Writer) InsertShots(ctx context.Context, shots []Shot) error {
	if len(shots) == 0 {
		return nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `
		INSERT INTO shots (
			match_id, round_index, tick, steamid, weapon_name,
			x, y, z, yaw, pitch, team
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, shot := range shots {
		_, err := stmt.ExecContext(ctx,
			shot.MatchID, shot.RoundIndex, shot.Tick, shot.SteamID, shot.WeaponName,
			shot.X, shot.Y, shot.Z, shot.Yaw, shot.Pitch, shot.Team,
		)
		if err != nil {
			return fmt.Errorf("failed to insert shot: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// InsertParserLogs inserts parser logs for a match.
func (w *Writer) InsertParserLogs(ctx context.Context, matchID string, logs string) error {
	query := `
		INSERT OR REPLACE INTO parser_logs (match_id, logs, created_at)
		VALUES (?, ?, ?)
	`
	_, err := w.db.ExecContext(ctx, query, matchID, logs, time.Now().Format(time.RFC3339))
	if err != nil {
		return fmt.Errorf("failed to insert parser logs: %w", err)
	}
	return nil
}
