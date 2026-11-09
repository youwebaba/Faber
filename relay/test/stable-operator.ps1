# Uses an isolated LOCALAPPDATA and documentation hostname. Optional registration uses a task unique to this temporary folder.
param([switch]$CheckSignInTask)
$ErrorActionPreference='Stop'
$prior=$env:LOCALAPPDATA
$root=Join-Path ([IO.Path]::GetTempPath()) ('Faber-relay-operator-'+[Guid]::NewGuid().ToString('N'))
$script=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../Start-FaberRelay.ps1')).Path
$socket=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$socket.Start();$port=$socket.LocalEndpoint.Port;$socket.Stop()
$base=Join-Path $root 'FaberRelay'
try{
    $env:LOCALAPPDATA=$root
    & $script -PublicUrl 'wss://relay.example.org' -Port $port -StartAtSignIn:$CheckSignInTask
    $first=Get-Content -Raw -LiteralPath (Join-Path $base 'operator.json')|ConvertFrom-Json
    if($first.relayUrl -ne 'wss://relay.example.org'){throw 'Stable address changed'}
    $routes=Join-Path $base 'routes.json';$before=(Get-FileHash -LiteralPath $routes).Hash
    & $script -Stop
    & $script
    $health=Invoke-RestMethod -Uri ("http://127.0.0.1:"+$port+'/healthz')
    $second=Get-Content -Raw -LiteralPath (Join-Path $base 'operator.json')|ConvertFrom-Json
    if(!$health.ok -or $second.relayUrl -ne $first.relayUrl -or (Get-FileHash -LiteralPath $routes).Hash -ne $before){throw 'Restart did not retain the operator configuration'}
    Write-Output 'Stable relay restarted on its fixed local port and retained the public address and route allowlist.'
}finally{
    try{
        if($CheckSignInTask){& $script -PublicUrl 'wss://relay.example.org' -Port $port -DisableStartup}
        elseif(Test-Path -LiteralPath (Join-Path $base 'stable.json')){& $script -Stop}
    }finally{$env:LOCALAPPDATA=$prior}
}
