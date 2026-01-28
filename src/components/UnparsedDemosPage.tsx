import { useState, useEffect } from 'react'
import { Loader2, Play, FolderOpen, Search } from 'lucide-react'
import { t } from '../utils/translations'
import Toast from './Toast'
import ParsingModal from './ParsingModal'

interface UnparsedDemo {
  fileName: string
  filePath: string
  fileSize: number
  createdAt: string
}

function UnparsedDemosPage() {
  const [demos, setDemos] = useState<UnparsedDemo[]>([])
  const [filteredDemos, setFilteredDemos] = useState<UnparsedDemo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type?: 'success' | 'error' | 'info' } | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [selectedDemos, setSelectedDemos] = useState<Set<string>>(new Set())
  const [showParsingModal, setShowParsingModal] = useState(false)
  const [demosToParse, setDemosToParse] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'size'>('date')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  const fetchUnparsedDemos = async () => {
    if (!window.electronAPI) {
      setError(t('unparsedDemos.electronApiNotAvailable'))
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const data = await window.electronAPI.getUnparsedDemos()
      setDemos(data)
      setSelectedDemos(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unparsedDemos.failedToLoad'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUnparsedDemos()
    
    // Listen for file changes and refresh when new demos are detected
    if (window.electronAPI?.onDemosFileAdded) {
      const unsubscribeAdded = window.electronAPI.onDemosFileAdded(({ filePath }) => {
        console.log('[UnparsedDemosPage] New demo file detected:', filePath)
        // Refresh the list after a short delay (to allow file to be fully written)
        setTimeout(() => {
          fetchUnparsedDemos()
        }, 1000)
      })
      
      const unsubscribeRemoved = window.electronAPI.onDemosFileRemoved(({ filePath }) => {
        console.log('[UnparsedDemosPage] Demo file removed:', filePath)
        // Refresh the list
        fetchUnparsedDemos()
      })
      
      return () => {
        if (window.electronAPI) {
          window.electronAPI.removeAllListeners('demos:fileAdded')
          window.electronAPI.removeAllListeners('demos:fileRemoved')
        }
      }
    }
  }, [])

  // Filter and sort demos
  useEffect(() => {
    let filtered = demos.filter((demo) =>
      demo.fileName.toLowerCase().includes(searchQuery.toLowerCase())
    )

    filtered.sort((a, b) => {
      let comparison = 0
      if (sortBy === 'name') {
        comparison = a.fileName.localeCompare(b.fileName)
      } else if (sortBy === 'date') {
        comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      } else if (sortBy === 'size') {
        comparison = a.fileSize - b.fileSize
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })

    setFilteredDemos(filtered)
  }, [demos, searchQuery, sortBy, sortDirection])

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedDemos(new Set(filteredDemos.map((d) => d.filePath)))
    } else {
      setSelectedDemos(new Set())
    }
  }

  const handleToggleDemo = (filePath: string) => {
    const newSelected = new Set(selectedDemos)
    if (newSelected.has(filePath)) {
      newSelected.delete(filePath)
    } else {
      newSelected.add(filePath)
    }
    setSelectedDemos(newSelected)
  }

  const handleParseSelected = () => {
    if (selectedDemos.size === 0) {
      setToast({ message: t('unparsedDemos.selectDemosFirst'), type: 'info' })
      return
    }
    setDemosToParse(Array.from(selectedDemos))
    setShowParsingModal(true)
  }

  const handleParseOne = (filePath: string) => {
    setDemosToParse([filePath])
    setShowParsingModal(true)
  }

  const handleShowInFolder = async (filePath: string) => {
    try {
      await window.electronAPI?.showFileInFolder(filePath)
    } catch (err) {
      setToast({ message: t('unparsedDemos.failedToShowInFolder'), type: 'error' })
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-primary text-white p-6 overflow-hidden">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">{t('unparsedDemos.title')}</h1>
        <p className="text-gray-400">{t('unparsedDemos.description')}</p>
      </div>

      {/* Controls */}
      <div className="mb-6 space-y-4">
        {/* Search and Actions */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-64">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder={t('unparsedDemos.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
            </div>
          </div>
          <button
            onClick={() => handleParseSelected()}
            disabled={selectedDemos.size === 0 || loading}
            className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 flex items-center gap-2 transition-colors"
          >
            <Play className="w-4 h-4" />
            {t('unparsedDemos.parseSelected')} ({selectedDemos.size})
          </button>
        </div>

        {/* Sort controls */}
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-400">{t('unparsedDemos.sortBy')}:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'name' | 'date' | 'size')}
            className="px-3 py-1 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:border-accent"
          >
            <option value="name">{t('unparsedDemos.sortByName')}</option>
            <option value="date">{t('unparsedDemos.sortByDate')}</option>
            <option value="size">{t('unparsedDemos.sortBySize')}</option>
          </select>
          <button
            onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
            className="px-3 py-1 bg-surface border border-border rounded text-white text-sm hover:bg-surface/80 transition-colors"
          >
            {sortDirection === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-accent" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-red-400 mb-4">{error}</p>
              <button
                onClick={() => fetchUnparsedDemos()}
                className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors"
              >
                {t('unparsedDemos.retry')}
              </button>
            </div>
          </div>
        ) : demos.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-gray-400 text-lg">{t('unparsedDemos.noDemosFound')}</p>
              <p className="text-gray-500 text-sm mt-2">{t('unparsedDemos.checkFolderSettings')}</p>
            </div>
          </div>
        ) : filteredDemos.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-400">{t('unparsedDemos.noMatches')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Header row with checkbox */}
            <div className="sticky top-0 bg-surface p-4 rounded border border-border flex items-center gap-4">
              <input
                type="checkbox"
                checked={selectedDemos.size === filteredDemos.length && filteredDemos.length > 0}
                onChange={(e) => handleSelectAll(e.target.checked)}
                className="w-4 h-4 cursor-pointer"
              />
              <div className="flex-1 grid grid-cols-12 gap-4 text-sm font-semibold text-gray-400">
                <div className="col-span-6">{t('unparsedDemos.fileName')}</div>
                <div className="col-span-2">{t('unparsedDemos.fileSize')}</div>
                <div className="col-span-3">{t('unparsedDemos.created')}</div>
                <div className="col-span-1 text-right">{t('unparsedDemos.actions')}</div>
              </div>
            </div>

            {/* Demo rows */}
            {filteredDemos.map((demo) => (
              <div
                key={demo.filePath}
                className="bg-surface p-4 rounded border border-border hover:border-accent/50 transition-colors flex items-center gap-4"
              >
                <input
                  type="checkbox"
                  checked={selectedDemos.has(demo.filePath)}
                  onChange={() => handleToggleDemo(demo.filePath)}
                  className="w-4 h-4 cursor-pointer"
                />
                <div className="flex-1 grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-6 truncate">
                    <div className="text-white font-mono text-sm truncate" title={demo.fileName}>
                      {demo.fileName}
                    </div>
                  </div>
                  <div className="col-span-2 text-gray-400 text-sm">{formatFileSize(demo.fileSize)}</div>
                  <div className="col-span-3 text-gray-400 text-sm">{formatDate(demo.createdAt)}</div>
                  <div className="col-span-1 flex justify-end gap-2">
                    <button
                      onClick={() => handleParseOne(demo.filePath)}
                      className="p-2 hover:bg-accent/20 rounded transition-colors"
                      title={t('unparsedDemos.parse')}
                    >
                      <Play className="w-4 h-4 text-accent" />
                    </button>
                    <button
                      onClick={() => handleShowInFolder(demo.filePath)}
                      className="p-2 hover:bg-accent/20 rounded transition-colors"
                      title={t('unparsedDemos.showInFolder')}
                    >
                      <FolderOpen className="w-4 h-4 text-accent" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Parsing Modal */}
      {showParsingModal && (
        <ParsingModal
          demosToParse={demosToParse}
          onClose={() => {
            setShowParsingModal(false)
            fetchUnparsedDemos()
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}

export default UnparsedDemosPage
