param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
try {
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$identity.User.Value
  function Resolve-OwnerSid([string]$value){if($value -match '^S-1-'){return $value};return ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value}
  if($request.action -eq 'identity'){@{sid=$sid;interactive=[Environment]::UserInteractive;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}|ConvertTo-Json -Compress;exit 0}
  if($request.taskName -notmatch '^FaberBoot-[a-f0-9]{24}$' -or $request.ownerSid -ne $sid){throw 'Boot task does not belong to this Windows user'}
  $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$folder=$scheduler.GetFolder('\')
  $task=$null
  try{$task=$folder.GetTask($request.taskName)}catch{if($_.Exception.HResult -ne -2147024894){throw}}
  if($task -and ($task.Definition.RegistrationInfo.Source -ne 'Faber boot worker v1' -or (Resolve-OwnerSid $task.Definition.Principal.UserId) -ne $sid)){throw 'An existing task has a different owner or source; it was preserved'}
  if($request.action -eq 'inspect'){
    if(!$task){@{installed=$false}|ConvertTo-Json -Compress}else{@{installed=$true;state=[int]$task.State;lastTaskResult=[long]$task.LastTaskResult;enabled=[bool]$task.Enabled;ownerSid=$task.Definition.Principal.UserId;logonType=[int]$task.Definition.Principal.LogonType;runLevel=[int]$task.Definition.Principal.RunLevel}|ConvertTo-Json -Compress};exit 0
  }
  if($request.action -eq 'install'){
    [xml]$xml=$request.xml
    $definition=$scheduler.NewTask(0);$definition.XmlText=$request.xml
    if((Resolve-OwnerSid $definition.Principal.UserId) -ne $sid -or [int]$definition.Principal.LogonType -ne 2 -or [int]$definition.Principal.RunLevel -ne 0 -or $definition.RegistrationInfo.Source -ne 'Faber boot worker v1' -or [int]$definition.Actions.Count -ne 1){throw "Boot task must use this user S4U token with least privilege (logon=$([int]$definition.Principal.LogonType), level=$([int]$definition.Principal.RunLevel), actions=$([int]$definition.Actions.Count))"}
    $null=$folder.RegisterTaskDefinition($request.taskName,$definition,6,$sid,$null,2,$null)
    @{installed=$true;passwordStored=$false;logonType='S4U';runLevel='LeastPrivilege'}|ConvertTo-Json -Compress;exit 0
  }
  if($request.action -eq 'remove'){if($task){$folder.DeleteTask($request.taskName,0)};@{removed=$true}|ConvertTo-Json -Compress;exit 0}
  if($request.action -eq 'start'){if(!$task){throw 'Boot task is not installed'};$null=$task.Run($null);@{started=$true}|ConvertTo-Json -Compress;exit 0}
  throw 'Unknown boot task action'
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
