# Server inventory (ASCII only)
$rep = 'D:\nebula\logs\inventory.txt'
$o = New-Object System.Collections.ArrayList

function Chk($p) { if (Test-Path $p) { return '[HAVE]   ' } else { return '[MISSING]' } }

[void]$o.Add('=== project files on server ===')
foreach ($f in @('server.js','sources.js','web','api','services','android','desktop','node_modules\three','.git','.cookie','LICENSE','README.md','.gitignore')) {
    [void]$o.Add('  ' + (Chk ('D:\nebula\' + $f)) + '  ' + $f)
}
[void]$o.Add('=== toolchain on server ===')
foreach ($f in @('D:\Apps\node\node.exe','D:\Apps\cloudflared\cloudflared.exe','D:\Apps\jdk17','D:\Apps\android-sdk')) {
    [void]$o.Add('  ' + (Chk $f) + '  ' + $f)
}
[void]$o.Add('=== disk ===')
[void]$o.Add('  D free: ' + [math]::Round((Get-PSDrive D).Free / 1GB, 1) + ' GB')
[void]$o.Add('  C free: ' + [math]::Round((Get-PSDrive C).Free / 1GB, 1) + ' GB')
[void]$o.Add('=== running ===')
$nc = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
$cc = (Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count
[void]$o.Add('  node processes: ' + $nc)
[void]$o.Add('  cloudflared   : ' + $cc)
$t = Get-ScheduledTask -TaskName 'NEBULA_Services' -ErrorAction SilentlyContinue
[void]$o.Add('  task state    : ' + $t.State)
[void]$o.Add('=== internet reachability (for downloading toolchain here) ===')
foreach ($u in @('https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/',
                 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
                 'https://mirrors.aliyun.com/',
                 'https://npmmirror.com/')) {
    $res = 'FAIL'
    try {
        $r = Invoke-WebRequest -Uri $u -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
        $res = 'HTTP ' + $r.StatusCode + '  ' + [math]::Round($r.RawContentLength / 1KB, 0) + ' KB'
    } catch {
        $msg = $_.Exception.Message
        if ($msg.Length -gt 55) { $msg = $msg.Substring(0, 55) }
        $res = 'FAIL: ' + $msg
    }
    [void]$o.Add('  ' + $res + '   ' + $u)
}
$o | Out-File $rep -Encoding utf8
Write-Output 'INV-DONE'
