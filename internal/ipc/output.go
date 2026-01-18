package ipc

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Output handles NDJSON (newline-delimited JSON) output to stdout.
// All methods are thread-safe.
type Output struct {
	mu sync.Mutex
}

// NewOutput creates a new NDJSON output handler.
func NewOutput() *Output {
	return &Output{}
}

// Progress sends a progress update message.
func (o *Output) Progress(stage string, tick, round int, pct float64) {
	o.writeJSON(map[string]interface{}{
		"type":   "progress",
		"stage":  stage,
		"tick":   tick,
		"round":  round,
		"pct":    pct,
	})
}

// Log sends a log message.
func (o *Output) Log(level, msg string) {
	o.writeJSON(map[string]interface{}{
		"type":  "log",
		"level": level,
		"msg":   msg,
	})
}

// Error sends an error message.
func (o *Output) Error(msg string) {
	o.writeJSON(map[string]interface{}{
		"type": "error",
		"msg":  msg,
	})
}

// writeJSON writes a JSON object to stdout followed by a newline.
func (o *Output) writeJSON(obj map[string]interface{}) {
	o.mu.Lock()
	defer o.mu.Unlock()

	data, err := json.Marshal(obj)
	if err != nil {
		// Fallback to stderr if JSON marshaling fails
		fmt.Fprintf(os.Stderr, "failed to marshal JSON: %v\n", err)
		return
	}

	fmt.Fprintf(os.Stdout, "%s\n", data)
}

