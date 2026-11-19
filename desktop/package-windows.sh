#!/usr/bin/env bash
#
# desktop/package-windows.sh — build the ENZO Windows installer (NSIS) from
# the current working tree, on macOS or Linux. Produces the same artifact as
# the Windows-native path (desktop/package-windows.ps1, used by CI):
#
#   ./desktop/package-windows.sh less
#     → desktop/dist/ENZO-<version>-less-theme-setup.exe
#   ./desktop/package-windows.sh full
#     → desktop/dist/ENZO-<version>-full-theme-setup.exe
#
# Two theme editions, same app, same docker variant (no Google identity OAuth
# — provider-key onboarding):
#
#   less — the docker-variant theme set only: Nebula drift on the homepage,
#          Default Particles + the NYC subway ride in the workspace. One theme
#          video ships (the 3.3MB subway loop).
#   full — every homepage + workspace theme, with all theme videos (~295MB).
#
# The bundle is fully self-contained: node.exe runtime, the backend tree with
# production deps (+ tsx), the built frontend and launcher.js. A user runs the
# exe, it installs into %LOCALAPPDATA%\ENZO (or %LOCALAPPDATA%\ENZO-less-theme
# for the light edition), starts ENZO and opens the browser — the Windows
# equivalent of the macOS drag-to-Applications DMG.
#
# Cross-build notes (this runs on macOS):
# - better-sqlite3 is a native module ENZO never imports (only referenced in
#   the coding prompt text). It is dropped from the bundle: it cannot be
#   cross-compiled from macOS, and shipping the mac binary would break on
#   Windows. The Windows-native build compiles it properly and keeps it.
# - tsx needs the platform esbuild binary → @esbuild/win32-x64 is installed
#   into the staged tree and the macOS one is removed.
# - node.exe comes from the official Node 22 Windows zip.
#
# Requirements: node/npm, curl, and makensis (brew install nsis).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$REPO/package.json').version")"
NODE_VERSION="v22.14.0"   # same LTS line as the docker image / macOS build

EDITION="${1:-less}"
case "$EDITION" in
  less)
    # docker-variant themes only (the lite frontend build)
    THEME_VARIANT="lite"
    OUTNAME="ENZO-$VERSION-less-theme-setup.exe"
    ;;
  full)
    # every theme + every theme video
    THEME_VARIANT="full"
    OUTNAME="ENZO-$VERSION-full-theme-setup.exe"
    ;;
  *)
    echo "usage: $0 [less|full]   (less = docker-variant themes only, full = all themes)" >&2
    exit 2
    ;;
esac

OUT="$REPO/desktop/dist"
WIN="$REPO/desktop/windows"
STAGED="$WIN/staged"
APPDIR="$STAGED/app"

command -v makensis >/dev/null 2>&1 || { echo "error: makensis is required (brew install nsis)" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }

echo "▸ ENZO $VERSION (Windows x64, $EDITION theme edition) — staging into desktop/windows/staged"

echo "▸ 1/6 frontend build (docker variant: no Google OAuth, $THEME_VARIANT themes)"
(cd "$REPO/synthetic-nature" && VITE_GOOGLE_AUTH=0 VITE_THEME_VARIANT="$THEME_VARIANT" npm run build --silent)

echo "▸ 2/6 app tree"
rm -rf "$STAGED"
mkdir -p "$APPDIR" "$STAGED/node-runtime" "$OUT"
cp "$REPO/index.ts" "$REPO/tsconfig.json" "$REPO/package.json" "$REPO/package-lock.json" "$APPDIR/"
cp -R "$REPO/src" "$APPDIR/src"
cp -R "$REPO/skills-bundled" "$APPDIR/skills-bundled"
mkdir -p "$APPDIR/synthetic-nature"
cp -R "$REPO/synthetic-nature/dist" "$APPDIR/synthetic-nature/dist"
# lite build: keep only the docker-variant theme videos (same rule the lite
# docker image uses) — the subway loop and the Bioluminescent Ocean clip
if [ "$THEME_VARIANT" = "lite" ]; then
  find "$APPDIR/synthetic-nature/dist/background_elements" -name '*.mp4' \
    ! -name 'Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4' \
    ! -name 'Bioluminescent_ocean.mp4' -delete 2>/dev/null || true
fi
cp "$REPO/desktop/launcher.js" "$APPDIR/launcher.js"
# the launcher reads this to tell the two editions apart (the in-app updater
# must download the same edition it is running)
printf '%s\n' "$EDITION" > "$APPDIR/edition.txt"
# never ship local runtime data — launcher.js creates the per-user dirs
rm -rf "$APPDIR/src/intelligence/data" "$APPDIR/src/neural-engine/data" \
       "$APPDIR/src/skills/skills" "$APPDIR/src/skills/.skill-tmp"

echo "▸ 3/6 server dependencies (npm ci + tsx, typescript/@types stripped)"
(cd "$REPO" && npm ci --include=dev --silent --ignore-scripts --prefix "$APPDIR")
rm -rf "$APPDIR/node_modules/typescript" "$APPDIR/node_modules/@types" \
       "$APPDIR/node_modules/.bin/tsc" "$APPDIR/node_modules/.bin/tsserver"

echo "▸ 4/6 platform binaries for Windows"
# esbuild: swap the host platform package for the Windows one (tsx loads it).
# npm refuses os-specific packages on the wrong platform → --force; the version
# must match the esbuild release installed by npm ci.
ESB_VER="$(node -p "require('$APPDIR/node_modules/esbuild/package.json').version")"
rm -rf "$APPDIR/node_modules/@esbuild/darwin-arm64" "$APPDIR/node_modules/@esbuild/linux-x64"
(cd "$APPDIR" && npm install --no-save --no-package-lock --ignore-scripts --force "@esbuild/win32-x64@$ESB_VER" >/dev/null 2>&1) || true
test -f "$APPDIR/node_modules/@esbuild/win32-x64/esbuild.exe" \
  || { echo "error: @esbuild/win32-x64 ($ESB_VER) did not install — tsx would not start on Windows" >&2; exit 1; }
# npm re-adds the host platform package while resolving — the Windows build
# never loads it, and it is 11MB of dead weight
rm -rf "$APPDIR/node_modules/@esbuild/darwin-arm64" "$APPDIR/node_modules/@esbuild/linux-x64"
# better-sqlite3 cannot be cross-compiled from macOS and ENZO never imports it
rm -rf "$APPDIR/node_modules/better-sqlite3"

echo "▸ 5/6 node.exe runtime"
NODE_ZIP="node-$NODE_VERSION-win-x64.zip"
curl -fsSL -o "$OUT/$NODE_ZIP" "https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP"
unzip -q -o "$OUT/$NODE_ZIP" -d "$OUT/node-win"
rm -rf "$STAGED/node-runtime" && mkdir -p "$STAGED/node-runtime"
cp -R "$OUT/node-win/node-$NODE_VERSION-win-x64/." "$STAGED/node-runtime/"
rm -rf "$OUT/$NODE_ZIP" "$OUT/node-win"
# npm/corepack belong to dev machines, not a one-click app
rm -rf "$STAGED/node-runtime/node_modules/npm" "$STAGED/node-runtime/node_modules/corepack" \
       "$STAGED/node-runtime/npm.cmd" "$STAGED/node-runtime/npx.cmd" "$STAGED/node-runtime/corepack.cmd"

echo "▸ 6/6 NSIS installer"
cp "$WIN/stop-enzo.cmd" "$STAGED/stop-enzo.cmd"
# installer icon + branded wizard bitmap (the EZ monogram)
cp "$REPO/synthetic-nature/public/favicon.ico" "$STAGED/favicon.ico"

(cd "$WIN" && ENZO_VERSION="$VERSION" makensis -DSTAGED="$STAGED" -DOUTDIR="$OUT" \
  -DEDITION="$EDITION" -DOUTNAME="$OUTNAME" enzo.nsi)

EXE="$OUT/$OUTNAME"
test -f "$EXE" || { echo "error: installer was not produced" >&2; exit 1; }
echo ""
echo "✓ $EXE ($(( $(stat -f%z "$EXE" 2>/dev/null || stat -c%s "$EXE") / 1024 / 1024 )) MB)"
echo "  SmartScreen: unsigned build → 'More info' → 'Run anyway' on first install"
