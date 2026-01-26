# Parser Memory Cleanup - Demoinfocs File Handle Management

## Problem

The `demoinfocs-golang` library likely keeps a copy of the entire demo file in memory during parsing. When parsing multiple demos or processing large files, this can lead to significant memory accumulation if the parser is not properly closed and memory is not freed.

## Solution

Implemented explicit file handle management and immediate cleanup after parsing completes:

### 1. Store File Handle in Parser Struct

**Location**: `internal/parser/parser.go`

- Added `file *os.File` field to `Parser` struct to track the file handle
- Store the file handle when creating the parser so we can explicitly close it

```go
type Parser struct {
	parser   dem.Parser
	path     string
	file     *os.File // Store file handle for explicit cleanup
}
```

### 2. Enhanced Close() Method

**Location**: `internal/parser/parser.go` lines 2614-2627

- Close both the demoinfocs parser AND the underlying file handle
- Added documentation explaining that all parsing steps must complete before closing

```go
// Close closes the parser and underlying file.
// This frees the memory used by demoinfocs to hold the demo file in memory.
// IMPORTANT: All parsing operations must complete before calling Close().
func (p *Parser) Close() error {
	var err error
	if p.parser != nil {
		err = p.parser.Close()
	}
	if p.file != nil {
		if closeErr := p.file.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}
	return err
}
```

### 3. Immediate Cleanup After Parsing

**Location**: `cmd/parser/main.go`

#### In `runJSON()` (lines ~192-196):
- Close parser immediately after `ParseWithDB()` completes
- Force GC to ensure memory is freed before processing events from file
- All parsing steps are synchronous, so it's safe to close

```go
// Close parser immediately after parsing completes to free demoinfocs memory
// This releases the demo file copy that demoinfocs keeps in memory
// All parsing steps are now complete, so it's safe to close
if err := p.Close(); err != nil {
	output.Log("warn", fmt.Sprintf("Error closing parser: %v", err))
}
// Force GC to ensure memory is freed before processing events
runtime.GC()
```

#### In `run()` (lines ~387-395):
- Close parser immediately after `ParseWithDB()` completes
- Force GC to ensure memory is freed before storing data to database

```go
// Close parser immediately after parsing completes to free demoinfocs memory
// This releases the demo file copy that demoinfocs keeps in memory
// All parsing steps are now complete, so it's safe to close
if err == nil {
	if closeErr := p.Close(); closeErr != nil {
		output.Log("warn", fmt.Sprintf("Error closing parser: %v", closeErr))
	}
	// Force GC to ensure memory is freed before storing data
	runtime.GC()
}
```

### 4. Safety Net with defer

- Both `runJSON()` and `run()` still use `defer p.Close()` as a safety net
- This ensures cleanup even if an error occurs
- The explicit close after parsing is the primary cleanup mechanism

## Benefits

1. **Immediate Memory Release**: Parser is closed as soon as parsing completes, freeing the demo file copy from memory
2. **Explicit GC**: `runtime.GC()` is called after closing to encourage immediate memory reclamation
3. **Synchronous Operations**: All parsing steps complete before closing, ensuring no race conditions
4. **Safety Net**: `defer` ensures cleanup even on errors

## Memory Flow

### Before:
```
Parse → [demoinfocs holds demo in memory] → Process events → [memory still held] → defer closes
```

### After:
```
Parse → [demoinfocs holds demo in memory] → Close parser → GC → [memory freed] → Process events
```

## Testing Recommendations

1. Monitor memory usage during parsing - should drop significantly after parsing completes
2. Parse multiple demos sequentially - memory should not accumulate
3. Verify output correctness - closing early should not affect results since all parsing is complete

## Notes

- The file handle is opened once in `NewParser()` and passed to `dem.NewParser(f)`
- Demoinfocs may read the entire file into memory during parsing
- Closing the parser releases this memory immediately
- All parsing operations are synchronous, so closing after `ParseWithDB()` returns is safe
