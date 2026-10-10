$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$chrome = Join-Path $root '.tools\chrome\chrome.exe'
$profile = Join-Path $root '.tools\chrome-profile'

if (!(Test-Path -LiteralPath $chrome)) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (!$chrome) {
    throw "Chrome or Edge was not found. Open http://localhost:8080/?debug manually."
  }
}

Start-Process -FilePath $chrome -ArgumentList @(
  '--user-data-dir=' + $profile,
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'http://localhost:8080/?debug'
)
