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
  panelToggle: $('#panelToggle'), panelPeek: $('#panelPeek'), q: $('#q'), searchForm: $('#searchForm'),
  cover: $('#cover'), coverBox: $('#coverBox'), title: $('#title'), artist: $('#artist'),
  play: $('#play'), icoPlay: $('#icoPlay'), icoPause: $('#icoPause'),
  prev: $('#prev'), next: $('#next'), bar: $('#bar'), fill: $('#fill'), knob: $('#knob'),
  cur: $('#cur'), dur: $('#dur'), vol: $('#vol'), mode: $('#mode'), level: $('#level'),
  vis: $('#vis'), reset: $('#reset'), dbg: $('#dbg'), toast: $('#toast'),
  lrcNow: $('#lyricNow'), lrcPrev: $('#lyricPrev'),
  tabMine: $('#tabMine'), tabSearch: $('#tabSearch'), panelSub: $('#panelSub'),
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
els.reset.addEventListener('click', () => {
  visual.resetView();
  toast('视角已复位（画面里拖动可 360° 环绕，滚轮推拉）');
});

/* ----------------------------------------------------------- 列表渲染 */
function renderList(title, items, { highlightId } = {}) {
  if (els.panelSub) els.panelSub.textContent = title;
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
  visual.clearLyricParticles();     // 换歌：旧歌词粒子散掉
  els.title.textContent = song.name;
  els.artist.textContent = song.artists.join(' / ') + (song.album ? ' · ' + song.album : '');
  els.cover.classList.remove('ok');
  if (song.cover) {
    const proxied = '/cover?url=' + encodeURIComponent(song.cover);
    els.cover.src = proxied;
    els.cover.onload = () => els.cover.classList.add('ok');
    // 封面 → 粒子：同源代理后取像素，采样成上万颗粒子
    visual.setCoverToParticles(proxied).catch((e) => console.warn('封面粒子化失败', e));
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
  loadMv(song.id);              // 有 MV 就挂到封面后面当粒子背景
}

function updatePlayIcon() {
  const playing = !audio.paused;
  els.icoPlay.style.display = playing ? 'none' : 'block';
  els.icoPause.style.display = playing ? 'block' : 'none';
  els.coverBox.classList.toggle('spin', playing);
  visual.setPlaying(playing);
  visual.setVideoPlaying(playing);      // MV 粒子幕跟音频一起播/停
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

/* ----------------------------------------------------------- MV（视频粒子背景） */
let mvNoticeShown = false;

async function loadMv(songId) {
  if (!visual.detachVideo) return;
  visual.detachVideo();
  try {
    const d = await api(`/song/detail?ids=${songId}`);
    const mvid = d?.songs?.[0]?.mv;
    if (!mvid) return;                                   // 这首歌没有 MV
    const u = await api(`/mv/url?id=${mvid}&r=1080`);
    if (!u?.data?.url) return;                           // 取不到地址（VIP/版权/地区）
    visual.attachVideo(`/mv?id=${mvid}`);                // 同源转发流 → 粒子幕
    if (!mvNoticeShown) {
      mvNoticeShown = true;
      toast('这首歌有 MV：正在封面后面用粒子播放（拖动画面能看到它）');
    }
  } catch {
    /* 没有 MV 是常态，静默处理 */
  }
}

/* ----------------------------------------------------------- 歌词 */
async function loadLyrics(id) {
  state.lyrics = [];
  state.lrcIndex = -1;
  els.lrcNow.textContent = '';
  els.lrcNow.classList.remove('show');
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
  const prev = idx > 0 ? state.lyrics[idx - 1] : null;

  // 当前这句交给空间里的粒子去显示
  const line = cur ? cur.text : (state.current ? state.current.name : '');
  visual.setLyricParticles(line);

  // 歌词全部交给空间里的粒子显示；DOM 只在粒子没生成出来时兜底，避免黑框/重复
  const particleOk = (visual.lyricPoints || 0) > 0;
  els.lrcPrev.textContent = '';
  if (particleOk) {
    els.lrcNow.textContent = '';
    els.lrcNow.classList.remove('show');
  } else {
    els.lrcNow.textContent = line;
    els.lrcNow.classList.add('show');
  }
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

els.panelPeek.addEventListener('click', () => {
  els.panel.classList.remove('collapsed');
  els.panelToggle.textContent = '−';
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
  els.tabSearch.classList.add('active');
  els.tabMine.classList.remove('active');
  state.tab = 'search';
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
    const av = profile.avatarUrl ? `<img src="/cover?url=${encodeURIComponent(profile.avatarUrl)}" alt="" onerror="this.style.display='none'">` : '';
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
    els.qrBox.innerHTML = profile.avatarUrl
      ? `<img src="/cover?url=${encodeURIComponent(profile.avatarUrl)}" alt="头像" onerror="this.replaceWith(document.createTextNode('已登录'))">`
      : '<div class="qr-loading">已登录</div>';
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
          if (state.tab === 'mine') loadMyPlaylists();   // 正在看"我的音乐"就刷新
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

/* ----------------------------------------------------------- 我的音乐（歌单） */
async function loadMyPlaylists() {
  els.list.innerHTML = '<div class="empty">读取你的歌单…</div>';
  els.panelSub.textContent = '';
  try {
    const j = await api('/me/playlists');
    if (!j.logged) {
      els.list.innerHTML = '<div class="empty">还没登录网易云<br/><br/>点右上角「未登录」扫码<br/>就能看到你的歌单和「我喜欢的音乐」</div>';
      return;
    }
    state.playlists = j.playlists || [];
    if (!state.playlists.length) {
      els.list.innerHTML = '<div class="empty">没读到歌单</div>';
      return;
    }
    els.panelSub.textContent = `我的音乐 · 共 ${state.playlists.length} 个歌单`;
    els.list.innerHTML = '';
    state.playlists.forEach((pl, i) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <span class="idx">${i + 1}</span>
        <span class="txt">
          <span class="n">${escapeHtml(pl.name)}</span>
          <span class="a">${pl.count} 首${pl.subscribed ? ' · 收藏' : ''}</span>
        </span>`;
      div.addEventListener('click', () => openPlaylist(pl));
      els.list.appendChild(div);
    });
    state.likedPlaylist = j.liked || null;
  } catch (e) {
    els.list.innerHTML = '<div class="empty">读取失败：' + escapeHtml(e.message) + '</div>';
  }
}

async function openPlaylist(pl) {
  els.panelSub.textContent = `${pl.name} · 载入中…`;
  els.list.innerHTML = '<div class="empty">正在拉取《' + escapeHtml(pl.name) + '》…</div>';
  try {
    const j = await api('/playlist/detail?id=' + pl.id);
    const tracks = (j.playlist?.tracks || []).map(normalizeSong);
    if (!tracks.length) {
      els.list.innerHTML = '<div class="empty">这个歌单没有曲目</div>';
      return;
    }
    state.queue = tracks;
    state.playlistName = pl.name;
    renderList(`${pl.name} · ${tracks.length} 首`, tracks);
    toast(`《${pl.name}》已载入 ${tracks.length} 首，点任意一首开始`);
  } catch (e) {
    els.list.innerHTML = '<div class="empty">拉取失败：' + escapeHtml(e.message) + '</div>';
  }
}

function setTab(which) {
  state.tab = which;
  els.tabMine.classList.toggle('active', which === 'mine');
  els.tabSearch.classList.toggle('active', which === 'search');
  if (which === 'mine') loadMyPlaylists();
  else if (state.queue.length) renderList(state.playlistName || '当前列表', state.queue);
  else els.list.innerHTML = '<div class="empty">搜一首歌开始吧</div>';
}
els.tabMine.addEventListener('click', () => setTab('mine'));
els.tabSearch.addEventListener('click', () => setTab('search'));

/* ------------------------------------------------ 布局自适应（歌词避开控制条）
   底部控制条在窄屏会折行变高，写死避让值就会让按钮压到歌词上（用户看到的"黑色箭头"）。
   这里按控制条实际高度动态让位，任何窗口尺寸都不会撞。 */
function fitLayout() {
  const bar = document.querySelector('.bottom');
  const ctr = document.getElementById('center');
  if (!bar || !ctr) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  ctr.style.bottom = (h + 30) + 'px';
}
window.addEventListener('resize', fitLayout);
if (window.ResizeObserver) {
  const bar = document.querySelector('.bottom');
  if (bar) new ResizeObserver(fitLayout).observe(bar);
}
fitLayout();

/* ----------------------------------------------------------- 探针（?probe=1） */
if (new URLSearchParams(location.search).has('probe')) {
  els.dbg.classList.add('show');
  const NL = String.fromCharCode(10);
  setTimeout(() => {
    const out = ['视口 ' + innerWidth + 'x' + innerHeight];
    for (const fy of [0.5, 0.58, 0.66, 0.74, 0.82]) {
      const x = Math.round(innerWidth / 2);
      const y = Math.round(innerHeight * fy);
      const el = document.elementFromPoint(x, y);
      let desc = 'null';
      if (el) {
        const cs = getComputedStyle(el);
        desc =
          el.tagName +
          (el.id ? '#' + el.id : '') +
          (el.className ? '.' + String(el.className).split(' ')[0] : '') +
          ' bg=' + cs.backgroundColor +
          ' txt=' + JSON.stringify((el.textContent || '').trim().slice(0, 16));
      }
      out.push(x + ',' + y + ' -> ' + desc);
    }
    const bar = document.querySelector('.bottom');
    const ctr = document.getElementById('center');
    const lw = document.querySelector('.lrc-wrap');
    out.push('--- 布局 ---');
    out.push('控制条 .bottom 高=' + (bar ? Math.round(bar.getBoundingClientRect().height) : '?') +
             '  歌词区 .center bottom=' + (ctr ? getComputedStyle(ctr).bottom : '?') +
             '  歌词块 y=' + (lw ? Math.round(lw.getBoundingClientRect().top) + '-' + Math.round(lw.getBoundingClientRect().bottom) : '?') +
             ' 视口高=' + innerHeight);
    // 模拟滚轮 → 验证能一路钻到封面内部
    const cvEl = document.querySelector('canvas');
    const rr = () => (window.__ncm && window.__ncm.visual ? Math.round(window.__ncm.visual.view.radius) : -1);
    if (cvEl) {
      const r0 = rr();
      for (let i = 0; i < 40; i++) {
        cvEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
      }
      out.push('滚轮模拟(40 次上推): radius ' + r0 + ' -> ' + rr());
      const cover = window.__ncm.visual.coverPoints;
      out.push('封面粒子数=' + cover + '  相机半径=' + rr());
    }
    const hits = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return;
      if (r.top < innerHeight * 0.3) return;
      const bg = getComputedStyle(el).backgroundColor;
      const opaque = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg.indexOf('rgba(0, 0, 0, 0') !== 0;
      if (!opaque) return;
      hits.push(
        el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className || '').split(' ')[0] +
        ' y=' + Math.round(r.top) + '-' + Math.round(r.bottom) +
        ' bg=' + bg +
        ' txt=' + JSON.stringify((el.textContent || '').trim().slice(0, 16))
      );
    });
    out.push('--- 下半屏不透明元素 ' + hits.length + ' ---');
    for (const h of hits.slice(0, 12)) out.push(h);
    const box = document.createElement('pre');
    box.id = 'probeOut';
    box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;color:#fff;background:#000;font:11px monospace;max-width:96vw;white-space:pre-wrap;padding:6px';
    box.textContent = out.join(NL);
    document.body.appendChild(box);

    // ---- 诊断用：把相机固定成"正视图"并冻结自动旋转，保证截图可比 ----
    if (window.__ncm && window.__ncm.visual) {
      const v = window.__ncm.visual.view;
      v.theta = Math.PI / 2; v.phi = Math.PI / 2; v.radius = 200; v.vTheta = 0; v.vPhi = 0;
      window.__ncm.visual.dragging = true;      // 冻结自动慢转，否则视角会飘
    }

    // 诊断用：直接点第 5 首（带 MV）→ 触发封面/歌词/MV 加载。
    // 合成点击可能过不了自动播放策略（音频不响），但视觉部分照常加载，足够验收画面。
    setTimeout(() => {
      const items = document.querySelectorAll('#list .item');
      if (items[4]) items[4].click();
    }, 1500);

    // ---- 诊断台：?stage=<songId> 直接用 scene.js 的接口挂封面/歌词/MV（绕过 UI，便于截图对照）----
    const stageId = new URLSearchParams(location.search).get('stage');
    const info2 = document.createElement('div');
    box.appendChild(info2);
    if (stageId && window.__ncm && window.__ncm.visual) {
      const V = window.__ncm.visual;
      fetch('/api/song/detail?ids=' + stageId)
        .then((r) => r.json())
        .then(async (d) => {
          const s = (d.songs || [])[0];
          if (!s) { info2.textContent = 'stage: 查不到这首歌'; return; }
          info2.textContent = 'stage: ' + s.name + ' — ' + (s.ar || []).map((x) => x.name).join('/') +
            ' · 封面=' + ((s.picUrl || (s.al && s.al.picUrl)) ? '有' : '无') + ' · mvid=' + (s.mv || '无');
          const cover = s.picUrl || (s.al && s.al.picUrl);
          if (cover) V.setCoverToParticles('/cover?url=' + encodeURIComponent(cover));
          V.setLyricParticles('母带后期处理录音室：Studio 21A');
          V.setPlaying(true);
          if (s.mv) {
            const u = await (await fetch('/api/mv/url?id=' + s.mv + '&r=1080')).json();
            if (u && u.data && u.data.url) {
              V.attachVideo('/mv?id=' + s.mv);
              info2.textContent += ' · MV 已挂';
            } else {
              info2.textContent += ' · MV 取不到地址';
            }
          }
        })
        .catch((e) => { info2.textContent = 'stage 出错: ' + e.message; });
    }

    // ---- 自截图回传：每 4 秒把画面 POST 回服务端（存 shots/latest.png），便于直接看渲染结果 ----
    let shotN = 0;
    const stageEl = document.getElementById('stage');
    const infoEl = document.createElement('div');
    box.appendChild(infoEl);
    setInterval(() => {
      try {
        const u = stageEl.toDataURL('image/png');
        const tag = 'a' + String((window.__ncm && window.__ncm.visual.videoAlpha) || 0).replace('.', '');
        fetch('/__shot?tag=' + tag, { method: 'POST', body: u })
          .then((r) => r.json())
          .then((j) => {
            shotN += 1;
            infoEl.textContent = '截图回传 ' + shotN + ' 次 · 最近 ' + Math.round((j.bytes || 0) / 1024) + 'KB';
          })
          .catch((e) => { infoEl.textContent = '截图失败: ' + e.message; });
      } catch (e) { infoEl.textContent = '截图异常: ' + e.message; }
    }, 4000);
  }, 3500);
}

/* ----------------------------------------------------------- 调试条 */
if (new URLSearchParams(location.search).has('debug')) {
  els.dbg.classList.add('show');
  setInterval(() => {
    const d = visual.debugInfo();
    els.dbg.textContent =
      `封面粒子 ${d.coverPoints} · 歌词粒子 ${d.lyricPoints}\nMV ${d.mv} · 亮度 ${d.mvLum}%(峰值${d.mvLumMax}%) · ${d.mvFrames}帧 · ${d.mvT}s\n${d.fps} fps · 视角 θ=${d.theta} r=${d.radius} · 能量 ${d.level}`;
  }, 600);
}

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
  else if (e.key === 'r' || e.key === 'R') { visual.resetView(); toast('视角已复位'); }
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
