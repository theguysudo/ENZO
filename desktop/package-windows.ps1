# desktop/package-windows.ps1 — build the ENZO Windows installer.
# Runs on a Windows machine/runner with git, Node 22 and NSIS (windows-latest
# images ship NSIS at ${env:ProgramFiles(x86)}\NSIS\makensis.exe).
#
#   powershell -File desktop/package-windows.ps1 less
#     → desktop/dist/ENZO-<version>-less-theme-setup.exe
#   powershell -File desktop/package-windows.ps1 full
#     → desktop/dist/ENZO-<version>-full-theme-setup.exe
#
# Two theme editions, same app, same docker variant (no Google identity OAuth
# — provider-key onboarding):
#   less — docker-variant themes only (Nebula drift, Default Particles, NYC
#          subway ride), one theme video.
#   full — every homepage + workspace theme, with all theme videos.
#
# Mirrors package-macos.sh: bundles the node.exe runtime, the app tree with
# production deps (+tsx), the built frontend and the launcher. Writable state
# is redirected to %APPDATA%\ENZO by launcher.js.

$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$Version = (Get-Content "$Repo\package.json" | ConvertFrom-Json).version
$NodeVersion = "v22.14.0"   # same LTS line as the docker image / macOS build

$Edition = if ($args.Count -ge 1) { $args[0] } else { "less" }
switch ($Edition) {
  "less" {
    $ThemeVariant = "lite"
    $OutName = "ENZO-$Version-less-theme-setup.exe"
  }
  "full" {
    $ThemeVariant = "full"
    $OutName = "ENZO-$Version-full-theme-setup.exe"
  }
  default {
    throw "usage: package-windows.ps1 [less|full]  (less = docker-variant themes only, full = all themes)"
  }
}

$Dist = "$Repo\desktop\dist"
$Staged = "$Repo\desktop\windows\staged"
$AppDir = "$Staged\app"
Write-Host "▸ ENZO $Version (Windows x64, $Edition theme edition) — staging into desktop\windows\staged"

Write-Host "▸ 1/5 frontend build (docker variant: no Google OAuth, $ThemeVariant themes)"
Push-Location "$Repo\synthetic-nature"
$env:VITE_GOOGLE_AUTH = "0"; $env:VITE_THEME_VARIANT = $ThemeVariant
npm run build --silent
Remove-Item Env:\VITE_GOOGLE_AUTH, Env:\VITE_THEME_VARIANT -ErrorAction SilentlyContinue
Pop-Location

Write-Host "▸ 2/5 app tree"
New-Item -ItemType Directory -Force -Path $AppDir, "$Dist" | Out-Null
Copy-Item "$Repo\index.ts","$Repo\tsconfig.json","$Repo\package.json","$Repo\package-lock.json" $AppDir
Copy-Item "$Repo\src" "$AppDir\src" -Recurse
Copy-Item "$Repo\skills-bundled" "$AppDir\skills-bundled" -Recurse
New-Item -ItemType Directory -Force -Path "$AppDir\synthetic-nature" | Out-Null
Copy-Item "$Repo\synthetic-nature\dist" "$AppDir\synthetic-nature\dist" -Recurse -Force
# lite build — keep only the docker-variant theme videos (lite-docker rule):
# the subway loop and the Bioluminescent Ocean clip. The videos live in nested
# homepage\ + marketplace\ folders, so the filter must recurse. Must match
# package-windows.sh exactly — the registry lists these themes, so dropping a
# video here would ship a theme with no backdrop.
if ($ThemeVariant -eq "lite") {
  $Keep = @(
    'Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4',
    'Bioluminescent_ocean.mp4',
    'Bioluminescent_ocean_reversed.mp4'
  )
  Get-ChildItem "$AppDir\synthetic-nature\dist\background_elements" -Filter *.mp4 -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $Keep -notcontains $_.Name } |
    Remove-Item -Force
}
Copy-Item "$Repo\desktop\launcher.js" "$AppDir\launcher.js"
# the launcher reads this to tell the two editions apart (the in-app updater
# must download the same edition it is running)
Set-Content -Path "$AppDir\edition.txt" -Value $Edition -Encoding ascii
# never ship local runtime data — launcher.js creates the per-user dirs
foreach ($p in "$AppDir\src\intelligence\data", "$AppDir\src\neural-engine\data",
               "$AppDir\src\skills\skills", "$AppDir\src\skills\.skill-tmp") {
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Copy-Item "$Repo\desktop\windows\stop-enzo.cmd" "$Staged\stop-enzo.cmd"
# installer icon = the project favicon (NSIS MUI_ICON wants a .ico)
Copy-Item "$Repo\synthetic-nature\public\favicon.ico" "$Staged\favicon.ico"

Write-Host "▸ 3/5 server dependencies (npm ci + tsx, typescript stripped)"
Push-Location $Repo; npm ci --include=dev --silent --prefix $AppDir; Pop-Location
Remove-Item "$AppDir\node_modules\typescript","$AppDir\node_modules\@types" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$AppDir\node_modules\.bin\tsc*","$AppDir\node_modules\.bin\tsserver*" -Force -ErrorAction SilentlyContinue

Write-Host "▸ 4/5 node.exe runtime"
$Zip = "$Dist\node-$NodeVersion-win-x64.zip"
Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$NodeVersion-win-x64.zip" -OutFile $Zip
Expand-Archive $Zip "$Dist\node-expand" -Force
Move-Item "$Dist\node-expand\node-$NodeVersion-win-x64" "$Staged\node-runtime" -Force
# keep only the node binary's needs — npm/corepack belong to dev machines
Remove-Item "$Staged\node-runtime\npm.cmd","$Staged\node-runtime\npx.cmd","$Staged\node-runtime\corepack.cmd" -Force -ErrorAction SilentlyContinue
Remove-Item "$Staged\node-runtime\node_modules\npm","$Staged\node-runtime\node_modules\corepack" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Zip, "$Dist\node-expand" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "▸ 5/5 NSIS installer"
$env:ENZO_VERSION = $Version
$Makensis = "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
if (-not (Test-Path $Makensis)) { $Makensis = "makensis" }
# STAGED/OUTDIR/EDITION/OUTNAME are passed as defines: NSIS resolves relative
# paths against the current directory, not the script's folder.
& $Makensis "-DSTAGED=$Staged" "-DOUTDIR=$Dist" "-DEDITION=$Edition" "-DOUTNAME=$OutName" "$Repo\desktop\windows\enzo.nsi"
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }

$Exe = "$Dist\$OutName"
Write-Host ""
Write-Host "✓ $Exe ($([math]::Round((Get-Item $Exe).Length/1MB)) MB compressed)"
Write-Host "  SmartScreen: unsigned build → 'More info' → 'Run anyway' on first install"
