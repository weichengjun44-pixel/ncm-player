#!/usr/bin/env bash
# 本机清理：只删【已备份到服务器】或【可重新生成】的东西
#
# 硬性约束（用户明确要求）：
#   1. 不影响系统正常工作 —— 全程不碰 Windows 系统文件，只动 D:\Apps 与项目目录
#   2. 不影响 Hermes 工作环境 —— 配置/技能/插件/会话/记忆一律不删（只清 cache/scratch 临时目录）
#
# 每一项都写明为什么可以删。删之前先打印大小，删之后对比空间。
set -u

HERMES="$LOCALAPPDATA/hermes"
PROJ="/d/code/ncm-player"

before=$(df -k /d | tail -1 | awk '{print $4}')

size() { [ -e "$1" ] && du -sh "$1" 2>/dev/null | awk '{print $1}' || echo "不存在"; }

# 安全防护：绝不触碰 Hermes 工作环境（除 cache/scratch），也绝不触碰系统目录
guard() {
  case "$1" in
    "$HERMES"|"$HERMES"/*)
      case "$1" in
        "$HERMES/cache/scratch"|"$HERMES/cache/scratch"/*) return 0 ;;
        *) echo "  ✗ 拒绝：$1 属于 Hermes 工作环境"; return 1 ;;
      esac ;;
    /c/Windows*|/c/Program*|/c/Users/*/Documents*|/c/Users/*/Desktop*)
      echo "  ✗ 拒绝：$1 属于系统/用户目录"; return 1 ;;
    /d/Apps/*|/d/code/ncm-player/*|/d/Apps|/d/code/ncm-player) return 0 ;;
    *) echo "  ✗ 拒绝：$1 不在允许范围内"; return 1 ;;
  esac
}

do_rm() {
  local path="$1" why="$2"
  if [ ! -e "$path" ]; then echo "  - 已不存在: $path"; return; fi
  if ! guard "$path"; then return; fi
  printf "  %-46s %-8s %s\n" "$(basename "$path")" "$(size "$path")" "$why"
  rm -rf "$path"
}

echo "=== A) 已装到服务器、本机不再需要的工具链 ==="
do_rm "/d/Apps/jdk17"            "在服务器 D:\\Apps\\jdk17（那边能构建 APK）"
do_rm "/d/Apps/android-sdk"      "在服务器 D:\\Apps\\android-sdk"
do_rm "/d/Apps/jdk17.zip"        "安装包已解压且服务器有全套"
do_rm "/d/Apps/cmdline-tools.zip" "同上"

echo "=== B) 构建产物 ==="
# 注意：桌面版安装包【尚未送达服务器】（ZeroTier 链路中断，传输失败）——
# 按"先确认送到才清"的原则，它必须保留。免安装版可由源码重建（源码在服务器上）。
if [ -f "$PROJ/dist/NEBULA-Setup-0.1.0.exe" ]; then
  echo "  ⚠ 保留 dist/NEBULA-Setup-0.1.0.exe（$(size "$PROJ/dist/NEBULA-Setup-0.1.0.exe")）：唯一副本且尚未送达服务器"
fi
do_rm "$PROJ/dist/win-unpacked"   "免安装版，可由源码重建（源码与构建脚本都在服务器）"
# shellcheck disable=SC2086
for f in "$PROJ"/dist/*.blockmap "$PROJ"/dist/builder-*.yaml; do
  [ -e "$f" ] && do_rm "$f" "electron-builder 中间产物，无用"
done
do_rm "$PROJ/desktop/node_modules" "Electron 构建树，可由 npm 重装（服务器有源码）"

echo "=== C) 根目录里的 Electron 残留（保留 three，前端要用）==="
for d in @electron @develar @malept @npmcli @pkgjs @sindresorhus @szmarczak @tootallnate @isaacs @gar; do
  do_rm "$PROJ/node_modules/$d" "桌面版构建残留，运行不需要"
done

echo "=== D) 运行日志与截图（服务器上有对应记录）==="
do_rm "$PROJ/logs"               "运行日志，服务器 D:\\nebula\\logs 有"
do_rm "$PROJ/shots"              "探针截图，一次性"
do_rm "$PROJ/client.log"         "前端报错记录，服务器上有"

echo "=== E) 我这次会话的临时文件（有价值的脚本已收进仓库 services/server/）==="
if [ -d "$HERMES/cache/scratch" ]; then
  before_s=$(du -sh "$HERMES/cache/scratch" 2>/dev/null | awk '{print $1}')
  echo "  cache/scratch: $before_s"
  for f in "$HERMES/cache/scratch"/*; do
    [ -e "$f" ] && guard "$f" && rm -rf "$f"
  done
  echo "  ✓ 已清空（仅此目录，Hermes 配置/技能/会话/记忆一律未动）"
fi

echo ""
after=$(df -k /d | tail -1 | awk '{print $4}')
echo "=== 结果 ==="
echo "  D 盘释放: $(( (after - before) / 1024 )) MB"
echo "  D 盘可用: $(( after / 1024 / 1024 )) GB"

echo ""
echo "=== 保留清单（确认这些还在）==="
for p in "/d/Apps/cloudflared" "$PROJ/server.js" "$PROJ/web" "$PROJ/api/node_modules" "$PROJ/node_modules/three" "$PROJ/STATUS.md" "$PROJ/.git" "$HERMES/skills" "$HERMES/plugins" "$HERMES/config.yaml" "/d/NebulaPlayer"; do
  [ -e "$p" ] && printf "  ✓ %-52s %s\n" "$p" "$(size "$p")" || printf "  ✗ 丢失: %s\n" "$p"
done
