import * as fs from 'fs'

/**
 * Helpers for the Ogg Opus files written by cs2-voice-extractor.
 *
 * The extractor remuxes CS2's Opus voice packets into Ogg without decoding them,
 * and fills gaps with 3-byte digital-silence frames. Opus voice is VBR, so the size
 * of a packet per millisecond of audio tracks how much is going on in it. That is
 * enough to draw a talk/silence waveform without an Opus decoder.
 */

const OPUS_SAMPLE_RATE = 48000
/** Packets this small are the extractor's silence filler (or DTX); treat them as silent. */
const SILENCE_PACKET_MAX_BYTES = 3

/** Duration of one Opus frame in 48 kHz samples, from the TOC config (RFC 6716 §3.1). */
function opusFrameSamples(config: number): number {
  if (config < 12) return [480, 960, 1920, 2880][config & 3] // SILK: 10/20/40/60 ms
  if (config < 16) return [480, 960][config & 1] // Hybrid: 10/20 ms
  return [120, 240, 480, 960][config & 3] // CELT: 2.5/5/10/20 ms
}

/** Number of 48 kHz samples in an Opus packet, or 0 if it can't be read. */
export function opusPacketSamples(packet: Buffer): number {
  if (packet.length === 0) return 0
  const toc = packet[0]
  const frameSamples = opusFrameSamples(toc >> 3)
  const code = toc & 3
  let frames = 1
  if (code === 1 || code === 2) frames = 2
  else if (code === 3) {
    if (packet.length < 2) return 0
    frames = packet[1] & 0x3f
  }
  return frames * frameSamples
}

interface OpusPacketInfo {
  /** Start position in 48 kHz samples (after pre-skip). */
  start: number
  samples: number
  bytes: number
}

/** Walks an Ogg Opus file and returns its audio packets (header packets skipped). */
function readOggOpusPackets(data: Buffer): { packets: OpusPacketInfo[]; durationSamples: number } {
  const packets: OpusPacketInfo[] = []
  let preSkip = 0
  let packetIndex = 0
  let position = 0 // samples, before pre-skip is applied
  let lastGranule = -1
  let pending: Buffer[] = []

  const onPacket = (packet: Buffer) => {
    const index = packetIndex++
    if (index === 0) {
      // OpusHead: magic(8) version(1) channels(1) pre-skip(2, LE) ...
      if (packet.length >= 12 && packet.toString('ascii', 0, 8) === 'OpusHead') {
        preSkip = packet.readUInt16LE(10)
      }
      return
    }
    if (index === 1) return // OpusTags
    const samples = opusPacketSamples(packet)
    if (samples > 0) {
      packets.push({ start: position - preSkip, samples, bytes: packet.length })
      position += samples
    }
  }

  let offset = 0
  while (offset + 27 <= data.length) {
    if (data.toString('ascii', offset, offset + 4) !== 'OggS') {
      // Resync on corrupt data rather than giving up.
      const next = data.indexOf('OggS', offset + 1, 'ascii')
      if (next === -1) break
      offset = next
      continue
    }
    const granuleLow = data.readUInt32LE(offset + 6)
    const granuleHigh = data.readInt32LE(offset + 10)
    const segmentCount = data[offset + 26]
    const tableStart = offset + 27
    const bodyStart = tableStart + segmentCount
    if (bodyStart > data.length) break

    let bodyLength = 0
    for (let i = 0; i < segmentCount; i++) bodyLength += data[tableStart + i]
    if (bodyStart + bodyLength > data.length) break

    let cursor = bodyStart
    for (let i = 0; i < segmentCount; i++) {
      const lacing = data[tableStart + i]
      pending.push(data.subarray(cursor, cursor + lacing))
      cursor += lacing
      if (lacing < 255) {
        onPacket(pending.length === 1 ? pending[0] : Buffer.concat(pending))
        pending = []
      }
    }

    if (granuleHigh !== -1 || granuleLow !== 0xffffffff) {
      lastGranule = granuleHigh * 0x100000000 + granuleLow
    }
    offset = bodyStart + bodyLength
  }

  const durationSamples = lastGranule > 0 ? Math.max(0, lastGranule - preSkip) : Math.max(0, position - preSkip)
  return { packets, durationSamples }
}

/**
 * Shapes raw per-bar levels for display: strips the background floor (the quietest
 * 20% of non-silent bars), normalises to the loudest bar, and applies a gentle curve
 * so quiet speech is still visible. Silent bars stay at 0.
 */
export function shapeWaveformLevels(levels: number[]): number[] {
  const max = levels.reduce((m, v) => (v > m ? v : m), 0)
  if (max <= 0) return levels.map(() => 0)
  const sorted = levels.filter(v => v > 0).sort((a, b) => a - b)
  const floor = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) * 0.2)] * 0.85 : 0
  const range = Math.max(max - floor, 1e-6)
  return levels.map(v => {
    if (v <= 0) return 0
    const normed = Math.max(0, v - floor) / range
    return normed > 0 ? Math.max(0.08, Math.pow(normed, 0.45)) : 0.08
  })
}

/**
 * Computes waveform bars for an Ogg Opus voice file from packet sizes.
 * Each bar is the average bitrate (bytes per sample) of the voice packets inside it.
 */
export async function computeOggOpusAmplitudesFromFile(
  filePath: string,
  numBars: number,
): Promise<{ amplitudes: number[]; duration: number }> {
  const data = await fs.promises.readFile(filePath)
  const { packets, durationSamples } = readOggOpusPackets(data)
  const duration = durationSamples / OPUS_SAMPLE_RATE
  if (durationSamples === 0 || packets.length === 0) {
    return { amplitudes: new Array(numBars).fill(0), duration }
  }

  const bytes = new Array<number>(numBars).fill(0)
  const covered = new Array<number>(numBars).fill(0)
  const samplesPerBar = durationSamples / numBars

  for (const packet of packets) {
    if (packet.bytes <= SILENCE_PACKET_MAX_BYTES) continue
    const start = Math.max(0, packet.start)
    const end = Math.min(durationSamples, packet.start + packet.samples)
    if (end <= start) continue
    const density = packet.bytes / packet.samples
    // Spread the packet over every bar it overlaps (packets can be longer than a bar).
    let bar = Math.min(numBars - 1, Math.floor(start / samplesPerBar))
    let cursor = start
    while (cursor < end && bar < numBars) {
      const barEnd = Math.min(end, (bar + 1) * samplesPerBar)
      const span = barEnd - cursor
      if (span > 0) {
        bytes[bar] += density * span
        covered[bar] += span
      }
      cursor = barEnd
      bar++
    }
  }

  // Average density over the voiced part of the bar, scaled by how much of the bar
  // is voiced, so a bar with a short blip reads lower than one full of speech.
  const levels = bytes.map((b, i) => {
    if (covered[i] <= 0) return 0
    const avgDensity = b / covered[i]
    const fill = Math.min(1, covered[i] / samplesPerBar)
    return avgDensity * Math.sqrt(fill)
  })

  return { amplitudes: shapeWaveformLevels(levels), duration }
}

export function isOggAudioPath(filePath: string): boolean {
  return /\.(ogg|opus|oga)$/i.test(filePath)
}

export function audioContentType(filePath: string): string {
  return isOggAudioPath(filePath) ? 'audio/ogg' : 'audio/wav'
}
