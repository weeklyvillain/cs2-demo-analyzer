package extractors

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
)

type BodyBlockExtractor struct {
	db         *sql.DB
	tickRate   float64
	minSeconds float64
	events     []Event
}

type bodyBlockPosition struct {
	steamID string
	team    string
	x       float64
	y       float64
	z       float64
}

type bodyBlockState struct {
	startTick  int
	lastTick   int
	totalTicks int
	sumDistXY  float64
	sumZDelta  float64
	minDistXY  float64
}

func NewBodyBlockExtractor(tickRate float64, db *sql.DB) *BodyBlockExtractor {
	return &BodyBlockExtractor{
		db:         db,
		tickRate:   tickRate,
		minSeconds: 0.5,
		events:     make([]Event, 0),
	}
}

func (e *BodyBlockExtractor) GetEvents() []Event {
	return e.events
}

func (e *BodyBlockExtractor) ClearEvents() {
	e.events = e.events[:0]
}

// ProcessRoundFromDatabase detects players standing on top of teammates within a round.
// It requires player_positions to be available in the database.
func (e *BodyBlockExtractor) ProcessRoundFromDatabase(matchID string, roundIndex int, startTick int, endTick int) {
	if e.db == nil || matchID == "" {
		return
	}

	// Thresholds tuned for head-stacking detection
	const (
		maxXYDistance = 24.0
		minZDelta     = 40.0
		maxZDelta     = 90.0
	)

	query := `
		SELECT tick, steamid, x, y, z, team
		FROM player_positions
		WHERE match_id = ? AND round_index = ? AND tick BETWEEN ? AND ?
		ORDER BY tick
	`

	rows, err := e.db.Query(query, matchID, roundIndex, startTick, endTick)
	if err != nil {
		return
	}
	defer rows.Close()

	active := make(map[string]*bodyBlockState)

	currentTick := -1
	positions := make([]bodyBlockPosition, 0, 16)

	flushTick := func(tick int, positions []bodyBlockPosition) {
		if tick < 0 || len(positions) < 2 {
			return
		}

		present := make(map[string]bodyBlockState)

		maxXYDistanceSq := maxXYDistance * maxXYDistance

		for i := 0; i < len(positions); i++ {
			for j := i + 1; j < len(positions); j++ {
				p1 := positions[i]
				p2 := positions[j]

				if p1.steamID == p2.steamID || p1.team == "" || p2.team == "" || p1.team != p2.team {
					continue
				}

				dx := p1.x - p2.x
				dy := p1.y - p2.y
				distSq := dx*dx + dy*dy
				if distSq > maxXYDistanceSq {
					continue
				}

				zDelta := p1.z - p2.z
				if math.Abs(zDelta) < minZDelta || math.Abs(zDelta) > maxZDelta {
					continue
				}

				var top, bottom bodyBlockPosition
				if zDelta > 0 {
					top = p1
					bottom = p2
				} else {
					top = p2
					bottom = p1
					zDelta = -zDelta
				}

				distXY := math.Sqrt(distSq)
				key := fmt.Sprintf("%s_%s", top.steamID, bottom.steamID)

				present[key] = bodyBlockState{
					startTick:  tick,
					lastTick:   tick,
					totalTicks: 1,
					sumDistXY:  distXY,
					sumZDelta:  zDelta,
					minDistXY:  distXY,
				}
			}
		}

		// Update active pairs
		for key, state := range active {
			if presentState, ok := present[key]; ok {
				state.lastTick = tick
				state.totalTicks++
				state.sumDistXY += presentState.sumDistXY
				state.sumZDelta += presentState.sumZDelta
				if presentState.minDistXY < state.minDistXY {
					state.minDistXY = presentState.minDistXY
				}
				delete(present, key)
			} else {
				e.finalizePair(key, state, roundIndex)
				delete(active, key)
			}
		}

		for key, state := range present {
			active[key] = &bodyBlockState{
				startTick:  state.startTick,
				lastTick:   state.lastTick,
				totalTicks: state.totalTicks,
				sumDistXY:  state.sumDistXY,
				sumZDelta:  state.sumZDelta,
				minDistXY:  state.minDistXY,
			}
		}
	}

	for rows.Next() {
		var tick int
		var steamID string
		var x, y, z float64
		var team string

		if err := rows.Scan(&tick, &steamID, &x, &y, &z, &team); err != nil {
			continue
		}

		if currentTick == -1 {
			currentTick = tick
		}

		if tick != currentTick {
			flushTick(currentTick, positions)
			positions = positions[:0]
			currentTick = tick
		}

		positions = append(positions, bodyBlockPosition{
			steamID: steamID,
			team:    team,
			x:       x,
			y:       y,
			z:       z,
		})
	}

	if len(positions) > 0 {
		flushTick(currentTick, positions)
	}

	for key, state := range active {
		e.finalizePair(key, state, roundIndex)
		delete(active, key)
	}
}

func (e *BodyBlockExtractor) finalizePair(key string, state *bodyBlockState, roundIndex int) {
    if state.totalTicks <= 0 {
		fmt.Fprintf(os.Stderr, "[BODY_BLOCK] Skip pair %s (round %d): totalTicks=%d\n", key, roundIndex, state.totalTicks)
        return
    }

    seconds := float64(state.totalTicks) / e.tickRate
    if seconds < e.minSeconds {
		fmt.Fprintf(os.Stderr, "[BODY_BLOCK] Skip pair %s (round %d): seconds=%.2f < minSeconds=%.2f\n", key, roundIndex, seconds, e.minSeconds)
        return
    }

    parts := strings.SplitN(key, "_", 2)
    if len(parts) != 2 {
		fmt.Fprintf(os.Stderr, "[BODY_BLOCK] Skip pair %s (round %d): invalid key\n", key, roundIndex)
        return
    }
    actorSteamID := parts[0]
    victimSteamID := parts[1]

    avgDistXY := state.sumDistXY / float64(state.totalTicks)
    avgZDelta := state.sumZDelta / float64(state.totalTicks)

    severity := math.Min(1.0, seconds/5.0)
    confidence := math.Min(1.0, 0.5+(seconds/5.0))

    meta := map[string]interface{}{
        "seconds":         seconds,
        "stacked_ticks":   state.totalTicks,
        "min_xy_distance": state.minDistXY,
        "avg_xy_distance": avgDistXY,
        "avg_z_delta":     avgZDelta,
    }

    metaJSON, _ := json.Marshal(meta)
    metaJSONStr := string(metaJSON)

    startTick := state.startTick
    endTick := state.lastTick

    e.events = append(e.events, Event{
        Type:          "BODY_BLOCK",
        RoundIndex:    roundIndex,
        StartTick:     startTick,
        EndTick:       &endTick,
        ActorSteamID:  &actorSteamID,
        VictimSteamID: &victimSteamID,
        Severity:      severity,
        Confidence:    confidence,
        MetaJSON:      &metaJSONStr,
    })

	fmt.Fprintf(os.Stderr, "[BODY_BLOCK] Detected round %d: actor=%s victim=%s seconds=%.2f ticks=%d minXY=%.2f avgXY=%.2f avgZ=%.2f startTick=%d endTick=%d\n",
		roundIndex, actorSteamID, victimSteamID, seconds, state.totalTicks, state.minDistXY, avgDistXY, avgZDelta, startTick, endTick)
}