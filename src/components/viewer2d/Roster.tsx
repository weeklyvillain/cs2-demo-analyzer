import { Crosshair, Shield, Skull } from 'lucide-react'
import { TEAM_COLORS, weaponLabel, type PlayerFrame } from './types'

type Props = {
  team: 'T' | 'CT'
  players: PlayerFrame[]
  score: number
  selected: string | null
  hovered: string | null
  following: boolean
  side: 'left' | 'right'
  onSelect: (steamid: string | null) => void
  onHover: (steamid: string | null) => void
}

const TEAM_NAMES = { T: 'Terrorists', CT: 'Counter-Terrorists' } as const

function hpColor(hp: number): string {
  if (hp > 60) return '#5fd08a'
  if (hp > 30) return '#e8b04a'
  return '#ff4d5e'
}

/** One side's players: health, armour and what they're holding, live at the playhead. */
export function Roster({ team, players, score, selected, hovered, following, side, onSelect, onHover }: Props) {
  const color = TEAM_COLORS[team]
  const alive = players.filter((p) => p.alive).length
  const sorted = [...players].sort((a, b) => Number(b.alive) - Number(a.alive) || (a.name || a.steamid).localeCompare(b.name || b.steamid))

  return (
    <aside className={`flex w-60 flex-shrink-0 flex-col bg-[#1b1d21] ${side === 'left' ? 'border-r' : 'border-l'} border-white/[0.06]`}>
      <header className="relative px-3 pb-2.5 pt-3">
        <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: color }} />
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
              {team}
            </div>
            <div className="text-sm font-semibold text-gray-100">{TEAM_NAMES[team]}</div>
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-white">{score}</div>
        </div>
        <div className="mt-2 flex gap-1">
          {Array.from({ length: Math.max(5, players.length) }).map((_, i) => (
            <div key={i} className="h-1 flex-1 rounded-full" style={{ background: i < alive ? color : 'rgba(255,255,255,0.08)' }} />
          ))}
        </div>
      </header>

      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {sorted.map((p) => {
          const hp = Math.max(0, p.alive ? p.health ?? 100 : 0)
          const isSel = selected === p.steamid
          const isHov = hovered === p.steamid
          return (
            <li key={p.steamid}>
              <button
                type="button"
                onClick={() => onSelect(isSel ? null : p.steamid)}
                onMouseEnter={() => onHover(p.steamid)}
                onMouseLeave={() => onHover(null)}
                title={isSel ? 'Click to deselect' : 'Click to select and follow'}
                className={`group w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                  isSel ? 'bg-white/[0.09] ring-1 ring-white/25' : isHov ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                } ${p.alive ? '' : 'opacity-45'}`}
              >
                <div className="flex items-center gap-2">
                  {p.alive ? (
                    <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} />
                  ) : (
                    <Skull size={11} className="flex-shrink-0 text-gray-500" />
                  )}
                  <span className={`flex-1 truncate text-[13px] font-medium ${p.alive ? 'text-gray-100' : 'text-gray-400 line-through decoration-white/20'}`}>
                    {p.name || p.steamid}
                  </span>
                  {isSel && following && <Crosshair size={12} className="flex-shrink-0 text-white" />}
                  {p.alive && <span className="font-mono text-[11px] tabular-nums text-gray-300">{hp}</span>}
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${hp}%`, background: hpColor(hp) }} />
                </div>
                {p.alive && (
                  <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-gray-400">
                    <span className="flex items-center gap-0.5" title="Armour">
                      <Shield size={10} className={p.armor ? 'text-sky-300/80' : 'text-gray-600'} />
                      <span className="tabular-nums">{p.armor ?? 0}</span>
                    </span>
                    <span className="truncate font-mono tracking-tight text-gray-300" title={p.weapon ?? undefined}>
                      {weaponLabel(p.weapon)}
                    </span>
                  </div>
                )}
              </button>
            </li>
          )
        })}
        {players.length === 0 && <li className="px-2.5 py-6 text-center text-xs text-gray-500">No players yet</li>}
      </ul>
    </aside>
  )
}
