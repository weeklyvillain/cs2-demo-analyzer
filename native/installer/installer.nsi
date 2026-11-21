; CS2 Demo Analyzer (native) installer.
;
; Takes over the Electron install in place: same folder, exe name, uninstall key, shortcuts
; and .dem association, so the Electron updater (`installer.exe --updated /S --force-run`),
; taskbar pins and Explorer entries keep working. See ../MIGRATION.md.
;
; Built by build.py:  makensis /DVERSION=2.0.0 /DSTAGE=<staged files> /DOUTFILE=<setup.exe> installer.nsi

!ifndef VERSION
  !error "pass /DVERSION=x.y.z"
!endif
!ifndef STAGE
  !error "pass /DSTAGE=<folder with CS2 Demo Analyzer.exe, resources, bin>"
!endif
!ifndef OUTFILE
  !define OUTFILE "CS2-Demo-Analyzer-Setup-${VERSION}.exe"
!endif

!define PRODUCT "CS2 Demo Analyzer"
!define EXE "CS2 Demo Analyzer.exe"
!define UNINSTALLER "Uninstall CS2 Demo Analyzer.exe"
; electron-builder's GUID for appId com.csgriefer.app; keep it so Windows sees one app.
!define GUID "b777ecc9-42be-5c4f-b7cb-5056ce50e849"
!define BUILDER_KEY "Software\${GUID}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${GUID}"
!define PROGID "CS2 Demo File"
!define LNK "CS2 Demo Analyzer.lnk"

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

Name "${PRODUCT}"
Caption "${PRODUCT} ${VERSION} Setup"
OutFile "${OUTFILE}"
Icon "${STAGE}\resources\icon.ico"
UninstallIcon "${STAGE}\resources\icon.ico"
BrandingText "${PRODUCT} ${VERSION}"
InstallDir "$LOCALAPPDATA\Programs\cs-griefer-electron"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT"

!include LogicLib.nsh
!include FileFunc.nsh

; One-click, like the Electron installer: just the progress page.
Page instfiles
UninstPage instfiles

Var WantDesktop    ; 1 = create the desktop shortcut
Var WasElectron   ; 1 = an Electron install was found and replaced

; ---------------------------------------------------------------------------------------------
; Shared helpers

; Wait for the app to exit (the Electron updater starts us while the app is quitting).
; After ~10 s: end it when silent, ask otherwise.
!macro WAIT_FOR_APP un
Function ${un}WaitForApp
  Push $0
  Push $1
  StrCpy $1 0
  ${DoWhile} ${FileExists} "$INSTDIR\${EXE}"
    ClearErrors
    FileOpen $0 "$INSTDIR\${EXE}" a
    ${IfNot} ${Errors}
      FileClose $0
      ${ExitDo}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 >= 20
      ${If} ${Silent}
        nsExec::Exec 'taskkill /F /IM "${EXE}"'
        Pop $0
        Sleep 1000
        StrCpy $1 0
      ${Else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT} is running. Close it and press Retry." /SD IDCANCEL IDRETRY retry
        Abort
        retry:
        StrCpy $1 0
      ${EndIf}
    ${EndIf}
    Sleep 500
  ${Loop}
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro WAIT_FOR_APP ""
!insertmacro WAIT_FOR_APP "un."

; ---------------------------------------------------------------------------------------------
; Install

Function .onInit
  ; An earlier install (Electron or native) recorded where it lives.
  ReadRegStr $0 HKCU "${BUILDER_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

; Run the Electron uninstaller the way electron-builder does on its own upgrades:
; copied out of the folder, `_?=` so it runs in place and we wait for it, `--updated` so it
; keeps shortcuts and taskbar pins (KeepShortcuts=true), /KEEP_APP_DATA for the user's data.
Function RemoveElectron
  DetailPrint "Removing the Electron version"
  ${If} ${FileExists} "$INSTDIR\${UNINSTALLER}"
    InitPluginsDir
    CopyFiles /SILENT "$INSTDIR\${UNINSTALLER}" "$PLUGINSDIR\old-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /currentuser /KEEP_APP_DATA --updated _?=$INSTDIR' $0
    DetailPrint "Electron uninstaller exit code $0"
  ${EndIf}
  ; Whatever it left (or everything, if the uninstaller was missing).
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\${UNINSTALLER}"

  ; Chromium caches in the user-data folder. matches\, *.sqlite and cs2_configs\ stay.
  StrCpy $0 "$APPDATA\cs-griefer-electron"
  ${If} ${FileExists} "$0\settings.sqlite"
  ${OrIf} ${FileExists} "$0\matches\*.*"
    RMDir /r "$0\Cache"
    RMDir /r "$0\Code Cache"
    RMDir /r "$0\GPUCache"
    RMDir /r "$0\DawnCache"
    RMDir /r "$0\Local Storage"
    RMDir /r "$0\Session Storage"
    RMDir /r "$0\blob_storage"
    RMDir /r "$0\Network"
    RMDir /r "$0\Shared Dictionary"
    RMDir /r "$0\Crashpad"
    Delete "$0\SharedStorage"
    Delete "$0\Local State"
    Delete "$0\Preferences"
    Delete "$0\.updaterId"
  ${EndIf}
  ; The Electron updater's download cache. When the Electron updater started us we run from
  ; in here, so our own exe stays behind; that's fine.
  RMDir /r "$LOCALAPPDATA\cs-griefer-electron-updater"
FunctionEnd

Section "Install"
  SetShellVarContext current
  Call WaitForApp

  ; Desktop shortcut: on a fresh install, or when one is there already.
  ReadRegStr $0 HKCU "${BUILDER_KEY}" "InstallLocation"
  ${If} $0 == ""
  ${OrIf} ${FileExists} "$DESKTOP\${LNK}"
    StrCpy $WantDesktop 1
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    StrCpy $WasElectron 1
    Call RemoveElectron
  ${Else}
    ; Native → native: replace the bundled files, keep nothing stale.
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\bin"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${STAGE}\${EXE}"
  File /r "${STAGE}\resources"
  File /r "${STAGE}\bin"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; electron-builder's key: our .onInit and Electron-era installers look here.
  WriteRegStr HKCU "${BUILDER_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${BUILDER_KEY}" "ShortcutName" "${PRODUCT}"
  WriteRegStr HKCU "${BUILDER_KEY}" "KeepShortcuts" "true"

  ; Apps & features: the same entry the Electron app had, now pointing at our uninstaller.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT} ${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}" /currentuser'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /currentuser /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"

  ; .dem: keep whatever was there before as `<progid>_backup` (as electron-builder did).
  ReadRegStr $0 HKCU "Software\Classes\.dem" ""
  ${If} $0 != ""
  ${AndIf} $0 != "${PROGID}"
    WriteRegStr HKCU "Software\Classes\.dem" "${PROGID}_backup" "$0"
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\.dem" "" "${PROGID}"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" ""
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open" "" "Open with ${PRODUCT}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  ; Explorer "Play in CS2" verb (resources/installer.nsh in the Electron build).
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2" "" "Open with ${PRODUCT}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2" "Icon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2\command" "" '"$INSTDIR\${EXE}" --play-demo "%1"'
  ; SHCNE_ASSOCCHANGED
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Shortcuts carrying AppUserModelID com.csgriefer.app (the app writes them; NSIS can't).
  ${If} $WantDesktop == 1
    nsExec::Exec '"$INSTDIR\${EXE}" --install-shortcuts --desktop'
  ${Else}
    nsExec::Exec '"$INSTDIR\${EXE}" --install-shortcuts'
  ${EndIf}
  Pop $0
  ${If} $0 != 0
    ; Fallback without the app ID; still opens the app.
    CreateShortcut "$SMPROGRAMS\${LNK}" "$INSTDIR\${EXE}"
    ${If} $WantDesktop == 1
      CreateShortcut "$DESKTOP\${LNK}" "$INSTDIR\${EXE}"
    ${EndIf}
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Silent installs start the app only when asked (the updater passes --force-run), or when
  ; they replaced Electron: its Settings → "Download and Install Version" runs us with just /S
  ; and quits. A normal install always starts it, like Electron's runAfterFinish.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--force-run" $1
  ${If} ${Errors}
  ${AndIf} ${Silent}
  ${AndIf} $WasElectron != 1
    Return
  ${EndIf}
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd

; ---------------------------------------------------------------------------------------------
; Uninstall. User data (%APPDATA%\cs-griefer-electron) stays, as with Electron.

Section "Uninstall"
  SetShellVarContext current
  Call un.WaitForApp

  ; An installer replacing us (another version, or Electron on a rollback) runs this with
  ; --updated, as electron-builder does: keep the shortcuts, and with them taskbar pins.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${If} ${Errors}
    Delete "$SMPROGRAMS\${LNK}"
    Delete "$DESKTOP\${LNK}"
  ${EndIf}

  ; .dem back to what it was before us.
  ReadRegStr $0 HKCU "Software\Classes\.dem" ""
  ${If} $0 == "${PROGID}"
    ReadRegStr $1 HKCU "Software\Classes\.dem" "${PROGID}_backup"
    ${If} $1 != ""
      WriteRegStr HKCU "Software\Classes\.dem" "" "$1"
    ${Else}
      DeleteRegValue HKCU "Software\Classes\.dem" ""
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.dem" "${PROGID}_backup"
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${BUILDER_KEY}"

  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
SectionEnd
