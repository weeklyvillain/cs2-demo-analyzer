package extractors

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

// DisconnectExtractor extracts disconnect/abandon events.
type DisconnectExtractor struct {
	events             []Event
	pendingDisconnects map[string]*pendingDisconnect // key: steamID
	lastRoundEndTick   *int                          // Track last round end tick to filter disconnects within 10s
	disconnectReasons  map[string]interface{}        // key: steamID-tick, value: reason code from GenericGameEvent
}

type pendingDisconnect struct {
	steamID        string
	roundIndex     int
	disconnectTick int
}

// NewDisconnectExtractor creates a new disconnect extractor.
func NewDisconnectExtractor() *DisconnectExtractor {
	return &DisconnectExtractor{
		events:             make([]Event, 0),
		pendingDisconnects: make(map[string]*pendingDisconnect),
		disconnectReasons:  make(map[string]interface{}),
	}
}

// HandlePlayerDisconnected processes a player disconnect event.
func (e *DisconnectExtractor) HandlePlayerDisconnected(event events.PlayerDisconnected, roundIndex int, tick int, tickRate float64) {
	player := event.Player
	if player == nil {
		return
	}

	steamID := getSteamID(player)
	if steamID == nil {
		return
	}

	steamIDStr := *steamID

	// Filter out disconnects that happen within 10 seconds of last round end
	// This filters out normal between-round disconnects
	if e.lastRoundEndTick != nil {
		ticksSinceRoundEnd := tick - *e.lastRoundEndTick
		secondsSinceRoundEnd := float64(ticksSinceRoundEnd) / tickRate
		if secondsSinceRoundEnd < 10.0 {
			// Disconnect within 10 seconds of round end - skip it
			return
		}
	}

	// Build metadata
	meta := make(map[string]interface{})

	// Try to get disconnect reason from stored GenericGameEvent data first
	// This is more reliable than trying to extract from PlayerDisconnected event
	// Match by tick (player_disconnect GenericGameEvent fires just before PlayerDisconnected)
	// Look for reasons within ±10 ticks to handle any small timing differences
	var reasonValue interface{}
	foundReason := false
	for storedKey, storedReason := range e.disconnectReasons {
		if strings.HasPrefix(storedKey, fmt.Sprintf("tick-")) {
			// Extract tick from key
			var storedTick int
			if _, err := fmt.Sscanf(storedKey, "tick-%d", &storedTick); err == nil {
				// Match if within ±10 ticks
				if storedTick >= tick-10 && storedTick <= tick+10 {
					reasonValue = storedReason
					// Clean up after use
					delete(e.disconnectReasons, storedKey)
					foundReason = true
					break
				}
			}
		}
	}

	if !foundReason {
		// Fallback: try to get reason from PlayerDisconnected event using reflection
		reasonValue = getDisconnectReasonFromEvent(event)
	}

	// Format the reason using our mapping function
	reason := formatDisconnectReason(reasonValue)
	meta["reason"] = reason
	meta["disconnect_time"] = float64(tick) / tickRate // Time in seconds

	// Store as pending disconnect in case they reconnect
	e.pendingDisconnects[steamIDStr] = &pendingDisconnect{
		steamID:        steamIDStr,
		roundIndex:     roundIndex,
		disconnectTick: tick,
	}

	metaJSON, _ := json.Marshal(meta)
	metaJSONStr := string(metaJSON)

	e.events = append(e.events, Event{
		Type:          "DISCONNECT",
		RoundIndex:    roundIndex,
		StartTick:     tick,
		EndTick:       nil, // Will be set if player reconnects
		ActorSteamID:  steamID,
		VictimSteamID: nil,
		Severity:      0.4,
		Confidence:    0.9,
		MetaJSON:      &metaJSONStr,
	})
}

// HandlePlayerConnect processes a player connect event and checks if they reconnected.
func (e *DisconnectExtractor) HandlePlayerConnect(event events.PlayerConnect, roundIndex int, tick int, tickRate float64) {
	player := event.Player
	if player == nil {
		return
	}

	steamID := getSteamID(player)
	if steamID == nil {
		return
	}

	steamIDStr := *steamID

	// Check if this player had a pending disconnect
	if pending, exists := e.pendingDisconnects[steamIDStr]; exists {
		// Player reconnected - update the disconnect event
		for i := range e.events {
			if e.events[i].Type == "DISCONNECT" &&
				e.events[i].ActorSteamID != nil &&
				*e.events[i].ActorSteamID == steamIDStr &&
				e.events[i].EndTick == nil {
				// Found the matching disconnect event, update it
				reconnectTick := tick
				e.events[i].EndTick = &reconnectTick

				// Update metadata with reconnect info
				var meta map[string]interface{}
				if e.events[i].MetaJSON != nil {
					json.Unmarshal([]byte(*e.events[i].MetaJSON), &meta)
				} else {
					meta = make(map[string]interface{})
				}

				meta["reconnected"] = true
				meta["reconnect_time"] = float64(tick) / tickRate
				meta["reconnect_round"] = roundIndex
				duration := float64(tick-pending.disconnectTick) / tickRate
				meta["disconnect_duration"] = duration

				metaJSON, _ := json.Marshal(meta)
				metaJSONStr := string(metaJSON)
				e.events[i].MetaJSON = &metaJSONStr

				// Remove from pending
				delete(e.pendingDisconnects, steamIDStr)
				break
			}
		}
	}
}

// SetLastRoundEndTick records the tick when the last round ended.
// This is used to filter out disconnects that happen within 10 seconds of round end.
func (e *DisconnectExtractor) SetLastRoundEndTick(tick int) {
	e.lastRoundEndTick = &tick
}

// FinalizeRound finalizes all pending disconnects for a round (marking them as not reconnected).
func (e *DisconnectExtractor) FinalizeRound(roundIndex int) {
	// Any pending disconnects that haven't been matched with reconnects
	// will remain as disconnects without reconnection
	// We could optionally mark them here, but for now we'll leave them as-is
}

// GetEvents returns all extracted events.
func (e *DisconnectExtractor) GetEvents() []Event {
	return e.events
}

// ClearEvents clears all extracted events from memory.
func (e *DisconnectExtractor) ClearEvents() {
	e.events = e.events[:0]
}

// StoreDisconnectReason stores a reason code from a GenericGameEvent for later use.
func (e *DisconnectExtractor) StoreDisconnectReason(steamID string, tick int, reason interface{}) {
	reasonKey := fmt.Sprintf("%s-%d", steamID, tick)
	e.disconnectReasons[reasonKey] = reason
}

// getDisconnectReasonFromEvent tries to extract reason from PlayerDisconnected event using reflection.
func getDisconnectReasonFromEvent(event events.PlayerDisconnected) interface{} {
	// Try to get reason from event using reflection
	// demoinfocs-golang may expose this as a Reason field, or it may not be available
	// We'll use reflection to check for common field names
	var reasonValue interface{}

	// Use reflection to try to access Reason-related fields
	v := reflect.ValueOf(event)
	if v.Kind() == reflect.Ptr {
		v = v.Elem()
	}

	if v.Kind() == reflect.Struct {
		// Try common field names for disconnect reason
		fieldNames := []string{"Reason", "reason", "DisconnectReason", "disconnect_reason", "ReasonText", "reason_text"}
		for _, fieldName := range fieldNames {
			field := v.FieldByName(fieldName)
			if field.IsValid() && field.CanInterface() {
				reasonValue = field.Interface()
				if reasonValue != nil && reasonValue != "" {
					break
				}
			}
		}
	}

	return reasonValue
}

// formatDisconnectReason converts a reason code (int or string) to a human-readable string.
// Based on CS2 disconnect reason codes from ENetworkDisconnectionReason enum.
// Source: https://swiftlys2.net/docs/api/protobufdefinitions/enetworkdisconnectionreason/
func formatDisconnectReason(reasonValue interface{}) string {
	// Map of disconnect reason codes to human-readable strings
	reasonCodeMap := map[int]string{
		0:   "Invalid",
		1:   "Shutdown",
		2:   "Disconnected by user",
		3:   "Disconnect by server",
		4:   "Connection lost",
		5:   "Overflow",
		6:   "Steam banned",
		7:   "Steam in use",
		8:   "Steam ticket",
		9:   "Steam logon",
		10:  "Steam auth cancelled",
		11:  "Steam auth already used",
		12:  "Steam auth invalid",
		13:  "Steam VAC ban state",
		14:  "Steam logged in elsewhere",
		15:  "Steam VAC check timed out",
		16:  "Steam dropped",
		17:  "Steam ownership",
		18:  "Server info overflow",
		19:  "Tick message overflow",
		20:  "String table message overflow",
		21:  "Delta entity message overflow",
		22:  "Temp entity message overflow",
		23:  "Sounds message overflow",
		24:  "Snapshot overflow",
		25:  "Error sending snapshot",
		26:  "Reliable overflow",
		27:  "Bad delta tick",
		28:  "No more splits",
		29:  "Unable to establish a connection with the gameserver.",
		30:  "Disconnected",
		31:  "Leaving split",
		32:  "Different class tables",
		33:  "Bad relay password",
		34:  "Bad spectator password",
		35:  "HLTV restricted",
		36:  "No spectators",
		37:  "HLTV unavailable",
		38:  "HLTV stop",
		39:  "Kicked",
		40:  "Ban added",
		41:  "Kick ban added",
		42:  "HLTV direct",
		43:  "Pure server client extra",
		44:  "Pure server mismatch",
		45:  "User command",
		46:  "Rejected by game",
		47:  "Message parse error",
		48:  "Invalid message error",
		49:  "Bad server password",
		50:  "Direct connect reservation",
		51:  "Connection failure",
		52:  "No peer group handlers",
		53:  "Reconnection",
		54:  "Loop shutdown",
		55:  "Loop deactivated.",
		56:  "Host endgame",
		57:  "Loop level load activate",
		58:  "Create server failed",
		59:  "Shutting down game",
		60:  "Request hoststate idle",
		61:  "Request hoststate HLTV relay",
		62:  "Client consistency fail",
		63:  "Client unable to CRC map",
		64:  "Client no map",
		65:  "Client different map",
		66:  "Server requires Steam",
		67:  "Steam deny misc",
		68:  "Steam deny bad anti-cheat",
		69:  "Server shutdown",
		71:  "Replay incompatible",
		72:  "Connect request timed out",
		73:  "Server incompatible",
		74:  "Local problem many relays",
		75:  "Local problem hosted server primary relay",
		76:  "Local problem network config",
		77:  "Local problem other",
		79:  "Remote timeout",
		80:  "Remote timeout connecting",
		81:  "Remote other",
		82:  "Remote bad crypt",
		83:  "Remote cert not trusted",
		84:  "Unusual",
		85:  "Internal error",
		128: "Reject bad challenge",
		129: "Reject no lobby",
		130: "Reject background map",
		131: "Reject single player",
		132: "Reject hidden game",
		133: "Reject LAN restrict",
		134: "Reject bad password",
		135: "Reject server full",
		136: "Reject invalid reservation",
		137: "Reject failed channel",
		138: "Reject connect from lobby",
		139: "Reject reserved for lobby",
		140: "Reject invalid key length",
		141: "Reject old protocol",
		142: "Reject new protocol",
		143: "Reject invalid connection",
		144: "Reject invalid cert length",
		145: "Reject invalid Steam cert length",
		146: "Reject Steam",
		147: "Reject server auth disabled",
		148: "Reject server CD key auth invalid",
		149: "Reject banned",
		150: "Kicked team killing",
		151: "Kicked TK start",
		152: "Kicked untrusted account",
		153: "Kicked convicted account",
		154: "Kicked competitive cooldown",
		155: "Kicked team hurting",
		156: "Kicked hostage killing",
		157: "Kicked voted off",
		158: "Kicked idle",
		159: "Kicked suicide",
		160: "Kicked no Steam login",
		161: "Kicked no Steam ticket",
		162: "Kicked input automation",
		163: "Kicked VACNet abnormal behavior",
		164: "Kicked insecure client",
	}

	// Try to extract reason from event
	// Check if event has a Reason field (this may vary by demoinfocs version)
	// We'll use type assertion to check for common field names

	// Attempt to get reason as integer code
	if code, ok := reasonValue.(int); ok {
		if reason, found := reasonCodeMap[code]; found {
			return reason
		}
		return fmt.Sprintf("Disconnect code %d", code)
	}

	// Attempt to get reason as string
	if reasonStr, ok := reasonValue.(string); ok && reasonStr != "" {
		// Try to parse as number first
		if code, err := strconv.Atoi(strings.TrimSpace(reasonStr)); err == nil {
			if reason, found := reasonCodeMap[code]; found {
				return reason
			}
			return fmt.Sprintf("Disconnect code %d", code)
		}

		// Handle string-based reasons
		reasonLower := strings.ToLower(strings.TrimSpace(reasonStr))
		if strings.Contains(reasonLower, "kicked") || strings.Contains(reasonLower, "kick") {
			return "Kicked by server"
		} else if strings.Contains(reasonLower, "timeout") || strings.Contains(reasonLower, "timed out") {
			return "Connection timeout"
		} else if strings.Contains(reasonLower, "banned") || strings.Contains(reasonLower, "ban") {
			return "Banned"
		} else if strings.Contains(reasonLower, "disconnect by user") || strings.Contains(reasonLower, "user disconnect") {
			return "Disconnected by user"
		} else if strings.Contains(reasonLower, "connection") && strings.Contains(reasonLower, "lost") {
			return "Connection lost"
		} else if strings.Contains(reasonLower, "server") && strings.Contains(reasonLower, "full") {
			return "Server full"
		} else if strings.Contains(reasonLower, "exiting") {
			return "Shutting down game"
		} else if len(reasonStr) > 0 {
			// Capitalize first letter
			return strings.ToUpper(string(reasonStr[0])) + reasonStr[1:]
		}
	}

	// Default fallback
	return "Disconnected"
}
