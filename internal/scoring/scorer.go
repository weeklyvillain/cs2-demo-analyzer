package scoring

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"cs-griefer-electron/internal/db"
)

// Scorer computes player scores from events.
type Scorer struct {
	writer *db.Writer
}

// NewScorer creates a new scorer.
func NewScorer(writer *db.Writer) *Scorer {
	return &Scorer{writer: writer}
}

// ComputeScores computes and stores player scores for a match.
func (s *Scorer) ComputeScores(ctx context.Context, matchID string, reader *db.Reader) error {
	// Get all events for the match
	events, err := reader.GetEvents(ctx, db.EventQuery{MatchID: matchID})
	if err != nil {
		return fmt.Errorf("failed to get events: %w", err)
	}

	// Aggregate by player
	scores := make(map[string]*playerAggregate)

	for _, event := range events {
		if event.ActorSteamID == nil {
			continue
		}

		steamID := *event.ActorSteamID

		// Initialize player aggregate if needed
		if scores[steamID] == nil {
			scores[steamID] = &playerAggregate{
				steamID: steamID,
			}
		}

		agg := scores[steamID]

		switch event.Type {
		case "TEAM_KILL":
			agg.teamKills++

		case "TEAM_DAMAGE":
			// Extract total damage from meta_json
			// Prefer total_damage if available, otherwise sum dmg_health + dmg_armor
			if event.MetaJSON != nil {
				var meta map[string]interface{}
				if err := json.Unmarshal([]byte(*event.MetaJSON), &meta); err == nil {
					// Try total_damage first (as per requirements)
					if totalDmg, ok := meta["total_damage"].(float64); ok {
						agg.teamDamage += totalDmg
					} else {
						// Fallback: sum health and armor damage
						if dmgHealth, ok := meta["dmg_health"].(float64); ok {
							agg.teamDamage += dmgHealth
						} else if dmgHealth, ok := meta["dmg_health"].(int); ok {
							agg.teamDamage += float64(dmgHealth)
						}
						if dmgArmor, ok := meta["dmg_armor"].(float64); ok {
							agg.teamDamage += dmgArmor
						} else if dmgArmor, ok := meta["dmg_armor"].(int); ok {
							agg.teamDamage += float64(dmgArmor)
						}
					}
				}
			}

		case "TEAM_FLASH":
			// Extract total blind seconds from meta_json
			if event.MetaJSON != nil {
				var meta map[string]interface{}
				if err := json.Unmarshal([]byte(*event.MetaJSON), &meta); err == nil {
					if totalBlind, ok := meta["total_blind_seconds"].(float64); ok {
						agg.teamFlashSeconds += totalBlind
					}
				}
			}

		case "AFK_STILLNESS":
			// Extract seconds from meta_json or estimate from ticks
			if event.MetaJSON != nil {
				var meta map[string]interface{}
				if err := json.Unmarshal([]byte(*event.MetaJSON), &meta); err == nil {
					if seconds, ok := meta["seconds"].(float64); ok {
						agg.afkSeconds += seconds
					}
				}
			}
			// Note: STATIC_HOLD events are excluded or weighted low per requirements

		case "BODY_BLOCK":
			// Extract seconds from meta_json
			if event.MetaJSON != nil {
				var meta map[string]interface{}
				if err := json.Unmarshal([]byte(*event.MetaJSON), &meta); err == nil {
					if seconds, ok := meta["seconds"].(float64); ok {
						agg.bodyBlockSeconds += seconds
					}
				}
			}
			
		case "ECONOMY_GRIEF":
			agg.economyGriefCount++
		}
	}

	// Compute grief scores and store
	for steamID, agg := range scores {
		score := s.computeGriefScore(agg)
		playerScore := db.PlayerScore{
			MatchID:           matchID,
			SteamID:           steamID,
			TeamKills:         agg.teamKills,
			TeamDamage:        agg.teamDamage,
			TeamFlashSeconds:  agg.teamFlashSeconds,
			AFKSeconds:        agg.afkSeconds,
			BodyBlockSeconds:  agg.bodyBlockSeconds,
			EconomyGriefCount: agg.economyGriefCount,
			GriefScore:        score,
		}

		if err := s.writer.InsertPlayerScore(ctx, playerScore); err != nil {
			return fmt.Errorf("failed to insert score for player %s: %w", steamID, err)
		}
	}

	return nil
}

type playerAggregate struct {
	steamID           string
	teamKills         int
	teamDamage        float64
	teamFlashSeconds  float64
	afkSeconds        float64
	bodyBlockSeconds  float64
	economyGriefCount int
}

// computeGriefScore calculates the grief score (0-100) from aggregates.
// Uses soft caps and weights for normalization.
func (s *Scorer) computeGriefScore(agg *playerAggregate) float64 {
	// Weights
	const (
		weightTK        = 0.25 // High
		weightDamage    = 0.20 // Medium-high
		weightFlash     = 0.15 // Medium
		weightAFK       = 0.15 // Medium
		weightBodyBlock = 0.10 // Medium-low
		weightEconomy   = 0.15 // Medium - impacts team strategy
	)

	// Soft cap functions: tanh-based normalization
	// This gives diminishing returns after certain thresholds

	// Team kills: soft cap at 5 (tanh(5) ≈ 1.0)
	tkScore := math.Tanh(float64(agg.teamKills) / 5.0) * 100.0

	// Team damage: soft cap at 200 (tanh(200) ≈ 1.0)
	damageScore := math.Tanh(agg.teamDamage / 200.0) * 100.0

	// Team flash: soft cap at 30 seconds (tanh(30) ≈ 1.0)
	flashScore := math.Tanh(agg.teamFlashSeconds / 30.0) * 100.0

	// AFK: soft cap at 60 seconds (tanh(60) ≈ 1.0)
	afkScore := math.Tanh(agg.afkSeconds / 60.0) * 100.0

	// Body block: soft cap at 30 seconds (tanh(30) ≈ 1.0)
	bodyBlockScore := math.Tanh(agg.bodyBlockSeconds / 30.0) * 100.0
	
	// Economy grief: soft cap at 5 incidents (tanh(5) ≈ 1.0)
	economyScore := math.Tanh(float64(agg.economyGriefCount) / 5.0) * 100.0

	// Weighted sum
	totalScore := tkScore*weightTK +
		damageScore*weightDamage +
		flashScore*weightFlash +
		afkScore*weightAFK +
		bodyBlockScore*weightBodyBlock +
		economyScore*weightEconomy

	// Clamp to 0-100
	return math.Max(0, math.Min(100, totalScore))
}

