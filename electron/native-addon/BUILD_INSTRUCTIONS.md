# Building the CS2 Window Tracker Native Addon

## Prerequisites

1. **Visual Studio Build Tools** (Windows)
   - Install "Desktop development with C++" workload
   - Or install Visual Studio with C++ workload

2. **Node.js** with npm

3. **node-gyp** (installed as dev dependency)

## Building

```bash
npm run build:addon
```

This will:
1. Compile the C++ addon using node-gyp
2. Output: `electron/native-addon/build/Release/cs2_window_tracker.node`

## Troubleshooting

If build fails:
- Ensure Visual Studio Build Tools are installed
- Run: `npm install -g node-gyp`
- Try: `npm run build:addon --verbose` for detailed output

## Integration

The addon is automatically loaded by `electron/cs2OverlayTracker.ts` when demo playback starts.

If the addon fails to load, the app will continue to work but overlay tracking will be disabled (warnings will be logged).
