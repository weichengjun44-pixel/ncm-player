# Diagnostic: why node does not start. Writes a report file, runs detached.
$rep = 'D:\nebula\logs\diag.txt'
$node = 'D:\Apps\node\node.exe'
$out = @()
$out += '=== whoami ==='
$out += (whoami)
$out += '=== logs dir writable? ==='
try {
    'probe' | Out-File 'D:\nebula\logs\_probe.txt' -Encoding ascii -ErrorAction Stop
    $out += 'logs dir: WRITABLE'
    Remove-Item 'D:\nebula\logs\_probe.txt' -ErrorAction SilentlyContinue
} catch { $out += ('logs dir: NOT WRITABLE -> ' + $_.Exception.Message) }
$out += '=== start API with PassThru + try/catch ==='
try {
    $p = Start-Process -FilePath $node -ArgumentList 'app.js' `
        -WorkingDirectory 'D:\nebula\api' -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput 'D:\nebula\logs\m-api.out' `
        -RedirectStandardError  'D:\nebula\logs\m-api.err' `
        -ErrorAction Stop
    $out += ('Start-Process OK, pid=' + $p.Id)
} catch {
    $out += ('Start-Process THREW: ' + $_.Exception.GetType().Name + ' :: ' + $_.Exception.Message)
}
Start-Sleep -Seconds 10
$out += '=== after 10s ==='
$np = Get-Process node -ErrorAction SilentlyContinue
if ($np) { $np | ForEach-Object { $out += ('node pid=' + $_.Id + ' mem=' + [math]::Round($_.WorkingSet64/1MB,1) + 'MB') } }
else { $out += 'no node process alive' }
$out += '=== m-api.out ==='
if (Test-Path 'D:\nebula\logs\m-api.out') { $out += (Get-Content 'D:\nebula\logs\m-api.out' -Tail 15) } else { $out += '(no file)' }
$out += '=== m-api.err ==='
if (Test-Path 'D:\nebula\logs\m-api.err') { $out += (Get-Content 'D:\nebula\logs\m-api.err' -Tail 15) } else { $out += '(no file)' }
$out += '=== port 3000 ==='
$out += ((netstat -ano | Select-String ':3000' | Select-Object -First 3 | ForEach-Object { $_.ToString().Trim() }) -join "`n")
$out += '=== try running node directly (foreground, 8s) ==='
$tmp = 'D:\nebula\logs\fg.txt'
$j = Start-Job -ScriptBlock {
    Set-Location 'D:\nebula\api'
    & 'D:\Apps\node\node.exe' 'app.js' 2>&1 | Out-String
}
$null = Wait-Job $j -Timeout 8
$fg = Receive-Job $j
Stop-Job $j -ErrorAction SilentlyContinue
Remove-Job $j -Force -ErrorAction SilentlyContinue
$out += ('foreground output: ' + ($fg | Out-String).Trim().Substring(0, [Math]::Min(1200, ($fg | Out-String).Trim().Length)))
$out | Out-File $rep -Encoding utf8
Write-Output 'DIAG-DONE'
