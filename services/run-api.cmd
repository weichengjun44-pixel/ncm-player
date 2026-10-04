@echo off
rem 启动网易云 API 服务（3000），输出追加到 logs\api.log
cd /d "%~dp0..\api"
node app.js >> "%~dp0..\logs\api.log" 2>&1
