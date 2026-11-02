param([switch]$RollbackLast)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or newer, then run this launcher again.' }
if ($RollbackLast) { & node (Join-Path $PSScriptRoot 'desktop\recovery.mjs') --rollback-last; exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron\package.json'))) {
 & npm.cmd ci
 if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'))) { & npm.cmd exec -- install-electron; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& npm.cmd start
exit $LASTEXITCODE
