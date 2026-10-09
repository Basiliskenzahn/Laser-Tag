$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$chrome = Join-Path $root '.tools\chrome\chrome.exe'
$profile = Join-Path $root '.tools\chrome-profile'

if (!(Test-Path -LiteralPath $chrome)) {
  throw "Portable Chrome was not found at $chrome"
}

Start-Process -FilePath $chrome -ArgumentList @(
  '--user-data-dir=' + $profile,
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'http://localhost:3000/?debug'
)
