import { contextBridge, ipcRenderer } from 'electron'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog
  openFileDialog: (allowMultiple?: boolean) => ipcRenderer.invoke('dialog:openFile', allowMultiple),

  // Parser
  parseDemo: (args: { demoPath: string }) => ipcRenderer.invoke('parser:parse', args),
  stopParser: () => ipcRenderer.invoke('parser:stop'),

  // Matches
  listMatches: () => ipcRenderer.invoke('matches:list'),
  getMatchSummary: (matchId: string) => ipcRenderer.invoke('matches:summary', matchId),
  getMatchPlayers: (matchId: string) => ipcRenderer.invoke('matches:players', matchId),
  getMatchEvents: (matchId: string, filters?: { type?: string; steamid?: string; round?: number }) =>
    ipcRenderer.invoke('matches:events', matchId, filters),
  getMatchRounds: (matchId: string) => ipcRenderer.invoke('matches:rounds', matchId),
  getMatchChat: (matchId: string, steamid?: string) => ipcRenderer.invoke('matches:chat', matchId, steamid),
  getMatchPositions: (matchId: string, roundIndex: number, tick: number) => ipcRenderer.invoke('matches:positions', matchId, roundIndex, tick),
  getMatchPositionsForRound: (matchId: string, roundIndex: number) => ipcRenderer.invoke('matches:positionsForRound', matchId, roundIndex),
  getGrenadePositionsForRound: (matchId: string, roundIndex: number) => ipcRenderer.invoke('matches:grenadePositionsForRound', matchId, roundIndex),
  getGrenadeEventsForRound: (matchId: string, roundIndex: number) => ipcRenderer.invoke('matches:grenadeEventsForRound', matchId, roundIndex),
  getShotsForRound: (matchId: string, roundIndex: number) => ipcRenderer.invoke('matches:shotsForRound', matchId, roundIndex),
  deleteMatches: (matchIds: string[]) => ipcRenderer.invoke('matches:delete', matchIds),
  deleteAllMatches: () => ipcRenderer.invoke('matches:deleteAll'),
  trimMatchesToCap: (cap: number) => ipcRenderer.invoke('matches:trimToCap', cap),
  
  // DB Viewer
  listTables: (matchId: string) => ipcRenderer.invoke('db:listTables', matchId),
  getTableInfo: (matchId: string, tableName: string) => ipcRenderer.invoke('db:getTableInfo', matchId, tableName),
  runQuery: (matchId: string, sql: string) => ipcRenderer.invoke('db:runQuery', matchId, sql),
  
  // CS2 Launch
  launchCS2: (demoPath: string, startTick?: number, playerName?: string) => ipcRenderer.invoke('cs2:launch', demoPath, startTick, playerName),
  // CS2 Copy Commands (without launching)
  copyCS2Commands: (demoPath: string, startTick?: number, playerName?: string) => ipcRenderer.invoke('cs2:copyCommands', demoPath, startTick, playerName),
  
  // Settings
  getSetting: (key: string, defaultValue?: string) => ipcRenderer.invoke('settings:get', key, defaultValue),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),
  
  // App Info
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  
  // File operations
  showFileInFolder: (filePath: string) => ipcRenderer.invoke('file:showInFolder', filePath),
  
  // Radar images (to avoid CORS issues with custom protocols)
  getRadarImage: (mapName: string) => ipcRenderer.invoke('radar:getImage', mapName),

  // Voice Extraction
  extractVoice: (options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => 
    ipcRenderer.invoke('voice:extract', options),
  getVoiceAudio: (filePath: string) => ipcRenderer.invoke('voice:getAudio', filePath),
  cleanupVoiceFiles: (outputPath: string) => ipcRenderer.invoke('voice:cleanup', outputPath),

  // Listeners
  onParserMessage: (callback: (message: string) => void) => {
    ipcRenderer.on('parser:message', (_, message) => callback(message))
  },
  onParserLog: (callback: (log: string) => void) => {
    ipcRenderer.on('parser:log', (_, log) => callback(log))
  },
  onParserExit: (callback: (data: { code: number | null; signal: string | null }) => void) => {
    ipcRenderer.on('parser:exit', (_, data) => callback(data))
  },
  onParserError: (callback: (error: string) => void) => {
    ipcRenderer.on('parser:error', (_, error) => callback(error))
  },

  // Remove listeners
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  },
  
  // Listeners for matches cleanup/trim events
  onMatchesCleanup: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => {
    ipcRenderer.on('matches:cleanup', (_, data) => callback(data))
  },
  onMatchesTrimmed: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => {
    ipcRenderer.on('matches:trimmed', (_, data) => callback(data))
  },

  // Voice extraction listeners
  onVoiceExtractionLog: (callback: (log: string) => void) => {
    ipcRenderer.on('voice:extractionLog', (_, log) => callback(log))
  },

  // Auto-updater listeners
  onUpdateAvailable: (callback: (data: { version: string }) => void) => {
    ipcRenderer.on('update:available', (_, data) => callback(data))
  },
  onUpdateDownloaded: (callback: (data: { version: string }) => void) => {
    ipcRenderer.on('update:downloaded', (_, data) => callback(data))
  },

  // Auto-updater actions
  installUpdate: () => ipcRenderer.invoke('update:install'),
  
  // Splash window methods
  getVersion: () => ipcRenderer.invoke('splash:getVersion'),
  closeSplash: () => ipcRenderer.invoke('splash:close'),
  onUpdateStatus: (callback: (status: string, data?: any) => void) => {
    ipcRenderer.on('update:status', (_, data) => callback(data.status, data))
  },
})

