# Titlebar Update Indicator — Design Spec

**Date:** 2026-04-08

## Summary

Show a `DownloadCloud` icon in the custom titlebar when a newer version of the app is available. The icon appears left of the window control buttons, has a tooltip, and clicking it restarts and installs the update.

## Behaviour

- On startup the app already checks for updates via `electron-updater` (splash screen flow). No change to startup behaviour.
- After the main window opens, the main process starts a 60-second interval that calls `autoUpdater.checkForUpdates()`. This runs in production only.
- When `autoUpdater` fires `update-available`, the main process sends an IPC push event (`update:available`) to the main window. This event is already declared in `preload.ts` and `electron.d.ts`.
- `TitleBar.tsx` listens to `window.electronAPI.onUpdateAvailable()` and sets local state `updateAvailable = true`.
- The `DownloadCloud` icon (lucide-react) appears between the drag region and the minimize button, separated by a thin vertical divider, styled with an amber tint to attract attention.
- Hovering shows a native `title` tooltip: **"Update available — click to install"**.
- Clicking calls `window.electronAPI.installUpdate()` → `autoUpdater.quitAndInstall(true, true)`, which silently installs the already-downloaded update and relaunches the app.
- `autoUpdater.autoDownload` is already `true`, so the update binary is downloaded in the background as soon as `update-available` fires.

## Affected Files

| File | Change |
|------|--------|
| `electron/main.ts` | Extend `update-available` handler to also send to `mainWindow`; add 60s interval after main window ready |
| `src/components/TitleBar.tsx` | Add `updateAvailable` state; listen to `onUpdateAvailable`; render icon + click handler |

## Out of Scope

- Dev mode update simulation
- Displaying the new version number in the tooltip
- Manual "check for updates" button
- Dismissing the icon without installing
