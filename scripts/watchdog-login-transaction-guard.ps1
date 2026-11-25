param([Parameter(Mandatory=$true)][string]$LiteralPath,[ValidateSet('Inspect','Archive')][string]$Action='Inspect',[string]$ExpectedBase64,[string]$ArchivePath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if (-not ('WatchdogFileIdentity' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class WatchdogFileIdentity {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
  public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
  public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
 }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder text,uint size,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,IntPtr info,uint size);
 public static void Rename(SafeFileHandle handle,string target) {
  byte[] text=Encoding.Unicode.GetBytes(target); int root=IntPtr.Size==8?8:4; int length=root+IntPtr.Size; int start=length+4;
  IntPtr buffer=Marshal.AllocHGlobal(start+text.Length+2);
  try {for(int i=0;i<start+text.Length+2;i++)Marshal.WriteByte(buffer,i,0);Marshal.WriteInt32(buffer,length,text.Length);Marshal.Copy(text,0,IntPtr.Add(buffer,start),text.Length);
   if(!SetFileInformationByHandle(handle,3,buffer,(uint)(start+text.Length+2)))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  } finally {Marshal.FreeHGlobal(buffer);}
 }
 public static long Time(System.Runtime.InteropServices.ComTypes.FILETIME t) {return ((long)(uint)t.dwHighDateTime<<32)|(uint)t.dwLowDateTime;}
}
'@
}
$full=[IO.Path]::GetFullPath($LiteralPath)
if ([IO.Path]::GetFileName($full) -cne 'transaction.lock' -or -not ([IO.Path]::GetDirectoryName($full).EndsWith('.watchdog',[StringComparison]::OrdinalIgnoreCase))) {throw 'Only Watchdog sidecar transaction.lock is permitted'}
$stream=$null
try {
 # Delete-only sharing excludes every pre-existing read/write handle. Keep this
 # handle through final identity verification and same-directory atomic rename.
 $stream=[WatchdogFileIdentity]::CreateFile($full,2147549184,4,[IntPtr]::Zero,3,2097152,[IntPtr]::Zero)
 if ($stream.IsInvalid) {throw 'Exclusive delete-sharing handle unavailable'}
 $info=New-Object WatchdogFileIdentity+Info
 if (-not [WatchdogFileIdentity]::GetFileInformationByHandle($stream,[ref]$info)) {throw 'File identity unavailable'}
 $name=New-Object Text.StringBuilder 32768
 $length=[WatchdogFileIdentity]::GetFinalPathNameByHandle($stream,$name,32768,0)
 if ($length -eq 0 -or $length -ge 32768) {throw 'Canonical handle path unavailable'}
 $resolved=$name.ToString()
 if ($resolved.StartsWith('\\?\')) {$resolved=$resolved.Substring(4)}
 if (-not $resolved.Equals($full,[StringComparison]::OrdinalIgnoreCase)) {throw 'Redirected transaction file'}
 $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToFileTimeUtc()
 $created=[WatchdogFileIdentity]::Time($info.Creation)
 $written=[WatchdogFileIdentity]::Time($info.Write)
 if (($info.Attributes -band 0x410) -ne 0 -or $info.SizeHigh -ne 0 -or $info.SizeLow -ne 0 -or $info.Links -ne 1 -or $created -le 0 -or $written -le 0 -or $created -ge $boot -or $written -ge $boot) {throw 'Transaction is not an unredirected zero-byte pre-boot file'}
 $snapshot=[ordered]@{path=$full;volume=$info.Volume;indexHigh=$info.IndexHigh;indexLow=$info.IndexLow;creation=$created.ToString();write=$written.ToString();boot=$boot.ToString();attributes=$info.Attributes;links=$info.Links;size=0}
 $encoded=$snapshot|ConvertTo-Json -Compress
 if ($Action -eq 'Archive') {
  if (-not $ExpectedBase64) {throw 'Expected identity required'}
  $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedBase64))
  if ($encoded -cne $expected) {throw 'Transaction identity changed'}
  $archive=[IO.Path]::GetFullPath($ArchivePath)
  $archiveId=[Guid]::Empty
  if (-not $archive.StartsWith($full+'.login-recovery-',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetDirectoryName($archive) -cne [IO.Path]::GetDirectoryName($full) -or -not [Guid]::TryParse($archive.Substring(($full+'.login-recovery-').Length),[ref]$archiveId)) {throw 'Invalid transaction archive target'}
  [WatchdogFileIdentity]::Rename($stream,$archive)
 }
 Write-Output $encoded
} finally {if ($stream) {$stream.Dispose()}}
