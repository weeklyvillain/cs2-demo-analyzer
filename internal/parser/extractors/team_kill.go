package extractors

import (
	"encoding/json"
	"math"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

// TeamKillExtractor extracts team kill events from PlayerDeath events.
type TeamKillExtractor struct {
	events []Event
}

// NewTeamKillExtractor creates a new team kill extractor.
func NewTeamKillExtractor() *TeamKillExtractor {
	return &TeamKillExtractor{
		events: make([]Event, 0),
	}
}

// HandlePlayerDeath processes a Kill event and extracts team kills.
func (e *TeamKillExtractor) HandlePlayerDeath(event events.Kill, roundIndex int, tick int) {
	attacker := event.Killer
	victim := event.Victim

	// Skip if attacker is nil or unknown
	if attacker == nil {
		return
	}

	// Check if this is a team kill
	if !isTeamKill(attacker, victim) {
		return
	}

	// Build metadata
	meta := make(map[string]interface{})

	// Weapon
	if event.Weapon != nil {
		weaponType := event.Weapon.Type
		if weaponType != common.EqUnknown {
			meta["weapon"] = weaponType.String()
		} else {
			meta["weapon"] = event.Weapon.String()
		}
	}

	// Headshot
	if event.IsHeadshot {
		meta["headshot"] = true
	}

	// Distance (if available)
	// Position() returns r3.Vector (value type, not pointer)
	attackerPos := attacker.Position()
	victimPos := victim.Position()
	// Check if positions are valid (non-zero vectors)
	if attackerPos.X != 0 || attackerPos.Y != 0 || attackerPos.Z != 0 {
		if victimPos.X != 0 || victimPos.Y != 0 || victimPos.Z != 0 {
			dx := attackerPos.X - victimPos.X
			dy := attackerPos.Y - victimPos.Y
			dz := attackerPos.Z - victimPos.Z
			// Calculate Euclidean distance in game units
			distance := math.Sqrt(float64(dx*dx + dy*dy + dz*dz))
			meta["distance"] = distance
		}
	}

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	actorSteamID := getSteamID(attacker)
	victimSteamID := getSteamID(victim)

	e.events = append(e.events, Event{
		Type:          "TEAM_KILL",
		RoundIndex:    roundIndex,
		StartTick:     tick,
		EndTick:       nil,
		ActorSteamID:  actorSteamID,
		VictimSteamID: victimSteamID,
		Severity:      0.8,
		Confidence:    1.0,
		MetaJSON:      &metaJSONStr,
	})
}

// GetEvents returns all extracted events.
func (e *TeamKillExtractor) GetEvents() []Event {
	return e.events
}

