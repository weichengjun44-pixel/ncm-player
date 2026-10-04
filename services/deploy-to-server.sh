#!/usr/bin/env bash
# 部署到服务器（DESKTOP-87P9U2C）—— 白名单式
#
# 为什么是白名单：之前用「排除法」打包（--exclude='./node_modules' 想排掉根目录
# Electron 构建残留），结果把运行必需的 node_modules/three 一起排掉了。
# 前端 importmap 把 'three' 指到 /vendor/three/*，中间层再从 node_modules/three 读，
# 于是 three 缺失 → 模块图断掉 → 浏览器只报最外层"js/app.js 加载失败"，
# 用户看到的是"资源加载失败 + 启动卡住"，而真正的原因藏了两层。
# 教训：搬运清单要显式列出（白名单），不要依赖排除规则。
set -e

SRC="${SRC:-/d/code/ncm-player}"
HOST="${HOST:-desk}"
DST="${DST:-D:/nebula}"
TMP=/tmp/nebula-deploy.tgz

# 运行真正需要的东西（node_modules 里只带 three：中间层的 /vendor/three 从它读）
ITEMS=(
  server.js sources.js
  web services api
  node_modules/three
  LICENSE README.md .gitignore
)

echo "=== 1) 打包（白名单）==="
cd "$SRC"
EXIST=()
for i in "${ITEMS[@]}"; do [ -e "$i" ] && EXIST+=("$i") || echo "  ⚠ 本地缺少 $i（跳过）"; done
[ -f .cookie ] && EXIST+=(.cookie) || echo "  ⚠ 没有 .cookie（登录凭据未部署）"
rm -f "$TMP"
tar czf "$TMP" "${EXIST[@]}"
ls -la "$TMP" | awk '{printf "  ✓ 部署包 %.1f MB\n", $5/1048576}'

echo "=== 2) 打包自检（关键文件必须在包里）==="
for f in server.js web/index.html web/js/app.js web/js/boot.js api/app.js node_modules/three/build/three.module.js; do
  n=$(tar tzf "$TMP" 2>/dev/null | grep -c "^$f$")
  [ "$n" = "1" ] && echo "  ✓ $f" || { echo "  ✗ $f 不在包里！"; exit 1; }
done

echo "=== 3) 传输 ==="
scp -o ConnectTimeout=20 "$TMP" "$HOST:$DST/deploy.tgz" 2>&1 | grep -v "WARNING\|session may\|server may\|openssh" || true
echo "  已传输"

echo "=== 4) 服务器上解压 ==="
ssh -o ConnectTimeout=25 "$HOST" "tar -xzf 'D:\nebula\deploy.tgz' -C 'D:\nebula'; Write-Output '  EXTRACT-OK'" 2>&1 | grep -v "WARNING\|session may\|server may\|openssh"

echo "=== 5) 服务器上核对 ==="
ssh -o ConnectTimeout=25 "$HOST" "foreach (\$f in @('server.js','web\index.html','api\app.js','node_modules\three\build\three.module.js')) { if (Test-Path ('D:\nebula\' + \$f)) { Write-Output ('  OK       ' + \$f) } else { Write-Output ('  MISSING  ' + \$f) } }" 2>&1 | grep -v "WARNING\|session may\|server may\|openssh"

echo ""
echo "完成。中间层监听中会自动提供新文件；node_modules/three 这类静态资源立即生效。"
echo "若改的是 server.js 本身，重启中间层（杀掉 8080 进程，看护会在 15 秒内拉起）。"
