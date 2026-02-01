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
   * Get video duration using ffprobe
   */
  private async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ]

      const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          const duration = parseFloat(stdout.trim())
          if (!isNaN(duration)) {
            resolve(duration)
          } else {
            reject(new Error(`Invalid duration value: ${stdout}`))
          }
        } else {
          reject(new Error(`ffprobe failed: ${stderr}`))
        }
      })

      proc.on('error', (error) => {
        reject(new Error(`ffprobe error: ${error.message}`))
      })
    })
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
   * Encode image sequence to MP4
   */
  async encodeImageSequence(
    imageDir: string,
    fps: number,
    outputPath: string,
    timescale: number = 1
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Find image pattern (e.g., *.tga, frame_%05d.tga)
      const files = fs.readdirSync(imageDir).filter((f) => f.endsWith('.tga') || f.endsWith('.png'))
      
      if (files.length === 0) {
        reject(new Error(`No image frames found in ${imageDir}`))
        return
      }

      // Determine pattern
      let pattern: string
      if (files[0].match(/\d{5,}/)) {
        // Numbered sequence like frame_00001.tga
        const match = files[0].match(/^(.+?)(\d+)(\.\w+)$/)
        if (match) {
          const [, prefix, , ext] = match
          const numDigits = match[2].length
          pattern = path.join(imageDir, `${prefix}%0${numDigits}d${ext}`)
        } else {
          pattern = path.join(imageDir, '*.tga')
        }
      } else {
        pattern = path.join(imageDir, '*.tga')
      }

      // Calculate setpts for speed normalization
      const setpts = timescale > 1 ? `setpts=${timescale}*PTS` : null

      const args = [
        '-framerate', fps.toString(),
        '-pattern_type', 'glob',
        '-i', pattern,
      ]

      if (setpts) {
        args.push('-vf', setpts)
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-y',
        outputPath
      )

      console.log('[FFmpeg] Encoding image sequence:', args.join(' '))

      const proc = spawn(this.ffmpegPath, args)
      let stderr = ''

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath)
        } else {
          reject(new Error(`ffmpeg image sequence encoding failed: ${stderr}`))
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
    return new Promise<string>(async (resolve, reject) => {
      if (clipPaths.length === 0) {
        reject(new Error('No clips provided for montage'))
        return
      }

      if (clipPaths.length === 1) {
        // Single clip, just copy it
        try {
          fs.copyFileSync(clipPaths[0], outputPath)
          resolve(outputPath)
        } catch (error) {
          reject(new Error(`Failed to copy single clip: ${error instanceof Error ? error.message : String(error)}`))
        }
        return
      }

      // If fadeDuration is 0 or very small, use simple concat without fades
      if (fadeDuration <= 0) {
        // Create a concat demuxer file
        const concatFile = path.join(path.dirname(outputPath), 'concat.txt')
        const concatContent = clipPaths.map((p) => `file '${p.replace(/'/g, "\\'")}'`).join('\n')

        try {
          fs.writeFileSync(concatFile, concatContent, 'utf8')
        } catch (error) {
          reject(new Error(`Failed to write concat file: ${error instanceof Error ? error.message : String(error)}`))
          return
        }

        // Use concat demuxer with re-encoding to ensure compatibility
        const args = [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFile,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-an', // Remove audio
          '-y',
          outputPath,
        ]

        console.log('[FFmpeg] Creating montage (no fades):', args.join(' '))

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
        return
      }

      // Use xfade filter for smooth fade transitions between clips
      // First, get durations of all clips
      console.log('[FFmpeg] Probing clip durations...')
      const durations: number[] = []
      
      try {
        for (const clipPath of clipPaths) {
          const duration = await this.getVideoDuration(clipPath)
          durations.push(duration)
          console.log(`[FFmpeg] Clip duration: ${clipPath} = ${duration.toFixed(2)}s`)
        }
      } catch (error) {
        reject(new Error(`Failed to probe clip durations: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      const args = ['-y']
      
      // Add all input files
      for (const clipPath of clipPaths) {
        args.push('-i', clipPath)
      }

      // Build filter complex for xfade transitions
      // offset = duration of current segment minus fade duration
      let filterComplex = ''
      if (clipPaths.length === 2) {
        // Simple case: just two clips with xfade
        const offset = Math.max(0, durations[0] - fadeDuration)
        filterComplex = `[0:v][1:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[v]`
        args.push('-filter_complex', filterComplex)
        args.push('-map', '[v]')
        args.push('-an') // Remove audio
      } else {
        // Multiple clips: chain xfades together
        const filterParts: string[] = []
        
        // First transition: clip 0 -> clip 1
        const offset0 = Math.max(0, durations[0] - fadeDuration)
        filterParts.push(`[0:v][1:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset0}[v01]`)
        
        // Track cumulative offset for chained xfades
        let cumulativeOffset = durations[0] // Start with duration of first clip
        
        for (let i = 2; i < clipPaths.length; i++) {
          const prevLabel = i === 2 ? 'v01' : `v${String(i - 1).padStart(2, '0')}`
          const nextLabel = `v${String(i).padStart(2, '0')}`
          
          // For chained xfades, offset is cumulative position minus fade duration
          // Each fade removes fadeDuration from the total, so we subtract it after each clip
          cumulativeOffset += durations[i - 1] - fadeDuration
          const offset = Math.max(0, cumulativeOffset - fadeDuration)
          
          filterParts.push(`[${prevLabel}][${i}:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[${nextLabel}]`)
        }
        
        filterComplex = filterParts.join('; ')
        const finalLabel = `v${String(clipPaths.length - 1).padStart(2, '0')}`
        args.push('-filter_complex', filterComplex)
        args.push('-map', `[${finalLabel}]`)
        args.push('-an') // Remove audio
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        outputPath
      )

      console.log('[FFmpeg] Creating montage with fades:', args.join(' '))

      const proc = spawn(this.ffmpegPath, args)
      let stderr = ''

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
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

  /**
   * Create montage with crossfade transitions (advanced)
   */
  async createMontageWithFades(clipPaths: string[], outputPath: string, fadeDuration: number): Promise<string> {
    // TODO: Implement xfade filter chain for smooth transitions
    // For now, fall back to simple concat
    return this.createMontage(clipPaths, outputPath, fadeDuration)
  }
}
