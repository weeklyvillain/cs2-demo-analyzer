; Custom NSIS script: register/unregister "Play in CS2" right-click context menu for .dem files

!macro customInstall
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2" "" "Open with CS2 Demo Analyzer"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --play-demo "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.dem\shell\PlayInCS2"
!macroend
