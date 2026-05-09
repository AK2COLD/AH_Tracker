<#
.SYNOPSIS
Creates a Windows desktop shortcut that launches AH Tracker as a standalone app.
Run from WSL terminal:
    powershell.exe -ExecutionPolicy Bypass -File "$(wslpath -w ~/AH_Tracker/scripts/install-shortcut.ps1)"
#>

# Resolve paths
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$vbsPath   = Join-Path $scriptDir "launch.vbs"
$desktop   = [System.Environment]::GetFolderPath('Desktop')
$lnkPath   = Join-Path $desktop "AH Tracker.lnk"

if (-not (Test-Path $vbsPath)) {
    Write-Error "launch.vbs not found at: $vbsPath"
    exit 1
}

# Create shortcut via WScript.Shell COM
$wsh      = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($lnkPath)

$shortcut.TargetPath       = "wscript.exe"
$shortcut.Arguments        = "`"$vbsPath`""
$shortcut.Description      = "Arcanum AH Tracker - WoW TBC Auction House"
$shortcut.WorkingDirectory = $scriptDir
$shortcut.IconLocation     = "%SystemRoot%\System32\shell32.dll,278"

$shortcut.Save()

Write-Host ""
Write-Host "  Desktop shortcut created:" -ForegroundColor Green
Write-Host "  $lnkPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To change the icon: right-click shortcut -> Properties -> Change Icon"
Write-Host "  Tip: right-click shortcut -> Pin to taskbar" -ForegroundColor Gray
