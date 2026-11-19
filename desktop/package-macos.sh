#!/usr/bin/env bash
#
# desktop/package-macos.sh — build ENZO.app + a drag-to-Applications DMG from
# the current working tree. The result is fully self-contained: bundled Node
# runtime, production deps (+ tsx), built frontend — a non-technical user only
# double-clicks the .app. No git clone, no docker, no system Node needed.
#
#   ./desktop/package-macos.sh
#   → desktop/dist/ENZO-<version>-macOS-<arch>.dmg
#
# Notes:
# - Signed ad hoc ("codesign --sign -"). Without a paid Apple Developer cert
#   the DMG still runs, but Gatekeeper asks for right-click → Open on first
#   launch of a DOWNLOADED copy (a locally built copy has no quarantine at
#   all). Apple Silicon kills completely unsigned binaries — the ad hoc
#   signature is what keeps local launches clean.
# - Writable state is redirected to ~/Library/Application Support/ENZO by
#   launcher.js (the bundle itself is read-only and gets replaced on updates).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$REPO/package.json').version")"
ARCH="$(uname -m)"
NODE_ARCH="$([ "$ARCH" = "arm64" ] && echo arm64 || echo x64)"
NODE_VERSION="v22.14.0" # matches the node:22-slim line the docker image ships

OUT="$REPO/desktop/dist"
STAGE="$OUT/stage"
APP="$STAGE/ENZO.app/Contents"
APPDIR="$APP/Resources/app"
BACKGROUND="$REPO/desktop/assets/dmg-background.png"
ICON_MASTER="$REPO/desktop/assets/enzo-icon-1024.png"

for tool in codesign hdiutil iconutil osascript SetFile sips; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done
test -f "$ICON_MASTER" || { echo "error: missing $ICON_MASTER" >&2; exit 1; }
test -f "$BACKGROUND" || { echo "error: missing $BACKGROUND" >&2; exit 1; }
test "$(sips -g pixelWidth "$BACKGROUND" | awk '/pixelWidth:/ { print $2 }')" = 1320 \
  && test "$(sips -g pixelHeight "$BACKGROUND" | awk '/pixelHeight:/ { print $2 }')" = 840 \
  || { echo "error: DMG background must be 1320x840" >&2; exit 1; }

echo "▸ ENZO $VERSION (macOS $NODE_ARCH) — staging into desktop/dist"

echo "▸ 1/7 frontend build (docker variant: no Google OAuth, lite themes)"
(cd "$REPO/synthetic-nature" && VITE_GOOGLE_AUTH=0 VITE_THEME_VARIANT=lite npm run build --silent)

echo "▸ 2/7 Node runtime download"
rm -rf "$STAGE"
mkdir -p "$APP/Resources/node-runtime" "$APPDIR" "$APP/MacOS"
NODE_TGZ="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
curl -fsSL -o "$OUT/$NODE_TGZ" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ"
tar -xzf "$OUT/$NODE_TGZ" -C "$APP/Resources/node-runtime" --strip-components=1
rm "$OUT/$NODE_TGZ"

echo "▸ 3/7 app tree"
cp "$REPO/index.ts" "$REPO/tsconfig.json" "$REPO/package.json" "$REPO/package-lock.json" "$APPDIR/"
cp -R "$REPO/src" "$APPDIR/src"
cp -R "$REPO/skills-bundled" "$APPDIR/skills-bundled"
mkdir -p "$APPDIR/synthetic-nature"
cp -R "$REPO/synthetic-nature/dist" "$APPDIR/synthetic-nature/dist"
# desktop is a LITE build — keep only the docker-variant theme videos (the
# same rule the lite docker image applies; unfiltered, public/ drags ~320MB of
# theme mp4s in): the subway loop and the Bioluminescent Ocean clip.
find "$APPDIR/synthetic-nature/dist/background_elements" -name '*.mp4' \
  ! -name 'Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4' \
  ! -name 'Bioluminescent_ocean.mp4' -delete 2>/dev/null || true
cp "$REPO/desktop/launcher.js" "$APPDIR/launcher.js"
# runtime data dirs are created per-user by launcher.js — never ship local ones
rm -rf "$APPDIR/src/intelligence/data" "$APPDIR/src/neural-engine/data" \
       "$APPDIR/src/skills/skills" "$APPDIR/src/skills/.skill-tmp"

echo "▸ 4/7 server dependencies (npm ci + tsx, typescript/@types stripped — runtime never needs tsc)"
cp "$REPO/package.json" "$REPO/package-lock.json" "$OUT/.pkg-stamp" 2>/dev/null || true
(cd "$REPO" && npm ci --include=dev --silent --prefix "$APPDIR")
rm -rf "$APPDIR/node_modules/typescript" "$APPDIR/node_modules/@types" \
       "$APPDIR/node_modules/.bin/tsc" "$APPDIR/node_modules/.bin/tsserver"

# the bundled runtime only needs the node binary — npm/corepack/corepack shims
# live in the user's toolchain world, not in a one-click app (~50MB saved)
rm -rf "$APP/Resources/node-runtime/bin/npm" "$APP/Resources/node-runtime/bin/npx" \
       "$APP/Resources/node-runtime/bin/corepack" "$APP/Resources/node-runtime/lib/node_modules" \
       "$APP/Resources/node-runtime/share" "$APP/Resources/node-runtime/include"

echo "▸ 5/7 app executable + Info.plist + icon"
# CFBundleExecutable must be a real AppKit binary: a bash/node wrapper cannot
# answer the Dock's quit AppleEvent (the app would be unquittable). Compile
# the tiny Swift shell that relays Dock → Quit to the launcher as SIGTERM.
if command -v swiftc >/dev/null 2>&1; then
  swiftc -O "$REPO/desktop/macos/main.swift" -o "$APP/MacOS/ENZO"
else
  echo "  ⚠ swiftc not found — falling back to the bash wrapper (Dock → Quit will NOT work; install Xcode CLT and rebuild)"
  cat > "$APP/MacOS/ENZO" <<WRAP
#!/bin/bash
RESOURCES="\$(cd "\$(dirname "\$0")/../Resources" && pwd)"
exec "\$RESOURCES/node-runtime/bin/node" "\$RESOURCES/app/launcher.js"
WRAP
  chmod +x "$APP/MacOS/ENZO"
fi

cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ENZO</string>
  <key>CFBundleDisplayName</key><string>ENZO</string>
  <key>CFBundleExecutable</key><string>ENZO</string>
  <key>CFBundleIdentifier</key><string>io.github.theguysudo.ENZO</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>enzo</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Apache-2.0 — https://github.com/theguysudo/ENZO</string>
</dict></plist>
PLIST

# App icon: the EZ monogram (the project's main logo) on a white rounded
# square — the same artwork the website's apple-touch-icon uses. The 1024px
# master is committed (desktop/assets/enzo-icon-1024.png) so this step needs
# no image tooling beyond macOS's own sips + iconutil.
ICONSET="$OUT/enzo.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICON_MASTER" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  retina=$((s * 2))
  sips -z "$retina" "$retina" "$ICON_MASTER" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
test "$(sips -g pixelWidth "$ICONSET/icon_512x512@2x.png" | awk '/pixelWidth:/ { print $2 }')" = 1024
iconutil -c icns "$ICONSET" -o "$APP/Resources/enzo.icns"
rm -rf "$ICONSET"

echo "▸ 6/7 ad-hoc codesign"
codesign --force --deep --sign - "$STAGE/ENZO.app" 2>/dev/null \
  || echo "  (codesign unavailable — continuing; local launches still fine on Intel, NOT on Apple Silicon)"

echo "▸ 7/7 flagship DMG"
VOLUME_NAME="ENZO $VERSION"
DMG="$OUT/ENZO-$VERSION-macOS-$NODE_ARCH.dmg"
RW_DMG="$OUT/ENZO-$VERSION-layout.dmg"
NEXT_DMG="$OUT/ENZO-$VERSION-macOS-$NODE_ARCH.next.dmg"
MOUNT_POINT="/Volumes/$VOLUME_NAME"
DEVICE=""

cleanup_dmg() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$DEVICE" ]; then
    hdiutil detach "$DEVICE" -quiet 2>/dev/null \
      || hdiutil detach "$DEVICE" -force -quiet 2>/dev/null \
      || true
  fi
  rm -f "$RW_DMG" "$NEXT_DMG"
  exit "$status"
}
trap cleanup_dmg EXIT INT TERM

if hdiutil info | grep -Fq "$MOUNT_POINT" || [ -e "$MOUNT_POINT" ]; then
  echo "error: $MOUNT_POINT is already in use" >&2
  exit 1
fi

rm -rf "$STAGE/.background"
rm -f "$RW_DMG" "$NEXT_DMG"
# ponytail: native Finder metadata is enough; add a DMG dependency only if macOS automation becomes unreliable.
ln -sfn /Applications "$STAGE/Applications"
mkdir -p "$STAGE/.background"
install -m 0644 "$BACKGROUND" "$STAGE/.background/dmg-background.png"

hdiutil create -srcfolder "$STAGE" -volname "$VOLUME_NAME" \
  -fs HFS+ -format UDRW -ov "$RW_DMG" >/dev/null
ATTACH_OUTPUT="$(hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen -mountpoint "$MOUNT_POINT")"
DEVICE="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '$1 ~ /^\/dev\/disk/ { device=$1 } END { print device }')"
test -n "$DEVICE" || { echo "error: could not determine mounted DMG device" >&2; exit 1; }

osascript - "$VOLUME_NAME" "ENZO.app" <<'APPLESCRIPT'
on run argv
  set volumeName to item 1 of argv
  set bundleName to item 2 of argv

  tell application "Finder"
    launch
    tell disk volumeName
      open
      delay 1
      set dmgWindow to container window
      set current view of dmgWindow to icon view
      set toolbar visible of dmgWindow to false
      set statusbar visible of dmgWindow to false
      set bounds of dmgWindow to {200, 160, 860, 580}
      set viewOptions to icon view options of dmgWindow
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 120
      set text size of viewOptions to 13
      set label position of viewOptions to bottom
      set background picture of viewOptions to file ".background:dmg-background.png"
      set position of item bundleName to {165, 260}
      set position of item "Applications" to {495, 260}
      update without registering applications
      delay 2
      close dmgWindow
    end tell
  end tell
end run
APPLESCRIPT

install -m 0644 "$APP/Resources/enzo.icns" "$MOUNT_POINT/.VolumeIcon.icns"
SetFile -a C "$MOUNT_POINT"

for _ in {1..20}; do
  [ -f "$MOUNT_POINT/.DS_Store" ] && break
  sleep 0.25
done

test -d "$MOUNT_POINT/ENZO.app"
test -L "$MOUNT_POINT/Applications"
test "$(readlink "$MOUNT_POINT/Applications")" = /Applications
test -f "$MOUNT_POINT/.background/dmg-background.png"
test -f "$MOUNT_POINT/.VolumeIcon.icns"
test -f "$MOUNT_POINT/.DS_Store" || { echo "error: Finder did not write DMG layout metadata" >&2; exit 1; }
codesign --verify --deep --strict "$MOUNT_POINT/ENZO.app"
sync
hdiutil detach "$DEVICE" -quiet || { sleep 1; hdiutil detach "$DEVICE" -quiet; }
DEVICE=""

hdiutil convert "$RW_DMG" -format UDZO -o "$NEXT_DMG" >/dev/null
hdiutil verify "$NEXT_DMG" >/dev/null
rm -f "$DMG"
mv "$NEXT_DMG" "$DMG"
rm -f "$RW_DMG" "$OUT/.pkg-stamp"
trap - EXIT INT TERM

APP_MB="$(du -sm "$STAGE/ENZO.app" | cut -f1)"
DMG_MB="$(du -sm "$DMG" | cut -f1)"
echo ""
echo "✓ $DMG"
echo "  app: ${APP_MB}MB unpacked → dmg: ${DMG_MB}MB compressed"
echo "  first launch of a downloaded copy: right-click → Open (unsigned cert)"
