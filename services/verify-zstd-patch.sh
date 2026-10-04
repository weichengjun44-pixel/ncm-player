#!/usr/bin/env bash
# 验证 zstd 补丁：用 Electron 自带的 Node 跑 API（打包版走的就是这条路），
# 看那个 "unexpected EOF at decompress (fzstd)" 是否消失。
# 对照：补丁前每次启动必现；如仍出现说明补丁没生效或问题在别处。
APP="/d/code/ncm-player/dist/win-unpacked/NEBULA.exe"
API="/d/code/ncm-player/api"
LOG="/tmp/zstd-verify.log"
cd "$API" || exit 1

echo "=== 用 Electron 的 Node 跑 API（:3013）==="
PORT=3013 ELECTRON_RUN_AS_NODE=1 "$APP" index.js > "$LOG" 2>&1 &
PID=$!
sleep 18

CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3013/search?keywords=test&limit=1" 2>/dev/null)
echo "  接口自检: HTTP ${CODE:-无响应}"
kill $PID 2>/dev/null
taskkill /F /PID $PID >/dev/null 2>&1

echo ""
echo "=== 关键判定：日志里还有没有 fzstd 报错 ==="
if grep -q "fzstd\|unexpected EOF" "$LOG" 2>/dev/null; then
  echo "  ✗ 仍然出现 —— 补丁没生效"
  grep -n -A 2 "unexpected EOF" "$LOG" | head -6
else
  echo "  ✓ 报错已消失（补丁生效）"
fi
echo ""
echo "=== Electron 的 Node 版本 + 走的是哪个分支 ==="
ELECTRON_RUN_AS_NODE=1 "$APP" -e "console.log('  Electron Node:', process.version); console.log('  有原生 zstd:', typeof require('zlib').zstdCompressSync === 'function');"
echo ""
echo "=== 日志全文（应只有正常启动 + 请求成功的行）==="
grep -v "injected env\|╔\|╠\|╩\|^\s*$" "$LOG" 2>/dev/null | tail -8 | sed 's/^/  /'
