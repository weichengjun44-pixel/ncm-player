# 盘点服务器现状与缺口（ASCII 输出到文件）
$rep = 'D:\nebula\logs\inventory.txt'
$o = @()
$o += '=== 服务器现有的项目内容 ==='
foreach ($f in @('server.js','sources.js','web','api','services','android','desktop','node_modules\three','.git','.cookie','README.md')) {
    $p = Join-Path 'D:\nebula' $f
    $o += ('  ' + $(if (Test-Path $p) { '[有]' } else { '[缺]' }) + '  ' + $f)
}
$o += '=== 服务器上的工具链 ==='
foreach ($f in @('D:\Apps\node\node.exe','D:\Apps\cloudflared\cloudflared.exe','D:\Apps\jdk17','D:\Apps\android-sdk')) {
    $o += ('  ' + $(if (Test-Path $f) { '[有]' } else { '[缺]' }) + '  ' + $f)
}
$o += ('  hermes python: ' + $(if (Test-Path 'D:\hermes') { 'D:\hermes 存在（自带 runtime）' } else { '?' }))
$o += '=== 磁盘 ==='
$o += ('  D free: ' + [math]::Round((Get-PSDrive D).Free / 1GB, 1) + ' GB')
$o += ('  C free: ' + [math]::Round((Get-PSDrive C).Free / 1GB, 1) + ' GB')
$o += '=== 当前运行的服务 ==='
$o += ('  node: ' + ((Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count) + ' 个')
$o += ('  cloudflared: ' + ((Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count) + ' 个')
$o += ('  任务 NEBULA_Services: ' + (Get-ScheduledTask -TaskName 'NEBULA_Services' -ErrorAction SilentlyContinue).State)
$o += '=== 外网可达性（决定能不能在这台机器上直接下工具链）==='
foreach ($u in @('https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/','https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip','https://mirrors.aliyun.com/','https://npmmirror.com/')) {
    $t = '?'
    try {
        $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
        $t = 'HTTP ' + $r.StatusCode
    } catch {
        try {
            $r2 = Invoke-WebRequest -Uri $u -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
            $t = 'HTTP ' + $r2.StatusCode
        } catch { $t = 'FAIL: ' + $_.Exception.Message.Substring(0, [Math]::Min(60, $_.Exception.Message.Length)) }
    }
    $o += ('  ' + $t + '   ' + $u)
}
$o | Out-File $rep -Encoding utf8
Write-Output 'INV-DONE'
