import * as fs from 'fs'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { getSetting } from './settings'

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
