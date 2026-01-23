# CS2 Window Tracker Native Addon

A purpose-built native addon for tracking CS2 window bounds on Windows.

## Building

```bash
npm run build:addon
```

This will compile the C++ addon using node-gyp.

## Requirements

- Windows (Windows-only addon)
- Visual Studio Build Tools or Visual Studio with C++ workload
- node-gyp
- node-addon-api

## Files

- `binding.gyp` - node-gyp build configuration
- `src/cs2_window_tracker.cpp` - Native C++ implementation
- `index.ts` - TypeScript wrapper

## Usage

The addon is automatically loaded by `electron/cs2OverlayTracker.ts` when demo playback starts.
