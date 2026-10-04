$rep = 'D:\nebula\logs\state.txt'
$o = New-Object System.Collections.ArrayList
function Chk($p) { if (Test-Path $p) { return 'YES' } else { return 'NO ' } }
[void]$o.Add('jdk17 dir      : ' + (Chk 'D:\Apps\jdk17'))
[void]$o.Add('android-sdk dir: ' + (Chk 'D:\Apps\android-sdk'))
[void]$o.Add('javac.exe      : ' + (Chk 'D:\Apps\jdk17'))
$jav = Get-ChildItem 'D:\Apps\jdk17' -Recurse -Filter 'javac.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($jav) { [void]$o.Add('  javac path   : ' + $jav.FullName) } else { [void]$o.Add('  javac path   : (not found)') }
[void]$o.Add('sdkmanager.bat : ' + (Chk 'D:\Apps\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat'))
[void]$o.Add('android.jar    : ' + (Chk 'D:\Apps\android-sdk\platforms\android-34\android.jar'))
foreach ($t in @('aapt2.exe','zipalign.exe','apksigner.bat','d8.bat')) {
    [void]$o.Add('  ' + $t.PadRight(14) + ': ' + (Chk ('D:\Apps\android-sdk\build-tools\34.0.0\' + $t)))
}
[void]$o.Add('zips:')
Get-ChildItem 'D:\Apps\*.zip' -ErrorAction SilentlyContinue | ForEach-Object {
    [void]$o.Add('  ' + $_.Name + '  ' + [math]::Round($_.Length/1MB,1) + ' MB  ' + $_.LastWriteTime)
}
$t2 = Get-ScheduledTask -TaskName 'NEBULA_Toolchain' -ErrorAction SilentlyContinue
if ($t2) { [void]$o.Add('task NEBULA_Toolchain: ' + $t2.State) }
[void]$o.Add('powershell procs: ' + (Get-Process powershell -ErrorAction SilentlyContinue | Measure-Object).Count)
[void]$o.Add('--- toolchain.txt ---')
if (Test-Path 'D:\nebula\logs\toolchain.txt') {
    Get-Content 'D:\nebula\logs\toolchain.txt' | ForEach-Object { [void]$o.Add($_) }
} else { [void]$o.Add('(no report file)') }
$o | Out-File $rep -Encoding utf8
Write-Output 'STATE-DONE'
