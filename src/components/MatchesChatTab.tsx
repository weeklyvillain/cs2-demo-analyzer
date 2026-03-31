import { useState } from 'react'
import { Copy } from 'lucide-react'
import type { PlayerScore } from '../types/matches'
import { t } from '../utils/translations'

interface MatchesChatTabProps {
  chatMessages: any[]
  scores: PlayerScore[]
  selectedMatchId: string
  onFetchChatMessages: (matchId: string, steamId?: string) => Promise<void>
  onCopyMessage: (message: string) => void
  onCopyAllChat: () => void
}

export default function MatchesChatTab({
  chatMessages,
  scores,
  selectedMatchId,
  onFetchChatMessages,
  onCopyMessage,
  onCopyAllChat,
}: MatchesChatTabProps) {
  const [chatFilterSteamId, setChatFilterSteamId] = useState<string | null>(null)
  const [chatViewMode] = useState<'all-chat'>('all-chat')
  const [loadingChat, setLoadingChat] = useState(false)

  const getPlayerName = (steamId: string) => {
    const player = scores.find((p) => p.steamId === steamId)
    return player?.name || steamId
  }

  void chatViewMode // declared but not yet used in the UI

  return (
    <div className="space-y-4">
      {/* Filter by player and view mode */}
      <div className="bg-surface rounded-lg border border-border p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-300">{t('matches.filterByPlayer')}</label>
          <select
            value={chatFilterSteamId || ''}
            onChange={async (e) => {
              const steamId = e.target.value || null
              setChatFilterSteamId(steamId)
              if (selectedMatchId) {
                setLoadingChat(true)
                try {
                  await onFetchChatMessages(selectedMatchId, steamId || undefined)
                } finally {
                  setLoadingChat(false)
                }
              }
            }}
            className="px-3 py-1.5 bg-secondary border border-border rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('matches.allPlayers')}</option>
            {scores.map((score) => (
              <option key={score.steamId} value={score.steamId}>
                {score.name || score.steamId}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 ml-auto">
            {chatMessages.length > 0 && (
              <button
                onClick={onCopyAllChat}
                className="px-3 py-1.5 bg-secondary hover:bg-secondary/80 border border-border rounded text-white text-sm flex items-center gap-2 transition-colors"
                title={t('matches.copyAllChat')}
              >
                <Copy size={14} />
                {t('matches.copyAll')}
              </button>
            )}
            <span className="text-sm text-gray-400">{t('matches.allChatOnly')}</span>
          </div>
        </div>
      </div>

      {/* Chat messages */}
      {loadingChat ? (
        <div className="text-center text-gray-400 py-8">{t('matches.loadingChat')}</div>
      ) : chatMessages.length === 0 ? (
        <div className="text-center text-gray-400 py-8">{t('matches.noChatMessages')}</div>
      ) : (
        <div className="grid gap-4 grid-cols-1">
          {/* All Chat Section */}
          {(
            <div className="bg-surface rounded-lg border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-accent/20">
                <h3 className="text-lg font-semibold text-accent">{t('matches.allChat')}</h3>
                <p className="text-xs text-gray-500">
                  {chatMessages.length} {t('matches.messages')}
                </p>
              </div>
              <div className="max-h-[600px] overflow-y-auto">
                {chatMessages.length === 0 ? (
                  <div className="text-center text-gray-500 py-8 text-sm">{t('matches.noChatMessagesInSection')}</div>
                ) : (
                  <div className="divide-y divide-border">
                    {chatMessages
                      .map((msg, idx) => {
                        const timeSeconds = msg.tick / 64
                        const minutes = Math.floor(timeSeconds / 60)
                        const seconds = Math.floor(timeSeconds % 60)
                        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

                        const fullMessage = `${msg.name || msg.steamid}: ${msg.message}`
                        const isServer = (msg.name || msg.steamid || '').toLowerCase() === '*server*'

                        return (
                          <div key={`all-${idx}`} className="p-3 hover:bg-secondary/50 transition-colors group">
                            <div className="flex items-start gap-3">
                              <div className="flex-shrink-0">
                                <div className="text-xs font-mono text-gray-500">
                                  {t('matches.round')} {msg.roundIndex + 1}
                                </div>
                                <div className="text-xs text-gray-500">{timeStr}</div>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  {msg.name ? (
                                    <span className={`font-medium text-accent ${isServer ? 'italic' : ''}`}>
                                      {msg.name}
                                    </span>
                                  ) : (
                                    <button
                                      onClick={async () => {
                                        if (window.electronAPI?.openExternal) {
                                          await window.electronAPI.openExternal(`https://steamcommunity.com/profiles/${msg.steamid}`)
                                        } else {
                                          window.open(`https://steamcommunity.com/profiles/${msg.steamid}`, '_blank')
                                        }
                                      }}
                                      className="font-medium text-accent hover:text-accent/80 underline bg-transparent border-none cursor-pointer p-0"
                                    >
                                      {msg.steamid}
                                    </button>
                                  )}
                                  {msg.team && (
                                    <span className={`text-xs text-gray-500 px-1.5 py-0.5 rounded ${
                                      msg.team === 'T'
                                        ? 'bg-orange-900/20'
                                        : 'bg-blue-900/20'
                                    }`}>
                                      {msg.team}
                                    </span>
                                  )}
                                  <button
                                    onClick={() => onCopyMessage(fullMessage)}
                                    className="ml-auto p-1 hover:bg-accent/20 rounded transition-colors opacity-0 group-hover:opacity-100"
                                    title={t('matches.copyMessage')}
                                  >
                                    <Copy size={14} className="text-gray-400 hover:text-accent" />
                                  </button>
                                </div>
                                <div className="text-sm text-gray-300 break-words">
                                  {msg.message}
                                  {(msg as any).isDisconnect && (msg as any).steamid && (
                                    <span className="text-xs text-gray-500 ml-2">
                                      ({getPlayerName((msg as any).steamid)})
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
