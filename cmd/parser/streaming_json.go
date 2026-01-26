package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
)

// JSONEvent is the simplified event structure for JSON output
type JSONEvent struct {
	Type          string  `json:"Type"`
	RoundIndex    int     `json:"RoundIndex"`
	StartTick     int     `json:"StartTick"`
	EndTick       *int    `json:"EndTick"`
	ActorSteamID  *string `json:"ActorSteamID"`
	VictimSteamID *string `json:"VictimSteamID"`
	Reason        *string `json:"Reason,omitempty"`
}

// sortJSONEvents sorts events by RoundIndex then StartTick
func sortJSONEvents(events []JSONEvent) {
	sort.Slice(events, func(i, j int) bool {
		if events[i].RoundIndex != events[j].RoundIndex {
			return events[i].RoundIndex < events[j].RoundIndex
		}
		return events[i].StartTick < events[j].StartTick
	})
}

// writeSortedChunk writes a sorted chunk of events to a temporary file
func writeSortedChunk(events []JSONEvent, filepath string) error {
	sortJSONEvents(events)
	
	f, err := os.Create(filepath)
	if err != nil {
		return fmt.Errorf("failed to create chunk file: %w", err)
	}
	defer f.Close()
	
	// Write as JSON array with proper formatting
	if _, err := f.WriteString("[\n"); err != nil {
		return err
	}
	
	// Write events with proper JSON array formatting
	for i, event := range events {
		// Marshal each event individually to control formatting
		eventJSON, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("failed to marshal event: %w", err)
		}
		
		// Indent the JSON (add 2 spaces)
		indented := "  " + string(eventJSON)
		if i < len(events)-1 {
			indented += ","
		}
		indented += "\n"
		
		if _, err := f.WriteString(indented); err != nil {
			return err
		}
	}
	
	if _, err := f.WriteString("]"); err != nil {
		return err
	}
	
	return nil
}

// mergeSortedChunks merges multiple sorted JSON chunk files into a single sorted output
func mergeSortedChunks(chunkFiles []string, outputPath string) error {
	if len(chunkFiles) == 0 {
		return fmt.Errorf("no chunk files to merge")
	}
	
	// If only one chunk, just copy it (streaming copy to avoid loading entire file)
	if len(chunkFiles) == 1 {
		src, err := os.Open(chunkFiles[0])
		if err != nil {
			return fmt.Errorf("failed to open chunk file: %w", err)
		}
		defer src.Close()
		
		dst, err := os.Create(outputPath)
		if err != nil {
			return fmt.Errorf("failed to create output file: %w", err)
		}
		defer dst.Close()
		
		_, err = io.Copy(dst, src)
		if err != nil {
			return fmt.Errorf("failed to copy chunk file: %w", err)
		}
		return nil
	}
	
	// Open all chunk files and create decoders
	// CRITICAL: Only hold ONE event per chunk in memory at a time (not a growing slice)
	type chunkReader struct {
		file    *os.File
		decoder *json.Decoder
		current *JSONEvent // Only the current event, not a slice
		hasMore bool       // Whether there are more events to read
	}
	
	readers := make([]*chunkReader, 0, len(chunkFiles))
	for _, chunkFile := range chunkFiles {
		f, err := os.Open(chunkFile)
		if err != nil {
			// Close already opened files
			for _, r := range readers {
				r.file.Close()
			}
			return fmt.Errorf("failed to open chunk file %s: %w", chunkFile, err)
		}
		
		decoder := json.NewDecoder(f)
		// Skip opening bracket
		token, err := decoder.Token()
		if err != nil || token != json.Delim('[') {
			f.Close()
			for _, r := range readers {
				r.file.Close()
			}
			return fmt.Errorf("invalid JSON array in chunk file")
		}
		
		// Read first event (only one at a time)
		var current *JSONEvent
		hasMore := decoder.More()
		if hasMore {
			var event JSONEvent
			if err := decoder.Decode(&event); err == nil {
				current = &event
			} else {
				hasMore = false
			}
		}
		
		readers = append(readers, &chunkReader{
			file:    f,
			decoder: decoder,
			current: current,
			hasMore: hasMore,
		})
	}
	
	defer func() {
		for _, r := range readers {
			r.file.Close()
		}
	}()
	
	// Open output file
	outFile, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("failed to create output file: %w", err)
	}
	defer outFile.Close()
	
	// Write opening bracket
	if _, err := outFile.WriteString("[\n"); err != nil {
		return err
	}
	
	first := true
	
	// K-way merge: repeatedly find the smallest event across all chunks
	// CRITICAL: Only hold ONE event per chunk in memory (not a growing slice)
	for {
		var bestReader *chunkReader
		var bestEvent *JSONEvent
		
		// Find the reader with the smallest current event
		for _, reader := range readers {
			// If this reader has no current event, try to read the next one
			if reader.current == nil && reader.hasMore {
				if reader.decoder.More() {
					var event JSONEvent
					if err := reader.decoder.Decode(&event); err == nil {
						reader.current = &event
					} else {
						reader.hasMore = false
					}
				} else {
					reader.hasMore = false
				}
			}
			
			// Check if this reader has a current event
			if reader.current != nil {
				if bestEvent == nil || compareEvents(reader.current, bestEvent) < 0 {
					bestEvent = reader.current
					bestReader = reader
				}
			}
		}
		
		if bestEvent == nil {
			break // No more events
		}
		
		// Write comma if not first
		if !first {
			if _, err := outFile.WriteString(",\n"); err != nil {
				return err
			}
		}
		first = false
		
		// Marshal and write event with indentation
		eventJSON, err := json.Marshal(bestEvent)
		if err != nil {
			return fmt.Errorf("failed to marshal event: %w", err)
		}
		
		indented := "  " + string(eventJSON) + "\n"
		if _, err := outFile.WriteString(indented); err != nil {
			return err
		}
		
		// Advance this reader: read next event (or mark as done)
		if bestReader.decoder.More() {
			var event JSONEvent
			if err := bestReader.decoder.Decode(&event); err == nil {
				bestReader.current = &event
			} else {
				bestReader.current = nil
				bestReader.hasMore = false
			}
		} else {
			bestReader.current = nil
			bestReader.hasMore = false
		}
	}
	
	// Write closing bracket
	if _, err := outFile.WriteString("]"); err != nil {
		return err
	}
	
	return nil
}

// compareEvents returns -1 if a < b, 0 if a == b, 1 if a > b
func compareEvents(a, b *JSONEvent) int {
	if a.RoundIndex != b.RoundIndex {
		if a.RoundIndex < b.RoundIndex {
			return -1
		}
		return 1
	}
	if a.StartTick != b.StartTick {
		if a.StartTick < b.StartTick {
			return -1
		}
		return 1
	}
	return 0
}
