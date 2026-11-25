param(
 [ValidateSet('Register','Disable')][string]$Action='Register',
 [Parameter(Mandatory=$true)][string]$TaskName,
 [string]$BindingPath,[string]$InstallationSha256,[string]$ManifestPath,[string]$ManifestSha256
)
$ErrorActionPreference='Stop'
if ($TaskName -notmatch '^Watchdog-Login-[A-Za-z0-9_.-]+$') {throw 'Use a dedicated Watchdog-Login- task name'}
if ($Action -eq 'Disable') {Disable-ScheduledTask -TaskName $TaskName | Out-Null; return}
foreach ($p in @($BindingPath,$ManifestPath)) {if (-not [IO.Path]::IsPathRooted($p) -or -not (Test-Path -LiteralPath $p -PathType Leaf)) {throw 'Explicit existing absolute binding and manifest required'}}
foreach ($h in @($InstallationSha256,$ManifestSha256)) {if ($h -cnotmatch '^[a-f0-9]{64}$') {throw 'Pinned lowercase SHA256 required'}}
$binding=Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json
$entry=Join-Path $binding.runtimeRoot 'scripts/watchdog-login-recover.mjs'
$argsList=@($entry,'--binding',$BindingPath,'--installation-sha256',$InstallationSha256,'--manifest',$ManifestPath,'--manifest-sha256',$ManifestSha256)
& $binding.nodeExecutable @argsList --check
if ($LASTEXITCODE -ne 0) {throw 'Recovery preflight failed; no task registered'}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {throw 'Task already exists; preserve it and use a new name'}
function Quote([string]$s) {return "'"+$s.Replace("'","''")+"'"}
$command='& '+(Quote $binding.nodeExecutable)+' '+(($argsList+@('--apply') | ForEach-Object {Quote $_}) -join ' ')+ '; exit $LASTEXITCODE'
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$ps=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskAction=New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encoded)
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Pinned Watchdog login recovery; fail closed on unknown ownership' | Out-Null
Write-Output 'Registered for next interactive login; service was not started by registration'
