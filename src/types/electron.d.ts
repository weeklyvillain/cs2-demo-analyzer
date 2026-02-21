export interface Incident {
  matchId?: string
  tick: number
  eventType?: string
  offender: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  victim: { name: string; steamId?: string; userId?: number; entityIndex?: number }
  meta?: any // Event metadata (e.g., AFK duration, damage amounts, etc.)
  endTick?: number | null // End tick for events with duration
}

export interface ElectronAPI {
  deleteDemo: (demoPath: string | null, deleteFile: boolean) => Promise<void>
  openFileDialog: (allowMultiple?: boolean, fileFilter?: 'exe' | 'demo') => Promise<string | null | string[]>
  openDirectoryDialog: () => Promise<string | null>
  parseDemo: (args: { demoPath: string }) => Promise<{ matchId: string; dbPath: string }>
  stopParser: () => Promise<void>
  listMatches: () => Promise<Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null; source?: string | null }>>
  getUnparsedDemos: () => Promise<Array<{ fileName: string; filePath: string; fileSize: number; createdAt: string }>>
  getMatchSummary: (matchId: string) => Promise<{ matchId: string; players: any[] }>
  getMatchPlayers: (matchId: string) => Promise<{ matchId: string; players: Array<{ steamId: string; name: string }> }>
  getMatchEvents: (matchId: string, filters?: { type?: string; steamid?: string; round?: number }) => Promise<any>
  getMatchParserLogs: (matchId: string) => Promise<{ matchId: string; logs: string }>
  getMatchRounds: (matchId: string) => Promise<any>
  getMatchChat: (matchId: string, steamid?: string) => Promise<{ matchId: string; messages: Array<{ matchId: string; roundIndex: number; tick: number; steamid: string; name: string; team: string | null; message: string; isTeamChat: boolean }> }>
  getMatchPositions: (matchId: string, roundIndex: number, tick: number) => Promise<{ matchId: string; roundIndex: number; tick: number; positions: Array<{ tick: number; steamid: string; x: number; y: number; z: number; team: string | null; name: string | null }> }>
  getMatchPositionsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; positions: Array<{ tick: number; steamid: string; x: number; y: number; z: number; team: string | null; name: string | null }> }>
  getGrenadePositionsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; positions: Array<{ tick: number; projectileId: number; grenadeName: string; x: number; y: number; z: number; throwerSteamId: string | null; throwerName: string | null; throwerTeam: string | null }> }>
  getGrenadeEventsForRound: (matchId: string, roundIndex: number) => Promise<{ matchId: string; roundIndex: number; events: Array<{ tick: number; eventType: string; projectileId: number; grenadeName: string; x: number; y: number; z: number; throwerSteamId: string | null; throwerName: string | null; throwerTeam: string | null }> }>
  getRadarImage: (mapName: string) => Promise<{ success: boolean; data?: string; error?: string }>
  getPlayerImage: (team: 'T' | 'CT') => Promise<{ success: boolean; data?: string; error?: string }>
  getKeyboardIcon: (iconName: string) => Promise<{ success: boolean; data?: string; error?: string }>
  getLogoImage: () => Promise<{ success: boolean; data?: string; error?: string }>
  deleteMatches: (matchIds: string[]) => Promise<{ deleted: number }>
  deleteAllMatches: () => Promise<{ deleted: number }>
  trimMatchesToCap: (cap: number) => Promise<{ deleted: Array<{ matchId: string; reason: string }> }>
  listTables: (matchId: string) => Promise<string[]>
  getTableInfo: (matchId: string, tableName: string) => Promise<{ name: string; rowCount: number; schema: string }>
  runQuery: (matchId: string, sql: string) => Promise<{ columns: string[]; rows: any[][] }>
  launchCS2: (demoPath: string, startTick?: number, playerName?: string, confirmLoadDemo?: boolean) => Promise<{ success: boolean; tick: number; commands: string; alreadyRunning?: boolean; needsDemoLoad?: boolean; currentDemo?: string | null; newDemo?: string; error?: string }>
  copyCS2Commands: (demoPath: string, startTick?: number, playerName?: string) => Promise<{ success: boolean; commands: string; error?: string }>
  launchHlaeCs2: (opts?: { width?: number; height?: number; launchArgs?: string; movieConfigDir?: string }) => Promise<{ success: boolean; pid?: number | null; startedAt?: string; hookVerified?: boolean; logPath?: string; error?: string }>
  getSetting: (key: string, defaultValue?: string) => Promise<string>
  setSetting: (key: string, value: string) => Promise<{ success: boolean }>
  getAllSettings: () => Promise<Record<string, string>>
  getAllStats: () => Promise<Record<string, number>>
  resetStats: () => Promise<{ success: boolean }>
  getLastSeenVersion: () => Promise<string>
  setLastSeenVersion: (version: string) => Promise<void>
  shouldShowWhatsNew: () => Promise<boolean>
  getReleaseNotes: (version: string) => Promise<{ title: string; body: string } | null>
  getAvailableVersions: () => Promise<string[]>
  getAppInfo: () => Promise<{
    version: string
    platform: string
    arch: string
    osVersion: string
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
    storage: {
      matches: { bytes: number; formatted: string; count: number }
      settings: { bytes: number; formatted: string }
      voiceCache: { bytes: number; formatted: string }
      total: { bytes: number; formatted: string }
    }
    updateAvailable: boolean
    updateVersion: string | null
    updateReleaseUrl: string | null
  }>
  openExternal: (url: string) => Promise<void>
  restartApp: () => Promise<void>
  showFileInFolder: (filePath: string) => Promise<void>
  selectDemoFolders: () => Promise<{ success: boolean; folders?: string[] }>
  addDemoFolder: () => Promise<{ success: boolean; folder?: string }>
  getDemoFolders: () => Promise<string[]>
  extractVoice: (options: { demoPath: string; outputPath?: string; mode?: 'split-compact' | 'split-full' | 'single-full'; steamIds?: string[] }) => Promise<{ success: boolean; outputPath: string; files: string[]; filePaths?: string[] }>
  getVoiceAudio: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
  generateWaveform: (
    filePath: string,
    audioDuration?: number,
    options?: { mode?: 'fixed' | 'wide'; pixelsPerSecond?: number; maxWidth?: number }
  ) => Promise<{ success: boolean; data?: string; error?: string; pixelsPerSecond?: number; actualWidth?: number }>
  cleanupVoiceFiles: (outputPath: string) => Promise<{ success: boolean; error?: string }>
  exportClips: (payload: {
    demoPath: string
    clipRanges: Array<{ 
      id: string
      startTick: number
      endTick: number
      label?: string
      playerName?: string
      playerSteamId?: string
      playerSlot?: number
      eventType?: string
    }>
    outputDir?: string
    width?: number
    height?: number
    fps?: number
    timescale?: number
    tickrate?: number
    montageEnabled?: boolean
    fadeDuration?: number
  }) => Promise<{ success: boolean; clips: string[]; montage?: string; error?: string }>
  onClipsExportProgress: (callback: (progress: {
    stage: 'validate' | 'launch' | 'load_demo' | 'seek' | 'pov' | 'recording' | 'encode' | 'montage' | 'done'
    currentClipIndex: number
    totalClips: number
    percent: number
    message: string
  }) => void) => void
  showItemInFolder: (filePath: string) => Promise<void>
  onParserMessage: (callback: (message: string | { processId: string; message: string }) => void) => () => void
  onParserLog: (callback: (log: string) => void) => () => void
  onParserExit: (callback: (data: { code: number | null; signal: string | null; processId?: string }) => void) => () => void
  onParserStarted: (callback: (data: { matchId: string; demoPath: string }) => void) => () => void
  onParserDone: (callback: (data: { success: boolean; matchId: string; demoPath: string; error?: string }) => void) => () => void
  onParserError: (callback: (error: string) => void) => () => void
  onDemosFileAdded: (callback: (data: { filePath: string }) => void) => void
  onDemosFileRemoved: (callback: (data: { filePath: string }) => void) => void
  onMatchesCleanup: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => void
  onMatchesTrimmed: (callback: (data: { deleted: number; details: Array<{ matchId: string; reason: string }> }) => void) => void
  onMatchesList: (callback: (matches: Array<{ id: string; map: string; startedAt: string | null; playerCount: number; demoPath: string | null; isMissingDemo?: boolean; createdAtIso?: string | null; source?: string | null }>) => void) => void
  onVoiceExtractionLog: (callback: (log: string) => void) => void
  onUpdateAvailable: (callback: (data: { version: string }) => void) => void
  onUpdateDownloaded: (callback: (data: { version: string }) => void) => void
  installUpdate: () => Promise<void>
  downloadAndInstallVersion: (version: string) => Promise<{ success: boolean; error?: string }>
  getVersion: () => Promise<string>
  closeSplash: () => Promise<void>
  onUpdateStatus: (callback: (status: string, data?: any) => void) => void
  removeAllListeners: (channel: string) => void
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  onWindowMaximized: (callback: (maximized: boolean) => void) => void
  overlay: {
    getInteractive: () => Promise<boolean>
    setInteractive: (value: boolean) => Promise<boolean>
    create: () => Promise<boolean>
    close: () => Promise<boolean>
    show: () => Promise<boolean>
    hide: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    setInteractiveRegionHovered: (hovered: boolean) => Promise<void>
    getInteractiveRegionHovered: () => Promise<boolean>
    onInteractive: (callback: (value: boolean) => void) => void
    onIncident: (callback: (incident: Incident | null) => void) => void
    onActionResult: (callback: (result: { success: boolean; action: string; player?: string; error?: string; clearLoadingOnly?: boolean }) => void) => void
    onCommandLog: (callback: (log: Array<{ ts: number; cmd: string }>) => void) => void
    sendIncident: (incident: Incident | null) => Promise<void>
    actions: {
      viewOffender: () => Promise<{ success: boolean; error?: string }>
      viewVictim: () => Promise<{ success: boolean; error?: string }>
    }
  }
  settings: {
    getHotkey: () => Promise<string>
    setHotkey: (accelerator: string) => Promise<{ success: boolean; error?: string }>
    resetHotkey: () => Promise<{ success: boolean; error?: string }>
    getDebugMode: () => Promise<boolean>
    setDebugMode: (value: boolean) => Promise<{ success: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

