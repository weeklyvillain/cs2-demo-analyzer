# MatchesScreen Component Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `MatchesScreen.tsx` (3,917 lines) into 15 focused components + 1 shared utility file with no behavior change.

**Architecture:** `MatchesScreen.tsx` stays as the single orchestrator holding all cross-cutting state and IPC logic. Each tab and overview section becomes its own file receiving only the props it needs. Tab-local state (chat filters, player sort, overview expansion) moves down into the relevant component.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide icons — no new dependencies.

---

## Files Created/Modified

| Action | File | Lines (approx) |
|---|---|---|
| Create | `src/types/matches.ts` | ~80 |
| Create | `src/utils/formatters.ts` | ~25 |
| Create | `src/components/overview/StatSummaryCards.tsx` | ~65 |
| Create | `src/components/overview/AfkSection.tsx` | ~165 |
| Create | `src/components/overview/DisconnectsSection.tsx` | ~105 |
| Create | `src/components/overview/TeamKillsSection.tsx` | ~70 |
| Create | `src/components/overview/TeamDamageSection.tsx` | ~115 |
| Create | `src/components/overview/TeamFlashesSection.tsx` | ~105 |
| Create | `src/components/overview/EconomyGriefSection.tsx` | ~240 |
| Create | `src/components/overview/BodyBlockSection.tsx` | ~80 |
| Create | `src/components/MatchesOverviewTab.tsx` | ~80 |
| Create | `src/components/MatchesRoundsTab.tsx` | ~170 |
| Create | `src/components/MatchesPlayersTab.tsx` | ~330 |
| Create | `src/components/MatchesChatTab.tsx` | ~145 |
| Create | `src/components/MatchesViewer2DTab.tsx` | ~30 |
| Create | `src/components/MatchListPanel.tsx` | ~410 |
| Create | `src/components/MatchDetailsHeader.tsx` | ~185 |
| Modify | `src/components/MatchesScreen.tsx` | ~500 (from 3,917) |

---

## Task 1: Extract shared types

**Files:**
- Create: `src/types/matches.ts`
- Modify: `src/components/MatchesScreen.tsx` (replace inline interfaces with imports)

- [ ] **Step 1: Create `src/types/matches.ts`**

Move the 6 interfaces from `MatchesScreen.tsx` lines 117–189 verbatim into a new file, adding exports:

```typescript
export interface Match {
  id: string
  map: string
  startedAt: string | null
  playerCount: number
  demoPath?: string | null
  isMissingDemo?: boolean
  createdAtIso?: string | null
  source?: string | null
}

export interface MatchStats {
  roundCount: number
  duration: number
  teamKills: number
  teamDamage: number
  afkSeconds: number
  teamFlashSeconds: number
  disconnects: number
  tWins: number
  ctWins: number
}

export interface PlayerScore {
  matchId: string
  steamId: string
  name: string
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  bodyBlockSeconds: number
  economyGriefCount: number
  griefScore: number
}

export interface Round {
  roundIndex: number
  startTick: number
  endTick: number
  freezeEndTick: number | null
  tWins: number
  ctWins: number
  winner: string | null
}

export interface RoundStats {
  roundIndex: number
  teamKills: number
  teamDamage: number
  teamFlashSeconds: number
  afkSeconds: number
  events: Array<{
    type: string
    actorSteamId: string
    victimSteamId: string | null
    startTick: number
    endTick: number | null
    meta: any
  }>
}

export interface PlayerEvent {
  type: string
  roundIndex: number
  startTick: number
  endTick: number | null
  actorSteamId: string
  victimSteamId: string | null
  severity: number | null
  confidence: number | null
  meta: any
}

export type ActiveTab = 'overview' | 'rounds' | 'players' | 'chat' | '2d-viewer'

export interface Player {
  steamId: string
  name: string
  team: string | null
  connectedMidgame?: boolean
  permanentDisconnect?: boolean
  firstConnectRound?: number | null
  disconnectRound?: number | null
}
```

- [ ] **Step 2: Update `MatchesScreen.tsx` imports**

Replace the 6 inline interface declarations (lines 117–189) with:

```typescript
import type { Match, MatchStats, PlayerScore, Round, RoundStats, PlayerEvent, ActiveTab, Player } from '../types/matches'
```

Then replace the inline `Array<{ steamId: string; name: string; team: string | null; ... }>` type for `allPlayers` with `Player[]`.

- [ ] **Step 3: Run build to verify no errors**

```bash
npm run build:vite
```

Expected: exits with code 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/matches.ts src/components/MatchesScreen.tsx
git commit -m "refactor: extract shared types to src/types/matches.ts"
```

---

## Task 2: Extract shared format utilities

**Files:**
- Create: `src/utils/formatters.ts`

- [ ] **Step 1: Create `src/utils/formatters.ts`**

```typescript
/** Converts a duration in seconds to a human-readable string e.g. "2m 5s" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

/** Converts a demo tick to a MM:SS string */
export function formatTime(tick: number, tickRate = 64): string {
  const seconds = tick / tickRate
  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/** Returns the duration between two ticks as e.g. "3.2s", or "N/A" if endTick is null */
export function formatEventDuration(startTick: number, endTick: number | null, tickRate = 64): string {
  if (!endTick) return 'N/A'
  const duration = (endTick - startTick) / tickRate
  return `${duration.toFixed(1)}s`
}
```

- [ ] **Step 2: Update `MatchesScreen.tsx`**

Add import at the top:
```typescript
import { formatDuration, formatTime, formatEventDuration } from '../utils/formatters'
```

Delete the three inline function definitions:
- `formatDuration` at line ~904
- `formatTime` at line ~1330
- `formatEventDuration` at line ~1337

Also delete the `formatTime` redefined inside the overview IIFE at line ~2163 (it shadows the outer one — now both will use the same import).

- [ ] **Step 3: Run build**

```bash
npm run build:vite
```

Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/utils/formatters.ts src/components/MatchesScreen.tsx
git commit -m "refactor: extract formatDuration/formatTime/formatEventDuration to src/utils/formatters.ts"
```

---

## Task 3: Extract `StatSummaryCards`

**Files:**
- Create: `src/components/overview/StatSummaryCards.tsx`

Source: `MatchesScreen.tsx` lines ~2220–2277 (the 7 stat summary cards at the top of the overview tab).

- [ ] **Step 1: Create `src/components/overview/StatSummaryCards.tsx`**

```typescript
import { Skull, Zap, WifiOff, Clock } from 'lucide-react'
import { t } from '../../utils/translations'

// Custom icons (copy from top of MatchesScreen.tsx)
const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

const BodyBlockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <circle cx="42" cy="34" r="10" fill="#FF9800"/>
    <rect x="30" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    <circle cx="86" cy="34" r="10" fill="#FF9800"/>
    <rect x="74" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
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
  // Move the 7-card JSX from MatchesScreen.tsx lines ~2220–2277 here verbatim.
  // The cards use t('matches.overview.*') keys and display the passed-in counts.
}
```

Move the JSX block from lines ~2220–2277 into the component body, replacing the `afkDetections.length`, `teamKills.length`, etc. references with the prop values.

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit** (component created; not yet wired in — that happens in Task 10)

```bash
git add src/components/overview/StatSummaryCards.tsx
git commit -m "refactor: extract StatSummaryCards component"
```

---

## Task 4: Extract `AfkSection`

**Files:**
- Create: `src/components/overview/AfkSection.tsx`

Source: `MatchesScreen.tsx` lines ~2279–2438.

- [ ] **Step 1: Create `src/components/overview/AfkSection.tsx`**

```typescript
import { ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { t } from '../../utils/translations'
import { formatEventDuration } from '../../utils/formatters'
import type { Player } from '../../types/matches'

interface AfkEvent {
  actorSteamId: string
  startTick: number
  endTick: number | null
  roundIndex: number
  meta: any
}

interface Props {
  events: AfkEvent[]
  allPlayers: Player[]
  expanded: boolean
  minSeconds: number
  sortBy: 'round' | 'duration'
  demoPath: string | null
  tickRate: number
  hasRadar: boolean
  onToggle: () => void
  onMinSecondsChange: (v: number) => void
  onSortByChange: (v: 'round' | 'duration') => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number }) => void
}

export default function AfkSection(props: Props) {
  // Move the JSX from MatchesScreen.tsx lines ~2279–2438 here verbatim.
  // Replace all references to MatchesScreen-local state with props.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/AfkSection.tsx
git commit -m "refactor: extract AfkSection component"
```

---

## Task 5: Extract `DisconnectsSection`

**Files:**
- Create: `src/components/overview/DisconnectsSection.tsx`

Source: `MatchesScreen.tsx` lines ~2440–2540.

- [ ] **Step 1: Create `src/components/overview/DisconnectsSection.tsx`**

```typescript
import { ChevronDown, ChevronUp, Play, Map as MapIcon, WifiOff } from 'lucide-react'
import { formatEventDuration } from '../../utils/formatters'
import { formatDisconnectReason } from '../../utils/disconnectReason'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

interface DisconnectEvent {
  actorSteamId: string
  startTick: number
  endTick: number | null
  roundIndex: number
  meta: any
}

interface Props {
  events: DisconnectEvent[]
  allPlayers: Player[]
  expanded: boolean
  demoPath: string | null
  tickRate: number
  hasRadar: boolean
  onToggle: () => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number }) => void
}

export default function DisconnectsSection(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~2440–2540 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/DisconnectsSection.tsx
git commit -m "refactor: extract DisconnectsSection component"
```

---

## Task 6: Extract `TeamKillsSection`

**Files:**
- Create: `src/components/overview/TeamKillsSection.tsx`

Source: `MatchesScreen.tsx` lines ~2542–2608.

- [ ] **Step 1: Create `src/components/overview/TeamKillsSection.tsx`**

```typescript
import { ChevronDown, ChevronUp, Skull, Play } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

interface TeamKillEvent {
  actorSteamId: string
  victimSteamId: string | null
  startTick: number
  roundIndex: number
  meta: any
}

interface Props {
  events: TeamKillEvent[]
  allPlayers: Player[]
  expanded: boolean
  demoPath: string | null
  tickRate: number
  onToggle: () => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
}

export default function TeamKillsSection(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~2542–2608 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/TeamKillsSection.tsx
git commit -m "refactor: extract TeamKillsSection component"
```

---

## Task 7: Extract `TeamDamageSection`

**Files:**
- Create: `src/components/overview/TeamDamageSection.tsx`

Source: `MatchesScreen.tsx` lines ~2610–2717.

- [ ] **Step 1: Create `src/components/overview/TeamDamageSection.tsx`**

```typescript
import { ChevronDown, ChevronUp, Zap, Play } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

interface TeamDamageEvent {
  actorSteamId: string
  victimSteamId: string | null
  startTick: number
  roundIndex: number
  meta: any
}

interface Props {
  events: TeamDamageEvent[]
  allPlayers: Player[]
  expanded: boolean
  demoPath: string | null
  tickRate: number
  onToggle: () => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
}

export default function TeamDamageSection(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~2610–2717 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/TeamDamageSection.tsx
git commit -m "refactor: extract TeamDamageSection component"
```

---

## Task 8: Extract `TeamFlashesSection`

**Files:**
- Create: `src/components/overview/TeamFlashesSection.tsx`

Source: `MatchesScreen.tsx` lines ~2679–2779.

- [ ] **Step 1: Create `src/components/overview/TeamFlashesSection.tsx`**

```typescript
import { ChevronDown, ChevronUp, Zap, Play } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

interface TeamFlashEvent {
  actorSteamId: string
  victimSteamId: string | null
  startTick: number
  roundIndex: number
  meta: any
}

interface Props {
  events: TeamFlashEvent[]
  allPlayers: Player[]
  expanded: boolean
  minSeconds: number
  demoPath: string | null
  tickRate: number
  onToggle: () => void
  onMinSecondsChange: (v: number) => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
}

export default function TeamFlashesSection(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~2679–2779 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/TeamFlashesSection.tsx
git commit -m "refactor: extract TeamFlashesSection component"
```

---

## Task 9: Extract `EconomyGriefSection`

**Files:**
- Create: `src/components/overview/EconomyGriefSection.tsx`

Source: `MatchesScreen.tsx` lines ~2781–3015. Includes the inline economy detail modal popup.

- [ ] **Step 1: Create `src/components/overview/EconomyGriefSection.tsx`**

```typescript
import { useState } from 'react'
import { ChevronDown, ChevronUp, X, Play, Info } from 'lucide-react'
import { t } from '../../utils/translations'
import type { Player, PlayerScore } from '../../types/matches'

// Copy DollarIcon from top of MatchesScreen.tsx
const DollarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="64" cy="64" r="54" fill="#F4C430"/>
    <circle cx="64" cy="64" r="44" fill="#FFD966"/>
    <text x="64" y="78" textAnchor="middle" fontSize="48" fontWeight="bold" fill="#B8860B">$</text>
  </svg>
)

interface EconomyEvent {
  actorSteamId: string
  startTick: number
  roundIndex: number
  meta: any
}

interface Props {
  events: EconomyEvent[]
  allPlayers: Player[]
  scores: PlayerScore[]
  expanded: boolean
  demoPath: string | null
  tickRate: number
  onToggle: () => void
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
}

export default function EconomyGriefSection(props: Props) {
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null)
  // Move JSX from MatchesScreen.tsx lines ~2781–3015 here verbatim.
  // Replace selectedEconomyEvent state with local selectedEvent state.
  // Replace setSelectedEconomyEvent with setSelectedEvent.
}
```

Note: `selectedEconomyEvent` and `setSelectedEconomyEvent` from MatchesScreen become local state inside this component.

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/EconomyGriefSection.tsx
git commit -m "refactor: extract EconomyGriefSection component"
```

---

## Task 10: Extract `BodyBlockSection`

**Files:**
- Create: `src/components/overview/BodyBlockSection.tsx`

Source: `MatchesScreen.tsx` lines ~3017–3090.

- [ ] **Step 1: Create `src/components/overview/BodyBlockSection.tsx`**

```typescript
import { ChevronDown, ChevronUp } from 'lucide-react'
import { formatEventDuration } from '../../utils/formatters'
import { t } from '../../utils/translations'
import type { Player } from '../../types/matches'

// Copy BodyBlockIcon from top of MatchesScreen.tsx
const BodyBlockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <circle cx="42" cy="34" r="10" fill="#FF9800"/>
    <rect x="30" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    <circle cx="86" cy="34" r="10" fill="#FF9800"/>
    <rect x="74" y="48" width="24" height="48" rx="7" fill="#FF9800"/>
    <rect x="56" y="68" width="16" height="8" rx="4" fill="#FF5722"/>
  </svg>
)

interface BodyBlockEvent {
  actorSteamId: string
  victimSteamId: string | null
  startTick: number
  endTick: number | null
  roundIndex: number
  meta: any
}

interface Props {
  events: BodyBlockEvent[]
  allPlayers: Player[]
  expanded: boolean
  tickRate: number
  onToggle: () => void
}

export default function BodyBlockSection(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~3017–3090 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/overview/BodyBlockSection.tsx
git commit -m "refactor: extract BodyBlockSection component"
```

---

## Task 11: Extract `MatchesOverviewTab`

**Files:**
- Create: `src/components/MatchesOverviewTab.tsx`

This composes all 8 overview sub-components. The IIFE aggregation logic from `MatchesScreen.tsx` line ~2135 moves here as regular component body code. The state `expandedSections`, `afkMinSeconds`, `flashMinSeconds`, `afkSortBy` moves from MatchesScreen into this component.

- [ ] **Step 1: Create `src/components/MatchesOverviewTab.tsx`**

```typescript
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
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number, isPov?: boolean, playerSteamId?: string) => void
  onToast: (msg: { message: string; type?: 'success' | 'error' | 'info' }) => void
}

export default function MatchesOverviewTab({
  allEvents, allPlayers, scores, rounds, demoPath, tickRate,
  hasRadarForCurrentMap, onSetViewer2D, onWatchAtTick, onToast,
}: Props) {
  const [expandedSections, setExpandedSections] = useState({
    afk: true, teamKills: true, teamDamage: true, disconnects: true,
    teamFlashes: true, economy: true, bodyBlock: true,
  })
  const [afkMinSeconds, setAfkMinSeconds] = useState(10)
  const [flashMinSeconds, setFlashMinSeconds] = useState(1.5)
  const [afkSortBy, setAfkSortBy] = useState<'round' | 'duration'>('round')

  const toggle = (section: keyof typeof expandedSections) =>
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))

  // Aggregate from allEvents — move the IIFE body from MatchesScreen lines ~2136–2168 here
  const teamKills = allEvents.filter(e => e.type === 'TEAM_KILL')
  const teamDamage = allEvents.filter(e => e.type === 'TEAM_DAMAGE')
  const afkDetections = allEvents.filter(e => e.type === 'AFK_STILLNESS')
  const disconnects = allEvents.filter(e => e.type === 'DISCONNECT')
  const teamFlashes = allEvents.filter(e => e.type === 'TEAM_FLASH')
  const economyGriefs = allEvents.filter(e => e.type === 'ECONOMY_GRIEF')
  const bodyBlocks = allEvents.filter(e => e.type === 'BODY_BLOCK')
  const totalTeamDamage = teamDamage.reduce((s, e) => s + (e.meta?.total_damage || 0), 0)
  const totalAfkSeconds = afkDetections.reduce((s, e) => {
    const d = e.meta?.seconds || e.meta?.afkDuration || (e.endTick && e.startTick ? (e.endTick - e.startTick) / 64 : 0)
    return s + d
  }, 0)
  const totalFlashSeconds = teamFlashes.reduce((s, e) => s + (e.meta?.blind_duration || 0), 0)

  return (
    <div className="space-y-4">
      <StatSummaryCards
        afkCount={afkDetections.length}
        teamKillCount={teamKills.length}
        teamDamageTotal={totalTeamDamage}
        disconnectCount={disconnects.length}
        flashSeconds={totalFlashSeconds}
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
        onToggle={() => toggle('afk')}
        onMinSecondsChange={setAfkMinSeconds}
        onSortByChange={setAfkSortBy}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={onSetViewer2D}
      />
      <DisconnectsSection
        events={disconnects}
        allPlayers={allPlayers}
        expanded={expandedSections.disconnects}
        demoPath={demoPath}
        tickRate={tickRate}
        hasRadar={hasRadarForCurrentMap}
        onToggle={() => toggle('disconnects')}
        onWatchAtTick={onWatchAtTick}
        onSetViewer2D={onSetViewer2D}
      />
      <TeamKillsSection
        events={teamKills}
        allPlayers={allPlayers}
        expanded={expandedSections.teamKills}
        demoPath={demoPath}
        tickRate={tickRate}
        onToggle={() => toggle('teamKills')}
        onWatchAtTick={onWatchAtTick}
      />
      <TeamDamageSection
        events={teamDamage}
        allPlayers={allPlayers}
        expanded={expandedSections.teamDamage}
        demoPath={demoPath}
        tickRate={tickRate}
        onToggle={() => toggle('teamDamage')}
        onWatchAtTick={onWatchAtTick}
      />
      <TeamFlashesSection
        events={teamFlashes}
        allPlayers={allPlayers}
        expanded={expandedSections.teamFlashes}
        minSeconds={flashMinSeconds}
        demoPath={demoPath}
        tickRate={tickRate}
        onToggle={() => toggle('teamFlashes')}
        onMinSecondsChange={setFlashMinSeconds}
        onWatchAtTick={onWatchAtTick}
      />
      <EconomyGriefSection
        events={economyGriefs}
        allPlayers={allPlayers}
        scores={scores}
        expanded={expandedSections.economy}
        demoPath={demoPath}
        tickRate={tickRate}
        onToggle={() => toggle('economy')}
        onWatchAtTick={onWatchAtTick}
      />
      <BodyBlockSection
        events={bodyBlocks}
        allPlayers={allPlayers}
        expanded={expandedSections.bodyBlock}
        tickRate={tickRate}
        onToggle={() => toggle('bodyBlock')}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchesOverviewTab.tsx
git commit -m "refactor: extract MatchesOverviewTab component"
```

---

## Task 12: Extract `MatchesRoundsTab`

**Files:**
- Create: `src/components/MatchesRoundsTab.tsx`

Source: `MatchesScreen.tsx` lines ~3094–3257.

- [ ] **Step 1: Create `src/components/MatchesRoundsTab.tsx`**

```typescript
import { useState } from 'react'
import { ChevronDown, ChevronUp, Play, Map as MapIcon } from 'lucide-react'
import { formatTime } from '../utils/formatters'
import { t } from '../utils/translations'
import type { Round, RoundStats, PlayerScore, Player } from '../types/matches'

interface Props {
  rounds: Round[]
  roundStats: Map<number, RoundStats>
  allPlayers: Player[]
  scores: PlayerScore[]
  demoPath: string | null
  tickRate: number
  hasRadarForCurrentMap: boolean
  onWatchAtTick: (tick: number, playerName: string, roundIndex: number) => void
  onSetViewer2D: (v: { roundIndex: number; tick: number } | null) => void
}

export default function MatchesRoundsTab(props: Props) {
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set())
  // Move JSX from MatchesScreen.tsx lines ~3094–3257 here verbatim.
  // Replace collapsedSections/toggleSection with local expandedRounds state.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchesRoundsTab.tsx
git commit -m "refactor: extract MatchesRoundsTab component"
```

---

## Task 13: Extract `MatchesPlayersTab`

**Files:**
- Create: `src/components/MatchesPlayersTab.tsx`

Source: `MatchesScreen.tsx` lines ~3259–3585. Absorbs `playerSortField` and `playerSortDirection` state.

- [ ] **Step 1: Create `src/components/MatchesPlayersTab.tsx`**

```typescript
import { useState } from 'react'
import { ArrowUp, ArrowDown, Mic } from 'lucide-react'
import { t } from '../utils/translations'
import type { PlayerScore, Player } from '../types/matches'

type PlayerSortField = 'name' | 'teamKills' | 'teamDamage' | 'teamFlashSeconds' | 'afkSeconds'

interface Props {
  scores: PlayerScore[]
  allPlayers: Player[]
  demoPath: string | null
  selectedMatch: string
  onPlayerClick: (player: PlayerScore) => void
  onExtractVoice: (player: PlayerScore, e?: React.MouseEvent) => void
  onExtractTeamVoice: (teamName: string, players: PlayerScore[], e?: React.MouseEvent) => void
}

export default function MatchesPlayersTab(props: Props) {
  const [sortField, setSortField] = useState<PlayerSortField>('teamKills')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  // Move JSX from MatchesScreen.tsx lines ~3259–3585 here verbatim.
  // Replace playerSortField/playerSortDirection and their setters with local state.
  // Replace groupedAndSortedScores/allPlayersWithScores memos with local equivalents
  //   (copy the memo logic from MatchesScreen into this component).
}
```

Note: The `allPlayersWithScores` and `groupedAndSortedScores` memos from MatchesScreen (lines ~700–829) are exclusively used by this tab. Move them into this component.

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchesPlayersTab.tsx
git commit -m "refactor: extract MatchesPlayersTab component"
```

---

## Task 14: Extract `MatchesChatTab`

**Files:**
- Create: `src/components/MatchesChatTab.tsx`

Source: `MatchesScreen.tsx` lines ~3586–3724. Absorbs `chatFilterSteamId`, `chatViewMode`, and `loadingChat` state. Owns its own data fetching.

- [ ] **Step 1: Create `src/components/MatchesChatTab.tsx`**

```typescript
import { useState } from 'react'
import { Copy } from 'lucide-react'
import { t } from '../utils/translations'
import { formatDisconnectReason } from '../utils/disconnectReason'
import type { PlayerScore } from '../types/matches'

interface ChatMessage {
  matchId: string
  roundIndex: number
  tick: number
  steamid: string
  name: string
  team: string | null
  message: string
  isTeamChat: boolean
}

interface Props {
  messages: ChatMessage[]
  loading: boolean
  scores: PlayerScore[]
  onToast: (msg: { message: string; type?: 'success' | 'error' | 'info' }) => void
}

export default function MatchesChatTab({ messages, loading, scores, onToast }: Props) {
  const [filterSteamId, setFilterSteamId] = useState<string | null>(null)
  // Move JSX from MatchesScreen.tsx lines ~3586–3724 here verbatim.
  // Replace chatFilterSteamId/chatViewMode/loadingChat with local state.
  // Replace setChatFilterSteamId with setFilterSteamId.
}
```

Note: `loadingChat` and `chatMessages` are fetched by MatchesScreen (via `fetchChatMessages`) and passed as `loading` and `messages` props. The filter state becomes local to this component. When the filter changes, call back up via a prop — OR keep filtering purely local since the full message list is always passed.

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchesChatTab.tsx
git commit -m "refactor: extract MatchesChatTab component"
```

---

## Task 15: Extract `MatchesViewer2DTab`

**Files:**
- Create: `src/components/MatchesViewer2DTab.tsx`

Source: `MatchesScreen.tsx` lines ~3725–3743.

- [ ] **Step 1: Create `src/components/MatchesViewer2DTab.tsx`**

```typescript
import Viewer2D from './Viewer2D'
import type { Match, Round } from '../types/matches'

interface Props {
  selectedMatch: string
  matches: Match[]
  rounds: Round[]
  demoPath: string | null
  tickRate: number
  viewer2D: { roundIndex: number; tick: number } | null
  onClose: () => void
}

export default function MatchesViewer2DTab({
  selectedMatch, matches, rounds, demoPath, tickRate, viewer2D, onClose
}: Props) {
  if (!viewer2D) return null
  return (
    <Viewer2D
      demoPath={demoPath || ''}
      initialTick={viewer2D.tick}
      roundIndex={viewer2D.roundIndex}
      tickRate={tickRate}
      roundStartTick={rounds.find(r => r.roundIndex === viewer2D.roundIndex)?.startTick || 0}
      roundEndTick={rounds.find(r => r.roundIndex === viewer2D.roundIndex)?.endTick || 0}
      mapName={matches.find(m => m.id === selectedMatch)?.map || ''}
      onClose={onClose}
    />
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchesViewer2DTab.tsx
git commit -m "refactor: extract MatchesViewer2DTab component"
```

---

## Task 16: Extract `MatchListPanel`

**Files:**
- Create: `src/components/MatchListPanel.tsx`

Source: `MatchesScreen.tsx` lines ~1547–1949 (match list view, search/sort, context menu, delete modal). Also moves `LazyMapThumbnail` (lines 39–115) here since it is only used by this panel.

- [ ] **Step 1: Create `src/components/MatchListPanel.tsx`**

```typescript
import { useState, useEffect, useRef } from 'react'
import { Loader2, Plus, Trash2, RefreshCw, ArrowUp, ArrowDown, Database } from 'lucide-react'
import { formatDuration } from '../utils/formatters'
import { t } from '../utils/translations'
import type { Match, MatchStats } from '../types/matches'

// Move LazyMapThumbnail from MatchesScreen.tsx lines 39–115 here verbatim (no export needed).
function LazyMapThumbnail({ thumbnail, alt, className }: {
  thumbnail: string | null
  alt: string
  className?: string
}) { /* ... move verbatim ... */ }

interface Props {
  matches: Match[]
  sortedMatches: Match[]
  matchStats: Map<string, MatchStats>
  selectedMatches: Set<string>
  loading: boolean
  error: string | null
  searchQuery: string
  sortField: 'id' | 'length' | 'map' | 'date'
  sortDirection: 'asc' | 'desc'
  showDeleteModal: boolean
  deleting: boolean
  enableDbViewer: boolean
  contextMenu: { x: number; y: number; match: Match } | null
  onSearchChange: (q: string) => void
  onSortFieldChange: (f: 'id' | 'length' | 'map' | 'date') => void
  onSortDirectionToggle: () => void
  onMatchClick: (id: string) => void
  onContextMenu: (e: React.MouseEvent, match: Match) => void
  onContextMenuAction: (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => void
  onContextMenuClose: () => void
  onToggleMatchSelection: (id: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onShowDeleteModal: (show: boolean) => void
  onDeleteConfirm: () => void
  onAddDemo: () => void
  getSourceIcon: (source: string | null | undefined) => string | null
  getMapThumbnail: (mapName: string | null | undefined) => string | null
}

export default function MatchListPanel(props: Props) {
  // Move JSX from MatchesScreen.tsx lines ~1547–1949 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchListPanel.tsx
git commit -m "refactor: extract MatchListPanel component (includes LazyMapThumbnail)"
```

---

## Task 17: Extract `MatchDetailsHeader`

**Files:**
- Create: `src/components/MatchDetailsHeader.tsx`

Source: `MatchesScreen.tsx` lines ~1954–2130 (match info bar + tab switcher).

- [ ] **Step 1: Create `src/components/MatchDetailsHeader.tsx`**

```typescript
import { Clock, Download, Trash2 } from 'lucide-react'
import { t } from '../utils/translations'
import type { Match, MatchStats, Round, Player, ActiveTab } from '../types/matches'

interface Props {
  selectedMatch: string
  matches: Match[]
  matchStats: Map<string, MatchStats>
  rounds: Round[]
  allPlayers: Player[]
  tickRate: number
  activeTab: ActiveTab
  demoPath: string | null
  hasRadarForCurrentMap: boolean
  onTabChange: (tab: ActiveTab) => void
  onWatchInCS2: () => void
  onDeleteDemo: () => void
  onFetchChat: (matchId: string) => void
}

export default function MatchDetailsHeader({
  selectedMatch, matches, matchStats, rounds, allPlayers, tickRate,
  activeTab, demoPath, hasRadarForCurrentMap,
  onTabChange, onWatchInCS2, onDeleteDemo, onFetchChat,
}: Props) {
  // Move JSX from MatchesScreen.tsx lines ~1954–2130 here verbatim.
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build:vite
```

- [ ] **Step 3: Commit**

```bash
git add src/components/MatchDetailsHeader.tsx
git commit -m "refactor: extract MatchDetailsHeader component"
```

---

## Task 18: Final cleanup — slim down `MatchesScreen.tsx`

**Files:**
- Modify: `src/components/MatchesScreen.tsx`

Replace the extracted JSX blocks and inline state with imports and usage of the new components. Target: under 500 lines.

- [ ] **Step 1: Add imports at top of `MatchesScreen.tsx`**

```typescript
import MatchListPanel from './MatchListPanel'
import MatchDetailsHeader from './MatchDetailsHeader'
import MatchesOverviewTab from './MatchesOverviewTab'
import MatchesRoundsTab from './MatchesRoundsTab'
import MatchesPlayersTab from './MatchesPlayersTab'
import MatchesChatTab from './MatchesChatTab'
import MatchesViewer2DTab from './MatchesViewer2DTab'
```

- [ ] **Step 2: Remove extracted state from `MatchesScreen`**

Delete these state declarations (they moved into their respective components):
- `expandedSections` (→ MatchesOverviewTab)
- `selectedEconomyEvent` (→ EconomyGriefSection)
- `afkMinSeconds`, `flashMinSeconds`, `afkSortBy` (→ MatchesOverviewTab)
- `chatFilterSteamId`, `chatViewMode` (→ MatchesChatTab)
- `playerSortField`, `playerSortDirection` (→ MatchesPlayersTab)
- `collapsedSections` (→ MatchesRoundsTab, was rounds tab toggle state)

- [ ] **Step 3: Remove extracted helper code**

Delete from `MatchesScreen.tsx`:
- `LazyMapThumbnail` function (lines 39–115, moved to MatchListPanel)
- `DollarIcon` and `BodyBlockIcon` SVG components (lines 17–37, moved to section components)
- `allPlayersWithScores` and `groupedAndSortedScores` memos (moved to MatchesPlayersTab)
- The `toggleSection` function (no longer needed in orchestrator)
- The `filteredEvents` / `eventsByType` / sort-within-type code (was player modal logic, verify still needed or remove)

- [ ] **Step 4: Replace the render return with wired-up components**

Replace the `return (...)` block (lines ~1537–3912) with:

```tsx
return (
  <div
    className={`flex-1 flex flex-col p-6 overflow-auto transition-colors ${
      isDragging ? 'bg-accent/10 border-2 border-dashed border-accent' : ''
    }`}
    onDragOver={handleDragOver}
    onDragLeave={handleDragLeave}
    onDrop={handleDrop}
  >
    {!showMatchOverview ? (
      <MatchListPanel
        matches={matches}
        sortedMatches={sortedMatches}
        matchStats={matchStats}
        selectedMatches={selectedMatches}
        loading={loading}
        error={error}
        searchQuery={searchQuery}
        sortField={sortField}
        sortDirection={sortDirection}
        showDeleteModal={showDeleteModal}
        deleting={deleting}
        enableDbViewer={enableDbViewer}
        contextMenu={contextMenu}
        onSearchChange={setSearchQuery}
        onSortFieldChange={setSortField}
        onSortDirectionToggle={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')}
        onMatchClick={handleMatchClick}
        onContextMenu={handleContextMenu}
        onContextMenuAction={handleContextMenuAction}
        onContextMenuClose={() => setContextMenu(null)}
        onToggleMatchSelection={toggleMatchSelection}
        onSelectAll={selectAllMatches}
        onDeselectAll={deselectAllMatches}
        onShowDeleteModal={setShowDeleteModal}
        onDeleteConfirm={handleDeleteSelected}
        onAddDemo={handleAddDemo}
        getSourceIcon={getSourceIcon}
        getMapThumbnail={getMapThumbnail}
      />
    ) : (
      <div className="flex-1 bg-secondary rounded-lg border border-border p-4 overflow-auto min-h-0 [scrollbar-gutter:stable]">
        {selectedMatch && (
          <>
            <MatchDetailsHeader
              selectedMatch={selectedMatch}
              matches={matches}
              matchStats={matchStats}
              rounds={rounds}
              allPlayers={allPlayers}
              tickRate={tickRate}
              activeTab={activeTab}
              demoPath={demoPath}
              hasRadarForCurrentMap={hasRadarForCurrentMap}
              onTabChange={setActiveTab}
              onWatchInCS2={handleWatchInCS2}
              onDeleteDemo={handleDeleteDemo}
              onFetchChat={(matchId) => fetchChatMessages(matchId, undefined)}
            />

            {loading ? (
              <div className="text-center text-gray-400 py-8">{t('matches.loading')}</div>
            ) : activeTab === 'overview' ? (
              <MatchesOverviewTab
                allEvents={allEvents}
                allPlayers={allPlayers}
                scores={scores}
                rounds={rounds}
                demoPath={demoPath}
                tickRate={tickRate}
                hasRadarForCurrentMap={hasRadarForCurrentMap}
                onSetViewer2D={setViewer2D}
                onWatchAtTick={handleWatchAtTick}
                onToast={setToast}
              />
            ) : activeTab === 'rounds' ? (
              <MatchesRoundsTab
                rounds={rounds}
                roundStats={roundStats}
                allPlayers={allPlayers}
                scores={scores}
                demoPath={demoPath}
                tickRate={tickRate}
                hasRadarForCurrentMap={hasRadarForCurrentMap}
                onWatchAtTick={handleWatchAtTick}
                onSetViewer2D={setViewer2D}
              />
            ) : activeTab === 'players' ? (
              <MatchesPlayersTab
                scores={scores}
                allPlayers={allPlayers}
                demoPath={demoPath}
                selectedMatch={selectedMatch}
                onPlayerClick={handlePlayerClick}
                onExtractVoice={handleExtractVoice}
                onExtractTeamVoice={handleExtractTeamVoice}
              />
            ) : activeTab === 'chat' ? (
              <MatchesChatTab
                messages={chatMessages}
                loading={loadingChat}
                scores={scores}
                onToast={setToast}
              />
            ) : activeTab === '2d-viewer' ? (
              <MatchesViewer2DTab
                selectedMatch={selectedMatch}
                matches={matches}
                rounds={rounds}
                demoPath={demoPath}
                tickRate={tickRate}
                viewer2D={viewer2D}
                onClose={() => setViewer2D(null)}
              />
            ) : null}
          </>
        )}
      </div>
    )}

    {/* Modals — unchanged from original */}
    {/* ... Demo Load Modal, PlayerModal, Toast, ParsingModal, VoicePlaybackModal,
            TeamCommsModal, ParserLogsModal, ClipExportPanel ... */}
  </div>
)
```

Keep all modal JSX (lines ~3756–3912) unchanged at the bottom of the return.

Also extract `handleAddDemo` — the inline click handler at lines ~1573–1596 — into a named function at the top of MatchesScreen alongside the other handlers.

Also extract `handleWatchAtTick` — a new named function combining the `setShowDemoLoadModal` + `setPendingDemoAction` logic currently scattered in the overview/rounds tabs — so all child components can call a single `onWatchAtTick(tick, playerName, roundIndex)` prop.

- [ ] **Step 5: Verify full build**

```bash
npm run build:vite && npm run build:electron
```

Expected: both exit 0, no TypeScript errors.

- [ ] **Step 6: Verify MatchesScreen.tsx is under 500 lines**

```bash
wc -l src/components/MatchesScreen.tsx
```

Expected: < 500.

- [ ] **Step 7: Commit**

```bash
git add src/components/MatchesScreen.tsx
git commit -m "refactor: slim down MatchesScreen.tsx to orchestrator (~500 lines)"
```

---

## Verification

After all tasks are complete:

1. `npm run build:vite && npm run build:electron` — both pass with no errors
2. `wc -l src/components/MatchesScreen.tsx` — output is under 500
3. Launch app (`npm run dev`), open the Matches screen — match list loads, search/sort works, context menu opens
4. Select a match — all 5 tabs (Overview, Rounds, Players, Chat, 2D Viewer) render correctly
5. Overview tab — all 7 sections expand/collapse, AFK threshold slider works, flash threshold slider works
6. Chat tab — player filter dropdown works, messages display
7. Players tab — sort by column works, player click opens detail modal
8. If a demo path is set: Watch in CS2 button triggers the confirm modal, voice extract opens voice modal
