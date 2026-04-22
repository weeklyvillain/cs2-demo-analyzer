import { useState, useEffect, useRef } from 'react'
import Modal from './Modal'
import { formatDuration } from '../utils/formatters'
import type { Match, MatchStats } from '../types/matches'
import { t } from '../utils/translations'
import {
  getDragSelectionRect,
  getOverlappingMatchIds,
  hasDragSelectionMovement,
  isDragSelectionIgnoredTagName,
} from '../utils/matchDragSelection'
import { Check, ArrowUp, ArrowDown, Trash2, X, Loader2, FolderOpen, Database, RefreshCw, Upload, FileText } from 'lucide-react'

function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null
  while (current && current !== document.body) {
    const style = getComputedStyle(current)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
        style.overflow === 'auto' || style.overflow === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

/** Lazy-loads the map thumbnail when the card enters the viewport to avoid loading many images at once. */
function LazyMapThumbnail({
  thumbnail,
  alt,
  className,
}: {
  thumbnail: string | null
  alt: string
  className?: string
}) {
  const [isInView, setIsInView] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || !thumbnail) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          observer.disconnect()
          setIsInView(true)
        }
      },
      { rootMargin: '100px', threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [thumbnail])

  useEffect(() => {
    if (!isInView || !thumbnail) setImageLoaded(false)
  }, [isInView, thumbnail])

  if (!thumbnail) {
    return (
      <div className={`w-full h-full flex items-center justify-center bg-gradient-to-br from-surface to-secondary ${className ?? ''}`}>
        <span className="text-4xl">🗺️</span>
      </div>
    )
  }

  if (!isInView) {
    return (
      <div
        ref={containerRef}
        className={`w-full h-full flex items-center justify-center bg-gradient-to-br from-surface to-secondary ${className ?? ''}`}
      >
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs text-gray-500">Loading…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full">
      {!imageLoaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-surface to-secondary">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs text-gray-500 mt-2">Loading…</span>
        </div>
      )}
      <img
        src={thumbnail}
        alt={alt}
        className={`w-full h-full ${className ?? ''} ${imageLoaded ? 'opacity-100' : 'opacity-0'} transition-[opacity,transform] duration-300`}
        onLoad={() => setImageLoaded(true)}
        onError={(e) => {
          e.currentTarget.style.display = 'none'
          setImageLoaded(true)
        }}
      />
    </div>
  )
}

const getSourceIcon = (source: string | null | undefined): string | null => {
  if (!source || source === 'unknown') {
    return null
  }

  const sourceIconMap: Record<string, string> = {
    'faceit': 'faceit-white.png',
    'cevo': 'cevo-white.png',
    'challengermode': 'challengermode.png',
    'esl': 'esl-white.png',
    'ebot': 'ebot.png',
    'esea': 'esea-white.png',
    'popflash': 'popflash-white.png',
    'esportal': 'esportal-white.png',
    'fastcup': 'fastcup-white.png',
    'gamersclub': 'gamersclub-white.png',
    'renown': 'renown-white.png',
    'matchzy': 'matchzy.png',
    'valve': 'valve-white.png',
    'perfectworld': 'perfectworld-white.png',
    '5eplay': '5eplay.png',
    'esplay': 'esplay.png',
  }

  const iconName = sourceIconMap[source.toLowerCase()]
  if (!iconName) {
    return null
  }

  return `resources/sources/${iconName}`
}

const getMapThumbnail = (mapName: string | null | undefined) => {
  if (!mapName) return null
  const mapKey = mapName.toLowerCase()
  try {
    return `map://${mapKey}.png`
  } catch {
    return null
  }
}

export interface MatchListPanelProps {
  matches: Match[]
  sortedMatches: Match[]
  matchStats: Map<string, MatchStats>
  loading: boolean
  searchQuery: string
  setSearchQuery: (q: string) => void
  sortField: 'id' | 'length' | 'map' | 'date'
  setSortField: (f: 'id' | 'length' | 'map' | 'date') => void
  sortDirection: 'asc' | 'desc'
  setSortDirection: (d: 'asc' | 'desc') => void
  selectedMatches: Set<string>
  showDeleteModal: boolean
  setShowDeleteModal: (v: boolean) => void
  deleting: boolean
  enableDbViewer: boolean
  latestCS2Build: number | null
  onMatchClick: (matchId: string) => void
  onContextMenuAction: (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => void
  onToggleMatchSelection: (matchId: string) => void
  onAddToSelection: (matchIds: string[]) => void
  onClearSelection: () => void
  onDeleteSelected: () => void
  onAddDemo: () => void
}

export default function MatchListPanel({
  matches,
  sortedMatches,
  matchStats,
  loading,
  searchQuery,
  setSearchQuery,
  sortField,
  setSortField,
  sortDirection,
  setSortDirection,
  selectedMatches,
  showDeleteModal,
  setShowDeleteModal,
  deleting,
  enableDbViewer,
  latestCS2Build,
  onMatchClick,
  onContextMenuAction,
  onToggleMatchSelection,
  onAddToSelection,
  onClearSelection,
  onDeleteSelected,
  onAddDemo,
}: MatchListPanelProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; match: Match } | null>(null)
  const [dragBox, setDragBox] = useState<{
    startX: number
    startY: number
    curX: number
    curY: number
  } | null>(null)
  const [dragPreviewMatches, setDragPreviewMatches] = useState<Set<string>>(new Set())
  const panelRef = useRef<HTMLDivElement>(null)
  const accumulatedHitIdsRef = useRef<Set<string>>(new Set())

  const handleContextMenu = (e: React.MouseEvent, match: Match) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, match })
  }

  const handleContextMenuAction = (action: 'delete' | 'open' | 'showInDb' | 'reparse' | 'select' | 'showLogs', match: Match) => {
    setContextMenu(null)
    onContextMenuAction(action, match)
  }

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      setContextMenu(null)
    }
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [contextMenu])

  // Esc clears selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClearSelection()
      if (e.key === 'Delete' && selectedMatches.size > 0) setShowDeleteModal(true)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClearSelection, selectedMatches, setShowDeleteModal])

  // Document-level mousedown: allows drag to start from anywhere in the scroll container
  // (including padding areas to the left/right of the match grid).
  useEffect(() => {
    const handleDocMouseDown = (e: MouseEvent) => {
      if (!e.ctrlKey || e.button !== 0) return
      if (!panelRef.current) return

      const scrollContainer = findScrollContainer(panelRef.current)
      const container = scrollContainer ?? panelRef.current
      const rect = container.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return

      if (e.target instanceof HTMLElement) {
        let cur: HTMLElement | null = e.target
        while (cur) {
          if (isDragSelectionIgnoredTagName(cur.tagName)) return
          cur = cur.parentElement
        }
      }

      e.preventDefault()
      accumulatedHitIdsRef.current = new Set()
      setDragBox({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
    }

    document.addEventListener('mousedown', handleDocMouseDown)
    return () => document.removeEventListener('mousedown', handleDocMouseDown)
  }, [])

  useEffect(() => {
    if (!dragBox) return

    const getHitIds = (nextDragBox: NonNullable<typeof dragBox>) => {
      if (!hasDragSelectionMovement(nextDragBox)) return []

      const selectionRect = getDragSelectionRect(nextDragBox)
      const cards = Array.from(
        (panelRef.current ?? document).querySelectorAll<HTMLElement>('[data-match-id]')
      ).map((el) => {
        const rect = el.getBoundingClientRect()
        return { matchId: el.dataset.matchId ?? '', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      }).filter((card) => card.matchId)

      return getOverlappingMatchIds(cards, selectionRect)
    }

    const onMove = (e: MouseEvent) => {
      // Auto-scroll when cursor is near top/bottom edge of scroll container
      const scrollContainer = findScrollContainer(panelRef.current)
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect()
        const SCROLL_ZONE = 60
        const distFromTop = e.clientY - containerRect.top
        const distFromBottom = containerRect.bottom - e.clientY
        if (distFromTop >= 0 && distFromTop < SCROLL_ZONE) {
          scrollContainer.scrollTop -= Math.ceil((SCROLL_ZONE - distFromTop) / 5)
        } else if (distFromBottom >= 0 && distFromBottom < SCROLL_ZONE) {
          scrollContainer.scrollTop += Math.ceil((SCROLL_ZONE - distFromBottom) / 5)
        }
      }

      setDragBox((prev) => {
        if (!prev) return null
        const nextDragBox = { ...prev, curX: e.clientX, curY: e.clientY }
        // Accumulate hit IDs — items stay highlighted even after scrolling off screen
        getHitIds(nextDragBox).forEach((id) => accumulatedHitIdsRef.current.add(id))
        setDragPreviewMatches(new Set(accumulatedHitIdsRef.current))
        return nextDragBox
      })
    }

    const onUp = () => {
      setDragBox((prev) => {
        if (!prev) return null
        const hitIds = Array.from(accumulatedHitIdsRef.current)
        if (hitIds.length > 0) onAddToSelection(hitIds)
        setDragPreviewMatches(new Set())
        accumulatedHitIdsRef.current = new Set()
        return null
      })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragBox, onAddToSelection])

  const dragSelectionRect = dragBox ? getDragSelectionRect(dragBox) : null

  return (
    <div
      ref={panelRef}
      className="relative"
    >
      {/* Search and Sorting Controls */}
      {matches.length > 0 && (
        <div className="mb-4 space-y-3">
          {/* Search Bar + Add Demo */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder={t('matches.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 pl-10 bg-surface border border-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              <div className="absolute left-3 top-1/2 transform -translate-y-1/2">
                <svg
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
                  title={t('matches.clearSearch')}
                >
                  <X size={18} />
                </button>
              )}
            </div>
            <button
              onClick={onAddDemo}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors text-sm font-medium whitespace-nowrap"
            >
              <Upload size={16} />
              Add Demo
            </button>
          </div>

          {/* Results count */}
          {searchQuery && (
            <div className="text-sm text-gray-400">
              {t('matches.showingResults').replace('{showing}', sortedMatches.length.toString()).replace('{total}', matches.length.toString())}
            </div>
          )}

          {/* Sort Controls */}
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm text-gray-400">{t('matches.sortBy')}</span>
            <div className="flex gap-2">
            {(['date', 'id', 'length', 'map'] as const).map((field) => (
              <button
                key={field}
                onClick={() => {
                  if (sortField === field) {
                    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                  } else {
                    setSortField(field)
                    // Default to desc for date (newest first), asc for others
                    setSortDirection(field === 'date' ? 'desc' : 'asc')
                  }
                }}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  sortField === field
                    ? 'bg-accent text-white'
                    : 'bg-surface text-gray-300 hover:bg-surface/80'
                }`}
              >
                <span className="capitalize">
                  {field === 'length' ? t('matches.duration') : field === 'id' ? t('settings.id') : field === 'date' ? t('settings.date') : t('settings.map')}
                </span>
                {sortField === field && (
                  sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />
                )}
              </button>
            ))}
            </div>
            {selectedMatches.size > 0 && (
              <>
                <span className="text-sm text-accent font-medium ml-auto">
                  {t('matches.selected').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size > 1 ? 'es' : '')}
                </span>
                <button
                  onClick={onClearSelection}
                  className="px-3 py-1.5 text-sm text-gray-300 hover:text-white bg-surface border border-border rounded transition-colors"
                >
                  {t('matches.deselectAll')}
                </button>
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded transition-colors"
                >
                  <Trash2 size={14} />
                  {t('matches.deleteSelected')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {loading && matches.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
          <div className="text-gray-400">{t('matches.loading')}</div>
        </div>
      ) : (searchQuery && sortedMatches.length === 0) ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="text-center text-gray-400">
            <p className="text-lg mb-2">{t('matches.noMatches')}</p>
            <p className="text-sm">{t('matches.noMatchesSearch').replace('{query}', searchQuery)}</p>
            <button
              onClick={() => setSearchQuery('')}
              className="mt-4 px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded transition-colors text-sm"
            >
              {t('matches.clearSearch')}
            </button>
          </div>
        </div>
      ) : matches.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="flex flex-col items-center text-center text-gray-400">
            <Upload className="w-16 h-16 mx-auto mb-4 text-gray-500 opacity-50" />
            <p className="text-lg mb-2">{t('matches.noMatches')}</p>
            <p className="text-sm mb-4">{t('matches.parseToStart')}</p>
            <button
              onClick={onAddDemo}
              className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Upload size={16} />
              {t('matches.addDemo')}
            </button>
            <div className="mt-4 p-4 bg-surface/50 rounded-lg border border-gray-700/50 max-w-md">
              <p className="text-sm text-gray-300 mb-2 font-medium">{t('matches.dragDrop')}</p>
              <p className="text-xs text-gray-400">
                {t('matches.dragDropDesc')}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 gap-4 relative"
        >
          {sortedMatches.map((match) => {
            const thumbnail = getMapThumbnail(match.map)
            const stats = matchStats.get(match.id)
            const isSelected = selectedMatches.has(match.id)
            const isPreviewSelected = dragPreviewMatches.has(match.id)
            return (
              <div
                key={match.id}
                data-match-id={match.id}
                onContextMenu={(e) => handleContextMenu(e, match)}
                className={`bg-secondary rounded-lg border-2 overflow-hidden transition-all hover:shadow-xl group flex flex-col relative box-border ${
                  isSelected
                    ? 'border-accent'
                    : isPreviewSelected
                      ? 'border-accent/80 ring-2 ring-accent/30'
                    : 'border-transparent hover:border-accent/50'
                }`}
              >
                {(isSelected || isPreviewSelected) && (
                  <div className="absolute top-2 left-2 z-10">
                    <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                      isSelected
                        ? 'bg-accent border-accent'
                        : 'bg-accent/60 border-accent/80'
                    }`}>
                      <Check size={16} className="text-white" />
                    </div>
                  </div>
                )}
                <button
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault()
                      e.stopPropagation()
                      onToggleMatchSelection(match.id)
                    } else {
                      onMatchClick(match.id)
                    }
                  }}
                  className="flex-1 flex flex-col"
                >
                  <div className="relative h-64 bg-surface overflow-hidden w-full">
                    <LazyMapThumbnail
                      thumbnail={thumbnail}
                      alt={match.map || t('matches.unknownMap')}
                      className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                    {match.buildNum != null && latestCS2Build != null && String(match.buildNum).slice(0, 4) !== String(latestCS2Build).slice(0, 4) && (
                      <div
                        className="absolute top-2 right-2 z-10 px-1.5 py-0.5 text-xs font-semibold rounded bg-amber-500/90 text-black"
                        title={`Demo build: #${match.buildNum} · Current: #${latestCS2Build} · This version may no longer be playable in-game`}
                      >
                        Old Version
                      </div>
                    )}
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
                      <div className="font-semibold text-white text-base truncate">
                        {match.map || 'Unknown Map'}
                      </div>
                      {match.source && getSourceIcon(match.source) && (
                        <img
                          src={getSourceIcon(match.source)!}
                          alt={match.source}
                          className="h-5 w-5 flex-shrink-0 object-contain"
                          title={match.source}
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <div className="p-4 bg-secondary border-t border-border/50">
                    <div className="text-sm font-bold text-white font-mono mb-3 truncate text-left" title={match.id}>
                      {match.id}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap text-xs">
                      {stats && stats.roundCount > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500">{t('matches.rounds')}:</span>
                          <span className="text-sm font-semibold text-accent">
                            {stats.roundCount}
                          </span>
                        </div>
                      )}
                      {stats && stats.duration > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500">{t('matches.duration')}:</span>
                          <span className="text-sm font-semibold text-accent">
                            {formatDuration(stats.duration)}
                          </span>
                        </div>
                      )}
                      {stats && (stats.tWins > 0 || stats.ctWins > 0) && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500">{t('matches.score')}:</span>
                          <span className="text-sm font-semibold text-gray-300">
                            {t('matches.teamA')} {stats.tWins} - {t('matches.teamB')} {stats.ctWins}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">{t('matches.players')}:</span>
                        <span className="text-sm font-semibold text-gray-300">
                          {match.playerCount}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-secondary border border-border rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{
            left: `${Math.min(contextMenu.x, window.innerWidth - 200)}px`,
            top: `${Math.min(contextMenu.y, window.innerHeight - 150)}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleContextMenuAction('open', contextMenu.match)}
            disabled={!contextMenu.match.demoPath}
            className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            {t('matches.openFolder')}
          </button>
          <button
            onClick={() => handleContextMenuAction('reparse', contextMenu.match)}
            disabled={!contextMenu.match.demoPath}
            className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            {t('matches.reparseDemo')}
          </button>
          {enableDbViewer && (
            <button
              onClick={() => handleContextMenuAction('showInDb', contextMenu.match)}
              className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
            >
              <Database className="w-4 h-4" />
              {t('matches.showInDb')}
            </button>
          )}
          <button
            onClick={() => handleContextMenuAction('showLogs', contextMenu.match)}
            className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Show Parser Logs
          </button>
          {selectedMatches.has(contextMenu.match.id) ? (
            <button
              onClick={() => handleContextMenuAction('select', contextMenu.match)}
              className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              {t('matches.deselect')}
            </button>
          ) : (
            <button
              onClick={() => handleContextMenuAction('select', contextMenu.match)}
              className="w-full text-left px-4 py-2 text-sm text-white hover:bg-surface transition-colors flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              {t('matches.select')} (CTRL + Click)
            </button>
          )}
          <div className="border-t border-border my-1" />
          <button
            onClick={() => handleContextMenuAction('delete', contextMenu.match)}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-900/20 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => !deleting && setShowDeleteModal(false)}
        title={t('matches.deleteMatches')}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowDeleteModal(false)}
              disabled={deleting}
              className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {t('settings.cancel')}
            </button>
            <button
              onClick={onDeleteSelected}
              disabled={deleting}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {deleting ? t('settings.deleting') : t('matches.deleteButton').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size > 1 ? 'er' : '')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-red-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-white mb-2">
                {t('matches.deleteConfirmTitle')}
              </h3>
              <p className="text-sm text-gray-400 mb-2">
                {t('matches.deleteConfirmDesc').replace('{count}', selectedMatches.size.toString()).replace('{plural}', selectedMatches.size > 1 ? 'er' : '')}
              </p>
              <p className="text-sm text-red-400 font-medium">
                {t('matches.deleteConfirmWarning')}
              </p>
            </div>
          </div>
        </div>
      </Modal>

      {/* Rubber-band drag-select overlay */}
      {dragBox &&
        dragSelectionRect &&
        hasDragSelectionMovement(dragBox) && (
        <div
          style={{
            position: 'fixed',
            left:     dragSelectionRect.left,
            top:      dragSelectionRect.top,
            width:    dragSelectionRect.right - dragSelectionRect.left,
            height:   dragSelectionRect.bottom - dragSelectionRect.top,
            border:   '2px dashed #3b82f6',
            background: 'rgba(59,130,246,0.08)',
            pointerEvents: 'none',
            zIndex:   100,
            borderRadius: 4,
          }}
        />
      )}
    </div>
  )
}
