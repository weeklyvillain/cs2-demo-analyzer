package parser

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3" // SQLite driver

	dem "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	common "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	events "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/msg"
	"github.com/golang/geo/r3"

	"cs-griefer-electron/internal/parser/extractors"
)

// Parser wraps demoinfocs to parse CS2 demo files.
type Parser struct {
	parser dem.Parser
	path   string
}

// MatchData contains extracted match information.
type MatchData struct {
	Map         string
	TickRate    float64
	StartedAt   *time.Time
	Players     []PlayerData
	Rounds      []RoundData
	Events      []extractors.Event
	ChatMessages []ChatMessageData
	Positions   []PlayerPositionData
	GrenadePositions []GrenadePositionData
	GrenadeEvents    []GrenadeEventData
	Shots            []ShotData
}

// PlayerPositionData contains player position at a specific tick.
type PlayerPositionData struct {
	RoundIndex int
	Tick       int
	SteamID    string
	X          float64
	Y          float64
	Z          float64
	Yaw        float64 // View angle (yaw) in degrees
	Team       string // "T" or "CT"
	Health     *int   // Optional health
	Armor      *int   // Optional armor
	Weapon     *string // Optional weapon name
}

// ChatMessageData contains chat message information.
type ChatMessageData struct {
	RoundIndex int
	Tick       int
	SteamID    string
	Name       string
	Team       string
	Message    string
	IsTeamChat bool
}

// PlayerData contains player information.
type PlayerData struct {
	SteamID string
	Name    string
}

// RoundData contains round information.
type RoundData struct {
	RoundIndex    int
	StartTick     int
	FreezeEndTick *int // Estimated if not directly available
	EndTick       int
	TWins         int
	CTWins        int
	Winner        *string // "T" or "CT"
}

// GrenadePositionData contains grenade position at a specific tick.
type GrenadePositionData struct {
	RoundIndex    int
	Tick          int
	ProjectileID  uint64 // Unique ID for the grenade projectile
	GrenadeName   string // "hegrenade", "smokegrenade", "flashbang", "incendiary", "molotov", "decoy"
	X             float64
	Y             float64
	Z             float64
	ThrowerSteamID *string // Optional thrower SteamID
	ThrowerName    *string // Optional thrower name
	ThrowerTeam    *string // Optional thrower team ("T" or "CT")
}

// GrenadeEventData contains grenade event information (explosions, smoke starts, etc.)
type GrenadeEventData struct {
	RoundIndex    int
	Tick          int
	EventType     string // "smoke_start", "he_explode", "flash_explode", "decoy_start", "inferno_start", "inferno_expire"
	ProjectileID  uint64 // Unique ID for the grenade projectile
	GrenadeName   string
	X             float64
	Y             float64
	Z             float64
	ThrowerSteamID *string
	ThrowerName    *string
	ThrowerTeam    *string
}

// ShotData contains weapon fire information.
type ShotData struct {
	RoundIndex int
	Tick       int
	SteamID    string
	WeaponName string
	X          float64
	Y          float64
	Z          float64
	Yaw        float64
	Pitch      *float64
	Team       *string
}

// ParseCallback is called during parsing to report progress.
type ParseCallback func(stage string, tick, round int, pct float64)

// NewParser creates a new parser for the given demo file.
func NewParser(path string) (*Parser, error) {
	// Validate file exists and is readable
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("failed to access demo file: %w", err)
	}
	if info.Size() == 0 {
		return nil, fmt.Errorf("demo file is empty")
	}

	// Basic validation: check file extension
	if !strings.HasSuffix(strings.ToLower(path), ".dem") {
		return nil, fmt.Errorf("file does not have .dem extension")
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open demo file: %w", err)
	}

	p := dem.NewParser(f)

	// Note: We can't validate the header here because the parser needs to
	// read the demo file first. Validation will happen during Parse().

	return &Parser{
		parser: p,
		path:   path,
	}, nil
}

// Parse parses the demo file and extracts match data.
// The callback is invoked periodically to report progress.
// The db parameter is used for AFK detection via player position queries.
func (p *Parser) Parse(ctx context.Context, callback ParseCallback) (*MatchData, error) {
	return p.ParseWithDB(ctx, callback, nil)
}

// ParseWithDB parses the demo file and extracts match data with an optional database connection.
// The db parameter is used for AFK detection via player position queries.
func (p *Parser) ParseWithDB(ctx context.Context, callback ParseCallback, db *sql.DB) (*MatchData, error) {
	data := &MatchData{
		Players:          make([]PlayerData, 0),
		Rounds:           make([]RoundData, 0),
		ChatMessages:     make([]ChatMessageData, 0),
		Positions:        make([]PlayerPositionData, 0),
		GrenadePositions: make([]GrenadePositionData, 0),
		GrenadeEvents:    make([]GrenadeEventData, 0),
	}

	var currentRound *RoundData
	var roundStartTick int
	var freezeEndTick *int
	playerMap := make(map[uint64]*PlayerData) // steamid -> player

	// Track round state
	var roundNumber int
	var tWins, ctWins int
	var maxTick int // Track maximum tick seen for progress estimation

	// Helper function to convert team to string
	getTeamString := func(team common.Team) string {
		switch team {
		case common.TeamTerrorists:
			return "T"
		case common.TeamCounterTerrorists:
			return "CT"
		default:
			return ""
		}
	}

	// Track map name from ServerInfo event (v5)
	var mapName string

	// Track Team A and Team B assignments
	// Team A and Team B are consistent throughout the match (don't swap sides)
	// We determine which is which based on the first round
	playerTeamMap := make(map[uint64]string) // steamid -> "A" or "B" (original team assignment)
	var firstTTeamSeen bool                   // Track if we've seen a T team player
	var firstCTTeamSeen bool                  // Track if we've seen a CT team player

	// Initialize event extractors
	// Get tick rate - will be set after parsing header
	// For now use default, will update from header after parse
	tickRate := 64.0 // Default fallback
	teamKillExtractor := extractors.NewTeamKillExtractor()
	teamDamageExtractor := extractors.NewTeamDamageExtractor(tickRate)
	teamFlashExtractor := extractors.NewTeamFlashExtractor()
	disconnectExtractor := extractors.NewDisconnectExtractor()
	afkExtractor := extractors.NewAFKExtractor(tickRate, db)

	// Register handler for ServerInfo to get map name (v5)
	// Based on: https://github.com/markus-wa/demoinfocs-golang/blob/master/examples/print-events/print_events.go
	p.parser.RegisterNetMessageHandler(func(m *msg.CSVCMsg_ServerInfo) {
		if m != nil {
			mapName = m.GetMapName()
		}
	})

	// Track current tick manually since GameState might not be available during parsing
	currentTick := 0

	// Helper function to get current tick
	// Use the parser's current tick if available, otherwise use tracked value
	getCurrentTick := func() int {
		// Try to get from parser's game state
		gs := p.parser.GameState()
		if gs != nil {
			tick := gs.IngameTick()
			if tick > 0 {
				currentTick = tick
				return tick
			}
		}
		return currentTick
	}

	// Update current tick in event handlers
	updateTick := func() {
		gs := p.parser.GameState()
		if gs != nil {
			tick := gs.IngameTick()
			if tick > 0 {
				currentTick = tick
			}
		}
	}

	// Register event handlers
	p.parser.RegisterEventHandler(func(e events.RoundStart) {
		updateTick()
		tick := getCurrentTick()

		// Finalize previous round's events if exists
		if currentRound != nil {
			currentRound.EndTick = tick
			data.Rounds = append(data.Rounds, *currentRound)

			// Finalize pending events for previous round
			teamDamageExtractor.FinalizeRound(currentRound.RoundIndex)
			teamFlashExtractor.FinalizeRound(currentRound.RoundIndex)
			// AFK detection is now done from database after positions are written
			disconnectExtractor.FinalizeRound(currentRound.RoundIndex)
		}

		// Start new round
		roundNumber++
		roundStartTick = tick
		freezeEndTick = nil // Reset for new round
		afkExtractor.HandleRoundStart(roundNumber-1, tick)

		// Start new round
		currentRound = &RoundData{
			RoundIndex: roundNumber - 1, // 0-indexed
			StartTick:  roundStartTick,
			TWins:      tWins,
			CTWins:     ctWins,
		}

		if tick > maxTick {
			maxTick = tick
		}
		if callback != nil {
			callback("parsing", tick, roundNumber, 0)
		}
	})

	p.parser.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		updateTick()
		tick := getCurrentTick()
		freezeEndTick = &tick
		if currentRound != nil {
			currentRound.FreezeEndTick = freezeEndTick
			// Notify AFK extractor that freeze time has ended
			afkExtractor.HandleFreezeTimeEnd(currentRound.RoundIndex, tick)
		}
	})

	p.parser.RegisterEventHandler(func(e events.RoundEnd) {
		if currentRound == nil {
			return
		}

		updateTick()
		tick := getCurrentTick()
		currentRound.EndTick = tick

		// Notify disconnect extractor of round end (for filtering disconnects within 10s)
		disconnectExtractor.SetLastRoundEndTick(tick)
		
		// Notify AFK extractor of round end (for filtering AFK periods that end at round end)
		afkExtractor.HandleRoundEnd(currentRound.RoundIndex, tick)

		// Determine winner
		var winner *string
		switch e.Winner {
		case common.TeamTerrorists:
			w := "T"
			winner = &w
			tWins++
		case common.TeamCounterTerrorists:
			w := "CT"
			winner = &w
			ctWins++
		default:
			// Unknown winner, leave as nil
			winner = nil
		}

		currentRound.Winner = winner
		currentRound.TWins = tWins
		currentRound.CTWins = ctWins

		if tick > maxTick {
			maxTick = tick
		}
		if callback != nil {
			callback("parsing", tick, roundNumber, 0)
		}
	})

	// Track players
	p.parser.RegisterEventHandler(func(e events.PlayerConnect) {
		player := e.Player
		if player == nil {
			return
		}

		roundIndex := -1
		if currentRound != nil {
			roundIndex = currentRound.RoundIndex
		}
		updateTick()
		tick := getCurrentTick()

		// Check if this is a reconnection
		disconnectExtractor.HandlePlayerConnect(e, roundIndex, tick, tickRate)

		steamID := fmt.Sprintf("%d", player.SteamID64)
		if _, exists := playerMap[player.SteamID64]; !exists {
			name := player.Name
			if name == "" {
				name = fmt.Sprintf("Player_%d", player.SteamID64)
			}
			playerMap[player.SteamID64] = &PlayerData{
				SteamID: steamID,
				Name:    name,
			}
		}

		// Track team assignment when player connects
		// First T team we see = Team A, first CT team we see = Team B
		if _, exists := playerTeamMap[player.SteamID64]; !exists {
			if player.Team == common.TeamTerrorists {
				if !firstTTeamSeen {
					firstTTeamSeen = true
				}
				playerTeamMap[player.SteamID64] = "A"
			} else if player.Team == common.TeamCounterTerrorists {
				if !firstCTTeamSeen {
					firstCTTeamSeen = true
				}
				playerTeamMap[player.SteamID64] = "B"
			}
		}

		// Add server announcement for player joining
		// roundIndex and tick are already declared above
		
		playerName := player.Name
		if playerName == "" {
			playerName = fmt.Sprintf("Player_%d", player.SteamID64)
		}
		
		data.ChatMessages = append(data.ChatMessages, ChatMessageData{
			RoundIndex: roundIndex,
			Tick:       tick,
			SteamID:    steamID,
			Name:       "*SERVER*",
			Team:       "",
			Message:    fmt.Sprintf("%s joined the game", playerName),
			IsTeamChat: false,
		})
	})

	// Update player names when they change
	p.parser.RegisterEventHandler(func(e events.PlayerNameChange) {
		player := e.Player
		if player == nil {
			return
		}

		steamID := fmt.Sprintf("%d", player.SteamID64)
		if p, exists := playerMap[player.SteamID64]; exists {
			if player.Name != "" {
				p.Name = player.Name
			}
		} else {
			// Player not yet in map, add them
			name := player.Name
			if name == "" {
				name = fmt.Sprintf("Player_%d", player.SteamID64)
			}
			playerMap[player.SteamID64] = &PlayerData{
				SteamID: steamID,
				Name:    name,
			}
		}
	})

	// Register event extractors
	p.parser.RegisterEventHandler(func(e events.Kill) {
		if currentRound != nil {
			updateTick()
			tick := getCurrentTick()
			teamKillExtractor.HandlePlayerDeath(e, currentRound.RoundIndex, tick)
			// AFK tracking is now done from database after positions are written
		}
	})

	p.parser.RegisterEventHandler(func(e events.PlayerHurt) {
		if currentRound != nil {
			updateTick()
			tick := getCurrentTick()
			teamDamageExtractor.HandlePlayerHurt(e, currentRound.RoundIndex, tick)
			// AFK tracking is now done from database after positions are written
		}
	})

	p.parser.RegisterEventHandler(func(e events.PlayerFlashed) {
		if currentRound != nil {
			updateTick()
			tick := getCurrentTick()
			teamFlashExtractor.HandlePlayerFlashed(e, currentRound.RoundIndex, tick)
			// AFK tracking is now done from database after positions are written
		}
	})

	p.parser.RegisterEventHandler(func(e events.PlayerDisconnected) {
		roundIndex := -1
		if currentRound != nil {
			roundIndex = currentRound.RoundIndex
		}
		updateTick()
		tick := getCurrentTick()
		
		disconnectExtractor.HandlePlayerDisconnected(e, roundIndex, tick, tickRate)
		
		// Add server announcement for player leaving
		player := e.Player
		if player != nil {
			steamID := fmt.Sprintf("%d", player.SteamID64)
			playerName := player.Name
			if playerName == "" {
				playerName = fmt.Sprintf("Player_%d", player.SteamID64)
			}
			
			data.ChatMessages = append(data.ChatMessages, ChatMessageData{
				RoundIndex: roundIndex,
				Tick:       tick,
				SteamID:    steamID,
				Name:       "*SERVER*",
				Team:       "",
				Message:    fmt.Sprintf("%s left the game", playerName),
				IsTeamChat: false,
			})
		}
	})

	// Handle chat messages using SayText2 event
	// CS Demo Analyzer uses the same event - SayText2 is the standard for CS2 chat
	// Based on: https://pkg.go.dev/github.com/markus-wa/demoinfocs-golang/events#SayText2
	// SayText2 has:
	// - MsgName: The message type identifier
	// - Params: Array of parameters, typically [0] = player name, [1] = message
	// - Entity: The player entity that sent the message (can be nil for server messages)
	p.parser.RegisterEventHandler(func(e events.SayText2) {
		// Extract player name and message from Params
		// Params structure varies by message type:
		// - For player chat: [0] = player name, [1] = message
		// - For server messages: may have different structure
		if len(e.Params) < 2 {
			return
		}

		playerName := e.Params[0]
		messageText := e.Params[1]

		if messageText == "" {
			return
		}

		// Determine chat type from MsgName
		// CS2 message types:
		// - "Cstrike_Chat_All" = all chat (global)
		// - "Cstrike_Chat_Team" = team chat
		// - "Cstrike_Chat_Dead" = dead chat (treated as all chat)
		// - "#CSGO_Chat_All" = all chat (alternative format)
		// - "#CSGO_Chat_Team" = team chat (alternative format)
		// - Server messages may have different MsgName values
		isTeamChat := false
		msgNameLower := strings.ToLower(e.MsgName)
		
		// Only treat as team chat if MsgName explicitly contains "team"
		// This matches CS Demo Analyzer's approach
		// Note: We capture ALL chat messages (both team and all chat) - the IsTeamChat flag
		// just indicates which type it is, but we store both types so both teams' messages are captured
		if strings.Contains(msgNameLower, "team") {
			isTeamChat = true
		}
		
		// Debug logging (uncomment to debug chat extraction)
		// fmt.Printf("[Chat] MsgName: %s, Player: %s, Message: %s, IsTeamChat: %v\n", e.MsgName, playerName, messageText, isTeamChat)

		updateTick()
		tick := getCurrentTick()

		// Get player from GameState
		// SayText2 has EntIdx (entity index) which we can use to find the player
		gs := p.parser.GameState()
		var player *common.Player
		var steamID string
		var team string

		// Try to get player from EntIdx (entity index) first (most reliable)
		if gs != nil && e.EntIdx > 0 {
			participants := gs.Participants()
			for _, p := range participants.All() {
				if p != nil && p.Entity != nil && p.Entity.ID() == e.EntIdx {
					player = p
					steamID = fmt.Sprintf("%d", p.SteamID64)
					// Update playerName from actual player object (more reliable)
					if p.Name != "" {
						playerName = p.Name
					}
					break
				}
			}
		}

		// Fallback: Look up player by name in GameState
		if player == nil && gs != nil {
			participants := gs.Participants()
			for _, p := range participants.All() {
				if p != nil && strings.EqualFold(p.Name, playerName) {
					player = p
					steamID = fmt.Sprintf("%d", p.SteamID64)
					break
				}
			}
		}

		// If we couldn't find the player, try to get from playerMap by name
		if player == nil {
			for steamID64, pData := range playerMap {
				if strings.EqualFold(pData.Name, playerName) {
					steamID = pData.SteamID
					// Try to get player from GameState by SteamID
					if gs != nil {
						participants := gs.Participants()
						for _, p := range participants.All() {
							if p != nil && p.SteamID64 == steamID64 {
								player = p
								break
							}
						}
					}
					break
				}
			}
		}

		// If still no player found, use name as fallback
		if player == nil {
			// Try to extract SteamID from playerMap by name match
			for _, pData := range playerMap {
				if strings.EqualFold(pData.Name, playerName) {
					steamID = pData.SteamID
					break
				}
			}
			if steamID == "" {
				// Last resort: use name as identifier
				steamID = playerName
			}
		} else {
			steamID = fmt.Sprintf("%d", player.SteamID64)
		}

		// Get team assignment (A or B) - use original team from first round
		// IMPORTANT: For team chat, ALWAYS store "A" or "B", never "T" or "CT"
		if isTeamChat {
			// For team chat, use Team A/B assignment
			if player != nil {
				steamID64 := player.SteamID64
				if assignedTeam, exists := playerTeamMap[steamID64]; exists {
					team = assignedTeam
				} else {
					// Player not yet assigned, assign them now based on current team
					// First T team we see = Team A, first CT team we see = Team B
					if player.Team == common.TeamTerrorists {
						if !firstTTeamSeen {
							firstTTeamSeen = true
						}
						team = "A"
						playerTeamMap[steamID64] = "A"
					} else if player.Team == common.TeamCounterTerrorists {
						if !firstCTTeamSeen {
							firstCTTeamSeen = true
						}
						team = "B"
						playerTeamMap[steamID64] = "B"
					} else {
						// Unknown team, try to assign based on what we've seen
						if firstTTeamSeen && !firstCTTeamSeen {
							team = "A"
							playerTeamMap[steamID64] = "A"
						} else if firstCTTeamSeen && !firstTTeamSeen {
							team = "B"
							playerTeamMap[steamID64] = "B"
						} else {
							team = ""
						}
					}
				}
			} else {
				// Player not found in GameState, try to get from playerMap and assign team
				// Look up by SteamID if we have it
				if steamID != "" && steamID != playerName {
					// Try to parse SteamID as uint64
					var steamID64 uint64
					if _, err := fmt.Sscanf(steamID, "%d", &steamID64); err == nil {
						if assignedTeam, exists := playerTeamMap[steamID64]; exists {
							team = assignedTeam
						} else {
							// Can't determine team without player object
							team = ""
						}
					} else {
						team = ""
					}
				} else {
					// No SteamID available, can't determine team
					team = ""
				}
			}
		} else {
			// For all chat, show current side (T/CT) for context
			if player != nil {
				switch player.Team {
				case common.TeamTerrorists:
					team = "T"
				case common.TeamCounterTerrorists:
					team = "CT"
				default:
					team = ""
				}
			} else {
				team = ""
			}
		}

		// Determine round index (allow chat before rounds start)
		roundIndex := -1
		if currentRound != nil {
			roundIndex = currentRound.RoundIndex
		}

		data.ChatMessages = append(data.ChatMessages, ChatMessageData{
			RoundIndex: roundIndex,
			Tick:       tick,
			SteamID:    steamID,
			Name:       playerName,
			Team:       team,
			Message:    messageText,
			IsTeamChat: isTeamChat,
		})
	})

	// Track player positions every tick for accurate AFK detection
	// Only track after freeze time ends
	lastPositionTick := 0
	positionInterval := 1 // Track every tick for accurate AFK detection

	p.parser.RegisterEventHandler(func(e events.FrameDone) {
		if currentRound == nil {
			return
		}

		updateTick()
		tick := getCurrentTick()

		// Only track positions after freeze time ends
		if freezeEndTick == nil || tick < *freezeEndTick {
			return
		}

		// Get all players from GameState
		gs := p.parser.GameState()
		if gs == nil {
			return
		}

		// Track positions at intervals (for database storage)
		if tick-lastPositionTick < positionInterval {
			return
		}
		lastPositionTick = tick

		// Get all players from GameState for position tracking
		participants := gs.Participants()
		for _, player := range participants.All() {
			if player == nil {
				continue
			}

			// Skip spectators
			if player.Team == common.TeamSpectators || player.Team == common.TeamUnassigned {
				continue
			}

			// Get player position
			pos := player.Position()
			// Note: We don't filter out (0,0,0) positions as they might be valid
			// The UI can decide whether to display them

			// Get team
			var team string
			switch player.Team {
			case common.TeamTerrorists:
				team = "T"
			case common.TeamCounterTerrorists:
				team = "CT"
			default:
				continue
			}

			steamID := fmt.Sprintf("%d", player.SteamID64)

			// Get health and armor
			var health *int
			if player.Health() > 0 {
				h := player.Health()
				health = &h
			}
			var armor *int
			if player.Armor() > 0 {
				a := player.Armor()
				armor = &a
			}

			// Get active weapon
			var weapon *string
			activeWeapon := player.ActiveWeapon()
			if activeWeapon != nil {
				weaponType := activeWeapon.Type
				if weaponType != common.EqUnknown {
					weaponName := weaponType.String()
					if weaponName != "" && weaponName != "weapon_knife" {
						weapon = &weaponName
					}
				}
			}

			// Get view direction (yaw angle)
			// ViewDirectionX and ViewDirectionY give us the direction vector
			// In Source engine: 0° = North (+Y), 90° = East (+X), 180° = South (-Y), 270° = West (-X)
			// atan2(Y, X) gives: 0° = East (+X), 90° = North (+Y), 180° = West (-X), 270° = South (-Y)
			// CS Demo Analyzer's demo analyzer outputs yaw directly from m_angEyeAngles[1]
			// We need to match that format. Let's try calculating without the -90° adjustment first
			viewDirX := player.ViewDirectionX()
			viewDirY := player.ViewDirectionY()
			var yaw float64
			if viewDirX != 0 || viewDirY != 0 {
				// Calculate yaw angle from direction vector
				// Try: atan2(Y, X) directly (no -90° adjustment) to match CS Demo Analyzer
				// If this doesn't work, we may need to check what ViewDirectionX/Y actually return
				yaw = math.Atan2(float64(viewDirY), float64(viewDirX)) * 180.0 / math.Pi
				// Normalize to 0-360 range
				if yaw < 0 {
					yaw += 360
				}
			}

			data.Positions = append(data.Positions, PlayerPositionData{
				RoundIndex: currentRound.RoundIndex,
				Tick:       tick,
				SteamID:    steamID,
				X:          float64(pos.X),
				Y:          float64(pos.Y),
				Z:          float64(pos.Z),
				Yaw:        yaw,
				Team:       team,
				Health:     health,
				Armor:      armor,
				Weapon:     weapon,
			})
		}

		// Track all active grenade projectiles
		for projectileID, grenade := range gs.GrenadeProjectiles() {
			if grenade == nil {
				continue
			}

			pos := grenade.Position()
			// Position is r3.Vector, not a pointer, so we check if it's zero vector
			if pos.X == 0 && pos.Y == 0 && pos.Z == 0 {
				continue
			}

			// Get grenade type from weapon instance
			weaponInstance := grenade.WeaponInstance
			if weaponInstance == nil {
				continue
			}
			grenadeName := strings.ToLower(weaponInstance.Type.String())

			// Normalize grenade names to match CS Demo Analyzer format
			normalizedName := grenadeName
			if strings.Contains(grenadeName, "he") || strings.Contains(grenadeName, "hegrenade") {
				normalizedName = "hegrenade"
			} else if strings.Contains(grenadeName, "smoke") || strings.Contains(grenadeName, "smokegrenade") {
				normalizedName = "smokegrenade"
			} else if strings.Contains(grenadeName, "flash") || strings.Contains(grenadeName, "flashbang") {
				normalizedName = "flashbang"
			} else if strings.Contains(grenadeName, "incendiary") || strings.Contains(grenadeName, "molotov") {
				normalizedName = "incendiary"
			} else if strings.Contains(grenadeName, "decoy") {
				normalizedName = "decoy"
			} else {
				// Skip unknown grenade types
				continue
			}

			// Get thrower information (Thrower is a field, not a method)
			var throwerSteamID *string
			var throwerName *string
			var throwerTeam *string
			thrower := grenade.Thrower
			if thrower != nil {
				steamID := fmt.Sprintf("%d", thrower.SteamID64)
				throwerSteamID = &steamID
				name := thrower.Name
				throwerName = &name
				team := getTeamString(thrower.Team)
				throwerTeam = &team
			}

			data.GrenadePositions = append(data.GrenadePositions, GrenadePositionData{
				RoundIndex:     currentRound.RoundIndex,
				Tick:           tick,
				ProjectileID:   uint64(projectileID),
				GrenadeName:    normalizedName,
				X:              float64(pos.X),
				Y:              float64(pos.Y),
				Z:              float64(pos.Z),
				ThrowerSteamID: throwerSteamID,
				ThrowerName:    throwerName,
				ThrowerTeam:    throwerTeam,
			})
		}
	})

	// Track grenade events
	// Smoke grenade detonation (smoke starts)
	p.parser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		// Check if it's a smoke grenade
		if e.Projectile == nil {
			return
		}
		weaponInstance := e.Projectile.WeaponInstance
		if weaponInstance == nil {
			return
		}
		grenadeName := strings.ToLower(weaponInstance.Type.String())
		if !strings.Contains(grenadeName, "smoke") && !strings.Contains(grenadeName, "smokegrenade") {
			return
		}
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		pos := e.Projectile.Position()
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Projectile.Thrower != nil {
			steamID := fmt.Sprintf("%d", e.Projectile.Thrower.SteamID64)
			throwerSteamID = &steamID
			name := e.Projectile.Thrower.Name
			throwerName = &name
			team := getTeamString(e.Projectile.Thrower.Team)
			throwerTeam = &team
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "smoke_start",
			ProjectileID:   uint64(e.Projectile.UniqueID()),
			GrenadeName:    "smokegrenade",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// HE grenade explosion
	p.parser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		// Check if it's an HE grenade
		if e.Projectile == nil {
			return
		}
		weaponInstance := e.Projectile.WeaponInstance
		if weaponInstance == nil {
			return
		}
		grenadeName := strings.ToLower(weaponInstance.Type.String())
		if !strings.Contains(grenadeName, "he") && !strings.Contains(grenadeName, "hegrenade") {
			return
		}
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		pos := e.Projectile.Position()
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Projectile.Thrower != nil {
			steamID := fmt.Sprintf("%d", e.Projectile.Thrower.SteamID64)
			throwerSteamID = &steamID
			name := e.Projectile.Thrower.Name
			throwerName = &name
			team := getTeamString(e.Projectile.Thrower.Team)
			throwerTeam = &team
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "he_explode",
			ProjectileID:   uint64(e.Projectile.UniqueID()),
			GrenadeName:    "hegrenade",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// Flashbang explosion
	p.parser.RegisterEventHandler(func(e events.FlashExplode) {
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		pos := e.Position
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Thrower != nil {
			steamID := fmt.Sprintf("%d", e.Thrower.SteamID64)
			throwerSteamID = &steamID
			name := e.Thrower.Name
			throwerName = &name
			team := getTeamString(e.Thrower.Team)
			throwerTeam = &team
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "flash_explode",
			ProjectileID:   0, // FlashExplode doesn't have ProjectileID, use 0
			GrenadeName:    "flashbang",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// Decoy start
	p.parser.RegisterEventHandler(func(e events.DecoyStart) {
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		pos := e.Position
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Thrower != nil {
			steamID := fmt.Sprintf("%d", e.Thrower.SteamID64)
			throwerSteamID = &steamID
			name := e.Thrower.Name
			throwerName = &name
			team := getTeamString(e.Thrower.Team)
			throwerTeam = &team
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "decoy_start",
			ProjectileID:   0, // DecoyStart doesn't have ProjectileID, use 0
			GrenadeName:    "decoy",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// Inferno (molotov/incendiary) start
	p.parser.RegisterEventHandler(func(e events.InfernoStart) {
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		// InfernoStart has Entity field
		// Inferno doesn't have Position() method - we'll track position from grenade projectile instead
		// For now, use zero position and rely on grenade positions for actual location
		var pos r3.Vector
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Inferno != nil {
			// Inferno doesn't expose Position() directly
			// We'll use (0,0,0) as placeholder - actual position tracked via grenade positions
			pos = r3.Vector{X: 0, Y: 0, Z: 0}
			// Thrower is a method that returns the player who threw it
			if e.Inferno.Thrower() != nil {
				thrower := e.Inferno.Thrower()
				steamID := fmt.Sprintf("%d", thrower.SteamID64)
				throwerSteamID = &steamID
				name := thrower.Name
				throwerName = &name
				team := getTeamString(thrower.Team)
				throwerTeam = &team
			}
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "inferno_start",
			ProjectileID:   0, // InfernoStart doesn't have ProjectileID
			GrenadeName:    "incendiary",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// Inferno expire
	p.parser.RegisterEventHandler(func(e events.InfernoExpired) {
		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		// InfernoExpired has Entity field
		// Get position from the inferno entity - Inferno doesn't have Position() method
		var pos r3.Vector
		var throwerSteamID *string
		var throwerName *string
		var throwerTeam *string
		if e.Inferno != nil {
			// Inferno doesn't expose Position() directly
			// For now, we'll set to zero and track via grenade positions instead
			pos = r3.Vector{X: 0, Y: 0, Z: 0}
			// Thrower is a method that returns the player who threw it
			if e.Inferno.Thrower() != nil {
				thrower := e.Inferno.Thrower()
				steamID := fmt.Sprintf("%d", thrower.SteamID64)
				throwerSteamID = &steamID
				name := thrower.Name
				throwerName = &name
				team := getTeamString(thrower.Team)
				throwerTeam = &team
			}
		}

		data.GrenadeEvents = append(data.GrenadeEvents, GrenadeEventData{
			RoundIndex:     currentRound.RoundIndex,
			Tick:           tick,
			EventType:      "inferno_expire",
			ProjectileID:   0, // InfernoExpire doesn't have ProjectileID
			GrenadeName:    "incendiary",
			X:              float64(pos.X),
			Y:              float64(pos.Y),
			Z:              float64(pos.Z),
			ThrowerSteamID: throwerSteamID,
			ThrowerName:    throwerName,
			ThrowerTeam:    throwerTeam,
		})
	})

	// Handle player_disconnect GenericGameEvent to extract reason code
	// This is the same approach used by cs2-web-replay
	// The GenericGameEvent contains the raw event data including the reason field
	p.parser.RegisterEventHandler(func(e events.GenericGameEvent) {
		if e.Name != "player_disconnect" {
			return
		}

		updateTick()
		tick := getCurrentTick()

		// Extract userid from event data
		var userid int
		if useridKey, ok := e.Data["userid"]; ok && useridKey != nil {
			if useridKey.ValLong != nil {
				userid = int(*useridKey.ValLong)
			} else if useridKey.ValShort != nil {
				userid = int(*useridKey.ValShort)
			}
		}
		if userid == 0 {
			return
		}

		// Extract reason from event data - this is the numerical code
		var reason interface{}
		if reasonKey, ok := e.Data["reason"]; ok && reasonKey != nil {
			// Try to get as integer first
			if reasonKey.ValLong != nil {
				reason = int(*reasonKey.ValLong)
			} else if reasonKey.ValShort != nil {
				reason = int(*reasonKey.ValShort)
			} else if reasonKey.ValString != nil {
				// Try to parse string as int, otherwise keep as string
				if parsed, err := strconv.Atoi(*reasonKey.ValString); err == nil {
					reason = parsed
				} else {
					reason = *reasonKey.ValString
				}
			}
		}

		// Find player by userid to get SteamID
		gs := p.parser.GameState()
		if gs != nil {
			participants := gs.Participants()
			for _, player := range participants.All() {
				if player != nil {
					// userid is typically the entity ID - try to match by entity index
					// For now, we'll match on a close tick basis - when PlayerDisconnected event fires,
					// we'll use the stored reason
					// Actually, we need to match by userid properly - but userid in GenericGameEvent
					// might be different from entity ID. Let's store it and match by tick/round instead
				}
			}
		}

		// Store reason temporarily - we'll match it with PlayerDisconnected event by tick
		// Store by tick so we can match it when PlayerDisconnected event fires
		// We'll look for reasons within a small tick range (±10 ticks) when matching
		if reason != nil {
			// Store by tick - we'll match by tick in HandlePlayerDisconnected
			disconnectExtractor.StoreDisconnectReason(fmt.Sprintf("tick-%d", tick), tick, reason)
		}
	})

	// Weapon fired (shots) - using GenericGameEvent
	// According to https://github.com/markus-wa/demoinfocs-golang/blob/master/docs/game-events.md
	// weapon_fire is available in both GOTV and POV demos
	p.parser.RegisterEventHandler(func(e events.GenericGameEvent) {
		if e.Name != "weapon_fire" {
			return
		}

		if currentRound == nil {
			return
		}
		updateTick()
		tick := getCurrentTick()

		// Only track shots after freeze time ends
		if freezeEndTick == nil || tick < *freezeEndTick {
			return
		}

		// Get userid from event data
		// GenericGameEvent.Data is a map[string]*msg.CMsgSource1LegacyGameEventKeyT
		var userid int
		if useridKey, ok := e.Data["userid"]; ok && useridKey != nil {
			// The value is stored in the KeyT structure
			// Try to get the integer value from ValLong or ValShort
			if useridKey.ValLong != nil {
				userid = int(*useridKey.ValLong)
			} else if useridKey.ValShort != nil {
				userid = int(*useridKey.ValShort)
			}
		}
		if userid == 0 {
			return
		}

		// Get weapon name from event data
		weaponName := "unknown"
		if weaponKey, ok := e.Data["weapon"]; ok && weaponKey != nil {
			if weaponKey.ValString != nil {
				weaponName = *weaponKey.ValString
			}
		}

		// Skip knife and grenades (we only want gun shots)
		if strings.Contains(weaponName, "knife") || 
		   strings.Contains(weaponName, "grenade") || 
		   strings.Contains(weaponName, "flashbang") ||
		   strings.Contains(weaponName, "smoke") ||
		   strings.Contains(weaponName, "molotov") ||
		   strings.Contains(weaponName, "incendiary") ||
		   strings.Contains(weaponName, "decoy") ||
		   strings.Contains(weaponName, "c4") {
			return
		}

		// Find player by userid
		gs := p.parser.GameState()
		if gs == nil {
			return
		}

		participants := gs.Participants()
		var player *common.Player
		for _, p := range participants.All() {
			if p != nil && int(p.Entity.ID()) == userid {
				player = p
				break
			}
		}

		if player == nil {
			return
		}

		// Skip spectators
		if player.Team == common.TeamSpectators || player.Team == common.TeamUnassigned {
			return
		}

		// Get player position
		pos := player.Position()

		// Get team
		var team *string
		switch player.Team {
		case common.TeamTerrorists:
			t := "T"
			team = &t
		case common.TeamCounterTerrorists:
			ct := "CT"
			team = &ct
		default:
			return
		}

		steamID := fmt.Sprintf("%d", player.SteamID64)

		// Get view direction (yaw angle) - same calculation as player positions
		viewDirX := player.ViewDirectionX()
		viewDirY := player.ViewDirectionY()
		var yaw float64
		if viewDirX != 0 || viewDirY != 0 {
			yaw = math.Atan2(float64(viewDirY), float64(viewDirX)) * 180.0 / math.Pi
			if yaw < 0 {
				yaw += 360
			}
		}

		// Get pitch (view angle up/down)
		// Note: ViewDirectionZ() doesn't exist in demoinfocs v5
		// We can calculate pitch from ViewDirectionX/Y if needed, but for now we'll skip it
		// Pitch is not critical for 2D viewer rendering
		var pitch *float64
		// TODO: Calculate pitch if needed using ViewDirectionX/Y conversion

		data.Shots = append(data.Shots, ShotData{
			RoundIndex: currentRound.RoundIndex,
			Tick:       tick,
			SteamID:    steamID,
			WeaponName: weaponName,
			X:          float64(pos.X),
			Y:          float64(pos.Y),
			Z:          float64(pos.Z),
			Yaw:        yaw,
			Pitch:      pitch,
			Team:       team,
		})
	})

	// Parse the demo
	if callback != nil {
		callback("parsing", 0, 0, 0)
	}

	// Parse with recovery to handle panics from demoinfocs
	var parseErr error
	var panicValue interface{}
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicValue = r
				parseErr = fmt.Errorf("parser panic: %v", r)
			}
		}()
		parseErr = p.parser.ParseToEnd()
	}()

	if parseErr != nil {
		// If we got a panic, provide more context
		if panicValue != nil {
			return nil, fmt.Errorf("parser crashed during parsing (demo may be corrupted, incomplete, or incompatible): %w", parseErr)
		}
		return nil, fmt.Errorf("failed to parse demo: %w", parseErr)
	}

	// Finalize last round if exists
	updateTick()
	finalTick := getCurrentTick()
	if finalTick > maxTick {
		maxTick = finalTick
	}
	if currentRound != nil {
		currentRound.EndTick = finalTick
		data.Rounds = append(data.Rounds, *currentRound)

		// Finalize pending events for last round
		teamDamageExtractor.FinalizeRound(currentRound.RoundIndex)
		teamFlashExtractor.FinalizeRound(currentRound.RoundIndex)
		// AFK detection is now done from database after positions are written
		disconnectExtractor.FinalizeRound(currentRound.RoundIndex)
	}

	// Collect all extracted events
	if callback != nil {
		callback("extracting_events", finalTick, roundNumber, 0)
	}

	data.Events = make([]extractors.Event, 0)
	data.Events = append(data.Events, teamKillExtractor.GetEvents()...)
	data.Events = append(data.Events, teamDamageExtractor.GetEvents()...)
	data.Events = append(data.Events, teamFlashExtractor.GetEvents()...)
	data.Events = append(data.Events, disconnectExtractor.GetEvents()...)
	data.Events = append(data.Events, afkExtractor.GetEvents()...)

	// Extract header information
	// In v5, we get map name and other info from GameState after parsing
	gs := p.parser.GameState()
	if gs != nil {
		// Try to get map name from GameState
		// In v5, GameState might have map information
		if mapName == "" {
			// Try alternative methods to get map name
			// Some versions might have it in different places
		}
	}

	// Set map name (use tracked value or leave empty)
	data.Map = mapName

	// Get tick rate - in demoinfocs v5, tick rate is typically 64 for CS2
	// Common values: 64 (most CS2 servers), 128 (some servers)
	data.TickRate = tickRate

	// Convert player map to slice
	for _, player := range playerMap {
		data.Players = append(data.Players, *player)
	}

	// Estimate freeze end tick for rounds that don't have it
	// Best-effort: assume freeze time is typically 15 seconds at tick rate
	// This is a fallback when RoundFreezetimeEnd event is not available
	if data.TickRate > 0 {
		estimatedFreezeTicks := int(data.TickRate * 15) // 15 seconds
		for i := range data.Rounds {
			if data.Rounds[i].FreezeEndTick == nil {
				estimated := data.Rounds[i].StartTick + estimatedFreezeTicks
				data.Rounds[i].FreezeEndTick = &estimated
			}
		}
	}

	return data, nil
}

// Close closes the parser and underlying file.
func (p *Parser) Close() error {
	return p.parser.Close()
}

// getSteamID converts a player's SteamID64 to a string, handling nil players.
func getSteamID(player *common.Player) *string {
	if player == nil {
		return nil
	}
	steamID := fmt.Sprintf("%d", player.SteamID64)
	return &steamID
}

