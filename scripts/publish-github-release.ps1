# Publish the current package.json version to GitHub Releases with electron-updater metadata.
# Run after: npm run dist
# Usage:  powershell -File scripts/publish-github-release.ps1
# Requires: gh auth login

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content -Raw package.json | ConvertFrom-Json
$ver = [string]$pkg.version
if (-not $ver) { throw 'package.json version missing' }

$setup = "release\LocalAgents-Studio-$ver-setup.exe"
$blockmap = "release\LocalAgents-Studio-$ver-setup.exe.blockmap"
$portable = "release\LocalAgents-Studio-$ver-portable.exe"
$latest = 'release\latest.yml'

foreach ($f in @($setup, $blockmap, $portable, $latest)) {
  if (-not (Test-Path $f)) { throw "Missing artifact: $f (run npm run dist first)" }
}

$yml = Get-Content -Raw $latest
if ($yml -notmatch [regex]::Escape("version: $ver")) {
  throw "latest.yml does not match package version $ver — rebuild with npm run dist"
}

$tag = $ver
$notes = @"
## LocalAgents Studio $ver

### Install / update
- **NSIS setup** (``LocalAgents-Studio-$ver-setup.exe``) — required for in-app updates
- **Portable** (``LocalAgents-Studio-$ver-portable.exe``) — manual replace; no auto-update

``latest.yml`` is included so electron-updater can check this release.
"@

gh release view $tag 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Release $tag already exists — uploading/replacing assets..."
  gh release upload $tag $setup $blockmap $portable $latest --clobber
} else {
  Write-Host "Creating release $tag..."
  gh release create $tag --title "LocalAgents Studio $ver" --notes $notes `
    $setup $blockmap $portable $latest
}

Write-Host "Done: https://github.com/HipHopGrinch/LocalAgents-Studio/releases/tag/$tag"
gh release view $tag --json assets --jq '.assets[].name'
