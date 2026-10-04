@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   NEBULA 粒子音乐空间 —— 首次安装
echo ============================================

if not exist "api" (
  echo [1/3] 拉取网易云 API 服务...
  git clone --depth 1 https://github.com/neteasecloudmusicapienhanced/api-enhanced.git api
  if errorlevel 1 (
    echo.
    echo [!] clone 失败。国内网络建议先开代理，或改用镜像：
    echo     git clone --depth 1 https://ghfast.top/https://github.com/neteasecloudmusicapienhanced/api-enhanced.git api
    pause
    exit /b 1
  )
) else (
  echo [1/3] api 目录已存在，跳过
)

echo [2/3] 安装 API 服务依赖（约 550 个包）...
cd api
call npm install --no-audit --no-fund
cd ..
if errorlevel 1 ( echo [!] API 依赖安装失败 & pause & exit /b 1 )

echo [3/3] 安装前端依赖 three.js...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo [!] three 安装失败 & pause & exit /b 1 )

echo.
echo 装完了，双击 start.bat 启动。
pause
