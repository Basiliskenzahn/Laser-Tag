$ErrorActionPreference = 'Stop'

$dockerBin = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'
if (!(Test-Path -LiteralPath (Join-Path $dockerBin 'docker.exe'))) {
  throw "docker.exe was not found in $dockerBin"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathParts = @($userPath -split ';' | Where-Object { $_ })

if ($pathParts -contains $dockerBin) {
  Write-Host "Docker CLI path is already in your user PATH: $dockerBin"
  exit 0
}

$pathParts += $dockerBin
[Environment]::SetEnvironmentVariable('Path', ($pathParts -join ';'), 'User')

Write-Host "Added Docker CLI path to your user PATH: $dockerBin"
Write-Host 'Open a new terminal for the PATH change to take effect.'
