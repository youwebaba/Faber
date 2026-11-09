param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Entry,[Parameter(Mandatory=$true)][string]$ProfileId)
$ErrorActionPreference='Stop'
if($ProfileId -ne 'default' -and $ProfileId -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid boot profile'}
if(![IO.Path]::IsPathRooted($Executable) -or ![IO.Path]::IsPathRooted($Entry) -or $Executable.StartsWith('\\') -or $Entry.StartsWith('\\')){throw 'Boot runtime must be local'}
# No user password, DPAPI token, browser session or interactive environment is copied here.
$env:ELECTRON_RUN_AS_NODE='1'
& $Executable $Entry '--worker-profile' $ProfileId
exit $LASTEXITCODE
