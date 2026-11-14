# Windows test instructions

Parts of the product depend on Windows and on real Steam connectivity. The
automated tests in this repository run on Linux (unit/integration tests and
Electron end-to-end tests) and the installer was exercised under Wine 9. The
following checks must be performed on a real Windows 10/11 x64 machine before
a release. Use a fresh Windows user account (or a VM snapshot) for the
first-run checks.

## A. Build

```bash
npm ci
```

```bash
npm test
```

```bash
npm run dist:win
```

Expected: `dist\SatisfactoryServerManager-Setup-1.0.0.exe` and
`dist\SatisfactoryServerManager-1.0.0-x64.zip`.

## B. Installer

1. Run the setup as a **standard (non-admin) user**. No UAC prompt must appear.
2. Welcome page shows the branded sidebar and text. **Next**.
3. License page shows the full proprietary license. **I Agree**.
4. Install mode: “Only for me” is preselected. **Next**.
5. Directory: default `%LOCALAPPDATA%\Programs\Satisfactory Server Manager`.
   Click **Browse…**, pick another folder, then go back to the default. **Install**.
6. Progress completes; the finish page shows “Launch …” (checked) and
   “Create a desktop shortcut” (unchecked).
7. Tick the desktop shortcut, leave launch ticked, **Finish**.
8. Verify:
   - The app starts and shows the setup assistant.
   - Start Menu → *Satisfactory Server Manager* exists and launches the app.
   - Desktop shortcut exists (and not when the box was left unticked — repeat once).
   - *Settings → Apps → Installed apps* lists “Satisfactory Server Manager”,
     version 1.0.0, publisher SuperSeller100X, with the app icon.
   - `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall /s /f "Satisfactory Server Manager"` shows the entry; nothing under HKLM.
9. Re-run the installer while the app is open: it must offer to close the app
   (running-instance check; this check cannot be verified under Wine).
10. Silent install for IT use: `SatisfactoryServerManager-Setup-1.0.0.exe /S`
    installs per-user without UI.

## C. Uninstall

1. *Installed apps → Satisfactory Server Manager → Uninstall*.
2. The branded uninstaller explains that servers, saves and backups are kept.
3. After completion verify: program folder removed, Start Menu and desktop
   shortcuts removed, Apps & Features entry removed,
   `HKCU\...\Run` has no Satisfactory Server Manager entry,
   `%APPDATA%\Satisfactory Server Manager` and the server folder still exist.

## D. First-launch assistant

1. Launch the app with a fresh user profile → assistant appears.
2. **Check this PC**: Windows version, RAM, CPU, disk, SteamCMD (not installed),
   Visual C++ runtime status are shown.
3. **Server folder**:
   - Type `C:\Program Files\Test` → refused (protected folder).
   - Choose the app's program folder → refused.
   - Choose a folder with unrelated files → refused (non-empty).
   - Accept the suggested folder; *Continue* stays disabled until the
     confirmation box is ticked.
   - Pick *Experimental* if Steam currently publishes that branch.
4. **Prerequisites**: SteamCMD downloads to
   `%LOCALAPPDATA%\SatisfactoryServerManager\steamcmd` and self-updates. If the
   VC++ runtime was missing, tick “Install it now”, approve the UAC prompt and
   confirm the check turns green.
5. **Install server**: progress shows downloading/verifying with percentage and
   bytes. After completion `steamapps\appmanifest_1690800.acf` exists in the
   server folder with `StateFlags 4`.
6. **Interrupted install**: start a fresh install in a new folder, close the
   app via the tray icon → *Quit* at ~20 %. Verify in Task Manager that no
   `steamcmd.exe` keeps running. Relaunch → assistant shows “Setup was
   interrupted”, *Resume installation* continues (does not restart from 0 %),
   and *Remove partial files* deletes only that folder.
7. **Partial installation repair**: delete
   `<server>\Engine\Binaries\Win64\FactoryServer-Win64-Shipping-Cmd.exe`,
   run the assistant again → partial installation detected → *Resume* repairs it.
8. **Network**: occupy port 7777 (e.g. `python -m http.server 7777`) → conflict
   shown with suggested ports. Release it. *Create firewall rules* → UAC prompt →
   rules named “Satisfactory Server Manager - …” appear in
   `wf.msc` → step shows “Allowed”. Cancelling UAC shows a clear message.
9. **Security**: *Start server* → server reaches “responding” → claim with a
   name and admin password → “API access is configured”. Restart the app and
   confirm the player count/tick rate appear on the dashboard. Repeat on a
   claimed server with *Sign in* and a wrong password (clear error).
10. **Review / Finish**: summary correct; *Open dashboard* with *Start the
    server now* → dashboard shows the server online.
11. **Already-installed detection**: run *Add server* and choose the existing
    folder → “Use an existing installation”; the install step reports it as
    installed without downloading.
12. **Start with Windows**: enable the option in the finish step, sign out and
    in → the manager starts minimized in the tray.

## E. Shutdown behaviour

With a running server and API access configured: shut down Windows. The
manager saves the game and stops the server within the grace period
(*Settings → Startup & shutdown*). Check the next run's console history for
“Saved game as … before shutdown”. Windows limits how long applications may
delay shutdown; very long grace periods can be cut short by Windows.
