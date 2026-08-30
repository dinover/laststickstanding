; Custom installer script — replaces electron-builder's own NSIS template, which has a broken
; internal step in this environment (its "pre-build the uninstaller, then embed it" trick never
; produces the uninstaller file, for reasons that held up even elevated/PowerShell/clean-version
; testing). This is the plain, standard single-pass NSIS install/uninstall pattern instead: no
; separate uninstaller pre-generation, no multi-user/elevation dance — just install, write an
; uninstaller inline, register it so it shows in Windows' "Apps y caracteristicas".
Name "Last Stick Standing"
RequestExecutionLevel user
InstallDir "$LocalAppData\Programs\Last Stick Standing"
Icon "${MUI_ICON}"
UninstallIcon "${MUI_UNICON}"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LastStickStanding"

; Plain classic NSIS UI (not Modern UI) — avoids MUI's per-language string tables entirely,
; which is what broke the build (electron-builder's shared header registers many languages,
; and -WX turns a missing MUI_TEXT_WELCOME_INFO_TITLE string in one of them into a hard error).
Page directory
Page instfiles

UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}\dist\win-unpacked\*.*"

  CreateDirectory "$SMPROGRAMS\Last Stick Standing"
  CreateShortcut "$SMPROGRAMS\Last Stick Standing\Last Stick Standing.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  CreateShortcut "$DESKTOP\Last Stick Standing.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Last Stick Standing"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Last Stick Standing"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Last Stick Standing\Last Stick Standing.lnk"
  RMDir "$SMPROGRAMS\Last Stick Standing"
  Delete "$DESKTOP\Last Stick Standing.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
