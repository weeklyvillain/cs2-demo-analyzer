package extractors

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	_ "modernc.org/sqlite" // Pure Go SQLite driver (no cgo required)
)

// AFKExtractor detects when players are AFK (stationary for extended periods).
// It tracks player positions and detects when they haven't moved significantly.
// AFK is only tracked after freeze time ends in each round.
type AFKExtractor struct {
	playerStates       map[string]*playerAFKState // key: roundIndex_steamID
	freezeEndTicks     map[int]int                // roundIndex -> freeze end tick
	roundEndTicks      map[int]int                // roundIndex -> round end tick
	lastDiscoveryTick  map[string]int             // key: roundIndex_tick -> last discovery tick
	tickRate           float64
	minAFKSeconds      float64
	events             []Event
	db                 *sql.DB
}

type playerAFKState struct {
	roundIndex           int
	steamID              string
	initialPosition      *position // Position at freeze time end
	lastPosition         *position
	lastMoveTick         int
	gracePeriodEndTick   int           // End of 5-second grace period
	movedDuringGrace     bool          // Whether player moved during grace period
	afkStartTick         *int          // When AFK period started (only if not moved during grace)
	firstMovementTick    *int          // When player first moved (if they moved)
	deathTick            *int          // When player died (if they died)
	minAFKSeconds        float64       // Minimum seconds to be considered AFK (e.g., 5 seconds)
	movementThreshold    float64       // Minimum distance to consider as movement (2-5 units)
}

type position struct {
	X, Y, Z float64
}

// Position is exported for use by parser
type Position = position

// NewAFKExtractor creates a new AFK extractor.
func NewAFKExtractor(tickRate float64, db *sql.DB) *AFKExtractor {
	return &AFKExtractor{
		playerStates:      make(map[string]*playerAFKState),
		freezeEndTicks:    make(map[int]int),
		roundEndTicks:     make(map[int]int),
		lastDiscoveryTick: make(map[string]int),
		tickRate:          tickRate,
		minAFKSeconds:     5.0, // 5 seconds of no movement = AFK
		events:            make([]Event, 0),
		db:                db,
	}
}

// HandlePlayerPositionUpdate should be called periodically to check player positions.
// For now, we'll use PlayerHurt and other events as proxies, or track on frame updates.
// Since demoinfocs doesn't have a direct "player position update" event, we'll track
// position changes through other events that include player position.

// HandleRoundStart resets AFK tracking for a new round.
// Note: With the new implementation, AFK detection is done via ProcessAFKFromDatabase
// after all positions are written, so this mainly just cleans up old state.
func (e *AFKExtractor) HandleRoundStart(roundIndex int, tick int) {
	// Clear states for previous rounds
	keysToDelete := make([]string, 0)
	for key, state := range e.playerStates {
		if state.roundIndex < roundIndex {
			keysToDelete = append(keysToDelete, key)
		}
	}
	for _, key := range keysToDelete {
		delete(e.playerStates, key)
	}
	
	// Clear freeze end tick for previous rounds
	for rIdx := range e.freezeEndTicks {
		if rIdx < roundIndex {
			delete(e.freezeEndTicks, rIdx)
		}
	}
	
	// Clear round end tick for previous rounds
	for rIdx := range e.roundEndTicks {
		if rIdx < roundIndex {
			delete(e.roundEndTicks, rIdx)
		}
	}
}

// HandleRoundEnd records when a round ends for filtering AFK periods that end at round end.
func (e *AFKExtractor) HandleRoundEnd(roundIndex int, roundEndTick int) {
	e.roundEndTicks[roundIndex] = roundEndTick
}

// HandleFreezeTimeEnd records when freeze time ends for a round and checks for AFK players.
// AFK tracking will only start after this tick.
func (e *AFKExtractor) HandleFreezeTimeEnd(roundIndex int, freezeEndTick int) {
	e.freezeEndTicks[roundIndex] = freezeEndTick
	
	// Query all player positions from the database at freeze time end
	// to initialize AFK tracking for all players
	e.initializePlayersFromDatabase(roundIndex, freezeEndTick)
}

// initializePlayersFromDatabase queries the database for all unique players in a round.
// Instead of just querying at freeze end, we get all unique steamids that appear in the round
// and initialize them with their position at freeze end (or their first position if not at freeze end).
func (e *AFKExtractor) initializePlayersFromDatabase(roundIndex int, freezeEndTick int) {
	// Query all DISTINCT steamids that appear in this round
	// We need to check player_positions table for positions in this round/match
	query := "SELECT DISTINCT steamid FROM player_positions WHERE tick >= ? ORDER BY steamid"
	rows, err := e.db.Query(query, freezeEndTick)
	if err != nil {
		// Silently skip if query fails - database might not have data yet
		return
	}
	defer rows.Close()

	// Grace period: 5 seconds after freeze time
	gracePeriodSeconds := 5.0
	gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
	gracePeriodEndTick := freezeEndTick + gracePeriodTicks

	playerCount := 0
	for rows.Next() {
		var steamID string
		if err := rows.Scan(&steamID); err != nil {
			continue // Skip rows that can't be scanned
		}

		// Get this player's position at freeze end if available, otherwise skip for now
		// They'll be initialized when first seen in CheckAllPlayersAFK
		pos, err := e.getPlayerPositionFromDB(steamID, freezeEndTick)
		if err != nil {
			continue
		}
		if pos == nil {
			// Player doesn't have position at freeze end - will initialize on first check
			continue
		}

		key := fmt.Sprintf("%d_%s", roundIndex, steamID)
		e.playerStates[key] = &playerAFKState{
			roundIndex:         roundIndex,
			steamID:            steamID,
			initialPosition:    pos,
			lastPosition:       pos,
			lastMoveTick:       freezeEndTick,
			gracePeriodEndTick: gracePeriodEndTick,
			movedDuringGrace:   false,
			afkStartTick:       nil,
			firstMovementTick:  nil,
			deathTick:          nil,
			minAFKSeconds:      5.0,
			movementThreshold:  3.0, // 2-5 units to ignore jitter
		}
		playerCount++
	}
}

// getPlayerPositionFromDB queries the player's position from the database for a given tick.
func (e *AFKExtractor) getPlayerPositionFromDB(steamID string, tick int) (*position, error) {
	query := "SELECT x, y, z FROM player_positions WHERE steamid = ? AND tick = ?"
	row := e.db.QueryRow(query, steamID, tick)

	var x, y, z float64
	if err := row.Scan(&x, &y, &z); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // No position found for this tick
		}
		return nil, err
	}

	return &position{X: x, Y: y, Z: z}, nil
}

// UpdatePlayerPosition updates a player's position and checks for AFK.
// AFK tracking only starts after freeze time ends.
func (e *AFKExtractor) UpdatePlayerPosition(player *common.Player, roundIndex int, tick int) {
	if player == nil {
		return
	}

	// Check if freeze time has ended for this round
	// If freeze time hasn't ended yet, don't track AFK
	freezeEndTick, freezeTimeEnded := e.freezeEndTicks[roundIndex]
	if !freezeTimeEnded || tick < freezeEndTick {
		return
	}

	steamID := getSteamID(player)
	if steamID == nil {
		return
	}

	key := fmt.Sprintf("%d_%s", roundIndex, *steamID)
	state, exists := e.playerStates[key]

	// Fetch position from the database
	currentPos, err := e.getPlayerPositionFromDB(*steamID, tick)
	if err != nil {
		return // Skip if position query fails
	}
	if currentPos == nil {
		return // No position data available
	}

	if !exists {
		// New player state - initialize after freeze time
		// Get grace period end tick for this round
		gracePeriodEndTick := 0
		if freezeEndTick, exists := e.freezeEndTicks[roundIndex]; exists {
			gracePeriodSeconds := 5.0
			gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
			gracePeriodEndTick = freezeEndTick + gracePeriodTicks
		}
		
		e.playerStates[key] = &playerAFKState{
			roundIndex:         roundIndex,
			steamID:            *steamID,
			lastPosition:       currentPos,
			lastMoveTick:        tick,
			gracePeriodEndTick:  gracePeriodEndTick,
			movedDuringGrace:   tick > gracePeriodEndTick, // If discovered after grace period, they implicitly "moved"
			afkStartTick:       nil,
			firstMovementTick:  nil,
			deathTick:          nil,
			minAFKSeconds:      5.0,
			movementThreshold:  3.0,
		}
		return
	}

	// Check if player has moved significantly (use movement threshold)
	dx := currentPos.X - state.lastPosition.X
	dy := currentPos.Y - state.lastPosition.Y
	dz := currentPos.Z - state.lastPosition.Z
	distance := math.Sqrt(dx*dx + dy*dy + dz*dz)

	if distance > state.movementThreshold {
		// Player moved - cancel AFK tracking
		// Note: With new implementation, this is handled in ProcessAFKFromDatabase
		state.lastPosition = currentPos
		state.lastMoveTick = tick
		state.afkStartTick = nil
	} else {
		// Player hasn't moved much
		if state.afkStartTick == nil {
			// Start tracking AFK period (only after freeze time)
			state.afkStartTick = &tick
		} else {
			// Check if AFK period is long enough
			afkTicks := tick - *state.afkStartTick
			afkSeconds := float64(afkTicks) / e.tickRate

			if afkSeconds >= e.minAFKSeconds {
				// Player has been AFK long enough - we'll finalize on next move or round end
				state.lastPosition = currentPos
			}
		}
	}
}

// ProcessAFKFromDatabase processes AFK detection for a match by querying positions from the database.
// This implements the "AFK at round start" detector based on the new requirements:
// - 5 second grace window starting at freezeTimeEnd (roundStart)
// - If player moves during grace: NOT_AFK
// - If player doesn't move during grace: AFK starts at roundStart (not after grace ends)
// - AFK continues until: move, die, or round end
// - Only tracks round-start AFK (no mid-round AFK intervals)
func (e *AFKExtractor) ProcessAFKFromDatabase(matchID string, roundIndex int, freezeEndTick int, roundEndTick int) error {
	// Record round end tick
	e.roundEndTicks[roundIndex] = roundEndTick
	
	// Define grace period: 5 seconds starting at freezeEndTick (roundStart)
	gracePeriodSeconds := 5.0
	gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
	gracePeriodEndTick := freezeEndTick + gracePeriodTicks
	
	// Movement threshold: 2-5 units (using 3.0 as middle ground)
	moveEps := 3.0

	// Query disconnect events for this round and previous rounds FIRST
	// Players who disconnect should not be tracked for AFK
	// We need to check disconnects from previous rounds too, as they might still be disconnected
	disconnectQuery := `
		SELECT actor_steamid, start_tick, end_tick, round_index
		FROM events
		WHERE match_id = ? AND type = 'DISCONNECT' AND actor_steamid IS NOT NULL
		ORDER BY start_tick
	`
	disconnectRows, err := e.db.Query(disconnectQuery, matchID)
	disconnectIntervals := make(map[string][]struct{ start, end int }) // steamID -> list of [start, end] intervals
	if err == nil {
		defer disconnectRows.Close()
		for disconnectRows.Next() {
			var steamID string
			var startTick int
			var endTick sql.NullInt64
			var eventRoundIndex int
			if err := disconnectRows.Scan(&steamID, &startTick, &endTick, &eventRoundIndex); err == nil {
				// Only consider disconnects that are relevant to this round
				// If disconnect happened before this round and no reconnect, they're still disconnected
				// If disconnect happened during this round, include it
				if eventRoundIndex < roundIndex {
					// Disconnect from previous round - if no reconnect, they're still disconnected
					if !endTick.Valid {
						// No reconnect, still disconnected - mark as disconnected from round start
						disconnectIntervals[steamID] = append(disconnectIntervals[steamID], struct{ start, end int }{start: freezeEndTick, end: roundEndTick})
					}
				} else if eventRoundIndex == roundIndex {
					// Disconnect during this round
					disconnectEnd := roundEndTick // Default to round end if no reconnect
					if endTick.Valid {
						disconnectEnd = int(endTick.Int64)
					}
					disconnectIntervals[steamID] = append(disconnectIntervals[steamID], struct{ start, end int }{start: startTick, end: disconnectEnd})
				}
			}
		}
	}

	// Query death events for this round
	deathQuery := `
		SELECT DISTINCT victim_steamid, start_tick
		FROM events
		WHERE match_id = ? AND round_index = ? AND victim_steamid IS NOT NULL
		ORDER BY start_tick
	`
	deathRows, err := e.db.Query(deathQuery, matchID, roundIndex)
	deathTicks := make(map[string]int) // steamID -> death tick
	if err == nil {
		defer deathRows.Close()
		for deathRows.Next() {
			var steamID string
			var deathTick int
			if err := deathRows.Scan(&steamID, &deathTick); err == nil {
				if existingTick, exists := deathTicks[steamID]; !exists || deathTick < existingTick {
					deathTicks[steamID] = deathTick
				}
			}
		}
	}

	// Helper function to check if player is disconnected or dead at a given tick
	isPlayerDisconnectedOrDead := func(steamID string, tick int) bool {
		// Check if player is dead at this tick
		if deathTick, isDead := deathTicks[steamID]; isDead && tick >= deathTick {
			return true
		}
		// Check if player is disconnected at this tick
		if intervals, isDisconnected := disconnectIntervals[steamID]; isDisconnected {
			for _, interval := range intervals {
				if tick >= interval.start && tick <= interval.end {
					return true
				}
			}
		}
		return false
	}

	// Get all unique players for this round
	query := `
		SELECT DISTINCT steamid
		FROM player_positions
		WHERE match_id = ? AND round_index = ?
		ORDER BY steamid
	`
	rows, err := e.db.Query(query, matchID, roundIndex)
	if err != nil {
		return fmt.Errorf("failed to query players: %w", err)
	}
	defer rows.Close()

	// Initialize player states - track movement during grace period
	// Local type for tracking AFK state during processing
	type afkPlayerState struct {
		steamID           string
		lastPosition      *position
		lastPositionTick  int
		movedDuringGrace  bool
		afkStartTick      *int // nil if NOT_AFK, set to freezeEndTick if AFK
		deathTick         *int
		firstMovementTick *int
	}
	
	playerStates := make(map[string]*afkPlayerState)

	for rows.Next() {
		var steamID string
		if err := rows.Scan(&steamID); err != nil {
			continue
		}

		// Skip if player is disconnected at round start - don't track AFK for disconnected players
		if isPlayerDisconnectedOrDead(steamID, freezeEndTick) {
			continue
		}

		// Get position at freeze end (roundStart)
		queryPos := `
			SELECT x, y, z
			FROM player_positions
			WHERE match_id = ? AND round_index = ? AND steamid = ? AND tick = ?
		`
		var x, y, z float64
		row := e.db.QueryRow(queryPos, matchID, roundIndex, steamID, freezeEndTick)
		if err := row.Scan(&x, &y, &z); err != nil {
			// Try to get first available position after freeze end
			queryFirst := `
				SELECT tick, x, y, z
				FROM player_positions
				WHERE match_id = ? AND round_index = ? AND steamid = ? AND tick >= ?
				ORDER BY tick ASC
				LIMIT 1
			`
			var firstTick int
			rowFirst := e.db.QueryRow(queryFirst, matchID, roundIndex, steamID, freezeEndTick)
			if err := rowFirst.Scan(&firstTick, &x, &y, &z); err != nil {
				continue // Skip if no position data
			}
			// If first position is after grace period, player might still be AFK
			// We'll initialize with this position and check if they move
		}

		playerStates[steamID] = &afkPlayerState{
			steamID:           steamID,
			lastPosition:      &position{X: x, Y: y, Z: z},
			lastPositionTick:  freezeEndTick,
			movedDuringGrace:  false,
			afkStartTick:      nil, // Will be set if no movement during grace
			deathTick:         nil,
			firstMovementTick: nil,
		}
	}

	// Update death ticks in player states
	for steamID, deathTick := range deathTicks {
		if state, exists := playerStates[steamID]; exists {
			if state.deathTick == nil || deathTick < *state.deathTick {
				state.deathTick = &deathTick
			}
		}
	}

	// Query all positions for this round, ordered by tick
	posQuery := `
		SELECT steamid, tick, x, y, z
		FROM player_positions
		WHERE match_id = ? AND round_index = ? AND tick >= ? AND tick <= ?
		ORDER BY tick ASC
	`
	posRows, err := e.db.Query(posQuery, matchID, roundIndex, freezeEndTick, roundEndTick)
	if err != nil {
		return fmt.Errorf("failed to query positions: %w", err)
	}
	defer posRows.Close()

	// Process positions tick by tick
	for posRows.Next() {
		var steamID string
		var tick int
		var x, y, z float64
		if err := posRows.Scan(&steamID, &tick, &x, &y, &z); err != nil {
			continue
		}

		// Skip AFK tracking if player is disconnected or dead at this tick
		// But still process their position to update state
		isDisconnectedOrDead := isPlayerDisconnectedOrDead(steamID, tick)

		// Skip if player is disconnected or dead at this tick - don't track AFK for disconnected players
		if isPlayerDisconnectedOrDead(steamID, tick) {
			continue
		}

		state, exists := playerStates[steamID]
		if !exists {
			// Skip if player is disconnected at round start - don't track AFK for disconnected players
			if isPlayerDisconnectedOrDead(steamID, freezeEndTick) {
				continue
			}

			// Initialize player on the fly if we encounter them
			state = &afkPlayerState{
				steamID:           steamID,
				lastPosition:      &position{X: x, Y: y, Z: z},
				lastPositionTick:  tick,
				movedDuringGrace:  false,
				afkStartTick:      nil,
				deathTick:         nil,
				firstMovementTick: nil,
			}
			playerStates[steamID] = state
			
			// If player first appears during grace period, they could be AFK
			// If they appear after grace period, they're not considered for round-start AFK
			// Only start AFK tracking if they're not disconnected/dead at round start
			if tick <= gracePeriodEndTick && !isPlayerDisconnectedOrDead(steamID, freezeEndTick) {
				// Player was present during grace - AFK starts at roundStart if no movement
				afkStart := freezeEndTick
				state.afkStartTick = &afkStart
			}
		}

		currentPos := &position{X: x, Y: y, Z: z}

		// If player is disconnected or dead, cancel any active AFK tracking
		if isDisconnectedOrDead {
			if state.afkStartTick != nil {
				// If they died, finalize with DIED status
				if state.deathTick != nil && *state.deathTick == tick {
					e.createAFKEvent(matchID, roundIndex, state.steamID, *state.afkStartTick, tick, "DIED", true, state.firstMovementTick)
				}
				// Cancel AFK tracking (disconnected or dead)
				state.afkStartTick = nil
			}
			// Update position but skip AFK tracking
			state.lastPosition = currentPos
			state.lastPositionTick = tick
			continue
		}

		// Check if player has moved significantly
		dx := currentPos.X - state.lastPosition.X
		dy := currentPos.Y - state.lastPosition.Y
		dz := currentPos.Z - state.lastPosition.Z
		distance := math.Sqrt(dx*dx + dy*dy + dz*dz)

		if distance > moveEps {
			// Player moved significantly
			if state.firstMovementTick == nil {
				state.firstMovementTick = &tick
			}

			// If during grace period, mark that they moved (they're NOT_AFK)
			if tick < gracePeriodEndTick {
				state.movedDuringGrace = true
				// Cancel AFK tracking - player moved during grace
				state.afkStartTick = nil
			} else if state.afkStartTick != nil {
				// Player moved after grace period, ending AFK
				// Finalize AFK interval (ended by movement)
				e.createAFKEvent(matchID, roundIndex, state.steamID, *state.afkStartTick, tick, "MOVED", false, state.firstMovementTick)
				state.afkStartTick = nil
			}

			state.lastPosition = currentPos
			state.lastPositionTick = tick
		} else {
			// Player hasn't moved significantly
			
			// If they moved during grace period, they're NOT_AFK - skip
			if state.movedDuringGrace {
				state.lastPosition = currentPos
				state.lastPositionTick = tick
				continue
			}

			// Check if player died at this tick (while AFK)
			if state.deathTick != nil && *state.deathTick == tick {
				// Player died while AFK
				if state.afkStartTick != nil {
					// Finalize AFK interval (ended by death, state = AFK_DIED)
					e.createAFKEvent(matchID, roundIndex, state.steamID, *state.afkStartTick, tick, "DIED", true, state.firstMovementTick)
					state.afkStartTick = nil
				}
			} else if state.afkStartTick == nil && tick < gracePeriodEndTick {
				// Player hasn't moved during grace period yet - start AFK at roundStart
				// Only if they weren't disconnected/dead at round start
				if !isPlayerDisconnectedOrDead(steamID, freezeEndTick) {
					afkStart := freezeEndTick
					state.afkStartTick = &afkStart
				}
			}
			
			// Continue tracking position (player is still stationary)
			state.lastPosition = currentPos
			state.lastPositionTick = tick
		}
	}

	// Finalize any remaining AFK states at round end
	for _, state := range playerStates {
		if state.afkStartTick != nil && !state.movedDuringGrace {
			// Only finalize if player wasn't disconnected/dead at round end
			if !isPlayerDisconnectedOrDead(state.steamID, roundEndTick) {
				// Player was still AFK at round end
				e.createAFKEvent(matchID, roundIndex, state.steamID, *state.afkStartTick, roundEndTick, "ROUND_END", false, state.firstMovementTick)
			}
		}
	}

	return nil
}

// createAFKEvent creates an AFK event with the specified end condition
// state is a local type from ProcessAFKFromDatabase, so we pass individual fields
func (e *AFKExtractor) createAFKEvent(matchID string, roundIndex int, steamID string, afkStartTick int, endTick int, endedBy string, diedWhileAFK bool, firstMovementTick *int) {
	afkTicks := endTick - afkStartTick
	afkSeconds := float64(afkTicks) / e.tickRate

	// Determine state: AFK or AFK_DIED
	stateStr := "AFK"
	if diedWhileAFK {
		stateStr = "AFK_DIED"
	}

	// Build metadata
	meta := make(map[string]interface{})
	meta["seconds"] = afkSeconds
	meta["afkDuration"] = afkSeconds
	meta["start_tick"] = afkStartTick
	meta["end_tick"] = endTick
	meta["state"] = stateStr
	meta["endedBy"] = endedBy
	meta["diedWhileAFK"] = diedWhileAFK
	if firstMovementTick != nil {
		timeToFirstMovement := float64(*firstMovementTick - afkStartTick) / e.tickRate
		meta["timeToFirstMovement"] = timeToFirstMovement
	}

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	// Create event (using AFK_STILLNESS to match UI expectations)
	event := Event{
		Type:          "AFK_STILLNESS",
		RoundIndex:    roundIndex,
		StartTick:     afkStartTick,
		EndTick:       &endTick,
		ActorSteamID:  &steamID,
		Severity:      1.0, // AFK is always severity 1.0
		Confidence:    1.0, // High confidence for position-based detection
		MetaJSON:      &metaJSONStr,
	}

	e.events = append(e.events, event)
}

// CheckAllPlayersAFK checks all tracked players for AFK status using live position data.
// DEPRECATED: Use ProcessAFKFromDatabase instead after positions are written to the database.
func (e *AFKExtractor) CheckAllPlayersAFK(roundIndex int, tick int, playerPositions map[string]*position) {
	// Check if freeze time has ended for this round
	freezeEndTick, freezeTimeEnded := e.freezeEndTicks[roundIndex]
	if !freezeTimeEnded || tick < freezeEndTick {
		return
	}

	// Initialize any new players from the provided positions
	for steamID, pos := range playerPositions {
		if pos == nil {
			continue
		}
		key := fmt.Sprintf("%d_%s", roundIndex, steamID)
		if _, exists := e.playerStates[key]; !exists {
			// Initialize new player
			gracePeriodSeconds := 5.0
			gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
			gracePeriodEndTick := freezeEndTick + gracePeriodTicks
			
			e.playerStates[key] = &playerAFKState{
				roundIndex:         roundIndex,
				steamID:            steamID,
				initialPosition:    pos,
				lastPosition:       pos,
				lastMoveTick:       tick,
				gracePeriodEndTick: gracePeriodEndTick,
				movedDuringGrace:   tick > gracePeriodEndTick, // If discovered after grace period, they implicitly "moved"
				afkStartTick:       nil,
				firstMovementTick:  nil,
				deathTick:          nil,
				minAFKSeconds:      5.0,
				movementThreshold:  3.0,
			}
		}
	}

	// Check all players we're tracking
	for _, state := range e.playerStates {
		if state.roundIndex != roundIndex {
			continue
		}

		// Get position from provided map (live data)
		currentPos, exists := playerPositions[state.steamID]
		if !exists || currentPos == nil {
			// No position at this tick, skip for now
			continue
		}

		// Check if player has moved significantly (use movement threshold, not hardcoded 10.0)
		dx := currentPos.X - state.lastPosition.X
		dy := currentPos.Y - state.lastPosition.Y
		dz := currentPos.Z - state.lastPosition.Z
		distance := math.Sqrt(dx*dx + dy*dy + dz*dz)

		if distance > state.movementThreshold {
			// Player moved significantly

			// Record first movement tick
			if state.firstMovementTick == nil {
				state.firstMovementTick = &tick
			}

			// If during grace period, mark that they moved (they're NOT AFK)
			if tick <= state.gracePeriodEndTick {
				state.movedDuringGrace = true
			}

			// If AFK was being tracked, cancel it (ended due to movement)
			// Note: With new implementation, this is handled in ProcessAFKFromDatabase
			state.afkStartTick = nil

			state.lastPosition = currentPos
			state.lastMoveTick = tick
		} else {
			// Player hasn't moved significantly

			// If they already moved during grace period, they're not AFK - skip
			if state.movedDuringGrace {
				state.lastPosition = currentPos
				continue
			}

			// Start or continue AFK tracking only for players who haven't moved during grace period
			if state.afkStartTick == nil {
				// Start tracking AFK period (after grace period ends)
				if tick > state.gracePeriodEndTick {
					state.afkStartTick = &tick
				}
			} else {
				// Check if AFK period is long enough
				afkTicks := tick - *state.afkStartTick
				afkSeconds := float64(afkTicks) / e.tickRate

				if afkSeconds >= state.minAFKSeconds {
					// Player has been AFK long enough
					state.lastPosition = currentPos
				}
			}
		}
	}
}

// discoverNewPlayers discovers players that haven't been initialized yet but exist in the database
func (e *AFKExtractor) discoverNewPlayers(roundIndex int, freezeEndTick int, currentTick int) {
	// Only discover periodically (every 64 ticks or ~1 second) to avoid excessive queries
	// Check if we've already discovered at this tick
	discoveryKey := fmt.Sprintf("%d_%d", roundIndex, currentTick)
	if e.lastDiscoveryTick == nil {
		e.lastDiscoveryTick = make(map[string]int)
	}
	
	if lastTick, exists := e.lastDiscoveryTick[discoveryKey]; exists && currentTick-lastTick < 64 {
		return // Skip if we just discovered
	}
	e.lastDiscoveryTick[discoveryKey] = currentTick

	// Query for steamids that might not be initialized yet
	query := "SELECT DISTINCT steamid FROM player_positions WHERE tick >= ? AND tick <= ? + 10"
	rows, err := e.db.Query(query, freezeEndTick, currentTick)
	if err != nil {
		return
	}
	defer rows.Close()

	gracePeriodSeconds := 5.0
	gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
	gracePeriodEndTick := freezeEndTick + gracePeriodTicks

	for rows.Next() {
		var steamID string
		if err := rows.Scan(&steamID); err != nil {
			continue
		}

		key := fmt.Sprintf("%d_%s", roundIndex, steamID)

		// Check if already initialized
		if _, exists := e.playerStates[key]; exists {
			continue // Already tracking this player
		}

		// Try to get position at current tick
		pos, err := e.getPlayerPositionFromDB(steamID, currentTick)
		if err != nil || pos == nil {
			continue
		}

		// Initialize new player
		e.playerStates[key] = &playerAFKState{
			roundIndex:         roundIndex,
			steamID:            steamID,
			initialPosition:    pos,
			lastPosition:       pos,
			lastMoveTick:       currentTick,
			gracePeriodEndTick: gracePeriodEndTick,
			movedDuringGrace:   currentTick > gracePeriodEndTick, // If discovered after grace period, they implicitly "moved"
			afkStartTick:       nil,
			firstMovementTick:  nil,
			deathTick:          nil,
			minAFKSeconds:      5.0,
			movementThreshold:  3.0,
		}
	}
}

// CancelAFK is deprecated - AFK detection is now done via ProcessAFKFromDatabase
// This function is kept for backwards compatibility but does nothing
func (e *AFKExtractor) CancelAFK(player *common.Player, roundIndex int, tick int) {
	// Deprecated - no longer used
}

// FinalizeRound is deprecated - AFK detection is now done via ProcessAFKFromDatabase
// This function is kept for backwards compatibility but does nothing
func (e *AFKExtractor) FinalizeRound(roundIndex int, finalTick int) {
	// Deprecated - no longer used
}


// GetEvents returns all extracted events.
func (e *AFKExtractor) GetEvents() []Event {
	return e.events
}

