# Manual start + capture of API and middle layer, to see the real error (ASCII)
$ErrorActionPreference = 'Continue'
$node = 'D:\Apps\node\node.exe'

Write-Output '=== node sanity ==='
Write-Output ('version: ' + (& $node --version))
Write-Output ('cwd test: ' + (Test-Path 'D:\nebula\api\app.js'))

Write-Output '=== start API manually ==='
Start-Process -FilePath $node -ArgumentList 'app.js' -WorkingDirectory 'D:\nebula\api' `
    -WindowStyle Hidden -RedirectStandardOutput 'D:\nebula\logs\m-api.out' `
    -RedirectStandardError 'D:\nebula\logs\m-api.err'
Start-Sleep -Seconds 12
Write-Output ('node processes now: ' + ((Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count))
Write-Output '--- m-api.out ---'
if (Test-Path 'D:\nebula\logs\m-api.out') { Get-Content 'D:\nebula\logs\m-api.out' -Tail 12 }
Write-Output '--- m-api.err ---'
if (Test-Path 'D:\nebula\logs\m-api.err') { Get-Content 'D:\nebula\logs\m-api.err' -Tail 12 }
Write-Output '=== port check ==='
netstat -ano | Select-String ':3000' | Select-Object -First 3 | ForEach-Object { Write-Output $_.ToString().Trim() }
