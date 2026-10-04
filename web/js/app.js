/**
 * NEBULA 播放器逻辑
 * 数据：本地网易云 API（/api/*） · 音频：同源代理（/stream）
 * 视觉：scene.js 的 VisualEngine（频谱驱动）
 */
import { VisualEngine } from './scene.js';

const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const els = {
  boot: $('#boot'), list: $('#list'), panel: $('#panel'), panelTitle: $('#panelTitle'),
  panelToggle: $('#panelToggle'), q: $('#q'), searchForm: $('#searchForm'),
  cover: $('#cover'), coverBox: $('#coverBox'), title: $('#title'), artist: $('#artist'),
  play: $('#play'), icoPlay: $('#icoPlay'), icoPause: $('#icoPause'),
  prev: $('#prev'), next: $('#next'), bar: $('#bar'), fill: $('#fill'), knob: $('#knob'),
  cur: $('#cur'), dur: $('#dur'), vol: $('#vol'), mode: $('#mode'), level: $('#level'),
  vis: $('#vis'), toast: $('#toast'), lrcNow: $('#lyricNow'), lrcNext: $('#lyricNext'),
  acct: $('#acct'), acctText: $('#acctText'), loginMask: $('#loginMask'), loginClose: $('#loginClose'),
  qrBox: $('#qrBox'), qrStatus: $('#qrStatus'), acctInfo: $('#acctInfo'), logoutBtn: $('#logoutBtn'),
};

const LEVELS = [
  { k: 'standard', n: '标准' },
  { k: 'higher', n: '较高' },
  { k: 'exhigh', n: '极高' },
  { k: 'lossless', n: '无损', needLogin: true },
  { k: 'hires', n: '高解析度', needLogin: true },
];
const MODES = ['列表循环', '单曲循环', '随机'];

const state = {
  queue: [],
  index: -1,
  mode: 0,
  level: 2,
  lyrics: [],
  lrcIndex: -1,
  seeking: false,
  failedStreak: 0,
  ctx: null,
  analyser: null,
  source: null,
  current: null,
  loggedIn: false,
  account: null,
};

/* ----------------------------------------------------------- 小工具 */
let toastTimer;
function toast(msg, warn = false) {
  els.toast.textContent = msg;
  els.toast.className = 'toast show' + (warn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.className = 'toast'), 3200);
}

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

async function api(path) {
  const r = await fetch('/api' + path);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

/* ----------------------------------------------------------- 音频图 */
function initAudioGraph() {
  if (state.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.ctx = new Ctx();
  state.source = state.ctx.createMediaElementSource(audio);
  state.analyser = state.ctx.createAnalyser();
  state.analyser.fftSize = 2048;
  state.analyser.smoothingTimeConstant = 0.78;
  state.analyser.minDecibels = -92;
  state.analyser.maxDecibels = -12;
  state.source.connect(state.analyser);
  state.analyser.connect(state.ctx.destination);
  visual.setAnalyser(state.analyser);
}

/** 浏览器要求用户手势后才能出声 */
function resumeCtx() {
  initAudioGraph();
  if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
}

/* ----------------------------------------------------------- 视觉 */
const visual = new VisualEngine($('#stage'));
window.addEventListener('vis-mode', (e) => (els.vis.textContent = e.detail));
els.vis.addEventListener('click', () => {
  els.vis.textContent = visual.nextMode();
});

/* ----------------------------------------------------------- 列表渲染 */
function renderList(title, items, { highlightId } = {}) {
  els.panelTitle.textContent = title;
  els.list.innerHTML = '';
  if (!items.length) {
    els.list.innerHTML = '<div class="empty">没有结果<br/>换个关键词试试</div>';
    return;
  }
  items.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (highlightId && it.id === highlightId ? ' active' : '');
    div.dataset.id = it.id;
    div.dataset.i = i;
    const artists = (it.artists || []).join(' / ');
    div.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="txt">
        <span class="n">${escapeHtml(it.name)}</span>
        <span class="a">${escapeHtml(artists)}${it.album ? ' · ' + escapeHtml(it.album) : ''}</span>
      </span>
      ${it.tags ? it.tags.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('') : ''}
    `;
    div.addEventListener('dblclick', () => playIndex(i));
    div.addEventListener('click', (e) => {
      if (e.detail === 1) playIndex(i);
    });
    els.list.appendChild(div);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeSong(s) {
  // 搜索结果(type=1) 与 歌单条目 结构不同，统一一下
  if (s.ar || s.al) {
    return {
      id: s.id,
      name: s.name,
      artists: (s.ar || []).map((a) => a.name),
      album: s.al ? s.al.name : '',
      cover: s.al ? s.al.picUrl : '',
      duration: (s.dt || 0) / 1000,
      fee: s.fee,
    };
  }
  const ar = (s.artists || []).map((a) => a.name);
  return {
    id: s.id,
    name: s.name,
    artists: ar,
    album: s.album ? s.album.name : s.alg ? s.alg.name : '',
    cover: s.picUrl || '',
    duration: (s.duration || 0) / 1000,
    fee: s.fee,
  };
}

/* ----------------------------------------------------------- 播放 */
function playIndex(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  const song = state.queue[i];
  state.failedStreak = 0;
  resumeCtx();
  visual.clearCover();

  state.current = song;
  els.title.textContent = song.name;
  els.artist.textContent = song.artists.join(' / ') + (song.album ? ' · ' + song.album : '');
  els.cover.classList.remove('ok');
  if (song.cover) {
    const proxied = '/cover?url=' + encodeURIComponent(song.cover);
    els.cover.src = proxied;
    els.cover.onload = () => els.cover.classList.add('ok');
    visual.setCover(proxied);
  } else {
    visual.clearCover();
  }

  audio.src = `/stream?id=${song.id}&level=${LEVELS[state.level].k}`;
  audio.play().then(updatePlayIcon).catch((err) => {
    toast('播放失败：' + (err.message || err.name), true);
  });

  document.querySelectorAll('.item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.i) === i);
  });
  const active = document.querySelector('.item.active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  loadLyrics(song.id);
  updateMediaSession(song);
}

function updatePlayIcon() {
  const playing = !audio.paused;
  els.icoPlay.style.display = playing ? 'none' : 'block';
  els.icoPause.style.display = playing ? 'block' : 'none';
  els.coverBox.classList.toggle('spin', playing);
  visual.setPlaying(playing);
}

function nextAuto(dir = 1) {
  if (!state.queue.length) return;
  if (state.mode === 1) {           // 单曲循环
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let i;
  if (state.mode === 2) {           // 随机
    i = Math.floor(Math.random() * state.queue.length);
    if (state.queue.length > 1 && i === state.index) i = (i + 1) % state.queue.length;
  } else {
    i = (state.index + dir + state.queue.length) % state.queue.length;
  }
  playIndex(i);
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: song.artists.join(' / '),
      album: song.album || '',
      artwork: song.cover ? [{ src: '/cover?url=' + encodeURIComponent(song.cover), sizes: '512x512' }] : [],
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => nextAuto(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => nextAuto(1));
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  } catch {}
}

/* ----------------------------------------------------------- 歌词 */
async function loadLyrics(id) {
  state.lyrics = [];
  state.lrcIndex = -1;
  els.lrcNow.textContent = '';
  els.lrcNext.textContent = '';
  els.lrcNow.classList.remove('show');
  els.lrcNext.classList.remove('show');
  try {
    const j = await api(`/lyric?id=${id}`);
    const raw = (j.lrc && j.lrc.lyric) || '';
    const tl = (j.tlyric && j.tlyric.lyric) || '';
    const trans = parseLrc(tl);
    state.lyrics = parseLrc(raw).map((line) => ({
      ...line,
      text: trans.find((t) => Math.abs(t.time - line.time) < 0.35)?.text || line.text,
    }));
  } catch {
    /* 纯音乐或无歌词 */
  }
}

function parseLrc(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    const m = [...line.matchAll(/\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g)];
    if (!m.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const x of m) {
      out.push({ time: Number(x[1]) * 60 + Number(x[2]), text: content });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function tickLyrics() {
  if (!state.lyrics.length) return;
  const t = audio.currentTime;
  let lo = 0, hi = state.lyrics.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.lyrics[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx === state.lrcIndex) return;
  state.lrcIndex = idx;
  const cur = state.lyrics[idx];
  const nxt = state.lyrics[idx + 1];
  if (cur) {
    els.lrcNow.textContent = cur.text;
    els.lrcNow.classList.add('show');
  } else {
    els.lrcNow.textContent = state.current ? state.current.name : '';
    els.lrcNow.classList.add('show');
  }
  if (nxt) {
    els.lrcNext.textContent = nxt.text;
    els.lrcNext.classList.add('show');
  } else els.lrcNext.classList.remove('show');
}

/* ----------------------------------------------------------- 进度 / 音量 */
function tickProgress() {
  if (!state.seeking) {
    const d = audio.duration || state.current?.duration || 0;
    const c = audio.currentTime || 0;
    const pct = d ? Math.min(100, (c / d) * 100) : 0;
    els.fill.style.width = pct + '%';
    els.knob.style.left = pct + '%';
    els.cur.textContent = fmt(c);
    els.dur.textContent = fmt(d);
  }
}

function seekFromEvent(e) {
  const r = els.bar.getBoundingClientRect();
  const x = Math.min(Math.max(0, (e.touches ? e.touches[0].clientX : e.clientX) - r.left), r.width);
  const pct = x / r.width;
  const d = audio.duration;
  els.fill.style.width = pct * 100 + '%';
  els.knob.style.left = pct * 100 + '%';
  if (isFinite(d) && d > 0) els.cur.textContent = fmt(d * pct);
  return pct;
}

els.bar.addEventListener('pointerdown', (e) => {
  state.seeking = true;
  const pct = seekFromEvent(e);
  const move = (ev) => seekFromEvent(ev);
  const up = (ev) => {
    const p = seekFromEvent(ev);
    state.seeking = false;
    if (isFinite(audio.duration)) audio.currentTime = audio.duration * p;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

els.vol.addEventListener('input', () => {
  audio.volume = Number(els.vol.value);
});
audio.volume = Number(els.vol.value);

/* ----------------------------------------------------------- 控件事件 */
els.play.addEventListener('click', () => {
  if (!state.queue.length) return toast('先搜索并选一首歌');
  if (audio.paused) { resumeCtx(); audio.play().catch((e) => toast('播放失败：' + e.message, true)); }
  else audio.pause();
});
els.prev.addEventListener('click', () => nextAuto(-1));
els.next.addEventListener('click', () => nextAuto(1));

els.mode.addEventListener('click', () => {
  state.mode = (state.mode + 1) % 3;
  els.mode.textContent = MODES[state.mode];
  audio.loop = state.mode === 1;
});
els.level.addEventListener('click', () => {
  const next = (state.level + 1) % LEVELS.length;
  if (LEVELS[next].needLogin && !state.loggedIn) {
    toast('无损 / 高解析度需要登录网易云账号', true);
    openLogin();
    return;
  }
  state.level = next;
  els.level.textContent = LEVELS[state.level].n;
  if (state.current) reloadCurrent();
});

/** 用当前音质重新加载正在播放的曲目（保持进度） */
function reloadCurrent() {
  if (!state.current) return;
  const keep = audio.currentTime;
  const playing = !audio.paused;
  audio.src = `/stream?id=${state.current.id}&level=${LEVELS[state.level].k}`;
  audio.addEventListener(
    'loadedmetadata',
    () => {
      try { audio.currentTime = Math.min(keep, audio.duration || keep); } catch {}
      if (playing) audio.play().catch(() => {});
    },
    { once: true },
  );
}
els.panelToggle.addEventListener('click', () => {
  els.panel.classList.toggle('collapsed');
  els.panelToggle.textContent = els.panel.classList.contains('collapsed') ? '+' : '−';
});

audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('ended', () => {
  if (state.mode !== 1) nextAuto(1);
});
audio.addEventListener('error', () => {
  if (!audio.src) return;
  const msg = '这首歌暂无可用播放地址（可能版权受限/VIP），已跳过';
  toast(msg, true);
  state.failedStreak += 1;
  if (state.failedStreak <= 3 && state.queue.length > 1) setTimeout(() => nextAuto(1), 1200);
});

/* ----------------------------------------------------------- 搜索 */
els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const kw = els.q.value.trim();
  if (!kw) return;
  els.panel.classList.remove('collapsed');
  els.panelToggle.textContent = '−';
  els.list.innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const j = await api(`/search?keywords=${encodeURIComponent(kw)}&type=1&limit=30`);
    const songs = (j.result?.songs || []).map(normalizeSong);
    state.queue = songs;
    renderList(`搜索：${kw}`, songs);
    if (songs.length) toast(`找到 ${songs.length} 首，点击播放`);
    else toast('没有找到相关歌曲', true);
  } catch (err) {
    els.list.innerHTML = '<div class="empty">搜索失败：API 服务没起来？</div>';
    toast('搜索失败：' + err.message, true);
  }
});

/* ----------------------------------------------------------- 扫码登录 */
let qrTimer = null;

async function refreshAccount() {
  try {
    const j = await api('/login/status');
    applyAccount(j.logged ? j.profile : null, j.account);
  } catch {
    applyAccount(null, null);
  }
}

function applyAccount(profile, account) {
  state.loggedIn = !!(profile && profile.userId);
  state.account = profile || null;
  const vip = (profile && profile.vipType) || (account && account.vipType) || 0;
  els.acct.classList.toggle('on', state.loggedIn);
  if (state.loggedIn) {
    const av = profile.avatarUrl ? `<img src="${profile.avatarUrl}" alt="">` : '';
    const badge = vip > 0 ? '<span class="vip">VIP</span>' : '';
    els.acct.innerHTML = `${av}<span class="acct-dot"></span><span>${escapeHtml(profile.nickname || '已登录')}</span>${badge}`;
  } else {
    els.acct.innerHTML = '<span class="acct-dot"></span><span>未登录</span>';
  }
  // 弹层里的账号信息
  if (state.loggedIn) {
    els.acctInfo.innerHTML =
      `<div>${escapeHtml(profile.nickname || '')} ${vip > 0 ? '<span class="vip">VIP</span>' : ''}</div>` +
      `<div class="sub">UID ${profile.userId} · 音质上限 ${vip > 0 ? '无损 / 高解析度' : '极高'}</div>`;
    els.logoutBtn.style.display = 'inline-block';
    els.qrBox.innerHTML = profile.avatarUrl ? `<img src="${profile.avatarUrl}" alt="头像">` : '<div class="qr-loading">已登录</div>';
    els.qrStatus.className = 'qr-status ok';
    els.qrStatus.textContent = '已登录';
  } else {
    els.acctInfo.innerHTML = '';
    els.logoutBtn.style.display = 'none';
  }
}

function openLogin() {
  els.loginMask.classList.add('show');
  if (state.loggedIn) return;      // 已登录：直接展示账号信息
  loadQr();
}

async function loadQr() {
  clearInterval(qrTimer);
  els.qrBox.innerHTML = '<div class="qr-loading">正在取二维码…</div>';
  els.qrStatus.className = 'qr-status';
  els.qrStatus.textContent = '等待扫码';
  try {
    const j = await api('/login/qr');
    if (!j.ok) throw new Error(j.error || '取二维码失败');
    els.qrBox.innerHTML = `<img alt="登录二维码" src="${j.img}">`;
    const key = j.key;
    qrTimer = setInterval(async () => {
      try {
        const r = await api('/login/qr/check?key=' + encodeURIComponent(key));
        if (r.code === 803) {
          clearInterval(qrTimer);
          els.qrStatus.className = 'qr-status ok';
          els.qrStatus.textContent = '登录成功';
          applyAccount(r.profile, r.account);
          const nick = (r.profile && r.profile.nickname) || '';
          const isVip = ((r.profile && r.profile.vipType) || 0) > 0;
          toast(`已登录：${nick}${isVip ? ' · 黑胶VIP' : ''}（可切无损音质了）`);
          setTimeout(() => els.loginMask.classList.remove('show'), 1200);
          if (state.current) reloadCurrent();     // 之前因版权/VIP 失败的曲目现在能放了
        } else if (r.code === 802) {
          els.qrStatus.textContent = '已扫码，请在手机上确认';
        } else if (r.code === 800) {
          els.qrStatus.className = 'qr-status bad';
          els.qrStatus.textContent = '二维码已过期，正在刷新…';
          loadQr();
        } else {
          els.qrStatus.textContent = '等待扫码';
        }
      } catch {
        /* 网络抖动就继续轮询 */
      }
    }, 2200);
  } catch (err) {
    els.qrBox.innerHTML = '<div class="qr-loading">二维码获取失败</div>';
    els.qrStatus.className = 'qr-status bad';
    els.qrStatus.textContent = err.message;
  }
}

els.acct.addEventListener('click', openLogin);
els.loginClose.addEventListener('click', () => {
  clearInterval(qrTimer);
  els.loginMask.classList.remove('show');
});
els.loginMask.addEventListener('click', (e) => {
  if (e.target === els.loginMask) {
    clearInterval(qrTimer);
    els.loginMask.classList.remove('show');
  }
});
els.logoutBtn.addEventListener('click', async () => {
  try {
    await api('/logout');
  } catch {}
  state.loggedIn = false;
  state.account = null;
  applyAccount(null, null);
  els.qrStatus.textContent = '已退出登录';
  toast('已退出登录');
  loadQr();
});

/* ----------------------------------------------------------- 首屏推荐 */
async function boot() {
  refreshAccount();                 // 先看有没有登录态
  try {
    const j = await api('/playlist/detail?id=3778678');   // 热歌榜
    const tracks = (j.playlist?.tracks || []).slice(0, 40).map(normalizeSong);
    if (tracks.length) {
      state.queue = tracks;
      renderList('热歌榜（点击播放）', tracks);
    }
  } catch {
    els.list.innerHTML = '<div class="empty">API 未就绪<br/>请确认 3000 端口的网易云 API 已启动</div>';
  } finally {
    setTimeout(() => els.boot.classList.add('hide'), 400);
  }
}

/* ----------------------------------------------------------- 键盘 */
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); els.play.click(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) nextAuto(1);
  else if (e.code === 'ArrowLeft' && e.shiftKey) nextAuto(-1);
  else if (e.code === 'ArrowRight') audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(audio.currentTime - 5, 0);
  else if (e.code === 'ArrowUp') { e.preventDefault(); els.vol.value = Math.min(1, Number(els.vol.value) + 0.05); audio.volume = Number(els.vol.value); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); els.vol.value = Math.max(0, Number(els.vol.value) - 0.05); audio.volume = Number(els.vol.value); }
  else if (e.key === 'f' || e.key === 'F') els.q.focus();
  else if (e.key === 'v' || e.key === 'V') document.getElementById('vis').click();
});

/* ----------------------------------------------------------- 帧循环 */
function frame() {
  requestAnimationFrame(frame);
  tickProgress();
  tickLyrics();
}
frame();

updatePlayIcon();
boot();

// 方便调试
window.__ncm = { state, audio, visual };
