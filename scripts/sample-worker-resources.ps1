param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$WorkerPid,
  [ValidateRange(1,60)][int]$DurationSeconds=60,
  [ValidateRange(1,10)][int]$IntervalSeconds=5
)
$ErrorActionPreference='Stop'
$timer=[Diagnostics.Stopwatch]::StartNew()
$original=Get-Process -Id $WorkerPid
$started=$original.StartTime.ToUniversalTime().ToString('o')
do {
  try {
    $worker=Get-Process -Id $WorkerPid
    if($worker.StartTime.ToUniversalTime().ToString('o') -ne $started){throw 'The selected PID was reused'}
    [ordered]@{schemaVersion=1;evidenceKind='actual Windows process sample';at=[DateTime]::UtcNow.ToString('o');elapsedMs=$timer.ElapsedMilliseconds;pid=$WorkerPid;startedAt=$started;workingSetBytes=$worker.WorkingSet64;privateBytes=$worker.PrivateMemorySize64;handleCount=$worker.HandleCount;threadCount=$worker.Threads.Count;cpuSeconds=$worker.TotalProcessorTime.TotalSeconds;screenCapture=$false;processChanged=$false} | ConvertTo-Json -Compress
  } catch {
    [ordered]@{schemaVersion=1;at=[DateTime]::UtcNow.ToString('o');elapsedMs=$timer.ElapsedMilliseconds;pid=$WorkerPid;unavailable=$true;reason='The selected process exited, changed identity or could not be sampled'} | ConvertTo-Json -Compress
    exit 2
  }
  if($timer.Elapsed.TotalSeconds -ge $DurationSeconds){break}
  Start-Sleep -Milliseconds ([Math]::Min($IntervalSeconds*1000,[Math]::Max(1,($DurationSeconds*1000)-$timer.ElapsedMilliseconds)))
} while($true)
