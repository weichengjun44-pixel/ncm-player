#!/usr/bin/env bash
# 带本地镜像的打包：winCodeSign 走本地（去掉了 macOS 符号链接），其余走 npmmirror
set -e
cd "$(dirname "$0")"

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="http://127.0.0.1:8899/"
export CSC_IDENTITY_AUTO_DISCOVERY=false
export ELECTRON_CACHE="D:/code/ncm-player/desktop/.cache/electron"
export ELECTRON_BUILDER_CACHE="D:/code/ncm-player/desktop/.cache/electron-builder"

echo "=== 1) 起本地镜像（8899）==="
if curl -s -m 2 "http://127.0.0.1:8899/winCodeSign-2.6.0/winCodeSign-2.6.0.7z" -o /dev/null 2>/dev/null; then
  echo "  已在运行"
else
  node local-mirror.js > /tmp/mirror.log 2>&1 &
  echo $! > /tmp/mirror.pid
  sleep 2
  echo "  已启动 (PID $(cat /tmp/mirror.pid))"
fi
# 自检用 $( ) 包起来并容错：之前写成裸 curl + set -e，curl 返回 23 直接把脚本打死（踩过）
echo "  自检：本地包 HTTP $(curl -s -m 8 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8899/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' || echo '?')"
echo "  自检：转发路径 HTTP $(curl -s -m 8 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8899/nsis-3.0.4.2/nsis-3.0.4.2.7z' || echo '?')（302 正常）"

echo "=== 2) 打包 ==="
npm run dist 2>&1 | tail -30

echo "=== 3) 产物 ==="
ls -la ../dist/*.exe 2>/dev/null || echo "  （还没有安装包）"
ls -d ../dist/win-unpacked 2>/dev/null && du -sh ../dist/win-unpacked
