<#
.SYNOPSIS
  Stop the VideoSage dev app: close videosage.exe, then free the Vite port.

.DESCRIPTION
  First the script asks each open Video Sage window to close, the same as a
  click on its close button. A window with unsaved changes then asks
  "Save changes?", and the script waits up to 10 seconds (-WaitSeconds) for
  the app to close. If the app is still open after that (a question not
  answered yet, or Cancel), the script stops with exit code 1 and stops
  nothing. -Force tree-kills the app without asking: unsaved
  changes are lost.
#>
[CmdletBinding()]
param(
  [switch] $Force,
  [int] $WaitSeconds = 10
)
$ErrorActionPreference = "Continue"

$apps = @(Get-Process -Name videosage -ErrorAction SilentlyContinue)
if (-not $Force) {
  foreach ($app in $apps) {
    if ($app.MainWindowHandle -ne [IntPtr]::Zero) {
      Write-Host "Closing Video Sage (PID $($app.Id)). If it asks to save changes, answer it."
      [void] $app.CloseMainWindow()
    }
  }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline -and @($apps | Where-Object { -not $_.HasExited }).Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
  $open = @($apps | Where-Object { -not $_.HasExited })
  if ($open.Count -gt 0) {
    Write-Host "Video Sage is still open (PID $($open.Id -join ', ')). Save or close it, then run this again." -ForegroundColor Yellow
    Write-Host "To stop it without saving, run .\kill-dev.ps1 -Force." -ForegroundColor Yellow
    exit 1
  }
}

$apps | Where-Object { -not $_.HasExited } | ForEach-Object {
  Write-Host "Stopping videosage.exe (PID $($_.Id))"
  & taskkill.exe /PID $_.Id /T /F | Out-Null
}

foreach ($port in 14530, 14531) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      Write-Host "Stopping PID $_ (port $port)"
      & taskkill.exe /PID $_ /T /F | Out-Null
    }
}
exit 0
