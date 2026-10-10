$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (!$isAdmin) {
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    "`"$PSCommandPath`""
  )
  exit $LASTEXITCODE
}

$features = @(
  'Microsoft-Windows-Subsystem-Linux',
  'VirtualMachinePlatform'
)

foreach ($feature in $features) {
  Write-Host "Enabling $feature..."
  dism.exe /online /enable-feature /featurename:$feature /all /norestart
  if ($LASTEXITCODE -notin @(0, 3010)) {
    throw "Failed to enable $feature. DISM exit code: $LASTEXITCODE"
  }
}

Write-Host 'Repairing Docker Desktop installation...'
winget install -e --id Docker.DockerDesktop --force --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop install/repair failed. Winget exit code: $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Docker prerequisites are installed. Restart Windows if prompted, then open Docker Desktop once.'
