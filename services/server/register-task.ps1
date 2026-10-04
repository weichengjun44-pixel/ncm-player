# Register + start NEBULA services as a SYSTEM scheduled task (server edition)
# Pattern copied from the existing Hermes gateway tasks: SYSTEM account, session 0,
# starts at boot, survives logoff. ASCII only to avoid codepage issues over SSH.
$ErrorActionPreference = 'Continue'

$taskName = 'NEBULA_Services'

# Clean up any previous version
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$act = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\nebula\services\watchdog.ps1' `
    -WorkingDirectory 'D:\nebula'

$trg = New-ScheduledTaskTrigger -AtStartup

$prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Principal $prn -Settings $set -Force | Out-Null
Write-Output ('TASK REGISTERED: ' + $taskName)

Start-ScheduledTask -TaskName $taskName
Write-Output 'TASK STARTED'

Start-Sleep -Seconds 6
$info = Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo
$t = Get-ScheduledTask -TaskName $taskName
Write-Output ('  state    : ' + $t.State)
Write-Output ('  lastRun  : ' + $info.LastRunTime)
Write-Output ('  lastTask : ' + $info.LastTaskResult)
Write-Output ('  runas    : ' + $t.Principal.UserId + '  runlevel=' + $t.Principal.RunLevel)
