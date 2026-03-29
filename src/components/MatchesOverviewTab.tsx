import { useState } from 'react'
import type { Round, PlayerScore, Player } from '../types/matches'
import StatSummaryCards from './overview/StatSummaryCards'
import AfkSection from './overview/AfkSection'
import DisconnectsSection from './overview/DisconnectsSection'
import TeamKillsSection from './overview/TeamKillsSection'
import TeamDamageSection from './overview/TeamDamageSection'
import TeamFlashesSection from './overview/TeamFlashesSection'
import EconomyGriefSection from './overview/EconomyGriefSection'
import BodyBlockSection from './overview/BodyBlockSection'

interface Props {
  allEvents: any[]
  allPlayers: Player[]
  scores: PlayerScore[]
  rounds: Round[]
  demoPath: string | null
  tickRate: number
  hasRadarForCurrentMap: boolean
  onSetViewer2D: (v: { roundIndex: number; tick: number } | null) => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onToast: (msg: { message: string; type?: 'success' | 'error' | 'info' }) => void
}

export default function MatchesOverviewTab({
  allEvents,
  allPlayers,
  scores,
  rounds,
  demoPath,
  tickRate,
  hasRadarForCurrentMap,
  onSetViewer2D,
  onWatchAtTick,
  onToast,
}: Props) {
  const [expandedSections, setExpandedSections] = useState({
    afk: true,
    teamKills: true,
    teamDamage: true,
    disconnects: true,
    teamFlashes: true,
    economy: true,
    bodyBlock: true,
  })
  const [afkMinSeconds, setAfkMinSeconds] = useState(10)
  const [flashMinSeconds, setFlashMinSeconds] = useState(1.5)
  const [afkSortBy, setAfkSortBy] = useState<'round' | 'duration'>('round')

  // Aggregate events by type
  const teamKills = allEvents.filter(e => e.type === 'TEAM_KILL')
  const teamDamage = allEvents.filter(e => e.type === 'TEAM_DAMAGE')
  const afkDetections = allEvents.filter(e => e.type === 'AFK_STILLNESS')
  const disconnects = allEvents.filter(e => e.type === 'DISCONNECT')
  const teamFlashes = allEvents.filter(e => e.type === 'TEAM_FLASH')
  const economyGriefs = allEvents.filter(e => e.type === 'ECONOMY_GRIEF')
  const bodyBlocks = allEvents.filter(e => e.type === 'BODY_BLOCK')

  const toggleSection = (key: keyof typeof expandedSections) =>
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="space-y-4">
      <StatSummaryCards
        afkCount={afkDetections.length}
        teamKillCount={teamKills.length}
        teamDamageCount={teamDamage.length}
        disconnectCount={disconnects.length}
        teamFlashCount={teamFlashes.length}
        economyGriefCount={economyGriefs.length}
        bodyBlockCount={bodyBlocks.length}
      />
      <AfkSection
        events={afkDetections}
        allPlayers={allPlayers}
        expanded={expandedSections.afk}
        minSeconds={afkMinSeconds}
        sortBy={afkSortBy}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('afk')}
        onMinSecondsChange={setAfkMinSeconds}
        onSortByChange={setAfkSortBy}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <DisconnectsSection
        events={disconnects}
        allPlayers={allPlayers}
        expanded={expandedSections.disconnects}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('disconnects')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <TeamKillsSection
        events={teamKills}
        allPlayers={allPlayers}
        expanded={expandedSections.teamKills}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('teamKills')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <TeamDamageSection
        events={teamDamage}
        allPlayers={allPlayers}
        expanded={expandedSections.teamDamage}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('teamDamage')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <TeamFlashesSection
        events={teamFlashes}
        allPlayers={allPlayers}
        expanded={expandedSections.teamFlashes}
        minSeconds={flashMinSeconds}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('teamFlashes')}
        onMinSecondsChange={setFlashMinSeconds}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <EconomyGriefSection
        events={economyGriefs}
        allPlayers={allPlayers}
        expanded={expandedSections.economy}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('economy')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
      <BodyBlockSection
        events={bodyBlocks}
        allPlayers={allPlayers}
        expanded={expandedSections.bodyBlock}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggleSection('bodyBlock')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={(v) => onSetViewer2D(v)}
      />
    </div>
  )
}
