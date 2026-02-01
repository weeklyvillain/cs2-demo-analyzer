# CS2 Clean Recording Config Integration

## Overview
The `clean_capture.cfg` and `restore_capture.cfg` files provide clean UI for HLAE recordings. These configs are now **actively integrated** into the HLAE recording workflow.

## Location
```
resources/cfg/
  ├── clean_capture.cfg   # Hide UI elements before recording
  └── restore_capture.cfg  # Restore UI after recording
```

## What Gets Hidden

### Clean Capture Mode (`clean_capture.cfg`)
- ✅ Demo playback UI (demoui bar)
- ✅ Build/version info (bottom-left corner)
- ✅ Radar/minimap
- ✅ All HUD except killfeed (death notices)
- ✅ Net graph
- Optional: Voice chat icons, player name overlays

### Restore Mode (`restore_capture.cfg`)
Reverts all settings to normal demo playback state.

## Manual Usage (Console)

```
// Before recording
exec clean_capture

// After recording
exec restore_capture
```

## Integration Status

### ✅ IMPLEMENTED in `hlaeRecorder.ts` → `recordClip()` method

**Before configuring mirv_streams:**
```typescript
// Execute clean capture config to hide UI elements for recording
this.logger.log('Applying clean capture config...')
await this.commandSender.send('exec clean_capture')
await this.commandSender.wait(500)
```

**After stopping recording:**
```typescript
// Restore normal UI after recording
this.logger.log('Restoring normal UI...')
await this.commandSender.send('exec restore_capture')
await this.commandSender.wait(300)
```

The configs are automatically executed during HLAE clip recording. No manual intervention required.

## Config File Deployment

Configs should be copied to CS2's `cfg` directory. Options:

### Option 1: Bundle with HLAE movieconfig
Copy to movieconfig directory specified in settings.

### Option 2: Copy to CS2 cfg folder
```typescript
const cs2CfgPath = path.join(cs2InstallPath, 'game', 'csgo', 'cfg')
// Copy clean_capture.cfg and restore_capture.cfg here
```

### Option 3: User-managed
Document that users should manually copy configs to their CS2 cfg folder.

## Testing

1. Load a demo in CS2
2. Run: `exec clean_capture`
3. Verify: demoui hidden, no radar, only killfeed visible
4. Run: `exec restore_capture`
5. Verify: demoui restored, full HUD back

## Customization

Users can edit configs to:
- Hide killfeed too: uncomment `cl_drawhud 0`
- Hide player names: uncomment `cl_drawhud_force_teamid_overhead -1`
- Keep voice chat: remove `cl_mute_enemy_team 1`

## Notes

- `demoui false` may need to be executed twice in some cases
- Configs are CS2-specific (will not work in CS:GO)
- Safe to execute multiple times (idempotent)
- No restart required, takes effect immediately
