package extractors

import (
	"fmt"

	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

// Event represents a detected event ready to be stored.
type Event struct {
	Type          string
	RoundIndex    int
	StartTick     int
	EndTick       *int
	ActorSteamID  *string
	VictimSteamID *string
	Severity      float64
	Confidence    float64
	MetaJSON      *string
}

// Helper functions for team checking and steamid conversion

// getSteamID converts a player's SteamID64 to a string, handling nil players.
func getSteamID(player *common.Player) *string {
	if player == nil {
		return nil
	}
	steamID := fmt.Sprintf("%d", player.SteamID64)
	return &steamID
}

// isSameTeam checks if two players are on the same team.
// Returns false if either player is nil.
func isSameTeam(p1, p2 *common.Player) bool {
	if p1 == nil || p2 == nil {
		return false
	}
	return p1.Team == p2.Team
}

// isSamePlayer checks if two players are the same.
// Returns false if either player is nil.
func isSamePlayer(p1, p2 *common.Player) bool {
	if p1 == nil || p2 == nil {
		return false
	}
	return p1.SteamID64 == p2.SteamID64
}

// isTeamKill checks if attacker and victim are on the same team and different players.
func isTeamKill(attacker, victim *common.Player) bool {
	return isSameTeam(attacker, victim) && !isSamePlayer(attacker, victim)
}

