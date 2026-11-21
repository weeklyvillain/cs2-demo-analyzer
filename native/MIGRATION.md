# Migrating users from the Electron app to the native app

Scope: **Windows only.** macOS is dropped (decided): no more Mac builds; see "macOS" below.

Goal: every Windows user on Electron 1.0.x ends up on the native app through the update
they already get, with their matches, settings, stats, shortcuts and `.dem` handling intact,
and with no manual reinstall.

## What we know (checked on a real 1.0.72 install)

**How the Electron updater installs an update** (`electron-updater` 6.8.11, `NsisUpdater`):

- On startup the splash checks GitHub `latest.yml` (`autoUpdateEnabled` defaults to on).
  If its `version` is newer (semver) it downloads the installer named there, checks its
  SHA-512 against `latest.yml`, then the app quits and runs:
  `"<installer>.exe" --updated /S --force-run`
- No code-signature check: `app-update.yml` has no `publisherName`, and `package.json`
  sets `verifyUpdateCodeSignature: false`.
- Admin rights are not requested (per-user install; `isAdminRightsRequired` absent).
- It first tries a differential download using `.blockmap` files and falls back to the
  full installer when that fails, so we don't need to publish a blockmap.
- Prereleases are ignored by default (`allowPrerelease` false), so a GitHub *pre-release*
  is invisible to Electron users. That's our staging switch.
- Settings → "Download and install version" in Electron picks the release's `…Setup….exe`
  and runs it with `/S`, so it can install the native app too.

**What the Electron install left on the machine** (per user, no admin):

| Thing | Where / value |
| --- | --- |
| App folder | `%LOCALAPPDATA%\Programs\cs-griefer-electron\` — `CS2 Demo Analyzer.exe`, `Uninstall CS2 Demo Analyzer.exe`, Chromium files, `resources\app.asar`, `resources\bin\…` |
| Uninstall entry | `HKCU\…\Uninstall\b777ecc9-42be-5c4f-b7cb-5056ce50e849` (DisplayName "CS2 Demo Analyzer 1.0.72", quiet uninstall `/currentuser /S`) |
| electron-builder key | `HKCU\Software\b777ecc9-…` — `InstallLocation`, `ShortcutName`, `KeepShortcuts` |
| Shortcuts | Desktop and Start menu `CS2 Demo Analyzer.lnk` (AppUserModelID `com.csgriefer.app`) |
| File association | `HKCU\Software\Classes\.dem` → `CS2 Demo File` (previous value kept as `CS2 Demo File_backup = Valve.Source`); `CS2 Demo File\shell\open\command` = `"…\CS2 Demo Analyzer.exe" "%1"` |
| Explorer verb | `HKCU\Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2` → `… --play-demo "%1"` |
| User data | `%APPDATA%\cs-griefer-electron\` — `matches\`, `settings.sqlite`, `stats.sqlite`, plus Chromium caches |
| Updater cache | `%LOCALAPPDATA%\cs-griefer-electron-updater\` |

The native app already reads and writes the same user-data folder and settings keys, so no
data migration is needed.

## The plan

### 1. Native app: last pieces before it can ship

Status: version, updater arguments and the AppUserModelID are done (`crates/app/src/win_install.rs`).
Leftover Electron caches are cleaned by the installer instead of the app.
Native updater: done (`crates/core/src/updater.rs`, `crates/app/src/updater.rs`), changed from the plan below on
purpose: startup never waits and nothing downloads by itself. A background check reads `latest.yml` and only shows
"Update to vX" in the title bar and Settings; clicking it downloads, verifies SHA-512, runs the installer
(`--updated /S --force-run`) and quits. Settings brings back the toggle (now "Check for Updates on Startup") and
"Download and Install Version". `CS2DA_UPDATE_FEED` (folder or URL) points it at a test feed. Tested end to end with a
local 2.0.1 feed; installing an Electron 1.0.x release from Settings (a rollback) is not tested.

- **Version 2.0.0** (anything above 1.0.72 works; 2.0.0 signals the rewrite). Drop "native preview".
- **Accept the updater's arguments**: ignore `--updated` and `/S`; treat `--force-run` as a normal start.
- **Same AppUserModelID as Electron** (`com.csgriefer.app`, via `SetCurrentProcessExplicitAppUserModelID`)
  so taskbar pins and notifications carry over.
- **First-run cleanup** after the switch: delete Electron-only leftovers in the user-data folder
  (`Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `Local Storage`, `Session Storage`,
  `blob_storage`, `Network`, `Shared Dictionary`, `SharedStorage`, `Local State`, `Preferences`)
  and `%LOCALAPPDATA%\cs-griefer-electron-updater`. Never touch `matches`, `*.sqlite` or `cs2_configs`.
- **Native updater** (`cs2da-core::releases` already reads GitHub): on startup, in the background
  and only when `autoUpdateEnabled` is on, read `latest.yml` from the latest release, download the
  installer, verify SHA-512, then offer "Restart to update" (title-bar indicator + Settings), which
  runs it with the same `--updated /S --force-run` and quits. Bring back the auto-update toggle and
  "install specific version" in Settings with it.
- **What's New** then shows the 2.0.0 notes on first start (`last_seen_version` is 1.0.72 → newer).

### 2. Installer (NSIS, built in CI)

Status: written in `installer/installer.nsi`; `installer/build.py` stages the files, runs makensis
and writes `latest.yml` (same fields as electron-builder's). Built (48.8 MB) and tested on a real
1.0.72 install: the updater's command line (`--updated /S --force-run`) replaced Electron in 6 s and started
the app; files, registry, shortcuts (with the app ID) and the `.dem` association were right, user data was
untouched, Electron caches were gone. Silent uninstall (app still running) and a fresh normal install also
worked. Not tested yet: the Electron updater downloading it from a feed, double-clicking a `.dem`, the
Explorer verb, and a taskbar pin. Notes on how it does each step:

- The Electron uninstaller runs the way electron-builder runs it on its own upgrades:
  copied to the temp folder, with `_?=<install dir>` (otherwise NSIS uninstallers return at once),
  `--updated` (keeps shortcuts and taskbar pins because `KeepShortcuts=true`) and `/KEEP_APP_DATA`.
- Shortcuts are written by the app itself (`CS2 Demo Analyzer.exe --install-shortcuts [--desktop]`),
  since plain NSIS can't set the AppUserModelID. If that fails it falls back to plain NSIS shortcuts.
- Desktop shortcut: on a fresh install, or when one already exists.
- Electron caches in the user-data folder and `%LOCALAPPDATA%\cs-griefer-electron-updater` are
  removed only when an Electron install was replaced.

Same install folder and names as Electron, so everything pointing there keeps working:

1. Silent when `/S` (the updater's case); a one-click UI otherwise, like today.
2. Wait for `CS2 Demo Analyzer.exe` to exit (the Electron app is quitting when we start); if it
   is still running after a few seconds, ask (UI) or end it (silent).
3. If an Electron install is present (`HKCU\Software\b777ecc9-…` `InstallLocation`), run its
   uninstaller quietly (`/currentuser /S`) — it keeps user data (`deleteAppDataOnUninstall: false`)
   and removes Chromium files, shortcuts and its registry entries cleanly. Fall back to deleting the
   known Electron files if the uninstaller is missing.
4. Install to `%LOCALAPPDATA%\Programs\cs-griefer-electron\`:
   `CS2 Demo Analyzer.exe` (native), `resources\` (maps, radars, sources, icon, cfg, keyboard),
   `bin\` (cs2-voice-extractor, audiowaveform). `parser.exe` is no longer needed by the native app.
5. Re-create the same uninstall key `b777ecc9-…` (DisplayVersion 2.0.0, our own uninstaller) and the
   electron-builder key values, so Windows shows one app and Electron-era tooling still finds it.
6. Shortcuts: desktop + Start menu `CS2 Demo Analyzer.lnk` with AppUserModelID `com.csgriefer.app`.
7. `.dem` association and the "Open with CS2 Demo Analyzer" / Play in CS2 verb, same keys and
   commands as `resources/installer.nsh` today (`"%1"` and `--play-demo "%1"`).
8. Run the app when finished (`--force-run` or UI install), like `runAfterFinish`.

Uninstaller: remove the app folder, shortcuts, the three registry groups, restore
`.dem` to the `_backup` value; keep `%APPDATA%\cs-griefer-electron` (as Electron does).

### 3. Release pipeline (`.github/workflows/release.yml`)

Both Electron jobs (Windows and macOS) are replaced by one native Windows job:

1. `cargo build --release` in `native/` (the extractor is linked in; `bin/win/` tools copied).
2. Build the installer with `makensis` (preinstalled on GitHub's Windows runners).
3. Generate `latest.yml` (version, file name, base64 SHA-512, size, releaseDate) in electron-builder's format.
4. Create the GitHub release (`v2.0.0`) with `CS2-Demo-Analyzer-Setup-2.0.0.exe` + `latest.yml`
   first as a **pre-release** (invisible to Electron users), published only after the checks below.

### macOS

- No more Mac builds: the macOS job and `bin/mac/` go away, and releases carry Windows assets only.
- Existing Mac installs keep working on the version they have. Their update check then finds no
  `latest-mac.yml` in the latest release and fails; Electron's splash shows the error and opens the
  app 2 seconds later (`autoUpdater.on('error')`), on every start. Harmless, but worth a line in the
  2.0.0 release notes ("macOS is no longer supported; your current version keeps working").
- The version can be set from the native build alone (`native/Cargo.toml`), so the jump to 2.0.0 is
  just that, and the auto-bump moves from `package.json` to the Cargo version.

### 4. Testing before anyone gets it

In **Windows Sandbox** (clean, disposable):

1. Install Electron 1.0.72 from its release; parse a demo; set a `.dem` association; pin to taskbar.
2. Point that install at a test feed: edit `resources\app-update.yml` to a throwaway GitHub repo that
   has the 2.0.0 pre-release published as a normal release (or a fork of this repo).
3. Start the Electron app → it should download, quit, install silently and start the native app.
4. Check: matches/settings/stats present, What's New shows, shortcuts and taskbar pin open the native
   app, double-clicking a `.dem` parses it, Explorer "Play in CS2" works, Apps & features shows one
   "CS2 Demo Analyzer 2.0.0", uninstall leaves user data, Electron leftovers are gone.
5. Also test the manual path (run the installer by hand over 1.0.72) and a fresh install with no Electron.

### 5. Rollout

1. Publish 2.0.0 as a pre-release; test it on a couple of real machines by running the installer manually.
2. Flip it to a normal release → Electron users update on their next app start.
3. Keep the 1.0.72 installer in its release: if something is badly wrong, publish 2.0.1 that…
   either fixes it, or (worst case) reinstalls Electron (the Electron installer replaces the folder).
4. Watch issues for a week; then remove the Electron app from the repo: `src/`, `electron/`,
   `package.json` and the Node build files, `bin/win/parser.exe` and `bin/mac/` (the extractor stays
   as a library; its `parser` CLI can stay for debugging), and move `native/` up as the project root.

## Decisions needed

- ~~Version number~~ — decided: 2.0.0.
- ~~macOS~~ — decided: dropped. No Mac builds from 2.0.0 on.
- **Code signing**: not used today (and not needed for the Electron updater). Unsigned exes get
  SmartScreen warnings on manual installs; signing would also let us turn on signature checks later.
- ~~Installer tool~~ — went with a hand-written NSIS script (full control over the Electron takeover; my
  recommendation) vs. `cargo-packager` (less code, but its NSIS template would need the takeover
  steps patched in).
