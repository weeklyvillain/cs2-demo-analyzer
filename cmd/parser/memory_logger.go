package main

import (
	"fmt"
	"runtime"
	"time"

	"cs-griefer-electron/internal/ipc"
)

// MemoryLogger logs memory usage periodically
type MemoryLogger struct {
	output    *ipc.Output
	lastLog   time.Time
	interval  time.Duration
	lastTick  int
	tickInterval int
}

// NewMemoryLogger creates a new memory logger
func NewMemoryLogger(output *ipc.Output, intervalSeconds int, tickInterval int) *MemoryLogger {
	return &MemoryLogger{
		output:       output,
		interval:     time.Duration(intervalSeconds) * time.Second,
		lastLog:      time.Now(),
		tickInterval: tickInterval,
	}
}

// LogIfNeeded logs memory stats if interval has passed or tick interval reached
func (ml *MemoryLogger) LogIfNeeded(tick int) {
	now := time.Now()
	shouldLog := false
	
	// Log every N seconds
	if now.Sub(ml.lastLog) >= ml.interval {
		shouldLog = true
		ml.lastLog = now
	}
	
	// Also log every N ticks (if tickInterval > 0)
	if ml.tickInterval > 0 && tick > 0 && (tick-ml.lastTick) >= ml.tickInterval {
		shouldLog = true
		ml.lastTick = tick
	}
	
	if !shouldLog {
		return
	}
	
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	heapAllocMB := float64(m.HeapAlloc) / (1024 * 1024)
	heapInuseMB := float64(m.HeapInuse) / (1024 * 1024)
	heapSysMB := float64(m.HeapSys) / (1024 * 1024)
	
	ml.output.Log("info", fmt.Sprintf("Memory: HeapAlloc=%.1fMB, HeapInuse=%.1fMB, HeapSys=%.1fMB, NumGC=%d, Tick=%d",
		heapAllocMB, heapInuseMB, heapSysMB, m.NumGC, tick))
}
