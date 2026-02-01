import * as fs from 'fs'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import * as net from 'net'
import { getSetting } from './settings'
import { app } from 'electron'

/**
 * Copy clean recording config files to CS2's cfg directory
 */
function ensureCleanCaptureConfigs(cs2Path: string, logger?: HlaeLogger): void {
  try {
    // Get CS2's cfg directory
    // CS2 path: .../game/bin/win64/cs2.exe
    // cfg path: .../game/csgo/cfg
    const cs2BinWin64 = path.dirname(cs2Path) // .../game/bin/win64
    const cs2Bin = path.dirname(cs2BinWin64) // .../game/bin
    const cs2GameDir = path.dirname(cs2Bin) // .../game
    const cs2CfgDir = path.join(cs2GameDir, 'csgo', 'cfg')
    
    if (!fs.existsSync(cs2CfgDir)) {
      if (logger) logger.error(`CS2 cfg directory not found: ${cs2CfgDir}`)
      return
    }
    
    // Get our config files from resources
    const resourcesCfgDir = path.join(process.resourcesPath || app.getAppPath(), 'resources', 'cfg')
    const cleanCaptureSource = path.join(resourcesCfgDir, 'clean_capture.cfg')
    const restoreCaptureSource = path.join(resourcesCfgDir, 'restore_capture.cfg')
    
    // Fallback: try relative path if resources path doesn't work
    const fallbackCfgDir = path.join(app.getAppPath(), 'resources', 'cfg')
    const cleanCaptureFallback = path.join(fallbackCfgDir, 'clean_capture.cfg')
    const restoreCaptureFallback = path.join(fallbackCfgDir, 'restore_capture.cfg')
    
    const cleanSource = fs.existsSync(cleanCaptureSource) ? cleanCaptureSource : cleanCaptureFallback
    const restoreSource = fs.existsSync(restoreCaptureSource) ? restoreCaptureSource : restoreCaptureFallback
    
    if (!fs.existsSync(cleanSource) || !fs.existsSync(restoreSource)) {
      if (logger) logger.error(`Config files not found in resources: ${resourcesCfgDir} or ${fallbackCfgDir}`)
      return
    }
    
    // Copy files to CS2 cfg directory
    const cleanCaptureTarget = path.join(cs2CfgDir, 'clean_capture.cfg')
    const restoreCaptureTarget = path.join(cs2CfgDir, 'restore_capture.cfg')
    
    fs.copyFileSync(cleanSource, cleanCaptureTarget)
    fs.copyFileSync(restoreSource, restoreCaptureTarget)
    
    if (logger) {
      logger.log(`Copied clean_capture.cfg to: ${cleanCaptureTarget}`)
      logger.log(`Copied restore_capture.cfg to: ${restoreCaptureTarget}`)
    }
  } catch (err) {
    if (logger) logger.error('Failed to copy clean capture configs:', err)
  }
}

/**
 * Logger for HLAE operations
 */
export class HlaeLogger {
  private logFile: string
  private logStream: fs.WriteStream | null = null

  constructor(jobDir: string, logFileName: string = 'hlae-export.log') {
    this.logFile = path.join(jobDir, logFileName)
    const logDir = path.dirname(this.logFile)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
  }

  log(message: string): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${message}\n`
    console.log(`[HLAE] ${message}`)
    if (this.logStream) {
      this.logStream.write(line)
    }
  }

  error(message: string, error?: any): void {
    const timestamp = new Date().toISOString()
    const errorMsg = error instanceof Error ? error.message : String(error || '')
    const line = `[${timestamp}] ERROR: ${message} ${errorMsg}\n`
    console.error(`[HLAE] ERROR: ${message}`, error)
    if (this.logStream) {
      this.logStream.write(line)
    }
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }
}

/**
 * CS2 Command Sender via netconport
 */
export class CS2CommandSender {
  private netconPort: number
  private logger: HlaeLogger

  constructor(netconPort: number, logger: HlaeLogger) {
    this.netconPort = netconPort
    this.logger = logger
  }

  async send(cmd: string): Promise<void> {
    return this.sendBatch([cmd], 150)
  }

  async sendBatch(cmds: string[], delayMs: number = 150): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.netconPort })
      let commandIndex = 0
      let connected = false

      const timeout = setTimeout(() => {
        if (!connected) {
          socket.destroy()
          reject(new Error('Connection timeout to netconport'))
        }
      }, 10000)

      socket.on('connect', () => {
        connected = true
        clearTimeout(timeout)
        this.logger.log(`Connected to CS2 netconport on port ${this.netconPort}`)
        sendNextCommand()
      })

      socket.on('data', (buf) => {
        const response = buf.toString('utf8').trim()
        if (response) {
          this.logger.log(`Response: ${response}`)
        }
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        this.logger.error('Socket error:', err)
        if (!connected) {
          reject(err)
        }
      })

      socket.on('close', () => {
        clearTimeout(timeout)
        if (connected && commandIndex >= cmds.length) {
          resolve()
        } else if (!connected || commandIndex < cmds.length) {
          reject(new Error('Connection closed before all commands were sent'))
        }
      })

      const sendNextCommand = () => {
        if (commandIndex >= cmds.length) {
          socket.end()
          return
        }

        const command = cmds[commandIndex]
        this.logger.log(`Sending command ${commandIndex + 1}/${cmds.length}: ${command}`)

        socket.write(command.trimEnd() + '\n', (err) => {
          if (err) {
            this.logger.error('Failed to send command:', err)
            socket.destroy()
            reject(err)
            return
          }

          commandIndex++

          let delay = delayMs
          if (commandIndex > 0) {
            const previousCommand = cmds[commandIndex - 1]
            if (previousCommand.startsWith('demo_gototick')) {
              delay = 2000
            } else if (previousCommand.startsWith('playdemo')) {
              delay = 3000
            } else if (previousCommand.startsWith('demo_pause')) {
              delay = 300
            }
          }

          if (commandIndex < cmds.length) {
            setTimeout(() => sendNextCommand(), delay)
          } else {
            setTimeout(() => socket.end(), 500)
          }
        })
      }
    })
  }

  async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async testConnection(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.netconPort })
      const timeout = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 2000)

      socket.on('connect', () => {
        clearTimeout(timeout)
        socket.end()
        resolve(true)
      })

      socket.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }
}

/**
 * HLAE Launcher
 */
export class HlaeLauncher {
  private hlaePath: string
  private cs2Path: string
  private netconPort: number
  private logger: HlaeLogger
  private hlaeProcess: ChildProcess | null = null

  constructor(hlaePath: string, cs2Path: string, netconPort: number, logger: HlaeLogger) {
    this.hlaePath = hlaePath
    this.cs2Path = cs2Path
    this.netconPort = netconPort
    this.logger = logger
  }

  async launch(options: { width: number; height: number; launchArgs?: string; movieConfigDir?: string }): Promise<void> {
    const { width, height, launchArgs, movieConfigDir } = options
    this.logger.log(`Launching CS2 via HLAE: ${this.hlaePath}`)
    this.logger.log(`CS2 path: ${this.cs2Path}`)
    this.logger.log(`Resolution: ${width}x${height}`)
    if (launchArgs) {
      this.logger.log(`Custom launch args: ${launchArgs}`)
    }
    if (movieConfigDir) {
      this.logger.log(`Movie config dir: ${movieConfigDir}`)
    }

    const sanitizePath = (value: string): string => value.trim().replace(/^"|"$/g, '')

    this.hlaePath = sanitizePath(this.hlaePath)
    this.cs2Path = sanitizePath(this.cs2Path)

    if (!fs.existsSync(this.hlaePath)) {
      throw new Error(`HLAE not found at: ${this.hlaePath}. Please configure HLAE path in Settings.`)
    }

    if (!fs.existsSync(this.cs2Path)) {
      throw new Error(`CS2 not found at: ${this.cs2Path}. Please configure CS2 path in Settings.`)
    }

    const hlaeStat = fs.statSync(this.hlaePath)
    let hlaeExe: string
    let hlaeRoot: string

    if (hlaeStat.isDirectory()) {
      const possibleExes = ['HLAE.exe', 'hlae.exe', 'AfxHookSource2.exe']
      const found = possibleExes.find((exe) => fs.existsSync(path.join(this.hlaePath, exe)))
      if (!found) {
        throw new Error(`HLAE executable not found in directory: ${this.hlaePath}`)
      }
      hlaeExe = path.join(this.hlaePath, found)
      hlaeRoot = this.hlaePath
    } else {
      hlaeExe = this.hlaePath
      hlaeRoot = path.dirname(hlaeExe)
    }

    const hookDllCandidates = [
      path.join(hlaeRoot, 'x64', 'AfxHookSource2.dll'),
      path.join(hlaeRoot, 'AfxHookSource2.dll'),
    ]
    const hookDllPath = hookDllCandidates.find((candidate) => fs.existsSync(candidate))
    if (!hookDllPath) {
      throw new Error(
        `AfxHookSource2.dll not found. Tried: ${hookDllCandidates.join(', ')}. ` +
        `Make sure you selected the HLAE folder containing the x64\AfxHookSource2.dll.`
      )
    }

    const argsFromString = (value?: string): string[] => {
      if (!value) return []
      const matches = value.match(/"[^"]+"|\S+/g) || []
      return matches.map((part) => part.replace(/^"|"$/g, ''))
    }

    if (movieConfigDir) {
      const cfgDir = path.join(movieConfigDir, 'cfg')
      if (!fs.existsSync(cfgDir)) {
        fs.mkdirSync(cfgDir, { recursive: true })
      }
    }

    const baseCs2Args = [
      '-steam',
      '-sw',
      '-w', width.toString(),
      '-h', height.toString(),
      '-novid',
      '-console',
      '-insecure',
      '+sv_lan', '1',
    ]

    const customArgs = argsFromString(launchArgs)
    const hasNetconPort = customArgs.some((arg) => arg === '-netconport')
    if (!hasNetconPort) {
      baseCs2Args.push('-netconport', this.netconPort.toString())
    }

    const cs2Args = [...baseCs2Args, ...customArgs].join(' ')

    const hlaeArgs = [
      '-customLoader',
      '-noGui',
      '-autoStart',
      '-hookDllPath', hookDllPath,
      '-programPath', this.cs2Path,
      '-cmdLine', cs2Args,
    ]

    if (movieConfigDir) {
      hlaeArgs.push('-addEnv', `USRLOCALCSGO=${movieConfigDir}`)
    }

    this.logger.log(`HLAE command: ${hlaeExe} ${hlaeArgs.join(' ')}`)

    return new Promise<void>((resolve, reject) => {
      try {
        this.hlaeProcess = spawn(hlaeExe, hlaeArgs, {
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: path.dirname(hlaeExe),
          env: { ...process.env },
        })

        if (this.hlaeProcess.stdout) {
          this.hlaeProcess.stdout.on('data', (data) => {
            this.logger.log(`STDOUT: ${data.toString().trim()}`)
          })
        }

        if (this.hlaeProcess.stderr) {
          this.hlaeProcess.stderr.on('data', (data) => {
            this.logger.log(`STDERR: ${data.toString().trim()}`)
          })
        }

        this.hlaeProcess.on('error', (error) => {
          this.logger.error('HLAE process error:', error)
          reject(new Error(`Failed to launch HLAE: ${error.message}`))
        })

        this.hlaeProcess.on('exit', (code, signal) => {
          this.logger.log(`HLAE process exited with code ${code}, signal ${signal}`)
        })

        this.logger.log('Waiting for CS2 to start...')
        this.waitForNetconPort(30, 1000)
          .then(() => {
            this.logger.log('CS2 netconport ready')
            resolve()
          })
          .catch((err) => {
            this.logger.error('CS2 failed to start netconport:', err)
            reject(
              new Error(
                `CS2 failed to start netconport: ${err.message}. Ensure CS2 isn't already running and HLAE is compatible with your CS2 version.`
              )
            )
          })
      } catch (error) {
        this.logger.error('Failed to spawn HLAE:', error)
        reject(new Error(`Failed to launch HLAE: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  getProcessId(): number | null {
    return this.hlaeProcess?.pid ?? null
  }

  async validateHook(commandSender: CS2CommandSender): Promise<boolean> {
    try {
      this.logger.log('Validating HLAE hook (testing mirv commands)...')
      await commandSender.send('mirv_streams')
      this.logger.log('HLAE hook validation passed')
      return true
    } catch (error) {
      this.logger.error('HLAE hook validation failed:', error)
      throw new Error(
        'HLAE hook not detected (mirv commands unavailable). Update HLAE/AfxHookSource2 to match your CS2 version.'
      )
    }
  }

  private async waitForNetconPort(maxRetries: number, delayMs: number): Promise<void> {
    const commandSender = new CS2CommandSender(this.netconPort, this.logger)
    
    for (let i = 0; i < maxRetries; i++) {
      const isReady = await commandSender.testConnection()
      if (isReady) {
        this.logger.log(`Netconport ready after ${i + 1} attempts`)
        return
      }
      
      this.logger.log(`Waiting for netconport... (${i + 1}/${maxRetries})`)
      
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    
    throw new Error('CS2 netconport did not become ready in time')
  }

  async terminate(commandSender: CS2CommandSender): Promise<void> {
    this.logger.log('Terminating CS2...')
    
    try {
      await commandSender.send('quit')
      await new Promise((resolve) => setTimeout(resolve, 2000))
    } catch (error) {
      this.logger.error('Failed to send quit command:', error)
    }

    if (this.hlaeProcess && !this.hlaeProcess.killed) {
      this.logger.log('Killing HLAE process...')
      this.hlaeProcess.kill('SIGTERM')
      
      await new Promise((resolve) => setTimeout(resolve, 1000))
      
      if (this.hlaeProcess && !this.hlaeProcess.killed) {
        this.hlaeProcess.kill('SIGKILL')
      }
    }

    this.hlaeProcess = null
    this.logger.log('CS2 terminated')
  }
}

/**
 * HLAE Recorder Backend
 */
export interface ClipRecordOptions {
  startTick: number
  endTick: number
  pov?: {
    steamId?: string
    name?: string
    slot?: number
  }
  timescale: number
  fps: number
  outputDir: string
  clipId: string
}

export class HlaeRecorderBackend {
  private commandSender: CS2CommandSender
  private logger: HlaeLogger
  private demoLoaded: boolean = false

  constructor(commandSender: CS2CommandSender, logger: HlaeLogger) {
    this.commandSender = commandSender
    this.logger = logger
  }

  async loadDemo(demoPath: string): Promise<void> {
    if (this.demoLoaded) {
      this.logger.log('Demo already loaded, skipping...')
      return
    }

    this.logger.log(`Loading demo: ${demoPath}`)
    await this.commandSender.send(`playdemo "${demoPath}"`)
    await this.commandSender.wait(5000)
    
    this.demoLoaded = true
    this.logger.log('Demo loaded successfully')
  }

  async recordClip(options: ClipRecordOptions): Promise<string> {
    this.logger.log(`\n========================================`)
    this.logger.log(`Recording clip: ${options.clipId}`)
    this.logger.log(`  Event ticks: ${options.startTick} -> ${options.endTick}`)
    this.logger.log(`  Timescale: ${options.timescale}x`)
    this.logger.log(`  FPS: ${options.fps}`)
    this.logger.log(`========================================`)

    // Verify mirv_streams is available
    this.logger.log('Checking if mirv_streams is available...')
    await this.commandSender.send('mirv_streams')
    await this.commandSender.wait(500)

    await this.commandSender.send('demo_pause')
    await this.commandSender.wait(300)

    // Start recording 15 seconds before the event (15 * 64 ticks at 64 tick rate)
    // This provides ample context to understand what's happening
    const TICKRATE = 64
    const PREVIEW_SECONDS = 15
    const recordStartTick = Math.max(0, options.startTick - (PREVIEW_SECONDS * TICKRATE))
    
    this.logger.log(`Seeking to tick ${recordStartTick} (15s before event at tick ${options.startTick})...`)
    await this.commandSender.send(`demo_gototick ${recordStartTick}`)
    await this.commandSender.wait(2000)

    if (options.pov) {
      await this.setPOV(options.pov)
    }

    await this.commandSender.send(`demo_timescale ${options.timescale}`)
    await this.commandSender.wait(300)

    const rawDir = path.join(options.outputDir, 'raw', options.clipId)
    if (!fs.existsSync(rawDir)) {
      fs.mkdirSync(rawDir, { recursive: true })
    }
    
    // Ensure clean capture config files are copied to CS2's cfg directory
    const cs2Path = getSetting('cs2_path', '')
    if (cs2Path && fs.existsSync(cs2Path)) {
      ensureCleanCaptureConfigs(cs2Path, this.logger)
    }
    
    // Execute clean capture config to hide UI elements for recording
    this.logger.log('Applying clean capture config...')
    await this.commandSender.send('exec clean_capture')
    await this.commandSender.wait(500)
    
    // HLAE writes to take0000 folder by default, so just use the clip name
    // Let HLAE write to its default location and we'll find the files there
    this.logger.log(`Configuring mirv_streams record for clip: ${options.clipId}`)
    
    await this.commandSender.sendBatch([
      'mirv_streams record',
      `mirv_streams record name "${options.clipId}"`,
      `mirv_streams record fps ${options.fps}`,
      `mirv_streams record format tga`,
      'mirv_streams record screen enabled 1',
    ], 200)

    // Start playing demo before starting recording to avoid frozen first frame
    this.logger.log('Starting demo playback...')
    await this.commandSender.send('demo_resume')
    
    // Wait for demo to stabilize after resume before starting recording
    // This prevents the first frame from being frozen/black
    this.logger.log('Waiting for demo to stabilize before recording...')
    await this.commandSender.wait(1000)

    this.logger.log('Starting recording...')
    await this.commandSender.send('mirv_streams record start')
    await this.commandSender.wait(500)

    // Calculate recording duration: from preview start to event end
    const TICKRATE_CONST = 64
    const durationTicks = options.endTick - recordStartTick
    const durationSeconds = durationTicks / TICKRATE_CONST
    const wallMs = (durationSeconds * 1000) / options.timescale
    const recordDurationMs = wallMs + 1000

    this.logger.log(`Recording for ${recordDurationMs}ms (${durationSeconds}s game time at ${options.timescale}x speed)...`)
    await this.commandSender.wait(recordDurationMs)

    this.logger.log('Stopping recording...')
    await this.commandSender.sendBatch([
      'mirv_streams record end',
      'demo_pause',
      'demo_timescale 1.0',
    ], 150)

    // Restore normal UI after recording
    this.logger.log('Restoring normal UI...')
    await this.commandSender.send('exec restore_capture')
    await this.commandSender.wait(300)

    // Wait for HLAE to flush frames to disk (critical for multi-clip recording)
    this.logger.log('Waiting for frames to be written to disk...')
    await this.commandSender.wait(2000)

    // Find TGA frames directory
    const tgaDir = await this.verifyOutput(rawDir, options.clipId)
    this.logger.log(`Found TGA frames at: ${tgaDir}`)

    // Render video from TGA frames (adjust fps for timescale)
    const adjustedFps = options.fps * options.timescale
    const videoPath = await this.renderVideo(tgaDir, options.clipId, adjustedFps)
    
    // Wait for video file to be fully written before returning
    await this.commandSender.wait(500)
    
    this.logger.log(`Clip recorded successfully: ${videoPath}`)
    this.logger.log(`========================================\n`)

    return videoPath
  }

  private async setPOV(pov: { steamId?: string; name?: string; slot?: number }): Promise<void> {
    let povCommand: string

    if (pov.slot !== undefined) {
      povCommand = `spec_player ${pov.slot}`
    } else if (pov.name) {
      const playerQuoted = pov.name.includes(' ') ? `"${pov.name}"` : pov.name
      povCommand = `spec_player ${playerQuoted}`
    } else {
      this.logger.log('No valid POV target specified, skipping...')
      return
    }

    this.logger.log(`Setting POV: ${povCommand}`)

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.commandSender.send(povCommand)
        await this.commandSender.wait(300)
        this.logger.log(`POV set successfully (attempt ${attempt})`)
        return
      } catch (error) {
        this.logger.error(`POV set failed (attempt ${attempt}):`, error)
        if (attempt < 3) {
          await this.commandSender.wait(300)
        }
      }
    }

    this.logger.error('Failed to set POV after 3 attempts')
  }

  private async verifyOutput(rawDir: string, clipId: string): Promise<string> {
    this.logger.log(`Verifying output, starting from: ${rawDir}`)

    // HLAE writes to take0000 under the configured output root.
    const rawRoot = path.dirname(rawDir)
    const cs2Path = getSetting('cs2ExePath', '') || getSetting('cs2_path', '')
    const cs2Dir = cs2Path ? path.dirname(cs2Path) : ''
    const candidates = [
      path.join(rawDir, 'take0000', clipId),
      path.join(rawDir, 'take0000'),
      path.join(rawRoot, 'take0000', clipId),
      path.join(rawRoot, 'take0000'),
    ]

    if (cs2Dir) {
      candidates.push(
        path.join(cs2Dir, clipId, 'take0000'),
        path.join(cs2Dir, clipId)
      )
    }

    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue
      const result = this.findTgaDirectory(dir)
      if (result) return result
    }

    if (cs2Dir) {
      const clipRoot = path.join(cs2Dir, clipId)
      if (fs.existsSync(clipRoot)) {
        try {
          const entries = fs.readdirSync(clipRoot, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (!/^take\d{4}$/i.test(entry.name)) continue
            const takeDir = path.join(clipRoot, entry.name)
            const result = this.findTgaDirectory(takeDir)
            if (result) return result
          }
        } catch {
          // ignore read errors
        }
      }
    }

    const checked = candidates.join(', ')
    throw new Error(
      `HLAE output directory not found. ` +
      `Checked: ${checked}. ` +
      `Ensure recording is active and frames are written under take0000.`
    )
  }
  
  private findTgaDirectory(searchDir: string): string | null {
    this.logger.log(`Searching for TGA files in: ${searchDir}`)
    
    // Recursively search for TGA files
    const findTgaFiles = (dir: string): string | null => {
      if (!fs.existsSync(dir)) return null
      
      const allFiles = fs.readdirSync(dir)
      const tgaFiles = allFiles.filter((file) => file.endsWith('.tga'))
      
      if (tgaFiles.length > 0) {
        this.logger.log(`Found ${tgaFiles.length} TGA files in: ${dir}`)
        return dir
      }
      
      // Search subdirectories
      for (const file of allFiles) {
        const fullPath = path.join(dir, file)
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            const result = findTgaFiles(fullPath)
            if (result) return result
          }
        } catch {
          // ignore stat errors
        }
      }
      
      return null
    }
    
    return findTgaFiles(searchDir)
  }

  private async renderVideo(tgaDir: string, clipId: string, fps: number = 30): Promise<string> {
    const { FfmpegService } = await import('./ffmpegService')
    const ffmpeg = new FfmpegService()

    // Get output directory from settings or use default
    let clipsOutputDir = getSetting('clips_output_directory', '')
    
    if (!clipsOutputDir) {
      // Use default: User's Videos folder under CS2 Demos
      const videosDir = process.env.USERPROFILE || process.env.HOME || ''
      if (!videosDir) {
        throw new Error('Unable to determine user home directory')
      }
      clipsOutputDir = path.join(videosDir, 'Videos', 'CS2 Demos', 'clips')
      this.logger.log(`Clips output directory not configured, using default: ${clipsOutputDir}`)
    }

    // Create match subdirectory (use clipId as match identifier)
    const matchDir = path.join(clipsOutputDir, clipId)
    if (!fs.existsSync(matchDir)) {
      fs.mkdirSync(matchDir, { recursive: true })
    }

    // Generate output filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const outputPath = path.join(matchDir, `clip_${timestamp}.mp4`)

    this.logger.log(`Rendering video from TGA frames: ${tgaDir}`)
    this.logger.log(`Video framerate: ${fps} fps`)

    // Detect TGA filename pattern by scanning directory
    let tgaPattern = '%08d.tga' // Default pattern
    try {
      const files = fs.readdirSync(tgaDir)
      const tgaFiles = files.filter(f => f.endsWith('.tga')).sort()
      
      if (tgaFiles.length > 0) {
        this.logger.log(`Found ${tgaFiles.length} TGA files, first file: ${tgaFiles[0]}`)
        
        // Analyze first file to determine pattern
        const firstFile = tgaFiles[0]
        const match = firstFile.match(/^(\d+)\.tga$/)
        if (match) {
          const numDigits = match[1].length
          this.logger.log(`Detected TGA filename pattern: ${numDigits}-digit zero-padded`)
          tgaPattern = `%0${numDigits}d.tga`
        }
      }
    } catch (err) {
      this.logger.error('Error scanning TGA directory:', err)
      // Fall back to default pattern
    }

    this.logger.log(`Using FFmpeg input pattern: ${tgaPattern}`)

    const inputPattern = path.join(tgaDir, tgaPattern)
    this.logger.log(`Output: ${outputPath}`)

    return new Promise((resolve, reject) => {
      const args = [
        '-framerate', fps.toString(),
        '-i', inputPattern,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-an', // Remove audio
        '-r', fps.toString(), // Explicitly set output framerate to match input
        outputPath,
      ]

      const ffmpegProcess = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''

      if (ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on('data', (data) => {
          const chunk = data.toString()
          stderr += chunk
          this.logger.log(`FFmpeg: ${chunk.trim()}`)
        })
      }

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.log(`Video rendered successfully: ${outputPath}`)
          
          // Clean up TGA files after successful encoding
          try {
            this.logger.log(`Cleaning up TGA files from: ${tgaDir}`)
            const files = fs.readdirSync(tgaDir)
            let deletedCount = 0
            for (const file of files) {
              if (file.endsWith('.tga')) {
                fs.unlinkSync(path.join(tgaDir, file))
                deletedCount++
              }
            }
            this.logger.log(`Deleted ${deletedCount} TGA files`)
            
            // Try to remove the directory if it's empty
            try {
              fs.rmdirSync(tgaDir)
              this.logger.log(`Removed empty TGA directory: ${tgaDir}`)
            } catch {
              // Directory might not be empty or already deleted, that's fine
            }
          } catch (err) {
            this.logger.error('Error cleaning up TGA files:', err)
            // Don't fail the conversion if cleanup fails
          }
          
          resolve(outputPath)
        } else {
          this.logger.error(`FFmpeg failed with code ${code}`, stderr)
          reject(new Error(`FFmpeg rendering failed: ${stderr}`))
        }
      })

      ffmpegProcess.on('error', (err) => {
        this.logger.error('FFmpeg process error:', err)
        reject(err)
      })
    })
  }
}

// Legacy HlaeRecorder class for backward compatibility
export class HlaeRecorder {
  private process: ChildProcess | null = null
  private netconPort: number

  constructor(netconPort: number) {
    this.netconPort = netconPort
  }

  async launch(resolutionPreset: '720p' | '1080p'): Promise<void> {
    const hlaePath = getSetting('hlae_path', '')
    if (!hlaePath || !fs.existsSync(hlaePath)) {
      throw new Error('HLAE path not configured or not found. Please set it in Settings.')
    }

    const cs2Path = getSetting('cs2_path', '')
    if (!cs2Path || !fs.existsSync(cs2Path)) {
      throw new Error('CS2 path not configured or not found. Please configure it in Settings.')
    }

    const [width, height] = resolutionPreset === '1080p' ? [1920, 1080] : [1280, 720]

    const args: string[] = [
      `-launch`,
      `-exe`, cs2Path,
      `-custom`,
      `-windowed`,
      `-noborder`,
      `-w`, width.toString(),
      `-h`, height.toString(),
      `-novid`,
      `-console`,
      `-insecure`,
      `-netconport`, this.netconPort.toString(),
      `-nosound`,
    ]

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(hlaePath, args, {
          detached: true,
          stdio: 'ignore',
          cwd: path.dirname(hlaePath),
        })

        this.process.unref()
        setTimeout(() => resolve(), 3000)
      } catch (error) {
        reject(new Error(`Failed to launch HLAE: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  async stop(): Promise<void> {
    if (!this.process) return

    if (!this.process.killed) {
      this.process.kill('SIGTERM')
    }

    this.process = null
  }

  buildStartCommands(outputPath: string, fps: number): string[] {
    const normalizedPath = outputPath.replace(/\\/g, '/')
    return [
      'mirv_streams remove all',
      'mirv_streams add normal',
      `mirv_streams record fps ${fps}`,
      `mirv_streams record name "${normalizedPath}"`,
      'mirv_streams record start',
    ]
  }

  buildStopCommands(): string[] {
    return [
      'mirv_streams record end',
    ]
  }
}
