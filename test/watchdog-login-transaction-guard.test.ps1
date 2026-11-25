$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$helper=Join-Path $PSScriptRoot '../scripts/watchdog-login-transaction-guard.ps1'
$root=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-login-fixture-'+[Guid]::NewGuid().ToString()+'.watchdog')
[IO.Directory]::CreateDirectory($root)|Out-Null
$p=Join-Path $root 'transaction.lock'
$global:WatchdogFixtureBoot=[DateTime]::UtcNow.AddHours(1)
# Isolated test replaces CIM only in this test process; production helper has
# no alternate boot time argument or bypass.
function Get-CimInstance {param([string]$ClassName) [pscustomobject]@{LastBootUpTime=$global:WatchdogFixtureBoot}}
function Reject([scriptblock]$Operation,[string]$Case) { $caught=$false;try {& $Operation|Out-Null}catch{$caught=$true};if(-not $caught){throw "Expected rejection: $Case"};Write-Output "PASS $Case" }
[IO.File]::WriteAllBytes($p,[byte[]]@())
$snapshot=& $helper -LiteralPath $p
if (($snapshot|ConvertFrom-Json).size -ne 0){throw 'Wrong snapshot'}
Write-Output 'PASS zero-byte exclusive identity'
$held=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
try{Reject {& $helper -LiteralPath $p} 'active handle exclusion'}finally{$held.Dispose()}
[IO.File]::WriteAllText($p,'x')
Reject {& $helper -LiteralPath $p} 'nonempty refusal'
[IO.File]::WriteAllBytes($p,[byte[]]@())
$global:WatchdogFixtureBoot=[DateTime]::UtcNow.AddDays(-1)
Reject {& $helper -LiteralPath $p} 'post-boot refusal'
$global:WatchdogFixtureBoot=[DateTime]::UtcNow.AddHours(1)
$snapshot=& $helper -LiteralPath $p
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($snapshot))
$archive=$p+'.login-recovery-'+[Guid]::NewGuid().ToString()
# Mutate last-write after inspection; the same file identity alone is insufficient.
[IO.File]::SetLastWriteTimeUtc($p,[DateTime]::UtcNow.AddMinutes(-2))
Reject {& $helper -LiteralPath $p -Action Archive -ExpectedBase64 $encoded -ArchivePath $archive} 'changed identity refusal'
$snapshot=& $helper -LiteralPath $p
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($snapshot))
[IO.File]::WriteAllText($archive,'existing archive')
Reject {& $helper -LiteralPath $p -Action Archive -ExpectedBase64 $encoded -ArchivePath $archive} 'archive collision refusal'
if ([IO.File]::ReadAllText($archive) -cne 'existing archive' -or -not [IO.File]::Exists($p)) {throw 'Collision overwrote evidence'}
$archive=$p+'.login-recovery-'+[Guid]::NewGuid().ToString()
& $helper -LiteralPath $p -Action Archive -ExpectedBase64 $encoded -ArchivePath $archive|Out-Null
if ([IO.File]::Exists($p) -or -not [IO.File]::Exists($archive)) {throw 'Archive failed'}
Write-Output 'PASS archive under held delete-only-sharing guard'
Reject {& $helper -LiteralPath (Join-Path $root 'business.lock')} 'business-lock refusal'
[IO.File]::WriteAllBytes($p,[byte[]]@())
$held=[WatchdogFileIdentity]::CreateFile($p,2147549184,4,[IntPtr]::Zero,3,2097152,[IntPtr]::Zero)
try {
 $swap=$p+'.swapped'
 [IO.File]::Move($p,$swap)
 [IO.File]::WriteAllText($p,'replacement')
 $byHandle=$p+'.login-recovery-'+[Guid]::NewGuid().ToString()
 [WatchdogFileIdentity]::Rename($held,$byHandle)
 if ([IO.File]::ReadAllText($p) -cne 'replacement' -or -not [IO.File]::Exists($byHandle) -or [IO.File]::Exists($swap)) {throw 'Handle rename touched replacement'}
 Write-Output 'PASS path swap preserves replacement and archives held identity'
} finally {$held.Dispose()}
Write-Output 'PASS 9 isolated transaction guard cases'
