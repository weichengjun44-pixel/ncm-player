@echo off
rem 启动中间层 + 前端（8080），输出追加到 logs\web.log
cd /d "%~dp0.."
node server.js >> "%~dp0..\logs\web.log" 2>&1
