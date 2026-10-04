# Redeploy the api tree on the server with the corrected archive (ASCII)
$ErrorActionPreference = 'Continue'
$rep = 'D:\nebula\logs\redeploy.txt'
$o = @()

$o += '=== stop watchdog (only the watchdog, never the gateway) ==='
$w = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
     Where-Object { $_.CommandLine -like '*watchdog.ps1*' }
foreach ($p in $w) { $o += ('  kill watchdog pid=' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-ScheduledTask -TaskName 'NEBULA_Services' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$o += '=== stop old node processes ==='
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $o += ('  kill node pid=' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

$o += '=== replace api tree ==='
if (Test-Path 'D:\nebula\api') { Remove-Item 'D:\nebula\api' -Recurse -Force -ErrorAction SilentlyContinue }
$o += ('  api dir removed: ' + (-not (Test-Path 'D:\nebula\api')))

$o += '=== extract corrected archive ==='
Push-Location 'D:\nebula'
& tar -xzf 'D:\nebula\app2.tgz' -C 'D:\nebula' 2>&1 | ForEach-Object { $o += ('  tar: ' + $_) }
Pop-Location
$o += '=== verify key files ==='
$o += ('  api/app.js        : ' + (Test-Path 'D:\nebula\api\app.js'))
$o += ('  axios.cjs         : ' + (Test-Path 'D:\nebula\api\node_modules\axios\dist\node\axios.cjs'))
$o += ('  node_modules files: ' + (Get-ChildItem 'D:\nebula\api\node_modules' -Recurse -File -ErrorAction SilentlyContinue).Count)

$o += '=== restart task ==='
Start-ScheduledTask -TaskName 'NEBULA_Services'
Start-Sleep -Seconds 25
$o += ('  task state: ' + (Get-ScheduledTask -TaskName 'NEBULA_Services').State)
$np = Get-Process node -ErrorAction SilentlyContinue
$o += ('  node processes: ' + ($np | Measure-Object).Count)
$o += '  ports:'
$o += ((netstat -ano | Select-String ':3000|:8080' | ForEach-Object { '   ' + $_.ToString().Trim() }) -join "`n")
$o += '=== api log tail ==='
if (Test-Path 'D:\nebula\logs\api.log') { $o += (Get-Content 'D:\nebula\logs\api.log' -Tail 8) }
if (Test-Path 'D:\nebula\logs\api.err.log') { $o += ('err: ' + ((Get-Content 'D:\nebula\logs\api.err.log' -Tail 8) -join ' | ')) }
$o | Out-File $rep -Encoding utf8
Write-Output 'REDEPLOY-DONE'
