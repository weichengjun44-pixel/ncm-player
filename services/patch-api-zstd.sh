#!/usr/bin/env bash
# 给 api/util/zstd.js 打一个容错补丁（幂等，可重复执行）
#
# 背景：Electron 自带的 Node 是 20.x，没有原生 zstd（Node 22.15+ 才有），
# 于是 util/zstd.js 走 fzstd 分支；遇到空的/非 zstd 的响应体时 fzstd 会抛
# "unexpected EOF"，而原生解码器在这种情况下不报错。
# 表现：只在打包版里能看到的启动期报错（匿名 token 注册那一步），不影响功能但日志难看。
#
# api/ 是独立 clone 且不在本仓库里（会随桌面版一起打包），所以补丁做成脚本以便重放。
set -e
API_DIR="/d/code/ncm-player/api"
API_DIR_WIN="D:/code/ncm-player/api"   # 传给原生程序（python/node）的路径：不认 MSYS 的 /d/...
TARGET="$API_DIR/util/zstd.js"
TARGET_WIN="$API_DIR_WIN/util/zstd.js"

[ -f "$TARGET" ] || { echo "✗ 找不到 $TARGET"; exit 1; }

if grep -q "fzstd 在 Electron" "$TARGET" 2>/dev/null; then
  echo "✓ 补丁已存在，跳过"
  exit 0
fi

python - "$TARGET_WIN" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old = """const decompress = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return hasNative
    ? zlib.zstdDecompressSync(buf)
    : Buffer.from(fzstdDecompress(buf))
}"""
new = """const decompress = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  try {
    return hasNative
      ? zlib.zstdDecompressSync(buf)
      : Buffer.from(fzstdDecompress(buf))
  } catch (e) {
    // fzstd 在 Electron 里会这样报错：打包版用 Electron 自带的 Node（20.x），
    // 没有原生 zstd 所以走 fzstd 分支，而空的/非 zstd 的响应体会让它抛 "unexpected EOF"；
    // 同一个响应在系统 Node（22.15+，走原生分支）下不报 —— 所以这个错只在打包版出现。
    // 拿不到就原样返回：让解码失败的响应交给下游正常报错，而不是在这里把请求链路打挂。
    return buf
  }
}"""
if s.count(old) != 1:
    print('✗ 未匹配到原始实现（%d 处），可能上游已改' % s.count(old))
    raise SystemExit(1)
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('✓ 已打补丁')
PY

echo "=== 验证改动 ==="
sed -n '/const decompress = /,/^}/p' "$TARGET"
node -e "require('$TARGET_WIN'); console.log('✓ 补丁后模块可正常加载')"