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

/* ------------------------------------------------------------------
   登录凭据（MUSIC_U cookie）
   存本地文件、不进 git、日志里一律脱敏；只在服务端与网易云之间使用。
   ------------------------------------------------------------------ */
const COOKIE_FILE = path.join(__dirname, '.cookie');
const readCookie = () => { try { return fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch { return ''; } };
const writeCookie = (c) => { try { fs.writeFileSync(COOKIE_FILE, String(c).trim(), { mode: 0o600 }); } catch (e) { log('cookie 保存失败:', e.message); } };
const dropCookie = () => { try { fs.unlinkSync(COOKIE_FILE); } catch {} };

/** 给 API 请求带上已登录的 cookie（除非调用方自己传了） */
function withCookie(pathQ) {
  const c = readCookie();
  if (!c || /[?&]cookie=/.test(pathQ)) return pathQ;
  return pathQ + (pathQ.includes('?') ? '&' : '?') + 'cookie=' + encodeURIComponent(c);
}

/** 日志脱敏：cookie=xxx 一律替换成 cookie=*** */
const redact = (s) => String(s).replace(/cookie=[^&\s]*/gi, 'cookie=***');

async function apiGet(pathQ) {
  const r = await fetch(API_BASE + withCookie(pathQ), { headers: { accept: 'application/json' } });
  return r.json();
}

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

/** 转发 /api/* 到网易云 API 服务（自动带登录 cookie） */
async function proxyApi(req, res, url) {
  const target = API_BASE + withCookie(url.pathname.replace(/^\/api/, '') + (url.search || ''));
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
    log('API 代理失败:', redact(target), err.message);
    sendJson(res, 502, { ok: false, error: '网易云 API 服务不可达: ' + err.message });
  }
}

/** 取歌曲真实播放地址 + 格式（带登录 cookie 才有高音质/VIP） */
async function resolveSong(id, level = 'exhigh') {
  const target = `${API_BASE}/song/url/v1?id=${encodeURIComponent(id)}&level=${level}`;
  const r = await fetch(withCookie(target));
  const j = await r.json();
  const item = Array.isArray(j.data) ? j.data[0] : null;
  if (!item || !item.url) return null;
  // level 是 flac 时网易云可能回落成 mp3，所以以返回的 url 后缀为准
  const guess = (item.type || '').toLowerCase() || (item.url.match(/\.(flac|mp3|m4a|aac)(?:\?|$)/i) || [])[1] || '';
  return { url: item.url, type: guess.toLowerCase(), br: item.br || 0, size: item.size || 0 };
}

const AUDIO_MIME = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  ape: 'audio/x-ape',
};

/** 取 MV 真实地址（带登录 cookie 才有高清/VIP 的 MV） */
async function resolveMv(id) {
  const r = await fetch(withCookie(`${API_BASE}/mv/url?id=${encodeURIComponent(id)}&r=1080`));
  const j = await r.json();
  return (j && j.data && j.data.url) || null;
}

/** 转发 MV 视频流：必须同源，否则前端 canvas 取像素会被污染（做不出视频粒子） */
async function proxyMv(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id) return send(res, 400, 'missing id');
  let src;
  try {
    src = await resolveMv(id);
  } catch (err) {
    return send(res, 502, 'mv resolve failed: ' + err.message);
  }
  if (!src) return send(res, 404, 'no mv url');

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Referer: 'https://music.163.com/',
    Accept: '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetch(src, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return send(res, 502, 'mv source ' + upstream.status);
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const out = {
      'Content-Type': ct.includes('mp4') || ct.includes('video') ? 'video/mp4' : 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const len = upstream.headers.get('content-length');
    const range = upstream.headers.get('content-range');
    if (len) out['Content-Length'] = len;
    if (range) out['Content-Range'] = range;
    res.writeHead(upstream.status === 206 ? 206 : 200, out);
    Readable.fromWeb(upstream.body).pipe(res);
    res.on('close', () => {
      try {
        if (upstream.body && !upstream.body.locked) upstream.body.cancel().catch(() => {});
      } catch {}
    });
  } catch (err) {
    log('MV 转发失败:', err.message);
    if (!res.headersSent) send(res, 502, 'mv failed: ' + err.message);
  }
}

/** 把远端音频流按 Range 转发给浏览器（带上网易云要求的 Referer） */
async function proxyStream(req, res, url) {
  const id = url.searchParams.get('id');
  const level = url.searchParams.get('level') || 'exhigh';
  if (!id) return send(res, 400, 'missing id');

  let info;
  try {
    info = await resolveSong(id, level);
  } catch (err) {
    return send(res, 502, 'resolve failed: ' + err.message);
  }
  if (!info) return send(res, 404, '该歌曲没有可播放地址（可能需要登录或版权受限）');
  const src = info.url;

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
      // 网易云 CDN 对 flac 也会报 audio/mpeg，这里按实际格式纠正，否则浏览器可能拒播
      'Content-Type': AUDIO_MIME[info.type] || upstream.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Audio-Type': info.type || '',
      'X-Audio-Bitrate': String(info.br || ''),
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

/* ------------------------------------------------------------------
   扫码登录接口
   /api/login/qr        取二维码（返回 key + base64 图）
   /api/login/qr/check  轮询扫码结果；成功则保存 cookie 并返回账号信息
   /api/login/status    当前登录状态（昵称 / VIP / 音质等级）
   /api/logout          退出登录（删本地 cookie）
   ------------------------------------------------------------------ */
async function handleAuth(req, res, url, p) {
  try {
    if (p === '/api/login/qr') {
      const keyJ = await apiGet('/login/qr/key?timestamp=' + Date.now());
      const key = keyJ && keyJ.data && keyJ.data.unikey;
      if (!key) return sendJson(res, 502, { ok: false, error: '拿不到二维码 key（API 服务在跑吗？）' });
      const qrJ = await apiGet(`/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&timestamp=${Date.now()}`);
      const d = (qrJ && qrJ.data) || {};
      return sendJson(res, 200, { ok: true, key, img: d.qrimg || '', url: d.qrurl || '' });
    }

    if (p === '/api/login/qr/check') {
      const key = url.searchParams.get('key');
      if (!key) return sendJson(res, 400, { ok: false, error: 'missing key' });
      const j = await apiGet(`/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`);
      // 800 二维码过期 / 801 等待扫码 / 802 待确认 / 803 授权成功
      if (j.code === 803) {
        if (j.cookie) writeCookie(j.cookie);
        const st = await apiGet('/login/status?timestamp=' + Date.now());
        const d = (st && st.data) || {};
        log('登录成功:', (d.profile && d.profile.nickname) || '(未知用户)');
        return sendJson(res, 200, { ok: true, code: 803, profile: d.profile || null, account: d.account || null });
      }
      return sendJson(res, 200, { ok: true, code: j.code, message: j.message || '' });
    }

    if (p === '/api/login/status') {
      if (!readCookie()) return sendJson(res, 200, { ok: true, logged: false });
      const st = await apiGet('/login/status?timestamp=' + Date.now());
      const d = (st && st.data) || {};
      const profile = d.profile || null;
      return sendJson(res, 200, {
        ok: true,
        logged: !!(profile && profile.userId),
        profile,
        account: d.account || null,
      });
    }

    if (p === '/api/logout') {
      dropCookie();
      log('已退出登录（本地 cookie 已删除）');
      return sendJson(res, 200, { ok: true });
    }

    // 我的歌单（含"我喜欢的音乐"），登录后才可用
    if (p === '/api/me/playlists') {
      if (!readCookie()) return sendJson(res, 200, { ok: false, logged: false, playlists: [] });
      const st = await apiGet('/login/status?timestamp=' + Date.now());
      const uid = st && st.data && st.data.profile && st.data.profile.userId;
      if (!uid) return sendJson(res, 200, { ok: false, logged: false, playlists: [] });
      const j = await apiGet(`/user/playlist?uid=${uid}&limit=100&timestamp=${Date.now()}`);
      const list = ((j && j.playlist) || []).map((pl) => ({
        id: pl.id,
        name: pl.name,
        cover: pl.coverImgUrl,
        count: pl.trackCount,
        creator: (pl.creator && pl.creator.nickname) || '',
        subscribed: !!pl.subscribed,
      }));
      const liked = list.find((x) => x.name.includes('喜欢的音乐'));
      return sendJson(res, 200, { ok: true, logged: true, uid, liked: liked || null, playlists: list });
    }
  } catch (err) {
    log('登录接口异常:', err.message);
    if (!res.headersSent) return sendJson(res, 502, { ok: false, error: err.message });
  }
}

fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

/* --------------------------------------------------------- 开发用：画面回传
   探针 (?probe=1) 会把当前 canvas 的 PNG dataURL POST 到这里，存成 shots/latest.png，
   方便直接看渲染结果（不用靠猜）。仅本机使用。 */
function handleShot(req, res, url) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 16e6) req.destroy(); });
  req.on('end', () => {
    try {
      const m = /^data:image\/png;base64,(.+)$/.exec(body.trim());
      if (!m) { sendJson(res, 400, { ok: false, err: 'expect png data url' }); return; }
      const dir = path.join(__dirname, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const buf = Buffer.from(m[1], 'base64');
      const tag = (url.searchParams.get('tag') || 'latest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'latest';
      fs.writeFileSync(path.join(dir, tag + '.png'), buf);
      if (tag !== 'latest') fs.writeFileSync(path.join(dir, 'latest.png'), buf);
      sendJson(res, 200, { ok: true, bytes: buf.length });
    } catch (e) {
      sendJson(res, 500, { ok: false, err: e.message });
    }
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/healthz') {
      return sendJson(res, 200, { ok: true, api: API_BASE, port: PORT });
    }
    if (p.startsWith('/vendor/three/')) return serveVendor(req, res, url);
    if (p.startsWith('/api/login/') || p === '/api/logout' || p === '/api/me/playlists') {
      return void handleAuth(req, res, url, p);
    }
    if (p.startsWith('/api/')) return void proxyApi(req, res, url);
    if (p === '/stream') return void proxyStream(req, res, url);
    if (p === '/mv') return void proxyMv(req, res, url);
    if (p === '/cover') return void proxyCover(req, res, url);
    if (p === '/__shot' && req.method === 'POST') return void handleShot(req, res, url);
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
