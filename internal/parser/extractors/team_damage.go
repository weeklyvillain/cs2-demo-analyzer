package extractors

import (
	"encoding/json"
	"fmt"
	"math"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

// TeamDamageExtractor extracts team damage events from PlayerHurt events.
// It merges events within a time window (2 seconds).
type TeamDamageExtractor struct {
	pending  map[string]*pendingDamage // key: roundIndex_attackerSteamID_victimSteamID
	tickRate float64
	events   []Event
}

type pendingDamage struct {
	roundIndex      int
	attackerSteamID string
	victimSteamID   string
	startTick       int
	lastTick        int
	totalHealth     int
	totalArmor      int
	hitCount        int
	hitgroups       map[string]int  // hitgroup -> count
	weapons         map[string]bool // weapon -> exists
	isUtility       bool
}

// NewTeamDamageExtractor creates a new team damage extractor.
func NewTeamDamageExtractor(tickRate float64) *TeamDamageExtractor {
	return &TeamDamageExtractor{
		pending:  make(map[string]*pendingDamage),
		tickRate: tickRate,
		events:   make([]Event, 0),
	}
}

// HandlePlayerHurt processes a PlayerHurt event and accumulates team damage.
func (e *TeamDamageExtractor) HandlePlayerHurt(event events.PlayerHurt, roundIndex int, tick int) {
	attacker := event.Attacker
	victim := event.Player

	// Skip if attacker is nil or unknown
	if attacker == nil || victim == nil {
		return
	}

	// Skip self-damage
	if isSamePlayer(attacker, victim) {
		return
	}

	// Check if this is team damage (same team, different players)
	if !isSameTeam(attacker, victim) {
		return
	}

	attackerSteamID := getSteamID(attacker)
	victimSteamID := getSteamID(victim)
	if attackerSteamID == nil || victimSteamID == nil {
		return
	}

	key := fmt.Sprintf("%d_%s_%s", roundIndex, *attackerSteamID, *victimSteamID)

	// Check if we have a pending event within the merge window
	mergeWindowTicks := int(e.tickRate * 2.0) // 2 seconds
	pending, exists := e.pending[key]

	if exists && (tick-pending.lastTick) <= mergeWindowTicks {
		// Merge into existing pending event
		pending.lastTick = tick
		pending.totalHealth += event.HealthDamage
		pending.totalArmor += event.ArmorDamage
		pending.hitCount++

		// Track hitgroups (HitGroup is an enum, 0 is generic/unknown)
		if event.HitGroup != 0 {
			hitgroupStr := fmt.Sprintf("%d", int(event.HitGroup))
			pending.hitgroups[hitgroupStr]++
		}

		// Track weapons
		if event.Weapon != nil {
			weaponType := event.Weapon.Type
			if weaponType != common.EqUnknown {
				weaponStr := weaponType.String()
				pending.weapons[weaponStr] = true
			} else {
				weaponStr := event.Weapon.String()
				pending.weapons[weaponStr] = true
			}
		}

		// Check if utility
		if event.Weapon != nil {
			weaponType := event.Weapon.Type
			weaponTypeStr := weaponType.String()
			if weaponTypeStr == "HE Grenade" || weaponTypeStr == "Flashbang" || weaponTypeStr == "Smoke Grenade" || weaponTypeStr == "Molotov" || weaponTypeStr == "Incendiary Grenade" {
				pending.isUtility = true
			}
		}
	} else {
		// Create new pending event or finalize old one
		if exists {
			// Finalize old event
			e.finalizePending(key, pending)
		}

		// Create new pending event
		hitgroups := make(map[string]int)
		if event.HitGroup != 0 {
			hitgroupStr := fmt.Sprintf("%d", int(event.HitGroup))
			hitgroups[hitgroupStr] = 1
		}

		weapons := make(map[string]bool)
		if event.Weapon != nil {
			weaponType := event.Weapon.Type
			if weaponType != common.EqUnknown {
				weapons[weaponType.String()] = true
			} else {
				weapons[event.Weapon.String()] = true
			}
		}

		isUtility := false
		if event.Weapon != nil {
			weaponType := event.Weapon.Type
			weaponTypeStr := weaponType.String()
			if weaponTypeStr == "HE Grenade" || weaponTypeStr == "Flashbang" || weaponTypeStr == "Smoke Grenade" || weaponTypeStr == "Molotov" || weaponTypeStr == "Incendiary Grenade" {
				isUtility = true
			}
		}

		e.pending[key] = &pendingDamage{
			roundIndex:      roundIndex,
			attackerSteamID: *attackerSteamID,
			victimSteamID:   *victimSteamID,
			startTick:       tick,
			lastTick:        tick,
			totalHealth:     event.HealthDamage,
			totalArmor:      event.ArmorDamage,
			hitCount:        1,
			hitgroups:       hitgroups,
			weapons:         weapons,
			isUtility:       isUtility,
		}
	}
}

// FinalizeRound finalizes all pending damage events for a round.
func (e *TeamDamageExtractor) FinalizeRound(roundIndex int) {
	keysToFinalize := make([]string, 0)
	for key, pending := range e.pending {
		if pending.roundIndex == roundIndex {
			keysToFinalize = append(keysToFinalize, key)
		}
	}

	for _, key := range keysToFinalize {
		e.finalizePending(key, e.pending[key])
		delete(e.pending, key)
	}
}

func (e *TeamDamageExtractor) finalizePending(key string, pending *pendingDamage) {
	// Build metadata
	meta := make(map[string]interface{})
	meta["dmg_health"] = pending.totalHealth
	meta["dmg_armor"] = pending.totalArmor
	totalDamage := float64(pending.totalHealth + pending.totalArmor)
	meta["total_damage"] = totalDamage
	meta["hit_count"] = pending.hitCount
	meta["is_utility"] = pending.isUtility

	if len(pending.hitgroups) > 0 {
		meta["hitgroups"] = pending.hitgroups
	}

	if len(pending.weapons) > 0 {
		weaponsList := make([]string, 0, len(pending.weapons))
		for weapon := range pending.weapons {
			weaponsList = append(weaponsList, weapon)
		}
		meta["weapon"] = weaponsList
	}

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	actorSteamID := &pending.attackerSteamID
	victimSteamID := &pending.victimSteamID
	endTick := pending.lastTick

	// Calculate severity: scale by total damage, cap at 1.0
	// Assuming 100 damage = 1.0 severity
	severity := math.Min(totalDamage/100.0, 1.0)

	e.events = append(e.events, Event{
		Type:          "TEAM_DAMAGE",
		RoundIndex:    pending.roundIndex,
		StartTick:     pending.startTick,
		EndTick:       &endTick,
		ActorSteamID:  actorSteamID,
		VictimSteamID: victimSteamID,
		Severity:      severity,
		Confidence:    1.0,
		MetaJSON:      &metaJSONStr,
	})
}

// GetEvents returns all extracted events.
func (e *TeamDamageExtractor) GetEvents() []Event {
	return e.events
}

// ClearEvents clears all extracted events from memory.
func (e *TeamDamageExtractor) ClearEvents() {
	e.events = e.events[:0]
}
