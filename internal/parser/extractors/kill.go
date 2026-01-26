package extractors

import (
	"encoding/json"
	"math"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

// KillExtractor extracts regular kill events (enemy kills, not team kills).
// Team kills are handled by TeamKillExtractor to avoid duplicates.
type KillExtractor struct {
	events []Event
}

// NewKillExtractor creates a new kill extractor.
func NewKillExtractor() *KillExtractor {
	return &KillExtractor{
		events: make([]Event, 0),
	}
}

// HandlePlayerDeath processes a Kill event and extracts regular kills (skips team kills).
func (e *KillExtractor) HandlePlayerDeath(event events.Kill, roundIndex int, tick int) {
	attacker := event.Killer
	victim := event.Victim

	// Skip if attacker is nil or unknown
	if attacker == nil || victim == nil {
		return
	}

	// Skip suicides (killer is the same as victim)
	if attacker.SteamID64 == victim.SteamID64 {
		return
	}

	// Skip team kills - those are handled by TeamKillExtractor
	// This extractor only handles regular kills (enemy kills)
	if isTeamKill(attacker, victim) {
		return
	}

	eventType := "KILL"

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
		Type:          eventType,
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
func (e *KillExtractor) GetEvents() []Event {
	return e.events
}

// ClearEvents clears all extracted events from memory.
func (e *KillExtractor) ClearEvents() {
	e.events = e.events[:0]
}
