' AH Tracker — Desktop Launcher
' Starts the Node.js server in WSL (hidden window), then opens the app
' as a standalone window in Chrome or Edge (no browser toolbar).
' The server auto-exits when the app window is closed (APP_MODE=1).

Option Explicit

Dim wsh, fso
Set wsh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Const APP_URL    = "http://localhost:3000"
Const SERVER_DIR = "~/AH_Tracker"

' ── 1. Start server in WSL (window style 0 = completely hidden) ──────────────
' APP_MODE=1 enables the heartbeat-based auto-shutdown.
' If the port is already in use (server running), the new process exits quietly.
Dim serverCmd
serverCmd = "wsl.exe -e bash -c """ & _
    "source ~/.nvm/nvm.sh && " & _
    "cd " & SERVER_DIR & " && " & _
    "APP_MODE=1 node src/index.js >> /tmp/ah_tracker.log 2>&1" & _
    """"
wsh.Run serverCmd, 0, False

' ── 2. Poll until server is ready (max ~15 seconds) ──────────────────────────
Dim attempts, serverReady
serverReady = False
For attempts = 1 To 15
    WScript.Sleep 1000
    On Error Resume Next
    Dim http
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", APP_URL & "/api/profile", False
    http.SetTimeouts 800, 800, 800, 800
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        serverReady = True
    End If
    On Error GoTo 0
    If serverReady Then Exit For
Next

' Give it a moment even if polling failed (cold WSL startup can be slow)
If Not serverReady Then WScript.Sleep 2000

' ── 3. Find Chrome or Edge ───────────────────────────────────────────────────
Dim browser
Dim paths(3)
paths(0) = wsh.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe")
paths(1) = wsh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
paths(2) = wsh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
paths(3) = wsh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")

Dim i
For i = 0 To 3
    If fso.FileExists(paths(i)) Then
        browser = paths(i)
        Exit For
    End If
Next

If browser = "" Then
    MsgBox "Chrome or Edge not found." & vbCrLf & _
           "Open " & APP_URL & " in your browser manually.", 48, "AH Tracker"
    WScript.Quit 1
End If

' ── 4. Open as standalone app window (--app removes browser toolbar) ──────────
' Window style 1 = normal window (so the app is visible and focusable)
wsh.Run """" & browser & """ --app=" & APP_URL & _
    " --window-size=1440,900", 1, False
