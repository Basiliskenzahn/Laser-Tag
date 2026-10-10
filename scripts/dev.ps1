$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $root '.tools\node'
$node = Join-Path $nodeDir 'node.exe'

if (!(Test-Path -LiteralPath $node)) {
  throw "Portable Node was not found at $node"
}

$env:PATH = "$nodeDir;$env:PATH"
& $node "$root\server\index.js"
