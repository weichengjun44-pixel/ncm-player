/**
 * 多音源适配层：把 QQ 音乐 / 酷狗 归一化成"网易云数据结构"。
 *
 * 为什么要归一化：前端（app.js / scene.js）整套逻辑都是按网易云的字段写的
 * （song.name / song.ar[] / song.al.picUrl / song.dt）。把 QQ、酷狗 在中间层
 * 翻译成同样的形状，前端就几乎不用动——这比让前端分支判断每个源要可靠得多。
 *
 * 所有接口都是实测验证过的（见 README 的"多音源"一节）。
 * 注意：QQ/酷狗的**原版付费曲**取不到流（返回明确的业务错误），翻唱/Live/版本曲可以。
 */
'use strict';
const { createHash } = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const md5 = (s) => createHash('md5').update(s).digest('hex');

/* ------------------------------------------------------------------ 工具 */

async function req(url, { headers = {}, method = 'GET', body = null, timeout = 12000 } = {}) {
  const r = await fetch(url, {
    method, body,
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  return r;
}
async function reqJson(url, opts) {
  const r = await req(url, opts);
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; }
  catch { return { status: r.status, data: null, text: t }; }
}

/** QQ 的图片/接口都要带 Referer，否则 403 */
const QQ_HEADERS = { Referer: 'https://y.qq.com/portal/player.html' };
const KG_HEADERS = { Referer: 'https://www.kugou.com/' };

/** 毫秒 → mm:ss.s 形式的 LRC 时间标签 */
/** 时长归一：搜索接口给秒，排行榜给毫秒 —— 统一成毫秒 */
const toMs = (d) => {
  const n = Number(d) || 0;
  return n > 10000 ? n : n * 1000;
};

/** 封面候选挑选：各家字段名不一样，而且有的藏在嵌套对象里（酷狗的 trans_param） */
function pickCover(s) {
  const cands = [
    s.album_sizable_cover, s.imgurl, s.Image, s.cover, s.album_sizable, 
    s.trans_param?.union_cover, s.trans_param?.nos_cover, s.trans_param?.cov,
    s.trans_param?.union_cover_40, s.authors?.[0]?.sizable_avatar,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && /^https?:\/\//.test(c)) return c.replace('{size}', '480');
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      for (const v of Object.values(c)) {
        if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace('{size}', '480');
      }
    }
  }
  return '';
}

/** QQ 的 mv 字段：new_json 下是对象 {vid,...}，老接口下是数字 */
const qqMvId = (mv) => (mv && typeof mv === 'object') ? (mv.vid || '') : (mv ? String(mv) : '');

const fmtTime = (ms) => {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${rest}`;
};

/** 把纯文本歌词（无时间轴）变成每行 4 秒的 LRC——有些源对某些歌只给纯文本 */
function plainToLrc(text) {
  return String(text).split(/\r?\n/)
    .map((line, i) => `[${fmtTime(i * 4000)}]${line}`)
    .join('\n');
}

/* ------------------------------------------------------------------ QQ 音乐 */

const qq = {
  id: 'qq',
  name: 'QQ 音乐',

  async search(keywords, page = 1, limit = 30) {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=${page}&n=${limit}`
      + `&w=${encodeURIComponent(keywords)}&cr=1&aggr=1&lossless=0&new_json=1`;
    const { data } = await reqJson(url, { headers: QQ_HEADERS });
    const list = data?.data?.song?.list || [];
    return list.map((s) => ({
      id: s.mid,
      name: s.name,
      ar: (s.singer || []).map((x) => ({ name: x.name })),
      al: {
        // gtimg 的路径里带尺寸，用 800x800 → 前端粒子化封面时细节足够
        picUrl: s.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${s.album.mid}.jpg` : '',
        name: s.album?.name || '',
        id: s.album?.mid || '',
      },
      dt: toMs(s.interval),
      source: 'qq',
      mvId: qqMvId(s.mv),
      _pay: s.pay ? s.pay.pay_play === 1 : false,   // 前端可用来标"付费"
    }));
  },

  /** 取流：musicu.fcg 的 vkey 流程（实测免登录约 40% 可播，返回 206 audio/mp4） */
  async songUrl(mid, { prefix = 'M800' } = {}) {
    const body = JSON.stringify({
      comm: { ct: 24, cv: 0, uin: '0', format: 'json', platform: 'wk_v17' },
      req: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: {
          guid: '10000', songmid: [mid], songtype: [0], uin: '0',
          loginflag: 1, platform: '20',
        },
      },
    });
    const { data } = await reqJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', body, headers: { ...QQ_HEADERS, 'Content-Type': 'application/json' },
    });
    const d = data?.req?.data;
    const info = (d?.midurlinfo || [])[0];
    if (!info || !info.purl) {
      // errtype 104003 = 需要会员 / 无版权；101404 = 找不到
      const e = new Error(info?.result === 104003 ? '这首歌需要会员（QQ 音乐）' : `QQ 取流失败 (errtype=${info?.result ?? '未知'})`);
      e.code = info?.result;
      throw e;
    }
    const sip = (d.sip || []).find((s) => s.startsWith('http')) || 'https://ws.stream.qqmusic.qq.com/';
    return { url: sip + info.purl, mime: 'audio/mp4' };
  },

  async lyric(mid) {
    const { data } = await reqJson(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${mid}&format=json&nobase64=1`,
      { headers: QQ_HEADERS });
    const lrc = data?.lyric || '';
    const tr = data?.trans || '';
    return { lrc, trans: tr, hasTimeTag: /\[\d{1,2}:\d{1,2}/.test(lrc) };
  },

  /** 排行榜（免登录）：topId 26 = 热歌榜、4 = 飙升榜 */
  async chart(topId = 26, limit = 40) {
    const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topId}&format=json&page=detail&type=top&song_begin=0&song_num=${limit}&tpl=3`;
    const { data } = await reqJson(url, { headers: QQ_HEADERS });
    const list = data?.songlist || [];
    return list.map((it) => {
      const s = it.data || it;
      return {
        id: s.songmid,
        name: s.songname,
        ar: (s.singer || []).map((x) => ({ name: x.name })),
        al: {
          picUrl: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${s.albummid}.jpg` : '',
          name: s.albumname || '',
          id: s.albummid || '',
        },
        dt: toMs(s.interval),
        source: 'qq',
        mvId: qqMvId(s.mv),
      };
    });
  },

  /** MV 取流（musicu.fcg 的 mv 模块） */
  async mvUrl(vid) {
    const body = JSON.stringify({
      comm: { ct: 24, cv: 0, uin: '0', format: 'json', platform: 'wk_v17' },
      req: { module: 'mv.MvUrlServer', method: 'CgiGetMvUrl', param: { vid, video_type: 0 } },
    });
    const { data } = await reqJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', body, headers: { ...QQ_HEADERS, 'Content-Type': 'application/json' },
    });
    const d = data?.req?.data;
    const url = d?.mp4?.[0] || d?.mp4_1 || d?.mp4_720 || d?.url || '';
    if (!url) throw new Error('QQ MV 取流失败');
    return { url, mime: 'video/mp4' };
  },
};

/* ------------------------------------------------------------------ 酷狗 */

const kugou = {
  id: 'kugou',
  name: '酷狗音乐',

  async search(keywords, page = 1, limit = 30) {
    const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keywords)}`
      + `&page=${page}&pagesize=${limit}&platform=WebFilter&userid=0&clientver=2000`;
    const { data } = await reqJson(url, { headers: KG_HEADERS });
    const list = data?.data?.lists || [];
    return list.map((s) => ({
      id: s.FileHash,
      name: s.SongName,
      ar: [{ name: s.SingerName }],
      al: {
        // 搜索返回的是 {size} 模板占位符；字段名各家不一，统一走候选挑选
        picUrl: pickCover(s),
        name: s.AlbumName || '',
        id: String(s.AlbumID || ''),
      },
      dt: toMs(s.Duration),
      source: 'kugou',
      mvId: s.MvHash || '',
      _mixId: s.MixSongID,          // 取流/歌词偶尔要用
      _kgHash: s.FileHash,
    }));
  },

  /** 取流：m.kugou.com 的 app 接口（实测免登录可播，直接给 mp3 直链）。
      付费曲会返回 err=需要付费 —— 这是业务错误，原样抛给前端提示。 */
  async songUrl(hash) {
    const { data } = await reqJson(
      `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`,
      { headers: KG_HEADERS });
    if (!data?.url) {
      const e = new Error(data?.error === '需要付费' ? '这首歌需要付费（酷狗）' : `酷狗取流失败 (${data?.error || data?.status || '未知'})`);
      e.code = data?.error || data?.status;
      throw e;
    }
    return { url: data.url, mime: 'audio/mpeg' };
  },

  /** 歌词：krcs 搜索 → download（返回 base64 的 LRC） */
  async lyric(hash, duration = 0) {
    const { data } = await reqJson(
      `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=${duration}&hash=${hash}`,
      { headers: KG_HEADERS });
    const c = (data?.candidates || [])[0];
    if (!c?.id || !c?.accesskey) return { lrc: '', trans: '', hasTimeTag: false };
    const { data: d2 } = await reqJson(
      `https://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=lrc&charset=utf8`,
      { headers: KG_HEADERS });
    if (!d2?.content) return { lrc: '', trans: '', hasTimeTag: false };
    const lrc = Buffer.from(d2.content, 'base64').toString('utf8');
    return { lrc, trans: '', hasTimeTag: /\[\d{1,2}:\d{1,2}/.test(lrc) };
  },

  /** 排行榜（免登录）：rankid 8888 = TOP500、6666 = 热歌榜 */
  async chart(rankId = 8888, limit = 40) {
    const { data } = await reqJson(
      `https://m.kugou.com/rank/info/?rankid=${rankId}&page=1&json=true`,
      { headers: KG_HEADERS });
    const list = data?.songs?.list || data?.data?.info || [];
    return list.slice(0, limit).map((s) => ({
      id: s.hash || s.FileHash,
      name: s.songname || s.SongName || '',
      ar: [{ name: s.authors?.[0]?.author_name || s.singername || s.SingerName || '' }],
      al: {
        picUrl: pickCover(s),
        name: s.album_name || s.AlbumName || '',
        id: String(s.album_id || s.AlbumID || ''),
      },
      dt: toMs(s.duration || s.Duration),
      source: 'kugou',
      mvId: s.mvhash || '',
      _kgHash: s.hash || s.FileHash,
    }));
  },
};

/* ------------------------------------------------------------------ 导出 */

const PROVIDERS = { qq, kugou };
const ALL = { netease: { id: 'netease', name: '网易云音乐' }, ...PROVIDERS };

module.exports = { qq, kugou, PROVIDERS, ALL, fmtTime, plainToLrc, md5, req };
