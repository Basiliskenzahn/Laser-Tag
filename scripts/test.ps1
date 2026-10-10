$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

. "$PSScriptRoot\Resolve-Docker.ps1"
$docker = Resolve-Docker

Push-Location $root
try {
  & $docker compose run --rm tests
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
