import { Clock, Skull, Zap, WifiOff } from 'lucide-react'
import { t } from '../../utils/translations'

// Custom dollar sign icon for economy griefing
const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

// Custom body block icon for head stacking
const BodyBlockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    {/* Player left */}
    <circle cx="42" cy="34" r="10" fill="#FF9800"/>
    <rect x="30" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    {/* Player right */}
    <circle cx="86" cy="34" r="10" fill="#FF9800"/>
    <rect x="74" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    {/* Impact bar (the block moment) */}
    <rect x="56" y="68" width="16" height="8" rx="4" fill="#FF5722"/>
  </svg>
)

interface Props {
  afkCount: number
  teamKillCount: number
  teamDamageTotal: number
  disconnectCount: number
  flashSeconds: number
  economyGriefCount: number
  bodyBlockCount: number
}

export default function StatSummaryCards({
  afkCount,
  teamKillCount,
  teamDamageTotal,
  disconnectCount,
  flashSeconds,
  economyGriefCount,
  bodyBlockCount,
}: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <Clock size={16} />
          <span className="text-sm font-medium">AFK Detections</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-white">{afkCount}</div>
        <div className="text-xs text-gray-500">No movement after freezetime</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <Skull size={16} />
          <span className="text-sm font-medium">Team Kills</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-red-400">{teamKillCount}</div>
        <div className="text-xs text-gray-500">Friendly fire kills</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <Zap size={16} />
          <span className="text-sm font-medium">{t('matches.sections.teamDamage')}</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-accent">{teamDamageTotal}</div>
        <div className="text-xs text-gray-500">{t('matches.friendlyFireDamage')}</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <WifiOff size={16} />
          <span className="text-sm font-medium">Disconnects</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-gray-400">{disconnectCount}</div>
        <div className="text-xs text-gray-500">Player disconnection events</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <Zap size={16} />
          <span className="text-sm font-medium">{t('matches.sections.teamFlashes')}</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-accent">{flashSeconds}</div>
        <div className="text-xs text-gray-500">{t('matches.friendlyFlashbangs')}</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <DollarIcon />
          <span className="text-sm font-medium">Economy Grief</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-yellow-400">{economyGriefCount}</div>
        <div className="text-xs text-gray-500">Poor buy decisions</div>
      </div>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-400">
          <BodyBlockIcon />
          <span className="text-sm font-medium">Body Block</span>
        </div>
        <div className="text-3xl font-bold mb-1 text-purple-400">{bodyBlockCount}</div>
        <div className="text-xs text-gray-500">Head stacking incidents</div>
      </div>
    </div>
  )
}
