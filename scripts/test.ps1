$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root '.tools\node\node.exe'

if (!(Test-Path -LiteralPath $node)) {
  throw "Portable Node was not found at $node"
}

& $node --test "$root\server\game.test.js" "$root\server\realtime.test.js"
