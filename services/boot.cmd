@echo off
rem 开机自启入口：只启动看护脚本，由看护负责把 API(3000) + 中间层(8080) + 公网隧道 全部拉起来。
rem 这样只有一个启动点，加服务只需要改看护脚本。
cd /d D:\code\ncm-player
start "nebula-watchdog" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\code\ncm-player\services\watchdog.ps1"
