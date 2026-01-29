import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getSetting } from './settings'

export class FfmpegService {
  private ffmpegPath: string

  constructor() {
    // Try to get ffmpeg path from settings, otherwise assume it's in PATH
    this.ffmpegPath = getSetting('ffmpeg_path', 'ffmpeg')
  }

  /**
   * Check if ffmpeg is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(this.ffmpegPath, ['-version'], { stdio: 'pipe' })
      
      proc.on('error', () => {
        resolve(false)
      })

      proc.on('close', (code) => {
        resolve(code === 0)
      })

      setTimeout(() => {
        proc.kill()
        resolve(false)
      }, 5000)
    })
  }

  /**
   * Normalize playback speed using ffmpeg setpts filter
   */
  async normalizeSpeed(inputPath: string, playbackSpeed: number, outputPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Use setpts to normalize speed: setpts=<speed>*PTS
      // For audio, chain atempo filters if needed
      const speedInverted = 1 / playbackSpeed
      let audioFilter = ''

      // atempo supports 0.5-2.0, so chain if speed is > 2x
      if (speedInverted < 0.5) {
        // E.g. for 4x speed, speedInverted = 0.25, so use 0.5*0.5
        audioFilter = 'atempo=0.5,atempo=0.5'
      } else if (speedInverted < 1) {
        audioFilter = `atempo=${speedInverted}`
      } else if (speedInverted > 2) {
        // For > 2x, use multiple filters
        audioFilter = 'atempo=2.0,atempo=2.0'
      } else {
        audioFilter = `atempo=${speedInverted}`
      }

      const args = [
        '-i', inputPath,
        '-vf', `setpts=${playbackSpeed}*PTS`,
        '-af', audioFilter,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-c:a', 'aac',
        '-y', // Overwrite output file
        outputPath,
      ]

      const proc = spawn(this.ffmpegPath, args)
      let stderr = ''

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath)
        } else {
          reject(new Error(`ffmpeg speed normalization failed: ${stderr}`))
        }
      })

      proc.on('error', (error) => {
        reject(new Error(`ffmpeg error: ${error.message}`))
      })
    })
  }

  /**
   * Create a montage from multiple clips with fades
   */
  async createMontage(clipPaths: string[], outputPath: string, fadeDuration: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Create a concat demuxer file
      const concatFile = path.join(path.dirname(outputPath), 'concat.txt')
      const concatContent = clipPaths.map((p) => `file '${p.replace(/'/g, "\\'")}'`).join('\n')

      try {
        fs.writeFileSync(concatFile, concatContent, 'utf8')
      } catch (error) {
        reject(new Error(`Failed to write concat file: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      // Use concat demuxer with simple concat (no fancy fades for MVP)
      const args = [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c', 'copy', // Copy without re-encoding for speed
        '-y', // Overwrite output file
        outputPath,
      ]

      const proc = spawn(this.ffmpegPath, args)
      let stderr = ''

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        // Clean up concat file
        try {
          fs.unlinkSync(concatFile)
        } catch {
          // Ignore cleanup errors
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath)
        } else {
          reject(new Error(`ffmpeg montage creation failed: ${stderr}`))
        }
      })

      proc.on('error', (error) => {
        reject(new Error(`ffmpeg error: ${error.message}`))
      })
    })
  }
}
