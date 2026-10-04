#!/usr/bin/env python3
"""递归检查前端模块图：从 index.html 出发，解析所有 import，逐层抓取，
找出任何 404 —— 这样就不受浏览器缓存干扰，能确定"到底还有没有真的缺文件"。
用法: python services/check-module-graph.py [base_url]
"""
import re
import sys
import urllib.request
import urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://herb-glen-inherited-panels.trycloudflare.com").rstrip('/')

IMPORTMAP = {}
seen = {}
errors = []
queue = []


def fetch(path, ref=None):
    if path.startswith('http'):
        url = path
    else:
        # 相对路径要先归一化（./js/x 直接拼会变成 ...com./js/x）
        p = path
        while p.startswith('./'):
            p = p[2:]
        url = BASE + '/' + p.lstrip('/')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'NebulaGraphCheck/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        errors.append((url, f'HTTP {e.code}', ref))
        return e.code, ''
    except Exception as e:
        errors.append((url, type(e).__name__ + ': ' + str(e), ref))
        return 0, ''


print(f'基准地址: {BASE}\n')

# 1) 首页
st, html = fetch('/')
print(f'  /            HTTP {st}  {len(html)} 字节')
if st != 200:
    print('首页都取不到，后面不用查了'); sys.exit(1)

# 2) importmap
m = re.search(r'<script type="importmap">(.*?)</script>', html, re.S)
if m:
    import json
    try:
        importmap = json.loads(m.group(1))
        IMPORTMAP.update(importmap.get('imports', {}))
        print(f'  importmap    {len(IMPORTMAP)} 条: {list(IMPORTMAP.keys())}')
    except Exception as e:
        print(f'  importmap 解析失败: {e}')

# 3) 所有 module script
for src in re.findall(r'<script[^>]+src="([^"]+)"', html):
    queue.append((src, 'index.html'))
for href in re.findall(r'<link[^>]+href="([^"]+)"', html):
    if href.endswith('.css') or href.endswith('.png') or href.endswith('manifest'):
        queue.append((href, 'index.html'))

# 4) 递归
def resolve(spec, from_path):
    if spec.startswith('http'):
        return spec
    if spec.startswith('.') or spec.startswith('/'):
        base = from_path.rsplit('/', 1)[0]
        parts = (base + '/' + spec).split('/')
        out = []
        for p in parts:
            if p == '..':
                if out: out.pop()
            elif p not in ('', '.'):
                out.append(p)
        return '/' + '/'.join(out)
    # importmap 规范：最长的匹配前缀优先。
    # 之前按字典顺序匹配，导致 'three/addons/x' 被 'three' 抢走，
    # 拼成了 three.module.js/addons/x（假 404）—— 检查器自己也必须守规范。
    hits = [(k, v) for k, v in IMPORTMAP.items()
            if spec == k or spec.startswith(k)]
    if hits:
        k, v = max(hits, key=lambda kv: len(kv[0]))
        return v + spec[len(k):]
    return None

depth = 0
while queue and depth < 2000:
    depth += 1
    path, ref = queue.pop(0)
    if path in seen:
        continue
    seen[path] = ref
    st, body = fetch(path, ref)
    flag = '✓' if st == 200 else '✗'
    print(f'  {flag} {path:<58} HTTP {st}   (来自 {ref})')
    if st != 200:
        continue
    if not (path.endswith('.js') or path.endswith('.mjs')):
        continue
    for spec in re.findall(r"""(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]""", body):
        r = resolve(spec, path)
        if r and r not in seen:
            queue.append((r, path))
    for spec in re.findall(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""", body):
        r = resolve(spec, path)
        if r and r not in seen:
            queue.append((r, path))

print(f'\n共检查 {len(seen)} 个资源')
if errors:
    print(f'\n✗ 发现 {len(errors)} 个失败:')
    for u, why, ref in errors:
        print(f'   {u}\n      {why}   (被 {ref} 引用)')
else:
    print('✓ 模块图完整，没有任何 404')
