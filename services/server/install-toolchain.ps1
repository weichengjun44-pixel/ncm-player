# 在服务器上安装安卓构建工具链（JDK 17 + Android SDK），全部装 D 盘
# 输出纯 ASCII，写文件后取回读（SSH 的 stdout 编码不可靠）
$ErrorActionPreference = 'Continue'
$rep = 'D:\nebula\logs\toolchain.txt'
$o = New-Object System.Collections.ArrayList
function Log($m) { [void]$o.Add($m); Write-Output $m; $o | Out-File (Join-Path 'D:
ebula\logs' 'toolchain.txt') -Encoding utf8 -ErrorAction SilentlyContinue }

$apps = 'D:\Apps'
$jdkDir = Join-Path $apps 'jdk17'
$sdkDir = Join-Path $apps 'android-sdk'
New-Item -ItemType Directory -Force -Path $jdkDir, $sdkDir | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'

Log '=== 1) JDK 17 (Tsinghua Adoptium mirror) ==='
$jdkZip = Join-Path $apps 'jdk17.zip'
$jdkUrl = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip'
$javac = Get-ChildItem $jdkDir -Recurse -Filter 'javac.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($javac) {
    Log ('  already extracted: ' + $javac.FullName)
} else {
    if (-not (Test-Path $jdkZip)) {
        Log '  downloading...'
        & curl.exe -L --retry 2 -m 1800 -o $jdkZip $jdkUrl 2>&1 | Out-Null
        Log ('  curl exit: ' + $LASTEXITCODE)
    }
    if (Test-Path $jdkZip) {
        Log ('  zip size: ' + [math]::Round((Get-Item $jdkZip).Length / 1MB, 1) + ' MB')
        & $tar -xf $jdkZip -C $jdkDir
        $javac = Get-ChildItem $jdkDir -Recurse -Filter 'javac.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    }
}
if ($javac) {
    $jdkHome = $javac.Directory.Parent.FullName
    Log ('  JDK_HOME = ' + $jdkHome)
    Log ('  version: ' + (& $javac -version 2>&1))
} else {
    Log '  JDK MISSING'
    $o | Out-File $rep -Encoding utf8
    exit 1
}

Log '=== 2) Android cmdline-tools (dl.google.com) ==='
$ctZip = Join-Path $apps 'cmdline-tools.zip'
$ctUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$sdkmanager = Join-Path $sdkDir 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
    if (-not (Test-Path $ctZip)) {
        Log '  downloading...'
        & curl.exe -L --retry 2 -m 1800 -o $ctZip $ctUrl 2>&1 | Out-Null
        Log ('  curl exit: ' + $LASTEXITCODE)
    }
    if (Test-Path $ctZip) {
        Log ('  zip size: ' + [math]::Round((Get-Item $ctZip).Length / 1MB, 1) + ' MB')
        $tmp = Join-Path $sdkDir '_tmp'
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        & $tar -xf $ctZip -C $tmp
        Remove-Item (Join-Path $sdkDir 'cmdline-tools') -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path (Join-Path $sdkDir 'cmdline-tools') | Out-Null
        Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $sdkDir 'cmdline-tools\latest')
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Log ('  sdkmanager: ' + (Test-Path $sdkmanager))

Log '=== 3) accept licenses + install platform-34 / build-tools 34.0.0 ==='
$env:JAVA_HOME = $jdkHome
$env:PATH = (Join-Path $jdkHome 'bin') + ';' + $env:PATH
$lic = ('y' + [Environment]::NewLine) * 60
$lic | & $sdkmanager --sdk_root=$sdkDir --licenses *> (Join-Path $apps 'sdk-lic.log')
Log '  licenses done'
& $sdkmanager --sdk_root=$sdkDir 'platforms;android-34' 'build-tools;34.0.0' *> (Join-Path $apps 'sdk-install.log')
Log '  packages done'

Log '=== 4) verify ==='
$ajar = Join-Path $sdkDir 'platforms\android-34\android.jar'
Log ('  android.jar: ' + (Test-Path $ajar))
foreach ($t in @('aapt2.exe','zipalign.exe','apksigner.bat','d8.bat')) {
    Log ('  ' + $t + ': ' + (Test-Path (Join-Path $sdkDir 'build-tools\34.0.0\' + $t)))
}
Log ('  install log tail:')
if (Test-Path (Join-Path $apps 'sdk-install.log')) {
    Get-Content (Join-Path $apps 'sdk-install.log') -Tail 4 | ForEach-Object { Log ('    ' + $_) }
}
$o | Out-File $rep -Encoding utf8
Write-Output 'TOOLCHAIN-DONE'
