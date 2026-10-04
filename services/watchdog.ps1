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
    Start-Sleep -Seconds 15
}
