/* ==========================================================
 *  音乐模块
 * ========================================================== */
const M = {
  audio: null, playlist: [], currentIndex: -1,
  isPlaying: false, loadingIndex: -1,
  requestId: 0, lastError: '', pendingPlay: false,
  lyrics: [], lyricIndex: -1, currentTab: 'search', miniHidden: false,
  pos: 0, dur: 0, searchKeyword: '', searchPage: 0, hasMore: false,
  searchResults: [], queue: [], history: [], cache: [], downloads: {}
};
let musicPlayHistory = sGet('via_ai_music_history', []) || [];
let musicQueue = sGet('via_ai_music_queue', []) || [];
let musicCacheRecords = sGet('via_ai_music_cache', []) || [];
M.queue = Array.isArray(musicQueue) ? musicQueue : [];
M.history = Array.isArray(musicPlayHistory) ? musicPlayHistory : [];
M.cache = Array.isArray(musicCacheRecords) ? musicCacheRecords : [];
/** 播放直链多为短时签名地址，绝不写进历史/队列/缓存索引。 */
const MUSIC_VOLATILE_FIELDS = ['playUrl', 'play_url', 'play_urls', 'url', 'urls', 'media_url', 'mediaUrl', 'audio', 'src', 'expiresAt', 'expires_at'];
function musicStripVolatile(song) {
  if (!song || typeof song !== 'object') return song;
  const out = Object.assign({}, song);
  MUSIC_VOLATILE_FIELDS.forEach(k => { delete out[k]; });
  return out;
}
function musicSongKey(song) {
  return String(song && (song.source || song.provider || '')) + ':' + String(song && (song.id || song.name || ''));
}
function musicRemember(song) {
  if (!song || CONFIG.musicHistoryLimit === 0) return;
  const key = musicSongKey(song);
  M.history = [Object.assign(musicStripVolatile(song), { playedAt: Date.now() }), ...M.history.filter(x => musicSongKey(x) !== key)];
  const limit = Math.max(20, Math.min(500, parseInt(CONFIG.musicHistoryLimit, 10) || 100));
  M.history = M.history.slice(0, limit);
  musicPlayHistory = M.history;
  sSet('via_ai_music_history', M.history);
}
function musicSaveQueue() { musicQueue = M.queue.slice(0, 100); sSet('via_ai_music_queue', musicQueue); }
function musicAddQueue(song) {
  if (!song) return false;
  if (!M.queue.some(x => musicSongKey(x) === musicSongKey(song))) { M.queue.push(musicStripVolatile(song)); musicSaveQueue(); return true; }
  return false;
}
function musicRemoveQueue(song) { M.queue = M.queue.filter(x => musicSongKey(x) !== musicSongKey(song)); musicSaveQueue(); }
function musicSaveCacheRecords() { musicCacheRecords = M.cache.slice(0, 300); sSet('via_ai_music_cache', musicCacheRecords); }
function musicCacheRecord(song, patch) {
  if (!song) return null;
  const key = musicSongKey(song);
  const old = M.cache.find(x => musicSongKey(x) === key) || musicStripVolatile(song);
  Object.assign(old, musicStripVolatile(song), patch || {}, { key, updatedAt: Date.now() });
  const rest = M.cache.filter(x => musicSongKey(x) !== key);
  M.cache = [old, ...rest].slice(0, 300);
  musicSaveCacheRecords();
  return old;
}
function musicFindSongByKey(key) {
  const lists = [M.playlist, M.queue, M.history, M.cache, favorites];
  for (const list of lists) {
    const found = Array.isArray(list) ? list.find(x => musicSongKey(x) === key) : null;
    if (found) return found;
  }
  return null;
}

/* ---- 播放顺序：顺序 / 单曲循环 / 随机 ---- */
const PLAY_MODES = [
  { id: 'order',   icon: '🔁', name: '顺序播放' },
  { id: 'single',  icon: '🔂', name: '单曲循环' },
  { id: 'shuffle', icon: '🔀', name: '随机播放' }
];
function playMode() {
  const m = CONFIG.playMode;
  return PLAY_MODES.some(x => x.id === m) ? m : 'order';
}
function playModeIcon() {
  const p = PLAY_MODES.find(x => x.id === playMode());
  return p ? p.icon : PLAY_MODES[0].icon;
}
function playModeName() {
  const p = PLAY_MODES.find(x => x.id === playMode());
  return p ? p.name : PLAY_MODES[0].name;
}
function cyclePlayMode() {
  const i = PLAY_MODES.findIndex(x => x.id === playMode());
  CONFIG.playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length].id;
  sSet('via_ai_config', CONFIG);
  updateBar(); updateMini();
  toast('播放方式：' + playModeName());
  vibrate(12);
}

const gdBase = () => (CONFIG.gdStudioApi || DC.gdStudioApi).replace(/\/$/, '');
const metingList = () => (CONFIG.metingInstances || DC.metingInstances)
  .split('\n').map(s => s.trim()).filter(Boolean);
const musicCatalogs = () => String(CONFIG.musicCatalogs || DC.musicCatalogs || 'netease,tencent,kugou,kuwo')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MUSIC_HEALTH_KEY = 'via_ai_music_source_health';
let MUSIC_HEALTH = sGet(MUSIC_HEALTH_KEY, {}) || {};
function musicHealthKey(source) { return String(source || 'unknown'); }
function musicMark(source, ok) {
  const k = musicHealthKey(source); const old = MUSIC_HEALTH[k] || { ok: 0, fail: 0, lastError: '' };
  MUSIC_HEALTH[k] = { ok: old.ok + (ok ? 1 : 0), fail: old.fail + (ok ? 0 : 1), lastError: ok ? '' : old.lastError, updatedAt: Date.now() };
  sSet(MUSIC_HEALTH_KEY, MUSIC_HEALTH);
}
/**
 * 音乐请求统一走 RequestManager。
 * 音乐 CDN 的 302 跨域是正常业务，因此始终允许跨域跳转（不受 Agent L2 影响）。
 */
async function musicRequest(url, timeout, source, retries) {
  try {
    const r = await reqRequest({
      method: 'GET', url: url,
      headers: { Accept: 'application/json,text/plain,*/*' },
      timeoutMs: timeout || 12000,
      // 搜索速度优先：只重试 1 次，避免失效来源把首屏拖长
      expect: 'text', retries: retries === undefined ? 1 : retries, maxRedirect: 5,
      source: 'music:' + String(source || '')
    });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    musicMark(source, true);
    return String(r.text || '');
  } catch (e) {
    const k = musicHealthKey(source); const h = MUSIC_HEALTH[k] || {};
    h.lastError = errMsg(e); MUSIC_HEALTH[k] = h; musicMark(source, false); throw e;
  }
}
function musicJson(text, source) {
  const raw = String(text == null ? '' : text).trim().replace(/^\uFEFF/, '');
  if (!raw) throw new Error((source || '音乐源') + ' 返回为空');
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error((source || '音乐源') + ' 返回的不是有效 JSON');
  }
  // 少数中转服务会把 JSON 再包成字符串，最多解一层，避免把任意文本当结果。
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { throw new Error((source || '音乐源') + ' JSON 内容不是对象或数组'); }
  }
  if (data && typeof data === 'object') {
    if (data.success === false || data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.message || '音乐源返回错误');
      throw new Error((source || '音乐源') + '：' + msg);
    }
    if (Number(data.code) >= 400) throw new Error((source || '音乐源') + '：HTTP/业务错误 ' + data.code);
  }
  return data;
}
function parseMusicUrlResponse(text, source) {
  const raw = String(text == null ? '' : text).trim().replace(/^\uFEFF/, '');
  if (!raw) return '';
  const looksUrl = (v) => {
    const s = String(v == null ? '' : v).trim().replace(/^['"]|['"]$/g, '');
    return /^https?:\/\//i.test(s) ? s : '';
  };
  const direct = looksUrl(raw);
  if (direct) return direct;
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error((source || '音乐源') + ' 播放地址不是有效 JSON/URL'); }
  const findUrl = (value, depth) => {
    if (depth > 5 || value == null) return '';
    const one = looksUrl(value); if (one) return one;
    if (Array.isArray(value)) { for (const x of value) { const u = findUrl(x, depth + 1); if (u) return u; } return ''; }
    if (typeof value === 'object') {
      for (const k of ['url','play_url','playUrl','media_url','mediaUrl','song_url','songUrl','audio_url','music_url','download_url','play_urls','urls','audio','src','data','result']) {
        if (Object.prototype.hasOwnProperty.call(value, k)) { const u = findUrl(value[k], depth + 1); if (u) return u; }
      }
    }
    return '';
  };
  const url = findUrl(data, 0);
  if (url) return url;
  throw new Error((source || '音乐源') + ' 未返回有效播放地址');
}

function findArr(o, d) {
  d = d || 0;
  if (d > 4 || !o || typeof o !== 'object') return null;
  if (Array.isArray(o) && o.length && typeof o[0] === 'object'
      && (o[0].name || o[0].song || o[0].title || o[0].songname)) return o;
  for (const k of ['songs', 'data', 'result', 'list', 'items', 'tracks', 'song_list']) {
    if (o[k]) { const f = findArr(o[k], d + 1); if (f) return f; }
  }
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object') {
      const f = findArr(o[k], d + 1); if (f) return f;
    }
  }
  return null;
}
function norm(raw, src) {
  const name = raw.name || raw.song || raw.title || raw.songname || raw.songName || '未知歌曲';
  let art = raw.artist || raw.artists || raw.singer || raw.author || raw.singerName ||
    raw.artistName || raw.artist_name || raw.albumArtist || raw.ar || raw.artistsName || '';
  if (Array.isArray(art)) art = art.map(a => typeof a === 'object' ? (a.name || a.artistName || a.id || '') : a).filter(Boolean).join(' / ');
  if (art && typeof art === 'object') art = art.name || art.artistName || art.id || '';
  art = String(art || '').trim();
  // 部分公共接口会用“某某/未知”占位，不能把它当成真实作者显示。
  if (!art || /^(某某|未知|未知歌手|unknown|undefined|null)$/i.test(art)) art = '未知歌手';
  let duration = raw.duration; if (duration == null) duration = raw.interval;
  if (duration == null) duration = raw.length; if (duration == null) duration = raw.duration_ms;
  if (duration == null) duration = 0;
  if (typeof duration === 'string' && /^\d+:\d+(?:\.\d+)?$/.test(duration)) {
    const p = duration.split(':'); duration = (Number(p[0]) * 60 + Number(p[1])) * 1000;
  } else {
    duration = Number(duration) || 0;
    // search 接口常返回秒，播放器显示统一使用毫秒。
    if (duration > 0 && duration < 1000) duration *= 1000;
  }
  return {
    id: String(raw.id || raw.url_id || raw.song_id || raw.songmid || raw.mid || raw.songId || ''),
    name: String(name), artist: art, duration, source: src,
    provider: raw.provider || '', catalog: raw.catalog || '', endpoint: raw.endpoint || '',
    playUrl: raw.playUrl || raw.play_url || raw.media_url || raw.mediaUrl || raw.song_url || raw.songUrl || raw.play_urls || raw.urls || raw.audio || '',
    coverUrl: raw.coverUrl || raw.cover_url || raw.pic || raw.picUrl || '',
    lyricsUrl: raw.lyricsUrl || raw.lyrics_url || raw.lyric_url || ''
  };
}
function parseLrc(t) {
  if (!t || typeof t !== 'string') return [];
  const out = [], re = /\[(\d+):(\d+(?:\.\d+)?)\]([^\n]*)/g;
  let m;
  while ((m = re.exec(t))) {
    let s = m[3].trim().replace(/<\/?[a-z][^>]*>/gi, '').trim();
    if (!s) continue;
    if (/^\[(ar|ti|al|by|offset|re|ve|length|kana|t_time|#)/i.test(s)) continue;
    if (/^(作词|作曲|编曲|制作人|监制|出品|发行|词|曲|制作|OP|SP|混音|母带|录音|配唱|和声|吉他|贝斯|鼓|键盘|弦乐|人声|出品人|监制)\s*[:：]\s*.*$/.test(s) && s.length < 40) continue;
    if (/^(某某|未知|unknown|undefined|null)$/i.test(s)) continue;
    if (/^[\s\-—·。，、！？!?,.;:：；]+$/.test(s)) continue;
    out.push({ t: parseInt(m[1]) * 60 + parseFloat(m[2]), text: s });
  }
  return out.sort((a, b) => a.t - b.t);
}

function parseLyricResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return { lyric: '', tlyric: '' };
  try {
    const d = JSON.parse(raw);
    if (typeof d === 'string') return { lyric: d, tlyric: '' };
    if (d && typeof d === 'object') {
      return { lyric: d.lyric || d.lrc || d.lyrics || '', tlyric: d.tlyric || d.trans || '' };
    }
  } catch (e) { /* plain LRC */ }
  return { lyric: raw, tlyric: '' };
}

const gdSrc = {
  id: 'gd', name: 'GD Studio',
  async search(kw, page) {
    const results = await Promise.allSettled(musicCatalogs().map(async catalog => {
      const source = this.id + ':' + catalog;
      const text = await musicRequest(`${gdBase()}?types=search&source=${encodeURIComponent(catalog)}&name=${encodeURIComponent(kw)}&count=30&pages=${page || 1}`, 10000, source);
      const arr = findArr(musicJson(text, source)); if (!arr) throw new Error('无数组');
      return arr.map(s => Object.assign(norm(s, source), { provider: this.id, catalog })).filter(s => s.id);
    }));
    const out = []; results.forEach(r => { if (r.status === 'fulfilled') out.push(...r.value); });
    if (!out.length) throw new Error('GD Studio 没有可用结果');
    return out;
  },
  async getUrl(song) {
    const catalog = song.catalog || String(song.source || '').split(':')[1] || 'netease';
    const source = this.id + ':' + catalog;
    const t = await musicRequest(`${gdBase()}?types=url&source=${encodeURIComponent(catalog)}&id=${encodeURIComponent(song.id)}&br=${encodeURIComponent(CONFIG.musicQuality)}`, 15000, source);
    return parseMusicUrlResponse(t, source);
  },
  async getLyric(song) {
    const catalog = song.catalog || String(song.source || '').split(':')[1] || 'netease';
    const source = this.id + ':' + catalog;
    const t = await musicRequest(`${gdBase()}?types=lyric&source=${encodeURIComponent(catalog)}&id=${encodeURIComponent(song.id)}&lrctype=1`, 12000, source);
    return parseLyricResponse(t);
  }
};
const metingSrc = {
  id: 'meting', name: 'Meting',
  async search(kw, page) {
    const jobs = [];
    metingList().forEach((base, index) => musicCatalogs().forEach(catalog => {
      const job = async () => {
        const source = this.id + ':' + index + ':' + catalog;
        const url = `${base.replace(/\/$/, '')}/?server=${encodeURIComponent(catalog)}&type=search&id=${encodeURIComponent(kw)}&page=${page || 1}`;
        const a = findArr(musicJson(await musicRequest(url, 10000, source), source)); if (!a) throw new Error('无数组');
        const l = a.map(s => Object.assign(norm(s, this.id + ':' + catalog), { provider: this.id, catalog, endpoint: base })).filter(s => s.id);
        if (!l.length) throw new Error('空'); return l;
      };
      jobs.push(job());
    }));
    const results = await Promise.allSettled(jobs); const out = [];
    results.forEach(r => { if (r.status === 'fulfilled') out.push(...r.value); });
    if (!out.length) throw new Error('Meting 没有可用结果'); return out;
  },
  async getUrl(song) {
    const catalog = song.catalog || 'netease';
    const endpoints = song.endpoint ? [song.endpoint] : metingList();
    const jobs = endpoints.map((base, index) => (async () => {
      const source = this.id + ':' + index + ':' + catalog;
      const t = await musicRequest(`${base.replace(/\/$/, '')}/?server=${encodeURIComponent(catalog)}&type=url&id=${encodeURIComponent(song.id)}&br=${encodeURIComponent(CONFIG.musicQuality)}`, 15000, source);
      return parseMusicUrlResponse(t, source);
    })());
    return pAny(jobs);
  },
  async getLyric(song) {
    const catalog = song.catalog || 'netease';
    const endpoints = song.endpoint ? [song.endpoint] : metingList();
    const jobs = endpoints.map((base, index) => (async () => {
      const source = this.id + ':' + index + ':' + catalog;
      const parsed = parseLyricResponse(await musicRequest(`${base.replace(/\/$/, '')}/?server=${encodeURIComponent(catalog)}&type=lyric&id=${encodeURIComponent(song.id)}`, 12000, source));
      if (parsed.lyric && parsed.lyric.length > 2) return parsed;
      throw new Error('无歌词');
    })());
    return pAny(jobs);
  }
};
const SOURCES = [gdSrc, metingSrc];

async function mSearch(kw, append) {
  const page = append ? Math.max(1, M.searchPage + 1) : 1;
  const results = await Promise.allSettled(SOURCES.map(s => s.search(kw, page)));
  const all = []; results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
  if (!all.length && !append) throw new Error('所有音乐来源都没有返回结果');
  const seen = new Set();
  const prior = append ? M.searchResults : [];
  const merged = [...prior, ...all];
  M.playlist = merged.filter(s => {
    const key = musicSongKey(s).toLowerCase();
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 120);
  M.searchKeyword = String(kw || M.searchKeyword || '');
  M.searchResults = M.playlist.slice();
  M.searchPage = page;
  M.hasMore = all.length >= 20 && M.playlist.length < 120;
  return M.playlist;
}
async function mGetUrl(song) {
  const direct = parseMusicUrlResponse(song && (song.playUrl || song.play_url || song.media_url || song.song_url || ''), '歌曲记录');
  if (direct) return direct;
  const preferred = [];
  const provider = String(song.provider || String(song.source || '').split(':')[0]);
  const first = SOURCES.find(s => s.id === provider);
  if (first) preferred.push(first);
  SOURCES.forEach(s => { if (!preferred.includes(s)) preferred.push(s); });
  try {
    return await pAny(preferred.map(s => s.getUrl(song).then(u => {
      if (!/^https?:\/\//i.test(String(u || ''))) throw new Error('无效播放地址');
      return u;
    })));
  } catch (e) { throw new Error('无法获取播放地址：' + errMsg(e)); }
}
async function mGetLyric(song) {
  const provider = String(song.provider || String(song.source || '').split(':')[0]);
  const first = SOURCES.find(s => s.id === provider);
  const list = first ? [first, ...SOURCES.filter(s => s !== first)] : SOURCES;
  try { return await pAny(list.map(s => s.getLyric(song).then(r => { if (!r || !r.lyric) throw new Error('无歌词'); return r; }))); }
  catch (e) { return { lyric: '', tlyric: '' }; }
}

function musicCacheId(song) { return String((song && song.source) || '') + ':' + String((song && song.id) || (song && song.name) || ''); }
function cachedMusicPath(song) {
  const id = musicCacheId(song);
  try { return HAS_NATIVE && Android.getCachedMusic ? String(Android.getCachedMusic(id) || '') : ''; } catch (e) { return ''; }
}
function cacheMusicSong(song) {
  if (!song) return;
  const id = musicCacheId(song);
  if (cachedMusicPath(song)) { musicCacheRecord(song, { status: 'ready' }); toast('这首歌已经缓存'); return; }
  if (M.downloads[id] && M.downloads[id].status === 'downloading') return toast('正在缓存这首歌');
  M.downloads[id] = { status: 'resolving', pct: 0 };
  musicCacheRecord(song, { status: 'downloading', progress: 0, error: '' });
  renderMusicTab();
  toast('正在下载缓存：' + song.name);
  mGetUrl(song).then(url => {
    if (!(HAS_NATIVE && Android.cacheMusic)) throw new Error('当前环境不支持音乐缓存');
    M.downloads[id] = { status: 'downloading', pct: 0 };
    Android.cacheMusic(id, url, song.name || '', song.artist || '');
  }).catch(e => {
    M.downloads[id] = { status: 'failed', pct: 0, error: errMsg(e) };
    musicCacheRecord(song, { status: 'failed', progress: 0, error: errMsg(e) });
    renderMusicTab(); toast('缓存失败：' + errMsg(e));
  });
}
function removeCachedMusic(song) {
  if (!song) return;
  const id = musicCacheId(song);
  const ok = HAS_NATIVE && Android.deleteCachedMusic ? Android.deleteCachedMusic(id) : false;
  if (ok || !HAS_NATIVE) {
    M.cache = M.cache.filter(x => musicSongKey(x) !== musicSongKey(song));
    musicSaveCacheRecords();
    delete M.downloads[id];
    renderMusicTab();
    toast('已删除缓存');
  } else toast('缓存文件不存在或删除失败');
}
window.__musicCacheProgress = function(id, pct) {
  const n = Number(pct) || 0;
  M.downloads[id] = { status: n >= 100 ? 'validating' : 'downloading', pct: n };
  const song = musicFindSongByKey(id);
  if (song) musicCacheRecord(song, { status: 'downloading', progress: n });
  renderMusicTab();
};
window.__musicCacheCb = function(id, ok, path, err) {
  const song = musicFindSongByKey(id);
  if (ok) {
    M.downloads[id] = { status: 'ready', pct: 100, path: path || '' };
    if (song) musicCacheRecord(song, { status: 'ready', progress: 100, path: path || '', error: '' });
    toast('已缓存，可在无网络时优先播放');
  } else {
    M.downloads[id] = { status: 'failed', pct: 0, error: err || '未知错误' };
    if (song) musicCacheRecord(song, { status: 'failed', progress: 0, error: err || '未知错误' });
    toast('缓存失败：' + (err || '未知错误'));
  }
  renderMusicTab();
};

const isFav = (s) => favorites.some(f => f.id === s.id && f.source === s.source);
function toggleFav(song) {
  const i = favorites.findIndex(f => f.id === song.id && f.source === song.source);
  if (i >= 0) favorites.splice(i, 1); else favorites.unshift(musicStripVolatile(song));
  sSet('via_ai_favs', favorites);
  $('#fav-cnt').textContent = favorites.length;
  if (M.currentTab === 'fav') { M.playlist = favorites.slice(); renderList(favorites); }
  else updateFavBtns();
}
function updateFavBtns() {
  $$('#music-list .mi').forEach((el, i) => {
    const btn = el.querySelector('.mfav'); if (!btn) return;
    const s = M.currentTab === 'fav' ? favorites[i] : M.playlist[i];
    if (s) {
      const on = isFav(s);
      btn.classList.toggle('active', on);
      btn.textContent = on ? '★' : '☆';
    }
  });
}
const fmtTime = (s) => {
  if (!s || isNaN(s)) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDur = (ms) => {
  if (!ms) return '--:--';
  const s = Math.floor(ms / 1000);
  if (s > 3600) return '--:--';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function updateProgress() {
  const bar = $('#mp-progress-bar'), timeEl = $('#mp-time');
  if (!bar) return;
  const dur = M.dur || 0;
  if (!dur) {
    bar.style.width = '0%';
    if (timeEl) timeEl.textContent = '0:00 / 0:00';
    return;
  }
  const p = Math.max(0, Math.min(100, (M.pos / dur) * 100));
  bar.style.width = p + '%';
  if (timeEl) timeEl.textContent = `${fmtTime(M.pos)} / ${fmtTime(dur)}`;
}
function getAudio() {
  if (!M.audio) {
    const a = new Audio();
    a.preload = 'auto';
    a.onended = () => { M.isPlaying = false; playNext(true); };
    a.onplay = () => { M.isPlaying = true; M.pendingPlay = false; M.lastError = ''; updateBar(); updateHL(); updateMini(); };
    a.onpause = () => { M.isPlaying = false; updateBar(); updateMini(); };
    a.ontimeupdate = () => {
      M.pos = (a.currentTime || 0) * 1000;
      M.dur = (a.duration || 0) * 1000;
      onLyricTime(); updateProgress();
    };
    a.onloadedmetadata = () => { M.dur = (a.duration || 0) * 1000; updateProgress(); };
    a.onerror = () => { M.isPlaying = false; if (a.src) M.lastError = '音频加载失败'; updateBar(); updateMini(); };
    M.audio = a;
  }
  return M.audio;
}

function stopLegacyAudio() {
  const a = M.audio;
  if (!a) return;
  try { a.pause(); } catch (e) {}
  try { a.removeAttribute('src'); a.load(); } catch (e) {}
}

/**
 * 歌曲直链缓存。只往前预取一首，且用之前先看是不是旧的 ——
 * 这些接口给的直链常常带签名过期时间，存太久反而会放不出来。
 */
const urlCache = new Map();
const URL_TTL = 8 * 60 * 1000;

async function songUrl(song) {
  const cached = cachedMusicPath(song);
  if (cached) return cached;
  const k = String(song.source || '') + ':' + String(song.provider || '') + ':' + String(song.catalog || '') + ':' + String(song.id || song.name || '');
  const hit = k && urlCache.get(k);
  if (hit && Date.now() - hit.at < URL_TTL) return hit.url;
  const url = await mGetUrl(song);
  if (k) urlCache.set(k, { url, at: Date.now() });
  return url;
}

/** 提前把下一首的直链拿到手，切歌时才不会卡在「正在连接…」。 */
function prefetchNextUrl() {
  const L = M.playlist.length;
  if (L < 2) return;
  let j;
  if (playMode() === 'shuffle') j = Math.floor(Math.random() * L);
  else if (playMode() === 'single') j = M.currentIndex;
  else j = M.currentIndex + 1 < L ? M.currentIndex + 1 : 0;
  const s = M.playlist[j];
  if (!s) return;
  songUrl(s).catch(() => {});
}

async function playAt(i) {
  const song = M.playlist[i]; if (!song) return;
  const rid = ++M.requestId;
  M.currentIndex = i; M.isPlaying = false; M.lastError = '';
  M.pendingPlay = false; M.loadingIndex = i;
  M.lyrics = []; M.lyricIndex = -1;
  M.pos = 0; M.dur = 0;
  setLyric(''); updateLyricModal();
  M.miniHidden = false;
  stopLegacyAudio();
  updateLoading(i); updateHL(); updateBar(); updateProgress();

  const [urlR, lyrR] = await Promise.allSettled([songUrl(song), mGetLyric(song)]);
  if (rid !== M.requestId) return;

  if (lyrR.status === 'fulfilled' && lyrR.value && lyrR.value.lyric) {
    M.lyrics = parseLrc(lyrR.value.lyric);
    updateLyricModal();
  }
  if (urlR.status === 'rejected') {
    M.lastError = errMsg(urlR.reason);
    M.loadingIndex = -1; updateLoading(-1); updateBar(); updateMini(); return;
  }

  M.loadingIndex = -1; updateLoading(-1); updateBar(); updateMini();
  musicRemember(song);
  musicAddQueue(song);

  const n = MP();
  if (n) {
    try { n.mpLoad(urlR.value, song.name || '', song.artist || ''); }
    catch (e) { M.lastError = errMsg(e); updateBar(); updateMini(); return; }
    M.isPlaying = true;            // 乐观先亮起来，原生 __mpState 会随时纠偏
    if (CONFIG.musicAutoCache) cacheMusicSong(song);
    updateBar(); updateMini();
    prefetchNextUrl();
    return;
  }

  // ---- 兑底：没有原生环境时还是走 <audio> ----
  const a = getAudio();
  a.src = urlR.value;
  try { await a.play(); if (CONFIG.musicAutoCache) cacheMusicSong(song); }
  catch (e) {
    if (rid !== M.requestId) return;
    if (e.name === 'NotAllowedError' || String(e).includes('user gesture')) {
      M.pendingPlay = true; updateBar();
    } else { M.lastError = errMsg(e); updateBar(); }
  }
}

function togglePlay() {
  M.miniHidden = false;
  M.lastError = '';
  const n = MP();
  if (n) {
    if (M.currentIndex < 0) {
      if (M.playlist.length) playAt(0);
      return;
    }
    try { n.mpToggle(); } catch (e) { M.lastError = errMsg(e); }
    return;
  }
  const a = getAudio();
  if (!a.src) { if (M.playlist.length) playAt(M.currentIndex >= 0 ? M.currentIndex : 0); return; }
  if (a.paused) {
    M.pendingPlay = false;
    a.play().catch(e => { M.lastError = errMsg(e); updateBar(); });
  } else a.pause();
}

/**
 * 上一首 / 下一首。auto=true 表示是「一首放完了自动往后」，
 * 这时才听播放方式的：单曲循环原地重放，顺序播放到底就停。
 * 手动点下一首则永远有反应（到底就绕回第一首）。
 */
function playNext(auto) {
  const L = M.playlist.length;
  if (!L) return;
  if (auto && playMode() === 'single') return playAt(M.currentIndex);
  if (playMode() === 'shuffle' && L > 1) {
    let j = M.currentIndex;
    while (j === M.currentIndex) j = Math.floor(Math.random() * L);
    return playAt(j);
  }
  if (M.currentIndex < L - 1) return playAt(M.currentIndex + 1);
  if (auto) { M.isPlaying = false; updateBar(); updateMini(); return; }
  return playAt(0);
}
function playPrev() {
  const L = M.playlist.length;
  if (!L) return;
  if (playMode() === 'shuffle' && L > 1) {
    let j = M.currentIndex;
    while (j === M.currentIndex) j = Math.floor(Math.random() * L);
    return playAt(j);
  }
  if (M.currentIndex > 0) return playAt(M.currentIndex - 1);
  return playAt(L - 1);
}

function updateHL() {
  const l = $('#music-list'); if (!l) return;
  l.querySelectorAll('.mi').forEach((el, i) =>
    el.classList.toggle('playing', i === M.currentIndex && M.currentTab === 'search'));
}
function updateLoading(i) {
  const l = $('#music-list'); if (!l) return;
  l.querySelectorAll('.mi').forEach((el, k) =>
    el.classList.toggle('loading', k === i && M.currentTab === 'search'));
}
function updateBar() {
  const bar = $('#music-player'); if (!bar) return;
  const s = M.playlist[M.currentIndex];
  const title = bar.querySelector('.mp-title'), btn = bar.querySelector('.mp-play');
  const mode = bar.querySelector('.mp-mode');
  if (mode) mode.textContent = playModeIcon();
  try { if (HAS_NATIVE && Android.setMiniPlayMode) Android.setMiniPlayMode(playModeIcon()); } catch (e) {}
  if (M.loadingIndex >= 0) { title.textContent = '⏳ 加载中...'; btn.textContent = '⏳'; return; }
  if (M.lastError) { title.textContent = '❌ ' + M.lastError; btn.textContent = '▶'; return; }
  if (M.pendingPlay) {
    title.textContent = '▶ 点播放: ' + (s ? `${s.name} - ${s.artist}` : '');
    btn.textContent = '▶'; return;
  }
  title.textContent = s ? `${s.name} - ${s.artist}` : '未播放';
  btn.textContent = M.isPlaying ? '⏸' : '▶';
}
function updateMini() {
  const mini = $('#mini-player');
  const song = M.playlist[M.currentIndex];
  const show = !!song && !M.miniHidden;
  // 原生迷你悬浮窗：独立于聊天窗，缩成小球后依然可见、可拖动
  if (HAS_NATIVE && Android.showMiniPlayer) {
    try {
      if (show) {
        Android.showMiniPlayer(song.name || '未知歌曲', song.artist || '未知歌手', !!M.isPlaying);
        // 原生迷你条刚建出来时图标是默认的，这里补一次（updateBar 跑在它前面）
        if (Android.setMiniPlayMode) Android.setMiniPlayMode(playModeIcon());
      } else if (Android.hideMiniPlayer) Android.hideMiniPlayer();
    } catch (e) {}
    if (mini) mini.classList.remove('show');
    return;
  }
  // 没有原生环境时的网页内兑底
  if (!mini) return;
  if (!show) { mini.classList.remove('show'); return; }
  mini.querySelector('.mini-name').textContent = song.name || '未知歌曲';
  mini.querySelector('.mini-artist').textContent = song.artist || '未知歌手';
  mini.querySelector('.mini-play').textContent = M.isPlaying ? '⏸' : '▶';
  mini.classList.add('show');
  mini.classList.toggle('playing', M.isPlaying);
}

/* ==========================================================
 *  原生播放器 ↔ 网页的双向对账
 *  原生只管出声，歌单 / 歌词 / 播放顺序都在 JS 这边，
 *  所以通知栏和耳机上的按键都会绕回 __mpCmd 再由 JS 决定切哪一首。
 * ========================================================== */
window.__mpState = function (json) {
  let s = {};
  try { s = typeof json === 'string' ? JSON.parse(json) : (json || {}); } catch (e) { return; }
  M.isPlaying = !!s.playing;
  if (typeof s.dur === 'number' && s.dur) M.dur = s.dur;
  if (typeof s.pos === 'number' && !s.playing) M.pos = s.pos;
  if (s.err) M.lastError = s.err;
  if (!s.loading && M.loadingIndex >= 0) { M.loadingIndex = -1; updateLoading(-1); }
  updateBar(); updateHL(); updateMini(); updateProgress();
};
window.__mpProgress = function (pos, dur) {
  M.pos = pos || 0;
  if (dur) M.dur = dur;
  updateProgress();
  onLyricTime();
};
window.__mpDone = function () {
  M.isPlaying = false;
  M.pos = 0;
  playNext(true);
};
window.__mpCmd = function (cmd) {
  try {
    if (cmd === 'next') playNext(false);
    else if (cmd === 'prev') playPrev();
    else if (cmd === 'stop') { M.isPlaying = false; M.miniHidden = true; updateBar(); updateMini(); }
  } catch (e) {}
};

/* 原生迷你播放器上的按钮（旧接口，保留兼容） */
window.__miniToggle = function () { try { togglePlay(); } catch (e) {} };
window.__miniMode = function () { try { cyclePlayMode(); } catch (e) {} };
window.__miniClose = function () {
  M.miniHidden = true;
  try { if (MP()) MP().mpStop(); else if (M.audio) M.audio.pause(); } catch (e) {}
  updateBar(); updateMini();
};
window.__miniOpen = function () {
  try { if (HAS_NATIVE && Android.restoreFloat) Android.restoreFloat(); } catch (e) {}
  try { M.currentTab = 'search'; renderList(M.playlist); showView('music'); } catch (e) {}
};
function setLyric(t) {
  const el = $('#music-lyric');
  let line = t;
  if (!line) {
    if (M.currentIndex >= 0 && M.playlist[M.currentIndex]) line = '';
  }
  // 原生迷你播放条上也带一行歌词，缩成小球之后也看得到
  try { if (HAS_NATIVE && Android.setMiniLyric) Android.setMiniLyric(line || ''); } catch (e) {}
  if (!el) return;
  if (t) { el.textContent = t; el.classList.add('hl'); }
  else if (M.currentIndex >= 0 && M.playlist[M.currentIndex]) {
    el.textContent = '♪ ' + M.playlist[M.currentIndex].name + ' ♪';
    el.classList.remove('hl');
  } else { el.textContent = '— ♪ —'; el.classList.remove('hl'); }
}
function onLyricTime() {
  if (!M.lyrics.length) return;
  const t = M.pos / 1000;
  let idx = -1;
  for (let i = 0; i < M.lyrics.length; i++) {
    if (M.lyrics[i].t <= t) idx = i; else break;
  }
  if (idx !== M.lyricIndex) {
    M.lyricIndex = idx;
    setLyric(idx >= 0 ? M.lyrics[idx].text : '');
    updateLyricModal();
  }
}
function updateLyricModal() {
  const box = $('#lyric-modal .lyric-content'); if (!box) return;
  if (!M.lyrics.length) { box.innerHTML = '<div class="lline" style="opacity:.5">暂无歌词~</div>'; return; }
  box.innerHTML = M.lyrics.map((l, i) =>
    `<div class="lline ${i === M.lyricIndex ? 'active' : ''}" data-i="${i}">${esc(l.text)}</div>`).join('');
  const act = box.querySelector('.active');
  if (act) act.scrollIntoView({ block: 'center', behavior: 'smooth' });
  box.querySelectorAll('.lline').forEach(el => el.onclick = () => {
    const i = +el.dataset.i;
    if (!M.lyrics[i]) return;
    const ms = Math.round(M.lyrics[i].t * 1000);
    const n = MP();
    if (n) { try { n.mpSeek(ms); } catch (e) {} }
    else if (M.audio) M.audio.currentTime = M.lyrics[i].t;
    M.lyricIndex = -1; onLyricTime();
  });
}
function musicTabItems(tab) {
  if (tab === 'fav') return favorites.slice();
  if (tab === 'history') return M.history.slice();
  if (tab === 'queue') return M.queue.slice();
  if (tab === 'cache') return M.cache.filter(song => cachedMusicPath(song) || song.status === 'downloading' || song.status === 'failed');
  return M.playlist.slice();
}
function renderMusicTab(tab) {
  M.currentTab = tab || M.currentTab || 'search';
  $$('.mtab').forEach(t => t.classList.toggle('active', t.dataset.tab === M.currentTab));
  const search = $('#ms-wrap');
  if (search) search.style.display = M.currentTab === 'search' ? 'flex' : 'none';
  if (M.currentTab !== 'search') M.playlist = musicTabItems(M.currentTab);
  else M.playlist = M.searchResults.slice();
  renderList(musicTabItems(M.currentTab));
  const more = $('#music-more');
  if (more) more.hidden = M.currentTab !== 'search' || !M.hasMore;
  const cacheInfo = $('#music-cache-info'); if (cacheInfo) cacheInfo.hidden = M.currentTab !== 'cache';
  const clear = $('#music-clear-cache'); if (clear) clear.hidden = M.currentTab !== 'cache';
  renderMusicCacheInfo();
}
function addSongToQueue(song) {
  const added = musicAddQueue(song);
  toast(added ? '已加入播放队列' : '这首歌已经在队列里');
  if (M.currentTab === 'queue') renderMusicTab('queue');
}
let MUSIC_CONTEXT_SONG = null;
function closeMusicContext() {
  const menu = $('#music-context-menu'); if (menu) menu.hidden = true;
  MUSIC_CONTEXT_SONG = null;
}
function openMusicContext(song, clientX, clientY, index) {
  const menu = $('#music-context-menu'); if (!menu || !song) return;
  MUSIC_CONTEXT_SONG = { song, index };
  const cached = !!cachedMusicPath(song) || song.status === 'ready';
  const title = $('#music-context-title'); if (title) title.textContent = song.name + ' · ' + (song.artist || '未知歌手');
  const cacheBtn = menu.querySelector('[data-music-action="cache"]');
  if (cacheBtn) cacheBtn.textContent = cached ? '删除缓存文件' : '缓存下载';
  const deleteBtn = menu.querySelector('[data-music-action="delete"]');
  if (deleteBtn) {
    deleteBtn.hidden = !['history', 'cache', 'queue'].includes(M.currentTab);
    deleteBtn.textContent = M.currentTab === 'history' ? '删除历史记录' : M.currentTab === 'cache' ? '删除缓存文件' : '移出播放队列';
  }
  const host = $('#music');
  const r = host ? host.getBoundingClientRect() : { left: 0, top: 0, width: 320, height: 600 };
  menu.style.left = Math.max(8, Math.min(r.width - 188, clientX - r.left - 80)) + 'px';
  menu.style.top = Math.max(56, Math.min(r.height - 250, clientY - r.top - 30)) + 'px';
  menu.hidden = false;
}
function handleMusicContextAction(action) {
  const item = MUSIC_CONTEXT_SONG; if (!item) return;
  const song = item.song;
  if (action === 'play') {
    const index = M.playlist.findIndex(x => musicSongKey(x) === musicSongKey(song));
    if (index >= 0) playAt(index);
  } else if (action === 'queue') addSongToQueue(song);
  else if (action === 'favorite') toggleFav(song);
  else if (action === 'cache') {
    if (cachedMusicPath(song) || song.status === 'ready') {
      uiConfirm('删除这首歌的本地缓存文件？', '删除缓存', '音乐缓存').then(ok => { if (ok) removeCachedMusic(song); closeMusicContext(); });
    } else cacheMusicSong(song);
  } else if (action === 'delete') {
    if (M.currentTab === 'history') {
      uiConfirm('删除这条播放历史？', '删除历史', '播放历史').then(ok => {
        if (!ok) return;
        M.history = M.history.filter(x => musicSongKey(x) !== musicSongKey(song)); musicPlayHistory = M.history; sSet('via_ai_music_history', M.history); renderMusicTab('history'); closeMusicContext();
      }); return;
    } else if (M.currentTab === 'cache') {
      uiConfirm('删除这首歌的本地缓存文件？', '删除缓存', '音乐缓存').then(ok => { if (ok) removeCachedMusic(song); closeMusicContext(); }); return;
    }
    else if (M.currentTab === 'queue') { musicRemoveQueue(song); renderMusicTab('queue'); }
  }
  if (action !== 'cache' || !(M.downloads[musicCacheId(song)] && M.downloads[musicCacheId(song)].status === 'downloading')) closeMusicContext();
}
function bindMusicContextMenu() {
  const menu = $('#music-context-menu'); if (!menu) return;
  menu.onclick = e => { const b = e.target.closest ? e.target.closest('[data-music-action]') : null; if (b) handleMusicContextAction(b.dataset.musicAction); };
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) closeMusicContext(); });
}
function renderList(items) {
  const l = $('#music-list');
  if (!l) return;
  if (!items.length) {
    const empty = M.currentTab === 'fav' ? '还没有收藏的歌~' : M.currentTab === 'history' ? '还没有播放历史~' : M.currentTab === 'queue' ? '播放队列还是空的~' : M.currentTab === 'cache' ? '还没有缓存歌曲~' : '没找到相关歌曲~';
    l.innerHTML = `<div class="mempty">${empty}</div>`;
    return;
  }
  l.innerHTML = '';
  items.forEach((song, i) => {
    const d = document.createElement('div'); d.className = 'mi';
    const source = CONFIG.musicShowSource === false ? '' : `<div class="msource">${esc(song.provider || song.source || '音乐源')}${song.catalog ? ' · ' + esc(song.catalog) : ''}</div>`;
    d.innerHTML = `<div class="mcover">${song.coverUrl ? `<img src="${esc(song.coverUrl)}" alt="" loading="lazy">` : '<span>♪</span>'}</div>
      <div class="midx">${i + 1}</div>
      <div class="minfo"><div class="mname">${esc(song.name)}</div><div class="mart">${esc(song.artist)}</div>${source}</div>
      <div class="mdur">${fmtDur(song.duration)}</div>`;
    const img = d.querySelector('.mcover img');
    if (img) img.onerror = () => { img.remove(); const span = document.createElement('span'); span.textContent = '♪'; d.querySelector('.mcover').appendChild(span); };
    let hold = null; let longPressed = false;
    const cancel = () => { if (hold) { clearTimeout(hold); hold = null; } };
    d.addEventListener('touchstart', e => { cancel(); longPressed = false; const p = e.touches[0]; hold = setTimeout(() => { longPressed = true; openMusicContext(song, p.clientX, p.clientY, i); hold = null; }, 600); }, { passive: true });
    d.addEventListener('touchmove', cancel, { passive: true });
    d.addEventListener('touchend', cancel, { passive: true });
    d.addEventListener('contextmenu', e => { e.preventDefault(); openMusicContext(song, e.clientX, e.clientY, i); });
    d.onclick = () => { if (longPressed) { longPressed = false; return; } playAt(i); };
    l.appendChild(d);
  });
  updateHL(); updateLoading(M.loadingIndex);
}

/* ==========================================================
 *  AI 音乐工具
 * ========================================================== */
function buildTools(runTask) {
  const tools = [];
  const exposedTask = runTask || currentTask();
  const a11yOk = HAS_PERM && Perm.hasAccessibility ? (function () {
    try { return !!Perm.hasAccessibility(); } catch (e) { return false; }
  })() : false;
  const shotOk = HAS_PERM && Perm.canScreenshot ? (function () {
    try { return !!Perm.canScreenshot(); } catch (e) { return false; }
  })() : false;

  if (a11yOk) {
    tools.push({ type: 'function', function: {
        name: 'read_screen',
        description: '读取当前屏幕：返回可交互控件（可点击/可输入/密码框/可滚动）和它们的比例坐标 rx/ry（0~1，相对屏幕中心）。需要更多文本时用 detail:"more"，需要完整节点时用 detail:"full" 分页获取。',
        parameters: { type: 'object', properties: {
          detail: { type: 'string', enum: ['basic', 'more', 'full'], description: 'basic=可交互控件（默认）；more=再加文本行；full=全量节点分页' },
          page: { type: 'integer', description: 'detail=full 时的页码，从 1 开始' }
        }, required: [] } } });
    tools.push({ type: 'function', function: {
        name: 'get_current_page',
        description: '获取用户当前浏览器正在访问的网页地址（URL）。需要链接、想分析或打开当前页面时调用。',
        parameters: { type: 'object', properties: {}, required: [] } } });
  }
  if (shotOk) {
    tools.push({ type: 'function', function: {
        name: 'screenshot',
        description: '截取用户当前手机屏幕的画面。用户说"看我屏幕""截图看看""我现在在干什么""识别屏幕上的东西"时调用，调用后屏幕画面会交给你查看。',
        parameters: { type: 'object', properties: {}, required: [] } } });
    tools.push({ type: 'function', function: {
        name: 'watch_screen',
        description: '在用户明确要求观察一段时间时使用。限定观察时长 1 到 10 秒、每秒 1 到 2 帧，只返回少量关键画面；不会后台持续监控。',
        parameters: { type: 'object', properties: {
          seconds: { type: 'integer', description: '观察秒数，默认 5，最长 10' },
          fps: { type: 'integer', description: '每秒帧数，默认 1，最多 2' }
        }, required: [] } } });
  }
  tools.push({ type: 'function', function: {
      name: 'open_url',
      description: '用系统浏览器打开一个网址。用户让你"打开某网站/打开这个链接"时调用。',
      parameters: { type: 'object', properties: {
        url: { type: 'string', description: '完整网址，需带 http:// 或 https://' }
      }, required: ['url'] } } });
  tools.push({ type: 'function', function: {
      name: 'set_clipboard',
      description: '把一段文字写入系统剪贴板，方便用户直接粘贴。',
      parameters: { type: 'object', properties: {
        text: { type: 'string', description: '要复制的文字' }
      }, required: ['text'] } } });
  tools.push({ type: 'function', function: {
      name: 'fetch_url',
      description: '读取一个网页的正文（自动去掉脚本和样式，返回标题和文本）。用户给出网址、让你看链接内容、总结网页时调用。只支持 http/https 公网地址。',
      parameters: { type: 'object', properties: {
        url: { type: 'string', description: '完整网址，需带 http:// 或 https://' },
        max_chars: { type: 'integer', description: '最多返回多少字，默认 8000，范围 500-20000' }
      }, required: ['url'] } } });
  tools.push({ type: 'function', function: {
      name: 'web_search',
      description: '按关键词搜索网页，返回标题、链接和摘要。需要查资料、找官网、确认最新信息时先用它，再用 fetch_url 深读结果。',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: '搜索关键词，最多 200 字' },
        count: { type: 'integer', description: '返回条数，默认 8，范围 1-10' }
      }, required: ['query'] } } });

  if (agentReadOn()) {
    tools.push({ type: 'function', function: {
      name: 'find_app', description: '按用户给出的应用名称或包名查询当前设备实际可启动的应用。打开 QQ、微信等应用前先调用，不要猜包名。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '应用显示名或包名，如 QQ、电话、com.tencent.mobileqq' } }, required: ['query'] } } });
  }
  if (agentActionsOn()) {
    tools.push({ type: 'function', function: {
      name: 'tap_screen', description: '点击屏幕上的位置。优先用 read_screen 返回的 rx/ry（比例坐标，0~1）；也兼容像素 x/y。',
      parameters: { type: 'object', properties: {
        rx: { type: 'number', description: '目标点横坐标占屏幕宽度的比例，0~1' },
        ry: { type: 'number', description: '目标点纵坐标占屏幕高度的比例，0~1' },
        x: { type: 'integer', description: '兼容：像素横坐标' },
        y: { type: 'integer', description: '兼容：像素纵坐标' }
      }, required: [] } } });
    tools.push({ type: 'function', function: {
      name: 'click_text', description: '按文字或 content description 点击当前页面控件，优先于猜坐标。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } });
    tools.push({ type: 'function', function: {
      name: 'swipe_screen', description: '在屏幕上滑动或滚动。优先用比例坐标 rx1/ry1 → rx2/ry2。',
      parameters: { type: 'object', properties: {
        rx1: { type: 'number' }, ry1: { type: 'number' }, rx2: { type: 'number' }, ry2: { type: 'number' },
        x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
        duration: { type: 'integer', description: '毫秒，80 到 2000，默认 350' }
      }, required: [] } } });
    tools.push({ type: 'function', function: {
      name: 'input_text', description: '向当前获得焦点的输入控件输入文字。如果焦点是密码框，会先请用户确认（内容不会被记录）。',
      parameters: { type: 'object', properties: {
        text: { type: 'string' },
        nodeIndex: { type: 'integer', description: '可选：read_screen 返回的节点 i，用于明确指定目标' }
      }, required: ['text'] } } });
    tools.push({ type: 'function', function: {
      name: 'press_key', description: '执行 back、home、recents、notifications 系统按键，或 enter（提交当前输入框，例如聊天里的发送）。发送前会请用户确认。',
      parameters: { type: 'object', properties: { key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'enter'] } }, required: ['key'] } } });
    tools.push({ type: 'function', function: {
      name: 'launch_app', description: '按应用显示名或包名启动白名单中的应用。会先在设备上解析真实包名，再执行白名单检查。',
      parameters: { type: 'object', properties: {
        app: { type: 'string', description: '应用显示名或包名' },
        package: { type: 'string', description: '兼容旧版本的包名参数' }
      }, required: [] } } });
  }

  if (hasAllFilesAccess() && agentLevelAtLeast('L1')) {
    tools.push({ type: 'function', function: {
      name: 'workspace_status', description: '查看允许管理所有文件权限和 ElysiaFloat 工作区是否已创建。',
      parameters: { type: 'object', properties: {}, required: [] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_create', description: '创建用户的 ElysiaFloat 工作区。',
      parameters: { type: 'object', properties: {}, required: [] } } });
  }
  if (workspaceReady() && agentLevelAtLeast('L2')) {
    tools.push({ type: 'function', function: {
      name: 'workspace_list', description: '列出工作区内的文件或目录。path 为空表示根目录。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_read', description: '读取工作区内的文本文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_write', description: '创建或写入工作区内的文本文件。工作区是受控写入区，不需要逐次确认；覆盖前会自动留快照。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path', 'content'] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_mkdir', description: '在工作区内创建目录，不需要逐次确认。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_preview',
      description: '快速预览工作区里的文件：返回类型、大小、行数和开头一段内容。想确认导出的结果对不对时用它，不要整份读进来。',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: '工作区内相对路径，如 output/周报.md' },
        max_chars: { type: 'integer', description: '预览长度，默认 1500，最多 8000' }
      }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'workspace_export',
      description: '把结果导出成文件到任务工作区的 output/ 目录。支持 md / txt / csv / json / html；json 会先校验格式，html 不是完整文档时会自动补基础外壳。不需要用户确认。',
      parameters: { type: 'object', properties: {
        format: { type: 'string', enum: ['md', 'txt', 'csv', 'json', 'html'], description: '导出格式' },
        content: { type: 'string', description: '文件内容' },
        path: { type: 'string', description: '可选：相对 output/ 的路径，如 report.md；不填则自动命名' },
        title: { type: 'string', description: '可选：标题，用于自动文件名和 html 外壳' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖' }
      }, required: ['format', 'content'] } } });
  }
  if (hasAllFilesAccess() && agentLevelAtLeast('L3')) {
    tools.push({ type: 'function', function: {
      name: 'external_file_list', description: '列出手机公共存储中的目录。读取操作不修改文件。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径或公共存储根目录下的相对路径' } }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'external_file_read', description: '读取手机公共存储中的文本文件。读取操作不修改文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'external_file_write', description: '写入或覆盖公共存储中的文本文件；每次修改前会弹窗请求用户确认。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path', 'content'] } } });
    tools.push({ type: 'function', function: {
      name: 'external_file_copy', description: '复制公共存储中的文件；写入目标前会弹窗请求用户确认。',
      parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['source', 'destination'] } } });
    tools.push({ type: 'function', function: {
      name: 'external_file_mkdir', description: '在公共存储中创建目录；执行前会弹窗请求用户确认。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } });
    tools.push({ type: 'function', function: {
      name: 'external_file_delete', description: '删除公共存储中的文件或目录；这是高风险操作，每次执行前都会弹窗请求用户确认。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] } } });
  }
  if (exposedTask.type === 'workspace' && workspaceReady() && agentActionsOn() && HAS_PERM && Perm.getTermuxWorkerState) {
    let termux = false; try { termux = JSON.parse(Perm.getTermuxWorkerState() || '{}').installed === true; } catch (e) {}
    if (termux) {
      tools.push({ type: 'function', function: {
        name: 'run_termux_job', description: '在当前工作任务目录中运行一个结构化 Termux 工具（支持长跑进程如服务器、bot）。只允许 python/node/git/rg/ffmpeg/java/bash，不接受 shell 字符串；执行前必须确认命令、参数和目录。返回 runId 用于后续查询状态和输出。',
        parameters: { type: 'object', properties: { executor: { type: 'string', enum: ['python','node','git','rg','ffmpeg','java','bash'] }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string', description: '当前任务工作区内的相对目录' } }, required: ['executor','args'] } } });
      tools.push({ type: 'function', function: {
        name: 'termux_job_status', description: '查询 Termux 任务状态和最近输出。状态可能是 running / done / failed。',
        parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } } });
      tools.push({ type: 'function', function: {
        name: 'termux_job_output', description: '读取 Termux 任务的输出日志，可指定偏移量实现流式读取。',
        parameters: { type: 'object', properties: { runId: { type: 'string' }, offset: { type: 'integer', description: '上次返回的 nextOffset，从 0 开始' } }, required: ['runId'] } } });
      tools.push({ type: 'function', function: {
        name: 'termux_job_cancel', description: '取消一个正在运行的 Termux 任务（先 TERM 后 KILL）。',
        parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } } });
      tools.push({ type: 'function', function: {
        name: 'termux_jobs_list', description: '列出当前任务下所有 Termux 任务及其状态。',
        parameters: { type: 'object', properties: {}, required: [] } } });
    }
  }
  if (exposedTask.type === 'workspace' && agentActionsOn() && HAS_PERM && Perm.getAgentRuntimeState) {
    let root = false; try { root = JSON.parse(Perm.getAgentRuntimeState() || '{}').rootAvailable === true; } catch (e) {}
    if (root) tools.push({ type: 'function', function: {
      name: 'root_operation', description: '执行受控 Root 操作，只允许 id、getprop、task_files、list_processes、kill_process；执行前必须确认。',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['id','getprop','task_files','list_processes','kill_process'] }, pid: { type: 'integer', description: 'kill_process 时需要的进程 PID' } }, required: ['operation'] } } });
  }

  const musicToolsOn = plugOn('music') && !!CONFIG.musicEnabled;
  if (musicToolsOn) {
  tools.push({ type: 'function', function: {
        name: 'search_and_play_music',
        description: '搜索并播放音乐。用户想听歌/找歌时调用。',
        parameters: { type: 'object', properties: {
          keyword: { type: 'string', description: '搜索词，如"周杰伦 稻香"' },
          action: { type: 'string', enum: ['play', 'search'], description: 'play 立即播放第一首；search 只展示列表' }
        }, required: ['keyword'] } } });
  tools.push({ type: 'function', function: {
        name: 'music_control',
        description: '控制音乐播放。',
        parameters: { type: 'object', properties: {
          command: { type: 'string', enum: ['pause', 'resume', 'next', 'prev', 'stop', 'favorite'], description: '命令' }
        }, required: ['command'] } } });


  }

  /* ---- 长期记忆 ---- */
  tools.push({ type: 'function', function: {
        name: 'list_memories',
        description: '检索/浏览你的长期记忆库。返回编号、分类、标题和正文摘要。用户问"你记得我什么""我之前说过什么""关于 X 的事"，或你想确认某件事是否记过时，先调它。记忆很多时用 keyword 缩小范围。',
        parameters: { type: 'object', properties: {
          keyword: { type: 'string', description: '搜索关键词，留空则按分类/时间列' },
          category: { type: 'string', description: '限定分类，如"关于你""项目"；留空表示全部' },
          limit: { type: 'integer', description: '最多返回几条，默认 15' }
        }, required: [] } } });
  tools.push({ type: 'function', function: {
        name: 'read_memory',
        description: '按编号读取长期记忆的完整正文。list_memories 只给标题和摘要，看标题不够时用它读全文（可一次传多个 id）。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', description: '记忆编号' },
          ids: { type: 'array', items: { type: 'string' }, description: '一次读多条' }
        }, required: [] } } });
  tools.push({ type: 'function', function: {
        name: 'list_memory_categories',
        description: '列出记忆库里现有的分类和每类条数。不确定新记忆该归到哪一类时先看看。',
        parameters: { type: 'object', properties: {}, required: [] } } });
  tools.push({ type: 'function', function: {
        name: 'save_memory',
        description: '新增一条长期记忆。用户透露了值得长期记住的偏好、事实、约定或进展时调用。类别相同也可以新增；只有正文高度相似且属于同一事实时才合并。系统合并时会保留原文并追加，不会缩短原文。日常闲聊、一次性信息不要存。',
        parameters: { type: 'object', properties: {
          title: { type: 'string', description: '一句话标题，简短好搜，如"用户喜欢喝无糖可乐"' },
          content: { type: 'string', description: '正文，把背景和细节写清楚' },
          category: { type: 'string', description: '分类，优先用已有分类，不合适再新建。默认"其他"' },
          tags: { type: 'array', items: { type: 'string' }, description: '2~5 个关键词标签，方便以后检索' },
          pinned: { type: 'boolean', description: '是否置为重要（常驻记忆），只在确实很重要时设 true' }
        }, required: ['title', 'content'] } } });
  tools.push({ type: 'function', function: {
        name: 'update_memory',
        description: '仅用于同一事实的高度相似补充或明确修订。默认保留原文并在末尾追加；只有用户明确要求修订原文时才传 replace=true。新的事实或相似度不足的内容应使用 save_memory 新增。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', description: '记忆编号' },
          title: { type: 'string' }, content: { type: 'string' },
          category: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean' },
          replace: { type: 'boolean', description: '仅在用户明确要求修订原文时设为 true；否则保留原文并追加。' }
        }, required: ['id'] } } });
  tools.push({ type: 'function', function: {
        name: 'pin_memory',
        description: '把某条记忆设为/取消「重要」。重要的记忆会常驻在每轮对话里。',
        parameters: { type: 'object', properties: {
          id: { type: 'string' },
          pinned: { type: 'boolean', description: 'true 设为重要，false 取消' }
        }, required: ['id'] } } });
  tools.push({ type: 'function', function: {
        name: 'delete_memory',
        description: '删除一条长期记忆。危险操作：只有用户本人明确指名要删某条记忆时才可调用，系统会再向用户弹窗确认，用户不同意就作废。不要自己决定删。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', description: '要删除的记忆编号' },
          reason: { type: 'string', description: '为什么要删，会展示给用户看' }
        }, required: ['id'] } } });
  /* ---- 自定义插件 ---- */
  USER_PLUGINS.forEach(p => {
    if (p.enabled === false) return;
    p.tools.forEach(t => {
      if (!toolOn(t.name)) return;
      tools.push({ type: 'function', function: {
        name: t.name,
        description: t.description || ('自定义插件「' + p.name + '」提供的工具。'),
        parameters: t.parameters || { type: 'object', properties: {} }
      }});
    });
  });
  // 与提示词用完全同一套开关判断，避免出现「提示词里说了但调不了」
  // 或者「能调但没告诉它」这种不一致。插件面板上的开关就是这里在生效。
  return tools.filter(t => toolLive(t.function.name));
}
async function execTool(name, args, runTask) {
  const task = runTask || currentTask();
  if (!toolLive(name)) return { success: false, error: '该工具当前未获授权或已关闭。' };
  if (!taskToolsAllowed(task.type, name, task.id)) return { success: false, error: '当前任务类型不能调用该工具，请切换到对应任务模式。' };
  args = args && typeof args === 'object' ? Object.assign({}, args) : {};
  const scoped = ['workspace_list','workspace_read','workspace_write','workspace_mkdir'];
  if (scoped.indexOf(name) >= 0 && task.type === 'workspace') args.path = taskWorkspacePath(task, args.path || '');
  const cp = plugFind(name);
  if (cp) {
    const pt = cp.plugin.pluginType || 'chat';
    if ((pt === 'workspace' && task.type !== 'workspace') || (pt === 'device' && task.type !== 'device' && task.type !== 'quick' && !(task.type === 'workspace' && consentGranted(task.id, 'device'))) || (pt === 'quick' && task.type === 'chat')) return { success: false, error: '当前任务类型不能调用该类型插件。' };
    if (cp.plugin.enabled === false) return { success: false, error: '该插件已停用。' };
    if (!toolOn(name)) return { success: false, error: '该工具已关闭。' };
    return await plugExec(cp.plugin, cp.tool, args || {}, task);
  }
  if (name === 'read_screen_once') {
    const t = HAS_PERM && Perm.getScreenTextOnce ? Perm.getScreenTextOnce() : '';
    return t ? { success: true, text: String(t).slice(0, 12000) } : { success: false, error: '读不到屏幕内容（可能无障碍未开启，或当前界面没有可读文字）' };
  }
  if (name === 'read_screen') {
    // G5-2：默认返回结构化摘要（含比例坐标）；detail 可要更多文本或全量分页
    const d = screenDigest({ detail: String(args.detail || 'basic'), page: args.page });
    const hasText = (d.tier0 && d.tier0.length) || (d.tier1 && d.tier1.length) || d.count > 0;
    if (!hasText) {
      const t = readScreenText();
      if (!t) return { success: false, errorCode: 'NO_TEXT', error: '读不到屏幕内容（可能无障碍未开启，或当前界面没有可读文字）' };
      return { success: true, text: t.slice(0, 6000), digest: d };
    }
    return Object.assign({ success: true }, d);
  }
  if (name === 'get_current_page') {
    const u = currentPageUrl();
    return u ? { success: true, url: u } : { success: false, error: '没有识别到浏览器地址栏' };
  }
  if (name === 'find_app') {
    if (!(HAS_PERM && Perm.findAgentApps)) return { success: false, error: '当前版本没有设备应用查询能力' };
    try {
      const list = JSON.parse(Perm.findAgentApps(String(args.query || '')) || '[]');
      return list.length ? { success: true, count: list.length, apps: list } : { success: false, error: '设备上没有找到匹配的可启动应用' };
    } catch (e) { return { success: false, error: '应用查询失败：' + errMsg(e) }; }
  }
  if (name === 'screenshot') {
    // G2-005：任务内已获准操作手机后，截图不再每次重复询问
    const shotOk = CONFIG.agentAutoShot === true || consentGranted(task.id, 'device');
    if (CONFIG.agentEnabled === true && CONFIG.agentL2 !== false && !shotOk) {
      const ok = await uiConfirm('Agent 想查看当前手机画面。截图可能包含聊天、验证码或其它隐私内容，是否继续？', '允许截图', '查看手机画面');
      if (!ok) return { success: false, kind: 'cancelled', error: '用户取消了本轮截图' };
    }
    agentCapsuleOn('正在截取屏幕');
    const shot = await captureScreenJS();
    if (!shot) { agentCapsuleState('截屏失败', 'done'); return { success: false, error: '截屏失败：请确认无障碍已开启（Android 11+），或同意录屏授权' }; }
    pendingShotImage = shot;
    pendingShotImages = [shot];
    agentCapsuleState('已取得屏幕画面', 'busy');
    return { success: true, note: '已截取当前屏幕画面，画面会在下一条消息里给你看。' };
  }
  if (name === 'watch_screen') {
    const watchOk = CONFIG.agentAutoShot === true || consentGranted(task.id, 'device');
    if (CONFIG.agentEnabled === true && CONFIG.agentL2 !== false && !watchOk) {
      const ok = await uiConfirm('Agent 想在限定时间内观察当前手机画面。最多 10 秒、每秒 2 帧，是否继续？', '允许观察', '观察手机画面');
      if (!ok) return { success: false, kind: 'cancelled', error: '用户取消了本轮观察' };
    }
    agentCapsuleOn('正在观察屏幕');
    const result = await watchScreenFrames(args || {});
    agentCapsuleState(result.frames ? '观察完成，正在分析' : '没有取得画面', 'busy');
    return result;
  }
  if (name === 'run_termux_job') {
    const runTaskObj = task;
    if (runTaskObj.type !== 'workspace') return { success: false, errorCode: 'TASK_TYPE_DENIED', error: 'Termux 只能在工作任务中运行' };
    // 原生 runId 只接受 [A-Za-z0-9_-]，插件任务 id 是反域名（plug-com.xxx.runtime）带点，
    // 直接拼会被判「任务 id 不合法」；这里只清洗 jobId，taskId 仍保留原名给工作区用。
    const jobKey = String(runTaskObj.id || 'task').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const job = { jobId: jobKey + '-' + Date.now().toString(36), taskId: runTaskObj.id, executor: String(args.executor || ''), args: Array.isArray(args.args) ? args.args.map(String) : [], cwd: String(args.cwd || 'working') };
    if (!(await uiConfirm('即将通过 Termux 执行：' + job.executor + '\n参数：' + JSON.stringify(job.args) + '\n目录：' + job.cwd + '\n是否继续？', '确认执行', 'Termux 任务确认'))) return { success: false, kind: 'cancelled', error: '用户取消了 Termux 任务' };
    try { return JSON.parse(Perm.dispatchTermuxJob ? (Perm.dispatchTermuxJob(JSON.stringify(job)) || '{}') : '{}'); }
    catch (e) { return { success: false, errorCode: 'TERMUX_DISPATCH_FAILED', error: errMsg(e) }; }
  }
  if (name === 'termux_job_status') {
    try { return JSON.parse(Perm.getTermuxJobStatus ? (Perm.getTermuxJobStatus(String(args.runId || '')) || '{}') : '{}'); }
    catch (e) { return { success: false, errorCode: 'TERMUX_STATUS_FAILED', error: errMsg(e) }; }
  }
  if (name === 'termux_job_output') {
    try { return JSON.parse(Perm.readTermuxJobOutput ? (Perm.readTermuxJobOutput(String(args.runId || ''), parseInt(args.offset, 10) || 0) || '{}') : '{}'); }
    catch (e) { return { success: false, errorCode: 'TERMUX_OUTPUT_FAILED', error: errMsg(e) }; }
  }
  if (name === 'termux_job_cancel') {
    if (!(await uiConfirm('确定要取消 Termux 任务 ' + String(args.runId || '') + ' 吗？', '确认取消', 'Termux 取消确认'))) return { success: false, kind: 'cancelled', error: '用户取消了操作' };
    try { return JSON.parse(Perm.cancelTermuxJob ? (Perm.cancelTermuxJob(String(args.runId || '')) || '{}') : '{}'); }
    catch (e) { return { success: false, errorCode: 'TERMUX_CANCEL_FAILED', error: errMsg(e) }; }
  }
  if (name === 'termux_jobs_list') {
    try { return JSON.parse(Perm.listTermuxJobs ? (Perm.listTermuxJobs(task.id) || '{}') : '{}'); }
    catch (e) { return { success: false, errorCode: 'TERMUX_LIST_FAILED', error: errMsg(e) }; }
  }
  if (name === 'root_operation') {
    const runTaskObj = task;
    if (!(await uiConfirm('即将执行受控 Root 操作：' + String(args.operation || '') + (args.pid ? ' pid=' + args.pid : '') + '\n是否继续？', '确认 Root 操作', 'Root 确认'))) return { success: false, kind: 'cancelled', error: '用户取消了 Root 操作' };
    try {
      const extra = args.pid ? JSON.stringify({ pid: parseInt(args.pid, 10) }) : '{}';
      return JSON.parse(Perm.runRootOperation ? (Perm.runRootOperation(String(args.operation || ''), runTaskObj.id, extra) || '{}') : '{}');
    }
    catch (e) { return { success: false, errorCode: 'ROOT_FAILED', error: errMsg(e) }; }
  }
  if (name === 'workspace_status') {
    try {
      const t = task;
      if (t.type === 'workspace') return taskWorkspaceState(t) || { success: false, error: '无法读取任务工作区状态' };
      return JSON.parse(Perm.workspaceState ? (Perm.workspaceState() || '{}') : '{}');
    } catch (e) { return { success: false, error: '无法读取工作区状态' }; }
  }
  if (name === 'workspace_create') {
    // 已经在工作任务里时不再二次确认（进入任务模式时用户已确认过）
    if (task.type !== 'workspace' && !(await uiConfirm('AI 请求创建 ElysiaFloat 工作区，并可能创建 README.md。是否确认？', '确认创建', '工作区创建确认'))) {
      return { success: false, kind: 'cancelled', error: '用户没有允许创建工作区' };
    }
    try { return JSON.parse(Perm.createWorkspace ? (Perm.createWorkspace() || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法创建工作区：' + errMsg(e) }; }
  }
  if (name === 'workspace_list') {
    try { return JSON.parse(Perm.agentWorkspaceList ? (Perm.agentWorkspaceList(String(args.path || '')) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法列出工作区：' + errMsg(e) }; }
  }
  if (name === 'workspace_read') {
    try { return JSON.parse(Perm.agentWorkspaceRead ? (Perm.agentWorkspaceRead(String(args.path || ''), parseInt(args.max_chars, 10) || 120000) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法读取工作区文件：' + errMsg(e) }; }
  }
  if (name === 'workspace_write') {
    const path = String(args.path || '').trim();
    const content = String(args.content == null ? '' : args.content);
    const overwrite = args.overwrite === true;
    // 工作区是受控写入区：用户决定工作区内写入/导出/复制不再逐次确认，
    // 原生侧仍用 canonical 路径把写入锁在任务工作区内（无法 ../ 逃逸）。
    let snapshot = null;
    const wt = task;
    if (wt.type === 'workspace' && wt.workspaceReady && HAS_PERM && Perm.snapshotTaskFile) {
      try { snapshot = JSON.parse(Perm.snapshotTaskFile(wt.id, taskRelPath(wt, path)) || '{}'); } catch (e) { snapshot = null; }
    }
    try {
      const r = JSON.parse(Perm.agentWorkspaceWrite ? (Perm.agentWorkspaceWrite(path, content, overwrite) || '{}') : '{}');
      if (r && r.ok && snapshot && snapshot.existed) { r.snapshot = snapshot.snapshot; r.note = '已保存写入前快照，可回滚。'; }
      try {
        taskEvent(task.id, 'workspace_write', { path: path, overwrite: overwrite, bytes: content.length, ok: !!(r && r.ok) });
      } catch (e) {}
      return r;
    } catch (e) { return { success: false, error: '无法写入工作区文件：' + errMsg(e) }; }
  }
  if (name === 'workspace_mkdir') {
    const path = String(args.path || '').trim();
    // 工作区内建目录同样不需要逐次确认
    try {
      const r = JSON.parse(Perm.agentWorkspaceMkdir ? (Perm.agentWorkspaceMkdir(path) || '{}') : '{}');
      try { taskEvent(task.id, 'workspace_mkdir', { path: path, ok: !!(r && r.ok) }); } catch (e) {}
      return r;
    } catch (e) { return { success: false, error: '无法创建工作区目录：' + errMsg(e) }; }
  }
  if (name === 'workspace_preview') {
    const path = String(args.path || '').trim();
    if (!path) return { success: false, errorCode: 'BAD_ARGUMENTS', error: '缺少 path' };
    const maxChars = Math.max(200, Math.min(8000, parseInt(args.max_chars, 10) || 1500));
    try {
      const raw = Perm.agentWorkspaceRead ? (Perm.agentWorkspaceRead(path, 400000) || '{}') : '{}';
      const r = JSON.parse(raw || '{}');
      if (!r || r.ok === false || r.text == null) {
        return { success: false, errorCode: 'READ_FAILED', error: (r && r.error) || '读不出这个文件（可能不是文本格式）' };
      }
      const text = String(r.text || '');
      const kind = previewKindOf(path);
      const lines = text ? text.split('\n').length : 0;
      const out = {
        success: true, path: path, kind: kind,
        bytes: text.length, chars: text.length, lines: lines,
        preview: text.slice(0, maxChars),
        truncated: text.length > maxChars
      };
      if (kind === 'csv') {
        const rows = text.split('\n').filter(Boolean);
        out.rows = rows.length;
        out.columns = (rows[0] ? rows[0].split(',').length : 0);
      }
      if (kind === 'json') {
        try { const o = JSON.parse(text); out.jsonType = Array.isArray(o) ? 'array' : typeof o;
          if (o && !Array.isArray(o) && typeof o === 'object') out.keys = Object.keys(o).slice(0, 20); } catch (e) { out.jsonType = 'invalid'; }
      }
      if (out.truncated) out.note = '只返回了前 ' + maxChars + ' 字，需要全文用 workspace_read';
      return out;
    } catch (e) { return { success: false, errorCode: 'PREVIEW_FAILED', error: errMsg(e) }; }
  }
  if (name === 'workspace_export') {
    const FMTS = { md: 'md', markdown: 'md', txt: 'txt', text: 'txt', csv: 'csv', json: 'json', html: 'html', htm: 'html' };
    const fmtIn = FMTS[String(args.format || '').toLowerCase()];
    const raw = String(args.content == null ? '' : args.content);
    if (!raw.trim()) return { success: false, errorCode: 'EMPTY_CONTENT', error: '导出内容为空' };
    // 路径：允许省略，也可以从 path 后缀推断格式
    let path = String(args.path || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    let fmt = fmtIn;
    if (!fmt) {
      const m = path.match(/\.([A-Za-z0-9]+)$/);
      fmt = m ? FMTS[m[1].toLowerCase()] : '';
    }
    if (!fmt) return { success: false, errorCode: 'BAD_FORMAT', error: '请指定导出格式：md / txt / csv / json / html' };
    if (path.indexOf('..') >= 0 || path.indexOf(':') >= 0 || path.startsWith('/')) {
      return { success: false, errorCode: 'INVALID_PATH', error: '导出路径不合法，只能写在 output/ 目录下' };
    }
    if (!path) {
      const slug = String(args.title || '').trim().slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
      path = (slug ? slug : 'export-' + stamp) + '.' + fmt;
    }
    // 统一落到 output/ 下
    if (path.indexOf('output/') !== 0) path = 'output/' + path.replace(/^output\/?/, '');
    if (!/\.[A-Za-z0-9]+$/.test(path)) path += '.' + fmt;
    else if (!path.toLowerCase().endsWith('.' + fmt)) path = path.replace(/\.[A-Za-z0-9]+$/, '.' + fmt);

    // 内容校验 / 包装
    let content = raw;
    let note = '';
    if (fmt === 'json') {
      try { JSON.parse(content); } catch (e) {
        return { success: false, errorCode: 'BAD_JSON', error: 'JSON 格式不合法：' + ((e && e.message) || '解析失败') };
      }
    }
    if (fmt === 'html' && !/<html[\s>]/i.test(content)) {
      const t = String(args.title || '').trim() || path.split('/').pop().replace(/\.html?$/i, '');
      content = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>' + esc(t) + '</title><style>body{font:15px/1.7 -apple-system,"Noto Sans SC",sans-serif;'
        + 'margin:0;padding:18px;color:#4a2c3a;background:#fff0f5}h1,h2,h3{color:#d6336c}'
        + 'pre{background:#fff;padding:10px;border-radius:10px;overflow:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #f0c8d4;padding:4px 8px}'
        + '</style></head><body>' + content + '</body></html>';
      note = '已自动补上 html 基础外壳，直接打开就能看';
    }
    if (content.length > 480000) {
      return { success: false, errorCode: 'TOO_LARGE', error: '内容超过 480KB，分成多个文件再导出吧' };
    }

    // 确保 output/ 存在
    try { if (Perm.agentWorkspaceMkdir) Perm.agentWorkspaceMkdir('output'); } catch (e) {}

    let snapshot = null;
    if (task.type === 'workspace' && task.workspaceReady && HAS_PERM && Perm.snapshotTaskFile) {
      try { snapshot = JSON.parse(Perm.snapshotTaskFile(task.id, taskRelPath(task, path)) || '{}'); } catch (e) { snapshot = null; }
    }
    try {
      const r = JSON.parse(Perm.agentWorkspaceWrite ? (Perm.agentWorkspaceWrite(path, content, args.overwrite === true) || '{}') : '{}');
      if (r && r.ok) {
        task.artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
        if (task.artifacts.indexOf(path) < 0) task.artifacts.push(path);
        if (snapshot && snapshot.existed) { r.snapshot = snapshot.snapshot; }
        try { taskEvent(task.id, 'workspace_export', { path: path, format: fmt, bytes: content.length }); } catch (e) {}
        // G7-3：在聊天里放一张可点开的小卡片（不占正文）
        try { addExportCard(taskRelPath(task, path), fmt); } catch (e) {}
        return Object.assign({}, r, {
          success: true, path: path, format: fmt, bytes: content.length,
          note: note || (snapshot && snapshot.existed ? '已留覆盖前快照' : '')
        });
      }
      return Object.assign({ success: false, errorCode: 'EXPORT_FAILED' }, r || { error: '写入导出文件失败' });
    } catch (e) { return { success: false, errorCode: 'EXPORT_FAILED', error: '导出失败：' + errMsg(e) }; }
  }
  if (name === 'external_file_list') {
    try { return JSON.parse(Perm.agentExternalList ? (Perm.agentExternalList(String(args.path || '')) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法列出外部目录：' + errMsg(e) }; }
  }
  if (name === 'external_file_read') {
    try { return JSON.parse(Perm.agentExternalRead ? (Perm.agentExternalRead(String(args.path || ''), parseInt(args.max_chars, 10) || 120000) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法读取外部文件：' + errMsg(e) }; }
  }
  if (name === 'external_file_write') {
    const path = String(args.path || '').trim();
    const content = String(args.content == null ? '' : args.content);
    const overwrite = args.overwrite === true;
    if (!(await ensureExternalWriteConsent(task, 'AI 请求' + (overwrite ? '覆盖' : '创建或写入') + '公共存储文件：\n\n' + path + '\n\n本次写入内容长度：' + content.length + ' 字符', '允许写入', '外部文件授权'))) {
      return { success: false, kind: 'cancelled', error: '用户没有允许本次外部文件写入' };
    }
    try { return JSON.parse(Perm.agentExternalWrite ? (Perm.agentExternalWrite(path, content, overwrite) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法写入外部文件：' + errMsg(e) }; }
  }
  if (name === 'external_file_copy') {
    const source = String(args.source || '').trim();
    const destination = String(args.destination || '').trim();
    const overwrite = args.overwrite === true;
    if (!(await ensureExternalWriteConsent(task, 'AI 请求复制公共存储文件：\n\n源：' + source + '\n目标：' + destination + '\n\n' + (overwrite ? '如果目标存在将覆盖。' : '目标已存在时不会覆盖。'), '允许复制', '文件复制授权'))) {
      return { success: false, kind: 'cancelled', error: '用户没有允许本次复制' };
    }
    try { return JSON.parse(Perm.agentExternalCopy ? (Perm.agentExternalCopy(source, destination, overwrite) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法复制外部文件：' + errMsg(e) }; }
  }
  if (name === 'external_file_mkdir') {
    const path = String(args.path || '').trim();
    if (!(await ensureExternalWriteConsent(task, 'AI 请求在公共存储创建目录：\n\n' + path, '允许创建', '外部目录授权'))) {
      return { success: false, kind: 'cancelled', error: '用户没有允许创建外部目录' };
    }
    try { return JSON.parse(Perm.agentExternalMkdir ? (Perm.agentExternalMkdir(path) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法创建外部目录：' + errMsg(e) }; }
  }
  if (name === 'external_file_delete') {
    const path = String(args.path || '').trim();
    const recursive = args.recursive === true;
    if (!(await uiConfirm('高风险操作：AI 请求删除公共存储中的文件或目录：\n\n' + path + '\n\n' + (recursive ? '将递归删除目录内容。' : '非空目录不会被递归删除。') + '\n此确认只对本次删除有效，是否继续？', '确认本次删除', '外部文件删除确认'))) {
      return { success: false, kind: 'cancelled', error: '用户没有允许本次删除' };
    }
    try { return JSON.parse(Perm.agentExternalDelete ? (Perm.agentExternalDelete(path, recursive) || '{}') : '{}'); }
    catch (e) { return { success: false, error: '无法删除外部文件：' + errMsg(e) }; }
  }
  if (name === 'open_url') {
    if (!args.url) return { success: false, error: '缺少网址' };
    try {
      if (HAS_NATIVE && Android.openUrl) { Android.openUrl(args.url); return { success: true, opened: args.url }; }
    } catch (e) {}
    return { success: false, error: '无法打开链接' };
  }
  if (name === 'set_clipboard') {
    if (!args.text) return { success: false, error: '缺少文本' };
    return writeClipboard(args.text) ? { success: true } : { success: false, error: '写入剪贴板失败' };
  }
  if (name === 'fetch_url') return webFetchTool(args);
  if (name === 'web_search') return webSearchTool(args);
  if (agentActionNames().indexOf(name) >= 0) {
    if (!HAS_PERM) return { success: false, error: '当前环境没有 Agent 原生能力桥' };
    // G5-1：所有设备动作都从这里过相位与计数，保证任何调用方行为一致
    const ds = deviceState(task);
    // G5-4：动作预算用尽 → 暂停（不判失败，可继续）
    if (deviceBudgetLeft(task) <= 0) {
      const used = parseInt(ds.actionsUsed, 10) || 0, cap = deviceBudget(task);
      taskUpdate(task.id, { state: 'paused', progress: '动作预算已用完（' + used + '/' + cap + '），已暂停', deadline: 0 });
      stopRequested = true;
      return { success: false, errorCode: 'BUDGET_EXHAUSTED', error: '设备动作预算已用完（' + used + '/' + cap + '），任务已暂停。告诉我要继续，我会再给一批 ' + (parseInt(CONFIG.deviceActionResumeChunk, 10) || 120) + ' 次。' };
    }
    // G5-4：只在密码框需要确认，不做按钮文字判断
    if (name === 'input_text') {
      let nodes = [];
      try { nodes = (rawScreenNodes() || {}).nodes || []; } catch (e) { nodes = []; }
      const idx = parseInt(args.nodeIndex, 10);
      const byIdx = isFinite(idx) && idx >= 0 && idx < nodes.length ? nodes[idx] : null;
      const focused = nodes.find(n => n && n.foc && (n.edt || n.pwd)) || null;
      const target = byIdx || focused;
      if (target && target.pwd) {
        const ok = await uiConfirm('要在这个密码框里输入吗？输入内容不会被记录，也不会写进日志。', '允许输入', '密码框确认');
        if (!ok) return { success: false, errorCode: 'USER_CANCELLED', error: '用户取消了密码输入' };
      }
    }
    // 发送属于高风险动作：无论是按发送键还是点「发送」按钮，都逐次确认。
    const keyName = String(args.key || '').toLowerCase();
    const sendLike = (name === 'press_key' && (keyName === 'enter' || keyName === 'send')) ||
      (name === 'click_text' && /发送|send|submit|提交/i.test(String(args.text || '')));
    if (sendLike) {
      const ok = await uiConfirm('这一步会真的把内容发出去（消息、评论或表单提交），确认继续？', '确认发送', '发送确认');
      if (!ok) return { success: false, errorCode: 'USER_CANCELLED', error: '用户取消了发送' };
    }
    if (ds.phase === 'idle' || ds.phase === 'planning') {
      deviceSetPhase(task.id, 'orienting', { action: name });
      try { await deviceOrient(task); } catch (e) {}
    }
    deviceSetPhase(task.id, 'acting', { action: name });
    ds.actionsUsed = (parseInt(ds.actionsUsed, 10) || 0) + 1;
    // 比例坐标 → 像素；模型直接给像素也兼容（>1 视为像素）
    const scr = (() => { try { const z = JSON.parse(Perm.getScreenSize ? (Perm.getScreenSize() || '{}') : '{}'); return { w: Number(z.w) || 1080, h: Number(z.h) || 2400 }; } catch (e) { return { w: 1080, h: 2400 }; } })();
    const px = (v, max) => {
      const n = Number(v);
      if (!isFinite(n)) return NaN;
      const raw = n > 0 && n <= 1 ? Math.round(n * max) : Math.round(n);
      return Math.max(0, Math.min(max - 1, raw));
    };
    const beforeFp = screenFingerprint();
    try {
      let raw = '{}';
      if (name === 'tap_screen' && Perm.agentTap) {
        const x = px(args.rx !== undefined ? args.rx : args.x, scr.w);
        const y = px(args.ry !== undefined ? args.ry : args.y, scr.h);
        if (!isFinite(x) || !isFinite(y)) { deviceSetPhase(task.id, 'idle', { action: name }); return { success: false, errorCode: 'BAD_ARGUMENTS', error: '点击坐标无效' }; }
        raw = Perm.agentTap(x, y);
      }
      else if (name === 'click_text' && Perm.agentClickText) raw = Perm.agentClickText(String(args.text || ''));
      else if (name === 'swipe_screen' && Perm.agentSwipe) raw = Perm.agentSwipe(
        px(args.x1 !== undefined ? args.x1 : args.rx1, scr.w), px(args.y1 !== undefined ? args.y1 : args.ry1, scr.h),
        px(args.x2 !== undefined ? args.x2 : args.rx2, scr.w), px(args.y2 !== undefined ? args.y2 : args.ry2, scr.h),
        Math.max(80, Math.min(2000, parseInt(args.duration, 10) || 350)));
      else if (name === 'input_text' && Perm.agentInputText) raw = Perm.agentInputText(String(args.text || ''));
      else if (name === 'press_key' && Perm.agentKey) raw = Perm.agentKey(String(args.key || ''));
      else if (name === 'launch_app' && Perm.agentLaunch) raw = Perm.agentLaunch(String(args.app || args.package || ''));
      else { deviceSetPhase(task.id, 'idle', { action: name }); return { success: false, error: '当前版本尚未提供该行为工具' }; }
      const r = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
      if (!(r && r.ok)) {
        deviceSetPhase(task.id, 'idle', { action: name });
        return { success: false, errorCode: (r && r.errorCode) || 'ACTION_DENIED', error: (r && r.error) || '行为执行失败' };
      }
      deviceSetPhase(task.id, 'verifying', { action: name });
      const v = await agentVerifyAction(beforeFp);
      deviceSetPhase(task.id, 'idle', { action: name });
      recordDeviceAction(task, name, args, v, r);
      if (v.verdict === 'PACKAGE_DENIED') {
        stopRequested = true; taskFinish(task.id, 'failed', v.error);
        return { success: false, errorCode: v.errorCode, error: v.error, after: v.after };
      }
      // 连续验证失败 → 暂停而不是失败（用户要求：不中断）
      if (v.verdict === 'PASS') ds.failStreak = 0;
      else ds.failStreak = (parseInt(ds.failStreak, 10) || 0) + 1;
      if ((parseInt(ds.failStreak, 10) || 0) >= 3) {
        ds.failStreak = 0;
        taskUpdate(task.id, { state: 'paused', progress: '连续 3 次动作未生效，已暂停等你确认', deadline: 0 });
        stopRequested = true;
        return { success: false, errorCode: 'VERIFY_REPEATED_FAIL', error: '连续 3 次动作后页面都没有变化，任务已暂停。请检查页面或告诉我下一步。', after: v.after };
      }
      return {
        success: v.verdict !== 'PACKAGE_DENIED',
        level: r.level || 'L3', package: r.package || v.after.package || '', label: r.label || '',
        verdict: v.verdict,
        warning: v.verdict === 'PASS' ? undefined : v.error,
        after: v.after
      };
    } catch (e) {
      deviceSetPhase(task.id, 'idle', { action: name });
      return { success: false, errorCode: 'ACTION_ERROR', error: errMsg(e) };
    }
  }

  /* ---- 长期记忆 ---- */
  if (name === 'list_memories') {
    const list = await memSearch({ keyword: args.keyword || '', category: args.category || '', limit: args.limit || 15 });
    if (!MEM.length) return { success: true, total: 0, memories: [], note: '记忆库还是空的，暂时没有可参考的长期记忆。' };
    return { success: true, total: MEM.length, count: list.length, memories: list.map(e => ({
      id: e.id, cat: memCat(e), title: e.title,
      summary: String(e.content || '').replace(/\s+/g, ' ').slice(0, 60),
      tags: e.tags || [], pinned: !!e.pinned,
      updated: String(e.updatedAt || '').slice(0, 10)
    })) };
  }
  if (name === 'read_memory') {
    const ids = (args.ids && args.ids.length) ? args.ids.slice() : (args.id ? [args.id] : []);
    if (!ids.length) return { success: false, error: '缺少记忆编号' };
    const out = [], miss = [];
    for (const id of ids) {
      const e = memFind(String(id));
      if (!e) { miss.push(String(id)); continue; }
      e.hits = (e.hits || 0) + 1;
      out.push({ id: e.id, cat: memCat(e), title: e.title, content: e.content, tags: e.tags || [],
        pinned: !!e.pinned, createdAt: e.createdAt, updatedAt: e.updatedAt });
    }
    memSaveAll();
    if (!out.length) return { success: false, error: '没找到这些编号：' + miss.join('、') + '（可用 list_memories 重新检索）' };
    return { success: true, count: out.length, memories: out, missing: miss };
  }
  if (name === 'list_memory_categories') {
    const counts = {};
    MEM.forEach(e => { const c = memCat(e); counts[c] = (counts[c] || 0) + 1; });
    return { success: true, total: MEM.length, preset: MEM_CATS, categories: counts };
  }
  if (name === 'save_memory') {
    if (!args.title || !args.content) return { success: false, error: '标题和正文都要有' };
    const title = String(args.title).trim();
    const content = String(args.content).trim();
    const tags = Array.isArray(args.tags) ? args.tags : [];
    // 同类并不等于同一条记忆。只有正文高度相似时才合并；相似度不足就新增。
    const similar = memFindSimilar(content);
    if (similar) {
      const e = memAppendContent(similar, content, tags) || similar;
      return { success: true, id: e.id, cat: memCat(e), saved: e.title, merged: true,
        note: '正文与已有记忆高度相似，已保留原文并追加新内容。' };
    }
    const e = memAdd({
      title: title, content: content,
      cat: String(args.category || '其他').trim() || '其他',
      tags: tags,
      pinned: !!args.pinned, src: 'ai'
    });
    return { success: true, id: e.id, cat: memCat(e), saved: e.title, merged: false };
  }
  if (name === 'update_memory') {
    if (!args.id) return { success: false, error: '缺少记忆编号' };
    const existing = memFind(String(args.id));
    if (!existing) return { success: false, error: '没有编号为 ' + args.id + ' 的记忆' };
    if (args.content !== undefined && args.replace !== true) {
      const merged = memAppendContent(existing, args.content, Array.isArray(args.tags) ? args.tags : null);
      if (!merged) return { success: false, error: '新内容与原记忆不够相似；请使用 save_memory 新增，或明确传 replace=true 修订原记录。' };
      if (args.title !== undefined || args.category !== undefined || args.pinned !== undefined) {
        const patch = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.category !== undefined) patch.cat = args.category;
        if (args.pinned !== undefined) patch.pinned = args.pinned;
        memUpdate(existing.id, patch);
      }
      return { success: true, id: existing.id, updated: existing.title, merged: true,
        note: '已保留原内容，并在末尾追加补充内容。' };
    }
    const patch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.category !== undefined) patch.cat = args.category;
    if (args.tags !== undefined) patch.tags = args.tags;
    if (args.pinned !== undefined) patch.pinned = args.pinned;
    const e = memUpdate(String(args.id), patch);
    return { success: true, id: e.id, updated: e.title, merged: false, replaced: args.replace === true };
  }
  if (name === 'pin_memory') {
    const e = memFind(String(args.id || ''));
    if (!e) return { success: false, error: '没有这条记忆' };
    const want = args.pinned === undefined ? !e.pinned : !!args.pinned;
    memUpdate(e.id, { pinned: want });
    return { success: true, id: e.id, pinned: want, title: e.title };
  }
  if (name === 'delete_memory') {
    const e = memFind(String(args.id || ''));
    if (!e) return { success: false, error: '没有这条记忆' };
    const why = args.reason ? '\n\n我的理由：' + String(args.reason).slice(0, 120) : '';
    const ok = await uiConfirm('爱莉希雅想删掉这条记忆：\n\n' + e.title + '\n' + String(e.content || '').slice(0, 120) + why, '同意删除', '记忆删除授权');
    if (!ok) return { success: false, error: '用户没有同意删除，这条记忆保留着。', denied: true };
    memDel(e.id);
    if ($('#memory').classList.contains('open')) renderMemory();
    return { success: true, deleted: e.title };
  }
  if (!CONFIG.musicEnabled) return { success: false, error: '音乐功能未开启，请让用户去设置开启。' };
  if (name === 'search_and_play_music') {
    if (!args.keyword) return { success: false, error: '缺少关键词' };
    try {
      const r = await mSearch(args.keyword);
      if (!r.length) return { success: false, error: '没找到歌曲' };
      renderList(r);
      if (args.action === 'search') {
        return { success: true, action: 'searched', count: r.length,
          songs: r.slice(0, 8).map((s, i) => `${i + 1}. ${s.name} - ${s.artist}`) };
      }
      await playAt(0);
      return { success: true, action: 'playing', song: `${r[0].name} - ${r[0].artist}` };
    } catch (e) { return { success: false, error: errMsg(e) }; }
  }
  if (name === 'music_control') {
    try {
      const n = MP();
      switch (args.command) {
        case 'pause': if (n) n.mpPause(); else if (M.audio) M.audio.pause(); M.isPlaying = false; updateBar(); updateMini(); return { success: true };
        case 'resume': if (n) n.mpPlay(); else if (M.audio) M.audio.play(); M.isPlaying = true; updateBar(); updateMini(); return { success: true };
        case 'next': playNext(false); return { success: true };
        case 'prev': playPrev(); return { success: true };
        case 'stop':
          if (n) n.mpStop(); else if (M.audio) { M.audio.pause(); M.audio.src = ''; }
          M.isPlaying = false; M.miniHidden = true; updateBar(); updateMini();
          return { success: true };
        case 'favorite': {
          const s = M.playlist[M.currentIndex];
          if (!s) return { success: false, error: '没有播放歌曲' };
          toggleFav(s);
          return { success: true, action: isFav(s) ? 'favorited' : 'unfavorited', song: s.name };
        }
        default: return { success: false, error: '未知命令' };
      }
    } catch (e) { return { success: false, error: errMsg(e) }; }
  }
  return { success: false, error: '未知工具' };
}

