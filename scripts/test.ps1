$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

. "$PSScriptRoot\Resolve-Docker.ps1"
$docker = Resolve-Docker

# Both suites, and both exit codes. This script used to run only the `tests` service, so a
# Windows contributor following the project's own script got 85 of 125 tests and exit code 0 -
# the 40 Python tests were never attempted, and nothing said so.
$failed = @()

Push-Location $root
try {
  & $docker compose run --rm tests
  if ($LASTEXITCODE -ne 0) { $failed += "node ($LASTEXITCODE)" }

  # Run this even when the node suite failed, so one run reports both.
  & $docker compose run --rm backend-tests
  if ($LASTEXITCODE -ne 0) { $failed += "python ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

if ($failed.Count -gt 0) {
  # Write-Host rather than Write-Error: with $ErrorActionPreference = 'Stop' a Write-Error
  # throws before `exit 1` is reached, which makes the exit code less predictable than just
  # setting it.
  Write-Host "Failing suites: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}

Write-Host 'Both suites passed.'
