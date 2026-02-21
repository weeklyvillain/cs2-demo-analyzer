import { useState, useEffect } from 'react'
import Modal from './Modal'
import WhatsNewModal from './WhatsNewModal'
import OverlayHotkeySettings from './OverlayHotkeySettings'
import { RefreshCw } from 'lucide-react'
import { t, setLanguage, getLanguage, type Language } from '../utils/translations'

interface Settings {
  cs2_path: string
  cs2ExePath: string
  hlaeExePath: string
  movieConfigDir: string
  launchArgs: string
  clips_output_dir: string
  ffmpeg_path: string
  cs2_window_width: string
  cs2_window_height: string
  cs2_window_mode: string
  auto_cleanup_missing_demos: string
  match_cap_enabled: string
  match_cap_value: string
  enable_db_viewer: string
  default_afk_threshold: string
  default_flash_threshold: string
  default_sort_field: string
  default_sort_direction: string
  voice_skip_time: string
  position_extraction_interval: string
  ram_only_parsing: string
  parallel_parsing_enabled: string
  parallel_parsing_count: string
  voiceCacheSizeLimitMB: string
  autoUpdateEnabled: string
  manualVersion: string
  debugMode: string
  overlayEnabled: string
  autoplayAfterSpectate: string
  language: string
  demo_folders: string
}

function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>({
    cs2_path: '',
    cs2ExePath: '',
    hlaeExePath: '',
    movieConfigDir: '',
    launchArgs: '',
    clips_output_dir: '',
    ffmpeg_path: '',
    cs2_window_width: '1920',
    cs2_window_height: '1080',
    cs2_window_mode: 'windowed',
    auto_cleanup_missing_demos: 'true',
    match_cap_enabled: 'false',
    match_cap_value: '10',
    enable_db_viewer: 'false',
    default_afk_threshold: '10',
    default_flash_threshold: '1.5',
    default_sort_field: 'date',
    default_sort_direction: 'desc',
    voice_skip_time: '10',
    position_extraction_interval: '4',
    ram_only_parsing: 'false',
    parallel_parsing_enabled: 'false',
    parallel_parsing_count: '2',
    voiceCacheSizeLimitMB: '50',
    autoUpdateEnabled: 'true',
    manualVersion: '',
    debugMode: 'false',
    overlayEnabled: 'false',
    autoplayAfterSpectate: 'true',
    language: getLanguage(),
    demo_folders: '',
  })
  const [demoFolders, setDemoFolders] = useState<string[]>([])
  const [, forceUpdate] = useState(0) // Force re-render when language changes
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [availableVersions, setAvailableVersions] = useState<string[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [installingVersion, setInstallingVersion] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [hlaeTestStatus, setHlaeTestStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [hlaeTestError, setHlaeTestError] = useState<string | null>(null)
  const [hlaeTestLogPath, setHlaeTestLogPath] = useState<string | null>(null)
  const [appInfo, setAppInfo] = useState<{
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
      voiceCache?: { bytes: number; formatted: string }
      total: { bytes: number; formatted: string }
    }
    updateAvailable: boolean
    updateVersion: string | null
  } | null>(null)

  useEffect(() => {
    loadSettings()
    loadAppInfo()
    loadAvailableVersions()
    
    // Refresh app info periodically to update storage usage (especially voice cache)
    const refreshInterval = setInterval(() => {
      loadAppInfo()
    }, 5000) // Refresh every 5 seconds
    
    return () => clearInterval(refreshInterval)
  }, [])

  const loadAvailableVersions = async () => {
    if (!window.electronAPI) return

    setLoadingVersions(true)
    try {
      const versions = await window.electronAPI.getAvailableVersions()
      setAvailableVersions(versions)
    } catch (err) {
      console.error('Failed to load available versions:', err)
    } finally {
      setLoadingVersions(false)
    }
  }

  const loadAppInfo = async () => {
    if (!window.electronAPI) return

    try {
      const info = await window.electronAPI.getAppInfo()
      setAppInfo(info)
    } catch (err) {
      console.error('Failed to load app info:', err)
    }
  }

  const loadSettings = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      setLoading(false)
      return
    }

    try {
      const allSettings = await window.electronAPI.getAllSettings()
      setSettings({
        cs2_path: allSettings.cs2_path || '',
        cs2ExePath: allSettings.cs2ExePath || allSettings.cs2_path || '',
        hlaeExePath: allSettings.hlaeExePath || allSettings.hlae_path || '',
        movieConfigDir: allSettings.movieConfigDir || '',
        launchArgs: allSettings.launchArgs || '',
        clips_output_dir: allSettings.clips_output_dir || '',
        ffmpeg_path: allSettings.ffmpeg_path || '',
        cs2_window_width: allSettings.cs2_window_width || '1920',
        cs2_window_height: allSettings.cs2_window_height || '1080',
        cs2_window_mode: allSettings.cs2_window_mode || 'windowed',
        auto_cleanup_missing_demos: allSettings.auto_cleanup_missing_demos || 'true',
        match_cap_enabled: allSettings.match_cap_enabled || 'false',
        match_cap_value: allSettings.match_cap_value || '10',
        enable_db_viewer: allSettings.enable_db_viewer || 'false',
        default_afk_threshold: allSettings.default_afk_threshold || '10',
        default_flash_threshold: allSettings.default_flash_threshold || '1.5',
        default_sort_field: allSettings.default_sort_field || 'date',
        default_sort_direction: allSettings.default_sort_direction || 'desc',
        voice_skip_time: allSettings.voice_skip_time || '10',
        position_extraction_interval: allSettings.position_extraction_interval || '4',
        ram_only_parsing: allSettings.ram_only_parsing || 'false',
        parallel_parsing_enabled: allSettings.parallel_parsing_enabled || 'false',
        parallel_parsing_count: allSettings.parallel_parsing_count || '2',
        voiceCacheSizeLimitMB: allSettings.voiceCacheSizeLimitMB || '50',
        autoUpdateEnabled: allSettings.autoUpdateEnabled || 'true',
        manualVersion: allSettings.manualVersion || '',
        debugMode: allSettings.debugMode || 'false',
        overlayEnabled: allSettings.overlayEnabled !== undefined ? allSettings.overlayEnabled : 'false',
        autoplayAfterSpectate: allSettings.autoplayAfterSpectate !== undefined ? allSettings.autoplayAfterSpectate : 'true',
        language: allSettings.language || getLanguage(),
        demo_folders: allSettings.demo_folders || '',
      })
      // Set language from settings
      if (allSettings.language && (allSettings.language === 'en' || allSettings.language === 'sv')) {
        setLanguage(allSettings.language as Language)
      }
      
      // Load demo folders
      await loadDemoFolders()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const loadDemoFolders = async () => {
    if (!window.electronAPI) return
    try {
      const folders = await window.electronAPI.getDemoFolders()
      setDemoFolders(folders || [])
    } catch (err) {
      console.error('Failed to load demo folders:', err)
    }
  }

  const handleAddDemoFolder = async () => {
    if (!window.electronAPI) return

    try {
      // Open a single folder dialog
      const result = await window.electronAPI.addDemoFolder()
      
      if (result.success && result.folder && !demoFolders.includes(result.folder)) {
        const updatedFolders = [...demoFolders, result.folder]
        setDemoFolders(updatedFolders)
        // Save updated list via setSetting if available
        if (window.electronAPI.setSetting) {
          await window.electronAPI.setSetting('demo_folders', updatedFolders.join('|'))
        }
        setSuccess(true)
        setTimeout(() => setSuccess(false), 2000)
      }
    } catch (err) {
      console.error('Failed to add demo folder:', err)
    }
  }

  const handleRemoveDemoFolder = async (folderToRemove: string) => {
    if (!window.electronAPI) return

    try {
      const updatedFolders = demoFolders.filter(f => f !== folderToRemove)
      setDemoFolders(updatedFolders)
      // Save updated list
      if (window.electronAPI.setSetting) {
        await window.electronAPI.setSetting('demo_folders', updatedFolders.join('|'))
      }
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove demo folder')
    }
  }

  // Save a single setting immediately
  const handleSaveSingleSetting = async (key: string, value: string) => {
    if (!window.electronAPI) return

    try {
      await window.electronAPI.setSetting(key, value)
      
      // Special handling for match cap
      if (key === 'match_cap_enabled' && value === 'true') {
        const capValue = parseInt(settings.match_cap_value, 10)
        if (!isNaN(capValue) && capValue > 0) {
          try {
            await window.electronAPI.trimMatchesToCap(capValue)
          } catch (err) {
            console.error('Failed to trim matches:', err)
          }
        }
      }
      
      // Special handling for language change
      if (key === 'language' && (value === 'en' || value === 'sv')) {
        setLanguage(value as Language)
        forceUpdate((prev) => prev + 1) // Force re-render to update all translations
      }
    } catch (err) {
      console.error(`Failed to save setting ${key}:`, err)
      setError(err instanceof Error ? err.message : `Failed to save ${key}`)
    }
  }

  // Save only window settings
  const handleSaveWindowSettings = async () => {
    if (!window.electronAPI) {
      setError('Electron API not available')
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      await window.electronAPI.setSetting('cs2_window_width', settings.cs2_window_width)
      await window.electronAPI.setSetting('cs2_window_height', settings.cs2_window_height)
      await window.electronAPI.setSetting('cs2_window_mode', settings.cs2_window_mode)

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save window settings')
    } finally {
      setSaving(false)
    }
  }

  const handleBrowseCS2 = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openFileDialog(false, 'exe')
    if (path && typeof path === 'string') {
      setSettings((prev) => ({ ...prev, cs2_path: path, cs2ExePath: path }))
      // Save immediately when file is selected
      await handleSaveSingleSetting('cs2_path', path)
      await handleSaveSingleSetting('cs2ExePath', path)
    }
  }

  const handleBrowseHlae = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openFileDialog()
    if (path) {
      setSettings((prev) => ({ ...prev, hlaeExePath: path }))
      await handleSaveSingleSetting('hlaeExePath', path)
    }
  }

  const handleBrowseMovieConfigDir = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openDirectoryDialog()
    if (path) {
      setSettings((prev) => ({ ...prev, movieConfigDir: path }))
      await handleSaveSingleSetting('movieConfigDir', path)
    }
  }

  const handleTestHlae = async () => {
    if (!window.electronAPI) return

    setHlaeTestStatus('running')
    setHlaeTestError(null)
    setHlaeTestLogPath(null)

    try {
      const result = await window.electronAPI.launchHlaeCs2({
        launchArgs: settings.launchArgs,
        movieConfigDir: settings.movieConfigDir,
      })

      if (!result.success) {
        setHlaeTestStatus('error')
        setHlaeTestError(result.error || 'Unknown error')
        return
      }

      setHlaeTestStatus(result.hookVerified ? 'success' : 'error')
      setHlaeTestLogPath(result.logPath || null)
      if (!result.hookVerified) {
        setHlaeTestError('HLAE hook not detected (mirv commands unavailable).')
      }
    } catch (err) {
      setHlaeTestStatus('error')
      setHlaeTestError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleBrowseFfmpeg = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openFileDialog()
    if (path) {
      setSettings((prev) => ({ ...prev, ffmpeg_path: path }))
      await handleSaveSingleSetting('ffmpeg_path', path)
    }
  }

  const handleBrowseClipsOutputDir = async () => {
    if (!window.electronAPI) return

    const path = await window.electronAPI.openDirectoryDialog()
    if (path) {
      setSettings((prev) => ({ ...prev, clips_output_dir: path }))
      // Save immediately when directory is selected
      await handleSaveSingleSetting('clips_output_dir', path)
    }
  }

  const handleDeleteAllMatches = async () => {
    if (!window.electronAPI) return
    
    setDeleting(true)
    setError(null)
    
    try {
      const result = await window.electronAPI.deleteAllMatches()
      setSuccess(true)
      setShowDeleteConfirm(false)
      setTimeout(() => {
        setSuccess(false)
        // Refresh matches list if we're on matches screen
        window.location.reload()
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete matches')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-gray-400">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">{t('settings.title')}</h2>
        <p className="text-gray-400 text-sm">{t('settings.subtitle')}</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-900/20 border border-red-500/50 rounded text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-900/20 border border-green-500/50 rounded text-green-400">
          Settings saved successfully!
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Settings */}
        <div className="space-y-6">
          {/* CS2 Configuration */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.cs2Config')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.cs2Path')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.cs2_path}
                    onChange={(e) => setSettings((prev) => ({ ...prev, cs2_path: e.target.value }))}
                    onBlur={async () => {
                      await handleSaveSingleSetting('cs2_path', settings.cs2_path)
                      await handleSaveSingleSetting('cs2ExePath', settings.cs2_path)
                    }}
                    placeholder="C:\Program Files\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe"
                    className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  />
                  <button
                    onClick={handleBrowseCS2}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.cs2PathDesc')}
                </p>
              </div>
              {
                false && /* Hide cs2ExePath field for now, using cs2_path for both */
                (<>
                   {/* HLAE Path */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  HLAE Executable Path
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.hlaeExePath}
                    onChange={(e) => setSettings((prev) => ({ ...prev, hlaeExePath: e.target.value }))}
                    onBlur={() => handleSaveSingleSetting('hlaeExePath', settings.hlaeExePath)}
                    placeholder="C:\HLAE\HLAE.exe"
                    className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  />
                  <button
                    onClick={handleBrowseHlae}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Path to HLAE.exe (AfxHookSource2).
                </p>
              </div>

              {/* HLAE Movie Config Directory */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  HLAE Movie Config Directory (USRLOCALCSGO)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.movieConfigDir}
                    onChange={(e) => setSettings((prev) => ({ ...prev, movieConfigDir: e.target.value }))}
                    onBlur={() => handleSaveSingleSetting('movieConfigDir', settings.movieConfigDir)}
                    placeholder="C:\Users\YourName\AppData\Roaming\CS2 Demo Analyzer\hlae"
                    className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  />
                  <button
                    onClick={handleBrowseMovieConfigDir}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Folder for HLAE configs. A cfg/ folder will be created inside.
                </p>
              </div>

              {/* HLAE Launch Args */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  HLAE Launch Arguments
                </label>
                <input
                  type="text"
                  value={settings.launchArgs}
                  onChange={(e) => setSettings((prev) => ({ ...prev, launchArgs: e.target.value }))}
                  onBlur={() => handleSaveSingleSetting('launchArgs', settings.launchArgs)}
                  placeholder="-novid -console -windowed -noborder -w 1280 -h 720"
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Additional CS2 launch args appended when HLAE starts CS2.
                </p>
              </div>

              {/* HLAE Test Button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleTestHlae}
                  disabled={hlaeTestStatus === 'running'}
                  className="px-4 py-2 bg-green-600/20 text-green-400 border border-green-600/50 rounded hover:bg-green-600/30 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {hlaeTestStatus === 'running' ? 'Testing HLAE...' : 'Test HLAE'}
                </button>
                {hlaeTestStatus === 'success' && (
                  <span className="text-sm text-green-400">Hook verified</span>
                )}
                {hlaeTestStatus === 'error' && (
                  <span className="text-sm text-red-400">Test failed</span>
                )}
                {hlaeTestLogPath && (
                  <button
                    onClick={() => window.electronAPI?.showItemInFolder(hlaeTestLogPath)}
                    className="text-sm text-blue-400 hover:text-blue-300"
                  >
                    Show Log
                  </button>
                )}
              </div>
              {hlaeTestError && (
                <p className="text-xs text-red-400">{hlaeTestError}</p>
              )}

              {/* Clips Output Directory */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Clips Output Directory
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.clips_output_dir}
                    onChange={(e) => setSettings((prev) => ({ ...prev, clips_output_dir: e.target.value }))}
                    placeholder="C:\Users\YourName\Documents\CS2 Demo Clips"
                    className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  />
                  <button
                    onClick={handleBrowseClipsOutputDir}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Where to save exported demo clips. Defaults to Documents/CS2 Demo Clips if not set.
                </p>
              </div>

              {/* FFmpeg Path */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  FFmpeg Path
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.ffmpeg_path}
                    onChange={(e) => setSettings((prev) => ({ ...prev, ffmpeg_path: e.target.value }))}
                    placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe"
                    className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  />
                  <button
                    onClick={handleBrowseFfmpeg}
                    className="px-4 py-2 bg-accent text-white rounded hover:bg-accent/80 transition-colors text-sm"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Used for speed normalization and montage rendering.
                </p>
              </div>
              </>
                )
              }
             

            </div>
          </div>

          {/* Demo Folder Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.demoFolders')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.demoFoldersDesc')}
                </label>
                <button
                  onClick={handleAddDemoFolder}
                  className="px-4 py-2 bg-green-600/20 text-green-400 border border-green-600/50 rounded hover:bg-green-600/30 transition-colors text-sm mb-3"
                >
                  + {t('settings.addFolder')}
                </button>
                
                {demoFolders.length > 0 && (
                  <div className="space-y-2 mt-3">
                    <p className="text-xs text-gray-400">{t('settings.watchedFolders')}:</p>
                    <div className="space-y-2">
                      {demoFolders.map((folder, idx) => (
                        <div
                          key={idx}
                          className="px-3 py-2 bg-surface border border-border rounded text-white text-sm truncate flex justify-between items-center"
                          title={folder}
                        >
                          <span className="flex-1 truncate">{folder}</span>
                          <button
                            onClick={() => handleRemoveDemoFolder(folder)}
                            className="ml-2 px-2 py-1 text-xs bg-red-600/20 text-red-400 border border-red-600/50 rounded hover:bg-red-600/30 transition-colors flex-shrink-0"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {demoFolders.length === 0 && (
                  <p className="text-xs text-gray-500 italic">{t('settings.noDemoFoldersSelected')}</p>
                )}
              </div>
            </div>
          </div>

          {/* Window Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.windowSettings')}</h3>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('settings.windowWidth')}
                  </label>
                  <input
                    type="number"
                    value={settings.cs2_window_width}
                    onChange={(e) => setSettings((prev) => ({ ...prev, cs2_window_width: e.target.value }))}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                    min="640"
                    max="7680"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('settings.windowHeight')}
                  </label>
                  <input
                    type="number"
                    value={settings.cs2_window_height}
                    onChange={(e) => setSettings((prev) => ({ ...prev, cs2_window_height: e.target.value }))}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                    min="480"
                    max="4320"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.windowMode')}
                </label>
                <select
                  value={settings.cs2_window_mode}
                  onChange={(e) => {
                    const el = e.currentTarget
                    setSettings((prev) => ({ ...prev, cs2_window_mode: e.target.value }))
                    el?.blur()
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                >
                  <option value="windowed">{t('settings.windowed')}</option>
                  <option value="fullscreen">{t('settings.fullscreen')}</option>
                </select>
              </div>

              {/* Save Button for Window Settings */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleSaveWindowSettings}
                  disabled={saving}
                  className="px-6 py-2 bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {saving ? t('settings.saving') : t('settings.saveWindowSettings')}
                </button>
              </div>
            </div>
          </div>

          {/* Parsing Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.parsingSettings')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.positionExtractionFrequency')}
                </label>
                <select
                  value={settings.position_extraction_interval}
                  onChange={async (e) => {
                    const el = e.currentTarget
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, position_extraction_interval: value }))
                    await handleSaveSingleSetting('position_extraction_interval', value)
                    el?.blur()
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                >
                  <option value="1">{t('settings.positionExtractionAll')}</option>
                  <option value="2">{t('settings.positionExtractionHalf')}</option>
                  <option value="4">{t('settings.positionExtractionQuarter')}</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.positionExtractionDesc')}
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.ramOnlyParsing')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.ramOnlyParsingDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.ram_only_parsing === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, ram_only_parsing: value }))
                      await handleSaveSingleSetting('ram_only_parsing', value)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.parallelParsing')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.parallelParsingDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.parallel_parsing_enabled === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, parallel_parsing_enabled: value }))
                      await handleSaveSingleSetting('parallel_parsing_enabled', value)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>

              {settings.parallel_parsing_enabled === 'true' && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('settings.parallelParsingCount')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={settings.parallel_parsing_count}
                    onChange={async (e) => {
                      const raw = e.target.value
                      const num = Math.max(1, Math.min(8, parseInt(raw, 10) || 2))
                      const value = String(num)
                      setSettings((prev) => ({ ...prev, parallel_parsing_count: value }))
                      await handleSaveSingleSetting('parallel_parsing_count', value)
                    }}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm max-w-[6rem]"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {t('settings.parallelParsingCountDesc')}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Display Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.displaySettings')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.defaultAfkThreshold')}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.default_afk_threshold}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, default_afk_threshold: value }))
                    await handleSaveSingleSetting('default_afk_threshold', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="0"
                  max="300"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.defaultAfkThresholdDesc')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.defaultFlashThreshold')}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={settings.default_flash_threshold}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, default_flash_threshold: value }))
                    await handleSaveSingleSetting('default_flash_threshold', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="0"
                  max="60"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.defaultFlashThresholdDesc')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.defaultMatchSort')}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={settings.default_sort_field}
                    onChange={async (e) => {
                      const el = e.currentTarget
                      const value = e.target.value
                      setSettings((prev) => ({ ...prev, default_sort_field: value }))
                      await handleSaveSingleSetting('default_sort_field', value)
                      el?.blur()
                    }}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  >
                    <option value="date">{t('settings.date')}</option>
                    <option value="id">{t('settings.id')}</option>
                    <option value="length">{t('settings.length')}</option>
                    <option value="map">{t('settings.map')}</option>
                  </select>
                  <select
                    value={settings.default_sort_direction}
                    onChange={async (e) => {
                      const el = e.currentTarget
                      const value = e.target.value
                      setSettings((prev) => ({ ...prev, default_sort_direction: value }))
                      await handleSaveSingleSetting('default_sort_direction', value)
                      el?.blur()
                    }}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  >
                    <option value="asc">{t('settings.ascending')}</option>
                    <option value="desc">{t('settings.descending')}</option>
                  </select>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.defaultMatchSortDesc')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.voicePlaybackSkipTime')}
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={settings.voice_skip_time}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, voice_skip_time: value }))
                    await handleSaveSingleSetting('voice_skip_time', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="0.5"
                  max="60"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.voicePlaybackSkipTimeDesc')}
                </p>
              </div>
            </div>
          </div>

          {/* Storage Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.storageSettings')}</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.cleanupMissingDemos')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.cleanupMissingDemosDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.auto_cleanup_missing_demos === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, auto_cleanup_missing_demos: value }))
                      await handleSaveSingleSetting('auto_cleanup_missing_demos', value)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.limitMatches')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.limitMatchesDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.match_cap_enabled === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, match_cap_enabled: value }))
                      await handleSaveSingleSetting('match_cap_enabled', value)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
              
              {settings.match_cap_enabled === 'true' && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('settings.maxMatches')}
                  </label>
                  <input
                    type="number"
                    value={settings.match_cap_value}
                    onChange={async (e) => {
                      const value = e.target.value
                      setSettings((prev) => ({ ...prev, match_cap_value: value }))
                      await handleSaveSingleSetting('match_cap_value', value)
                    }}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                    min="1"
                    max="1000"
                  />
                </div>
              )}
              
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.voiceCacheSizeLimit')}
                </label>
                <input
                  type="number"
                  value={settings.voiceCacheSizeLimitMB}
                  onChange={async (e) => {
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, voiceCacheSizeLimitMB: value }))
                    await handleSaveSingleSetting('voiceCacheSizeLimitMB', value)
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                  min="1"
                  max="10000"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.voiceCacheSizeLimitDesc')}
                </p>
              </div>
            </div>
          </div>

          {/* Overlay Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.overlaySettings')}</h3>
            
            <div className="space-y-4">
              {/* Overlay Enable/Disable */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.enableOverlay')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.enableOverlayDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.overlayEnabled !== 'false'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, overlayEnabled: value }))
                      await handleSaveSingleSetting('overlayEnabled', value)
                      // Close overlay if disabling
                      if (!e.target.checked && window.electronAPI?.overlay?.close) {
                        await window.electronAPI.overlay.close()
                      }
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>

              <div className="pt-2 border-t border-border">
                {/* Overlay Hotkey Settings */}
                <OverlayHotkeySettings />
              </div>

              <div className="pt-2 border-t border-border">
                {/* Debug Mode */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      {t('settings.debugMode')}
                    </label>
                    <p className="text-xs text-gray-500">
                      {t('settings.debugModeDesc')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.debugMode === 'true'}
                      onChange={async (e) => {
                        const value = e.target.checked ? 'true' : 'false'
                        setSettings((prev) => ({ ...prev, debugMode: value }))
                        await handleSaveSingleSetting('debugMode', value)
                        // Also update via settings API for immediate overlay update
                        if (window.electronAPI) {
                          await window.electronAPI.settings.setDebugMode(e.target.checked)
                        }
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Playback Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.playbackSettings')}</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.autoplayAfterSpectate')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.autoplayAfterSpectateDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.autoplayAfterSpectate === 'true'}
                    onChange={async (e) => {
                      const newValue = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, autoplayAfterSpectate: newValue }))
                      await handleSaveSingleSetting('autoplayAfterSpectate', newValue)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Language Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.language')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.language')}
                </label>
                <select
                  value={settings.language}
                  onChange={async (e) => {
                    const el = e.currentTarget
                    const value = e.target.value
                    setSettings((prev) => ({ ...prev, language: value }))
                    await handleSaveSingleSetting('language', value)
                    el?.blur()
                  }}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-white text-sm"
                >
                  <option value="en">{t('settings.english')}</option>
                  <option value="sv">{t('settings.swedish')}</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.languageDesc')}
                </p>
              </div>
            </div>
          </div>


          {/* Advanced Settings */}
          <div className="bg-secondary rounded-lg border border-border p-4">
            <h3 className="text-lg font-semibold mb-4">{t('settings.advanced')}</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('settings.enableDbViewer')}
                  </label>
                  <p className="text-xs text-gray-500">
                    {t('settings.enableDbViewerDesc')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.enable_db_viewer === 'true'}
                    onChange={async (e) => {
                      const value = e.target.checked ? 'true' : 'false'
                      setSettings((prev) => ({ ...prev, enable_db_viewer: value }))
                      await handleSaveSingleSetting('enable_db_viewer', value)
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="bg-secondary rounded-lg border border-red-500/50 p-4">
            <h3 className="text-lg font-semibold mb-4 text-red-400">{t('settings.dangerZone')}</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.deleteAllMatches')}
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  {t('settings.deleteAllMatchesDesc')}
                </p>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
                >
                  {t('settings.deleteAllMatches')}
                </button>
              </div>
            </div>
          </div>

          {/* Delete All Matches Modal */}
          <Modal
            isOpen={showDeleteConfirm}
            onClose={() => !deleting && setShowDeleteConfirm(false)}
            title={t('settings.deleteAllMatches')}
            size="md"
            footer={
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={deleting}
                  className="px-4 py-2 bg-surface border border-border text-white rounded hover:bg-surface/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {t('settings.cancel')}
                </button>
                <button
                  onClick={handleDeleteAllMatches}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {deleting ? t('settings.deleting') : t('settings.yesDeleteAll')}
                </button>
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-red-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-white mb-2">
                    {t('settings.deleteConfirmTitle')}
                  </h3>
                  <p className="text-sm text-gray-400 mb-2">
                    {t('settings.deleteConfirmDesc')}
                  </p>
                  <p className="text-sm text-red-400 font-medium">
                    {t('settings.deleteConfirmWarning')}
                  </p>
                </div>
              </div>
            </div>
          </Modal>
        </div>

        {/* Right Column: Application Information */}
        {appInfo && (
          <div className="space-y-6">
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('settings.appInfo')}</h3>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">{t('settings.version')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{appInfo.version}</span>
                    <button
                      onClick={() => setShowWhatsNew(true)}
                      className="px-3 py-1 bg-surface hover:bg-surface/80 text-white text-xs rounded transition-colors flex items-center gap-1"
                      title="View What's New"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {t('settings.whatsNew')}
                    </button>
                    {appInfo.updateAvailable && appInfo.updateVersion && (
                      <button
                        onClick={async () => {
                          if (window.electronAPI?.restartApp) {
                            await window.electronAPI.restartApp()
                          }
                        }}
                        className="px-3 py-1 bg-accent hover:bg-accent/90 text-white text-xs rounded transition-colors flex items-center gap-1"
                        title={`Restart to install update v${appInfo.updateVersion}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Restart to Update
                      </button>
                    )}
                  </div>
                </div>
                
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">{t('settings.platform')}</span>
                  <span className="text-sm font-medium text-white">
                    {appInfo.platform} {appInfo.arch} ({appInfo.osVersion})
                  </span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">{t('settings.electron')}</span>
                  <span className="text-sm font-medium text-white">{appInfo.electronVersion}</span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">{t('settings.chrome')}</span>
                  <span className="text-sm font-medium text-white">{appInfo.chromeVersion}</span>
                </div>
                
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-sm text-gray-400">{t('settings.nodejs')}</span>
                  <span className="text-sm font-medium text-white">{appInfo.nodeVersion}</span>
                </div>
                
                <div className="mt-4 pt-3 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-gray-300">{t('settings.storageUsage')}</h4>
                    <button
                      onClick={loadAppInfo}
                      className="p-1.5 hover:bg-surface rounded transition-colors"
                      title="Refresh storage usage"
                    >
                      <RefreshCw size={14} className="text-gray-400 hover:text-white" />
                    </button>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">{t('settings.matches')} ({appInfo.storage.matches.count} {t('settings.files')})</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.matches.formatted}</span>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">{t('settings.settings')}</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.settings.formatted}</span>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-400">{t('settings.voiceCache')}</span>
                      <span className="text-sm font-medium text-white">{appInfo.storage.voiceCache?.formatted || '0 B'}</span>
                    </div>
                    
                    <div className="flex items-center justify-between pt-2 border-t border-border/50">
                      <span className="text-sm font-medium text-gray-300">{t('settings.total')}</span>
                      <span className="text-sm font-semibold text-white">{appInfo.storage.total.formatted}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Update Settings */}
            <div className="bg-secondary rounded-lg border border-border p-4">
              <h3 className="text-lg font-semibold mb-4">{t('settings.updateSettings')}</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      {t('settings.enableAutoUpdate')}
                    </label>
                    <p className="text-xs text-gray-500">
                      {t('settings.enableAutoUpdateDesc')}
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.autoUpdateEnabled === 'true'}
                      onChange={async (e) => {
                        const value = e.target.checked ? 'true' : 'false'
                        setSettings((prev) => ({ ...prev, autoUpdateEnabled: value }))
                        await handleSaveSingleSetting('autoUpdateEnabled', value)
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('settings.downloadAndInstallVersion')}
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={settings.manualVersion}
                      onChange={async (e) => {
                        const el = e.currentTarget
                        const value = e.target.value
                        setSettings((prev) => ({ ...prev, manualVersion: value }))
                        await handleSaveSingleSetting('manualVersion', value)
                        setInstallError(null)
                        el?.blur()
                      }}
                      className="flex-1 px-3 py-2 bg-surface border border-border rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      disabled={loadingVersions || installingVersion !== null}
                    >
                      <option value="">{t('settings.useActualVersion')}</option>
                      {availableVersions.map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </select>
                    {settings.manualVersion && (
                      <button
                        onClick={async () => {
                          if (!settings.manualVersion) return
                          
                          setInstallingVersion(settings.manualVersion)
                          setInstallError(null)
                          
                          try {
                            const result = await window.electronAPI?.downloadAndInstallVersion(settings.manualVersion)
                            if (result?.success) {
                              // App will restart, so we don't need to do anything else
                            } else {
                              setInstallError(result?.error || 'Failed to install version')
                              setInstallingVersion(null)
                            }
                          } catch (err) {
                            setInstallError(err instanceof Error ? err.message : 'Failed to install version')
                            setInstallingVersion(null)
                          }
                        }}
                        disabled={installingVersion !== null || !settings.manualVersion}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors whitespace-nowrap"
                      >
                        {installingVersion ? t('settings.installing') : t('settings.install')}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('settings.downloadAndInstallDesc')}
                  </p>
                  {loadingVersions && (
                    <p className="text-xs text-gray-400 mt-1">{t('settings.loadingVersions')}</p>
                  )}
                  {installError && (
                    <p className="text-xs text-red-400 mt-1">{installError}</p>
                  )}
                  {installingVersion && (
                    <p className="text-xs text-blue-400 mt-1">Downloading and installing {installingVersion}... The app will restart shortly.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {/* What's New Modal */}
      {showWhatsNew && appInfo && (
        <WhatsNewModal 
          version={appInfo.version} 
          onClose={() => setShowWhatsNew(false)} 
        />
      )}
    </div>
  )
}

export default SettingsScreen

