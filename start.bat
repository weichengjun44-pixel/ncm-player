@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   NEBULA 粒子音乐空间 —— 一键启动
echo ============================================

if not exist "api\node_modules" (
  echo [!] 还没装依赖，先跑 setup.bat
  pause
  exit /b 1
)
if not exist "node_modules\three" (
  echo [!] 还没装 three，先跑 setup.bat
  pause
  exit /b 1
)

start "NCM-API (3000)" cmd /k "cd /d %~dp0api && node app.js"
timeout /t 3 >nul
start "NCM-WEB (8080)" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 2 >nul
start "" "http://localhost:8080"

echo.
echo 已启动：
echo   网易云 API 服务  http://localhost:3000
echo   播放器页面       http://localhost:8080
echo 关闭那两个黑窗口即可停止服务。
