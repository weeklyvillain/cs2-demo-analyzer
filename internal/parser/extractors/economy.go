package extractors

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

// EconomyExtractor detects economy griefing patterns based on player money and spending behavior.
// It analyzes each player's buy decisions compared to their team to identify griefing.
type EconomyExtractor struct {
	events []Event
}

// NewEconomyExtractor creates a new economy griefing extractor.
func NewEconomyExtractor() *EconomyExtractor {
	return &EconomyExtractor{
		events: make([]Event, 0),
	}
}

// PlayerEconomySnapshot captures a player's economy state at freeze time end.
type PlayerEconomySnapshot struct {
	SteamID         string
	Team            common.Team
	Money           int
	MoneySpent      int
	StartRoundMoney int // Money at round start (before buying)
	PrimaryWeapon   string
	AllWeapons      []string // All equipped weapons
	EquipmentValue  int      // Total value of current equipment
}

// HandleFreezeTimeEnd analyzes player economies at the end of freeze time (after buy phase).
// This is called once per round to detect economy griefing patterns.
func (e *EconomyExtractor) HandleFreezeTimeEnd(roundIndex int, tick int, players []*common.Player) {
	if len(players) == 0 {
		return
	}

	// Group players by team
	teamSnapshots := make(map[common.Team][]PlayerEconomySnapshot)

	for _, player := range players {
		if player == nil {
			continue
		}

		// Skip spectators and unassigned
		if player.Team == common.TeamSpectators || player.Team == common.TeamUnassigned {
			continue
		}

		steamID := getSteamID(player)
		if steamID == nil {
			continue
		}

		// Get primary weapon and equipment value
		primaryWeapon := ""
		var allWeapons []string
		equipmentValue := 0
		
		for _, weapon := range player.Weapons() {
			if weapon == nil {
				continue
			}
			weaponName := weapon.String()
			allWeapons = append(allWeapons, weaponName)
			equipmentValue += weapon.AmmoReserve() // Rough approximation
			
			// Identify primary weapon
			if weapon.Class() == common.EqClassRifle || weapon.Class() == common.EqClassSMG || weapon.Class() == common.EqClassHeavy {
				primaryWeapon = weaponName
			}
		}

		snapshot := PlayerEconomySnapshot{
			SteamID:         *steamID,
			Team:            player.Team,
			Money:           player.Money(),
			MoneySpent:      player.MoneySpentThisRound(),
			StartRoundMoney: player.Money() + player.MoneySpentThisRound(),
			PrimaryWeapon:   primaryWeapon,
			AllWeapons:      allWeapons,
			EquipmentValue:  equipmentValue,
		}

		teamSnapshots[player.Team] = append(teamSnapshots[player.Team], snapshot)
	}

	// Run detection for each team
	for team, snapshots := range teamSnapshots {
		if len(snapshots) > 0 {
			e.detectEconomyGriefing(roundIndex, tick, team, snapshots)
		}
	}
}

// detectEconomyGriefing identifies players with suspicious economy behavior.
func (e *EconomyExtractor) detectEconomyGriefing(roundIndex int, tick int, team common.Team, snapshots []PlayerEconomySnapshot) {
	// Calculate team statistics
	var totalStartMoney int
	var totalSpent int
	var avgStartMoney float64
	var avgSpent float64
	
	// Count weapon types
	rifleCount := 0
	smgCount := 0
	pistolOnlyCount := 0

	for _, s := range snapshots {
		totalStartMoney += s.StartRoundMoney
		totalSpent += s.MoneySpent
		
		// Classify weapons
		weapon := s.PrimaryWeapon
		if isRifle(weapon) {
			rifleCount++
		} else if isSMG(weapon) {
			smgCount++
		} else if weapon == "" || isPistol(weapon) {
			pistolOnlyCount++
		}
	}

	avgStartMoney = float64(totalStartMoney) / float64(len(snapshots))
	avgSpent = float64(totalSpent) / float64(len(snapshots))
	teamSpendPct := avgSpent / avgStartMoney

	// Calculate team average remaining money once per team
	var totalRemaining int
	for _, s := range snapshots {
		totalRemaining += s.Money
	}
	avgRemaining := float64(totalRemaining) / float64(len(snapshots))
	
	// Determine majority weapon type
	majorityWeaponType := "other"
	maxCount := 0
	if rifleCount > maxCount {
		maxCount = rifleCount
		majorityWeaponType = "rifle"
	}
	if smgCount > maxCount {
		maxCount = smgCount
		majorityWeaponType = "smg"
	}
	if pistolOnlyCount > maxCount {
		maxCount = pistolOnlyCount
		majorityWeaponType = "pistol"
	}
	
	// Check each player for griefing behavior
	for _, snapshot := range snapshots {
		spendPct := 0.0
		if snapshot.StartRoundMoney > 0 {
			spendPct = float64(snapshot.MoneySpent) / float64(snapshot.StartRoundMoney)
		}

		// Detect griefing patterns
		var isGriefing bool
		var griefType string
		var severity float64
		var confidence float64

		// Determine player's weapon type
		playerWeaponType := "other"
		if isRifle(snapshot.PrimaryWeapon) {
			playerWeaponType = "rifle"
		} else if isSMG(snapshot.PrimaryWeapon) {
			playerWeaponType = "smg"
		} else if isPistol(snapshot.PrimaryWeapon) {
			playerWeaponType = "pistol"
		}

		// Weapon hierarchy values (higher is better)
		weaponValue := map[string]int{
			"rifle":  3,
			"smg":    2,
			"pistol": 1,
			"other":  0,
		}

		// Calculate remaining money alignment with team average
		remainingDiffPct := 0.0
		if avgRemaining > 0 {
			remainingDiff := math.Abs(float64(snapshot.Money) - avgRemaining)
			remainingDiffPct = remainingDiff / avgRemaining
		}

		// If remaining money is within 15% of team average, they evened out the economy (likely legitimate)
		evenedOut := avgRemaining > 0 && remainingDiffPct < 0.15

		// Pattern 1: Equipment mismatch (bought WORSE weapon than team majority)
		// Only flag if player bought a cheaper/worse weapon AND spent significantly less than team
		playerValue := weaponValue[playerWeaponType]
		majorityValue := weaponValue[majorityWeaponType]
		spendDifference := teamSpendPct - spendPct
		
		if playerValue < majorityValue && playerWeaponType != "other" && majorityWeaponType != "other" &&
			snapshot.StartRoundMoney > 3000 && snapshot.MoneySpent > 1500 && spendDifference > 0.25 && !evenedOut {
			fmt.Fprintf(os.Stderr, "[ECONOMY]     ✓ Pattern 1: Equipment mismatch (%s %s when team majority is %s, $%d spent vs team avg $%d, diff %.1f%%)\n",
				playerWeaponType, snapshot.PrimaryWeapon, majorityWeaponType, snapshot.MoneySpent, int(avgSpent), spendDifference*100.0)
			isGriefing = true
			griefType = "equipment_mismatch"
			severity = 0.75
			confidence = 0.85
		}

		// Pattern 2: Not buying with team (accounting for saved equipment)
		// Consider "good weapon" if they have a rifle/SMG as primary OR if they have a saved rifle/SMG (low spend + rifle/SMG in inventory)
		hasGoodWeapon := isRifle(snapshot.PrimaryWeapon) || (isSMG(snapshot.PrimaryWeapon) && majorityWeaponType == "smg")
		hasSavedWeapon := snapshot.MoneySpent < 1000 && hasRifleOrSMGInInventory(snapshot.AllWeapons)
		if hasSavedWeapon {
			hasGoodWeapon = true
		}
		spendDifference = teamSpendPct - spendPct
		
		if !isGriefing && !hasGoodWeapon && teamSpendPct > 0.4 && spendPct < 0.25 && snapshot.StartRoundMoney > 2000 && spendDifference > 0.25 && !evenedOut {
			fmt.Fprintf(os.Stderr, "[ECONOMY]     ✓ Pattern 2: Not buying with team (team %.1f%%, player %.1f%%, diff %.1f%%, remaining diff %.1f%%, no proper weapon)\n",
				teamSpendPct*100.0, spendPct*100.0, spendDifference*100.0, remainingDiffPct*100.0)
			isGriefing = true
			griefType = "no_buy_with_team"
			potentialSpend := float64(snapshot.StartRoundMoney)
			severity = math.Min(1.0, potentialSpend/5000.0) * 0.7
			deviation := spendDifference
			confidence = math.Min(1.0, deviation*2.0) * 0.8
		}

		// Pattern 3: Excessive saving (keeping >$6000 while team has low money)
		if !isGriefing && snapshot.Money > 6000 && avgStartMoney < 5000 && teamSpendPct > 0.25 {
			fmt.Fprintf(os.Stderr, "[ECONOMY]     ✓ Pattern 3: Excessive saving ($%d remaining, team avg $%d)\n",
				snapshot.Money, int(avgStartMoney))
			isGriefing = true
			griefType = "excessive_saving"
			excessMoney := float64(snapshot.Money - 3000)
			severity = math.Min(1.0, excessMoney/10000.0) * 0.6
			teamPoverty := 1.0 - (avgStartMoney / 8000.0)
			confidence = math.Min(1.0, teamPoverty*1.5) * 0.7
		}

		// Pattern 4: Full save with high money
		if !isGriefing && snapshot.StartRoundMoney > 8000 && snapshot.MoneySpent < 800 && teamSpendPct > 0.5 && !hasGoodWeapon {
			fmt.Fprintf(os.Stderr, "[ECONOMY]     ✓ Pattern 4: Full save with high money ($%d start, $%d spent, team %.1f%%)\n",
				snapshot.StartRoundMoney, snapshot.MoneySpent, teamSpendPct*100.0)
			isGriefing = true
			griefType = "full_save_high_money"
			severity = 0.8
			confidence = 0.85
		}

		if isGriefing {
			fmt.Fprintf(os.Stderr, "[ECONOMY]     → DETECTED: %s (severity=%.2f, confidence=%.2f)\n",
				griefType, severity, confidence)
			
			// Determine which weapons were likely bought vs saved
			weaponDetails := make([]map[string]interface{}, 0)
			for _, weapon := range snapshot.AllWeapons {
				// Skip utility/economy items not typically bought
				if !isRelevantWeapon(weapon) {
					continue
				}
				
				// Estimate if weapon was bought or saved based on spend
				// High spend (>$2000) = likely bought expensive weapons
				// Low spend (<$800) = likely saved weapons
				var estimatedPurchase string
				if snapshot.MoneySpent > 2000 && (isRifle(weapon) || weapon == "AWP") {
					estimatedPurchase = "bought"
				} else if snapshot.MoneySpent < 800 && (isRifle(weapon) || isSMG(weapon)) {
					estimatedPurchase = "saved"
				} else if snapshot.MoneySpent < 1000 {
					estimatedPurchase = "saved"
				} else {
					estimatedPurchase = "likely_bought"
				}
				
				weaponDetails = append(weaponDetails, map[string]interface{}{
					"name":      weapon,
					"purchase":  estimatedPurchase,
				})
			}
			
			// Include other team members' weapons
			otherPlayers := make([]map[string]interface{}, 0)
			for _, s := range snapshots {
				if s.SteamID != snapshot.SteamID {
					filteredWeapons := make([]string, 0, len(s.AllWeapons))
					for _, weapon := range s.AllWeapons {
						if isRelevantWeapon(weapon) {
							filteredWeapons = append(filteredWeapons, weapon)
						}
					}
					otherPlayers = append(otherPlayers, map[string]interface{}{
						"steamid": s.SteamID,
						"money":   s.Money,
						"primary": s.PrimaryWeapon,
						"weapons": filteredWeapons,
					})
				}
			}
			
			meta := map[string]interface{}{
				"grief_type":           griefType,
				"start_money":          snapshot.StartRoundMoney,
				"money_spent":          snapshot.MoneySpent,
				"remaining_money":      snapshot.Money,
				"spend_pct":            spendPct * 100.0,
				"team_avg_spend":       avgSpent,
				"team_avg_money":       avgStartMoney,
				"team_avg_remaining":   avgRemaining,
				"team_spend_pct":       teamSpendPct * 100.0,
				"primary_weapon":       snapshot.PrimaryWeapon,
				"all_weapons":          snapshot.AllWeapons,
				"weapon_details":       weaponDetails,
				"majority_weapon_type": majorityWeaponType,
				"other_players":        otherPlayers,
			}

			metaJSON, _ := json.Marshal(meta)
			metaJSONStr := string(metaJSON)

			event := Event{
				Type:         "ECONOMY_GRIEF",
				RoundIndex:   roundIndex,
				StartTick:    tick,
				EndTick:      nil,
				ActorSteamID: &snapshot.SteamID,
				Severity:     severity,
				Confidence:   confidence,
				MetaJSON:     &metaJSONStr,
			}
			e.events = append(e.events, event)
		}
	}
}

// GetEvents returns all detected economy griefing events.
func (e *EconomyExtractor) GetEvents() []Event {
	return e.events
}

// ClearEvents clears the accumulated events.
func (e *EconomyExtractor) ClearEvents() {
	e.events = e.events[:0]
}

// Weapon classification helpers
func isRifle(weapon string) bool {
	rifles := []string{"AK-47", "M4A4", "M4A1", "AUG", "SG 553", "AWP", "SSG 08"}
	for _, r := range rifles {
		if weapon == r {
			return true
		}
	}
	return false
}

func isSMG(weapon string) bool {
	smgs := []string{"MAC-10", "MP9", "MP7", "UMP-45", "P90", "PP-Bizon", "MP5-SD"}
	for _, s := range smgs {
		if weapon == s {
			return true
		}
	}
	return false
}

func isPistol(weapon string) bool {
	pistols := []string{"Glock-18", "USP-S", "P2000", "P250", "Five-SeveN", "Tec-9", "CZ75-Auto", "Desert Eagle", "Dual Berettas", "R8 Revolver"}
	for _, p := range pistols {
		if weapon == p {
			return true
		}
	}
	return false
}

// hasRifleOrSMGInInventory returns true if the player has any rifle or SMG in their weapon list (e.g. saved from last round).
func hasRifleOrSMGInInventory(weapons []string) bool {
	for _, w := range weapons {
		if isRifle(w) || isSMG(w) {
			return true
		}
	}
	return false
}

// isRelevantWeapon filters out weapons that aren't typically bought (economy/utility items)
func isRelevantWeapon(weapon string) bool {
	// Exclude C4, starter pistols, and knife
	excluded := map[string]bool{
		"C4":        true,
		"Knife":     true,
		"Glock-18":  true,
		"USP-S":     true,
		"P2000":     true,
	}
	return !excluded[weapon] && weapon != ""
}
