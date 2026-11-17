import { useMemo, useRef, useState } from 'react'
import { mmss } from './radarMath'
import { TICKRATE, TEAM_COLORS, type MatchEvent, type Round } from './types'

type Props = {
  rounds: Round[]
  minTick: number
  maxTick: number
  tick: number
  events: MatchEvent[]
  onSeek: (tick: number) => void
  onScrubChange?: (scrubbing: boolean) => void
}

const PIP_COLORS: Record<string, string> = {
  team_kill: '#ff4d5e',
  team_damage: '#ff9a3d',
  team_flash: '#ffe066',
}

const EVENT_NAMES: Record<string, string> = {
  team_kill: 'Team kill',
  team_damage: 'Team damage',
  team_flash: 'Team flash',
}

function eventName(type: string): string {
  return EVENT_NAMES[type] ?? type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** The match as a ribbon of rounds, each as wide as it lasted and tinted by who won it. */
export function Timeline({ rounds, minTick, maxTick, tick, events, onSeek, onScrubChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; tick: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const span = Math.max(1, maxTick - minTick)
  const pct = (t: number) => ((t - minTick) / span) * 100

  const segments = rounds.length > 0 ? rounds : [{ roundIndex: 0, startTick: minTick, endTick: maxTick } as Round]
  const current = segments.find((r) => tick >= r.startTick && tick <= r.endTick)

  const pips = useMemo(
    () =>
      events
        .filter((e) => e.startTick >= minTick && e.startTick <= maxTick)
        .sort((a, b) => a.startTick - b.startTick),
    [events, minTick, maxTick],
  )

  const tickFromClient = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect()
    if (!r) return tick
    const k = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)))
    return Math.round(minTick + k * span)
  }

  const roundLabel = (t: number) => {
    const r = segments.find((x) => t >= x.startTick && t <= x.endTick)
    if (!r) return mmss((t - minTick) / TICKRATE)
    const live = r.freezeEndTick || r.startTick
    const clock = t < live ? `freeze ${mmss((live - t) / TICKRATE)}` : mmss((t - live) / TICKRATE)
    return `R${r.roundIndex + 1} · ${clock}`
  }

  return (
    <div className="select-none">
      <div
        ref={barRef}
        className="relative h-10 cursor-pointer touch-none"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).dataset.pip) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setScrubbing(true)
          onScrubChange?.(true)
          onSeek(tickFromClient(e.clientX))
        }}
        onPointerMove={(e) => {
          const t = tickFromClient(e.clientX)
          const r = barRef.current!.getBoundingClientRect()
          setHover({ x: e.clientX - r.left, tick: t })
          if (scrubbing) onSeek(t)
        }}
        onPointerUp={() => {
          if (scrubbing) onScrubChange?.(false)
          setScrubbing(false)
        }}
        onPointerLeave={() => !scrubbing && setHover(null)}
      >
        {/* round segments */}
        <div className="absolute inset-x-0 top-0 h-7">
          {segments.map((r) => {
            const left = pct(r.startTick)
            const width = Math.max(0.15, pct(r.endTick) - left)
            const isCur = r === current
            const won = r.winner === 'T' ? TEAM_COLORS.T : r.winner === 'CT' ? TEAM_COLORS.CT : null
            const freeze = r.freezeEndTick && r.freezeEndTick > r.startTick ? ((r.freezeEndTick - r.startTick) / Math.max(1, r.endTick - r.startTick)) * 100 : 0
            return (
              <div
                key={r.roundIndex}
                className={`absolute top-0 h-full overflow-hidden rounded-[3px] transition-[filter] ${isCur ? 'ring-1 ring-white/60' : 'hover:brightness-125'}`}
                style={{
                  left: `calc(${left}% + 1px)`,
                  width: `calc(${width}% - 2px)`,
                  background: won ? `${won}${isCur ? '55' : '2e'}` : isCur ? '#ffffff26' : '#ffffff12',
                }}
              >
                {freeze > 0 && (
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${freeze}%`,
                      background: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.35) 0 3px, transparent 3px 6px)',
                    }}
                  />
                )}
                {won && <div className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: won }} />}
                <span
                  className={`pointer-events-none absolute left-1 top-1 font-mono text-[10px] leading-none ${isCur ? 'font-bold text-white' : 'text-gray-400'}`}
                >
                  {r.roundIndex + 1}
                </span>
              </div>
            )
          })}
        </div>

        {/* event pips */}
        <div className="absolute inset-x-0 bottom-0 h-2.5">
          {pips.map((e, i) => (
            <button
              key={`${e.type}-${e.startTick}-${i}`}
              type="button"
              data-pip="1"
              title={`${eventName(e.type)} · ${roundLabel(e.startTick)}`}
              onClick={() => onSeek(Math.max(minTick, e.startTick - 3 * TICKRATE))}
              className="absolute top-0 h-2.5 w-1.5 -translate-x-1/2 rounded-sm hover:scale-150"
              style={{ left: `${pct(e.startTick)}%`, background: PIP_COLORS[e.type?.toLowerCase()] ?? '#9aa0a8' }}
            />
          ))}
        </div>

        {/* playhead */}
        <div className="pointer-events-none absolute -top-1 bottom-2.5 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" style={{ left: `${pct(tick)}%` }}>
          <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-white" />
        </div>

        {/* hover readout */}
        {hover && (
          <div
            className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-gray-200"
            style={{ left: hover.x }}
          >
            {roundLabel(hover.tick)}
          </div>
        )}
      </div>
    </div>
  )
}
