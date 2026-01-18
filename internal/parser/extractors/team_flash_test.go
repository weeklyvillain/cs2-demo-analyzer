package extractors

import (
	"testing"
)

func TestTeamFlashMerge(t *testing.T) {
	extractor := NewTeamFlashExtractor()

	// Simulate multiple teammates flashed from same flash
	// Round 0, flasher "1", flash tick 1000 (grouped)
	key := "0_1_1000"
	pending := &pendingFlash{
		roundIndex:    0,
		flasherSteamID: "1",
		flashTick:     1000,
		victims:       make([]flashVictim, 0),
	}
	extractor.pending[key] = pending

	// Add multiple victims
	pending.victims = append(pending.victims, flashVictim{
		SteamID:  "2",
		Duration: 3.0,
	})
	pending.victims = append(pending.victims, flashVictim{
		SteamID:  "3",
		Duration: 2.5,
	})
	pending.victims = append(pending.victims, flashVictim{
		SteamID:  "4",
		Duration: 4.0,
	})

	// Finalize
	extractor.finalizePending(key, pending)

	events := extractor.GetEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 merged event, got %d", len(events))
	}

	event := events[0]
	if event.Type != "TEAM_FLASH" {
		t.Errorf("expected type TEAM_FLASH, got %s", event.Type)
	}
	if event.StartTick != 1000 {
		t.Errorf("expected start tick 1000, got %d", event.StartTick)
	}
	if len(pending.victims) != 3 {
		t.Errorf("expected 3 victims, got %d", len(pending.victims))
	}

	// Check severity calculation
	// Total blind: 3.0 + 2.5 + 4.0 = 9.5 seconds
	// Victims: 3
	// Severity = min(9.5 / 3 / 5.0, 1.0) = min(0.633, 1.0) = 0.633
	expectedSeverity := 9.5 / 3.0 / 5.0
	if event.Severity < expectedSeverity-0.01 || event.Severity > expectedSeverity+0.01 {
		t.Errorf("expected severity ~%.3f, got %.3f", expectedSeverity, event.Severity)
	}
}

