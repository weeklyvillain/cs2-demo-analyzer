package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"cs-griefer-electron/internal/db"
	"cs-griefer-electron/internal/ipc"
	"cs-griefer-electron/internal/parser"
	"cs-griefer-electron/internal/parser/extractors"
	"cs-griefer-electron/internal/scoring"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	setConsoleTitleProc = kernel32.NewProc("SetConsoleTitleW")
)

const (
	exitSuccess = 0
	exitFailure = 1
)

// setProcessTitle sets the console window title on Windows
func setProcessTitle(title string) {
	if runtime.GOOS == "windows" {
		// Convert Go string to UTF-16 pointer
		utf16Title, err := syscall.UTF16PtrFromString(title)
		if err != nil {
			return
		}
		// Call SetConsoleTitleW
		setConsoleTitleProc.Call(uintptr(unsafe.Pointer(utf16Title)))
	}
}

func main() {
	var (
		demoPath         = flag.String("demo", "", "Path to CS2 demo file")
		outPath          = flag.String("out", "", "Path to output SQLite database (required for database mode)")
		outputPath       = flag.String("output", "", "Path to output file (required for json mode)")
		mode             = flag.String("mode", "database", "Output mode: 'json' or 'database'")
		steamIDs         = flag.String("steam-ids", "", "Comma-separated list of Steam IDs to filter (optional)")
		matchID          = flag.String("match-id", "", "Optional match ID (defaults to demo filename)")
		positionInterval = flag.Int("position-interval", 4, "Position extraction interval (1=all, 2=half, 4=quarter)")
		memoryLimitMB    = flag.Int("memory-limit", 0, "Memory limit in MB for JSON mode (0 = no limit, splits JSON when limit reached)")
	)
	flag.Parse()

	// Set process title/name for better identification in task manager
	processTitle := "CS2 Demo Parser"
	if *demoPath != "" {
		demoName := filepath.Base(*demoPath)
		if demoName != "" {
			processTitle = fmt.Sprintf("CS2 Demo Parser - %s", demoName)
		}
	}
	setProcessTitle(processTitle)

	// Validate required arguments
	if *demoPath == "" {
		fmt.Fprintf(os.Stderr, "error: --demo is required\n")
		os.Exit(exitFailure)
	}

	// Validate mode
	if *mode != "json" && *mode != "database" {
		fmt.Fprintf(os.Stderr, "error: --mode must be 'json' or 'database'\n")
		os.Exit(exitFailure)
	}

	// Validate output path based on mode
	if *mode == "json" {
		if *outputPath == "" {
			fmt.Fprintf(os.Stderr, "error: --output is required when --mode=json\n")
			os.Exit(exitFailure)
		}
	} else {
		if *outPath == "" {
			fmt.Fprintf(os.Stderr, "error: --out is required when --mode=database\n")
			os.Exit(exitFailure)
		}
	}

	// Set memory limit if provided (applies to all modes)
	// This uses Go's built-in memory limit which triggers more aggressive GC
	if *memoryLimitMB > 0 {
		memoryLimitBytes := int64(*memoryLimitMB) * 1024 * 1024 // Convert MB to bytes
		debug.SetMemoryLimit(memoryLimitBytes)
		fmt.Fprintf(os.Stderr, "Set memory limit to %d MB\n", *memoryLimitMB)
	}

	// Parse steam IDs if provided
	var steamIDSet map[string]bool
	if *steamIDs != "" {
		steamIDSet = make(map[string]bool)
		ids := strings.Split(*steamIDs, ",")
		for _, id := range ids {
			id = strings.TrimSpace(id)
			if id != "" {
				steamIDSet[id] = true
			}
		}
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
	var err error
	if *mode == "json" {
		memoryLimitBytes := int64(0)
		if *memoryLimitMB > 0 {
			memoryLimitBytes = int64(*memoryLimitMB) * 1024 * 1024 // Convert MB to bytes
		}
		err = runJSON(ctx, *demoPath, *outputPath, *matchID, *positionInterval, steamIDSet, memoryLimitBytes, output)
	} else {
		err = run(ctx, *demoPath, *outPath, *matchID, *positionInterval, output)
	}

	if err != nil {
		output.Error(err.Error())
		os.Exit(exitFailure)
	}

	os.Exit(exitSuccess)
}

// getMemoryUsage returns current memory usage in bytes
func getMemoryUsage() int64 {
	var m runtime.MemStats
	runtime.GC() // Force GC before measuring for more accurate reading
	runtime.ReadMemStats(&m)
	return int64(m.Alloc)
}

// runJSON runs the parser in JSON output mode with file-based streaming
func runJSON(ctx context.Context, demoPath, outputPath, matchID string, positionInterval int, steamIDSet map[string]bool, memoryLimitBytes int64, output *ipc.Output) error {
	output.Log("info", fmt.Sprintf("Starting parser for demo: %s", demoPath))
	output.Log("info", fmt.Sprintf("Output JSON: %s", outputPath))
	output.Log("info", fmt.Sprintf("Match ID: %s", matchID))
	if len(steamIDSet) > 0 {
		output.Log("info", fmt.Sprintf("Filtering by %d Steam ID(s)", len(steamIDSet)))
	}

	// Create temporary events file for streaming
	eventsFilePath := outputPath + ".events.tmp"
	eventsFile, err := os.Create(eventsFilePath)
	if err != nil {
		return fmt.Errorf("failed to create events file: %w", err)
	}
	defer eventsFile.Close()
	defer os.Remove(eventsFilePath) // Clean up temp file

	// Create parser
	output.Log("info", "Creating parser...")
	p, err := parser.NewParser(demoPath)
	if err != nil {
		return fmt.Errorf("failed to create parser: %w", err)
	}
	defer p.Close()

	// Track partial files for memory management
	var partialFiles []string
	partNumber := 1
	allowedEventTypes := map[string]bool{
		"TEAM_KILL":      true,
		"TEAM_DAMAGE":    true,
		"DISCONNECT":     true,
		"RECONNECT":      true,
		"AFK":            true,
		"TEAM_FLASH":     true,
		"ECONOMY_GRIEF":  true,
		"BODY_BLOCK":     true,
	}

	// Parse demo - events will be written to file during parsing
	// IMPORTANT: All parsing steps must complete synchronously before closing the parser
	// to ensure demoinfocs releases the demo file from memory
	output.Log("info", fmt.Sprintf("Parsing demo with position interval: %d", positionInterval))
	matchData, err := p.ParseWithDB(ctx, func(stage string, tick, round int, pct float64) {
		output.Progress(stage, tick, round, pct)
	}, nil, positionInterval, nil, "", eventsFile, steamIDSet)
	if err != nil {
		eventsFile.Close()
		return err
	}

	// Flush and close events file before reading
	if err := eventsFile.Sync(); err != nil {
		eventsFile.Close()
		return fmt.Errorf("failed to sync events file: %w", err)
	}
	eventsFile.Close()

	// Close parser immediately after parsing completes to free demoinfocs memory
	// This releases the demo file copy that demoinfocs keeps in memory
	// Note: defer will also try to close, but Close() handles multiple calls gracefully
	if closeErr := p.Close(); closeErr != nil {
		// Only log if it's not a "file already closed" error (which is harmless)
		if !strings.Contains(closeErr.Error(), "file already closed") {
			output.Log("warn", fmt.Sprintf("Error closing parser: %v", closeErr))
		}
	}
	// Force GC to ensure memory is freed before processing events
	runtime.GC()

	output.Log("info", fmt.Sprintf("Parsed %d rounds, %d players", len(matchData.Rounds), len(matchData.Players)))

	// Stream events from NDJSON file, filter on-the-fly, and write to sorted chunks
	// This is truly streaming - never loads all events into memory
	output.Log("info", "Streaming and filtering events from NDJSON file...")
	eventsFile, err = os.Open(eventsFilePath)
	if err != nil {
		return fmt.Errorf("failed to open events file: %w", err)
	}
	defer eventsFile.Close()

	// Process events in fixed-size chunks to keep memory bounded
	const chunkSize = 100000 // Process 100K events per chunk (bounded memory)
	jsonEventsChunk := make([]JSONEvent, 0, chunkSize)
	eventCount := 0
	filteredCount := 0

	// Read NDJSON line by line (one JSON object per line)
	// json.Decoder works for NDJSON - we decode until EOF
	decoder := json.NewDecoder(eventsFile)

	// Track memory usage for threshold-based flushing
	const memoryCheckInterval = 10000 // Check memory every 10K events
	lastMemoryCheck := 0

	for {
		var event extractors.Event
		// Decode until EOF (works for NDJSON - one JSON object per line)
		if err := decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				break // End of file
			}
			// Try to continue on other decode errors (malformed JSON line)
			// Log warning but don't fail
			continue
		}
		eventCount++

		// Filter by Steam IDs if provided (immediate filtering)
		if len(steamIDSet) > 0 {
			actorMatch := event.ActorSteamID != nil && steamIDSet[*event.ActorSteamID]
			victimMatch := event.VictimSteamID != nil && steamIDSet[*event.VictimSteamID]
			if !actorMatch && !victimMatch {
				continue
			}
		}

		// Filter by event type (immediate filtering)
		if !allowedEventTypes[event.Type] {
			continue
		}

		filteredCount++

		// Convert to JSONEvent immediately (no intermediate storage)
		jsonEvent := JSONEvent{
			Type:          event.Type,
			RoundIndex:    event.RoundIndex,
			StartTick:     event.StartTick,
			EndTick:       event.EndTick,
			ActorSteamID:  event.ActorSteamID,
			VictimSteamID: event.VictimSteamID,
		}

		// Extract reason from MetaJSON for DISCONNECT events
		if event.Type == "DISCONNECT" && event.MetaJSON != nil {
			var meta map[string]interface{}
			if err := json.Unmarshal([]byte(*event.MetaJSON), &meta); err == nil {
				if reason, ok := meta["reason"].(string); ok && reason != "" {
					jsonEvent.Reason = &reason
				}
			}
		}

		jsonEventsChunk = append(jsonEventsChunk, jsonEvent)

		// Check if we should flush chunk (size-based or memory-based)
		shouldFlush := len(jsonEventsChunk) >= chunkSize

		// Check memory usage periodically
		if !shouldFlush && memoryLimitBytes > 0 && (filteredCount-lastMemoryCheck) >= memoryCheckInterval {
			memUsage := getMemoryUsage()
			if memUsage >= memoryLimitBytes {
				shouldFlush = true
				output.Log("info", fmt.Sprintf("Memory limit reached (%d MB), flushing chunk %d...", memUsage/(1024*1024), partNumber))
			}
			lastMemoryCheck = filteredCount
		}

		if shouldFlush {
			chunkPath := fmt.Sprintf("%s.chunk%d", outputPath, partNumber)
			partialFiles = append(partialFiles, chunkPath)

			if err := writeSortedChunk(jsonEventsChunk, chunkPath); err != nil {
				return fmt.Errorf("failed to write chunk: %w", err)
			}

			jsonEventsChunk = jsonEventsChunk[:0] // Clear chunk (reuse underlying array)
			runtime.GC()
			partNumber++
		}
	}

	output.Log("info", fmt.Sprintf("Processed %d events, filtered to %d relevant events", eventCount, filteredCount))

	// Write final chunk if any remaining events
	if len(jsonEventsChunk) > 0 {
		chunkPath := fmt.Sprintf("%s.chunk%d", outputPath, partNumber)
		partialFiles = append(partialFiles, chunkPath)

		if err := writeSortedChunk(jsonEventsChunk, chunkPath); err != nil {
			return fmt.Errorf("failed to write final chunk: %w", err)
		}
		jsonEventsChunk = nil // Free memory
		runtime.GC()
	}

	// Merge sorted chunks into final output (streaming merge, no full file reads)
	if len(partialFiles) > 0 {
		output.Log("info", fmt.Sprintf("Merging %d sorted chunks into final JSON...", len(partialFiles)))
		if err := mergeSortedChunks(partialFiles, outputPath); err != nil {
			return fmt.Errorf("failed to merge chunks: %w", err)
		}

		// Clean up chunk files
		output.Log("info", "Cleaning up chunk files...")
		for _, chunkPath := range partialFiles {
			if err := os.Remove(chunkPath); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to remove chunk file %s: %v", chunkPath, err))
			}
		}
	} else {
		// No events to write
		output.Log("info", "No events to write")
		// Write empty array
		if err := os.WriteFile(outputPath, []byte("[]\n"), 0644); err != nil {
			return fmt.Errorf("failed to write empty JSON: %w", err)
		}
	}

	output.Log("info", "Parsing complete!")
	output.Progress("complete", 0, len(matchData.Rounds), 1.0)

	return nil
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

	// Determine if we should use RAM-only parsing (in-memory mode)
	// RAM-only parsing: pass empty matchID to ParseWithDB to force in-memory accumulation
	// But we still need a matchID for the database, so we use the provided matchID for DB operations
	useRAMOnlyParsing := matchID == ""
	var actualMatchID string
	if useRAMOnlyParsing {
		// Generate matchID from demo filename if not provided
		base := filepath.Base(demoPath)
		actualMatchID = base[:len(base)-len(filepath.Ext(base))]
		output.Log("info", fmt.Sprintf("RAM-only parsing enabled: accumulating all data in memory before writing to disk (Match ID: %s)", actualMatchID))
	} else {
		actualMatchID = matchID
	}

	// Insert placeholder match record BEFORE parsing starts
	// This is required because players and positions have foreign key constraints to matches
	// We'll update it with full data after parsing completes
	output.Log("info", "Inserting placeholder match record...")
	unknownSource := "unknown"
	placeholderMatch := db.Match{
		ID:        actualMatchID,  // Use actualMatchID for database
		Map:       "unknown",      // Will be updated after parsing
		TickRate:  64.0,           // Default, will be updated after parsing
		StartedAt: nil,            // Will be updated after parsing
		Source:    &unknownSource, // Will be updated after parsing
	}
	if err := writer.InsertMatch(ctx, placeholderMatch); err != nil {
		return fmt.Errorf("failed to insert placeholder match: %w", err)
	}

	// Create parser
	// IMPORTANT: Parser must be closed after ALL parsing steps complete (synchronously)
	// to free the demo file copy that demoinfocs keeps in memory
	output.Log("info", "Creating parser...")
	p, err := parser.NewParser(demoPath)
	if err != nil {
		return fmt.Errorf("failed to create parser: %w", err)
	}
	// Note: We defer Close() as a safety net, but also explicitly close after parsing completes
	// to ensure memory is freed as soon as possible
	defer p.Close()

	// Parse demo with progress callback
	// IMPORTANT: All parsing steps must complete synchronously before closing the parser
	// to ensure demoinfocs releases the demo file from memory
	output.Log("info", fmt.Sprintf("Parsing demo with position interval: %d", positionInterval))

	// For RAM-only parsing, pass empty matchID to ParseWithDB to force in-memory mode
	// This makes ParseWithDB accumulate all data in memory instead of streaming to DB
	// We use actualMatchID for database operations, but empty string for ParseWithDB when RAM-only
	parseMatchID := ""
	if !useRAMOnlyParsing {
		parseMatchID = actualMatchID // Use actual matchID for streaming mode
	}
	// When parseMatchID is empty, ParseWithDB will use in-memory mode (writer != nil but matchID == "")

	matchData, err := p.ParseWithDB(ctx, func(stage string, tick, round int, pct float64) {
		output.Progress(stage, tick, round, pct)
	}, dbConn, positionInterval, writer, parseMatchID, nil, nil)

	// Close parser immediately after parsing completes to free demoinfocs memory
	// This releases the demo file copy that demoinfocs keeps in memory
	// All parsing steps are now complete, so it's safe to close
	// Note: defer will also try to close, but Close() handles multiple calls gracefully
	if err == nil {
		if closeErr := p.Close(); closeErr != nil {
			// Only log if it's not a "file already closed" error (which is harmless)
			if !strings.Contains(closeErr.Error(), "file already closed") {
				output.Log("warn", fmt.Sprintf("Error closing parser: %v", closeErr))
			}
		}
		// Force GC to ensure memory is freed before storing data
		runtime.GC()
	}

	if err != nil {
		// The error message already includes context about crashes
		return err
	}

	output.Log("info", fmt.Sprintf("Parsed %d rounds, %d players, %d events", len(matchData.Rounds), len(matchData.Players), len(matchData.Events)))

	// Update match metadata with actual data from parsing
	output.Log("info", "Updating match metadata...")
	source := matchData.Source
	match := db.Match{
		ID:        actualMatchID, // Use actualMatchID for database
		Map:       matchData.Map,
		TickRate:  matchData.TickRate,
		StartedAt: matchData.StartedAt,
		Source:    &source,
	}
	if err := writer.InsertMatch(ctx, match); err != nil {
		return fmt.Errorf("failed to update match: %w", err)
	}

	// If RAM-only parsing was used, now write all accumulated data to database
	if useRAMOnlyParsing {
		output.Log("info", "RAM-only parsing: Writing accumulated data to database...")

		// Store players
		output.Log("info", fmt.Sprintf("Storing %d players...", len(matchData.Players)))
		for _, playerData := range matchData.Players {
			player := db.Player{
				MatchID:             actualMatchID, // Use actualMatchID for database
				SteamID:             playerData.SteamID,
				Name:                playerData.Name,
				Team:                playerData.Team,
				ConnectedMidgame:    playerData.ConnectedMidgame,
				PermanentDisconnect: playerData.PermanentDisconnect,
				FirstConnectRound:   playerData.FirstConnectRound,
				DisconnectRound:     playerData.DisconnectRound,
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
				MatchID:       actualMatchID, // Use actualMatchID for database
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
				MatchID:       actualMatchID, // Use actualMatchID for database
				RoundIndex:    eventData.RoundIndex,
				Type:          eventData.Type,
				StartTick:     eventData.StartTick,
				EndTick:       eventData.EndTick,
				ActorSteamID:  eventData.ActorSteamID,
				VictimSteamID: eventData.VictimSteamID,
				Severity:      &eventData.Severity,
				Confidence:    &eventData.Confidence,
				MetaJSON:      eventData.MetaJSON,
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

		// Store chat messages (RAM-only mode accumulates these)
		if len(matchData.ChatMessages) > 0 {
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
					MatchID:    actualMatchID, // Use actualMatchID for database
					RoundIndex: chatData.RoundIndex,
					Tick:       chatData.Tick,
					SteamID:    chatData.SteamID,
					Name:       name,
					Team:       team,
					Message:    chatData.Message,
					IsTeamChat: chatData.IsTeamChat,
				})
			}
			if err := writer.InsertChatMessages(ctx, chatMessages); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to insert chat messages: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d chat messages", len(chatMessages)))
			}
		}

		// Store player positions (RAM-only mode accumulates these)
		if len(matchData.Positions) > 0 {
			output.Log("info", fmt.Sprintf("Storing %d player positions...", len(matchData.Positions)))
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
					MatchID:    actualMatchID, // Use actualMatchID for database
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
		}

		// Process AFK detection from database positions
		output.Log("info", "Processing AFK detection from database...")
		afkExtractor := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
		for _, roundData := range matchData.Rounds {
			if roundData.FreezeEndTick == nil {
				continue // Skip rounds without freeze end tick
			}
			if err := afkExtractor.ProcessAFKFromDatabase(actualMatchID, roundData.RoundIndex, *roundData.FreezeEndTick, roundData.EndTick); err != nil {
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
					MatchID:       actualMatchID, // Use actualMatchID for database
					RoundIndex:    eventData.RoundIndex,
					Type:          eventData.Type,
					StartTick:     eventData.StartTick,
					EndTick:       eventData.EndTick,
					ActorSteamID:  eventData.ActorSteamID,
					VictimSteamID: eventData.VictimSteamID,
					Severity:      &eventData.Severity,
					Confidence:    &eventData.Confidence,
					MetaJSON:      eventData.MetaJSON,
				})
			}
			afkExtractor.ClearEvents() // Clear events after writing to prevent accumulation
			if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to batch insert AFK events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d AFK events", len(afkEvents)))
			}
		}

		// Process body blocking detection from database positions
		output.Log("info", "Processing body blocking detection from database...")
		bodyBlockExtractor := extractors.NewBodyBlockExtractor(matchData.TickRate, dbConn)
		for _, roundData := range matchData.Rounds {
			bodyBlockExtractor.ProcessRoundFromDatabase(actualMatchID, roundData.RoundIndex, roundData.StartTick, roundData.EndTick)
		}
		// Write body block events to database
		bodyBlockEvents := bodyBlockExtractor.GetEvents()
		if len(bodyBlockEvents) > 0 {
			output.Log("info", fmt.Sprintf("Found %d body blocking events", len(bodyBlockEvents)))
			dbEvents := make([]db.Event, 0, len(bodyBlockEvents))
			for _, eventData := range bodyBlockEvents {
				dbEvents = append(dbEvents, db.Event{
					MatchID:       actualMatchID,
					RoundIndex:    eventData.RoundIndex,
					Type:          eventData.Type,
					StartTick:     eventData.StartTick,
					EndTick:       eventData.EndTick,
					ActorSteamID:  eventData.ActorSteamID,
					VictimSteamID: eventData.VictimSteamID,
					Severity:      &eventData.Severity,
					Confidence:    &eventData.Confidence,
					MetaJSON:      eventData.MetaJSON,
				})
			}
			bodyBlockExtractor.ClearEvents()
			if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to batch insert body blocking events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d body blocking events", len(bodyBlockEvents)))
			}
		}

		// Store grenade positions (RAM-only mode accumulates these)
		if len(matchData.GrenadePositions) > 0 {
			output.Log("info", fmt.Sprintf("Storing %d grenade positions...", len(matchData.GrenadePositions)))
			grenadePositions := make([]db.GrenadePosition, 0, len(matchData.GrenadePositions))
			for _, grenadePosData := range matchData.GrenadePositions {
				grenadePositions = append(grenadePositions, db.GrenadePosition{
					MatchID:        actualMatchID, // Use actualMatchID for database
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
			if err := writer.InsertGrenadePositions(ctx, grenadePositions); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to insert grenade positions: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d grenade positions", len(grenadePositions)))
			}
		}

		// Store grenade events (RAM-only mode accumulates these)
		if len(matchData.GrenadeEvents) > 0 {
			output.Log("info", fmt.Sprintf("Storing %d grenade events...", len(matchData.GrenadeEvents)))
			grenadeEvents := make([]db.GrenadeEvent, 0, len(matchData.GrenadeEvents))
			for _, grenadeEventData := range matchData.GrenadeEvents {
				grenadeEvents = append(grenadeEvents, db.GrenadeEvent{
					MatchID:        actualMatchID, // Use actualMatchID for database
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
			if err := writer.InsertGrenadeEvents(ctx, grenadeEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to insert grenade events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d grenade events", len(grenadeEvents)))
			}
		}

		// Store shots (RAM-only mode accumulates these)
		if len(matchData.Shots) > 0 {
			output.Log("info", fmt.Sprintf("Storing %d shots...", len(matchData.Shots)))
			shots := make([]db.Shot, 0, len(matchData.Shots))
			for _, shotData := range matchData.Shots {
				shots = append(shots, db.Shot{
					MatchID:    actualMatchID, // Use actualMatchID for database
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
			if err := writer.InsertShots(ctx, shots); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to insert shots: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d shots", len(shots)))
			}
		}
	} else {
		// Streaming mode: data was already written to database during parsing
		// Only handle events, players, and rounds (which are always stored after parsing)
		// Store players
		output.Log("info", fmt.Sprintf("Storing %d players...", len(matchData.Players)))
		for _, playerData := range matchData.Players {
			player := db.Player{
				MatchID:             actualMatchID, // Use actualMatchID for database
				SteamID:             playerData.SteamID,
				Name:                playerData.Name,
				Team:                playerData.Team,
				ConnectedMidgame:    playerData.ConnectedMidgame,
				PermanentDisconnect: playerData.PermanentDisconnect,
				FirstConnectRound:   playerData.FirstConnectRound,
				DisconnectRound:     playerData.DisconnectRound,
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
				MatchID:       actualMatchID, // Use actualMatchID for database
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
				MatchID:       actualMatchID, // Use actualMatchID for database
				RoundIndex:    eventData.RoundIndex,
				Type:          eventData.Type,
				StartTick:     eventData.StartTick,
				EndTick:       eventData.EndTick,
				ActorSteamID:  eventData.ActorSteamID,
				VictimSteamID: eventData.VictimSteamID,
				Severity:      &eventData.Severity,
				Confidence:    &eventData.Confidence,
				MetaJSON:      eventData.MetaJSON,
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

		// Process AFK detection from database positions (streaming mode)
		output.Log("info", "Processing AFK detection from database...")
		afkExtractor := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
		for _, roundData := range matchData.Rounds {
			if roundData.FreezeEndTick == nil {
				continue // Skip rounds without freeze end tick
			}
			if err := afkExtractor.ProcessAFKFromDatabase(actualMatchID, roundData.RoundIndex, *roundData.FreezeEndTick, roundData.EndTick); err != nil {
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
					MatchID:       actualMatchID, // Use actualMatchID for database
					RoundIndex:    eventData.RoundIndex,
					Type:          eventData.Type,
					StartTick:     eventData.StartTick,
					EndTick:       eventData.EndTick,
					ActorSteamID:  eventData.ActorSteamID,
					VictimSteamID: eventData.VictimSteamID,
					Severity:      &eventData.Severity,
					Confidence:    &eventData.Confidence,
					MetaJSON:      eventData.MetaJSON,
				})
			}
			afkExtractor.ClearEvents() // Clear events after writing to prevent accumulation
			if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to batch insert AFK events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d AFK events", len(afkEvents)))
			}
		}

		// Process body blocking detection from database positions (streaming mode)
		output.Log("info", "Processing body blocking detection from database...")
		bodyBlockExtractor := extractors.NewBodyBlockExtractor(matchData.TickRate, dbConn)
		for _, roundData := range matchData.Rounds {
			bodyBlockExtractor.ProcessRoundFromDatabase(actualMatchID, roundData.RoundIndex, roundData.StartTick, roundData.EndTick)
		}
		// Write body block events to database
		bodyBlockEvents := bodyBlockExtractor.GetEvents()
		if len(bodyBlockEvents) > 0 {
			output.Log("info", fmt.Sprintf("Found %d body blocking events", len(bodyBlockEvents)))
			dbEvents := make([]db.Event, 0, len(bodyBlockEvents))
			for _, eventData := range bodyBlockEvents {
				dbEvents = append(dbEvents, db.Event{
					MatchID:       actualMatchID,
					RoundIndex:    eventData.RoundIndex,
					Type:          eventData.Type,
					StartTick:     eventData.StartTick,
					EndTick:       eventData.EndTick,
					ActorSteamID:  eventData.ActorSteamID,
					VictimSteamID: eventData.VictimSteamID,
					Severity:      &eventData.Severity,
					Confidence:    &eventData.Confidence,
					MetaJSON:      eventData.MetaJSON,
				})
			}
			bodyBlockExtractor.ClearEvents()
			if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to batch insert body blocking events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d body blocking events", len(bodyBlockEvents)))
			}
		}
	}

	// Chat messages are already streamed to database during parsing via buffers (streaming mode)
	// Only handle fallback case (should not happen in normal operation)
	if !useRAMOnlyParsing && len(matchData.ChatMessages) > 0 {
		output.Log("warn", fmt.Sprintf("Found %d chat messages in MatchData (should be empty - data already in DB)", len(matchData.ChatMessages)))
		// Convert and insert as fallback (backward compatibility)
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
				MatchID:    actualMatchID, // Use actualMatchID for database
				RoundIndex: chatData.RoundIndex,
				Tick:       chatData.Tick,
				SteamID:    chatData.SteamID,
				Name:       name,
				Team:       team,
				Message:    chatData.Message,
				IsTeamChat: chatData.IsTeamChat,
			})
		}
		if err := writer.InsertChatMessages(ctx, chatMessages); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert chat messages: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d chat messages (fallback mode)", len(chatMessages)))
		}
	} else {
		output.Log("info", "Chat messages were streamed to database during parsing")
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
				MatchID:    actualMatchID, // Use actualMatchID for database
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

	// Process AFK detection from database positions (only in streaming mode, already done in RAM-only mode)
	if !useRAMOnlyParsing {
		output.Log("info", "Processing AFK detection from database...")
		afkExtractor := extractors.NewAFKExtractor(matchData.TickRate, dbConn)
		for _, roundData := range matchData.Rounds {
			if roundData.FreezeEndTick == nil {
				continue // Skip rounds without freeze end tick
			}
			if err := afkExtractor.ProcessAFKFromDatabase(actualMatchID, roundData.RoundIndex, *roundData.FreezeEndTick, roundData.EndTick); err != nil {
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
					MatchID:       actualMatchID, // Use actualMatchID for database
					RoundIndex:    eventData.RoundIndex,
					Type:          eventData.Type,
					StartTick:     eventData.StartTick,
					EndTick:       eventData.EndTick,
					ActorSteamID:  eventData.ActorSteamID,
					VictimSteamID: eventData.VictimSteamID,
					Severity:      &eventData.Severity,
					Confidence:    &eventData.Confidence,
					MetaJSON:      eventData.MetaJSON,
				})
			}
			afkExtractor.ClearEvents() // Clear events after writing to prevent accumulation
			if err := writer.BatchInsertEvents(ctx, dbEvents); err != nil {
				output.Log("warn", fmt.Sprintf("Failed to batch insert AFK events: %v", err))
			} else {
				output.Log("info", fmt.Sprintf("Stored %d AFK events", len(afkEvents)))
			}
		}
	}

	// Grenade positions are already streamed to database during parsing via buffers
	if len(matchData.GrenadePositions) > 0 {
		output.Log("warn", fmt.Sprintf("Found %d grenade positions in MatchData (should be empty - data already in DB)", len(matchData.GrenadePositions)))
		grenadePositions := make([]db.GrenadePosition, 0, len(matchData.GrenadePositions))
		for _, grenadePosData := range matchData.GrenadePositions {
			grenadePositions = append(grenadePositions, db.GrenadePosition{
				MatchID:        actualMatchID, // Use actualMatchID for database
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
		if err := writer.InsertGrenadePositions(ctx, grenadePositions); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert grenade positions: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d grenade positions (fallback mode)", len(grenadePositions)))
		}
	} else {
		output.Log("info", "Grenade positions were streamed to database during parsing")
	}

	// Grenade events are already streamed to database during parsing via buffers
	if len(matchData.GrenadeEvents) > 0 {
		output.Log("warn", fmt.Sprintf("Found %d grenade events in MatchData (should be empty - data already in DB)", len(matchData.GrenadeEvents)))
		grenadeEvents := make([]db.GrenadeEvent, 0, len(matchData.GrenadeEvents))
		for _, grenadeEventData := range matchData.GrenadeEvents {
			grenadeEvents = append(grenadeEvents, db.GrenadeEvent{
				MatchID:        actualMatchID, // Use actualMatchID for database
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
		if err := writer.InsertGrenadeEvents(ctx, grenadeEvents); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert grenade events: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d grenade events (fallback mode)", len(grenadeEvents)))
		}
	} else {
		output.Log("info", "Grenade events were streamed to database during parsing")
	}

	// Shots are already streamed to database during parsing via buffers
	if len(matchData.Shots) > 0 {
		output.Log("warn", fmt.Sprintf("Found %d shots in MatchData (should be empty - data already in DB)", len(matchData.Shots)))
		shots := make([]db.Shot, 0, len(matchData.Shots))
		for _, shotData := range matchData.Shots {
			shots = append(shots, db.Shot{
				MatchID:    actualMatchID, // Use actualMatchID for database
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
		if err := writer.InsertShots(ctx, shots); err != nil {
			output.Log("warn", fmt.Sprintf("Failed to insert shots: %v", err))
		} else {
			output.Log("info", fmt.Sprintf("Stored %d shots (fallback mode)", len(shots)))
		}
	} else {
		output.Log("info", "Shots were streamed to database during parsing")
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
	if err := scorer.ComputeScores(ctx, actualMatchID, reader); err != nil {
		return fmt.Errorf("failed to compute scores: %w", err)
	}
	output.Log("info", "Player scores computed")

	output.Log("info", "Parsing complete!")
	output.Progress("complete", 0, len(matchData.Rounds), 1.0)

	return nil
}
