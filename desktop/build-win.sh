#!/usr/bin/env bash
# 打包 NEBULA 桌面版为 NSIS 安装包
# 关键：electron-builder 平时从 GitHub 拉 nsis/winCodeSign 等辅助二进制（被墙），
# 这里把下载源指到 npmmirror 的 electron-builder-binaries 镜像。
set -e
cd "$(dirname "$0")"      # 注意：是 desktop/ 自己，不是项目根（根没有 dist 脚本）

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
export CSC_IDENTITY_AUTO_DISCOVERY=false      # 不签名：没有证书，跳过省一大截下载
export ELECTRON_CACHE="D:/code/ncm-player/desktop/.cache/electron"
export ELECTRON_BUILDER_CACHE="D:/code/ncm-player/desktop/.cache/electron-builder"

echo "=== 1) 装 electron-builder ==="
npm install -D electron-builder@25 --no-audit --no-fund 2>&1 | tail -6

echo "=== 2) 待批准的安装脚本（新版 npm 会拦住 postinstall）==="
npm install-scripts ls 2>&1 | tail -12 || true

echo "=== 3) 开始打包 ==="
npm run dist 2>&1 | tail -40

echo "=== 4) 产物 ==="
ls -la ../dist/ 2>/dev/null || echo "（没有 dist 目录）"
