# Overlay Window Synchronization - Implementation Notes

## Overview
Event-driven window tracking for CS2 using Win32 `SetWinEventHook` to keep the overlay perfectly aligned with the CS2 game window in both windowed and borderless fullscreen modes.

## Architecture

### Files
- **`electron/cs2WindowEvents.ts`**: Win32 event hook implementation
  - Finds CS2 window by title or process name
  - Registers WinEvent hooks for move/resize/minimize events
  - Emits events when CS2 window state changes
  
- **`electron/overlaySync.ts`**: Overlay synchronization manager
  - Subscribes to CS2 window events
  - Updates overlay bounds with throttling (~60fps max)
  - Handles show/hide based on CS2 window state

- **`electron/main.ts`**: Integration
  - Creates `OverlaySync` instance when overlay window is created
  - Starts/stops synchronization on app lifecycle events

## Dependencies

Added to `package.json`:
- `ffi-napi`: Foreign Function Interface for calling Win32 APIs
- `ref-napi`: Reference types for FFI
- `ref-struct-di`: Structure definitions for Win32 types

Install with:
```bash
npm install ffi-napi ref-napi ref-struct-di
```

## Implementation Details

### Window Detection
1. **Primary**: `FindWindowA` with title "Counter-Strike 2" or "CS2"
2. **Fallback**: `EnumWindows` to find window by process name "cs2.exe"
3. **Verification**: Confirms process name matches before tracking

### Event Hooks
Uses `SetWinEventHook` with these events:
- `EVENT_SYSTEM_MOVESIZESTART/END`: Window resize/move operations
- `EVENT_OBJECT_LOCATIONCHANGE`: Window position changes
- `EVENT_SYSTEM_MINIMIZESTART/END`: Minimize/restore
- `EVENT_SYSTEM_FOREGROUND`: Window activation

### Bounds Calculation
1. **Preferred**: Client rect (excludes title bar/borders)
   - Uses `GetClientRect` + `ClientToScreen` for accurate alignment
2. **Fallback**: Window rect (includes title bar/borders)
   - Uses `GetWindowRect` if client rect conversion fails

### Throttling
- Maximum update rate: ~60fps (16ms throttle)
- Uses `setTimeout` for debouncing rapid updates
- Prevents excessive `setBounds` calls during live resize

## Gotchas & Solutions

### DPI Scaling
- Win32 APIs return screen coordinates in physical pixels
- Electron's `setBounds` expects the same coordinate system
- No conversion needed - coordinates match directly

### Client Rect vs Window Rect
- **Client rect** preferred for accurate overlay alignment
- Excludes title bar, borders, and window chrome
- If client rect fails, falls back to window rect
- Borderless fullscreen: Both rects are identical (no borders)

### Always-On-Top Levels
- Overlay uses `setAlwaysOnTop(true, 'screen-saver', 1)` - highest level
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` for fullscreen support
- These settings are preserved during bounds updates

### Window Lifecycle
- **CS2 not found**: Overlay remains hidden, tracker polls every 2 seconds
- **CS2 minimized**: Overlay hidden automatically
- **CS2 restored**: Overlay shown and bounds synced immediately
- **CS2 closed**: Tracker detects window loss, overlay hidden

### Cleanup
- Hooks are properly unregistered on `stop()`
- `before-quit` handler ensures cleanup
- Overlay window `closed` event stops synchronization

## Performance

- **Event-driven**: No polling loops, only responds to actual window changes
- **Throttled updates**: Max 60fps prevents excessive setBounds calls
- **Efficient filtering**: Events filtered by hwnd to only process CS2 window
- **Minimal overhead**: Only active when overlay window exists

## Testing

1. **Windowed mode**: Resize/move CS2 window - overlay should follow
2. **Borderless fullscreen**: Switch to fullscreen - overlay should match monitor bounds
3. **Minimize/restore**: Overlay should hide/show automatically
4. **Multi-monitor**: Move CS2 between monitors - overlay should follow
5. **CS2 restart**: Close and reopen CS2 - overlay should reattach

## Error Handling

- All Win32 API calls wrapped in try-catch
- Graceful fallback if hooks fail to register
- Logs errors but continues operation
- Overlay falls back to static bounds if sync fails

## Future Improvements

- Add configurable offset correction for window rect fallback
- Support for multiple CS2 instances (track by PID)
- Add bounds change debouncing for smoother resize
- Optional polling fallback if event hooks fail
