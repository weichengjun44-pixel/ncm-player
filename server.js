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
const { PROVIDERS, setAuth, getAuth } = require('./sources');

const PORT = Number(process.env.PORT || 8080);
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
// 可写数据根目录：桌面版由主进程通过 NCM_DATA_DIR 指到 D 盘（打包后安装目录只读）
// 开发时就是项目根，行为不变
const DATA_ROOT = process.env.NCM_DATA_DIR || __dirname;
// 静态资源根：桌面版可能从 asar/资源目录提供
const WEB_DIR = process.env.NCM_WEB_DIR || path.join(__dirname, 'web');

const MIME = {
  // .webmanifest 必须给正确类型：Chrome 对清单的 MIME 是硬校验，
  // 返回 application/octet-stream 会直接拒绝清单 → "添加到主屏幕"失效
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // 安卓安装包：不给对类型的话手机浏览器可能不让下载
  '.apk': 'application/vnd.android.package-archive',
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
const COOKIE_FILE = path.join(DATA_ROOT, '.cookie');
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

  // 网易云 CDN 对 flac 也会报 audio/mpeg，按实际格式纠正，否则浏览器可能拒播
  return void pipeMedia(req, res, src, AUDIO_MIME[info.type], {
    referer: 'https://music.163.com/',
    extraHeaders: { 'X-Audio-Type': info.type || '', 'X-Audio-Bitrate': String(info.br || '') },
  });
}

/** 抓上游媒体（音频/视频）并转发，带 Range 支持。网易云与 QQ/酷狗 共用这一份。 */
async function pipeMedia(req, res, src, mime, opts) {
  const o = opts || {};
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Referer: o.referer || 'https://music.163.com/',
    Accept: '*/*',
    ...(o.extraHeaders || {}),
  };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetch(src, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) {
      return send(res, 502, '媒体源返回 ' + upstream.status);
    }
    const outHeaders = {
      'Content-Type': mime || upstream.headers.get('content-type') || 'audio/mpeg',
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
    log('媒体转发失败:', err.message);
    if (!res.headersSent) send(res, 502, 'stream failed: ' + err.message);
  }
}

/* --------------------------------------------------- 多音源（QQ / 酷狗）
   设计：把 QQ/酷狗 的数据在中间层翻译成"网易云的数据结构"再返回。
   这样前端（搜索列表、播放、歌词、粒子封面）整套逻辑不用分叉——
   比让前端判断每个源要可靠得多，也正好符合"效果和接入网易云一样"的目标。

   已知限制：QQ/酷狗的**原版付费曲**取不到流（会返回明确的业务错误，前端提示换一首），
   翻唱 / Live / 版本曲可以；MV 暂未接入（QQ 的 MV 模块名未探通、酷狗是 m3u8 需 hls.js）。 */

const sourceOf = function (url) {
  return String(url.searchParams.get('source') || 'netease').toLowerCase();
};

/* ---------------------------------------------- 分音源登录 Cookie（QQ / 酷狗）
   为什么要单独存：这两家的播放密钥/登录态都在 Cookie 里（QQ 是 qqmusic_key、酷狗是 token），
   拿到之后 VIP 曲才取得到流。存放位置 D 盘项目根目录、带 source 后缀，且不进 git。 */
const AUTH_SOURCES = ['qq', 'kugou'];

/** 粘贴容错：DevTools 里能复制出来的几种形态都吃下，别让人因为多了个换行/引号而反复失败 */
function normalizeCookie(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^cookie\s*:\s*/i, '');            // 整行 "Cookie: a=b; c=d"
  s = s.replace(/^["'`]+|[\s*"'`]+$/g, '');        // 外层引号/反引号
  if (/^[[{]/.test(s)) {                           // JSON（DevTools 复制为 JSON / 扩展导出）
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) {
        s = j.filter((x) => x && x.name).map((x) => x.name + '=' + x.value).join('; ');
      } else if (j && typeof j === 'object') {
        s = Object.entries(j).map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join('; ');
      }
    } catch {}
  }
  // DevTools 里选中 Cookie 表格多行 Ctrl+C 出来是制表符分隔：name<TAB>value<TAB>domain...
  // 这一步不处理的话会拼成一条畸形的超长 Cookie，让人以为"粘贴没生效"
  if (/\t/.test(s)) {
    const pairs = [];
    for (const line of s.split(/[\r\n]+/)) {
      const parts = line.split('\t');
      if (parts.length >= 2 && parts[0].trim()) pairs.push(parts[0].trim() + '=' + parts[1].trim());
    }
    if (pairs.length) s = pairs.join('; ');
  }
  s = s.replace(/[\r\n]+/g, '; ');                 // 多行 → 单行
  s = s.split(';').map((x) => x.trim()).filter(Boolean).join('; ');
  return s;
}

/** 各源真正管用的键（用于判断"这段 Cookie 里有没有播放入口要的东西"） */
const AUTH_KEYS = {
  qq: ['qqmusic_key', 'qm_keyst', 'uin', 'skey', 'p_skey'],
  kugou: ['token', 'userid', 'user_id', 'vip_type', 'kg_mid', 'dfid'],
};
const authFile = (src) => path.join(DATA_ROOT, '.cookie-' + src);

function loadAuthCookies() {
  for (const src of AUTH_SOURCES) {
    try {
      const c = fs.readFileSync(authFile(src), 'utf8').trim();
      if (c) { setAuth(src, c); log('已载入 ' + src + ' 登录 Cookie (' + c.length + ' 字符)'); }
    } catch {}
  }
}

/** 用 VIP 曲实测这个 Cookie 到底管不管用 —— 比"保存成功"有意义得多 */
async function verifyAuth(src) {
  const prov = PROVIDERS[src];
  const probe = { qq: { kw: '晴天', label: '晴天(原版)' }, kugou: { kw: '晴天', label: '晴天(原版)' } }[src];
  const songs = await prov.search(probe.kw, 1, 8);
  const target = songs.find((x) => src === 'qq' ? x._pay : true) || songs[0];
  if (!target) return { ok: false, msg: '拿不到测试曲目' };
  try {
    const r = await prov.songUrl(target.id);
    return { ok: true, msg: '有效：VIP 测试曲《' + target.name + '》已可取流', sample: String(r.url).slice(0, 60) };
  } catch (e) {
    return { ok: false, msg: '无效：VIP 测试曲《' + target.name + '》仍然取不到（' + e.message + '）' };
  }
}

async function handleAuthSource(req, res, url, src) {
  if (!AUTH_SOURCES.includes(src)) return sendJson(res, 400, { error: '该音源不需要登录 Cookie' });
  if (req.method === 'GET') {
    const c = getAuth(src);
    return sendJson(res, 200, {
      source: src, set: !!c, length: c.length,
      // 只回显键名，不回显值——Cookie 等同密码，不该在接口里来回传
      keys: c ? c.split(';').map((x) => x.split('=')[0].trim()).filter(Boolean) : [],
    });
  }
  if (req.method === 'DELETE') {
    try { fs.unlinkSync(authFile(src)); } catch {}
    setAuth(src, '');
    return sendJson(res, 200, { ok: true, cleared: true });
  }
  if (req.method === 'POST') {
    let body = '';
    await new Promise((resolve) => {
      req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', resolve);
      req.on('error', resolve);
    });
    let cookie = body.trim();
    try { const j = JSON.parse(body); if (j && typeof j.cookie === 'string') cookie = j.cookie; } catch {}
    cookie = normalizeCookie(cookie);
    if (!cookie) return sendJson(res, 400, { ok: false, msg: 'Cookie 是空的' });
    const keys = cookie.split(';').map((x) => x.split('=')[0].trim()).filter(Boolean);
    const want = AUTH_KEYS[src] || [];
    const hit = want.filter((k) => keys.includes(k));
    if (src === 'qq' && !keys.includes('qqmusic_key') && !keys.includes('qm_keyst')) {
      return sendJson(res, 200, {
        ok: false, source: src, keys,
        msg: '这段 Cookie 里没有 qqmusic_key（QQ 音乐的播放密钥），可能是从 qq.com 而不是 y.qq.com 复制的，或者没登录成功',
      });
    }
    if (src === 'kugou' && !keys.includes('token')) {
      return sendJson(res, 200, {
        ok: false, source: src, keys,
        msg: '这段 Cookie 里没有 token（酷狗的登录凭证），请在已登录的 www.kugou.com 上复制',
      });
    }
    setAuth(src, cookie);
    let v;
    try { v = await verifyAuth(src); } catch (e) { v = { ok: false, msg: '校验出错：' + e.message }; }
    if (v.ok) {
      try { fs.writeFileSync(authFile(src), cookie, { mode: 0o600 }); } catch (e) { log('cookie 落盘失败: ' + e.message); }
      redactLog('[' + src + '] 登录 Cookie 校验通过并已保存');
    } else {
      setAuth(src, '');   // 校验不过就不留，避免"看着登录了其实没用"
      redactLog('[' + src + '] 登录 Cookie 校验失败：' + v.msg);
    }
    return sendJson(res, 200, { ok: v.ok, msg: v.msg, source: src, keys, matched: hit });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

function redactLog(msg) {
  log(String(msg).replace(/cookie[:=]\s*[^\s]+/gi, 'cookie=***'));
}

async function handleSource(req, res, url, src) {
  const p = url.pathname;
  const prov = PROVIDERS[src];
  if (!prov) return sendJson(res, 400, { error: 'unknown source: ' + src });
  try {
    if (p === '/api/search') {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Number(url.searchParams.get('limit') || 30);
      const songs = await prov.search(kw, 1, limit);
      return sendJson(res, 200, { result: { songs, songCount: songs.length }, source: src });
    }
    if (p === '/api/lyric') {
      const id = url.searchParams.get('id');
      const duration = url.searchParams.get('duration') || 0;
      const l = await prov.lyric(id, duration);
      return sendJson(res, 200, {
        lrc: { lyric: l.lrc }, tlyric: { lyric: l.trans || '' },
        source: src, hasTimeTag: l.hasTimeTag,
      });
    }
    if (p === '/api/playlist/detail') {
      const id = url.searchParams.get('id') || (src === 'qq' ? '26' : '8888');
      const tracks = await prov.chart(id, 60);
      const nm = src === 'qq' ? 'QQ 音乐 · 榜单' : '酷狗 · 榜单';
      return sendJson(res, 200, {
        playlist: {
          id: String(id), name: nm + ' ' + id, tracks, trackCount: tracks.length,
          coverImgUrl: (tracks[0] && tracks[0].al && tracks[0].al.picUrl) || '',
        },
        source: src,
      });
    }
  } catch (e) {
    log('[' + src + '] ' + p + ' 失败: ' + e.message);
    return sendJson(res, 502, { error: e.message, source: src });
  }
  return sendJson(res, 404, { error: 'not found', source: src });
}

/** QQ/酷狗 取流：先解析真实直链，再走同一套转发。
    注意它们是**有时效的签名直链**，必须每次现取，不能缓存。 */
async function streamFromSource(req, res, url, src) {
  const id = url.searchParams.get('id');
  if (!id) return send(res, 400, 'missing id');
  const prov = PROVIDERS[src];
  try {
    const info = await prov.songUrl(id);
    return void pipeMedia(req, res, info.url, info.mime, {
      referer: src === 'qq' ? 'https://y.qq.com/' : 'https://www.kugou.com/',
    });
  } catch (e) {
    // 付费/版权受限走这里：把原因原样告诉前端，前端好提示"换一首"
    log('[' + src + '] 取流失败: ' + e.message);
    return send(res, 502, e.message);
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
      const dir = path.join(DATA_ROOT, 'shots');
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
    // 手机端没有控制台：前端 boot.js 把错误 POST 到这里，落到日志里便于排查
    // （桌面端有 DevTools，这块是专门为手机/平板准备的）
    if (req.method === 'POST' && p === '/__boot') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch (e) {}
        const nl = String.fromCharCode(10);
        const line = '[前端] ' + new Date().toLocaleString('zh-CN') + ' ' + (j.kind || '?')
          + ' | 卡在: ' + (j.stage || '-') + ' | 耗时 ' + (j.t || 0) + 'ms | webgl2=' + j.gl2
          + ' | 屏幕 ' + (j.screen || '-') + ' dpr=' + (j.dpr || '-')
          + nl + '         ' + (j.msg || '')
          + (j.extra ? nl + '         extra=' + JSON.stringify(j.extra) : '')
          + (j.ua ? nl + '         UA: ' + j.ua : '');
        console.log(line);
        try { fs.appendFileSync(path.join(DATA_ROOT, 'client.log'), line + nl); } catch (e) {}
      });
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    if (p.startsWith('/vendor/three/')) return serveVendor(req, res, url);
    if (p.startsWith('/api/login/') || p === '/api/logout' || p === '/api/me/playlists') {
      return void handleAuth(req, res, url, p);
    }
    if (p === '/api/sources') {
      return sendJson(res, 200, {
        sources: [
          { id: 'netease', name: '网易云音乐' },
          { id: 'qq', name: 'QQ 音乐' },
          { id: 'kugou', name: '酷狗音乐' },
        ],
      });
    }
    if (p === '/api/source/auth') {
      return void handleAuthSource(req, res, url, sourceOf(url));
    }
    // 非网易云的源在中间层直接处理（网易云那套照旧走 3000 端口的 API 服务）
    if (sourceOf(url) !== 'netease'
        && (p === '/api/search' || p === '/api/lyric' || p === '/api/playlist/detail')) {
      return void handleSource(req, res, url, sourceOf(url));
    }
    if (p === '/stream') {
      if (sourceOf(url) !== 'netease') return void streamFromSource(req, res, url, sourceOf(url));
      return void proxyStream(req, res, url);
    }
    if (p.startsWith('/api/')) return void proxyApi(req, res, url);
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

loadAuthCookies();

server.listen(PORT, () => {
  log(`粒子播放器已启动:  http://localhost:${PORT}`);
  log(`网易云 API 服务:    ${API_BASE}`);
});
