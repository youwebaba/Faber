[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 39372, [switch]$Stop, [string]$PublicUrl, [switch]$StartAtSignIn, [switch]$DisableStartup)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'FaberRelay'
if ($PublicUrl -or $StartAtSignIn -or $DisableStartup -or (Test-Path -LiteralPath (Join-Path $root 'stable.json'))) {
    & (Join-Path $PSScriptRoot 'Start-FaberStableRelay.ps1') @PSBoundParameters
    return
}
$server = Join-Path $root 'server.mjs'
$helper = Join-Path $root 'cloudflared-2026.10.7.exe'
$settingsFile = Join-Path $root 'operator.json'
$routesFile = Join-Path $root 'routes.json'
$runFile = Join-Path $root 'processes.json'
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.Directory]::CreateDirectory($root) | Out-Null

function Write-JsonFile($file, $value) {
    $temporary = "$file.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), $utf8)
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, [Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$file) }
}
function Get-OurProcess($number, $exe, $argument) {
    if (!$number) { return }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$number)"
    if ($p -and $p.ExecutablePath -eq $exe -and $p.CommandLine.Contains($argument)) { Get-Process -Id $p.ProcessId }
}
function Stop-OurProcess($process) {
    if ($process -and !$process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
}
$node = (Get-Command node.exe).Source
$saved = if (Test-Path -LiteralPath $runFile) { Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json }
$relay = Get-OurProcess $saved.relay $node $server
$tunnel = Get-OurProcess $saved.tunnel $helper 'http://127.0.0.1:'
if ($Stop) {
    Stop-OurProcess $tunnel
    Stop-OurProcess $relay
    foreach ($file in @($settingsFile,$runFile)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file } }
    Write-Output 'Faber relay stopped.'
    return
}
if ($relay -and $tunnel -and (Test-Path -LiteralPath $settingsFile)) { Write-Output 'Faber relay is already running.'; return }
if ($relay -or $tunnel) { throw 'A previous relay launch is incomplete. Run this script with -Stop before retrying.' }
if ([int](((& $node --version) -replace '^v','').Split('.')[0]) -lt 24) { throw 'Install Node.js 24 or newer to operate the relay.' }
$checksum = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'
if (!(Test-Path -LiteralPath $helper)) {
    $download = Join-Path $root ("tunnel-"+[guid]::NewGuid().ToString('N')+".tmp")
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe' -OutFile $download
    if ((Get-FileHash -LiteralPath $download).Hash -ne $checksum) { throw 'Tunnel helper checksum mismatch.' }
    [IO.File]::Move($download,$helper)
}
if ((Get-FileHash -LiteralPath $helper).Hash -ne $checksum) { throw 'Tunnel helper checksum mismatch.' }
foreach ($name in @('server.mjs','package.json','package-lock.json')) {
    $source = Join-Path $PSScriptRoot $name
    if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath((Join-Path $root $name))) { Copy-Item -LiteralPath $source -Destination $root -Force }
}
& npm.cmd ci --prefix $root --ignore-scripts --omit=dev --no-audit --no-fund
if ($LASTEXITCODE) { throw 'Could not install the locked relay dependency.' }
if (!(Test-Path -LiteralPath $routesFile)) { Write-JsonFile $routesFile @{ routes=@() } }
$log = Join-Path $root 'tunnel.log'
if (Test-Path -LiteralPath $log) { [IO.File]::WriteAllText($log,'',$utf8) }
$origin = "http://127.0.0.1:$Port"
try {
    $relay = Start-Process $node -ArgumentList @("""$server""",'--bind','127.0.0.1','--port',$Port,'--allow-file',"""$routesFile""") -WorkingDirectory $root -WindowStyle Hidden -PassThru
    for ($i=0; $i -lt 30; $i++) {
        if ($relay.HasExited) { throw 'Relay could not start. Check that the chosen port is free.' }
        try { $health=Invoke-RestMethod -TimeoutSec 2 -Uri "$origin/healthz"; if ($health.ok) { break } } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (!$health.ok -or $relay.HasExited) { throw 'Local relay health check failed.' }
    $tunnel = Start-Process $helper -ArgumentList @('tunnel','--no-autoupdate','--protocol','http2','--logfile',"""$log""",'--url',$origin) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    for ($i=0; $i -lt 100; $i++) {
        if ($tunnel.HasExited) { throw 'Public tunnel failed to start. See tunnel.log in the local relay folder.' }
        $logText = if (Test-Path -LiteralPath $log) { Get-Content -Raw -LiteralPath $log -ErrorAction SilentlyContinue }
        if ([string]::IsNullOrEmpty($logText)) { Start-Sleep -Milliseconds 500; continue }
        $match = [regex]::Match($logText,'https://([a-z0-9-]+\.trycloudflare\.com)\b')
        if ($match.Success) { break }
        Start-Sleep -Milliseconds 500
    }
    if (!$match.Success) { throw 'The tunnel provider did not issue a public address. Check outbound Internet access.' }
    Write-JsonFile $runFile @{ relay=$relay.Id; tunnel=$tunnel.Id }
    Write-JsonFile $settingsFile @{ relayUrl=("wss://"+$match.Groups[1].Value); allowLocalEnrollment=$true }
    Write-Output 'Relay running. In Faber, open Settings > Connections and enable Allow connections to pair a laptop.'
} catch {
    Stop-OurProcess $tunnel
    Stop-OurProcess $relay
    throw
}
