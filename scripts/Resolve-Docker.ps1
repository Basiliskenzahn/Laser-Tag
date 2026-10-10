$ErrorActionPreference = 'Stop'

function Resolve-Docker {
  $command = Get-Command docker -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidatePaths = @(
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Docker\Docker\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Docker\resources\bin\docker.exe"
  )

  foreach ($path in $candidatePaths) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  throw @"
Docker CLI was not found.

Docker Desktop may not have finished installing on this machine. If it is installed,
open Docker Desktop once, then restart this terminal. Otherwise install/reinstall
Docker Desktop and retry:

  winget install -e --id Docker.DockerDesktop
"@
}
