Option Explicit
Dim fso, shell, root, executable, result
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
executable = fso.BuildPath(root, "app\WorkBuddyUnlock.exe")
If Not fso.FileExists(executable) Then
    MsgBox "UI executable not found:" & vbCrLf & executable, vbCritical, "WorkBuddy Prompt Unlock"
    WScript.Quit 1
End If
shell.CurrentDirectory = root
On Error Resume Next
result = shell.Run(Chr(34) & executable & Chr(34), 1, False)
If Err.Number <> 0 Then
    MsgBox "Unable to start the UI:" & vbCrLf & Err.Description, vbCritical, "WorkBuddy Prompt Unlock"
    WScript.Quit 1
End If
On Error GoTo 0
