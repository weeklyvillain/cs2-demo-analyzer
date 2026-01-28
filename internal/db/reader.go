package db

import (
	"context"
	"database/sql"
	"fmt"
)

// Reader provides methods to read CS2 demo data from the database.
type Reader struct {
	db *sql.DB
}

// NewReader creates a new database reader.
func NewReader(db *sql.DB) *Reader {
	return &Reader{db: db}
}

// PlayerScore represents a player's griefing score.
type PlayerScore struct {
	MatchID          string
	SteamID          string
	TeamKills        int
	TeamDamage       float64
	TeamFlashSeconds float64
	AFKSeconds       float64
	BodyBlockSeconds float64
	GriefScore       float64
}

// MatchSummary represents a match summary with players and scores.
type MatchSummary struct {
	MatchID string
	Players []PlayerScore
}

// EventQuery represents query parameters for events.
type EventQuery struct {
	MatchID  string
	Type     *string
	SteamID  *string
	Round    *int
}

// GetPlayerScores retrieves all player scores for a match.
func (r *Reader) GetPlayerScores(ctx context.Context, matchID string) ([]PlayerScore, error) {
	query := `
		SELECT match_id, steamid, team_kills, team_damage, team_flash_seconds,
		       afk_seconds, body_block_seconds, grief_score
		FROM player_scores
		WHERE match_id = ?
		ORDER BY grief_score DESC
	`
	rows, err := r.db.QueryContext(ctx, query, matchID)
	if err != nil {
		return nil, fmt.Errorf("failed to query player scores: %w", err)
	}
	defer rows.Close()

	scores := make([]PlayerScore, 0)
	for rows.Next() {
		var score PlayerScore
		err := rows.Scan(
			&score.MatchID, &score.SteamID, &score.TeamKills, &score.TeamDamage,
			&score.TeamFlashSeconds, &score.AFKSeconds, &score.BodyBlockSeconds,
			&score.GriefScore,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan player score: %w", err)
		}
		scores = append(scores, score)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating player scores: %w", err)
	}

	return scores, nil
}

// GetEvents retrieves events matching the query parameters.
func (r *Reader) GetEvents(ctx context.Context, q EventQuery) ([]Event, error) {
	query := `
		SELECT match_id, round_index, type, start_tick, end_tick,
		       actor_steamid, victim_steamid, severity, confidence, meta_json
		FROM events
		WHERE match_id = ?
	`
	args := []interface{}{q.MatchID}

	if q.Type != nil {
		query += " AND type = ?"
		args = append(args, *q.Type)
	}

	if q.SteamID != nil {
		query += " AND (actor_steamid = ? OR victim_steamid = ?)"
		args = append(args, *q.SteamID, *q.SteamID)
	}

	if q.Round != nil {
		query += " AND round_index = ?"
		args = append(args, *q.Round)
	}

	query += " ORDER BY start_tick ASC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query events: %w", err)
	}
	defer rows.Close()

	events := make([]Event, 0)
	for rows.Next() {
		var e Event
		var severity, confidence sql.NullFloat64
		err := rows.Scan(
			&e.MatchID, &e.RoundIndex, &e.Type, &e.StartTick, &e.EndTick,
			&e.ActorSteamID, &e.VictimSteamID, &severity, &confidence, &e.MetaJSON,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan event: %w", err)
		}

		if severity.Valid {
			e.Severity = &severity.Float64
		}
		if confidence.Valid {
			e.Confidence = &confidence.Float64
		}

		events = append(events, e)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating events: %w", err)
	}

	return events, nil
}

// GetRounds retrieves all rounds for a match.
func (r *Reader) GetRounds(ctx context.Context, matchID string) ([]Round, error) {
	query := `
		SELECT match_id, round_index, start_tick, freeze_end_tick, end_tick,
		       t_wins, ct_wins, winner
		FROM rounds
		WHERE match_id = ?
		ORDER BY round_index ASC
	`
	rows, err := r.db.QueryContext(ctx, query, matchID)
	if err != nil {
		return nil, fmt.Errorf("failed to query rounds: %w", err)
	}
	defer rows.Close()

	rounds := make([]Round, 0)
	for rows.Next() {
		var r Round
		var winner sql.NullString
		var freezeEndTick sql.NullInt64
		err := rows.Scan(
			&r.MatchID, &r.RoundIndex, &r.StartTick, &freezeEndTick, &r.EndTick,
			&r.TWins, &r.CTWins, &winner,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan round: %w", err)
		}

		if winner.Valid {
			r.Winner = &winner.String
		}
		if freezeEndTick.Valid {
			tick := int(freezeEndTick.Int64)
			r.FreezeEndTick = &tick
		}

		rounds = append(rounds, r)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating rounds: %w", err)
	}

	return rounds, nil
}

// GetPlayerName retrieves a player's name for a match.
func (r *Reader) GetPlayerName(ctx context.Context, matchID, steamID string) (string, error) {
	query := `SELECT name FROM players WHERE match_id = ? AND steamid = ? LIMIT 1`
	var name string
	err := r.db.QueryRowContext(ctx, query, matchID, steamID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to get player name: %w", err)
	}
	return name, nil
}

// GetMatchExists checks if a match exists.
func (r *Reader) GetMatchExists(ctx context.Context, matchID string) (bool, error) {
	query := `SELECT 1 FROM matches WHERE id = ? LIMIT 1`
	var exists int
	err := r.db.QueryRowContext(ctx, query, matchID).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check match existence: %w", err)
	}
	return true, nil
}

// GetChatMessages retrieves chat messages for a match, optionally filtered by steamid.
// Only returns all chat messages (excludes team chat).
func (r *Reader) GetChatMessages(ctx context.Context, matchID string, steamid *string) ([]ChatMessage, error) {
	var query string
	var args []interface{}

	if steamid != nil {
		query = `
			SELECT match_id, round_index, tick, steamid, name, team, message, is_team_chat
			FROM chat_messages
			WHERE match_id = ? AND steamid = ? AND is_team_chat = 0
			ORDER BY tick ASC
		`
		args = []interface{}{matchID, *steamid}
	} else {
		query = `
			SELECT match_id, round_index, tick, steamid, name, team, message, is_team_chat
			FROM chat_messages
			WHERE match_id = ? AND is_team_chat = 0
			ORDER BY tick ASC
		`
		args = []interface{}{matchID}
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query chat messages: %w", err)
	}
	defer rows.Close()

	messages := make([]ChatMessage, 0)
	for rows.Next() {
		var msg ChatMessage
		var isTeamChat int
		var name, team sql.NullString
		if err := rows.Scan(&msg.MatchID, &msg.RoundIndex, &msg.Tick, &msg.SteamID, &name, &team, &msg.Message, &isTeamChat); err != nil {
			return nil, fmt.Errorf("failed to scan chat message: %w", err)
		}
		msg.IsTeamChat = isTeamChat == 1
		if name.Valid {
			msg.Name = &name.String
		}
		if team.Valid {
			msg.Team = &team.String
		}
		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating chat messages: %w", err)
	}

	return messages, nil
}

// GetParserLogs retrieves parser logs for a match.
func (r *Reader) GetParserLogs(ctx context.Context, matchID string) (string, error) {
	query := `SELECT logs FROM parser_logs WHERE match_id = ?`
	var logs string
	err := r.db.QueryRowContext(ctx, query, matchID).Scan(&logs)
	if err == sql.ErrNoRows {
		return "", nil // No logs found
	}
	if err != nil {
		return "", fmt.Errorf("failed to get parser logs: %w", err)
	}
	return logs, nil
}
