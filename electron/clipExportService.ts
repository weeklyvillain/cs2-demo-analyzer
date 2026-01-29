import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as net from 'net'
import { getSetting } from './settings'

export interface ClipRange {
  id: string
  startTick: number
  endTick: number
  label?: string
  playerName?: string
  playerSteamId?: string
}

export interface ExportOptions {
  demoPath: string
  clipRanges: ClipRange[]
  outputDir?: string
  resolutionPreset: '720p' | '1080p'
  playbackSpeed: number
  montageEnabled: boolean
  fadeDuration: number
  tickRate?: number
}

export interface ExportProgress {
  stage: 'launch_cs2' | 'load_demo' | 'recording' | 'ffmpeg' | 'done'
  currentClipIndex: number
  totalClips: number
  percent: number
  message: string
}

type ProgressCallback = (progress: ExportProgress) => void

export class ClipExportService {
  private cs2Process: ChildProcess | null = null
  private netconPort: number
  private tickRate: number = 64
  private tempDir: string

  constructor(netconPort: number = 2121) {
    this.netconPort = netconPort
    this.tempDir = path.join(app.getPath('temp'), `cs2-clip-export-${Date.now()}`)
  }

  /**
   * Main export orchestrator
   */
  async exportClips(options: ExportOptions, onProgress: ProgressCallback): Promise<{ success: boolean; clips: string[]; montage?: string; error?: string }> {
    try {
      // Validate inputs
      if (!fs.existsSync(options.demoPath)) {
        throw new Error(`Demo file not found: ${options.demoPath}`)
      }
      if (!options.clipRanges || options.clipRanges.length === 0) {
        throw new Error('No clip ranges provided')
      }
      if (options.playbackSpeed <= 0 || options.playbackSpeed > 10) {
        throw new Error('Playback speed must be between 0.1 and 10')
      }

      // Setup output directory
      const outputDir = options.outputDir || path.join(app.getPath('documents'), 'CS2 Demo Clips')
      const demoName = path.basename(options.demoPath, '.dem')
      const clipOutputDir = path.join(outputDir, demoName, 'clips')
      
      if (!fs.existsSync(clipOutputDir)) {
        fs.mkdirSync(clipOutputDir, { recursive: true })
      }

      // Create temp directory for intermediate files
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true })
      }

      this.tickRate = options.tickRate || 64

      // Report: Launch CS2
      onProgress({
        stage: 'launch_cs2',
        currentClipIndex: 0,
        totalClips: options.clipRanges.length,
        percent: 5,
        message: 'Launching CS2...',
      })

      // Launch CS2 hidden
      await this.launchCS2Hidden(options.resolutionPreset)

      // Load demo
      onProgress({
        stage: 'load_demo',
        currentClipIndex: 0,
        totalClips: options.clipRanges.length,
        percent: 15,
        message: 'Loading demo...',
      })

      await this.loadDemo(options.demoPath)

      // Record each clip
      const tempClips: string[] = []
      const finalClipPaths: string[] = []
      for (let i = 0; i < options.clipRanges.length; i++) {
        const range = options.clipRanges[i]

        onProgress({
          stage: 'recording',
          currentClipIndex: i + 1,
          totalClips: options.clipRanges.length,
          percent: 20 + ((i / options.clipRanges.length) * 60),
          message: `Recording clip ${i + 1}/${options.clipRanges.length}: ${range.label || range.id}...`,
        })

        // Generate safe filename from clip ID
        const safeId = range.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        const tempClipPath = await this.recordClip(range, options.playbackSpeed, safeId)
        tempClips.push(tempClipPath)
        
        // Track final output path
        const finalPath = path.join(clipOutputDir, `${safeId}.mp4`)
        finalClipPaths.push(finalPath)
      }

      // Terminate CS2
      await this.terminateCS2()

      // Post-process with ffmpeg
      const { FfmpegService } = await import('./ffmpegService')
      const ffmpegService = new FfmpegService()

      onProgress({
        stage: 'ffmpeg',
        currentClipIndex: 0,
        totalClips: options.clipRanges.length,
        percent: 80,
        message: 'Post-processing clips with ffmpeg...',
      })

      // Normalize speed and move to final output directory
      const normalizedClips: string[] = []
      for (let i = 0; i < tempClips.length; i++) {
        onProgress({
          stage: 'ffmpeg',
          currentClipIndex: i + 1,
          totalClips: tempClips.length,
          percent: 80 + ((i / tempClips.length) * 15),
          message: `Processing clip ${i + 1}/${tempClips.length}...`,
        })

        // Normalize speed directly to final output path
        await ffmpegService.normalizeSpeed(
          tempClips[i],
          options.playbackSpeed,
          finalClipPaths[i]
        )
        normalizedClips.push(finalClipPaths[i])
      }

      // Create montage if enabled
      let montageOutputPath: string | undefined
      if (options.montageEnabled && normalizedClips.length > 0) {
        onProgress({
          stage: 'ffmpeg',
          currentClipIndex: 0,
          totalClips: options.clipRanges.length,
          percent: 95,
          message: 'Creating montage...',
        })

        montageOutputPath = path.join(outputDir, demoName, 'montage.mp4')
        await ffmpegService.createMontage(
          normalizedClips,
          montageOutputPath,
          options.fadeDuration
        )
      }

      // Cleanup temp files
      await this.cleanup()

      onProgress({
        stage: 'done',
        currentClipIndex: options.clipRanges.length,
        totalClips: options.clipRanges.length,
        percent: 100,
        message: 'Export complete!',
      })

      return {
        success: true,
        clips: finalClipPaths,
        montage: montageOutputPath,
      }
    } catch (error) {
      console.error('[ClipExport] Error:', error)
      await this.cleanup()
      return {
        success: false,
        clips: [],
        error: error instanceof Error ? error.message : 'Unknown error during clip export',
      }
    }
  }

  /**
   * Launch CS2 in hidden/borderless mode
   */
  private async launchCS2Hidden(resolutionPreset: '720p' | '1080p'): Promise<void> {
    const cs2Path = getSetting('cs2_path', '')
    if (!cs2Path || !fs.existsSync(cs2Path)) {
      throw new Error('CS2 path not configured or not found. Please configure it in Settings.')
    }

    const [width, height] = resolutionPreset === '1080p' ? [1920, 1080] : [1280, 720]

    const args = [
      '-windowed',
      '-noborder',
      `-w`, width.toString(),
      `-h`, height.toString(),
      '-novid',
      '-console',
      '-insecure',
      '+ip', '0.0.0.0',
      '-usercon',
      '-netconport', this.netconPort.toString(),
      '-nosound', // Disable audio for faster recording
    ]

    return new Promise<void>((resolve, reject) => {
      try {
        this.cs2Process = spawn(cs2Path, args, {
          detached: true,
          stdio: 'ignore',
          cwd: path.dirname(cs2Path),
        })

        this.cs2Process.unref()

        // Wait for CS2 to start and be ready for netconport with retries
        this.waitForNetconPort(10, 1000).then(() => {
          console.log('[ClipExport] CS2 netconport ready')
          resolve()
        }).catch((err) => {
          reject(new Error(`CS2 failed to start netconport: ${err.message}. Make sure CS2 isn't already running.`))
        })
      } catch (error) {
        reject(new Error(`Failed to launch CS2: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /**
   * Wait for netconport to be ready with retries
   */
  private async waitForNetconPort(maxRetries: number, delayMs: number): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.testNetconConnection()
        return // Success!
      } catch (err) {
        console.log(`[ClipExport] Waiting for netconport... (${i + 1}/${maxRetries})`)
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
    }
    throw new Error('CS2 netconport did not become ready in time')
  }

  /**
   * Test if netconport is accepting connections (TCP)
   */
  private async testNetconConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.netconPort })
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('Connection timeout'))
      }, 2000)

      socket.on('connect', () => {
        clearTimeout(timeout)
        socket.end()
        resolve()
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  /**
   * Load demo in CS2
   */
  private async loadDemo(demoPath: string): Promise<void> {
    await this.sendCommand(`playdemo "${demoPath}"`)
    // Wait for demo to load
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  /**
   * Record a single clip
   */
  private async recordClip(
    range: ClipRange,
    playbackSpeed: number,
    safeId: string
  ): Promise<string> {
    const clipFilePath = path.join(this.tempDir, `${safeId}.mp4`)
    const durationSeconds = (range.endTick - range.startTick) / this.tickRate
    const recordDurationMs = (durationSeconds * 1000) / playbackSpeed + 500 // Add safety buffer

    const commands: string[] = [
      'demo_pause',
      `demo_gototick ${range.startTick}`,
    ]

    // Spectate player if provided
    if (range.playerName) {
      const playerQuoted = range.playerName.includes(' ') ? `"${range.playerName}"` : range.playerName
      commands.push(`spec_player ${playerQuoted}`)
    }

    // Set playback speed and start recording
    commands.push(`demo_timescale ${playbackSpeed}`)
    const clipFilePathForCs2 = clipFilePath.replace(/\\/g, '/')
    commands.push(`startmovie "${clipFilePathForCs2}" 0`)
    commands.push('demo_resume')

    // Send all commands in one connection (more efficient than individual sends)
    await this.sendCommandsSequentially(commands)

    // Wait for recording duration
    await new Promise(resolve => setTimeout(resolve, recordDurationMs))

    // Stop recording
    await this.sendCommandsSequentially([
      'endmovie',
      'demo_pause',
      'demo_timescale 1.0'
    ])

    const recordedPath = await this.waitForRecordedFile(clipFilePath, safeId)
    if (recordedPath !== clipFilePath) {
      try {
        fs.copyFileSync(recordedPath, clipFilePath)
        fs.unlinkSync(recordedPath)
      } catch (error) {
        console.warn('[ClipExport] Failed to move recording to temp dir:', error)
      }
    }

    return clipFilePath
  }

  private getPossibleRecordingDirs(): string[] {
    const cs2Path = getSetting('cs2_path', '')
    if (!cs2Path) return []

    const gameDir = path.resolve(path.dirname(cs2Path), '..', '..')
    const candidates = [
      path.join(gameDir, 'csgo'),
      path.join(gameDir, 'csgo', 'videos'),
      path.join(gameDir, 'csgo', 'movie'),
      path.join(gameDir, 'cs2'),
      path.join(gameDir, 'cs2', 'videos'),
    ]

    return candidates.filter((dir) => fs.existsSync(dir))
  }

  private async waitForRecordedFile(expectedPath: string, safeId: string): Promise<string> {
    const possibleDirs = this.getPossibleRecordingDirs()
    const extensions = ['.mp4', '.webm', '.avi', '.mov']
    const deadline = Date.now() + 15000

    while (Date.now() < deadline) {
      if (fs.existsSync(expectedPath)) {
        return expectedPath
      }

      for (const dir of possibleDirs) {
        for (const ext of extensions) {
          const candidate = path.join(dir, `${safeId}${ext}`)
          if (fs.existsSync(candidate)) {
            return candidate
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500))
    }

    throw new Error(`Recording failed: output file not created for ${safeId}`)
  }

  /**
   * Send console command to CS2 via netconport (TCP) - matches main.ts implementation
   */
  private async sendCommand(command: string): Promise<void> {
    return this.sendCommandsSequentially([command])
  }

  /**
   * Send multiple console commands sequentially via netconport (TCP)
   * Implementation matches sendCS2CommandsSequentially from main.ts
   */
  private async sendCommandsSequentially(commands: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.netconPort })
      let commandIndex = 0
      let connected = false

      const timeout = setTimeout(() => {
        if (!connected) {
          socket.destroy()
          reject(new Error('Connection timeout'))
        }
      }, 10000)

      socket.on('connect', () => {
        connected = true
        clearTimeout(timeout)
        console.log(`[ClipExport] Connected to CS2 netconport on port ${this.netconPort}`)
        sendNextCommand()
      })

      socket.on('data', (buf) => {
        const response = buf.toString('utf8')
        if (response.trim()) {
          console.log(`[ClipExport] Response:`, response.trim())
        }
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        console.error(`[ClipExport] Socket error:`, err)
        if (!connected) {
          reject(err)
        } else if (commandIndex >= commands.length) {
          resolve()
        }
      })

      socket.on('close', () => {
        clearTimeout(timeout)
        console.log(`[ClipExport] Connection closed`)
        if (connected) {
          if (commandIndex >= commands.length) {
            resolve()
          } else {
            reject(new Error('Connection closed before all commands were sent'))
          }
        }
      })

      const sendNextCommand = () => {
        if (commandIndex >= commands.length) {
          socket.end()
          return
        }

        const command = commands[commandIndex]
        console.log(`[ClipExport] Sending command ${commandIndex + 1}/${commands.length}: ${command}`)

        socket.write(command.trimEnd() + '\n', (err) => {
          if (err) {
            console.error(`[ClipExport] Failed to send command:`, err)
            socket.destroy()
            reject(err)
            return
          }

          commandIndex++

          // Determine delay based on command type (matching main.ts logic)
          let delay = 500
          if (commandIndex > 0) {
            const previousCommand = commands[commandIndex - 1]
            if (previousCommand.startsWith('demo_gototick')) {
              delay = 2000
            } else if (previousCommand.startsWith('playdemo')) {
              delay = 3000
            } else if (previousCommand.startsWith('demo_pause')) {
              delay = 300
            }
          }

          if (commandIndex < commands.length) {
            setTimeout(() => sendNextCommand(), delay)
          } else {
            setTimeout(() => socket.end(), 500)
          }
        })
      }
    })
  }

  /**
   * Terminate CS2 gracefully
   */
  private async terminateCS2(): Promise<void> {
    if (!this.cs2Process) return

    try {
      await this.sendCommand('quit')
    } catch {
      // If netconport fails, kill process
      if (this.cs2Process && !this.cs2Process.killed) {
        this.cs2Process.kill('SIGTERM')
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000))

    if (this.cs2Process && !this.cs2Process.killed) {
      this.cs2Process.kill('SIGKILL')
    }

    this.cs2Process = null
  }

  /**
   * Cleanup temporary files
   */
  private async cleanup(): Promise<void> {
    try {
      await this.terminateCS2()
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true })
      }
    } catch (error) {
      console.error('[ClipExport] Cleanup error:', error)
    }
  }
}
