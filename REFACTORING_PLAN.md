# CS2 Demo Parser Memory Optimization Plan

## A) Refactoring Plan

### Top 3 Biggest RAM Sources (Estimated)

1. **MatchData accumulation in database mode** (~8-10GB)
   - `matchData.ChatMessages`: ~50K messages × 200 bytes = ~10MB (but doubled during conversion)
   - `matchData.GrenadePositions`: ~200K positions × 100 bytes = ~20MB (doubled)
   - `matchData.GrenadeEvents`: ~50K events × 150 bytes = ~7.5MB (doubled)
   - `matchData.Shots`: ~500K shots × 80 bytes = ~40MB (doubled)
   - **Total**: ~77MB × 2 (duplication) = ~154MB per match, but accumulates across parsing
   - **Real issue**: These are streamed to DB but ALSO stored in MatchData, then converted again

2. **JSON mode event accumulation** (~10-12GB)
   - `allEvents`: All events from file (could be 100K+ events × 500 bytes = ~50MB)
   - `filteredEvents`: Duplicate of filtered subset (~30MB)
   - `jsonEvents`: Converted format (~25MB)
   - `allJSONEvents`: When combining partials, all loaded again (~25MB)
   - **Total**: ~130MB × 100 (across processing) = ~13GB peak

3. **Demoinfocs parser internal state** (~3-5GB)
   - GameState tracking all entities, players, weapons
   - Cannot be controlled, but we can reduce what we process

### Changes to Implement

#### 1. Eliminate MatchData accumulation (main.go `run()`)
- **Current**: Lines 553-734 convert MatchData slices to []db.* slices, doubling memory
- **Fix**: Remove these conversions entirely. Data is already in DB from streaming.
- **Safeguard**: Only convert if slices are non-empty (backward compatibility for old code paths)

#### 2. Stream JSON events incrementally (main.go `runJSON()`)
- **Current**: Lines 204-211 load ALL events, then filter, then convert, then write
- **Fix**: 
  - Decode NDJSON event-by-event
  - Apply Steam ID filter during decode
  - Apply event type filter during decode
  - Write to sorted temporary files (external sort)
  - Merge sorted files into final JSON
- **Benefit**: Never hold more than ~10K events in memory

#### 3. Ensure parser.go never accumulates when writer exists
- **Current**: Lines 851-862, 1584, 1661, etc. have fallback appends to MatchData
- **Fix**: Remove ALL fallback appends when writer != nil
- **Result**: MatchData.ChatMessages, GrenadePositions, etc. stay empty in DB mode

#### 4. Add memory logging utility
- Print HeapAlloc, HeapInuse, HeapSys, NumGC every 5 seconds or every 10K ticks
- Help diagnose remaining memory issues

#### 5. Fix Parse() default
- **Current**: Calls ParseWithDB with writer=nil, causing accumulation
- **Fix**: Document that Parse() is for testing only, CLI always uses writer

### Implementation Strategy

1. **Phase 1**: Fix parser.go to never populate MatchData when writer exists
2. **Phase 2**: Fix main.go run() to skip conversions (data already in DB)
3. **Phase 3**: Refactor runJSON() to stream events
4. **Phase 4**: Add memory logging
5. **Phase 5**: Update documentation

### Expected Results

- **Database mode**: < 1GB (only MatchData.Players, Rounds, Events remain)
- **JSON mode**: < 2GB (streaming events, external sort)
- **Total reduction**: From ~23GB to ~2-3GB (10x improvement)
