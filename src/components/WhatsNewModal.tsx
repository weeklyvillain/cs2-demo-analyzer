import { useState, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

interface WhatsNewModalProps {
  version: string
  onClose: () => void
}

// Fallback changelog for offline use or if GitHub API fails
const FALLBACK_CHANGELOG: Record<string, { title: string; body: string }> = {
  '1.0.18': {
    title: 'What\'s New in Version 1.0.18',
    body: `- Added defuse griefing detection
- Improved AFK detection accuracy
- Enhanced event visualization in 2D viewer
- Bug fixes and performance improvements`,
  },
}

export default function WhatsNewModal({ version, onClose }: WhatsNewModalProps) {
  const [changelog, setChangelog] = useState<{ title: string; body: string }>({
    title: `What's New in Version ${version}`,
    body: 'Loading release notes...',
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadReleaseNotes = async () => {
      if (!window.electronAPI) {
        // Fallback if no electron API
        const fallback = FALLBACK_CHANGELOG[version] || {
          title: `What's New in Version ${version}`,
          body: 'Bug fixes and improvements',
        }
        setChangelog(fallback)
        setLoading(false)
        return
      }

      try {
        // Try to fetch from GitHub releases
        console.log(`[WhatsNewModal] Fetching release notes for version: ${version}`)
        const notes = await window.electronAPI.getReleaseNotes(version)
        console.log(`[WhatsNewModal] Received notes:`, notes ? { title: notes.title, bodyLength: notes.body?.length || 0 } : 'null')
        
        if (notes && notes.body && notes.body.trim().length > 0) {
          console.log(`[WhatsNewModal] Using GitHub release notes`)
          setChangelog(notes)
        } else {
          console.log(`[WhatsNewModal] No valid release notes found, using fallback`)
          // Fallback to hardcoded changelog
          const fallback = FALLBACK_CHANGELOG[version] || {
            title: `What's New in Version ${version}`,
            body: 'Bug fixes and improvements',
          }
          setChangelog(fallback)
        }
      } catch (error) {
        console.error('[WhatsNewModal] Failed to load release notes:', error)
        // Fallback to hardcoded changelog
        const fallback = FALLBACK_CHANGELOG[version] || {
          title: `What's New in Version ${version}`,
          body: 'Bug fixes and improvements',
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
            <div className="prose prose-invert prose-sm max-w-none text-gray-300">
              <ReactMarkdown
                components={{
                  h1: ({ children }) => <h1 className="text-2xl font-bold text-white mb-4 mt-6 first:mt-0">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-xl font-semibold text-white mb-3 mt-5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-lg font-semibold text-white mb-2 mt-4">{children}</h3>,
                  p: ({ children }) => <p className="text-gray-300 mb-3 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside mb-3 space-y-1 text-gray-300">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside mb-3 space-y-1 text-gray-300">{children}</ol>,
                  li: ({ children }) => <li className="ml-4">{children}</li>,
                  code: ({ children, className }) => {
                    const isInline = !className
                    return isInline ? (
                      <code className="bg-surface px-1.5 py-0.5 rounded text-accent text-sm font-mono">{children}</code>
                    ) : (
                      <code className="block bg-surface p-3 rounded text-accent text-sm font-mono overflow-x-auto mb-3">{children}</code>
                    )
                  },
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80 underline">
                      {children}
                    </a>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-accent pl-4 italic text-gray-400 my-3">{children}</blockquote>
                  ),
                  hr: () => <hr className="border-border my-4" />,
                  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                }}
              >
                {changelog.body}
              </ReactMarkdown>
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
