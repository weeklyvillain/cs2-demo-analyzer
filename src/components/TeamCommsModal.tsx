import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, Loader2, Mic } from 'lucide-react'
import Modal from './Modal'

type ExtractionState = 'idle' | 'extracting' | 'ready' | 'error'

interface TeamCommsModalProps {
	isOpen: boolean
	onClose: () => void
	demoPath: string | null
	teamName: string
	players: Array<{ steamId: string; name: string }>
}

interface TeamAudioFile {
	steamId: string
	playerName: string
	path: string
	url: string
}

export default function TeamCommsModal({ isOpen, onClose, demoPath, teamName, players }: TeamCommsModalProps) {
	const [state, setState] = useState<ExtractionState>('idle')
	const [error, setError] = useState<string | null>(null)
	const [logs, setLogs] = useState<string[]>([])
	const [audioFiles, setAudioFiles] = useState<TeamAudioFile[]>([])
	const [isPlaying, setIsPlaying] = useState(false)
	const [currentTime, setCurrentTime] = useState(0)
	const [duration, setDuration] = useState(0)
	const [speakingMap, setSpeakingMap] = useState<Record<string, boolean>>({})
	const [durations, setDurations] = useState<Record<string, number>>({})

	const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
	const audioContextRef = useRef<AudioContext | null>(null)
	const analyserMapRef = useRef<Map<string, AnalyserNode>>(new Map())
	const sourceMapRef = useRef<Map<string, MediaElementAudioSourceNode>>(new Map())
	const rafRef = useRef<number | null>(null)
	const speakingStateRef = useRef<Record<string, boolean>>({})

	const audioBySteamId = useMemo(() => {
		const map: Record<string, TeamAudioFile> = {}
		audioFiles.forEach(file => {
			map[file.steamId] = file
		})
		return map
	}, [audioFiles])

	useEffect(() => {
		if (!isOpen) {
			setState('idle')
			setError(null)
			setLogs([])
			setAudioFiles([])
			setIsPlaying(false)
			setCurrentTime(0)
			setDuration(0)
			setSpeakingMap({})
			setDurations({})
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

				const filePaths = result.filePaths || result.files.map(f => `${result.outputPath}/${f}`)

				const resolvedFiles: TeamAudioFile[] = []
				const nextDurations: Record<string, number> = {}

				for (const filePath of filePaths) {
					const normalized = filePath.replace(/\\/g, '/')
					const matchedId = players.find(p => normalized.includes(p.steamId))?.steamId
					if (!matchedId) continue

					const playerName = players.find(p => p.steamId === matchedId)?.name || matchedId
					const audioData = await window.electronAPI.getVoiceAudio(normalized)
					if (!audioData.success || !audioData.data) continue

					resolvedFiles.push({
						steamId: matchedId,
						playerName,
						path: normalized,
						url: audioData.data,
					})
				}

				if (!cancelled) {
					setAudioFiles(resolvedFiles)
					setDurations(nextDurations)
					setDuration(0)
					setState('ready')
				}
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
	}, [isOpen, demoPath, players])

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
		if (!isOpen || audioFiles.length === 0) return

		const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
		if (!AudioContextClass) return

		if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
			audioContextRef.current = new AudioContextClass()
		}

		const audioContext = audioContextRef.current

		audioFiles.forEach((file) => {
			const audioEl = audioRefs.current[file.steamId]
			if (!audioEl || sourceMapRef.current.has(file.steamId)) return

			const source = audioContext.createMediaElementSource(audioEl)
			const analyser = audioContext.createAnalyser()
			analyser.fftSize = 1024

			source.connect(analyser)
			analyser.connect(audioContext.destination)

			sourceMapRef.current.set(file.steamId, source)
			analyserMapRef.current.set(file.steamId, analyser)
		})

		const dataArray = new Uint8Array(1024)
		const updateSpeaking = () => {
			const speaking: Record<string, boolean> = {}
			analyserMapRef.current.forEach((analyser, steamId) => {
				analyser.getByteTimeDomainData(dataArray)
				let sum = 0
				for (let i = 0; i < dataArray.length; i++) {
					const v = (dataArray[i] - 128) / 128
					sum += v * v
				}
				const rms = Math.sqrt(sum / dataArray.length)
				const prev = speakingStateRef.current[steamId] || false
				const speakOn = 0.012
				const speakOff = 0.007
				const next = prev ? rms > speakOff : rms > speakOn
				speaking[steamId] = next
			})
			speakingStateRef.current = speaking
			setSpeakingMap(speaking)
			rafRef.current = requestAnimationFrame(updateSpeaking)
		}

		rafRef.current = requestAnimationFrame(updateSpeaking)

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
			sourceMapRef.current.forEach((source) => {
				try {
					source.disconnect()
				} catch {}
			})
			analyserMapRef.current.clear()
			sourceMapRef.current.clear()
		}
	}, [isOpen, audioFiles])

	const handlePlay = async () => {
		if (audioContextRef.current?.state === 'suspended') {
			await audioContextRef.current.resume()
		}

		Object.values(audioRefs.current).forEach((audio) => {
			if (audio) {
				audio.currentTime = currentTime
			}
		})

		Object.values(audioRefs.current).forEach((audio) => {
			audio?.play().catch(() => {})
		})

		setIsPlaying(true)
	}

	const handlePause = () => {
		Object.values(audioRefs.current).forEach((audio) => audio?.pause())
		setIsPlaying(false)
	}

	const handleTimeUpdate = () => {
		const primary = audioFiles[0]?.steamId ? audioRefs.current[audioFiles[0].steamId] : null
		if (primary) {
			setCurrentTime(primary.currentTime)
		}
	}

	const handleLoadedMetadata = (steamId: string, audioDuration: number) => {
		setDurations((prev) => ({ ...prev, [steamId]: audioDuration }))
		if (audioFiles[0]?.steamId === steamId) {
			setDuration(audioDuration)
		}
	}

	const handleAudioError = (steamId: string) => {
		setDurations((prev) => ({ ...prev, [steamId]: 0 }))
	}

	const handleSeek = (value: number) => {
		Object.values(audioRefs.current).forEach((audio) => {
			if (audio) {
				audio.currentTime = value
			}
		})
		setCurrentTime(value)
	}

	// Waveforms are pre-generated during extraction to avoid delays on playback screen

	const formatTime = (time: number) => {
		if (!time || Number.isNaN(time)) return '0:00'
		const minutes = Math.floor(time / 60)
		const seconds = Math.floor(time % 60)
		return `${minutes}:${seconds.toString().padStart(2, '0')}`
	}

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
						{audioFiles.length === 0 || Object.keys(durations).length < audioFiles.length || duration <= 0 ? (
							<div className="flex items-center gap-2 text-gray-300">
								<Loader2 className="animate-spin" size={16} />
								<span>Loading audio...</span>
							</div>
						) : (
							<>
								<div className="flex items-center gap-3">
									<button
										onClick={isPlaying ? handlePause : handlePlay}
										className="px-3 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors flex items-center gap-2"
									>
										{isPlaying ? <Pause size={16} /> : <Play size={16} />}
										<span>{isPlaying ? 'Pause' : 'Play'}</span>
									</button>
									<div className="text-sm text-gray-400">
										{formatTime(currentTime)} / {formatTime(duration)}
									</div>
								</div>

								<input
									type="range"
									min={0}
									max={duration || 0}
									step={0.01}
									value={currentTime}
									onChange={(e) => handleSeek(parseFloat(e.target.value))}
									className="w-full accent-accent"
								/>
							</>
						)}

						<div className="grid grid-cols-2 gap-3">
							{players.map((player) => {
								const speaking = speakingMap[player.steamId]
								const hasAudio = !!audioBySteamId[player.steamId]

								return (
									<div key={player.steamId} className="bg-surface/50 border border-border rounded px-3 py-2 space-y-2">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-2">
												<Mic size={14} className={speaking ? 'text-green-400' : 'text-gray-500'} />
												<span className="text-sm text-white">{player.name || player.steamId}</span>
											</div>
											<span className={`text-xs ${speaking ? 'text-green-400' : hasAudio ? 'text-gray-400' : 'text-red-400'}`}>
												{speaking ? 'Speaking' : hasAudio ? 'Silent' : 'No audio'}
											</span>
										</div>
									</div>
								)
							})}
						</div>

						<div className="hidden">
							{audioFiles.map((file, idx) => (
								<audio
									key={file.steamId}
									ref={(el) => { audioRefs.current[file.steamId] = el }}
									src={file.url}
									onTimeUpdate={idx === 0 ? handleTimeUpdate : undefined}
									onLoadedMetadata={(e) => handleLoadedMetadata(file.steamId, (e.currentTarget as HTMLAudioElement).duration)}
									onError={() => handleAudioError(file.steamId)}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</Modal>
	)
}
