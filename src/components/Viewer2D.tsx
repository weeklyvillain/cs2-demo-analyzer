import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronFirst,
  ChevronLast,
  Crosshair,
  Keyboard,
  Layers as LayersIcon,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  X,
} from 'lucide-react'
import { MapCanvas, type MapCanvasHandle, type SceneInput } from './viewer2d/MapCanvas'
import { levelIndexAt, prettyMapName, radarMapFor } from './viewer2d/radarMaps'
import { useRadarArt, type RadarStyle } from './viewer2d/radarArt'
import { mmss, type MapBounds } from './viewer2d/radarMath'
import { useMatchReplay } from './viewer2d/useMatchReplay'
import { Roster } from './viewer2d/Roster'
import { Timeline } from './viewer2d/Timeline'
import { KillFeed, ScoreBug, phaseAt, scoreAt } from './viewer2d/Hud'
import { DEFAULT_LAYERS, GRENADE_COLORS, TEAM_COLORS, TICKRATE, type Layers, type Round } from './viewer2d/types'

interface Viewer2DProps {
  matchId: string
  roundIndex: number // -1 means full game (all rounds)
  initialTick: number
  roundStartTick: number
  roundEndTick: number
  mapName: string
  onClose: () => void
  isFullGame?: boolean
  allRounds?: Round[]
}

const SPEEDS = [0.5, 1, 2, 4, 8]
const SKIP_SECONDS = 5

const LAYER_LABELS: Record<keyof Layers, string> = {
  names: 'Player names',
  trails: 'Movement trails',
  utility: 'Grenades & utility',
  shots: 'Shot tracers',
  events: 'Grief event markers',
}

function Viewer2D({
  matchId,
  roundIndex,
  initialTick,
  roundStartTick,
  roundEndTick,
  mapName,
  onClose,
  isFullGame = false,
  allRounds = [],
}: Viewer2DProps) {
  const replay = useMatchReplay({ matchId, roundIndex, initialTick, roundStartTick, roundEndTick, isFullGame, allRounds })
  const { minTick, maxTick } = replay

  const [tick, setTick] = useState(initialTick)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [radarStyle, setRadarStyle] = useState<RadarStyle>('flat')
  const [selected, setSelected] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [levelChoice, setLevelChoice] = useState<'auto' | number>('auto')
  const [menu, setMenu] = useState<'layers' | 'help' | null>(null)
  const canvasRef = useRef<MapCanvasHandle>(null)

  const seek = useCallback((t: number) => setTick(Math.max(minTick, Math.min(maxTick, Math.round(t)))), [minTick, maxTick])

  // ---------- rounds ----------
  const singleRound: Round = useMemo(
    () => allRounds.find((r) => r.roundIndex === roundIndex) ?? { roundIndex: Math.max(0, roundIndex), startTick: roundStartTick, endTick: roundEndTick },
    [allRounds, roundIndex, roundStartTick, roundEndTick],
  )
  const timelineRounds = isFullGame && allRounds.length > 0 ? allRounds : [singleRound]
  const currentRound = (isFullGame ? replay.roundNear(tick) : singleRound) ?? singleRound
  const roundPos = timelineRounds.indexOf(currentRound)

  // keep the neighbouring rounds streamed in as the playhead moves
  const { ensureAround } = replay
  useEffect(() => {
    ensureAround(currentRound.startTick)
  }, [currentRound.startTick, ensureAround])

  // ---------- playback ----------
  const tickRef = useRef(tick)
  tickRef.current = tick
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    let carry = 0
    const step = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      carry += (TICKRATE * speed * dt) / 1000
      if (carry >= 1) {
        const n = Math.floor(carry)
        carry -= n
        const next = tickRef.current + n
        if (next >= maxTick) {
          setTick(maxTick)
          setPlaying(false)
          return
        }
        setTick(next)
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, maxTick])

  const togglePlay = useCallback(() => {
    if (!playing && tickRef.current >= maxTick) setTick(minTick)
    setPlaying((p) => !p)
  }, [playing, maxTick, minTick])

  const jumpRound = useCallback(
    (dir: -1 | 1) => {
      if (timelineRounds.length === 0) return
      const cur = timelineRounds[roundPos] ?? timelineRounds[0]
      const live = cur.freezeEndTick || cur.startTick
      // "previous" from well into a round restarts it, like a media player
      if (dir === -1 && tickRef.current - live > 2 * TICKRATE) {
        seek(cur.startTick)
        return
      }
      const target = timelineRounds[Math.max(0, Math.min(timelineRounds.length - 1, roundPos + dir))]
      seek(target.startTick)
    },
    [timelineRounds, roundPos, seek],
  )

  // ---------- players & map ----------
  const players = useMemo(() => replay.playersAt(tick), [replay, tick])
  const tPlayers = players.filter((p) => p.team === 'T')
  const ctPlayers = players.filter((p) => p.team === 'CT')

  const info = radarMapFor(mapName)
  const levels = info?.levels ?? []
  const selectedPlayer = selected ? players.find((p) => p.steamid === selected) : undefined
  const autoLevel = selectedPlayer && levels.length > 1 ? levelIndexAt(levels, selectedPlayer.z) : 0
  const shownLevel = levelChoice === 'auto' ? autoLevel : Math.min(levelChoice, Math.max(0, levels.length - 1))
  const loadedArt = useRadarArt(levels[shownLevel]?.image)
  // keep the last floor on screen while the next one loads, instead of flashing the grid
  const lastArtRef = useRef(loadedArt)
  if (loadedArt !== undefined) lastArtRef.current = loadedArt
  const art = loadedArt ?? lastArtRef.current
  const onLevel = useMemo(() => (levels.length < 2 ? () => true : (z: number) => levelIndexAt(levels, z) === shownLevel), [levels, shownLevel])

  // without a radar calibration, frame the players we've seen (once)
  const [fallbackBounds, setFallbackBounds] = useState<MapBounds | undefined>()
  useEffect(() => {
    if (info || fallbackBounds || players.length === 0) return
    const xs = players.map((p) => p.x)
    const ys = players.map((p) => p.y)
    const pad = 1500
    setFallbackBounds({ min: [Math.min(...xs) - pad, Math.min(...ys) - pad, 0], max: [Math.max(...xs) + pad, Math.max(...ys) + pad, 0] })
  }, [info, fallbackBounds, players])

  const sceneRef = useRef<SceneInput | null>(null)
  sceneRef.current = {
    info,
    art: art ? art[radarStyle] : null,
    tick,
    players,
    layers,
    selected,
    hovered,
    roundStart: isFullGame ? currentRound.startTick : roundStartTick,
    roundEnd: isFullGame ? currentRound.endTick : roundEndTick,
    replay,
    onLevel,
  }

  const select = useCallback((id: string | null) => {
    setSelected(id)
    setFollowing(id !== null)
  }, [])

  const nameOf = useCallback((id: string | null) => (id ? replay.roster.get(id)?.name ?? 'Unknown' : 'Unknown'), [replay.roster])
  const teamOf = useCallback((id: string | null) => (id ? replay.roster.get(id)?.team ?? null : null), [replay.roster])

  // ---------- keyboard ----------
  const isModal = !isFullGame
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (e.shiftKey) jumpRound(-1)
          else seek(tickRef.current - SKIP_SECONDS * TICKRATE)
          break
        case 'ArrowRight':
          e.preventDefault()
          if (e.shiftKey) jumpRound(1)
          else seek(tickRef.current + SKIP_SECONDS * TICKRATE)
          break
        case '+':
        case '=':
          canvasRef.current?.zoomBy(1.5)
          break
        case '-':
          canvasRef.current?.zoomBy(1 / 1.5)
          break
        case '0':
          setFollowing(false)
          canvasRef.current?.reset()
          break
        case '[':
          setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s)
          break
        case ']':
          setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)] ?? s)
          break
        case 'f':
        case 'F':
          if (selected) setFollowing((f) => !f)
          break
        case 'Escape':
          if (menu) setMenu(null)
          else if (selected) select(null)
          else if (isModal) onClose()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, jumpRound, seek, selected, select, menu, isModal, onClose])

  // ---------- derived HUD ----------
  const score = scoreAt(allRounds.length > 0 ? allRounds : timelineRounds, tick)
  const { phase, clock } = phaseAt(currentRound, tick)
  const roundNumber = currentRound.roundIndex + 1
  const totalRounds = isFullGame ? allRounds.length : 0
  const waiting = !replay.hasPositions && (replay.loading || replay.loadingRounds.size > 0)
  const streaming = replay.loadingRounds.size > 0

  const body = (
    <div className={`relative flex flex-col overflow-hidden bg-[#141619] text-gray-200 ${isModal ? 'h-[92vh] w-[94vw] rounded-xl border border-white/10 shadow-2xl' : 'min-h-0 flex-1'}`}>
      {/* top bar */}
      <div className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#1b1d21] px-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold text-white">{prettyMapName(mapName || 'Unknown map')}</span>
          <span className="font-mono text-[11px] text-gray-500">{mapName}</span>
        </div>
        <span className="h-4 w-px bg-white/10" />
        <span className="text-xs text-gray-400">
          Round <span className="font-semibold text-gray-100">{roundNumber}</span>
          {totalRounds > 0 && <span className="text-gray-500"> of {totalRounds}</span>}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            phase === 'freeze' ? 'bg-sky-400/15 text-sky-300' : phase === 'live' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-gray-400'
          }`}
        >
          {phase === 'freeze' ? 'Freeze time' : phase === 'live' ? 'Live' : 'Round over'}
        </span>
        {streaming && (
          <span className="flex items-center gap-1 text-[11px] text-gray-500">
            <Loader2 size={12} className="animate-spin" /> Loading rounds
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <HeaderButton active={menu === 'layers'} onClick={() => setMenu(menu === 'layers' ? null : 'layers')} title="Layers">
            <LayersIcon size={15} />
            <span>Layers</span>
          </HeaderButton>
          <HeaderButton active={menu === 'help'} onClick={() => setMenu(menu === 'help' ? null : 'help')} title="Shortcuts and legend">
            <Keyboard size={15} />
          </HeaderButton>
          {isModal && (
            <HeaderButton onClick={onClose} title="Close (Esc)">
              <X size={16} />
            </HeaderButton>
          )}
        </div>

        {menu === 'layers' && (
          <Popover onClose={() => setMenu(null)}>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Show</div>
            {(Object.keys(LAYER_LABELS) as (keyof Layers)[]).map((k) => (
              <label key={k} className="flex cursor-pointer items-center justify-between gap-6 rounded px-1 py-1.5 text-sm hover:bg-white/5">
                <span>{LAYER_LABELS[k]}</span>
                <Toggle on={layers[k]} onChange={(v) => setLayers((l) => ({ ...l, [k]: v }))} />
              </label>
            ))}
            <div className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Map style</div>
            <Segmented
              value={radarStyle}
              options={[
                { value: 'flat', label: 'Flat' },
                { value: 'original', label: 'Original radar' },
              ]}
              onChange={(v) => setRadarStyle(v as RadarStyle)}
            />
          </Popover>
        )}
        {menu === 'help' && (
          <Popover onClose={() => setMenu(null)} wide>
            <HelpContent />
          </Popover>
        )}
      </div>

      {/* main */}
      <div className="flex min-h-0 flex-1">
        <Roster team="T" side="left" players={tPlayers} score={score.t} selected={selected} hovered={hovered} following={following} onSelect={select} onHover={setHovered} />

        <div className="relative min-w-0 flex-1 bg-[radial-gradient(ellipse_at_center,#1d2024_0%,#121417_75%)]">
          <MapCanvas
            ref={canvasRef}
            sceneRef={sceneRef}
            info={info}
            fallbackBounds={fallbackBounds}
            follow={following ? selected : null}
            onSelect={select}
            onHover={setHovered}
            onManualCamera={() => setFollowing(false)}
          >
            <ScoreBug score={score} round={roundNumber} totalRounds={totalRounds} phase={phase} clock={clock} />
            <KillFeed events={replay.events} tick={tick} nameOf={nameOf} teamOf={teamOf} />

            {/* floors */}
            {levels.length > 1 && (
              <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-lg border border-white/10 bg-[#16181b]/85 p-1 shadow-lg backdrop-blur">
                <LevelButton active={levelChoice === 'auto'} onClick={() => setLevelChoice('auto')} title="Follow the selected player's floor">
                  Auto
                </LevelButton>
                {levels.map((l, i) => (
                  <LevelButton key={l.name} active={levelChoice !== 'auto' ? levelChoice === i : false} dim={levelChoice === 'auto' && shownLevel === i} onClick={() => setLevelChoice(i)}>
                    {l.name}
                  </LevelButton>
                ))}
              </div>
            )}

            {/* follow chip */}
            {selectedPlayer && (
              <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-white/10 bg-[#16181b]/90 py-1 pl-2.5 pr-1 text-xs shadow-lg backdrop-blur">
                <span className="h-2 w-2 rounded-full" style={{ background: selectedPlayer.team === 'T' ? TEAM_COLORS.T : TEAM_COLORS.CT }} />
                <span className="max-w-[160px] truncate font-medium text-white">{selectedPlayer.name}</span>
                <button
                  type="button"
                  onClick={() => setFollowing((f) => !f)}
                  title="Toggle camera follow (F)"
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${following ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  <Crosshair size={12} /> {following ? 'Following' : 'Follow'}
                </button>
                <button type="button" onClick={() => select(null)} title="Deselect (Esc)" className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-white">
                  <X size={13} />
                </button>
              </div>
            )}

            {waiting && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#121417]/70">
                <div className="flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 size={16} className="animate-spin" /> Loading positions…
                </div>
              </div>
            )}
            {!waiting && !replay.hasPositions && (
              <div className="absolute inset-0 z-30 flex items-center justify-center text-sm text-gray-500">No position data for this round</div>
            )}
          </MapCanvas>
        </div>

        <Roster team="CT" side="right" players={ctPlayers} score={score.ct} selected={selected} hovered={hovered} following={following} onSelect={select} onHover={setHovered} />
      </div>

      {/* transport */}
      <div className="flex-shrink-0 border-t border-white/[0.06] bg-[#1b1d21] px-4 pb-3 pt-2.5">
        <div className="mb-2.5 flex items-center gap-3">
          <div className="flex items-center gap-0.5">
            <TransportButton onClick={() => jumpRound(-1)} title="Previous round (Shift+←)">
              <ChevronFirst size={17} />
            </TransportButton>
            <TransportButton onClick={() => seek(tick - SKIP_SECONDS * TICKRATE)} title={`Back ${SKIP_SECONDS}s (←)`}>
              <RotateCcw size={15} />
            </TransportButton>
            <button
              type="button"
              onClick={togglePlay}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
              className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white shadow-md transition hover:brightness-110 active:scale-95"
            >
              {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="translate-x-px" />}
            </button>
            <TransportButton onClick={() => seek(tick + SKIP_SECONDS * TICKRATE)} title={`Forward ${SKIP_SECONDS}s (→)`}>
              <RotateCw size={15} />
            </TransportButton>
            <TransportButton onClick={() => jumpRound(1)} title="Next round (Shift+→)">
              <ChevronLast size={17} />
            </TransportButton>
          </div>

          <div className="font-mono text-xs tabular-nums text-gray-400">
            <span className="text-gray-100">{mmss((tick - minTick) / TICKRATE)}</span> / {mmss((maxTick - minTick) / TICKRATE)}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Speed</span>
            <Segmented value={String(speed)} options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))} onChange={(v) => setSpeed(Number(v))} />
          </div>
        </div>
        <Timeline rounds={timelineRounds} minTick={minTick} maxTick={maxTick} tick={tick} events={replay.events} onSeek={seek} />
      </div>
    </div>
  )

  if (!isModal) return body
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {body}
    </div>
  )
}

// ---------- small pieces ----------

function HeaderButton({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${active ? 'bg-white/15 text-white' : 'text-gray-400 hover:bg-white/[0.08] hover:text-white'}`}
    >
      {children}
    </button>
  )
}

function TransportButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="flex h-8 w-8 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-white/[0.08] hover:text-white">
      {children}
    </button>
  )
}

function LevelButton({ children, onClick, active, dim, title }: { children: React.ReactNode; onClick: () => void; active: boolean; dim?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md px-2.5 py-1 text-left text-[11px] font-medium transition-colors ${
        active ? 'bg-white/15 text-white' : dim ? 'text-gray-200 ring-1 ring-inset ring-white/15' : 'text-gray-400 hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function Segmented({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-md bg-black/30 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${value === o.value ? 'bg-white/15 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={(e) => {
        e.preventDefault()
        onChange(!on)
      }}
      className={`relative h-[18px] w-8 flex-shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-white/15'}`}
    >
      <span className={`absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[16px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function Popover({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div className={`absolute right-3 top-11 z-50 rounded-lg border border-white/10 bg-[#1f2226] p-3 text-gray-200 shadow-2xl ${wide ? 'w-[420px]' : 'w-72'}`}>{children}</div>
    </>
  )
}

function HelpContent() {
  const keys: [string, string][] = [
    ['Space', 'Play / pause'],
    ['← / →', `Back / forward ${SKIP_SECONDS}s`],
    ['Shift + ← / →', 'Previous / next round'],
    ['[ / ]', 'Slower / faster'],
    ['+ / − / 0', 'Zoom in / out / fit'],
    ['Click player', 'Select and follow'],
    ['F', 'Toggle follow'],
    ['Esc', 'Deselect / close'],
  ]
  const legend: [React.ReactNode, string][] = [
    [<Swatch key="t" color={TEAM_COLORS.T} />, 'Terrorist (points where they look)'],
    [<Swatch key="ct" color={TEAM_COLORS.CT} />, 'Counter-Terrorist'],
    [<span key="hp" className="inline-block h-3 w-3 rounded-full border-2 border-[#ff4d5e]" />, 'Inner ring: health (red at 30 or less)'],
    [<span key="d" className="text-xs font-bold text-gray-300">✕</span>, 'Dead player'],
    [<Swatch key="s" color={GRENADE_COLORS.smoke} />, 'Smoke (edge ring counts down)'],
    [<Swatch key="f" color={GRENADE_COLORS.fire} />, 'Molotov / incendiary'],
    [<Swatch key="h" color={GRENADE_COLORS.he} />, 'HE grenade'],
    [<Swatch key="fl" color={GRENADE_COLORS.flash} />, 'Flashbang'],
    [<Swatch key="dc" color={GRENADE_COLORS.decoy} />, 'Decoy'],
    [<span key="tk" className="rounded bg-[#ff4d5e] px-1 text-[9px] font-bold text-[#16181b]">TK</span>, 'Team kill / damage / flash marker'],
  ]
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Shortcuts</div>
        <dl className="space-y-1.5 text-xs">
          {keys.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <dt className="text-gray-400">{v}</dt>
              <dd>
                <kbd className="whitespace-nowrap rounded border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-gray-200">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Legend</div>
        <ul className="space-y-1.5 text-xs text-gray-400">
          {legend.map(([icon, label], i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="flex w-5 justify-center">{icon}</span>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block h-3 w-3 rounded-full" style={{ background: color }} />
}

export default Viewer2D
