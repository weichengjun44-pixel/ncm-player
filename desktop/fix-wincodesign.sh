#!/usr/bin/env bash
# 绕开 winCodeSign 的符号链接权限问题：
#   1) 用它已经解出来的内容（除 darwin 外都在）重新打一个不含 macOS 符号链接的 7z
#   2) 起一个本地小镜像：这个包走本地，其余照旧 302 到 npmmirror
#   3) 打包时把 ELECTRON_BUILDER_BINARIES_MIRROR 指到本地
set -e
ROOT="/d/code/ncm-player"
CACHE="$ROOT/desktop/.cache/electron-builder/winCodeSign"
WORK="$CACHE/fixed"
# 原生程序（7za）不认 MSYS 的 /d/... 路径，必须给 Windows 风格路径
WINWORK="D:/code/ncm-player/desktop/.cache/electron-builder/winCodeSign/fixed"
SEVEN="D:/code/ncm-player/desktop/node_modules/7zip-bin/win/x64/7za.exe"

echo "=== 1) 找一份已解出的内容（上一轮留下的）==="
SRC=""
for d in "$CACHE"/*/; do
  if [ -f "$d/rcedit-x64.exe" ]; then SRC="$d"; break; fi
done
if [ -z "$SRC" ]; then
  echo "  没有可用的解出内容，先手动解一次"
  A=$(ls "$CACHE"/*.7z 2>/dev/null | head -1)
  [ -z "$A" ] && { echo "  ✗ 连 7z 包都没有"; exit 1; }
  mkdir -p "$WORK/extract"
  "$SEVEN" x -snld -bd -y "$A" -o"$WORK/extract" 2>&1 | tail -2 || true
  SRC="$WORK/extract/"
fi
echo "  用: $SRC"
ls "$SRC" | head -6

echo "=== 2) 重新打包（排除 darwin，那里才有 macOS 符号链接）==="
mkdir -p "$WORK"
rm -f "$WORK/winCodeSign-2.6.0.7z"
( cd "$SRC" && "$SEVEN" a -mx=1 -xr'!darwin' "$WINWORK/winCodeSign-2.6.0.7z" . 2>&1 | tail -3 )
ls -la "$WORK/winCodeSign-2.6.0.7z"

echo "=== 3) 内容自检（Windows 工具必须在）==="
"$SEVEN" l "$WINWORK/winCodeSign-2.6.0.7z" 2>/dev/null | grep -E "rcedit-x64.exe|windows-10/x64/makeappx.exe|darwin" | head -5
echo "  （不应再出现 darwin）"
