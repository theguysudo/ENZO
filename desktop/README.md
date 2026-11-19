# ENZO desktop installers (one-click, no Docker / git / terminal)

Builds a fully self-contained native install per platform:

| Platform | Artifact | Produced by | Tested on |
|---|---|---|---|
| macOS | `ENZO-<ver>-macOS-<arch>.dmg` (drag → Applications) | `package-macos.sh` | built + live-tested locally (2026-11-11) |
| Windows | `ENZO-<ver>-full-theme-setup.exe` (NSIS, per-user install, starts ENZO at the end) | `package-windows.sh full` (mac/Linux cross-build) or `package-windows.ps1 full` (Windows-native, CI) | payload tree boot-verified locally; **not yet run on a real Windows machine** |
| Windows | `ENZO-<ver>-less-theme-setup.exe` (same app, docker-variant themes only) | `package-windows.sh less` / `package-windows.ps1 less` | payload tree boot-verified locally |

## The two Windows theme editions

Same app, same docker variant, same features — only the **theme set** differs:

| Edition | Homepage themes | Workspace themes | Theme videos | Installer |
|---|---|---|---|---|
| **full** | all 9 (Nebula drift + 8 anime scenes) | all 12 (Default Particles + 11 video scenes) | all 26 (~295MB) | `ENZO-<ver>-full-theme-setup.exe` |
| **less** | 1 (Nebula drift — pure WebGL, no video) | 3 (Default Particles + NYC subway ride + Bioluminescent Ocean) | 3 (~17MB) | `ENZO-<ver>-less-theme-setup.exe` |

The **less** edition is the docker-variant theme set the `enzo:lite` image ships:
one homepage theme (pure WebGL, no video), one workspace theme that needs no
video, and the two short video themes. It is the light download for weak
machines or metered connections; the **full** edition is the complete theme
gallery.

Both installers are the docker variant (no Google identity OAuth), install
side by side (own install dir — `%LOCALAPPDATA%\ENZO` vs
`%LOCALAPPDATA%\ENZO-less-theme` — own shortcuts, own uninstall entry) and
**share `%APPDATA%\ENZO`**, so the user's keys, memory and projects carry over
when they switch editions. The running edition is recorded in
`app/edition.txt` and exported as `ENZO_DESKTOP_EDITION`, so the in-app
updater always downloads the same edition it is running.

## How it works

Both platforms ship the same bundle: a **pinned Node 22 runtime**, the backend
tree with production deps (+ tsx, typescript stripped), the **built frontend**
and `launcher.js`. The launcher (plain Node, zero deps):

1. creates the per-user data dir — `~/Library/Application Support/ENZO`
   (macOS) / `%APPDATA%\ENZO` (Windows) — and redirects **all** writable state
   there via env (`ENZO_DATA_DIR`, `ENZO_MEMORY_PATH`, `ENZO_INTEL_DIR`,
   `ENZO_NEURAL_DIR`, `ENZO_PROJECTS_DIR`, `ENZO_SKILLS_DIR`), because the app
   bundle is read-only and gets replaced on upgrades;
2. boots the server on **port 5200** (the docker variant's port; falls forward
   to 5220 if taken) with `NODE_ENV=production` — that env is what gates
   single-origin serving of the built frontend, without it `/` 404s;
3. waits for the server's own `-> listening on http://localhost:<port>` line
   on stdout (never a cross-process health probe — another service holding
   the port will answer those);
4. opens the browser and stays alive while ENZO runs; logs to `<data>/enzo.log`.

**The desktop build IS the docker variant**: the frontend is built with
`VITE_GOOGLE_AUTH=0` (Google identity OAuth is dead-code-eliminated from the
bundle — no `accounts.google.com` anywhere) and `VITE_THEME_VARIANT=lite` for
the light edition / `full` for the complete theme gallery, and the backend runs
with `ENZO_GOOGLE_AUTH=0` (no Google identity routes; provider-key onboarding
only). That means a desktop user never sees a Google login screen.

### In-app updates (one click, twice a week, never forced)

`src/desktop/update.ts` gives the desktop builds a real update path — a docker
user gets a link to the release notes, a desktop user gets the update itself:

- **Check** — the backend reads the latest GitHub release (every 6h at most),
  compares it with the running version and picks the asset for this platform
  (`…-macOS-arm64.dmg` / `…-full-theme-setup.exe` / `…-less-theme-setup.exe` —
  on Windows the edition must match the running one).
- **Remind** — the banner appears **at most twice per rolling week** (tracked
  in `<data>/update-state.json`). "Later" keeps the current version; nothing is
  ever forced and the banner is dismissible.
- **Apply** — one click: the asset is downloaded, mounted (macOS) or run
  silently (Windows), the new bundle is staged, and a detached helper swaps
  the app in place, clears the quarantine flag, re-signs it ad hoc and
  relaunches. ENZO restarts by itself — no installer to hunt for.
- **Nothing is lost**: memory, vault keys, investigations, neural state and
  generated projects live in the per-user data dir *outside* the app bundle,
  and the browser tab (localStorage) survives the restart.

The routes are loopback-only and exist only in desktop installs (the launcher
sets `ENZO_DESKTOP_HOME`), and they need no vault token — a fresh install
hears about updates before any provider key is claimed.

Quitting: **macOS** — the app shows in the Dock; Dock → Quit (or Cmd-Q) relays
through a tiny compiled Swift shell (`macos/main.swift`, the .app's actual
executable — a bash/node wrapper cannot answer the quit AppleEvent, tested)
as SIGTERM to the launcher, which stops the server before exiting. **Windows**
— close the launcher console window, or the "Stop ENZO" Start-menu shortcut.

Build requirements: macOS needs Xcode Command Line Tools on the BUILD machine
only (`swiftc` for the quit shell — the script falls back to a bash wrapper
without it, and then Dock → Quit does not work). Windows needs NSIS.

## What the user does

- **macOS**: open the DMG, drag ENZO to Applications, double-click. A copy
  *downloaded* from GitHub is ad-hoc signed but not cert-signed: on first
  launch, right-click → Open once (Gatekeeper). Locally built copies have no
  quarantine at all. The app icon is the **EZ monogram** (the project's main
  logo) on a white rounded square — the same artwork as the website's
  apple-touch-icon — generated from the committed master
  `desktop/assets/enzo-icon-1024.png` at package time.
- **Windows**: run the setup exe — `…-full-theme-setup.exe` for the complete
  theme gallery, `…-less-theme-setup.exe` for the light one (unsigned →
  SmartScreen: More info → Run anyway), then use the desktop shortcut ("ENZO",
  or "ENZO (Less Theme)") — the installer's last page starts ENZO for you
  (same "install → running" feel as the DMG). Closing the console window stops
  ENZO; the "Stop ENZO" Start-menu shortcut does the same from the desktop.
  Uninstalling keeps `%APPDATA%\ENZO` (their data).

## Build it yourself

```bash
./desktop/package-macos.sh                      # macOS, host arch
./desktop/package-windows.sh less               # Windows .exe, light themes (cross-built from mac/Linux)
./desktop/package-windows.sh full               # Windows .exe, all themes (cross-built from mac/Linux)
powershell desktop/package-windows.ps1 less     # Windows .exe, light themes (native, needs NSIS)
powershell desktop/package-windows.ps1 full     # Windows .exe, all themes (native, needs NSIS)
```

`package-windows.sh` needs `makensis` (`brew install nsis`). The cross-build
ships the Windows esbuild binary that tsx loads and **drops `better-sqlite3`**
(it cannot be cross-compiled from macOS and ENZO's own runtime never imports
it — only the coding prompt mentions it; the Windows-native build compiles it
properly and keeps it). The Windows-native script (used by the
`desktop-release.yml` CI job) needs no such swap.

Or Actions → **Desktop installers** → Run workflow (also attaches to a
release when triggered by a `v*` tag; pushing the workflow file needs the
ADITYADUBEY2023 token — theguysudo's active token lacks `workflow` scope).

## Deliberate v1 limits

- No code-signed certs (Apple notarization / Windows EV): the one-time
  Gatekeeper/SmartScreen prompts above are the honest trade-off until a cert
  is bought. No auto-updater yet — the update banner already tells users a
  new release exists; replacing the app in /Applications (or re-running the
  exe) upgrades in place while data survives.
- No Electron/Tauri: the browser **is** the UI and already ships with every
  OS; the launcher adds ~200 lines instead of ~150MB of framework.
- Generated projects needing `better-sqlite3` compile from source on first
  use — machines without a C toolchain (no Xcode CLT / VS Build Tools) will
  fail that one path; core ENZO never needs it.
