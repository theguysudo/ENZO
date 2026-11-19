; ENZO — one-click Windows installer (NSIS)
;
; Built by desktop/package-windows.sh (mac/Linux cross-build) or
; desktop/package-windows.ps1 (Windows-native, used by CI). Installs a
; self-contained ENZO into $LOCALAPPDATA\ENZO — bundled node.exe + app +
; node_modules + built frontend. No git, no docker, no system Node needed.
;
; The Windows counterpart of the macOS drag-to-Applications DMG: run the exe,
; it installs, and it starts ENZO (the launcher boots the server and opens the
; browser at http://localhost:5200). The Finish page has "Run ENZO" checked by
; default, so the experience matches the DMG: install → ENZO is running.
;
; Data lives in %APPDATA%\ENZO (created by launcher.js) and survives upgrades;
; uninstalling keeps that data.
;
; EDITION — the same app ships in two theme editions, one installer each:
;   full — every homepage + workspace theme, with all theme videos (~295MB)
;   less — the docker-variant theme set only: Nebula drift on the homepage,
;          Default Particles + the NYC subway ride in the workspace, one video
; Both are the docker variant (no Google identity OAuth, provider-key
; onboarding). The editions install side by side — own install dir, own
; shortcuts, own uninstall entry — but SHARE %APPDATA%\ENZO, so the user's
; keys, memory and projects carry over when they switch editions.

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME "ENZO"
!define COMPANY "theguysudo"
!define APPURL "https://github.com/theguysudo/ENZO"
!define VERSION "$%ENZO_VERSION%"
; STAGED and OUTDIR are passed by the builder (absolute paths — NSIS resolves
; relative file paths against the CURRENT directory, not the script's folder).
!ifndef STAGED
  !define STAGED "staged"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\dist"
!endif
; EDITION picks the theme set + the install identity of this installer.
!ifndef EDITION
  !define EDITION "full"
!endif
; OUTNAME is the file name written into OUTDIR (passed by the builder).
!ifndef OUTNAME
  !define OUTNAME "ENZO-${VERSION}-setup.exe"
!endif

!if "${EDITION}" == "less"
  !define INSTALL_DIR "$LOCALAPPDATA\ENZO-less-theme"
  !define DISPLAY_NAME "ENZO (Less Theme)"
  !define SHORTCUT_NAME "ENZO (Less Theme)"
  !define REG_KEY "Software\ENZO-LessTheme"
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ENZO-LessTheme"
  !define EDITION_NOTE "The light edition — the docker-variant theme set only: Nebula drift, Default Particles, the NYC subway ride and the Bioluminescent Ocean clip."
!else
  !define INSTALL_DIR "$LOCALAPPDATA\ENZO"
  !define DISPLAY_NAME "ENZO"
  !define SHORTCUT_NAME "ENZO"
  !define REG_KEY "Software\ENZO"
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ENZO"
  !define EDITION_NOTE "The full edition — every homepage and workspace theme, with all theme videos."
!endif

Name "${DISPLAY_NAME} ${VERSION}"
OutFile "${OUTDIR}\${OUTNAME}"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "${REG_KEY}" "InstallDir"
RequestExecutionLevel user                  ; per-user install, no UAC prompt
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${DISPLAY_NAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0"

!define MUI_ICON "staged\favicon.ico"
!define MUI_UNICON "staged\favicon.ico"
!define MUI_ABORTWARNING

; Wizard copy mirrors the DMG's window ("DRAG TO INSTALL" → install + run)
!define MUI_WELCOMEPAGE_TITLE "Install ${DISPLAY_NAME} on this computer"
!define MUI_WELCOMEPAGE_TEXT "Everything ENZO needs is bundled — no Docker, no git, no Node install. After the install, ${APPNAME} starts and opens in your browser.$\r`n$\r`n${EDITION_NOTE}$\r`n$\r`nYour provider keys stay in your browser; the app runs on your own machine."
!define MUI_FINISHPAGE_TITLE "${DISPLAY_NAME} is installed"
!define MUI_FINISHPAGE_TEXT "${APPNAME} starts in the background and opens at http://localhost:5200. Close the console window (or use the 'Stop ENZO' shortcut) to shut it down.$\r`n$\r`nYour data lives in %APPDATA%\ENZO and survives updates."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; the launcher boots the server AND opens the browser — node.exe alone would
; only start a REPL, so the script argument is required. MUI quotes the
; executable itself; the parameter needs its own $\" quotes so a user name
; with a space ($INSTDIR = %LOCALAPPDATA%\ENZO) does not break the command.
!define MUI_FINISHPAGE_RUN "$INSTDIR\node-runtime\node.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "$\"$INSTDIR\app\launcher.js$\""
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME} now (it opens in your browser)"
!define MUI_FINISHPAGE_RUN_CHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${STAGED}\*.*"

  ; Shortcuts: launcher opens the console + browser; stop kills the server by pid
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\node-runtime\node.exe" '"$INSTDIR\app\launcher.js"' "$INSTDIR\favicon.ico" 0 SW_SHOWNORMAL
  CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" \
    "$INSTDIR\node-runtime\node.exe" '"$INSTDIR\app\launcher.js"' "$INSTDIR\favicon.ico" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}\Stop ${SHORTCUT_NAME}.lnk" "$INSTDIR\stop-enzo.cmd"
  WriteRegStr HKCU "${REG_KEY}" "InstallDir" "$INSTDIR"

  ; Uninstall metadata (shows in Settings → Apps)
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\favicon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${APPURL}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "un.Install"
  ; stop a running ENZO first (the pid file lives in the data dir)
  IfFileExists "$APPDATA\ENZO\enzo.pid" 0 +2
  nsExec::ExecToLog '"$INSTDIR\stop-enzo.cmd"'
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${SHORTCUT_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${REG_KEY}"
  ; %APPDATA%\ENZO (user data) is intentionally KEPT on uninstall
SectionEnd
