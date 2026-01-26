package extractors

import (
	"encoding/json"
	"math"

	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

// TeamFlashExtractor extracts team flash events from flash/blind events.
// Creates individual events per thrower-victim pair (similar to cs2-web-replay).
type TeamFlashExtractor struct {
	events []Event
}

// NewTeamFlashExtractor creates a new team flash extractor.
func NewTeamFlashExtractor() *TeamFlashExtractor {
	return &TeamFlashExtractor{
		events: make([]Event, 0),
	}
}

// HandlePlayerFlashed processes a flash/blind event and accumulates team flashes.
func (e *TeamFlashExtractor) HandlePlayerFlashed(event events.PlayerFlashed, roundIndex int, tick int) {
	attacker := event.Attacker
	victim := event.Player

	// Skip if attacker is nil or unknown
	if attacker == nil {
		return
	}

	// Check if this is a team flash (not self-flash)
	if !isTeamKill(attacker, victim) {
		return
	}

	flasherSteamID := getSteamID(attacker)
	victimSteamID := getSteamID(victim)
	if flasherSteamID == nil || victimSteamID == nil {
		return
	}

	// Get flash duration from event
	// In demoinfocs-golang v5, PlayerFlashed has a FlashDuration() method
	// that returns a time.Duration (nanoseconds), which we convert to seconds
	duration := 0.0

	// Try to get flash duration from the event
	// PlayerFlashed event should have FlashDuration() method
	flashDuration := event.FlashDuration()
	if flashDuration > 0 {
		// Convert time.Duration to seconds (float64)
		duration = flashDuration.Seconds()
	} else {
		// Fallback: estimate based on typical flash duration (2-5 seconds)
		// Most flashes last 2-4 seconds, use 3.0 as default
		duration = 3.0
	}

	// Filter out very short flashes (< 1 second) as they're not significant team flashes
	// This matches cs2-web-replay's approach
	if duration < 1.0 {
		return
	}

	// Create individual event per thrower-victim pair (like cs2-web-replay)
	// This makes it easier to display in the UI and matches the expected data structure
	meta := make(map[string]interface{})
	meta["blind_duration"] = duration

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	// Calculate severity: scale by flash duration, cap at 1.0
	// 5 seconds = 1.0 severity
	severity := math.Min(duration/5.0, 1.0)

	e.events = append(e.events, Event{
		Type:          "TEAM_FLASH",
		RoundIndex:    roundIndex,
		StartTick:     tick,
		EndTick:       nil,
		ActorSteamID:  flasherSteamID,
		VictimSteamID: victimSteamID, // Individual victim per event
		Severity:      severity,
		Confidence:    1.0,
		MetaJSON:      &metaJSONStr,
	})
}

// FinalizeRound finalizes all pending flash events for a round.
// No-op for this extractor since we create events immediately.
func (e *TeamFlashExtractor) FinalizeRound(roundIndex int) {
	// Events are created immediately, no pending state to finalize
}

// GetEvents returns all extracted events.
func (e *TeamFlashExtractor) GetEvents() []Event {
	return e.events
}

// ClearEvents clears all extracted events from memory.
func (e *TeamFlashExtractor) ClearEvents() {
	e.events = e.events[:0]
}
