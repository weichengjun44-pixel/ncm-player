# NEBULA service watchdog (server edition, ASCII only)
# Keeps NetEase API (:3000), middle layer (:8080) and the public tunnel alive.
$ErrorActionPreference = 'SilentlyContinue'

$root     = 'D:\nebula'
$logDir   = Join-Path $root 'logs'
$log      = Join-Path $logDir 'watchdog.log'
$nodeExe  = 'D:\Apps\node\node.exe'
$cfExe    = 'D:\Apps\cloudflared\cloudflared.exe'
$tunLog   = Join-Path $logDir 'tunnel.log'
$tunOut   = Join-Path $logDir 'tunnel.out.log'
$tunUrl   = Join-Path $root '.tunnel-url'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($m) {
    Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8
}

function Test-Port($p) {
    $hit = netstat -ano | Select-String -Pattern (':' + $p + '\s') | Select-Object -First 1
    return [bool]$hit
}

function Get-TunnelUrl {
    if (Test-Path $tunLog) {
        $m = Select-String -Path $tunLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
             Select-Object -Last 1
        if ($m -and $m.Matches.Count -gt 0) { return $m.Matches[$m.Matches.Count - 1].Value }
    }
    return $null
}

function Start-Tunnel {
    if (-not (Test-Path $cfExe)) { Write-Log "tunnel: $cfExe not found"; return }
    Remove-Item $tunLog, $tunOut -ErrorAction SilentlyContinue
    Start-Process -FilePath $cfExe `
        -ArgumentList 'tunnel', '--url', 'http://localhost:8080', '--no-autoupdate' `
        -WorkingDirectory (Split-Path $cfExe) -WindowStyle Hidden `
        -RedirectStandardError $tunLog -RedirectStandardOutput $tunOut
    Write-Log 'tunnel: started, waiting for address'
}

Write-Log 'watchdog start (server)'

while ($true) {
    if (-not (Test-Port 3000)) {
        Write-Log 'API(3000) down -> start'
        Start-Process -FilePath $nodeExe -ArgumentList 'app.js' `
            -WorkingDirectory (Join-Path $root 'api') -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir 'api.log') `
            -RedirectStandardError  (Join-Path $logDir 'api.err.log')
    }
    if (-not (Test-Port 8080)) {
        Write-Log 'middle(8080) down -> start'
        Start-Process -FilePath $nodeExe -ArgumentList 'server.js' `
            -WorkingDirectory $root -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir 'web.log') `
            -RedirectStandardError  (Join-Path $logDir 'web.err.log')
    }
    $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $cf) {
        Write-Log 'tunnel down -> start'
        Start-Tunnel
        Start-Sleep -Seconds 14
    }
    $u = Get-TunnelUrl
    if ($u) {
        $prev = if (Test-Path $tunUrl) { (Get-Content $tunUrl -Raw).Trim() } else { '' }
        if ($u -ne $prev) {
            Set-Content -Path $tunUrl -Value $u -Encoding UTF8
            Write-Log ('tunnel url: ' + $u)
        }
    }
    Start-Sleep -Seconds 15
}
