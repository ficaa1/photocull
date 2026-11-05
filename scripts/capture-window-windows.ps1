# Capture physical screen pixels, including the window frame. Never closes a window.
param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PhotoCullCapture {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point p);
 public struct Rect { public int Left,Top,Right,Bottom; }
 public struct Point { public int X,Y; }
}
'@
[PhotoCullCapture]::SetProcessDPIAware() | Out-Null
$h=(Get-Process -Id $ProcessId).MainWindowHandle
if($h -eq 0){throw 'The process has no visible window.'}
[PhotoCullCapture]::ShowWindow($h,9) | Out-Null
[PhotoCullCapture]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$r=New-Object PhotoCullCapture+Rect
$c=New-Object PhotoCullCapture+Point
[PhotoCullCapture]::GetWindowRect($h,[ref]$r) | Out-Null
[PhotoCullCapture]::ClientToScreen($h,[ref]$c) | Out-Null
Add-Type -AssemblyName System.Drawing
$b=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
$g=[Drawing.Graphics]::FromImage($b)
try {$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size);$b.Save($OutputPath)} finally {$g.Dispose();$b.Dispose()}
@{clientX=$c.X-$r.Left;clientY=$c.Y-$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top} | ConvertTo-Json -Compress
