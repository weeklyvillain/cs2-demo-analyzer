package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"cs-griefer-electron/internal/db"
	"cs-griefer-electron/internal/ipc"
	"cs-griefer-electron/internal/parser"
	"cs-griefer-electron/internal/parser/extractors"
	"cs-griefer-electron/internal/scoring"
)

const (
	exitSuccess = 0
	exitFailure = 1
)

func main() {
	var (
		demoPath         = flag.String("demo", "", "Path to CS2 demo file")
		outPath          = flag.String("out", "", "Path to output SQLite database")
		matchID          = flag.String("match-id", "", "Optional match ID (defaults to demo filename)")
		positionInterval = flag.Int("position-interval", 4, "Position extraction interval (1=all, 2=half, 4=quarter)")
	)
	flag.Parse()

	// Validate required arguments
	if *demoPath == "" {
		fmt.Fprintf(os.Stderr, "error: --demo is required\n")
		os.Exit(exitFailure)
	}
	if *outPath == "" {
		fmt.Fprintf(os.Stderr, "error: --out is required\n")
		os.Exit(exitFailure)
	}

	// Generate match ID if not provided
	if *matchID == "" {
		base := filepath.Base(*demoPath)
		*matchID = base[:len(base)-len(filepath.Ext(base))]
	}

	// Setup context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle interrupt signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	// Initialize output handler
	output := ipc.NewOutput()

	// Run the parser
	if err := run(ctx, *demoPath, *outPath, *matchID, *positionInterval, output); err != nil {
		output.Error(err.Error())
		os.Exit(exitFailure)
	}

	os.Exit(exitSuccess)
}

func run(ctx context.Context, demoPath, outPath, matchID string, positionInterval int, output *ipc.Output) error {
	output.Log("info", fmt.Sprintf("Starting parser for demo: %s", demoPath))
	output.Log("info", fmt.Sprintf("Output database: %s", outPath))
	output.Log("info", fmt.Sprintf("Match ID: %s", matchID))

	// Open database
	output.Log("info", "Opening database...")
	dbConn, err := db.Open(ctx, outPath)
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}
	defer dbConn.Close()

	writer := db.NewWriter(dbConn)

	// Insert placeholder match record BEFORE parsing starts
	// This is required because players and positions have foreign key constraints to matches
	// We'll update it with full data after parsing completes
	output.Log("info", "Inserting placeholder match record...")
	unknownSource := "unknown"
	placeholderMatch := db.Match{
		ID:        matchID,
		Map:       "unknown", // Will be updated after parsing
		TickRate:  64.0,     // Default, will be updated after parsing
		StartedAt: nil,      // Will be updated after parsing
		Source:    &unknownSource, // Will be updated after parsing
	}
	if err := writer.InsertMatch(ctx, placeholderMatch); err != nil {
		return fmt.Errorf("failed to insert placeholder match: %w", err)
	}

	// Create parser
	output.Log("info", "Creating parser...")
	p, err := parser.NewParser(demoPath)
	if err != nil {
		return fmt.Errorf("failed to create parser: %w", err)
	}
	defer p.Close()

	// Parse demo with progress callback
	output.Log("info", fmt.Sprintf("Parsing demo with position interval: %d", positionInterval))
	matchData, err := p.ParseWithDB(ctx, func(stage string, tick, round int, pct float64) {
		output.Progress(stage, tick, round, pct)
	}, dbConn, positionInterval, writer, matchID)
	if err != nil {
		// The error message already includes context about crashes
		return err
	}

	output.Log("info", fmt.Sprintf("Parsed %d rounds, %d players, %d events", len(matchData.Rounds), len(matchData.Players), len(matchData.Events)))

	// Update match metadata with actual data from parsing
	output.Log("info", "Updating match metadata...")
	source := matchData.Source
	match := db.Match{
		ID:        matchID,
		Map:       matchData.Map,
		TickRate:  matchData.TickRate,
		StartedAt: matchData.StartedAt,
		Source:    &source,
	}
	if err := writer.InsertMatch(ctx, match); err != nil {
		return fmt.Errorf("failed to update match: %w", err)
	}

	// Store players
	output.Log("info", fmt.Sprintf("Storing %d players...", len(matchData.Players)))
	for _, playerData := range matchData.Players {
		player := db.Player{
			MatchID:            matchID,
			SteamID:            playerData.SteamID,
			Name:               playerData.Name,
			Team:               playerData.Team,
			ConnectedMidgame:   playerData.ConnectedMidgame,
			PermanentDisconnect: playerData.PermanentDisconnect,
			FirstConnectRound:  playerData.FirstConnectRound,
			DisconnectRound:    playerData.DisconnectRound,
		}
		// Debug: log team assignment
		if playerData.Team == "" {
			output.Log("warn", fmt.Sprintf("Player %s (%s) has no team assigned!", playerData.SteamID, playerData.Name))
		} else {
			output.Log("info", fmt.Sprintf("Player %s (%s) assigned to team %s", playerData.SteamID, playerData.Name, playerData.Team))
		}
		if err := writer.InsertPlayer(ctx, player); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert player %s: %v", playerData.SteamID, err))
			// Continue with other players
		}
	}

	// Store rounds
	output.Log("info", fmt.Sprintf("Storing %d rounds...", len(matchData.Rounds)))
	for _, roundData := range matchData.Rounds {
		round := db.Round{
			MatchID:       matchID,
			RoundIndex:    roundData.RoundIndex,
			StartTick:     roundData.StartTick,
			FreezeEndTick: roundData.FreezeEndTick,
			EndTick:       roundData.EndTick,
			TWins:         roundData.TWins,
			CTWins:        roundData.CTWins,
			Winner:        roundData.Winner,
		}
		if err := writer.InsertRound(ctx, round); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert round %d: %v", roundData.RoundIndex, err))
			// Continue with other rounds
		}
	}

	// Store events
	output.Log("info", fmt.Sprintf("Storing %d events...", len(matchData.Events)))
	eventCount := 0
	for _, eventData := range matchData.Events {
		event := db.Event{
			MatchID:       matchID,
			RoundIndex:    eventData.RoundIndex,
			Type:          eventData.Type,
			StartTick:     eventData.StartTick,
			EndTick:        eventData.EndTick,
			ActorSteamID:   eventData.ActorSteamID,
			VictimSteamID:  eventData.VictimSteamID,
			Severity:       &eventData.Severity,
			Confidence:     &eventData.Confidence,
			MetaJSON:       eventData.MetaJSON,
		}
		if err := writer.InsertEvent(ctx, event); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert event %s: %v", eventData.Type, err))
			// Continue with other events
		} else {
			eventCount++
			// Rate limit logging: log every 10th event or every event type change
			if eventCount%10 == 0 {
				output.Log("info", fmt.Sprintf("Inserted %d events...", eventCount))
			}
		}
	}
	output.Log("info", fmt.Sprintf("Stored %d events", eventCount))

	// Store chat messages
	output.Log("info", fmt.Sprintf("Storing %d chat messages...", len(matchData.ChatMessages)))
	chatMessages := make([]db.ChatMessage, 0, len(matchData.ChatMessages))
	for _, chatData := range matchData.ChatMessages {
		var name *string
		if chatData.Name != "" {
			name = &chatData.Name
		}
		var team *string
		if chatData.Team != "" {
			team = &chatData.Team
		}
		chatMessages = append(chatMessages, db.ChatMessage{
			MatchID:    matchID,
			RoundIndex: chatData.RoundIndex,
			Tick:       chatData.Tick,
			SteamID:    chatData.SteamID,
			Name:       name,
			Team:       team,
			Message:    chatData.Message,
			IsTeamChat: chatData.IsTeamChat,
		})
	}
	if len(chatMessages) > 0 {
		if err := writer.InsertChatMessages(ctx, chatMessages); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert chat messages: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d chat messages", len(chatMessages)))
		}
	}

	// Store player positions (only if not already inserted incrementally)
	// Positions are now inserted incrementally during parsing, so this is only for backward compatibility
	if len(matchData.Positions) > 0 {
		output.Log("info", fmt.Sprintf("Storing %d player positions (fallback mode)...", len(matchData.Positions)))
		positions := make([]db.PlayerPosition, 0, len(matchData.Positions))
		for _, posData := range matchData.Positions {
			var team *string
			if posData.Team != "" {
				team = &posData.Team
			}
			var yaw *float64
			if posData.Yaw != 0 {
				yaw = &posData.Yaw
			}
			positions = append(positions, db.PlayerPosition{
				MatchID:    matchID,
				RoundIndex: posData.RoundIndex,
				Tick:       posData.Tick,
				SteamID:    posData.SteamID,
				X:          posData.X,
				Y:          posData.Y,
				Z:          posData.Z,
				Yaw:        yaw,
				Team:       team,
				Health:     posData.Health,
				Armor:      posData.Armor,
				Weapon:     posData.Weapon,
			})
		}
		if err := writer.InsertPlayerPositions(ctx, positions); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert player positions: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d player positions", len(positions)))
		}
	} else {
		output.Log("info", "Player positions were inserted incrementally during parsing")
	}

	// Process AFK detection from database positions
	output.Log("info", "Processing AFK detection from database...")
	afkExtractor := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
	for _, roundData := range matchData.Rounds {
		if roundData.FreezeEndTick == nil {
			continue // Skip rounds without freeze end tick
		}
		if err := afkExtractor.ProcessAFKFromDatabase(matchID, roundData.RoundIndex, *roundData.FreezeEndTick, roundData.EndTick); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to process AFK for round %d: %v", roundData.RoundIndex, err))
		}
	}
	// Write AFK events to database
	afkEvents := afkExtractor.GetEvents()
	if len(afkEvents) > 0 {
		output.Log("info", fmt.Sprintf("Found %d AFK events", len(afkEvents)))
		dbEvents := make([]db.Event, 0, len(afkEvents))
		for _, eventData := range afkEvents {
			dbEvents = append(dbEvents, db.Event{
				MatchID:       matchID,
				RoundIndex:    eventData.RoundIndex,
				Type:          eventData.Type,
				StartTick:     eventData.StartTick,
				EndTick:        eventData.EndTick,
				ActorSteamID:   eventData.ActorSteamID,
				VictimSteamID:  eventData.VictimSteamID,
				Severity:       &eventData.Severity,
				Confidence:     &eventData.Confidence,
				MetaJSON:       eventData.MetaJSON,
			})
		}
		if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to batch insert AFK events: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d AFK events", len(afkEvents)))
		}
	}

	// Store grenade positions
	output.Log("info", fmt.Sprintf("Storing %d grenade positions...", len(matchData.GrenadePositions)))
	grenadePositions := make([]db.GrenadePosition, 0, len(matchData.GrenadePositions))
	for _, grenadePosData := range matchData.GrenadePositions {
		grenadePositions = append(grenadePositions, db.GrenadePosition{
			MatchID:        matchID,
			RoundIndex:     grenadePosData.RoundIndex,
			Tick:           grenadePosData.Tick,
			ProjectileID:   grenadePosData.ProjectileID,
			GrenadeName:    grenadePosData.GrenadeName,
			X:              grenadePosData.X,
			Y:              grenadePosData.Y,
			Z:              grenadePosData.Z,
			ThrowerSteamID: grenadePosData.ThrowerSteamID,
			ThrowerName:    grenadePosData.ThrowerName,
			ThrowerTeam:    grenadePosData.ThrowerTeam,
		})
	}
	if len(grenadePositions) > 0 {
		if err := writer.InsertGrenadePositions(ctx, grenadePositions); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert grenade positions: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d grenade positions", len(grenadePositions)))
		}
	}

	// Store grenade events
	output.Log("info", fmt.Sprintf("Storing %d grenade events...", len(matchData.GrenadeEvents)))
	grenadeEvents := make([]db.GrenadeEvent, 0, len(matchData.GrenadeEvents))
	for _, grenadeEventData := range matchData.GrenadeEvents {
		grenadeEvents = append(grenadeEvents, db.GrenadeEvent{
			MatchID:        matchID,
			RoundIndex:     grenadeEventData.RoundIndex,
			Tick:           grenadeEventData.Tick,
			EventType:      grenadeEventData.EventType,
			ProjectileID:   grenadeEventData.ProjectileID,
			GrenadeName:    grenadeEventData.GrenadeName,
			X:              grenadeEventData.X,
			Y:              grenadeEventData.Y,
			Z:              grenadeEventData.Z,
			ThrowerSteamID: grenadeEventData.ThrowerSteamID,
			ThrowerName:    grenadeEventData.ThrowerName,
			ThrowerTeam:    grenadeEventData.ThrowerTeam,
		})
	}
	if len(grenadeEvents) > 0 {
	if err := writer.InsertGrenadeEvents(ctx, grenadeEvents); err != nil {
		output.Log("warn", fmt.Sprintf("Failed to insert grenade events: %v", err))
	} else {
		output.Log("info", fmt.Sprintf("Stored %d grenade events", len(grenadeEvents)))
	}

	// Store shots
	output.Log("info", fmt.Sprintf("Storing %d shots...", len(matchData.Shots)))
	shots := make([]db.Shot, 0, len(matchData.Shots))
	for _, shotData := range matchData.Shots {
		shots = append(shots, db.Shot{
			MatchID:    matchID,
			RoundIndex: shotData.RoundIndex,
			Tick:       shotData.Tick,
			SteamID:    shotData.SteamID,
			WeaponName: shotData.WeaponName,
			X:          shotData.X,
			Y:          shotData.Y,
			Z:          shotData.Z,
			Yaw:        shotData.Yaw,
			Pitch:      shotData.Pitch,
			Team:       shotData.Team,
		})
	}
	if len(shots) > 0 {
		if err := writer.InsertShots(ctx, shots); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert shots: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d shots", len(shots)))
		}
	}
	}

	// Store metadata
	if err := writer.SetMeta(ctx, "demo_path", demoPath); err != nil {
		output.Log("warn", fmt.Sprintf("Failed to store demo_path meta: %v", err))
	}
	createdAtIso := time.Now().Format(time.RFC3339)
	if err := writer.SetMeta(ctx, "created_at_iso", createdAtIso); err != nil {
		output.Log("warn", fmt.Sprintf("Failed to store created_at_iso meta: %v", err))
	}
	if err := writer.SetMeta(ctx, "parsed_at", createdAtIso); err != nil {
		output.Log("warn", fmt.Sprintf("Failed to store parsed_at meta: %v", err))
	}

	// Compute player scores
	output.Log("info", "Computing player scores...")
	reader := db.NewReader(dbConn)
	scorer := scoring.NewScorer(writer)
	if err := scorer.ComputeScores(ctx, matchID, reader); err != nil {
		return fmt.Errorf("failed to compute scores: %w", err)
	}
	output.Log("info", "Player scores computed")

	output.Log("info", "Parsing complete!")
	output.Progress("complete", 0, len(matchData.Rounds), 1.0)

	return nil
}

