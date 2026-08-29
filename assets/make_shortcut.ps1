Add-Type -AssemblyName System.Drawing

$wslAsset  = "\\wsl$\Ubuntu\home\alexk\AH_Tracker\assets"
$srcPng    = "$wslAsset\icon.png"
$destIco   = "$wslAsset\icon.ico"
$desktop   = "$env:USERPROFILE\OneDrive\Desktop"

# Convert PNG -> ICO
$png         = New-Object System.Drawing.Bitmap($srcPng)
$iconHandle  = $png.GetHicon()
$icon        = [System.Drawing.Icon]::FromHandle($iconHandle)
$stream      = New-Object System.IO.FileStream($destIco, [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Close()
$icon.Dispose()
$png.Dispose()
Write-Host "ICO created."

# Remove old .bat from desktop
Remove-Item "$desktop\AH Tracker.bat" -ErrorAction SilentlyContinue

# Create .lnk shortcut
$shell      = New-Object -ComObject WScript.Shell
$lnk        = $shell.CreateShortcut("$desktop\AH Tracker.lnk")
$lnk.TargetPath       = "C:\Windows\System32\cmd.exe"
$lnk.Arguments        = "/k wsl bash ~/AH_Tracker/start_server.sh"
$lnk.IconLocation     = $destIco
$lnk.WindowStyle      = 1
$lnk.Save()
Write-Host "Shortcut created on Desktop."
