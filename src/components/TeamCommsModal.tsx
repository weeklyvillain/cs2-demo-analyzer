import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, Loader2, Mic, Gauge, Volume2, VolumeX } from 'lucide-react'
import Modal from './Modal'
import {
	computeNumBars,
	computeScrollState,
	canvasXToTime,
	drawWaveform,
} from '../utils/waveformUtils'

type ExtractionState = 'idle' | 'extracting' | 'ready' | 'error'

interface TeamCommsModalProps {
	isOpen: boolean
	onClose: () => void
	demoPath: string | null
	teamName: string
	players: Array<{ steamId: string; name: string }>
}

interface TeamAudioTrack {
	steamId: string
	playerName: string
	path: string
	url: string
	duration: number | null
	volume: number
	muted: boolean
	amplitudes: Float32Array | null
	numBars: number
	loadState: 'loading' | 'ready' | 'error'
	waveformState: 'idle' | 'loading' | 'ready' | 'error'
}

interface TeamAudioRow {
	steamId: string
	playerName: string
	track: TeamAudioTrack | null
}

export default function TeamCommsModal({ isOpen, onClose, demoPath, teamName, players }: TeamCommsModalProps) {
	const [state, setState] = useState<ExtractionState>('idle')
	const [error, setError] = useState<string | null>(null)
	const [logs, setLogs] = useState<string[]>([])
	const [tracks, setTracks] = useState<TeamAudioTrack[]>([])
	const [isPlaying, setIsPlaying] = useState(false)
	const [currentTime, setCurrentTime] = useState(0)
	const [duration, setDuration] = useState(0)
	const [playbackRate, setPlaybackRate] = useState(1)
	const [speakingMap, setSpeakingMap] = useState<Record<string, boolean>>({})
	const [displayWidth, setDisplayWidth] = useState(0)

	const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
	const audioContextRef = useRef<AudioContext | null>(null)
	const analyserMapRef = useRef<Map<string, AnalyserNode>>(new Map())
	const gainNodeMapRef = useRef<Map<string, GainNode | null>>(new Map())
	const sourceMapRef = useRef<Map<string, MediaElementAudioSourceNode>>(new Map())
	const rafRef = useRef<number | null>(null)
	const waveformRafRef = useRef<number | null>(null)
	const speakingStateRef = useRef<Record<string, boolean>>({})
	const waveformContainerRef = useRef<HTMLDivElement | null>(null)
	const trackCanvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({})
	const playheadAnchorTrackRef = useRef<string | null>(null)
	const waveformSessionRef = useRef(0)
	const pendingWaveformsRef = useRef<Set<string>>(new Set())
	const playRefRef = useRef<{ audioTime: number; perfTime: number; rate: number } | null>(null)
	const currentTimeRef = useRef(0)
	const tracksRef = useRef<TeamAudioTrack[]>([])
	const pendingSeekRef = useRef<number | null>(null)
	const playPendingRef = useRef(false)
	const outputPathRef = useRef<string | null>(null)
	const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null)
	const skipSeconds = 5

	const trackBySteamId = useMemo(() => {
		const map: Record<string, TeamAudioTrack> = {}
		tracks.forEach(track => {
			map[track.steamId] = track
		})
		return map
	}, [tracks])

	const playerRows = useMemo<TeamAudioRow[]>(() => {
		return players.map((player) => ({
			steamId: player.steamId,
			playerName: player.name || player.steamId,
			track: trackBySteamId[player.steamId] ?? null,
		}))
	}, [players, trackBySteamId])
	const playersKey = useMemo(
		() => players.map((player) => `${player.steamId}:${player.name}`).join('|'),
		[players],
	)

	const trackGraphKey = useMemo(() => tracks.map((track) => track.steamId).join('|'), [tracks])
	const gainKey = useMemo(
		() => tracks.map((track) => `${track.steamId}:${track.muted ? 1 : 0}:${track.volume}`).join('|'),
		[tracks],
	)
	const waveformLoadKey = useMemo(
		() => tracks.map((track) => `${track.steamId}:${track.loadState}:${track.waveformState}:${track.numBars}:${track.duration ?? 'null'}`).join('|'),
		[tracks],
	)

	const playheadAnchorSteamId = useMemo(() => {
		const anchor = tracks.reduce<TeamAudioTrack | null>((best, track) => {
			if (track.loadState === 'error' || track.duration == null) return best
			if (!best || track.duration > (best.duration ?? 0)) {
				return track
			}
			return best
		}, null)
		return anchor?.steamId ?? tracks[0]?.steamId ?? null
	}, [tracks])
	playheadAnchorTrackRef.current = playheadAnchorSteamId

	useEffect(() => {
		currentTimeRef.current = currentTime
	}, [currentTime])

	useEffect(() => {
		tracksRef.current = tracks
	}, [tracks])

	useEffect(() => {
		if (!isOpen) {
			const outputPath = outputPathRef.current
			outputPathRef.current = null
			waveformSessionRef.current += 1
			pendingWaveformsRef.current.clear()
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current)
				rafRef.current = null
			}
			if (waveformRafRef.current) {
				cancelAnimationFrame(waveformRafRef.current)
				waveformRafRef.current = null
			}
			Object.values(audioRefs.current).forEach((audio) => audio?.pause())
			audioRefs.current = {}
			analyserMapRef.current.clear()
			gainNodeMapRef.current.clear()
			sourceMapRef.current.clear()
			speakingStateRef.current = {}
			trackCanvasRefs.current = {}
			waveformContainerRef.current = null
			playheadAnchorTrackRef.current = null
			playRefRef.current = null
			currentTimeRef.current = 0
			pendingSeekRef.current = null
			playPendingRef.current = false
			setSeekPreviewTime(null)
			if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
				void audioContextRef.current.close().catch(() => {})
			}
			audioContextRef.current = null
			setState('idle')
			setError(null)
			setLogs([])
			setTracks([])
			setIsPlaying(false)
			setCurrentTime(0)
			setDuration(0)
			setPlaybackRate(1)
			setSpeakingMap({})
			setDisplayWidth(0)
			if (outputPath && window.electronAPI?.cleanupVoiceFiles) {
				void window.electronAPI.cleanupVoiceFiles(outputPath).catch((cleanupError) => {
					console.error('Failed to cleanup team voice files:', cleanupError)
				})
			}
			return
		}

		if (!demoPath || players.length === 0) {
			setState('error')
			setError('Demo path or team players not available.')
			return
		}

		let cancelled = false
		const startExtraction = async () => {
			try {
				setState('extracting')
				setError(null)
				setLogs([])

				const result = await window.electronAPI.extractVoice({
					demoPath,
					mode: 'split-full',
					steamIds: players.map(p => p.steamId),
				})

				if (cancelled) {
					if (result.outputPath && window.electronAPI?.cleanupVoiceFiles) {
						void window.electronAPI.cleanupVoiceFiles(result.outputPath).catch((cleanupError) => {
							console.error('Failed to cleanup cancelled team voice files:', cleanupError)
						})
					}
					return
				}

				outputPathRef.current = result.outputPath

				const filePaths = result.filePaths || result.files.map(f => `${result.outputPath}/${f}`)

				const resolvedTracks: TeamAudioTrack[] = []

				for (const filePath of filePaths) {
					const normalized = filePath.replace(/\\/g, '/')
					const matchedId = players.find(p => normalized.includes(p.steamId))?.steamId
					if (!matchedId) continue

					const playerName = players.find(p => p.steamId === matchedId)?.name || matchedId
					const audioData = await window.electronAPI.getVoiceAudio(normalized)
					if (!audioData.success || !audioData.data) continue

					resolvedTracks.push({
						steamId: matchedId,
						playerName,
						path: normalized,
						url: audioData.data,
						duration: null,
						volume: 1,
						muted: false,
						amplitudes: null,
						numBars: 0,
						loadState: 'loading',
						waveformState: 'idle',
					})
				}

				setTracks(resolvedTracks)
				setDuration(0)
				setState('ready')
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : 'Failed to extract team voice')
					setState('error')
				}
			}
		}

		startExtraction()

		return () => {
			cancelled = true
		}
	}, [isOpen, demoPath, playersKey])

	useEffect(() => {
		if (!window.electronAPI || state !== 'extracting') return

		const handleVoiceLog = (log: string) => {
			setLogs(prev => [...prev.slice(-50), log])
		}

		window.electronAPI.onVoiceExtractionLog(handleVoiceLog)

		return () => {
			window.electronAPI.removeAllListeners('voice:extractionLog')
		}
	}, [state])

	useEffect(() => {
		if (!isOpen || tracks.length === 0) return

		const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
		if (!AudioContextClass) return

		if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
			audioContextRef.current = new AudioContextClass()
		}

		const audioContext = audioContextRef.current

		tracks.forEach((track) => {
			const audioEl = audioRefs.current[track.steamId]
			if (!audioEl || sourceMapRef.current.has(track.steamId)) return

			const source = audioContext.createMediaElementSource(audioEl)
			const gainNode = audioContext.createGain()
			const analyser = audioContext.createAnalyser()
			analyser.fftSize = 1024
			gainNode.gain.value = track.muted ? 0 : track.volume

			source.connect(gainNode)
			gainNode.connect(analyser)
			analyser.connect(audioContext.destination)

			sourceMapRef.current.set(track.steamId, source)
			gainNodeMapRef.current.set(track.steamId, gainNode)
			analyserMapRef.current.set(track.steamId, analyser)
		})

		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current)
				rafRef.current = null
			}
			analyserMapRef.current.forEach((analyser) => {
				try {
					analyser.disconnect()
				} catch {}
			})
			gainNodeMapRef.current.forEach((gainNode) => {
				try {
					gainNode?.disconnect()
				} catch {}
			})
			sourceMapRef.current.forEach((source) => {
				try {
					source.disconnect()
				} catch {}
			})
			analyserMapRef.current.clear()
			gainNodeMapRef.current.clear()
			sourceMapRef.current.clear()
		}
	}, [isOpen, trackGraphKey])

	useEffect(() => {
		if (!isOpen || !isPlaying || analyserMapRef.current.size === 0) {
			speakingStateRef.current = {}
			setSpeakingMap((prev) => (Object.keys(prev).length === 0 ? prev : {}))
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current)
				rafRef.current = null
			}
			return
		}

		const dataArray = new Uint8Array(1024)
		const updateSpeaking = () => {
			const previous = speakingStateRef.current
			const speaking: Record<string, boolean> = {}
			let changed = false

			analyserMapRef.current.forEach((analyser, steamId) => {
				analyser.getByteTimeDomainData(dataArray)
				let sum = 0
				for (let i = 0; i < dataArray.length; i++) {
					const v = (dataArray[i] - 128) / 128
					sum += v * v
				}
				const rms = Math.sqrt(sum / dataArray.length)
				const prev = previous[steamId] || false
				const speakOn = 0.012
				const speakOff = 0.007
				const next = prev ? rms > speakOff : rms > speakOn
				speaking[steamId] = next
				if (next !== prev) {
					changed = true
				}
			})

			speakingStateRef.current = speaking
			if (changed) {
				setSpeakingMap({ ...speaking })
			}
			rafRef.current = requestAnimationFrame(updateSpeaking)
		}

		rafRef.current = requestAnimationFrame(updateSpeaking)

		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current)
				rafRef.current = null
			}
		}
	}, [isOpen, isPlaying, trackGraphKey])

	useEffect(() => {
		if (!isOpen) return

		const container = waveformContainerRef.current
		if (!container) {
			setDisplayWidth(0)
			return
		}

		const updateWidth = (width: number) => {
			const nextWidth = Math.round(width)
			if (nextWidth <= 0) return
			setDisplayWidth((prev) => (prev === nextWidth ? prev : nextWidth))
		}

		updateWidth(container.clientWidth)

		if (typeof ResizeObserver === 'undefined') return

		const observer = new ResizeObserver((entries) => {
			const nextWidth = entries[0]?.contentRect.width ?? container.clientWidth
			updateWidth(nextWidth)
		})

		observer.observe(container)

		return () => {
			observer.disconnect()
		}
	}, [isOpen, tracks.length])

	useEffect(() => {
		if (!isOpen || tracks.length === 0 || displayWidth <= 0) return

		const sessionId = waveformSessionRef.current
		const tracksToLoad = tracks
			.filter((track) => {
				if (track.loadState !== 'ready' || track.duration == null) return false
				const desiredBars = computeNumBars(track.duration, displayWidth)
				if (pendingWaveformsRef.current.has(track.steamId)) return false
				return (
					track.waveformState !== 'loading' &&
					(
						track.waveformState === 'idle' ||
						track.waveformState === 'error' ||
						track.numBars !== desiredBars ||
						(track.waveformState !== 'error' && track.amplitudes === null)
					)
				)
			})
			.map((track) => ({
				steamId: track.steamId,
				path: track.path,
				bars: computeNumBars(track.duration!, displayWidth),
			}))

		if (tracksToLoad.length === 0) return

		tracksToLoad.forEach((track) => {
			pendingWaveformsRef.current.add(track.steamId)
		})

		const loadMap = new Map(tracksToLoad.map((track) => [track.steamId, track]))

		setTracks((prev) => prev.map((track) => {
			const nextTrack = loadMap.get(track.steamId)
			if (!nextTrack) return track
			return {
				...track,
				numBars: nextTrack.bars,
				waveformState: 'loading',
			}
		}))

		void Promise.all(tracksToLoad.map(async (track) => {
			try {
				const result = await window.electronAPI.computeWaveformFromFile(track.path, track.bars)
				return { steamId: track.steamId, bars: track.bars, result }
			} catch (err) {
				return {
					steamId: track.steamId,
					bars: track.bars,
					result: {
						success: false,
						error: err instanceof Error ? err.message : 'Failed to compute waveform',
					},
				}
			}
		})).then((results) => {
			if (waveformSessionRef.current !== sessionId) return

			results.forEach((result) => {
				pendingWaveformsRef.current.delete(result.steamId)
			})

			const resultMap = new Map(results.map((result) => [result.steamId, result]))
			setTracks((prev) => prev.map((track) => {
				const nextResult = resultMap.get(track.steamId)
				if (!nextResult) return track
				if (!nextResult.result.success || !nextResult.result.amplitudes) {
					return {
						...track,
						amplitudes: null,
						numBars: nextResult.bars,
						waveformState: 'error',
					}
				}

				return {
					...track,
					duration: Number.isFinite(nextResult.result.duration) && (nextResult.result.duration ?? 0) > 0
						? nextResult.result.duration!
						: track.duration,
					amplitudes: new Float32Array(nextResult.result.amplitudes),
					numBars: nextResult.result.amplitudes.length,
					waveformState: 'ready',
				}
			}))
		})
	}, [isOpen, waveformLoadKey, displayWidth])

	const drawWaveformsAtTime = useCallback((time: number) => {
		if (!isOpen || state !== 'ready' || displayWidth <= 0 || duration <= 0) return

		tracksRef.current.forEach((track) => {
			const canvas = trackCanvasRefs.current[track.steamId]
			if (!canvas || !track.amplitudes || track.numBars === 0) return

			if (canvas.width !== displayWidth) canvas.width = displayWidth
			const nextHeight = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1))
			if (canvas.height !== nextHeight) canvas.height = nextHeight

			const { scrollX, playheadPx, playedBarIndex } = computeScrollState(
				time,
				duration,
				track.numBars,
				displayWidth,
			)

			drawWaveform(
				canvas,
				track.amplitudes,
				scrollX,
				playedBarIndex,
				playheadPx,
				displayWidth,
			)
		})
	}, [isOpen, state, displayWidth, duration])

	useEffect(() => {
		if (!isOpen || state !== 'ready' || displayWidth <= 0 || duration <= 0 || !isPlaying) return

		const draw = () => {
			let liveTime = currentTimeRef.current
			const playRef = playRefRef.current
			if (playRef) {
				const elapsed = (performance.now() - playRef.perfTime) / 1000
				liveTime = Math.min(duration, playRef.audioTime + elapsed * playRef.rate)
			}

			const previewTime = pendingSeekRef.current
			drawWaveformsAtTime(
				previewTime != null && Number.isFinite(previewTime)
					? Math.max(0, Math.min(previewTime, duration))
					: liveTime,
			)
			waveformRafRef.current = requestAnimationFrame(draw)
		}

		waveformRafRef.current = requestAnimationFrame(draw)

		return () => {
			if (waveformRafRef.current) {
				cancelAnimationFrame(waveformRafRef.current)
				waveformRafRef.current = null
			}
		}
	}, [isOpen, state, displayWidth, duration, isPlaying, drawWaveformsAtTime])

	useEffect(() => {
		if (!isOpen || state !== 'ready' || isPlaying) return
		const previewTime = seekPreviewTime
		drawWaveformsAtTime(
			previewTime != null && Number.isFinite(previewTime)
				? Math.max(0, Math.min(previewTime, duration || previewTime))
				: currentTimeRef.current,
		)
	}, [isOpen, state, isPlaying, currentTime, seekPreviewTime, duration, waveformLoadKey, drawWaveformsAtTime])

	const syncPlayheadFromAnchor = () => {
		const anchorSteamId = playheadAnchorTrackRef.current
		const anchor = anchorSteamId ? audioRefs.current[anchorSteamId] : null
		if (!anchor) return

		const nextTime = Math.max(0, anchor.currentTime || 0)
		setCurrentTime(nextTime)
		playRefRef.current = anchor.paused
			? null
			: {
				audioTime: nextTime,
				perfTime: performance.now(),
				rate: anchor.playbackRate,
			}
	}

	const syncPlayingState = () => {
		const audios = Object.values(audioRefs.current).filter((audio): audio is HTMLAudioElement => !!audio)
		const anyPlaying = audios.some((audio) => !audio.paused && !audio.ended)
		setIsPlaying(anyPlaying)
		if (!anyPlaying) {
			playRefRef.current = null
		}
	}

	const syncAllTracks = (time: number) => {
		const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0
		Object.values(audioRefs.current).forEach((audio) => {
			if (!audio) return
			const audioDuration = Number.isFinite(audio.duration) ? audio.duration : safeTime
			const nextTime = Math.max(0, Math.min(safeTime, audioDuration || safeTime))
			audio.currentTime = nextTime
			audio.defaultPlaybackRate = playbackRate
			audio.playbackRate = playbackRate
		})
		const safeDuration = Number.isFinite(duration) ? duration : safeTime
		setCurrentTime(Math.max(0, Math.min(safeTime, safeDuration || safeTime)))
		playRefRef.current = playRefRef.current
			? {
				audioTime: Math.max(0, Math.min(safeTime, safeDuration || safeTime)),
				perfTime: performance.now(),
				rate: playbackRate,
			}
			: null
	}

	const handlePlay = async () => {
		if (duration <= 0 || playPendingRef.current) return
		playPendingRef.current = true
		setIsPlaying(true)
		const targetTime = currentTimeRef.current

		try {
			if (audioContextRef.current?.state === 'suspended') {
				await audioContextRef.current.resume()
			}

			Object.values(audioRefs.current).forEach((audio) => {
				if (!audio) return
				audio.currentTime = Math.max(0, Math.min(targetTime, audio.duration || targetTime))
				audio.defaultPlaybackRate = playbackRate
				audio.playbackRate = playbackRate
			})

			void Promise.allSettled(
				Object.values(audioRefs.current).map(async (audio) => {
					if (!audio) return
					await audio.play()
				}),
			).finally(() => {
				playPendingRef.current = false
				syncPlayheadFromAnchor()
				syncPlayingState()
			})
		} catch {
			playPendingRef.current = false
			setIsPlaying(false)
		}
	}

	const handlePause = () => {
		Object.values(audioRefs.current).forEach((audio) => audio?.pause())
		setIsPlaying(false)
		playRefRef.current = null
	}

	const handleTimeUpdate = () => {
		syncPlayheadFromAnchor()
	}

	const handleLoadedMetadata = (steamId: string, audioDuration: number) => {
		const safeDuration = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : 0
		const audio = audioRefs.current[steamId]
		if (audio) {
			audio.defaultPlaybackRate = playbackRate
			audio.playbackRate = playbackRate
			if (currentTimeRef.current > 0 && safeDuration > 0) {
				audio.currentTime = Math.min(currentTimeRef.current, safeDuration)
			}
		}

		setTracks((prev) => prev.map((track) => (
			track.steamId === steamId
				? { ...track, duration: safeDuration, loadState: 'ready' }
				: track
		)))
	}

	const handleAudioError = (steamId: string) => {
		setTracks((prev) => prev.map((track) => (
			track.steamId === steamId
				? { ...track, duration: 0, loadState: 'error' }
				: track
		)))
	}

	const handleSeek = (value: number) => {
		pendingSeekRef.current = null
		setSeekPreviewTime(null)
		syncAllTracks(value)
	}

	const handleSkipBackward = () => {
		if (duration <= 0) return
		handleSeek(Math.max(0, currentTimeRef.current - skipSeconds))
	}

	const handleSkipForward = () => {
		if (duration <= 0) return
		handleSeek(Math.min(duration, currentTimeRef.current + skipSeconds))
	}

	const commitPendingSeek = () => {
		if (pendingSeekRef.current == null) return
		handleSeek(pendingSeekRef.current)
	}

	const handleAnchorPlayState = () => {
		syncPlayheadFromAnchor()
		syncPlayingState()
	}

	const handleAnchorSeeked = () => {
		syncPlayheadFromAnchor()
	}

	const handleTrackEnded = (steamId: string) => {
		if (steamId === playheadAnchorTrackRef.current) {
			Object.entries(audioRefs.current).forEach(([trackSteamId, audio]) => {
				if (!audio) return
				audio.pause()
				if (trackSteamId === steamId) {
					audio.load()
					return
				}
				try {
					audio.currentTime = 0
				} catch {
					// Ignore non-anchor reset failures; the anchor reload is the critical seekability reset.
				}
			})
			pendingSeekRef.current = null
			setSeekPreviewTime(null)
			setCurrentTime(0)
			playRefRef.current = null
			setIsPlaying(false)
			return
		}
		syncPlayingState()
	}

	useEffect(() => {
		if (!isOpen) return

		Object.values(audioRefs.current).forEach((audio) => {
			if (audio) {
				audio.defaultPlaybackRate = playbackRate
				audio.playbackRate = playbackRate
			}
		})

		if (playRefRef.current) {
			const anchorSteamId = playheadAnchorTrackRef.current
			const anchor = anchorSteamId ? audioRefs.current[anchorSteamId] : null
			if (anchor && !anchor.paused) {
				playRefRef.current = {
					audioTime: anchor.currentTime,
					perfTime: performance.now(),
					rate: anchor.playbackRate,
				}
			}
		}
	}, [isOpen, playbackRate, trackGraphKey])

	useEffect(() => {
		const audioContext = audioContextRef.current
		if (!audioContext) return

		tracks.forEach((track) => {
			const gainNode = gainNodeMapRef.current.get(track.steamId)
			if (!gainNode) return

			const nextGain = track.muted ? 0 : Math.max(0, Math.min(2, track.volume))
			try {
				gainNode.gain.cancelScheduledValues(audioContext.currentTime)
				gainNode.gain.setValueAtTime(nextGain, audioContext.currentTime)
			} catch {
				gainNode.gain.value = nextGain
			}
		})
	}, [gainKey])

	useEffect(() => {
		const maxDuration = tracks.reduce((max, track) => {
			if (track.loadState === 'error' || track.duration == null || !Number.isFinite(track.duration)) return max
			return Math.max(max, track.duration)
		}, 0)

		setDuration(maxDuration)
	}, [tracks])

	// Waveforms are loaded after extraction and recalculated when the lane width changes.

	const updateTrackVolume = (steamId: string, volume: number) => {
		const nextVolume = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1
		setTracks((prev) => prev.map((track) => (
			track.steamId === steamId
				? { ...track, volume: nextVolume }
				: track
		)))
	}

	const updateTrackMuted = (steamId: string, muted: boolean) => {
		setTracks((prev) => prev.map((track) => (
			track.steamId === steamId
				? { ...track, muted }
				: track
		)))
	}

	const formatTime = (time: number) => {
		if (!Number.isFinite(time) || time < 0) return '0:00'
		const minutes = Math.floor(time / 60)
		const seconds = Math.floor(time % 60)
		return `${minutes}:${seconds.toString().padStart(2, '0')}`
	}

	const getSliderBackground = (value: number, min: number, max: number) => {
		const percent = max > min ? ((value - min) / (max - min)) * 100 : 0
		return `linear-gradient(to right, #d07a2d ${percent}%, #36393e ${percent}%)`
	}

	const handleWaveformSeek = (steamId: string, clientX: number, laneElement: HTMLDivElement) => {
		const track = trackBySteamId[steamId]
		if (!track || !track.amplitudes || track.numBars === 0 || !Number.isFinite(duration) || duration <= 0) return

		const rect = laneElement.getBoundingClientRect()
		const canvasX = clientX - rect.left
		const liveTime = playRefRef.current
			? Math.min(
				duration,
				playRefRef.current.audioTime + ((performance.now() - playRefRef.current.perfTime) / 1000) * playRefRef.current.rate,
			)
			: currentTime
		const { scrollX } = computeScrollState(liveTime, duration, track.numBars, displayWidth)
		const nextTime = canvasXToTime(canvasX, scrollX, track.numBars, duration)
		if (!Number.isFinite(nextTime)) return
		handleSeek(nextTime)
	}

	const displayedTime = seekPreviewTime != null && Number.isFinite(seekPreviewTime)
		? Math.max(0, Math.min(seekPreviewTime, duration || seekPreviewTime))
		: currentTime

	if (!isOpen) return null

	return (
		<Modal isOpen={isOpen} onClose={onClose} title={`Team Voice - ${teamName}`} size="xl">
			<div className="p-6">
				{state === 'extracting' && (
					<div className="space-y-3">
						<div className="flex items-center gap-2 text-gray-300">
							<Loader2 className="animate-spin" size={16} />
							<span>Extracting team voice...</span>
						</div>
						<div className="bg-surface border border-border rounded p-3 max-h-40 overflow-auto text-xs text-gray-400">
							{logs.length === 0 ? 'Waiting for extractor...' : logs.map((log, idx) => (
								<div key={idx}>{log}</div>
							))}
						</div>
					</div>
				)}

				{state === 'error' && (
					<div className="bg-red-900/20 border border-red-500/50 rounded p-3 text-red-400">
						{error || 'Failed to extract team voice'}
					</div>
				)}

				{state === 'ready' && (
					<div className="space-y-4">
						{tracks.some(track => track.loadState === 'loading' || track.waveformState === 'loading') && (
							<div className="flex items-center gap-2 text-gray-300 text-sm">
								<Loader2 className="animate-spin" size={16} />
								<span>Loading team audio...</span>
							</div>
						)}

						{tracks.length === 0 && (
							<div className="bg-blue-900/20 border border-blue-500/50 rounded p-3 text-blue-300 text-sm">
								No extracted team comms were found. Players without audio still appear below for comparison.
							</div>
						)}

						<div className="grid grid-cols-[240px_minmax(0,1fr)] gap-x-4 gap-y-3 items-center">
							<div className="flex items-center gap-3">
								<button
									onClick={handleSkipBackward}
									disabled={duration <= 0}
									className="px-2 py-2 bg-secondary text-gray-200 rounded hover:bg-surface transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
									aria-label={`Skip backward ${skipSeconds}s`}
									title={`Skip backward ${skipSeconds}s`}
								>
									-{skipSeconds}s
								</button>
								<button
									onClick={isPlaying ? handlePause : handlePlay}
									disabled={duration <= 0}
									className="px-3 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
								>
									{isPlaying ? <Pause size={16} /> : <Play size={16} />}
									<span>{isPlaying ? 'Pause' : 'Play'}</span>
								</button>
								<button
									onClick={handleSkipForward}
									disabled={duration <= 0}
									className="px-2 py-2 bg-secondary text-gray-200 rounded hover:bg-surface transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
									aria-label={`Skip forward ${skipSeconds}s`}
									title={`Skip forward ${skipSeconds}s`}
								>
									+{skipSeconds}s
								</button>
							</div>

							<div className="flex items-center justify-end gap-3">
								<div className="flex items-center gap-1 text-xs text-gray-400 uppercase tracking-wide">
									<Gauge size={14} />
									<span>{playbackRate.toFixed(1)}x</span>
								</div>
								<input
									type="range"
									min={0.5}
									max={2}
									step={0.1}
									value={playbackRate}
									onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
									className="w-40 h-1.5 rounded-lg appearance-none cursor-pointer accent-accent"
									style={{ background: getSliderBackground(playbackRate, 0.5, 2) }}
								/>
							</div>

							<div ref={waveformContainerRef} className="space-y-1 col-span-2">
								<div className="flex justify-between text-xs text-gray-500 font-mono">
									<span>{formatTime(displayedTime)}</span>
									<span>{formatTime(duration)}</span>
								</div>
								<input
									type="range"
									min={0}
									max={duration || 0}
									step={0.01}
									value={Math.min(seekPreviewTime ?? currentTime, duration || 0)}
									disabled={duration <= 0}
									onInput={(e) => {
										const nextTime = parseFloat((e.target as HTMLInputElement).value)
										pendingSeekRef.current = nextTime
										syncAllTracks(nextTime)
										setSeekPreviewTime(nextTime)
									}}
									onChange={() => {}}
									onMouseUp={commitPendingSeek}
									onTouchEnd={commitPendingSeek}
									onKeyUp={commitPendingSeek}
									onBlur={commitPendingSeek}
									className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-accent border border-border disabled:cursor-not-allowed disabled:opacity-50"
									style={{ background: getSliderBackground(Math.min(displayedTime, duration || 0), 0, duration || 1) }}
								/>
							</div>

							{playerRows.map((row) => {
								const track = row.track
								const speaking = speakingMap[row.steamId]
								const hasAudio = !!track && track.loadState !== 'error'
								const controlsDisabled = !hasAudio
								const statusLabel = !track || track.loadState === 'error'
									? 'No audio'
									: track.loadState === 'loading'
										? 'Loading audio'
										: speaking
											? 'Speaking'
											: 'Silent'

								return (
									<div key={row.steamId} className="col-span-2 grid grid-cols-[240px_minmax(0,1fr)] items-stretch overflow-hidden rounded border border-border bg-surface/50">
										<div
											className="border-r border-border px-3 py-3 space-y-2"
										>
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2 min-w-0">
													<Mic size={14} className={speaking ? 'text-green-400' : hasAudio ? 'text-gray-500' : 'text-red-400'} />
													<span className="text-sm text-white truncate">{row.playerName}</span>
												</div>
												<span className={`text-xs whitespace-nowrap ${speaking ? 'text-green-400' : hasAudio ? 'text-gray-400' : 'text-red-400'}`}>
													{statusLabel}
												</span>
											</div>

											<div className="flex items-center gap-2">
												<button
													type="button"
													disabled={controlsDisabled}
													onClick={() => track && updateTrackMuted(track.steamId, !track.muted)}
													aria-label={track?.muted ? `Unmute ${row.playerName}` : `Mute ${row.playerName}`}
													className="flex h-8 w-8 items-center justify-center rounded border border-border bg-secondary text-gray-200 hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
												>
													{track?.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
												</button>
												<div className="flex items-center gap-2 flex-1">
													<span className={`text-[11px] font-mono ${controlsDisabled ? 'text-gray-600' : 'text-gray-400'}`}>
														{Math.round((track?.volume ?? 1) * 100)}%
													</span>
													<input
														type="range"
														min={0}
														max={2}
														step={0.05}
														value={track?.volume ?? 1}
														disabled={controlsDisabled}
														onChange={(e) => track && updateTrackVolume(track.steamId, parseFloat(e.target.value))}
														className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
														style={{ background: getSliderBackground(track?.volume ?? 1, 0, 2) }}
													/>
												</div>
											</div>
										</div>

										<div
											className={`relative self-stretch overflow-hidden ${hasAudio ? 'bg-secondary' : 'bg-secondary/40'}`}
											onClick={(e) => {
												if (!track || track.waveformState !== 'ready') return
												handleWaveformSeek(track.steamId, e.clientX, e.currentTarget)
											}}
										>
											{!hasAudio ? (
												<div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">
													No audio available
												</div>
											) : track.waveformState === 'idle' || track.waveformState === 'loading' || track.loadState === 'loading' ? (
												<div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 gap-2">
													<Loader2 size={14} className="animate-spin" />
													<span>Loading waveform...</span>
												</div>
											) : track.waveformState === 'error' || !track.amplitudes ? (
												<div className="absolute inset-0 flex items-center justify-center text-xs text-red-300">
													Waveform unavailable
												</div>
											) : (
												<canvas
													ref={(el) => { trackCanvasRefs.current[row.steamId] = el }}
													width={1}
													height={64}
													style={{ display: 'block', width: '100%', height: '100%', cursor: 'pointer', position: 'absolute', inset: 0 }}
												/>
											)}
										</div>
									</div>
								)
							})}
						</div>

						<div className="hidden">
							{tracks.map((track) => (
								<audio
									key={track.steamId}
									ref={(el) => { audioRefs.current[track.steamId] = el }}
									src={track.url}
									preload="auto"
									data-track-path={track.path}
									onTimeUpdate={track.steamId === playheadAnchorSteamId ? handleTimeUpdate : undefined}
									onPlay={track.steamId === playheadAnchorSteamId ? handleAnchorPlayState : undefined}
									onPause={track.steamId === playheadAnchorSteamId ? handleAnchorPlayState : undefined}
									onSeeked={track.steamId === playheadAnchorSteamId ? handleAnchorSeeked : undefined}
									onEnded={() => handleTrackEnded(track.steamId)}
									onLoadedMetadata={(e) => handleLoadedMetadata(track.steamId, (e.currentTarget as HTMLAudioElement).duration)}
									onError={() => handleAudioError(track.steamId)}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</Modal>
	)
}
