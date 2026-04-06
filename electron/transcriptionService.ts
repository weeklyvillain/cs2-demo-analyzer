import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { app } from 'electron'

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large'

export interface TranscriptSegment {
  fromMs: number
  toMs: number
  text: string
}

export interface TranscriptionResult {
  segments: TranscriptSegment[]
  model: WhisperModelSize
  language: string
}

export interface TranscriptionStatus {
  binaryReady: boolean
  modelReady: boolean
  currentModel: WhisperModelSize
  whisperDir: string
}

export type DownloadProgressCallback = (progress: {
  phase: 'binary' | 'model' | 'extracting'
  percent: number
  receivedBytes: number
  totalBytes: number
}) => void

export type TranscribeProgressCallback = (progress: {
  percent: number
  estimatedSecondsRemaining: number | null
}) => void

const MODEL_URLS: Record<WhisperModelSize, string> = {
  tiny:   'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  base:   'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small:  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  medium: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
  large:  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
}

const GITHUB_RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'

/** Name patterns to match against release assets per platform/arch */
const BINARY_ASSET_PATTERNS: Partial<Record<NodeJS.Platform, (arch: string) => string>> = {
  win32: (arch) => arch === 'x64' ? 'whisper-bin-x64.zip' : 'whisper-bin-Win32.zip',
}

/** Fetch the latest release from GitHub and return the download URL for this platform */
async function resolveLatestBinaryUrl(): Promise<{ url: string; version: string; assetName: string }> {
  const patternFn = BINARY_ASSET_PATTERNS[process.platform]
  if (!patternFn) {
    throw new Error(
      `Automatic binary download is only supported on Windows.\n` +
      `On Linux/macOS, please install whisper.cpp manually (e.g. brew install whisper-cpp on macOS) ` +
      `and set the binary path in the whisper directory: ${getBinaryPath()}`
    )
  }

  const assetName = patternFn(process.arch)
  const https = await import('https')

  const releaseData: string = await new Promise((resolve, reject) => {
    const req = https.get(
      GITHUB_RELEASES_API,
      { headers: { 'User-Agent': 'CS2-Analyzer/1.0', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        const chunks: string[] = []
        res.on('data', (d: Buffer) => chunks.push(d.toString()))
        res.on('end', () => resolve(chunks.join('')))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
  })

  const release = JSON.parse(releaseData)
  const asset = (release.assets as Array<{ name: string; browser_download_url: string }>)
    .find((a) => a.name === assetName)

  if (!asset) {
    throw new Error(
      `No binary asset matching "${assetName}" found in the latest whisper.cpp release (${release.tag_name}). ` +
      `Available assets: ${(release.assets as any[]).map((a) => a.name).join(', ')}`
    )
  }

  return { url: asset.browser_download_url, version: release.tag_name as string, assetName }
}

const BINARY_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32:  'whisper-cli.exe',
  darwin: 'whisper-cli',
  linux:  'whisper-cli',
}

export function getWhisperDir(): string {
  return path.join(app.getPath('userData'), 'whisper')
}

export function getModelsDir(): string {
  return path.join(getWhisperDir(), 'models')
}

export function getBinaryPath(): string {
  const name = BINARY_NAMES[process.platform] ?? 'whisper-cli'
  return path.join(getWhisperDir(), name)
}

export function getModelPath(size: WhisperModelSize): string {
  return path.join(getModelsDir(), `ggml-${size}.bin`)
}

export async function deleteWhisperDir(): Promise<void> {
  const whisperDir = getWhisperDir()
  await fs.promises.rm(whisperDir, { recursive: true, force: true })
}

export async function deleteWhisperModel(size: WhisperModelSize): Promise<void> {
  const modelPath = getModelPath(size)
  await fs.promises.unlink(modelPath)
}

export function getTranscriptionStatus(model: WhisperModelSize): TranscriptionStatus {
  return {
    binaryReady: fs.existsSync(getBinaryPath()),
    modelReady: fs.existsSync(getModelPath(model)),
    currentModel: model,
    whisperDir: getWhisperDir(),
  }
}

/**
 * Download a file from a URL with progress callbacks.
 * Uses Node.js https/http module to stream into a temp file then moves it.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const https = await import('https')
  const http = await import('http')
  const fsPromises = fs.promises

  await fsPromises.mkdir(path.dirname(destPath), { recursive: true })
  const tmpPath = destPath + '.download'

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'))

    const get = url.startsWith('https') ? https.get : http.get
    const req = get(url, { headers: { 'User-Agent': 'CS2-Analyzer/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const location = res.headers.location
        if (!location) return reject(new Error('Redirect without location'))
        return downloadFile(location, destPath, onProgress, signal).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`))
      }

      const total = parseInt(res.headers['content-length'] ?? '0', 10)
      let received = 0
      const fileStream = fs.createWriteStream(tmpPath)

      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0) onProgress(received, total)
      })
      res.pipe(fileStream)
      fileStream.on('finish', () => {
        fileStream.close(async () => {
          try {
            await fsPromises.rename(tmpPath, destPath)
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
      fileStream.on('error', (e) => { fs.unlink(tmpPath, () => {}); reject(e) })
      res.on('error', (e) => { fs.unlink(tmpPath, () => {}); reject(e) })
    })
    req.on('error', reject)
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')) })
  })
}

/**
 * Download and extract the whisper-cli binary for the current platform.
 * Resolves the download URL dynamically from the latest GitHub release.
 */
export async function downloadBinary(onProgress: DownloadProgressCallback): Promise<void> {
  const { url: zipUrl, version } = await resolveLatestBinaryUrl()

  const whisperDir = getWhisperDir()
  await fs.promises.mkdir(whisperDir, { recursive: true })

  const zipPath = path.join(whisperDir, 'whisper-bin.zip')
  await downloadFile(zipUrl, zipPath, (received, total) => {
    onProgress({ phase: 'binary', percent: Math.round((received / total) * 100), receivedBytes: received, totalBytes: total })
  })

  // Extract the full zip so that whisper-cli.exe and its sibling DLLs are all present
  const binaryName = BINARY_NAMES[process.platform] ?? 'whisper-cli'
  onProgress({ phase: 'extracting', percent: 0, receivedBytes: 0, totalBytes: 0 })
  await extractZipFlatToDir(zipPath, whisperDir, binaryName)
  onProgress({ phase: 'extracting', percent: 100, receivedBytes: 0, totalBytes: 0 })

  if (process.platform !== 'win32') {
    await fs.promises.chmod(getBinaryPath(), 0o755)
  }

  // Record installed version for future update checks
  await fs.promises.writeFile(path.join(whisperDir, 'version.txt'), version, 'utf8')

  await fs.promises.unlink(zipPath).catch(() => {})
}

/**
 * Extract a ZIP archive and flatten all files from the directory containing
 * `binaryName` into `destDir`. This ensures whisper-cli.exe and its sibling
 * DLLs all end up in the same folder so Windows can resolve them.
 */
async function extractZipFlatToDir(zipPath: string, destDir: string, binaryName: string): Promise<void> {
  const tmpDir = destDir + '_unzip'
  try {
    if (process.platform === 'win32') {
      await runCommand('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${tmpDir}"`,
      ])
    } else {
      await fs.promises.mkdir(tmpDir, { recursive: true })
      await runCommand('unzip', ['-o', zipPath, '-d', tmpDir])
    }

    // Locate the directory that contains the binary — all DLLs sit there too
    const binaryPath = await findFileRecursive(tmpDir, binaryName)
    if (!binaryPath) throw new Error(`Binary ${binaryName} not found in zip`)
    const binarySourceDir = path.dirname(binaryPath)

    // Move every file from that directory into destDir
    const files = await fs.promises.readdir(binarySourceDir, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile()) continue
      const src = path.join(binarySourceDir, file.name)
      const dst = path.join(destDir, file.name)
      // Remove stale copy first so rename doesn't fail on Windows
      await fs.promises.unlink(dst).catch(() => {})
      await fs.promises.rename(src, dst)
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
  if (!fs.existsSync(dir)) return null
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, filename)
      if (found) return found
    } else if (entry.name === filename) {
      return full
    }
  }
  return null
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Download a Whisper model file.
 */
export async function downloadModel(
  size: WhisperModelSize,
  onProgress: DownloadProgressCallback
): Promise<void> {
  const modelsDir = getModelsDir()
  await fs.promises.mkdir(modelsDir, { recursive: true })
  const url = MODEL_URLS[size]
  const dest = getModelPath(size)
  await downloadFile(url, dest, (received, total) => {
    onProgress({ phase: 'model', percent: Math.round((received / total) * 100), receivedBytes: received, totalBytes: total })
  })
}

/**
 * Run whisper-cli on a WAV file and return transcript segments.
 */
export async function transcribeAudio(
  audioFilePath: string,
  modelSize: WhisperModelSize,
  onProgress?: TranscribeProgressCallback
): Promise<TranscriptionResult> {
  const binaryPath = getBinaryPath()
  const modelPath = getModelPath(modelSize)

  if (!fs.existsSync(binaryPath)) throw new Error('Whisper binary not found. Please download it in Settings.')
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model (${modelSize}) not found. Please download it in Settings.`)
  if (!fs.existsSync(audioFilePath)) throw new Error(`Audio file not found: ${audioFilePath}`)

  // Write output to a temp file to avoid collisions
  const tmpId = crypto.randomBytes(8).toString('hex')
  const tmpOutPrefix = path.join(os.tmpdir(), `whisper_${tmpId}`)
  const jsonOutputPath = `${tmpOutPrefix}.json`

  try {
    await runWhisper(binaryPath, [
      '-m', modelPath,
      '-f', audioFilePath,
      '--output-json',
      '--output-file', tmpOutPrefix,
      '--language', 'auto',
      '--print-progress',
      '--threads', String(Math.min(4, os.cpus().length)),
    ], onProgress)

    if (!fs.existsSync(jsonOutputPath)) {
      throw new Error('Whisper completed but produced no output file.')
    }

    const raw = JSON.parse(fs.readFileSync(jsonOutputPath, 'utf8'))
    const detectedLanguage: string = raw?.result?.language ?? 'unknown'
    const transcription: Array<{ offsets: { from: number; to: number }; text: string }> =
      raw?.transcription ?? []

    const segments: TranscriptSegment[] = transcription
      .filter((seg) => seg.text?.trim())
      .map((seg) => ({
        fromMs: seg.offsets.from,
        toMs: seg.offsets.to,
        text: seg.text.trim(),
      }))

    return { segments, model: modelSize, language: detectedLanguage }
  } finally {
    fs.unlink(jsonOutputPath, () => {})
  }
}

function runWhisper(binary: string, args: string[], onProgress?: TranscribeProgressCallback): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderrChunks: string[] = []
    const startTime = Date.now()
    let lastPercent = 0

    const handleChunk = (d: Buffer) => {
      const chunk = d.toString()
      process.stdout.write(`[whisper] ${chunk}`)
      // whisper.cpp emits: "whisper_print_progress_callback: progress = 10"
      const match = chunk.match(/progress\s*=\s*(\d+)/)
      if (match && onProgress) {
        const percent = Math.min(100, parseInt(match[1], 10))
        if (percent > lastPercent) {
          lastPercent = percent
          let estimatedSecondsRemaining: number | null = null
          if (percent > 0 && percent < 100) {
            const elapsedMs = Date.now() - startTime
            const totalMs = (elapsedMs / percent) * 100
            estimatedSecondsRemaining = Math.round((totalMs - elapsedMs) / 1000)
          }
          onProgress({ percent, estimatedSecondsRemaining })
        }
      }
    }

    // whisper.cpp v1.7 writes progress to stderr; v1.8+ writes to stdout — listen to both
    proc.stdout?.on('data', handleChunk)
    proc.stderr?.on('data', (d: Buffer) => {
      stderrChunks.push(d.toString())
      handleChunk(d)
    })

    // Heartbeat: if no progress lines arrive, still pulse the UI so it doesn't look frozen.
    // Simulates progress up to ~90% based on elapsed time, assuming ~60s for a 5 min clip on small model.
    const ASSUMED_TOTAL_MS = 60_000
    const heartbeat = onProgress ? setInterval(() => {
      if (lastPercent > 0) return // real progress is flowing, skip heartbeat
      const elapsedMs = Date.now() - startTime
      const syntheticPercent = Math.min(90, Math.round((elapsedMs / ASSUMED_TOTAL_MS) * 90))
      if (syntheticPercent > lastPercent) {
        lastPercent = syntheticPercent
        const remaining = Math.max(0, Math.round((ASSUMED_TOTAL_MS - elapsedMs) / 1000))
        onProgress({ percent: syntheticPercent, estimatedSecondsRemaining: remaining })
      }
    }, 1500) : null

    proc.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat)
      if (code === 0) resolve()
      else reject(new Error(`whisper-cli exited with code ${code}: ${stderrChunks.join('')}`))
    })
    proc.on('error', (err) => {
      if (heartbeat) clearInterval(heartbeat)
      reject(new Error(`Failed to spawn whisper-cli: ${err.message}`))
    })
  })
}
