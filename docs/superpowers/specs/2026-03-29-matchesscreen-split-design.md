# MatchesScreen Component Split — Design Spec

**Date:** 2026-03-29
**Status:** Approved

---

## Context

`MatchesScreen.tsx` has grown to 3,917 lines and is the primary match browsing/analysis UI. It is difficult to navigate and reason about. The goal is to split it into focused, smaller component files without changing any behavior or state management approach. This is a structural refactor only — no logic extraction, no new hooks, no visible changes to the user.

---

## File Structure

```
src/components/
  MatchesScreen.tsx           ← orchestrator (~400 lines, down from 3917)
  MatchListPanel.tsx          ← match grid, search/sort, context menu, delete modal
  MatchDetailsHeader.tsx      ← match info bar + tab switcher + action buttons
  MatchesOverviewTab.tsx      ← composes the 7 overview sections
  MatchesRoundsTab.tsx        ← rounds list with per-round events
  MatchesPlayersTab.tsx       ← team player cards, sort/filter, voice extract
  MatchesChatTab.tsx          ← chat messages + player filter
  MatchesViewer2DTab.tsx      ← thin wrapper around Viewer2D
  overview/
    StatSummaryCards.tsx      ← 7 stat cards at the top of the overview
    AfkSection.tsx
    DisconnectsSection.tsx
    TeamKillsSection.tsx
    TeamDamageSection.tsx
    TeamFlashesSection.tsx
    EconomyGriefSection.tsx
    BodyBlockSection.tsx

src/utils/
  formatters.ts               ← shared formatDuration, formatTime, formatEventDuration
```

**16 new files total** (15 components + 1 utility). `MatchesScreen.tsx` shrinks to ~400 lines.

---

## State & Data Flow

`MatchesScreen.tsx` remains the single source of truth for all cross-cutting state. Props flow down, callbacks flow up. No state management library changes.

**Tab-local state moves down into the relevant component:**

| State | Current location | Moves to |
|---|---|---|
| `expandedSections`, `afkMinSeconds`, `flashMinSeconds`, `afkSortBy`, `selectedEconomyEvent` | MatchesScreen | `MatchesOverviewTab` |
| `chatFilterSteamId`, `chatViewMode`, `loadingChat` | MatchesScreen | `MatchesChatTab` |
| `playerSortField`, `playerSortDirection` | MatchesScreen | `MatchesPlayersTab` |

Everything else (selected match, events, rounds, scores, modals, demo path, loading/error) stays in `MatchesScreen`.

**Shared format utilities** — `formatDuration`, `formatTime`, `formatEventDuration` are currently inline in MatchesScreen but needed by multiple tabs/sections. They move to `src/utils/formatters.ts` and are imported wherever needed.

---

## Component Responsibilities

### `MatchesScreen.tsx` (orchestrator)
- All remaining state (selected match, events, rounds, scores, allPlayers, modals, demoPath, loading/error, activeTab)
- `fetchMatches()`, `fetchChatMessages()` and all IPC data loading
- `sortedMatches`, `allPlayersWithScores`, `groupedAndSortedScores` memos
- Shared event handlers: `handleMatchClick`, `handleWatchInCS2`, `handleDeleteDemo`, `handleExtractTeamVoice`, `handlePlayerClick`, drag-and-drop handlers
- Renders: `MatchListPanel` + `MatchDetailsHeader` + tab components + all modals

### `MatchListPanel.tsx`
- Match grid with `LazyMapThumbnail`
- Search input and sort controls
- Context menu
- Delete confirmation modal
- Multi-select checkboxes
- Source: lines ~1549–1949

### `MatchDetailsHeader.tsx`
- Match info bar (map name, date, player count, duration)
- Tab switcher (Overview / Rounds / Players / Chat / 2D Viewer)
- Action buttons (Watch in CS2, Export Panel, Parser Logs)
- Source: lines ~1954–2130

### `MatchesOverviewTab.tsx`
- Owns: `expandedSections`, `afkMinSeconds`, `flashMinSeconds`, `afkSortBy`, `selectedEconomyEvent`
- Composes all 8 overview sub-components
- Passes section-specific props and toggle handlers

### `overview/StatSummaryCards.tsx`
- 7 stat summary cards: AFK, Team Kills, Team Damage, Disconnects, Team Flashes, Economy Grief, Body Blocks
- Source: lines ~2220–2277

### `overview/AfkSection.tsx`
- Collapsible AFK detections grouped by player
- Sort by round or duration, threshold filter
- Source: lines ~2279–2438

### `overview/DisconnectsSection.tsx`
- Disconnect events with reason, duration, reconnect status
- Source: lines ~2440–2540

### `overview/TeamKillsSection.tsx`
- Team kill events: killer → victim, weapon
- Source: lines ~2542–2608

### `overview/TeamDamageSection.tsx`
- Team damage events with amount and weapon
- Source: lines ~2610–2717

### `overview/TeamFlashesSection.tsx`
- Team flash events with blind duration and threshold filter
- Source: lines ~2679–2779

### `overview/EconomyGriefSection.tsx`
- Economy grief events with money analysis
- Inline modal popup for detailed team economy comparison
- Source: lines ~2781–3015

### `overview/BodyBlockSection.tsx`
- Body block events with blocker/victim and duration
- Source: lines ~3017–3090

### `MatchesRoundsTab.tsx`
- Round list with collapsible per-round events
- Event timeline relative to round start
- 2D viewer button per round
- Source: lines ~3094–3257

### `MatchesPlayersTab.tsx`
- Owns: `playerSortField`, `playerSortDirection`
- Two-column team layout with player stat cards
- Team voice extract button
- Source: lines ~3259–3585

### `MatchesChatTab.tsx`
- Owns: `chatFilterSteamId`, `chatViewMode`, `loadingChat`
- Player filter dropdown, copy all chat button
- Message list with server message highlighting
- Source: lines ~3586–3724

### `MatchesViewer2DTab.tsx`
- Thin wrapper around `<Viewer2D>`
- Source: lines ~3725–3743

---

## Implementation Order

Bottom-up — leaf components first, orchestrator last. App stays working after every step.

1. `src/utils/formatters.ts` — extract shared format functions, no component changes
2. `overview/` — 8 leaf components (StatSummaryCards, AfkSection, DisconnectsSection, TeamKillsSection, TeamDamageSection, TeamFlashesSection, EconomyGriefSection, BodyBlockSection)
3. `MatchesOverviewTab.tsx` — composes the 8 sections, absorbs its local state
4. `MatchesRoundsTab.tsx`
5. `MatchesPlayersTab.tsx` — absorbs playerSort state
6. `MatchesChatTab.tsx` — absorbs chat state
7. `MatchesViewer2DTab.tsx`
8. `MatchListPanel.tsx`
9. `MatchDetailsHeader.tsx`
10. `MatchesScreen.tsx` — final cleanup, remove all extracted code, wire up components

---

## Verification

- `MatchesScreen.tsx` ends up under 500 lines
- App launches and all tabs render correctly
- Match list loads, search/sort works, context menu works
- All 5 tabs (Overview, Rounds, Players, Chat, 2D Viewer) display correctly
- All overview sections expand/collapse correctly
- Demo can be launched in CS2, voice extraction works, clip export panel opens
- No TypeScript errors (`npm run build:electron && npm run build:vite`)
