Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
stopFile = fso.BuildPath(scriptDir, "radio_monitor.stop")
If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True
shell.CurrentDirectory = scriptDir
shell.Run "pythonw.exe """ & fso.BuildPath(scriptDir, "radio_monitor.py") & """", 0, False
