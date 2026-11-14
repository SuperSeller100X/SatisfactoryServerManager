; Satisfactory Server Manager — NSIS customisations for electron-builder's
; assisted installer. Page order:
;   Welcome → License (LICENSE) → Install mode (defaults to "Only for me")
;   → Directory → Progress → Finish (launch app, optional desktop shortcut)
; The installer is per-user by default (%LOCALAPPDATA%\Programs) and only asks
; for elevation if the user explicitly chooses "Anyone who uses this computer".

!macro customHeader
  ; Branding text at the bottom of every page instead of "Nullsoft Install System".
  BrandingText "Satisfactory Server Manager ${VERSION}"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Satisfactory Server Manager ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "This wizard installs Satisfactory Server Manager, the control center for Satisfactory dedicated servers on Windows.$\r$\n$\r$\nThe manager program is installed separately from your server files: after installation, the first-launch assistant lets you choose a dedicated folder for the Satisfactory server and downloads it with SteamCMD.$\r$\n$\r$\nNo administrator rights are needed for a standard installation.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  ; Optional desktop shortcut, unchecked by default (Start Menu shortcut is always created).
  Function CreateDesktopShortcut
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_FILENAME}.lnk" "${APP_ID}"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "Satisfactory Server Manager is ready"
  !define MUI_FINISHPAGE_TEXT "Satisfactory Server Manager ${VERSION} has been installed.$\r$\n$\r$\nOn first launch, the setup assistant checks your PC, lets you choose the server folder and installs the Satisfactory Dedicated Server for you."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Satisfactory Server Manager"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall Satisfactory Server Manager"
  !define MUI_WELCOMEPAGE_TEXT "This removes the Satisfactory Server Manager program.$\r$\n$\r$\nYour Satisfactory server installations, save games and backups are NOT deleted — they live in the folders you chose and in your user profile, so you can reinstall the manager later and attach them again.$\r$\n$\r$\nPlease stop running servers before uninstalling.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUnInstall
  ; Remove the optional desktop shortcut created from the finish page (if present).
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    ; Remove the per-user "start at sign-in" entry the app may have created (opt-in setting).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"
  ${endIf}
!macroend
