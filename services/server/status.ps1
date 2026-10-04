# Status report -> file (ASCII). Fetched via scp so nothing gets mangled.
$rep = 'D:\nebula\logs\status.txt'
$o = @()
$t = Get-ScheduledTask -TaskName 'NEBULA_Services' -ErrorAction SilentlyContinue
if ($t) {
    $o += ('task state   : ' + $t.State)
    $o += ('task action  : ' + $t.Actions[0].Arguments)
} else { $o += 'task: NOT FOUND' }
$np = Get-Process node -ErrorAction SilentlyContinue
$o += ('node procs   : ' + ($np | Measure-Object).Count)
$np | ForEach-Object { $o += ('   node pid=' + $_.Id) }
$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
$o += ('tunnel proc  : ' + ($cf | Measure-Object).Count)
$o += 'ports:'
$o += ((netstat -ano | Select-String ':3000|:8080') | ForEach-Object { '   ' + $_.ToString().Trim() })
$o += 'watchdog log tail:'
if (Test-Path 'D:\nebula\logs\watchdog.log') { $o += (Get-Content 'D:\nebula\logs\watchdog.log' -Tail 8) }
$o += 'api.err.log tail:'
if (Test-Path 'D:\nebula\logs\api.err.log') { $o += (Get-Content 'D:\nebula\logs\api.err.log' -Tail 6) }
$o += 'tunnel url:'
if (Test-Path 'D:\nebula\.tunnel-url') { $o += (Get-Content 'D:\nebula\.tunnel-url') }
$o | Out-File $rep -Encoding utf8
Write-Output 'STATUS-DONE'
