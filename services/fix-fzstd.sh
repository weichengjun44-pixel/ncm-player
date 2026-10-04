#!/usr/bin/env bash
# 真修：升级 fzstd（0.1.1 解不了某些合法 zstd 流，原生解码器可以），
# 并把之前的 catch 改成"记警告 + 原样返回"，既不崩也不掩盖。
set -e
API="/d/code/ncm-player/api"
API_WIN="D:/code/ncm-player/api"

echo "=== 1) 当前 fzstd 版本 ==="
node -e "console.log('  ', require('$API_WIN/node_modules/fzstd/package.json').version)" 2>/dev/null || echo "  (读不到)"

echo "=== 2) 升级 fzstd ==="
( cd "$API" && npm install fzstd@latest --no-audit --no-fund 2>&1 | tail -4 )
node -e "console.log('  升级后:', require('$API_WIN/node_modules/fzstd/package.json').version)" 2>/dev/null

echo "=== 3) 把 catch 改成记警告（保留容错，但不再静默）==="
python - "$API_WIN/util/zstd.js" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding='utf-8')
old = """  } catch (e) {
    // fzstd 在 Electron 里会这样报错：打包版用 Electron 自带的 Node（20.x），
    // 没有原生 zstd 所以走 fzstd 分支，而空的/非 zstd 的响应体会让它抛 "unexpected EOF"；
    // 同一个响应在系统 Node（22.15+，走原生分支）下不报 —— 所以这个错只在打包版出现。
    // 拿不到就原样返回：让解码失败的响应交给下游正常报错，而不是在这里把请求链路打挂。
    return buf
  }"""
new = """  } catch (e) {
    // Electron 自带 Node 20（无原生 zstd）→ 走 fzstd 分支；某些合法 zstd 流它解不了。
    // 记一条警告后原样返回：不让一次解码失败把整条请求链路打挂，同时保留线索（不静默吞掉）。
    try {
      console.warn('[zstd] 解压失败，按原文返回:', e && e.message)
    } catch (_) {}
    return buf
  }"""
if s.count(old) != 1:
    print('  ⚠ 未匹配（可能已是新版写法），跳过')
else:
    p.write_text(s.replace(old, new, 1), encoding='utf-8')
    print('  ✓ 已改为记警告')
PY

echo "=== 4) 用 Electron 的 Node 实测 ==="
LOG=/tmp/zstd-verify2.log
cd "$API"
PORT=3014 ELECTRON_RUN_AS_NODE=1 /d/code/ncm-player/dist/win-unpacked/NEBULA.exe index.js > "$LOG" 2>&1 &
PID=$!
sleep 18
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3014/search?keywords=test&limit=1" 2>/dev/null)
echo "  接口自检: HTTP ${CODE:-无响应}"
kill $PID 2>/dev/null; taskkill /F /PID $PID >/dev/null 2>&1

echo ""
echo "=== 5) 判定 ==="
if grep -q "unexpected EOF" "$LOG" 2>/dev/null; then echo "  ✗ 仍有 unexpected EOF"; else echo "  ✓ 不再有 unexpected EOF"; fi
if grep -q "解压失败，按原文返回" "$LOG" 2>/dev/null; then echo "  · 仍有解压失败（升级没解决，但已降级为警告）"; else echo "  ✓ 没有解压失败 —— 升级 fzstd 真的解决了"; fi
if grep -q "neapiConfig\|loadChunk" "$LOG" 2>/dev/null; then echo "  ✗ neapiConfig 那层仍报错"; else echo "  ✓ neapiConfig 那层也干净了"; fi
echo ""
echo "  日志（去掉噪音）:"; grep -v "injected env\|╔\|╠\|╩\|^\s*$" "$LOG" 2>/dev/null | tail -6 | sed 's/^/    /'
