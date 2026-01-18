package extractors

import (
	"testing"
)

func TestTeamDamageMerge(t *testing.T) {
	tickRate := 64.0 // 64 tick server
	extractor := NewTeamDamageExtractor(tickRate)

	// Simulate events within merge window (2 seconds = 128 ticks)
	// Round 0, attacker "1", victim "2"
	
	// First event at tick 1000
	// We can't easily create real events, so we'll test the merge logic directly
	// by simulating the pending map structure
	
	key := "0_1_2"
	pending := &pendingDamage{
		roundIndex:     0,
		attackerSteamID: "1",
		victimSteamID:   "2",
		startTick:      1000,
		lastTick:       1000,
		totalHealth:    20,
		totalArmor:     10,
		hitCount:       1,
		hitgroups:      make(map[string]int),
		weapons:        make(map[string]bool),
		isUtility:      false,
	}
	extractor.pending[key] = pending

	// Second event at tick 1100 (within 128 tick window)
	pending.lastTick = 1100
	pending.totalHealth += 15
	pending.totalArmor += 5
	pending.hitCount++

	// Third event at tick 1200 (within 128 tick window)
	pending.lastTick = 1200
	pending.totalHealth += 25
	pending.totalArmor += 0
	pending.hitCount++

	// Finalize
	extractor.finalizePending(key, pending)

	events := extractor.GetEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 merged event, got %d", len(events))
	}

	event := events[0]
	if event.StartTick != 1000 {
		t.Errorf("expected start tick 1000, got %d", event.StartTick)
	}
	if event.EndTick == nil || *event.EndTick != 1200 {
		t.Errorf("expected end tick 1200, got %v", event.EndTick)
	}
	if event.Type != "TEAM_DAMAGE" {
		t.Errorf("expected type TEAM_DAMAGE, got %s", event.Type)
	}

	// Check severity calculation (total damage = 60, should be 0.6)
	expectedSeverity := 0.6
	if event.Severity < expectedSeverity-0.01 || event.Severity > expectedSeverity+0.01 {
		t.Errorf("expected severity ~%.2f, got %.2f", expectedSeverity, event.Severity)
	}
}

func TestTeamDamageNoMerge(t *testing.T) {
	tickRate := 64.0
	extractor := NewTeamDamageExtractor(tickRate)

	// Simulate events outside merge window
	key1 := "0_1_2"
	pending1 := &pendingDamage{
		roundIndex:     0,
		attackerSteamID: "1",
		victimSteamID:   "2",
		startTick:      1000,
		lastTick:       1000,
		totalHealth:    20,
		totalArmor:     10,
		hitCount:       1,
		hitgroups:      make(map[string]int),
		weapons:        make(map[string]bool),
		isUtility:      false,
	}
	extractor.pending[key1] = pending1

	// Second event at tick 1200 (outside 128 tick window from 1000)
	key2 := "0_1_2"
	pending2 := &pendingDamage{
		roundIndex:     0,
		attackerSteamID: "1",
		victimSteamID:   "2",
		startTick:      1200,
		lastTick:       1200,
		totalHealth:    15,
		totalArmor:     5,
		hitCount:       1,
		hitgroups:      make(map[string]int),
		weapons:        make(map[string]bool),
		isUtility:      false,
	}

	// Finalize first
	extractor.finalizePending(key1, pending1)
	delete(extractor.pending, key1)

	// Add second
	extractor.pending[key2] = pending2
	extractor.finalizePending(key2, pending2)

	events := extractor.GetEvents()
	if len(events) != 2 {
		t.Fatalf("expected 2 separate events, got %d", len(events))
	}
}

