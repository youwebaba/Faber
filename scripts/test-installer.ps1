param([Parameter(Mandatory=$true)][string]$InitialInstaller,[Parameter(Mandatory=$true)][string]$UpgradeInstaller)
$ErrorActionPreference='Stop'
$guid='3a22f5e1-acc0-529a-a1af-9032454a154d'
$keys=@("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid","HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid","HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
foreach($key in $keys){if(Test-Path -LiteralPath $key){throw "An existing Faber installation must not be replaced: $key"}}
if(Get-Process -Name Faber -ErrorAction SilentlyContinue){throw 'A Faber process is running; installer test must not close it.'}
$links=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Faber.lnk'),(Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Faber.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'Faber.lnk'),(Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Faber.lnk'))
foreach($link in $links){if(Test-Path -LiteralPath $link){throw "Preserve existing shortcut: $link"}}
$proofRoot=Join-Path ([IO.Path]::GetTempPath()) ('Faber-installer-proof-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $proofRoot | Out-Null
$install=Join-Path $proofRoot 'app';$profile=Join-Path $proofRoot 'profile'
if(-not ([IO.Path]::GetFullPath($install)).StartsWith(([IO.Path]::GetFullPath($proofRoot)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid isolated install target'}
$proof=@{root=$proofRoot;install=$install;profile=$profile;initialHash=(Get-FileHash -LiteralPath $InitialInstaller -Algorithm SHA256).Hash;upgradeHash=(Get-FileHash -LiteralPath $UpgradeInstaller -Algorithm SHA256).Hash;steps=@()}
function Save-Proof { $proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $proofRoot 'installer-proof.json') }
function Install-Fixture([string]$file,[string]$version) {
  $process=Start-Process -FilePath $file -ArgumentList @('/S',"/D=$install") -WindowStyle Hidden -PassThru -Wait
  if($process.ExitCode -ne 0){throw "Installer failed: $($process.ExitCode)"}
  $exe=Join-Path $install 'Faber.exe';if(-not (Test-Path -LiteralPath $exe)){throw 'Installed GUI executable missing'}
  $output=& $exe --smoke-installed --smoke-profile $profile 2>&1 | Out-String
  $output | Set-Content -LiteralPath (Join-Path $proofRoot "launch-$version.txt")
  $report=Join-Path $profile "installer-$version-report.json";if(-not (Test-Path -LiteralPath $report)){throw "Installed smoke failed: $output"}
  $result=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json;if(-not $result.ok -or $result.version -ne $version){throw 'Unexpected installed app version/report'}
  $proof.steps+=@{kind='install-and-launch';version=$version;report=$report;exitCode=$process.ExitCode};Save-Proof
}
try {
  Install-Fixture $InitialInstaller '1.0.0-beta.1'
  Install-Fixture $UpgradeInstaller '1.0.0-beta.2'
  # Explicit installer downgrade verifies rollback retains the old workbench and same profile.
  Install-Fixture $InitialInstaller '1.0.0-beta.1'
  $before=@{};foreach($file in @('state.json','secrets.json','installer-fixture.json')){$before[$file]=(Get-FileHash -LiteralPath (Join-Path $profile $file) -Algorithm SHA256).Hash}
  $uninstaller=Join-Path $install 'Uninstall Faber.exe';if(-not(Test-Path -LiteralPath $uninstaller)){throw 'Uninstaller missing'}
  $process=Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
  if($process.ExitCode -ne 0){throw "Uninstaller failed: $($process.ExitCode)"}
  $until=(Get-Date).AddSeconds(30);while((Test-Path -LiteralPath (Join-Path $install 'Faber.exe')) -and (Get-Date)-lt $until){Start-Sleep -Milliseconds 200}
  if(Test-Path -LiteralPath (Join-Path $install 'Faber.exe')){throw 'Uninstall did not remove GUI executable'}
  foreach($file in $before.Keys){if((Get-FileHash -LiteralPath (Join-Path $profile $file) -Algorithm SHA256).Hash -ne $before[$file]){throw "Uninstall changed profile fixture: $file"}}
  foreach($key in $keys){if(Test-Path -LiteralPath $key){throw "Test uninstall registration remains: $key"}}
  foreach($link in $links){if(Test-Path -LiteralPath $link){throw "Test shortcut remains: $link"}}
  $proof.steps+=@{kind='uninstall';profileUnchanged=$true;programRemoved=$true;registrationRemoved=$true;shortcutsRemoved=$true};$proof.ok=$true;Save-Proof
  Write-Output (Join-Path $proofRoot 'installer-proof.json')
} catch {$proof.error=$_.Exception.Message;Save-Proof;throw}
