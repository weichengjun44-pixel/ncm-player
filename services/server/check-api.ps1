# Compare the api tree on the server with expectations; write report to a file
$rep = 'D:\nebula\logs\check.txt'
$o = @()
$tgz = 'D:\nebula\app.tgz'
$o += ('tgz size bytes : ' + (Get-Item $tgz).Length)
$o += ('axios dir exists: ' + (Test-Path 'D:\nebula\api\node_modules\axios'))
if (Test-Path 'D:\nebula\api\node_modules\axios') {
    $ax = Get-ChildItem 'D:\nebula\api\node_modules\axios' -Recurse -File -ErrorAction SilentlyContinue
    $o += ('axios files    : ' + $ax.Count)
    $o += ('axios.cjs exists: ' + (Test-Path 'D:\nebula\api\node_modules\axios\dist\node\axios.cjs'))
    $o += 'axios tree:'
    Get-ChildItem 'D:\nebula\api\node_modules\axios' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 25 | ForEach-Object { $o += ('   ' + $_.FullName.Replace('D:\nebula\api\node_modules\axios', '')) }
} else {
    $o += 'axios dir MISSING entirely'
}
$nm = Get-ChildItem 'D:\nebula\api\node_modules' -Directory -ErrorAction SilentlyContinue
$o += ('node_modules top dirs: ' + $nm.Count)
$o += ('dirs: ' + (($nm | Select-Object -First 20 -ExpandProperty Name) -join ', '))
$all = Get-ChildItem 'D:\nebula\api\node_modules' -Recurse -File -ErrorAction SilentlyContinue
$o += ('node_modules total files: ' + $all.Count)
$o += ('longest path len: ' + (($all | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum))
$o | Out-File $rep -Encoding utf8
Write-Output 'CHECK-DONE'
