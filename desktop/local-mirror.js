/**
 * 本地 electron-builder 二进制镜像（只为了解决 winCodeSign 的符号链接权限问题）
 *
 * 背景：winCodeSign-2.6.0.7z 里含两个 macOS 的符号链接（darwin/10.12/lib/libcrypto.dylib 等），
 * Windows 普通账户没有 SeCreateSymbolicLinkPrivilege → 7-Zip 建不了符号链接 → 退出码 2
 * → electron-builder 判定解压失败，NSIS 打包中断（而且它每次用随机目录名解压，预解压没用）。
 *
 * 做法：把那个包重打成不含 darwin 的版本，用这个小服务提供；
 * 其余所有请求 302 到 npmmirror。打包时把 ELECTRON_BUILDER_BINARIES_MIRROR 指到本服务即可。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.MIRROR_PORT || 8899);
const UPSTREAM = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
const LOCAL = {
  '/winCodeSign-2.6.0/winCodeSign-2.6.0.7z':
    'D:/code/ncm-player/desktop/.cache/electron-builder/winCodeSign/fixed/winCodeSign-2.6.0.7z',
};

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = LOCAL[p];
  if (file) {
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('local override missing: ' + file);
      console.log('✗ 本地文件不存在:', file);
      return;
    }
    const st = fs.statSync(file);
    console.log('✓ 本地提供', p, st.size, '字节');
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/x-7z-compressed' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  console.log('→ 转发上游', p);
  res.writeHead(302, { Location: UPSTREAM.replace(/\/$/, '') + p });
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地镜像已启动: http://127.0.0.1:${PORT}/`);
  console.log('覆盖的路径:', Object.keys(LOCAL).join(', '));
  console.log('其余 302 →', UPSTREAM);
});
