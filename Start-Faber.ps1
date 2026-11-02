param([switch]$RollbackLast)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$packaged = Join-Path $PSScriptRoot 'release\win-unpacked\Faber.exe'
if (Test-Path -LiteralPath $packaged) {
  $parameters = @{ FilePath = $packaged; WindowStyle = 'Hidden' }
  if ($RollbackLast) { $parameters.ArgumentList = '--rollback-last' }
  Start-Process @parameters
  exit
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Use the Faber Windows installer. Source development requires Node.js 24 or newer.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron\package.json'))) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'))) { & npm.cmd exec -- install-electron; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
if ($RollbackLast) { & npm.cmd start -- --rollback-last } else { & npm.cmd start }
exit $LASTEXITCODE
