; TEST-ONLY include used by scripts/test-installer-wine.sh. Never used for releases.
; Wine ships a stub powershell.exe that exits 0 for every command and a tasklist
; that ignores /FI filters, so electron-builder's "is the app running?" probe
; reports a false positive under Wine and aborts. This build replaces only that
; probe with a no-op; every other page, file, shortcut and registry step is the
; same as in the production installer (which includes installer.nsh directly).
!include "${BUILD_RESOURCES_DIR}\installer.nsh"
!macro customCheckAppRunning
  DetailPrint "Running-instance check skipped (Wine test build)"
!macroend
