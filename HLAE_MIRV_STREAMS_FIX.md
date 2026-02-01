# HLAE mirv_streams Recording Fix

## Issue
Recording failed with error:
```
Recording failed: no output found in C:\Users\Filip\Videos\Cs2Demo\...\raw\...
Ensure mirv_streams is configured correctly and write permissions exist.
```

## Root Cause
The mirv_streams commands were using incorrect syntax that didn't properly configure the CS2 recording stream.

### Original (Incorrect) Code
```typescript
await this.commandSender.sendBatch([
  `mirv_streams record name "${options.clipId}"`,
  `mirv_streams record fps ${options.fps}`,
  `mirv_streams add baseFx "${outputPathForCs2}"`,
  `mirv_streams edit baseFx recordType image`,
  `mirv_streams edit baseFx imageType tga`,
], 150)
```

**Problems:**
1. Wrong command order (setting record parameters before configuring recording method)
2. Mixing `mirv_streams add` stream-based approach with `mirv_streams record` commands
3. `mirv_streams edit` syntax doesn't exist for basic recording
4. Not enabling screen capture output

## Solution

### Fixed Code
```typescript
await this.commandSender.sendBatch([
  'mirv_streams record',
  `mirv_streams record name "${outputPathForCs2}"`,
  `mirv_streams record fps ${options.fps}`,
  `mirv_streams record format tga`,
  'mirv_streams record screen enabled 1',
], 200)
```

**Fixes:**
1. **Correct command structure**: Uses `mirv_streams record` commands consistently
2. **Screen capture enabled**: `mirv_streams record screen enabled 1` captures rendered output
3. **Format specified**: `mirv_streams record format tga` for image sequence
4. **Proper syntax**: All commands use documented HLAE syntax
5. **Correct start/end**: Uses `mirv_streams record start` and `mirv_streams record end`

## Additional Improvements

### 1. Pre-flight mirv_streams Check
```typescript
// Verify mirv_streams is available
this.logger.log('Checking if mirv_streams is available...')
await this.commandSender.send('mirv_streams')
await this.commandSender.wait(500)
```

### 2. Enhanced Output Verification
```typescript
// List all files in the directory for debugging
const allFiles = fs.readdirSync(rawDir)
this.logger.log(`Files in output directory (${allFiles.length}): ${allFiles.join(', ')}`)
```

### 3. Better Error Messages
```typescript
throw new Error(
  `Recording failed: no output found in ${rawDir}. ` +
  `Found ${allFiles.length} file(s) but no TGA frames or video. ` +
  `Files: ${allFiles.length > 0 ? allFiles.join(', ') : 'none'}. ` +
  `Ensure HLAE is running with AfxHookSource2, mirv_streams is configured correctly, and write permissions exist.`
)
```

## HLAE/mirv_streams CS2 Reference

### Key Recording Commands
```
// Configure recording
mirv_streams record
mirv_streams record name "C:/path/to/output"
mirv_streams record fps 60
mirv_streams record format tga
mirv_streams record screen enabled 1

// Start/stop recording
mirv_streams record start
mirv_streams record end
```

### Recording Format Options
- `tga` - TGA image sequence (recommended for quality)
- `jpg` - JPEG image sequence (smaller file size)
- `png` - PNG image sequence
- Video formats may vary by HLAE version

### Important Notes
- **FPS adjustable**: 30, 60, 120, or any value
- **Format must be specified**: Use `mirv_streams record format <format>`
- **Screen capture required**: `mirv_streams record screen enabled 1` captures rendered output
- **Paths must use forward slashes** even on Windows: `C:/path/to/output`
- **HLAE must be launched with AfxHookSource2** to enable mirv_streams in CS2

## Testing Steps

1. Configure settings:
   - `hlae_path`: Path to HLAE.exe or AfxHookSource2.exe
   - `cs2_path`: Path to cs2.exe
   - `cs2_netconport`: Port for netcon (default 2121)

2. Parse a demo with incidents

3. Click "Export Clips" button

4. Select clips and configure export options

5. Monitor logs in `<jobDir>/hlae-export.log`:
   - Should see: "Configuring mirv_streams to output to: ..."
   - Should see: "Checking if mirv_streams is available..."
   - Should see: "Starting recording..."
   - Should see: "Found X TGA frames"

6. Verify TGA files are created in: `<outputDir>/raw/<clipId>/`

## Troubleshooting

### Still no output after fix?

**Check HLAE compatibility:**
- HLAE must support your CS2 version
- AfxHookSource2 hook must be injected successfully
- Test by running `mirv_streams` in CS2 console - should list available recorders

**Check netconport connection:**
- Ensure CS2 launched with `-netconport 2121`
- Test connection in logs: "Connected to CS2 netconport on port 2121"

**Check file permissions:**
- Ensure output directory is writable
- Check Windows folder permissions
- Try different output location (e.g., Documents folder)

**Check demo playback:**
- Ensure demo is loaded and playing
- Verify tick range is valid (startTick < endTick)
- Check demo isn't corrupted

### HLAE hook validation fails?

Error: `HLAE hook not detected (mirv commands unavailable)`

**Solutions:**
1. Update HLAE to latest version compatible with CS2
2. Use AfxHookSource2.exe instead of HLAE.exe
3. Ensure CS2 isn't running with anti-cheat (Akros, etc.)
4. Run HLAE as administrator
5. Check HLAE console output for hook injection errors

## Related Files
- [electron/hlaeRecorder.ts](electron/hlaeRecorder.ts) - Fixed mirv_streams commands
- [electron/clipExportService.ts](electron/clipExportService.ts) - Export orchestrator
- [HLAE_CLIP_EXPORT_IMPLEMENTATION.md](HLAE_CLIP_EXPORT_IMPLEMENTATION.md) - Full documentation
