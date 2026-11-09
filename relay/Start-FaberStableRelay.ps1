[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port=39372, [switch]$Stop, [string]$PublicUrl, [switch]$StartAtSignIn, [switch]$DisableStartup)
$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'FaberRelay'
$config=Join-Path $root 'stable.json'
$server=Join-Path $root 'server.mjs'
$routes=Join-Path $root 'routes.json'
$pidFile=Join-Path $root 'stable-process.json'
$hasher=[Security.Cryptography.SHA256]::Create()
try{$taskId=[BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-','').Substring(0,12)}finally{$hasher.Dispose()}
$taskName='Faber paired-device relay '+$taskId
$utf8=[Text.UTF8Encoding]::new($false)
[IO.Directory]::CreateDirectory($root)|Out-Null
function Write-Record($file,$value) {
    $stage="$file.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($stage,($value|ConvertTo-Json -Compress),$utf8)
    if([IO.File]::Exists($file)){[IO.File]::Replace($stage,$file,[Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($stage,$file)}
}
$prior=if(Test-Path -LiteralPath $config){Get-Content -Raw -LiteralPath $config|ConvertFrom-Json}
if(!$PublicUrl){$PublicUrl=$prior.publicUrl}
if(!$PSBoundParameters.ContainsKey('Port') -and $prior.port){$Port=$prior.port}
$url=$null
if(![Uri]::TryCreate($PublicUrl,[UriKind]::Absolute,[ref]$url) -or $url.Scheme -ne 'wss' -or $url.Port -ne 443 -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/' -or $url.IsLoopback -or $url.HostNameType -ne [UriHostNameType]::Dns -or $url.Host -notmatch '^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$' -or $url.Host -match '(^|\.)(localhost|local|internal|test|invalid)$' -or $url.Host.EndsWith('.trycloudflare.com')){throw 'Set -PublicUrl to the permanent wss:// hostname of your TLS reverse proxy or named tunnel.'}
$node=(Get-Command node.exe).Source
if([int](((& $node --version) -replace '^v','').Split('.')[0]) -lt 24){throw 'Install Node.js 24 or newer to operate the relay.'}
$arguments='"'+$server+'" --bind 127.0.0.1 --port '+$Port+' --allow-file "'+$routes+'"'
$saved=if(Test-Path -LiteralPath $pidFile){Get-Content -Raw -LiteralPath $pidFile|ConvertFrom-Json}
$manual=if($saved.pid){$candidate=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$saved.pid);if($candidate -and $candidate.ExecutablePath -eq $node -and $candidate.CommandLine.Contains('"'+$server+'"') -and $candidate.CommandLine.Contains($routes)){Get-Process -Id $candidate.ProcessId}}
$task=if(Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue){Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue}
if($task -and ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $node -or !$task.Actions[0].Arguments.StartsWith('"'+$server+'" --bind 127.0.0.1 --port ') -or !$task.Actions[0].Arguments.EndsWith('"'+$routes+'"'))){throw 'The existing Windows task with this name does not belong to this relay.'}
if($Stop -or $DisableStartup){
    if($task){Stop-ScheduledTask -TaskName $taskName;if($DisableStartup){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}}
    if($manual -and !$manual.HasExited){$manual.Kill();$manual.WaitForExit(5000)|Out-Null}
    if($DisableStartup -and $prior){$prior.startAtSignIn=$false;Write-Record $config $prior}
    Write-Output 'Relay stopped. The permanent address, route allowlist and device pairing records are retained.'
    return
}
if($prior -and ($prior.publicUrl -ne $url.GetLeftPart([UriPartial]::Authority) -or $prior.port -ne $Port) -and ($manual -or ($task -and $task.State -eq 'Running'))){throw 'Stop the running relay before changing its public address or port.'}
if(!$manual -and (!$task -or $task.State -ne 'Running')){
    foreach($name in @('server.mjs','package.json','package-lock.json')){
        $source=Join-Path $PSScriptRoot $name
        if([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath((Join-Path $root $name))){Copy-Item -LiteralPath $source -Destination (Join-Path $root $name) -Force}
    }
    & npm.cmd ci --prefix $root --ignore-scripts --omit=dev --no-audit --no-fund
    if($LASTEXITCODE){throw 'Could not install the locked relay dependency.'}
}
if(!(Test-Path -LiteralPath $routes)){Write-Record $routes @{routes=@()}}
$automatic=$StartAtSignIn -or ($prior -and $prior.startAtSignIn)
if($automatic){
    if($manual -and !$manual.HasExited){$manual.Kill();$manual.WaitForExit(5000)|Out-Null}
    if(!$task -or $task.Actions[0].Arguments -ne $arguments){
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $action=New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
        $trigger=New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings=New-ScheduledTaskSettingsSet -RestartCount 90 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
    }
    Start-ScheduledTask -TaskName $taskName
}elseif(!$manual){
    $manual=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Write-Record $pidFile @{pid=$manual.Id}
}
$ready=$false
for($i=0;$i -lt 35;$i++){
    if(!$automatic -and $manual.HasExited){throw 'The relay process exited. Check that its local port is available.'}
    try{$health=Invoke-RestMethod -TimeoutSec 2 -Uri ("http://127.0.0.1:"+$Port+'/healthz');if($health.ok -and $health.protocol -eq 1){$ready=$true;break}}catch{}
    Start-Sleep -Milliseconds 200
}
if(!$ready){throw 'The relay did not become healthy. Check the port and the Windows task history.'}
$address=$url.GetLeftPart([UriPartial]::Authority)
Write-Record $config @{publicUrl=$address;port=$Port;startAtSignIn=[bool]$automatic}
Write-Record (Join-Path $root 'operator.json') @{relayUrl=$address;allowLocalEnrollment=$true}
Write-Output 'Relay ready. Point the registered public TLS endpoint at the local relay port.'
