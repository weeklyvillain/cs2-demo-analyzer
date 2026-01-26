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
  launchCS2: (demoPath: string, startTick?: number, playerName?: string, confirmLoadDemo?: boolean) => ipcRenderer.invoke('cs2:launch', demoPath, startTick, playerName, confirmLoadDemo),
  // CS2 Copy Commands (without launching)
  copyCS2Commands: (demoPath: string, startTick?: number, playerName?: string) => ipcRenderer.invoke('cs2:copyCommands', demoPath, startTick, playerName),
  
  // Settings
  getSetting: (key: string, defaultValue?: string) => ipcRenderer.invoke('settings:get', key, defaultValue),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),
  
  // Stats
  getAllStats: () => ipcRenderer.invoke('stats:getAll'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  
  // What's New
  getLastSeenVersion: () => ipcRenderer.invoke('app:getLastSeenVersion'),
  setLastSeenVersion: (version: string) => ipcRenderer.invoke('app:setLastSeenVersion', version),
  shouldShowWhatsNew: () => ipcRenderer.invoke('app:shouldShowWhatsNew'),
  getReleaseNotes: (version: string) => ipcRenderer.invoke('app:getReleaseNotes', version),
  getAvailableVersions: () => ipcRenderer.invoke('app:getAvailableVersions'),
  
  // App Info
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  
  // File operations
  showFileInFolder: (filePath: string) => ipcRenderer.invoke('file:showInFolder', filePath),
  
  // Radar images (to avoid CORS issues with custom protocols)
  getRadarImage: (mapName: string) => ipcRenderer.invoke('radar:getImage', mapName),
  
  // Player images (for 2D viewer)
  getPlayerImage: (team: 'T' | 'CT') => ipcRenderer.invoke('player:getImage', team),
  
  // Keyboard icons (for overlay hotkey display)
  getKeyboardIcon: (iconName: string) => ipcRenderer.invoke('keyboard:getIcon', iconName),
  
  // Splash screen logo
  getLogoPath: () => ipcRenderer.invoke('splash:getLogoPath'),
  
  // App logo image (for renderer)
  getLogoImage: () => ipcRenderer.invoke('app:getLogoImage'),

  // Voice Extraction
  extractVoice: (options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => 
    ipcRenderer.invoke('voice:extract', options),
  getVoiceAudio: (filePath: string) => ipcRenderer.invoke('voice:getAudio', filePath),
  generateWaveform: (filePath: string, audioDuration?: number) => ipcRenderer.invoke('voice:generateWaveform', filePath, audioDuration),
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
  onMatchesList: (callback: (matches: Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null; source?: string | null }>) => void) => {
    ipcRenderer.on('matches:list', (_, matches) => callback(matches))
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
  downloadAndInstallVersion: (version: string) => ipcRenderer.invoke('update:downloadAndInstallVersion', version),
  
  // Splash window methods
  getVersion: () => ipcRenderer.invoke('splash:getVersion'),
  closeSplash: () => ipcRenderer.invoke('splash:close'),
  onUpdateStatus: (callback: (status: string, data?: any) => void) => {
    ipcRenderer.on('update:status', (_, data) => callback(data.status, data))
  },
  
  // Window controls for custom title bar
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    ipcRenderer.on('window:maximized', (_, maximized) => callback(maximized))
  },

  // Overlay API
  overlay: {
    getInteractive: () => ipcRenderer.invoke('overlay:getInteractive'),
    setInteractive: (value: boolean) => ipcRenderer.invoke('overlay:setInteractive', value),
    create: () => ipcRenderer.invoke('overlay:create'),
    close: () => ipcRenderer.invoke('overlay:close'),
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    sendIncident: (incident: any) => ipcRenderer.invoke('overlay:sendIncident', incident),
    setInteractiveRegionHovered: (hovered: boolean) => ipcRenderer.invoke('overlay:hovered', hovered),
    getInteractiveRegionHovered: () => ipcRenderer.invoke('overlay:getHovered'),
    onInteractive: (callback: (value: boolean) => void) => {
      ipcRenderer.on('overlay:interactiveChanged', (_, value) => callback(value))
    },
    onIncident: (callback: (incident: any) => void) => {
      ipcRenderer.on('overlay:incident', (_, incident) => callback(incident))
    },
    onActionResult: (callback: (result: { success: boolean; action: string; player?: string; error?: string }) => void) => {
      ipcRenderer.on('overlay:actionResult', (_, result) => callback(result))
    },
    onCommandLog: (callback: (log: Array<{ ts: number; cmd: string }>) => void) => {
      ipcRenderer.on('overlay:commandLog', (_, log) => callback(log))
    },
    actions: {
      viewOffender: () => ipcRenderer.invoke('overlay:actions:viewOffender'),
      viewVictim: () => ipcRenderer.invoke('overlay:actions:viewVictim'),
    },
  },

  // Hotkey settings API
  settings: {
    getHotkey: () => ipcRenderer.invoke('settings:getHotkey'),
    setHotkey: (accelerator: string) => ipcRenderer.invoke('settings:setHotkey', accelerator),
    resetHotkey: () => ipcRenderer.invoke('settings:resetHotkey'),
    getDebugMode: () => ipcRenderer.invoke('settings:getDebugMode'),
    setDebugMode: (value: boolean) => ipcRenderer.invoke('settings:setDebugMode', value),
  },
})

