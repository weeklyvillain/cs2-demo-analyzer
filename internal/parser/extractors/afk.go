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
func (e *AFKExtractor) HandleRoundStart(roundIndex int, tick int) {
	// Clear states for this round
	keysToDelete := make([]string, 0)
	for key, state := range e.playerStates {
		if state.roundIndex < roundIndex {
			// Finalize any pending AFK events from previous round
			if state.afkStartTick != nil {
				e.finalizeAFK(state, tick)
			}
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
		if state.afkStartTick != nil {
			// Finalize the AFK period
			e.finalizeAFK(state, tick)
		}
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
// This should be called after all positions have been written to the database.
func (e *AFKExtractor) ProcessAFKFromDatabase(matchID string, roundIndex int, freezeEndTick int, roundEndTick int) error {
	// Record round end tick
	e.roundEndTicks[roundIndex] = roundEndTick
	
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

	// Initialize player states
	gracePeriodSeconds := 5.0
	gracePeriodTicks := int(math.Ceil(gracePeriodSeconds * e.tickRate))
	gracePeriodEndTick := freezeEndTick + gracePeriodTicks

	for rows.Next() {
		var steamID string
		if err := rows.Scan(&steamID); err != nil {
			continue
		}

		// Get position at freeze end (need to query with match_id and round_index)
		queryPos := `
			SELECT x, y, z
			FROM player_positions
			WHERE match_id = ? AND round_index = ? AND steamid = ? AND tick = ?
		`
		var x, y, z float64
		row := e.db.QueryRow(queryPos, matchID, roundIndex, steamID, freezeEndTick)
		var initialPos *position
		if err := row.Scan(&x, &y, &z); err != nil {
			// Try to get first available position after freeze end
			queryFirst := `
				SELECT x, y, z
				FROM player_positions
				WHERE match_id = ? AND round_index = ? AND steamid = ? AND tick >= ?
				ORDER BY tick ASC
				LIMIT 1
			`
			rowFirst := e.db.QueryRow(queryFirst, matchID, roundIndex, steamID, freezeEndTick)
			if err := rowFirst.Scan(&x, &y, &z); err != nil {
				continue // Skip if no position data
			}
		}
		initialPos = &position{X: x, Y: y, Z: z}

		key := fmt.Sprintf("%d_%s", roundIndex, steamID)
		e.playerStates[key] = &playerAFKState{
			roundIndex:         roundIndex,
			steamID:            steamID,
			initialPosition:    initialPos,
			lastPosition:       initialPos,
			lastMoveTick:       freezeEndTick,
			gracePeriodEndTick: gracePeriodEndTick,
			movedDuringGrace:   false,
			afkStartTick:       nil,
			firstMovementTick:  nil,
			deathTick:          nil,
			minAFKSeconds:      5.0,
			movementThreshold:  3.0,
		}
	}

	// Query all positions for this round, ordered by tick
	posQuery := `
		SELECT steamid, tick, x, y, z
		FROM player_positions
		WHERE match_id = ? AND round_index = ? AND tick >= ?
		ORDER BY tick ASC
	`
	posRows, err := e.db.Query(posQuery, matchID, roundIndex, freezeEndTick)
	if err != nil {
		return fmt.Errorf("failed to query positions: %w", err)
	}
	defer posRows.Close()

	// Query death events for this round to mark when players die
	// Check both TEAM_KILL events and any events where victim_steamid is set (player died)
	deathQuery := `
		SELECT DISTINCT victim_steamid, start_tick
		FROM events
		WHERE match_id = ? AND round_index = ? AND victim_steamid IS NOT NULL
		ORDER BY start_tick
	`
	deathRows, err := e.db.Query(deathQuery, matchID, roundIndex)
	if err == nil {
		defer deathRows.Close()
		for deathRows.Next() {
			var steamID string
			var deathTick int
			if err := deathRows.Scan(&steamID, &deathTick); err == nil {
				key := fmt.Sprintf("%d_%s", roundIndex, steamID)
				if state, exists := e.playerStates[key]; exists {
					if state.deathTick == nil || deathTick < *state.deathTick {
						state.deathTick = &deathTick
					}
				}
			}
		}
	}

	// Process positions tick by tick
	for posRows.Next() {
		var steamID string
		var tick int
		var x, y, z float64
		if err := posRows.Scan(&steamID, &tick, &x, &y, &z); err != nil {
			continue
		}

		key := fmt.Sprintf("%d_%s", roundIndex, steamID)
		state, exists := e.playerStates[key]
		if !exists {
			// Initialize player on the fly if we encounter them in position data
			// This handles cases where player wasn't initialized earlier (e.g., no position at freezeEndTick)
			currentPos := &position{X: x, Y: y, Z: z}
			gracePeriodEndTick := freezeEndTick + int(math.Ceil(5.0*e.tickRate))
			// If player first appears after grace period, they might still be AFK
			// But we'll track their first appearance tick
			firstSeenTick := tick
			
			e.playerStates[key] = &playerAFKState{
				roundIndex:         roundIndex,
				steamID:            steamID,
				initialPosition:    currentPos,
				lastPosition:       currentPos,
				lastMoveTick:       tick,
				gracePeriodEndTick: gracePeriodEndTick,
				movedDuringGrace:   false, // Will be set to true if they move during grace period
				afkStartTick:       nil,
				firstMovementTick:  nil,
				deathTick:          nil,
				minAFKSeconds:      5.0,
				movementThreshold:  3.0,
			}
			state = e.playerStates[key]
			
			// If player first appears at or before grace period end, AFK starts at freezeEndTick
			// If player appears after grace period, AFK starts when they first appeared (if they don't move)
			if firstSeenTick <= gracePeriodEndTick {
				// Player was present during grace period - AFK starts at round start
				state.afkStartTick = &freezeEndTick
			} else {
				// Player appeared after grace period - AFK starts when they first appeared
				// (but only if they don't move - we'll check this as we process)
				state.afkStartTick = &firstSeenTick
			}
		}

		// Check if player died at this tick
		if state.deathTick != nil && *state.deathTick == tick {
			// Cancel any active AFK tracking
			if state.afkStartTick != nil {
				e.finalizeAFK(state, tick)
				state.afkStartTick = nil
			}
			// Continue processing to update last position
		}

		currentPos := &position{X: x, Y: y, Z: z}

		// Check if player has moved significantly
		dx := currentPos.X - state.lastPosition.X
		dy := currentPos.Y - state.lastPosition.Y
		dz := currentPos.Z - state.lastPosition.Z
		distance := math.Sqrt(dx*dx + dy*dy + dz*dz)

		if distance > state.movementThreshold {
			// Player moved significantly
			if state.firstMovementTick == nil {
				state.firstMovementTick = &tick
			}

			// If during grace period, mark that they moved (they're NOT AFK for this round)
			if tick <= state.gracePeriodEndTick {
				state.movedDuringGrace = true
			}

			// If AFK was being tracked, finalize it (ended due to movement)
			if state.afkStartTick != nil {
				e.finalizeAFK(state, tick)
				state.afkStartTick = nil
			}

			state.lastPosition = currentPos
			state.lastMoveTick = tick
		} else {
			// Player hasn't moved significantly
			// CRITICAL: If they moved during grace period, they're NOT AFK - skip entirely
			// This ensures we only detect AFK at round start, not mid-round
			if state.movedDuringGrace {
				// Player moved during grace period - they're NOT AFK for this round
				// Cancel any AFK tracking and skip
				if state.afkStartTick != nil {
					state.afkStartTick = nil
				}
				state.lastPosition = currentPos
				continue
			}

			// Only track AFK for players who haven't moved during grace period
			// AFK should already be started (at freezeEndTick or first appearance)
			// We should NOT start tracking AFK mid-round - only at round start
			if state.afkStartTick == nil {
				// This shouldn't happen if initialization worked correctly
				// But if it does, skip - we don't want mid-round AFK detection
				state.lastPosition = currentPos
				continue
			}
			
			// Continue AFK tracking - player is still stationary
			// We'll finalize when they move, die, or round ends
			state.lastPosition = currentPos
		}
	}

	// Finalize any remaining AFK states at round end
	e.FinalizeRound(roundIndex, roundEndTick)

	return nil
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

			// If AFK was being tracked, finalize it (ended due to movement)
			if state.afkStartTick != nil {
				e.finalizeAFK(state, tick)
				state.afkStartTick = nil
			}

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

// CancelAFK cancels AFK tracking for a player (e.g., when they die).
func (e *AFKExtractor) CancelAFK(player *common.Player, roundIndex int, tick int) {
	if player == nil {
		return
	}

	steamID := getSteamID(player)
	if steamID == nil {
		return
	}

	key := fmt.Sprintf("%d_%s", roundIndex, *steamID)
	state, exists := e.playerStates[key]
	if !exists {
		return
	}

	// Record death tick
	if state.deathTick == nil {
		state.deathTick = &tick
	}

	// Cancel any active AFK tracking
	if state.afkStartTick != nil {
		// Finalize the AFK period up to now (with diedWhileAFK flag)
		e.finalizeAFK(state, tick)
	}
	// Reset AFK tracking
	state.afkStartTick = nil
}

// FinalizeRound finalizes all pending AFK events for a round.
// This does a comprehensive check across all position data stored in the database for this round.
func (e *AFKExtractor) FinalizeRound(roundIndex int, finalTick int) {
	// Note: CheckAllPlayersAFK should be called with live position data from the parser
	// For finalization, we just finalize any remaining AFK states
	// But only for players who didn't move during grace period (round start AFK only)

	// Then finalize any remaining AFK states
	keysToFinalize := make([]string, 0)
	for key, state := range e.playerStates {
		if state.roundIndex == roundIndex && state.afkStartTick != nil && !state.movedDuringGrace {
			keysToFinalize = append(keysToFinalize, key)
		}
	}

	for _, key := range keysToFinalize {
		state := e.playerStates[key]
		e.finalizeAFK(state, finalTick)
		delete(e.playerStates, key)
	}
}

func (e *AFKExtractor) finalizeAFK(state *playerAFKState, endTick int) {
	if state.afkStartTick == nil {
		return
	}

	// CRITICAL: Don't finalize AFK if player moved during grace period
	// This ensures we only detect AFK at round start, not mid-round
	if state.movedDuringGrace {
		return
	}

	afkTicks := endTick - *state.afkStartTick
	afkSeconds := float64(afkTicks) / e.tickRate

	// Only create event if AFK period is significant
	if afkSeconds < e.minAFKSeconds {
		return
	}

	// Check if AFK ended at round end
	roundEndTick, endedAtRoundEnd := e.roundEndTicks[state.roundIndex]
	isRoundEnd := endedAtRoundEnd && endTick == roundEndTick
	
	// Filter out AFK periods that end at round end if they started too close to round end
	// This prevents flagging players who are just holding a position at the end of a round
	if isRoundEnd {
		// Calculate how long before round end the AFK started
		timeBeforeRoundEnd := float64(roundEndTick-*state.afkStartTick) / e.tickRate
		
		// If AFK started within the last 10 seconds of the round, it's likely just holding position
		// Filter it out unless it's a very long AFK period (15+ seconds)
		if timeBeforeRoundEnd < 10.0 && afkSeconds < 15.0 {
			// Skip this AFK event - likely false positive
			return
		}
	}

	// Determine how AFK ended and calculate timeToFirstMovement
	diedWhileAFK := state.deathTick != nil && *state.deathTick == endTick
	var timeToFirstMovement *float64
	if state.firstMovementTick != nil && *state.firstMovementTick == endTick {
		// AFK ended due to movement
		timeToFirstMovementVal := float64(*state.firstMovementTick - *state.afkStartTick) / e.tickRate
		timeToFirstMovement = &timeToFirstMovementVal
	}

	// Build metadata (matching cs2-web-replay format)
	meta := make(map[string]interface{})
	meta["seconds"] = afkSeconds
	meta["afkDuration"] = afkSeconds // Also include as afkDuration for consistency
	meta["start_tick"] = *state.afkStartTick
	meta["end_tick"] = endTick
	meta["diedWhileAFK"] = diedWhileAFK
	if timeToFirstMovement != nil {
		meta["timeToFirstMovement"] = *timeToFirstMovement
	}

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	actorSteamID := &state.steamID
	severity := math.Min(afkSeconds/60.0, 1.0) // Scale by 60 seconds, cap at 1.0

	e.events = append(e.events, Event{
		Type:         "AFK_STILLNESS",
		RoundIndex:   state.roundIndex,
		StartTick:    *state.afkStartTick,
		EndTick:      &endTick,
		ActorSteamID: actorSteamID,
		Severity:     severity,
		Confidence:   0.8, // AFK detection has some uncertainty
		MetaJSON:     &metaJSONStr,
	})

	// Reset AFK tracking
	state.afkStartTick = nil
}

// GetEvents returns all extracted events.
func (e *AFKExtractor) GetEvents() []Event {
	return e.events
}

