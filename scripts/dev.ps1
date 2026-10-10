# dev.ps1 and docker.ps1 were byte-identical copies, so a fix to one silently missed the
# other. docker.ps1 is the canonical one (it is the name docs/troubleshooting.md and
# docs/operations/windows-scripts.md point at); this forwards to it so the `dev` name keeps
# working without a second copy to maintain.
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\docker.ps1" @args
exit $LASTEXITCODE
