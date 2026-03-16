## External binaries layout for macOS

This app relies on several external binaries for demo parsing, voice extraction, and waveform generation. They are shipped inside the packaged app under `resources/bin` with per-platform subdirectories.

### Expected layout (production)

All paths below are relative to `resources/bin` in the packaged app:

- Parser:
  - Windows: `win/parser.exe`
  - macOS: `mac/parser` (single binary; can be universal or built for the primary target arch)
  - Linux: `linux/parser`

- Voice extractor (`csgove` / csgo-voice-extractor wrapper):
  - Windows: `win/csgove.exe`
  - macOS (Intel): `mac/csgove-mac-amd64`
  - macOS (Apple Silicon): `mac/csgove-mac-arm64`
  - Linux: `linux/csgove-linux`

- Waveform generator (`audiowaveform`):
  - Windows: `win/audiowaveform.exe`
  - macOS (Intel): `mac/audiowaveform-mac-amd64`
  - macOS (Apple Silicon): `mac/audiowaveform-mac-arm64`
  - Linux: `linux/audiowaveform-linux`

These names/paths are resolved by helper functions in `electron/main.ts` (`getParserPath`, `getVoiceExtractorPath`, `getAudiowaveformPath`) using `process.platform` and `process.arch`.

### CI expectations for the separate tools repo

The separate tools repository that builds these binaries should, for each release:

1. Produce archives containing the above files under a `bin/` folder (so they can be unpacked at the project root in this repo and end up under `resources/bin` after packaging).
2. For macOS, build **both** `amd64` and `arm64` variants for `csgove` and `audiowaveform`, named as listed above, and at least one `parser` binary under `bin/mac/parser`.
3. Publish these archives (for example as GitHub Release assets or artifacts) so that this repo’s GitHub Actions workflow can download and extract them into `./bin` before running `electron-builder`.

