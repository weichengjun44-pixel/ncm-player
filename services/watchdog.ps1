# 服务看护：每 15 秒检查 3000(API) 与 8080(前端+中间层)，掉了就拉起来
# 第三方网易云 API 服务会偶发崩溃，没有看护的话播放器会整个失联
$ErrorActionPreference = 'SilentlyContinue'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

# 公网隧道（cloudflared 只发在 GitHub，地址每次重启都会变，所以要把当前地址落盘）
$cfExe = 'D:\Apps\cloudflared\cloudflared.exe'
$tunLog = Join-Path $logDir 'tunnel.log'
$tunOut = Join-Path $logDir 'tunnel.out.log'
$tunUrlFile = Join-Path $root '.tunnel-url'

function Get-TunnelUrl {
    if (Test-Path $tunLog) {
        $m = Select-String -Path $tunLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
             Select-Object -Last 1
        if ($m -and $m.Matches.Count -gt 0) { return $m.Matches[$m.Matches.Count - 1].Value }
    }
    return $null
}

function Start-Tunnel {
    if (-not (Test-Path $cfExe)) { Write-Log "隧道：找不到 $cfExe"; return }
    Remove-Item $tunLog, $tunOut -ErrorAction SilentlyContinue
    Start-Process -FilePath $cfExe `
        -ArgumentList 'tunnel', '--url', 'http://localhost:8080', '--no-autoupdate' `
        -WindowStyle Hidden -RedirectStandardError $tunLog -RedirectStandardOutput $tunOut
    Write-Log '隧道：已启动，等待分配公网地址'
}

# 单实例保护：开机自启与手动启动可能撞车，已有一个在跑就直接退出
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like '*watchdog.ps1*' -and $_.ProcessId -ne $PID }
if ($others) { exit }

Write-Log "看护启动"

while ($true) {
    if (-not (Test-Port 3000)) {
        Write-Log 'API 服务(3000) 不在 → 重启'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $PSScriptRoot 'run-api.cmd') + '"') -WindowStyle Hidden
    }
    if (-not (Test-Port 8080)) {
        Write-Log '中间层(8080) 不在 → 重启'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $PSScriptRoot 'run-web.cmd') + '"') -WindowStyle Hidden
    }
    # 公网隧道：进程不在就拉起，并把当前地址写进 .tunnel-url
    $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $cf) {
        Write-Log '公网隧道 不在 -> 重启'
        Start-Tunnel
        Start-Sleep -Seconds 14
    }
    $u = Get-TunnelUrl
    if ($u) {
        $prev = if (Test-Path $tunUrlFile) { (Get-Content $tunUrlFile -Raw).Trim() } else { '' }
        if ($u -ne $prev) {
            Set-Content -Path $tunUrlFile -Value $u -Encoding UTF8
            Write-Log "隧道地址: $u"
        }
    }

    Start-Sleep -Seconds 15
}
