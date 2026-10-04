#!/usr/bin/env bash
# 验证打包版是否自包含：先把开发环境的服务全部停掉，再跑打包出来的 exe。
# 如果它自己能起来（中间层 + 网易云 API 都靠它自己拉起），才说明打包成功。
cd "$(dirname "$0")/.."
ROOT=$(pwd)
APP="$ROOT/dist/win-unpacked/NEBULA.exe"
LOG="$ROOT/dist/verify.log"

echo "=== 0) 检查产物 ==="
if [ ! -f "$APP" ]; then echo "✗ 找不到 $APP"; exit 1; fi
ls -la "$APP"
du -sh "$ROOT/dist/win-unpacked" 2>/dev/null

echo "=== 1) 停掉开发环境的所有相关进程（看护 + 中间层 + API）==="
for PORT in 8080 3000; do
  PID=$(netstat -ano 2>/dev/null | grep LISTENING | grep ":$PORT " | head -1 | awk '{print $NF}')
  if [ -n "$PID" ]; then taskkill /F /PID "$PID" >/dev/null 2>&1 && echo "  已停 :$PORT (PID $PID)"; fi
done
# 看护会自己把服务拉回来，验证期间要停掉它。
# 只停"跑着 watchdog.ps1 的那个" powershell，不要无差别杀所有 powershell（会误伤用户自己的终端）
for P in $(wmic process where "name='powershell.exe'" get processid,commandline 2>/dev/null | grep -i "watchdog.ps1" | grep -oE "[0-9]+\s*$"); do
  taskkill /F /PID "$P" >/dev/null 2>&1 && echo "  已停看护 (PID $P)"
done
sleep 3
curl -s -m 3 http://localhost:8080/healthz >/dev/null 2>&1 && echo "  ⚠ 8080 仍活着" || echo "  ✓ 8080 已空"
curl -s -m 3 http://localhost:3000/ >/dev/null 2>&1 && echo "  ⚠ 3000 仍活着" || echo "  ✓ 3000 已空"

echo "=== 2) 启动打包版 ==="
rm -f "$LOG"
"$APP" > "$LOG" 2>&1 &
APP_PID=$!
echo "  exe PID=$APP_PID，等待自启…"
for i in $(seq 1 40); do
  sleep 1
  if curl -s -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "  ✓ ${i}s 后中间层已由打包版拉起"
    break
  fi
done

echo "=== 3) 关键自检 ==="
echo -n "  中间层 /healthz : "; curl -s -m 5 http://127.0.0.1:8080/healthz || echo "✗ 无响应"; echo
echo -n "  网易云 API :3000 : "
curl -s -m 8 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/search?keywords=test&limit=1" || echo "✗ 无响应"
echo -n "  多音源路由 /api/sources : "; curl -s -m 5 http://127.0.0.1:8080/api/sources | head -c 120; echo
echo -n "  前端页面 : "; curl -s -m 5 -o /dev/null -w "%{http_code} %{size_download}B\n" http://127.0.0.1:8080/
echo -n "  three.js 静态资源 : "; curl -s -m 5 -o /dev/null -w "%{http_code} %{size_download}B\n" "http://127.0.0.1:8080/vendor/three/build/three.module.js"
echo -n "  数据目录（应在 D 盘）: "; ls -d /d/NebulaPlayer/* 2>/dev/null | tr '\n' ' '; echo

echo "=== 4) 进程树（应有主进程 + 渲染 + API 子进程）==="
tasklist 2>/dev/null | grep -i "NEBULA" | head -8

echo ""
echo "打包版仍在运行，PID=$APP_PID（要停就 taskkill /F /PID $APP_PID）"
echo "日志：$LOG"
cat "$LOG" 2>/dev/null | head -20
