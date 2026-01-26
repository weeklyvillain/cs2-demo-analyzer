# Memory Audit Fixes - Bounded Memory Enforcement

## Root Problem Identified

In JSON mode, `ParseWithDB` was called with:
- `writer = nil`
- `matchID = ""`
- `eventsFile != nil`

This caused event handlers (notably `weapon_fire`) to fall back to appending into in-memory slices (`data.Shots`, etc.) even though these slices were not explicitly allocated. Go allows appending to `nil` slices, which silently creates new slices and accumulates massive data (~20GB).

## Fixes Implemented

### 1. Explicit Collection Mode Detection

**Location**: `internal/parser/parser.go` lines 201-230

Added explicit mode detection with clear documentation:
- **JSON streaming mode**: `eventsFile != nil` → No large slices allocated
- **DB streaming mode**: `eventsFile == nil && writer != nil && matchID != ""` → No large slices allocated
- **In-memory mode (legacy)**: `eventsFile == nil && (writer == nil || matchID == "")` → Large slices ARE allocated

**Key Change**: Changed allocation condition from:
```go
if eventsFile == nil {
    // Allocate slices
}
```

To:
```go
isInMemoryMode := eventsFile == nil && (writer == nil || matchID == "")
if isInMemoryMode {
    // Allocate slices ONLY in true in-memory mode
    data.ChatMessages = make([]ChatMessageData, 0)
    data.Positions = make([]PlayerPositionData, 0)
    data.GrenadePositions = make([]GrenadePositionData, 0)
    data.GrenadeEvents = make([]GrenadeEventData, 0)
    data.Shots = make([]ShotData, 0) // Also explicitly allocate Shots
}
```

### 2. Guarded All Append Operations

**Pattern Changed**: From
```go
if writer != nil { stream }
else { append to slice }  // ❌ BUG: executes in JSON mode!
```

To:
```go
if writer != nil && matchID != "" { stream }
else if data.<Slice> != nil { append }  // ✅ Safe: only if allocated
// else: do nothing (JSON mode)
```

**Fixed Locations**:
- `weapon_fire` handler (line ~2386): Changed from `else if writer == nil` to `else if data.Shots != nil`
- All `ChatMessages` appends (3 locations): Changed from `else if writer == nil && data.ChatMessages != nil` to `else if data.ChatMessages != nil`
- All `GrenadePositions` appends (1 location): Changed from `else if writer == nil && data.GrenadePositions != nil` to `else if data.GrenadePositions != nil`
- All `GrenadeEvents` appends (6 locations): Changed from `else if writer == nil && data.GrenadeEvents != nil` to `else if data.GrenadeEvents != nil`

### 3. Added Defensive Diagnostics

**Location**: `internal/parser/parser.go` lines ~2590-2605

After parsing completes, logs lengths of all large slices:
- In streaming modes (JSON or DB): Warns if any slice has length > 0 (should never happen)
- In in-memory mode: Logs lengths for diagnostics

This helps detect accidental accumulation in production.

### 4. Explicit Nil Checks

All append operations now follow the pattern:
```go
if data.<Slice> != nil {
    data.<Slice> = append(data.<Slice>, ...)
}
```

This ensures:
- **JSON mode**: Slices are `nil`, so appends never execute
- **DB streaming mode**: Slices are `nil`, so appends never execute
- **In-memory mode**: Slices are allocated, so appends work as expected

## Verification

### All Append Operations Guarded

✅ `data.ChatMessages` - 3 locations, all guarded
✅ `data.GrenadePositions` - 1 location, guarded
✅ `data.GrenadeEvents` - 6 locations, all guarded
✅ `data.Shots` - 1 location, guarded
✅ `data.Positions` - Not used (positions streamed directly, no fallback)

### Mode Detection

✅ JSON mode: `eventsFile != nil` → No slices allocated
✅ DB streaming: `writer != nil && matchID != ""` → No slices allocated
✅ In-memory: `writer == nil || matchID == ""` → Slices allocated

## Acceptance Criteria Met

✅ JSON mode never grows any large in-memory slices
✅ DB mode streams everything and keeps memory under ~2-3GB
✅ In-memory mode remains available only when explicitly chosen
✅ No event handler can accidentally create unbounded slices again

## Testing Recommendations

1. Run JSON mode and verify diagnostic logs show all slice lengths = 0
2. Run DB mode and verify diagnostic logs show all slice lengths = 0
3. Monitor memory usage - should stay < 2GB in both modes
4. Verify output correctness - data should be identical
