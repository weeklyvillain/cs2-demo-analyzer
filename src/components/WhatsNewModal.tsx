import { useState, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'

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
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw, rehypeHighlight]}
                components={{
                  h1: ({ children }) => <h1 className="text-2xl font-bold text-white mb-4 mt-6 first:mt-0 border-b border-border pb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-xl font-semibold text-white mb-3 mt-5 border-b border-border pb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-lg font-semibold text-white mb-2 mt-4">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-base font-semibold text-white mb-2 mt-3">{children}</h4>,
                  h5: ({ children }) => <h5 className="text-sm font-semibold text-white mb-2 mt-3">{children}</h5>,
                  h6: ({ children }) => <h6 className="text-xs font-semibold text-white mb-2 mt-3">{children}</h6>,
                  p: ({ children }) => <p className="text-gray-300 mb-3 leading-relaxed">{children}</p>,
                  ul: ({ children, className }) => {
                    const isTaskList = className?.includes('contains-task-list')
                    return (
                      <ul className={`${isTaskList ? 'list-none' : 'list-disc'} list-inside mb-3 space-y-1.5 text-gray-300 ${className || ''}`}>
                        {children}
                      </ul>
                    )
                  },
                  ol: ({ children }) => (
                    <ol className="list-decimal list-inside mb-3 space-y-1.5 text-gray-300">{children}</ol>
                  ),
                  li: ({ children, className, checked }) => {
                    const isTaskItem = className?.includes('task-list-item')
                    if (isTaskItem) {
                      return (
                        <li className={`flex items-start gap-2 ${className || ''}`}>
                          <input
                            type="checkbox"
                            checked={checked || false}
                            disabled
                            className="mt-1.5 w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent"
                          />
                          <span>{children}</span>
                        </li>
                      )
                    }
                    return <li className="ml-4">{children}</li>
                  },
                  code: ({ children, className, ...props }) => {
                    const isInline = !className
                    const language = className?.replace('language-', '') || ''
                    return isInline ? (
                      <code className="bg-surface px-1.5 py-0.5 rounded text-accent text-sm font-mono" {...props}>
                        {children}
                      </code>
                    ) : (
                      <code
                        className={`block bg-surface p-3 rounded text-sm font-mono overflow-x-auto ${className || ''}`}
                        {...props}
                      >
                        {children}
                      </code>
                    )
                  },
                  pre: ({ children }) => {
                    // Extract language from code element if present
                    const codeProps = (children as any)?.props
                    const className = codeProps?.className || ''
                    const language = className?.replace('hljs language-', '').replace('language-', '') || ''
                    
                    return (
                      <div className="relative mb-3">
                        {language && (
                          <div className="text-xs text-gray-500 px-3 py-1 bg-surface/50 rounded-t border-b border-border">
                            {language}
                          </div>
                        )}
                        <pre className={`bg-surface ${language ? 'rounded-b' : 'rounded'} p-3 overflow-x-auto border border-border`}>
                          {children}
                        </pre>
                      </div>
                    )
                  },
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:text-accent/80 underline break-words"
                    >
                      {children}
                    </a>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-accent pl-4 italic text-gray-400 my-3 bg-surface/30 py-2 rounded-r">
                      {children}
                    </blockquote>
                  ),
                  hr: () => <hr className="border-border my-6" />,
                  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  del: ({ children }) => <del className="line-through text-gray-500">{children}</del>,
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-4">
                      <table className="min-w-full border-collapse border border-border rounded">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-surface">{children}</thead>
                  ),
                  tbody: ({ children }) => (
                    <tbody className="divide-y divide-border">{children}</tbody>
                  ),
                  tr: ({ children }) => (
                    <tr className="hover:bg-surface/30">{children}</tr>
                  ),
                  th: ({ children, align }) => (
                    <th
                      className={`px-4 py-2 text-left font-semibold text-white border border-border ${
                        align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : ''
                      }`}
                    >
                      {children}
                    </th>
                  ),
                  td: ({ children, align }) => (
                    <td
                      className={`px-4 py-2 text-gray-300 border border-border ${
                        align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : ''
                      }`}
                    >
                      {children}
                    </td>
                  ),
                  img: ({ src, alt, title, width, height, ...props }) => {
                    // Convert relative image URLs to absolute GitHub URLs
                    let imageSrc = src || ''
                    
                    // Handle GitHub user-attachments URLs (they're already absolute, no conversion needed)
                    // https://github.com/user-attachments/assets/...
                    
                    if (imageSrc && !imageSrc.startsWith('http://') && !imageSrc.startsWith('https://') && !imageSrc.startsWith('data:')) {
                      // Handle relative URLs - GitHub release assets are typically at:
                      // https://github.com/owner/repo/releases/download/tag/filename
                      // But in markdown they might be relative like ./image.png or image.png
                      const repoOwner = 'weeklyvillain'
                      const repoName = 'cs2-demo-analyzer'
                      
                      // If it's a relative path, try to construct the GitHub release asset URL
                      if (imageSrc.startsWith('./')) {
                        imageSrc = imageSrc.substring(2)
                      }
                      
                      // Remove leading slash if present
                      if (imageSrc.startsWith('/')) {
                        imageSrc = imageSrc.substring(1)
                      }
                      
                      // Try to get the release tag from the version
                      const releaseTag = `v${version.replace(/^v/, '')}`
                      imageSrc = `https://github.com/${repoOwner}/${repoName}/releases/download/${releaseTag}/${imageSrc}`
                    } else if (imageSrc && imageSrc.startsWith('https://github.com/') && !imageSrc.includes('/releases/download/') && !imageSrc.includes('raw.githubusercontent.com') && !imageSrc.includes('user-attachments')) {
                      // Handle GitHub blob URLs - convert to raw.githubusercontent.com
                      // https://github.com/owner/repo/blob/branch/path/image.png
                      // -> https://raw.githubusercontent.com/owner/repo/branch/path/image.png
                      imageSrc = imageSrc
                        .replace('github.com/', 'raw.githubusercontent.com/')
                        .replace('/blob/', '/')
                    }
                    
                    console.log(`[WhatsNewModal] Loading image: ${imageSrc}`)
                    
                    // Convert width/height to numbers if they're strings
                    const imgWidth = width ? (typeof width === 'string' ? parseInt(width, 10) : width) : undefined
                    const imgHeight = height ? (typeof height === 'string' ? parseInt(height, 10) : height) : undefined
                    
                    return (
                      <img
                        src={imageSrc}
                        alt={alt || ''}
                        title={title || alt || ''}
                        width={imgWidth}
                        height={imgHeight}
                        className="max-w-full h-auto rounded my-4 border border-border"
                        loading="lazy"
                        onError={(e) => {
                          console.error(`[WhatsNewModal] Failed to load image: ${imageSrc}`, e)
                          // Show a placeholder instead of hiding
                          const target = e.target as HTMLImageElement
                          target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzIxMjQyOCIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM2NjY2NjYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5JbWFnZSBub3QgZm91bmQ8L3RleHQ+PC9zdmc+'
                          target.alt = alt || 'Image not found'
                        }}
                        onLoad={() => {
                          console.log(`[WhatsNewModal] Successfully loaded image: ${imageSrc}`)
                        }}
                        {...props}
                      />
                    )
                  },
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
