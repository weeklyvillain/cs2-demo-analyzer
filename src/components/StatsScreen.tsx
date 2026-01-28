import { useState, useEffect } from 'react'
import { BarChart3, RefreshCw, Trash2, HardDrive, Clock, Users, Volume2 } from 'lucide-react'
import Modal from './Modal'
import Toast from './Toast'
import { t, getLanguage } from '../utils/translations'

interface Stats {
  total_demos_parsed: number
  total_voices_extracted: number
  largest_demo_parsed: number
  smallest_demo_parsed: number
  total_demo_size: number
  total_parsing_time_ms: number
  fastest_parsing_time_ms: number
  slowest_parsing_time_ms: number
  total_voice_extraction_ms: number
  shortest_voice_extraction_ms: number
  longest_voice_extraction_ms: number
  voice_files_generated: number
  [key: string]: number
}

function StatsScreen() {
  const [stats, setStats] = useState<Stats>({
    total_demos_parsed: 0,
    total_voices_extracted: 0,
    largest_demo_parsed: 0,
    smallest_demo_parsed: 0,
    total_demo_size: 0,
    total_parsing_time_ms: 0,
    fastest_parsing_time_ms: 0,
    slowest_parsing_time_ms: 0,
    total_voice_extraction_ms: 0,
    shortest_voice_extraction_ms: 0,
    longest_voice_extraction_ms: 0,
    voice_files_generated: 0,
  })
  const [loading, setLoading] = useState(true)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' | 'info' } | null>(null)
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    loadStats()
  }, [])

  // Subscribe to language changes
  useEffect(() => {
    const checkLanguage = () => {
      forceUpdate((prev) => prev + 1)
    }
    // Check language every second (simple polling approach)
    const interval = setInterval(checkLanguage, 1000)
    return () => clearInterval(interval)
  }, [])

  const loadStats = async () => {
    if (!window.electronAPI) {
      setLoading(false)
      return
    }

    try {
      const allStats = await window.electronAPI.getAllStats()
      setStats(allStats)
    } catch (err) {
      console.error('Failed to load stats:', err)
      setToast({ message: t('stats.loadFailed'), type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async () => {
    if (!window.electronAPI) return

    try {
      await window.electronAPI.resetStats()
      await loadStats()
      setShowResetConfirm(false)
      setToast({ message: t('stats.resetSuccess'), type: 'success' })
    } catch (err) {
      console.error('Failed to reset stats:', err)
      setToast({ message: t('stats.resetFailed'), type: 'error' })
    }
  }

  // Extract map stats
  const mapStats = Object.entries(stats)
    .filter(([key]) => key.startsWith('map_parsed_'))
    .map(([key, value]) => ({
      map: key.replace('map_parsed_', ''),
      count: value,
    }))
    .sort((a, b) => b.count - a.count)

  // Format map name for display
  const formatMapName = (mapName: string): string => {
    // Remove 'de_' prefix and capitalize
    const cleaned = mapName.replace(/^de_/, '')
    return cleaned
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  // Format bytes to human-readable size
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  // Format milliseconds to human-readable time
  const formatTime = (ms: number): string => {
    const seconds = Math.floor((ms / 1000) % 60)
    const minutes = Math.floor((ms / (1000 * 60)) % 60)
    const hours = Math.floor(ms / (1000 * 60 * 60))
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`
    } else {
      return `${seconds}s`
    }
  }

  // Format milliseconds to hours
  const formatHours = (ms: number): string => {
    const hours = ms / (1000 * 60 * 60)
    return hours.toFixed(2)
  }

  // Calculate average demo size
  const averageDemoSize = stats.total_demos_parsed > 0 
    ? stats.total_demo_size / stats.total_demos_parsed 
    : 0

  // Calculate average parsing time
  const averageParsingTime = stats.total_demos_parsed > 0 
    ? stats.total_parsing_time_ms / stats.total_demos_parsed 
    : 0

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-gray-400">{t('stats.loading')}</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-auto">
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 size={24} className="text-accent" />
          <h1 className="text-2xl font-bold text-white">{t('stats.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadStats}
            className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors flex items-center gap-2"
            title={t('stats.refreshTitle')}
          >
            <RefreshCw size={16} />
            {t('stats.refresh')}
          </button>
          <button
            onClick={() => setShowResetConfirm(true)}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center gap-2"
            title={t('stats.resetTitle')}
          >
            <Trash2 size={16} />
            {t('stats.resetStats')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Overall Stats */}
        <div className="bg-secondary rounded-lg border border-border p-6">
          <h2 className="text-lg font-semibold text-white mb-4">{t('stats.overallStatistics')}</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.totalDemosParsed')}</span>
              <span className="text-2xl font-bold text-accent">{stats.total_demos_parsed || 0}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.totalVoicesExtracted')}</span>
              <span className="text-2xl font-bold text-accent">{stats.voice_files_generated || 0}</span>
            </div>
          </div>
        </div>

        {/* Performance Statistics */}
        <div className="bg-secondary rounded-lg border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-white">{t('stats.performanceStats')}</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.largestDemo')}</span>
              <span className="text-lg font-semibold text-accent">{formatBytes(stats.largest_demo_parsed || 0)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.smallestDemo')}</span>
              <span className="text-lg font-semibold text-accent">{formatBytes(stats.smallest_demo_parsed || 0)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.averageDemo')}</span>
              <span className="text-lg font-semibold text-accent">{formatBytes(averageDemoSize)}</span>
            </div>
          </div>
        </div>

        {/* Time Statistics */}
        <div className="bg-secondary rounded-lg border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-white">{t('stats.timeStats')}</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.totalParsingTime')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(stats.total_parsing_time_ms || 0)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.averageParsingTime')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(averageParsingTime)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.fastestParsingTime')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(stats.fastest_parsing_time_ms || 0)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.slowestParsingTime')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(stats.slowest_parsing_time_ms || 0)}</span>
            </div>
          </div>
        </div>

        {/* Extraction Statistics */}
        <div className="bg-secondary rounded-lg border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Volume2 size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-white">{t('stats.extractionStats')}</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.voiceFilesGenerated')}</span>
              <span className="text-lg font-semibold text-accent">{stats.voice_files_generated || 0}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.totalVoiceExtracted')}</span>
              <span className="text-lg font-semibold text-accent">{formatHours(stats.total_voice_extraction_ms || 0)} h</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.shortestVoiceExtraction')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(stats.shortest_voice_extraction_ms || 0)}</span>
            </div>
            <div className="flex items-center justify-between p-4 bg-surface rounded">
              <span className="text-gray-300">{t('stats.longestVoiceExtraction')}</span>
              <span className="text-lg font-semibold text-accent">{formatTime(stats.longest_voice_extraction_ms || 0)}</span>
            </div>
          </div>
        </div>

        {/* Map Statistics */}
        <div className="bg-secondary rounded-lg border border-border p-6 md:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Users size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-white">{t('stats.mapsParsed')}</h2>
          </div>
          {mapStats.length === 0 ? (
            <div className="text-center text-gray-400 py-8">{t('stats.noMapStatistics')}</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
              {mapStats.map(({ map, count }) => (
                <div
                  key={map}
                  className="flex items-center justify-between p-3 bg-surface rounded hover:bg-surface/80 transition-colors"
                >
                  <span className="text-gray-300">{formatMapName(map)}</span>
                  <span className="text-lg font-semibold text-accent">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <Modal
          isOpen={showResetConfirm}
          onClose={() => setShowResetConfirm(false)}
          title={t('stats.resetConfirmTitle')}
          canClose={true}
        >
          <div className="p-6">
            <p className="text-gray-300 mb-6">
              {t('stats.resetConfirmMessage')}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 bg-surface hover:bg-surface/80 text-white rounded transition-colors"
              >
                {t('settings.cancel')}
              </button>
              <button
                onClick={handleReset}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                {t('stats.resetStats')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default StatsScreen
