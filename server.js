/**
 * 网易云粒子播放器 —— 本地中间层
 *
 * 职责：
 *   1. 静态服务 web/ 目录（前端页面）
 *   2. /api/*  -> 转发到本地网易云 API 服务（默认 http://127.0.0.1:3000）
 *   3. /stream  -> 解析歌曲真实地址后同源转发音频流（支持 Range，便于拖动进度）
 *   4. /cover   -> 同源转发封面图（走同源才能当 WebGL 纹理用）
 *
 * 零外部依赖，只要 Node 18+（本机 Node 26）。
 *   启动:  node server.js            （默认端口 8080）
 *          PORT=9000 node server.js
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT || 8080);
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

function log(...a) {
  const line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + a.join(' ');
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, 'logs', 'server.log'), line + '\n');
  } catch {}
}

// 进程级兜底：任何未捕获异常都只记日志，不让服务器倒下
process.on('uncaughtException', (err) => log('!! uncaughtException:', err && err.stack ? err.stack.split('\n')[0] : err));
process.on('unhandledRejection', (err) => log('!! unhandledRejection:', err && err.stack ? err.stack.split('\n')[0] : err));

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
}

/** 转发 /api/* 到网易云 API 服务 */
async function proxyApi(req, res, url) {
  const target = API_BASE + url.pathname.replace(/^\/api/, '') + (url.search || '');
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: 'application/json' },
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    log('API 代理失败:', target, err.message);
    sendJson(res, 502, { ok: false, error: '网易云 API 服务不可达: ' + err.message });
  }
}

/** 取歌曲真实播放地址（走 API 服务） */
async function resolveSongUrl(id, level = 'exhigh') {
  const target = `${API_BASE}/song/url/v1?id=${encodeURIComponent(id)}&level=${level}`;
  const r = await fetch(target);
  const j = await r.json();
  const item = Array.isArray(j.data) ? j.data[0] : null;
  return item && item.url ? item.url : null;
}

/** 把远端音频流按 Range 转发给浏览器（带上网易云要求的 Referer） */
async function proxyStream(req, res, url) {
  const id = url.searchParams.get('id');
  const level = url.searchParams.get('level') || 'exhigh';
  if (!id) return send(res, 400, 'missing id');

  let src;
  try {
    src = await resolveSongUrl(id, level);
  } catch (err) {
    return send(res, 502, 'resolve failed: ' + err.message);
  }
  if (!src) return send(res, 404, '该歌曲没有可播放地址（可能需要登录或版权受限）');

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Referer: 'https://music.163.com/',
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetch(src, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) {
      return send(res, 502, '音频源返回 ' + upstream.status);
    }
    const outHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const len = upstream.headers.get('content-length');
    const range = upstream.headers.get('content-range');
    if (len) outHeaders['Content-Length'] = len;
    if (range) outHeaders['Content-Range'] = range;
    res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders);
    Readable.fromWeb(upstream.body).pipe(res);
    res.on('close', () => {
      try {
        if (upstream.body && !upstream.body.locked) upstream.body.cancel().catch(() => {});
      } catch {}
    });
  } catch (err) {
    log('音频转发失败:', err.message);
    if (!res.headersSent) send(res, 502, 'stream failed: ' + err.message);
  }
}

/** 同源转发封面等图片（WebGL 纹理需要同源/CORS） */
async function proxyCover(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//.test(target)) return send(res, 400, 'bad url');
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(buf);
  } catch (err) {
    send(res, 502, 'cover failed: ' + err.message);
  }
}

/** 静态文件 */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底
      const idx = path.join(WEB_DIR, 'index.html');
      return fs.readFile(idx, (e2, b2) =>
        e2 ? send(res, 404, 'not found') : send(res, 200, b2, { 'Content-Type': MIME['.html'] }),
      );
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    // 客户端提前断开 / 读文件出错，都不能让进程崩
    const bye = () => { try { stream.destroy(); } catch {} };
    res.on('close', bye);
    res.on('error', bye);
    stream.on('error', (e2) => {
      log('静态文件读取失败:', file, e2.message);
      bye();
      if (!res.headersSent) send(res, 500, 'read error');
      else try { res.end(); } catch {}
    });
    stream.pipe(res);
  });
}

/** 把 three 的源码目录（node_modules/three）以 /vendor/three/* 暴露给前端 importmap */
const VENDOR_ROOT = path.join(__dirname, 'node_modules', 'three');
const VENDOR_MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm' };

function serveVendor(req, res, url) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/vendor\/three\/?/, ''));
  const file = path.join(VENDOR_ROOT, path.normalize(rel || 'build/three.module.js'));
  if (!file.startsWith(VENDOR_ROOT)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'vendor not found: ' + rel);
    res.writeHead(200, {
      'Content-Type': VENDOR_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  });
}

fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/healthz') {
      return sendJson(res, 200, { ok: true, api: API_BASE, port: PORT });
    }
    if (p.startsWith('/vendor/three/')) return serveVendor(req, res, url);
    if (p.startsWith('/api/')) return void proxyApi(req, res, url);
    if (p === '/stream') return void proxyStream(req, res, url);
    if (p === '/cover') return void proxyCover(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    log('!! 请求处理异常:', err && err.stack ? err.stack.split('\n')[0] : err);
    try { if (!res.headersSent) send(res, 500, 'internal error'); else res.end(); } catch {}
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

server.listen(PORT, () => {
  log(`粒子播放器已启动:  http://localhost:${PORT}`);
  log(`网易云 API 服务:    ${API_BASE}`);
});
