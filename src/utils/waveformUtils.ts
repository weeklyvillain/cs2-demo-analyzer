// src/utils/waveformUtils.ts

export const BAR_WIDTH = 3
export const BAR_GAP = 2
export const BAR_STRIDE = BAR_WIDTH + BAR_GAP
const BASE_BARS_PER_SECOND = 20
const MAX_BARS = 6000

/**
 * Divide PCM channel data into numBars equal chunks and compute the RMS amplitude
 * of each chunk. The result is normalised so the loudest bar = 1.0.
 */
export function computeRmsAmplitudes(channelData: Float32Array, numBars: number): Float32Array {
  const amplitudes = new Float32Array(numBars)
  const samplesPerBar = Math.floor(channelData.length / numBars)
  if (samplesPerBar === 0) return amplitudes

  let maxRms = 0
  for (let i = 0; i < numBars; i++) {
    const start = i * samplesPerBar
    const end = Math.min(start + samplesPerBar, channelData.length)
    let sumSq = 0
    for (let j = start; j < end; j++) {
      sumSq += channelData[j] * channelData[j]
    }
    amplitudes[i] = Math.sqrt(sumSq / (end - start))
    if (amplitudes[i] > maxRms) maxRms = amplitudes[i]
  }

  if (maxRms > 0) {
    for (let i = 0; i < numBars; i++) amplitudes[i] /= maxRms
  }
  return amplitudes
}

/**
 * How many bars to render. Uses at least enough bars to fill the display width,
 * but adds more for longer audio (up to MAX_BARS) so long tracks are scrollable.
 */
export function computeNumBars(audioDuration: number, displayWidth: number): number {
  const fromDuration = Math.ceil(audioDuration * BASE_BARS_PER_SECOND)
  const fromDisplay = Math.ceil(displayWidth / BAR_STRIDE)
  return Math.min(Math.max(fromDuration, fromDisplay), MAX_BARS)
}

export interface ScrollState {
  scrollX: number       // px the canvas image is shifted left
  playheadPx: number    // absolute px position of the playhead within the full canvas
  playedBarIndex: number // bar index at playhead (bars before this are "played" colour)
  totalWidth: number    // full canvas pixel width
}

/**
 * Compute scrolling waveform state from current playback position.
 * Playhead stays at displayWidth/2 once it passes the midpoint; the canvas scrolls behind it.
 */
export function computeScrollState(
  currentTime: number,
  audioDuration: number,
  numBars: number,
  displayWidth: number,
): ScrollState {
  const totalWidth = numBars * BAR_STRIDE
  if (audioDuration <= 0 || numBars === 0) {
    return { scrollX: 0, playheadPx: 0, playedBarIndex: 0, totalWidth }
  }
  const playheadPx = (currentTime / audioDuration) * totalWidth
  const halfDisplay = displayWidth / 2
  const scrollX = Math.max(0, Math.min(playheadPx - halfDisplay, totalWidth - displayWidth))
  const playedBarIndex = Math.floor(playheadPx / BAR_STRIDE)
  return { scrollX, playheadPx, playedBarIndex, totalWidth }
}

/**
 * Convert a pixel x position on the visible canvas (0..displayWidth) to a playback time.
 * scrollX must be the current scroll offset from computeScrollState.
 */
export function canvasXToTime(
  canvasX: number,
  scrollX: number,
  numBars: number,
  audioDuration: number,
): number {
  const totalWidth = numBars * BAR_STRIDE
  if (totalWidth === 0) return 0
  return Math.max(0, Math.min(audioDuration, ((canvasX + scrollX) / totalWidth) * audioDuration))
}

/**
 * Draw the waveform onto the given canvas for the current playback state.
 * Only the visible window (displayWidth) is painted; the caller handles the canvas size.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  amplitudes: Float32Array,
  scrollX: number,
  playedBarIndex: number,
  playheadPx: number,
  displayWidth: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { height } = canvas
  const centerY = height / 2
  const maxBarHalfHeight = centerY * 0.88

  ctx.clearRect(0, 0, canvas.width, height)

  // Played-region tint
  const playheadInDisplay = playheadPx - scrollX
  if (playheadInDisplay > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, 0, Math.min(playheadInDisplay, displayWidth), height)
  }

  // Amplitude bars (only those in the visible window)
  const firstBar = Math.floor(scrollX / BAR_STRIDE)
  const lastBar = Math.min(amplitudes.length - 1, Math.ceil((scrollX + displayWidth) / BAR_STRIDE))

  for (let i = firstBar; i <= lastBar; i++) {
    const x = i * BAR_STRIDE - scrollX
    const barHalfHeight = Math.max(2, amplitudes[i] * maxBarHalfHeight)
    ctx.fillStyle = i <= playedBarIndex ? '#d07a2d' : '#36393e'
    ctx.beginPath()
    if (ctx.roundRect) {
      ctx.roundRect(x, centerY - barHalfHeight, BAR_WIDTH, barHalfHeight * 2, 1)
    } else {
      ctx.rect(x, centerY - barHalfHeight, BAR_WIDTH, barHalfHeight * 2)
    }
    ctx.fill()
  }

  // Playhead line
  if (playheadInDisplay >= 0 && playheadInDisplay <= displayWidth) {
    ctx.fillStyle = '#d07a2d'
    ctx.fillRect(Math.round(playheadInDisplay) - 1, 0, 2, height)
  }
}
