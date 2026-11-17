const WHISPER_SAMPLE_RATE = 16000

/**
 * Whisper only reads WAV, while cs2-voice-extractor writes Ogg Opus. For Ogg files,
 * decode with Chromium's built-in Opus decoder, resample to 16 kHz mono, and have the
 * main process write a WAV for Whisper. Returns the path Whisper should read.
 */
export async function prepareAudioForTranscription(audioFilePath: string): Promise<string> {
  if (!/\.(ogg|opus|oga)$/i.test(audioFilePath)) return audioFilePath

  const audio = await window.electronAPI.getVoiceAudio(audioFilePath)
  if (!audio.success || !audio.data) throw new Error(audio.error ?? 'Audio file not found')
  const encoded = await (await fetch(audio.data)).arrayBuffer()

  // decodeAudioData resamples to the context's rate; mix down to mono afterwards.
  const decodeCtx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE)
  const decoded = await decodeCtx.decodeAudioData(encoded)
  const length = decoded.length
  const pcm = new Int16Array(length)
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c))
  for (let i = 0; i < length; i++) {
    let sample = 0
    for (const channel of channels) sample += channel[i]
    sample /= channels.length
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }

  const result = await window.electronAPI.writeTranscriptionWav(audioFilePath, encodeWav16(pcm, WHISPER_SAMPLE_RATE))
  if (!result.success || !result.path) throw new Error(result.error ?? 'Could not prepare audio for transcription')
  return result.path
}

function encodeWav16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  new Int16Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}
