import { useState, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'

interface WhatsNewModalProps {
  version: string
  onClose: () => void
}

// Fallback changelog for offline use or if GitHub API fails
const FALLBACK_CHANGELOG: Record<string, { title: string; items: string[] }> = {
  '1.0.18': {
    title: 'What\'s New in Version 1.0.18',
    items: [
      'Added defuse griefing detection',
      'Improved AFK detection accuracy',
      'Enhanced event visualization in 2D viewer',
      'Bug fixes and performance improvements',
    ],
  },
}

export default function WhatsNewModal({ version, onClose }: WhatsNewModalProps) {
  const [changelog, setChangelog] = useState<{ title: string; items: string[] }>({
    title: `What's New in Version ${version}`,
    items: ['Loading release notes...'],
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadReleaseNotes = async () => {
      if (!window.electronAPI) {
        // Fallback if no electron API
        const fallback = FALLBACK_CHANGELOG[version] || {
          title: `What's New in Version ${version}`,
          items: ['Bug fixes and improvements'],
        }
        setChangelog(fallback)
        setLoading(false)
        return
      }

      try {
        // Try to fetch from GitHub releases
        const notes = await window.electronAPI.getReleaseNotes(version)
        if (notes) {
          setChangelog(notes)
        } else {
          // Fallback to hardcoded changelog
          const fallback = FALLBACK_CHANGELOG[version] || {
            title: `What's New in Version ${version}`,
            items: ['Bug fixes and improvements'],
          }
          setChangelog(fallback)
        }
      } catch (error) {
        console.error('Failed to load release notes:', error)
        // Fallback to hardcoded changelog
        const fallback = FALLBACK_CHANGELOG[version] || {
          title: `What's New in Version ${version}`,
          items: ['Bug fixes and improvements'],
        }
        setChangelog(fallback)
      } finally {
        setLoading(false)
      }
    }

    loadReleaseNotes()
  }, [version])

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-secondary border border-border rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <h2 className="text-2xl font-bold text-white">{changelog.title}</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-surface rounded transition-colors"
            title="Close"
          >
            <X size={20} className="text-gray-400 hover:text-white" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
          ) : (
            <div className="space-y-3">
              {changelog.items.map((item, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <div className="w-2 h-2 rounded-full bg-accent mt-2 flex-shrink-0" />
                  <p className="text-gray-300 text-sm leading-relaxed">{item}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-accent hover:bg-accent/80 text-white rounded transition-colors font-medium"
          >
            Got it!
          </button>
        </div>
      </div>
    </div>
  )
}
