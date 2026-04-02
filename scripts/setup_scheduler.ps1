# setup_scheduler.ps1
# Creates a Windows Scheduled Task that imports TSM AppData into AH Tracker
# every 30 minutes, silently, even when the web app is closed.
#
# MUST run from an Administrator PowerShell:
#   Right-click PowerShell -> Run as Administrator
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   cd \\wsl.localhost\Ubuntu\home\alexk\AH_Tracker
#   .\scripts\setup_scheduler.ps1

$TaskName    = "AHTracker - TSM Import"
$ProjectPath = "/home/alexk/AH_Tracker"
$LogFile     = "/home/alexk/AH_Tracker/logs/tsm_import.log"

$WslExe = "$env:SystemRoot\System32\wsl.exe"

$WslDistro = (& "$env:SystemRoot\System32\wsl.exe" --list --quiet |
    ForEach-Object { $_ -replace '\x00', '' } |
    Where-Object { $_ -match '\S' } |
    Select-Object -First 1).Trim()

Write-Host "Detected WSL distro: $WslDistro"
Write-Host "Using wsl.exe at:    $WslExe"

# VBScript wrapper runs wsl.exe with window style 0 (hidden, no console flash)
$VbsWrapper = "C:\ProgramData\ah_tsm_import.vbs"
$BashLine   = "source ~/.nvm/nvm.sh && cd $ProjectPath && node src/scripts/import_tsm_once.js >> $LogFile 2>&1"
$VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$WslExe"" -d $WslDistro -- bash -lc ""$BashLine""", 0, False
"@
[System.IO.File]::WriteAllText($VbsWrapper, $VbsContent, [System.Text.Encoding]::ASCII)
Write-Host "VBS wrapper:         $VbsWrapper"

# Remove old task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$WinUser = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Running task as:     $WinUser"

$action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $VbsWrapper
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $WinUser -LogonType S4U -RunLevel Highest

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force -ErrorAction Stop | Out-Null
    Write-Host ""
    Write-Host "SUCCESS: Task scheduled every 30 minutes, no window."
    Write-Host "Logs:    $LogFile (check from WSL)"
    Write-Host ""
    Write-Host "Test now:  schtasks /Run /TN '$TaskName'"
    Write-Host "Remove:    schtasks /Delete /TN '$TaskName' /F"
} catch {
    Write-Host "ERROR: $_"
    Write-Host "Ensure PowerShell is running as Administrator."
}
