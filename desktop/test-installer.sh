#!/usr/bin/env bash
# 安装包完整闭环测试：静默安装（不指定目录，验默认值）→ 验证 → 启动 → 卸载 → 验证清理
# 重点验证两件事：
#   1) 默认安装目录是否落在 D 盘（用户要求：C 盘不留东西）
#   2) 卸载是否干净，且用户数据是否按配置保留
cd /d/code/ncm-player
SETUP="D:/code/ncm-player/dist/NEBULA-Setup-0.1.0.exe"
APP_DIR="D:/NEBULA"

echo "############ 1) 静默安装（不带 /D，验默认目录）############"
if [ ! -f "$SETUP" ]; then echo "✗ 找不到安装包"; exit 1; fi
ls -la "$SETUP" | awk '{printf "  安装包 %.1f MB\n", $5/1048576}'
echo "  执行: NEBULA-Setup-0.1.0.exe /S"
"$SETUP" /S
echo "  已发出安装命令，轮询等待文件落地…"
for i in $(seq 1 60); do
  sleep 2
  if [ -f "$APP_DIR/NEBULA.exe" ]; then echo "  ✓ ${i}x2s：已装到 $APP_DIR"; break; fi
done

echo ""
echo "############ 2) 安装结果验证 ############"
if [ -f "$APP_DIR/NEBULA.exe" ]; then
  echo "  ✓ 主程序: $(ls -la "$APP_DIR/NEBULA.exe" | awk '{printf "%.1f MB", $5/1048576}')"
else
  echo "  ✗ D:\\NEBULA\\NEBULA.exe 不存在 —— 默认目录可能仍落在 C 盘！"
  echo "    查一下 C 盘有没有被装进去："
  ls -d "$LOCALAPPDATA/Programs/"*[Nn][Ee][Bb][Uu][Ll][Aa]* 2>/dev/null || echo "    （C 盘也没找到）"
fi
echo "  — 安装目录内容 —"; ls "$APP_DIR" 2>/dev/null | head -10
echo "  — 是否含打包资源 —"
for f in resources/app/server.js resources/app/web/index.html resources/app/api/index.js resources/app/node_modules/three/build/three.module.js; do
  [ -e "$APP_DIR/$f" ] && echo "    ✓ $f" || echo "    ✗ 缺 $f"
done
echo "  — 快捷方式 —"
ls -la "$USERPROFILE/Desktop/"*NEBULA* 2>/dev/null && echo "    ✓ 桌面快捷方式" || echo "    ✗ 桌面无快捷方式"
ls "$APPDATA/Microsoft/Windows/Start Menu/Programs/"*NEBULA* 2>/dev/null && echo "    ✓ 开始菜单项" || echo "    ✗ 开始菜单无项"
echo "  — 卸载器 —"
ls "$APP_DIR"/Uninstall*.exe 2>/dev/null && echo "    ✓ 卸载器存在" || echo "    ✗ 无卸载器"
echo "  — 注册表登记（控制面板可见性）—"
reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "NEBULA" 2>/dev/null | grep -iE "DisplayName|DisplayIcon|UninstallString" | head -3 || echo "    （未查到，可能键名不同）"

echo ""
echo "############ 3) 启动安装版，验证自包含 ############"
taskkill /F /IM NEBULA.exe >/dev/null 2>&1   # 先确保没有别的实例占着端口/单实例锁
sleep 2
"$APP_DIR/NEBULA.exe" &
for i in $(seq 1 50); do
  sleep 1
  if curl -s -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "  ✓ ${i}s：安装版已拉起服务"
    break
  fi
done
echo -n "  中间层 8080 : "; curl -s -m 5 http://127.0.0.1:8080/healthz || echo "✗"; echo
echo -n "  网易云 API  : "; curl -s -m 12 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/search?keywords=t&limit=1"
echo -n "  QQ 音源     : "; curl -s -m 25 "http://127.0.0.1:8080/api/search?keywords=%E6%99%B4%E5%A4%A9&limit=1&source=qq" | head -c 80; echo
echo "  进程数: $(tasklist 2>/dev/null | grep -c 'NEBULA.exe')"

echo ""
if [ "$1" != "--uninstall" ]; then
  echo ""
  echo "############ 4) 安装版保持运行（供截图）############"
  echo "  要卸载请执行: bash desktop/test-installer.sh --uninstall"
  exit 0
fi

echo "############ 4) 开始卸载 ############"
taskkill /F /IM NEBULA.exe >/dev/null 2>&1 && echo "  已关闭安装版"
sleep 3
UNINST=$(ls "$APP_DIR"/Uninstall*.exe 2>/dev/null | head -1)
if [ -n "$UNINST" ]; then
  echo "  执行卸载: $UNINST /S"
  "$UNINST" /S
  for i in $(seq 1 40); do
    sleep 2
    [ ! -f "$APP_DIR/NEBULA.exe" ] && { echo "  ✓ ${i}x2s：程序文件已卸载"; break; }
  done
else
  echo "  ✗ 找不到卸载器"
fi

echo ""
echo "############ 5) 卸载结果 ############"
[ -d "$APP_DIR" ] && { echo "  残留目录:"; ls "$APP_DIR" 2>/dev/null | head -6; } || echo "  ✓ 安装目录已完全移除"
[ -d "$USERPROFILE/Desktop" ] && ls "$USERPROFILE/Desktop/"*NEBULA* >/dev/null 2>&1 && echo "  ⚠ 桌面快捷方式仍在" || echo "  ✓ 桌面快捷方式已清理"
echo "  — 用户数据（按配置应保留）—"
ls -d /d/NebulaPlayer/* 2>/dev/null | sed 's/^/    /' || echo "    无"
echo "    登录凭据: $(ls /d/NebulaPlayer/data/.cookie* 2>/dev/null | wc -l) 个 cookie 文件"
