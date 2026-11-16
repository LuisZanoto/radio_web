Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
stopFile = fso.BuildPath(scriptDir, "radio_monitor.stop")
Set marker = fso.CreateTextFile(stopFile, True)
marker.Close
