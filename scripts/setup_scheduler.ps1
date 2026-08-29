# setup_scheduler.ps1
# Creates two Windows Scheduled Tasks for AH Tracker:
#   1. Blizzard AH poller  — every 15 minutes (accurate live prices)
#   2. TSM context import  — every 30 minutes (market intelligence: liquidity, regional stats)
#
# MUST run from an Administrator PowerShell:
#   Right-click PowerShell -> Run as Administrator
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   cd \\wsl.localhost\Ubuntu\home\alexk\AH_Tracker
#   .\scripts\setup_scheduler.ps1

$ProjectPath = "/home/alexk/AH_Tracker"
$LogDir      = "/home/alexk/AH_Tracker/logs"

$WslExe = "$env:SystemRoot\System32\wsl.exe"
$WslDistro = (& "$env:SystemRoot\System32\wsl.exe" --list --quiet |
    ForEach-Object { $_ -replace '\x00', '' } |
    Where-Object { $_ -match '\S' } |
    Select-Object -First 1).Trim()

Write-Host "Detected WSL distro: $WslDistro"

$WinUser = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Running tasks as:    $WinUser"

function Register-AHTask {
    param($TaskName, $VbsPath, $BashLine, $IntervalMinutes)

    $VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$WslExe"" -d $WslDistro -- bash -lc ""$BashLine""", 0, False
"@
    [System.IO.File]::WriteAllText($VbsPath, $VbsContent, [System.Text.Encoding]::ASCII)

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    $action    = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $VbsPath
    $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) `
                    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
                    -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId $WinUser -LogonType S4U -RunLevel Highest

    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Principal $principal -Force -ErrorAction Stop | Out-Null
        Write-Host "  OK — '$TaskName' every $IntervalMinutes min"
    } catch {
        Write-Host "  ERROR on '$TaskName': $_"
    }
}

Write-Host ""
Write-Host "Registering tasks..."

# ── 1. Blizzard AH poller (accurate prices, every 15 min) ──────────────────
Register-AHTask `
    -TaskName        "AHTracker - Blizzard Poll" `
    -VbsPath         "C:\ProgramData\ah_blizzard_poll.vbs" `
    -BashLine        "source ~/.nvm/nvm.sh && cd $ProjectPath && node src/scripts/poll_once.js >> $LogDir/blizzard_poll.log 2>&1" `
    -IntervalMinutes 15

# ── 2. TSM market context import (liquidity/regional signals, every 30 min) ─
Register-AHTask `
    -TaskName        "AHTracker - TSM Import" `
    -VbsPath         "C:\ProgramData\ah_tsm_import.vbs" `
    -BashLine        "source ~/.nvm/nvm.sh && cd $ProjectPath && node src/scripts/import_tsm_once.js >> $LogDir/tsm_import.log 2>&1" `
    -IntervalMinutes 30

Write-Host ""
Write-Host "Done. Log files in $LogDir (check from WSL)."
Write-Host ""
Write-Host "Test poll now:  schtasks /Run /TN 'AHTracker - Blizzard Poll'"
Write-Host "Test TSM now:   schtasks /Run /TN 'AHTracker - TSM Import'"
Write-Host "Remove all:     schtasks /Delete /TN 'AHTracker - Blizzard Poll' /F ; schtasks /Delete /TN 'AHTracker - TSM Import' /F"
