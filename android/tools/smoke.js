/*
 * 运行期冒烟测试 —— 用假的 DOM/桥接把 assets/index.html 里的脚本真跑一遍。
 *
 * 为什么需要它：`node --check` 只查语法。像 `MP()` 这种「调用了但从没定义」
 * 的问题语法完全合法，静态检查查不出来，只有跑起来才会炸。
 *
 * 用法：node tools/smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const NodeURL = URL;   // Node 自带的 URL 构造函数（现在 Node 全局就有）

const HTML_PATH = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('没找到 <script> 块'); process.exit(1); }
let js = m[1];

/* ---- 把内部符号挂到 window，供测试调用（只改内存里的副本，不动源文件） ---- */
const EXPORTS = ['M', 'playAt', 'togglePlay', 'playNext', 'playPrev', 'execTool', 'cyclePlayMode',
  'updateBar', 'updateMini', 'onLyricTime', 'setLyric', 'refreshSystemPrompt', 'buildTools',
  'buildToolsPrompt', 'composeSystemPrompt', 'speakText', 'stopTTS', 'ttsSplit', 'ttsStripMd',
  'togglePlug', 'toggleTool', 'toolOn', 'renderPlugins', 'renderPlugMarket', 'CONFIG', 'DC', 'PLUGINS', 'toolLive', 'mSearch', 'mGetUrl', 'getAudio', 'MP',
  'plugNormalize', 'plugManifestError', 'plugExec', 'plugUrlAllowed', 'plugFind', 'plugPermissionGranted', 'PLUG_PERMISSION_INFO', 'PLUGIN_MARKET_INDEX', 'USER_PLUGINS', 'verArr', 'cmpVer',
  'PLUG_SANDBOX_HTML', 'PLUG_HELP', 'MEM', 'memSimilarContent',
  'saveSettings', 'renderSettings',
  'showGuide', 'hideGuide', 'ensureGuideFooterVisible', 'activePermItems', 'PERM_ITEMS',
  'renderGuideSteps', 'webviewLevel', 'loadEnv', 'sdkAtLeast', 'detectCaps'];
const cuts = js.lastIndexOf('})();');
if (cuts < 0) { console.error('没找到 IIFE 结尾'); process.exit(1); }
js = js.slice(0, cuts) + '\ntry { window.__T = {' + EXPORTS.join(',') + '}; } catch (e) { console.error("EXPORT FAIL", e); }\n' + js.slice(cuts);

/* ======================= 假 DOM ======================= */
function mkStyle() {
  const t = {
    setProperty(k, v) { t[k] = v; },
    getPropertyValue(k) { return t[k] || ''; },
    removeProperty(k) { const v = t[k]; delete t[k]; return v || ''; }
  };
  return new Proxy(t, {
    get: (o, p) => (p in o ? o[p] : (typeof p === 'string' ? '' : undefined)),
    set: (o, p, v) => { o[p] = v; return true; }
  });
}
function mkClassList() {
  const s = new Set();
  return {
    add(...c) { c.forEach(x => x && s.add(x)); },
    remove(...c) { c.forEach(x => s.delete(x)); },
    toggle(c, f) { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { f ? s.add(c) : s.delete(c); } },
    contains(c) { return s.has(c); },
    replace(a, b) { if (s.has(a)) { s.delete(a); s.add(b); } },
    get length() { return s.size; },
    item(i) { return [...s][i]; },
    toString() { return [...s].join(' '); }
  };
}
function mkCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get: (o, p) => {
      if (p === 'canvas') return mkEl('canvas');
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createLinearGradient') return () => ({ addColorStop: noop });
      return typeof p === 'string' ? noop : undefined;
    },
    set: () => true
  });
}
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: mkStyle(), classList: mkClassList(), dataset: {}, attributes: {},
    children: [], childNodes: [], parentNode: null,
    textContent: '', innerHTML: '', innerText: '', value: '', id: '', className: '',
    type: '', name: '', placeholder: '', title: '', htmlFor: '',
    hidden: false, disabled: false, checked: false, selected: false,
    src: '', href: '', currentTime: 0, duration: 0, volume: 1, muted: false,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
    offsetHeight: 0, offsetWidth: 0, naturalWidth: 0, naturalHeight: 0,
    files: null, options: [], selectedIndex: 0,
    appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; },
    insertBefore(c) { return this.appendChild(c); },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    replaceChild(a, b) { return b; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); },
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
    querySelector() { return mkEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; }, matches() { return false; },
    focus() { }, blur() { }, click() { }, scrollIntoView() { }, select() { }, setSelectionRange() { },
    getBoundingClientRect() { return { width: 300, height: 560, left: 0, top: 0, right: 300, bottom: 560, x: 0, y: 0 }; },
    getContext() { return mkCtx(); },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
    toBlob(cb) { cb && cb({}); },
    animate() { return { cancel() { }, finished: Promise.resolve() }; },
    cloneNode() { return mkEl(this.tagName); },
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    get parentElement() { return this.parentNode; },
    get nextSibling() { return null; },
    get offsetParent() { return null; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = String(v); this.children = []; this.childNodes = []; }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return this._text || ''; },
    set(v) { this._text = String(v); }
  });
  return el;
}

const elCache = new Map();
function q1(sel) {
  if (!elCache.has(sel)) elCache.set(sel, mkEl('div'));
  return elCache.get(sel);
}

const document = {
  readyState: 'complete',
  hidden: false, visibilityState: 'visible',
  cookie: '', title: '',
  documentElement: mkEl('html'),
  body: mkEl('body'),
  head: mkEl('head'),
  createElement: t => mkEl(t),
  createElementNS: (ns, t) => mkEl(t),
  createTextNode: t => ({ nodeType: 3, textContent: String(t) }),
  createDocumentFragment: () => mkEl('fragment'),
  getElementById: id => q1('#' + id),
  querySelector: sel => q1(sel),
  querySelectorAll: () => [],
  getElementsByTagName: () => [],
  getElementsByClassName: () => [],
  addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
  elementFromPoint() { return null; },
  execCommand() { return true; },
  fonts: { ready: Promise.resolve(), add() { } }
};

/* ======================= 假存储 / 桥接 ======================= */
const store = new Map();
const calls = { mp: [], tts: [], ui: [], net: [] };

/* 模拟环境：可以用 ELY_SDK / ELY_WV 环境变量换一组来测老机器。 */
const ENVINFO = {
  sdk: Number(process.env.ELY_SDK || 30),
  release: String(process.env.ELY_SDK ? '?' : '11'),
  brand: process.env.ELY_BRAND || 'vivo',
  model: process.env.ELY_MODEL || 'iQOO Z6x',
  webviewPkg: 'com.google.android.webview',
  webviewVer: String(process.env.ELY_WV || '90.0.4430.91'),
  appVer: '0.6.0', density: 2.75, densityDpi: 440,
  screenW: 1080, screenH: 2400
};

const Android = {
  getValue(k, def) { return store.has(k) ? store.get(k) : (def === undefined ? null : def); },
  setValue(k, v) { store.set(k, String(v)); },
  clearAll() { store.clear(); },
  // 网络：把结果异步回抛给 window.__gmCb
  request(id, method, url, headersJson, body, timeout) {
    calls.net.push({ method, url });
    let text = '[]';
    try {
      const u = decodeURIComponent(url);
      if (/types=search|type=search/.test(u)) {
        text = JSON.stringify([
          { id: 1001, name: '测试歌曲甲', artists: [{ name: '歌手A' }], album: { name: '专辑' }, duration: 180000 },
          { id: 1002, name: '测试歌曲乙', artists: [{ name: '歌手B' }], album: { name: '专辑' }, duration: 200000 }
        ]);
      } else if (/types=url|type=url/.test(u)) {
        text = 'https://example.invalid/song.mp3';
      } else if (/types=lyric|type=lyric/.test(u)) {
        text = JSON.stringify({ lyric: '[00:00.00]第一句\n[00:05.00]第二句\n[00:10.00]第三句' });
      } else if (/audio\/voices/.test(u)) {
        text = JSON.stringify({ data: [{ id: 'test-voice-1' }, { id: 'test-voice-2' }] });
      } else if (/chat\/completions/.test(u)) {
        text = JSON.stringify({ choices: [{ message: { content: '好的呀♪' } }] });
      } else if (/embeddings/.test(u)) {
        text = JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] });
      }
    } catch (e) { }
    setTimeout(() => {
      try { sandbox.window.__gmCb(id, true, 200, text, ''); } catch (e) { }
    }, 0);
  },
  closeFloat() { }, minimizeToBubble() { }, restoreFloat() { }, toCapsule() { },
  capsuleState() { }, capsuleDone() { return true; }, capsuleHide() { },
  showTranslateOverlay() { }, hideTranslateOverlay() { },
  showMiniPlayer(...a) { calls.ui.push(['showMiniPlayer', ...a]); },
  hideMiniPlayer() { calls.ui.push(['hideMiniPlayer']); },
  setMiniLyric(t) { calls.ui.push(['setMiniLyric', t]); },
  setMiniPlayMode(i) { calls.ui.push(['setMiniPlayMode', i]); },
  mpLoad(...a) { calls.mp.push(['load', ...a]); },
  mpPlay() { calls.mp.push(['play']); },
  mpPause() { calls.mp.push(['pause']); },
  mpToggle() { calls.mp.push(['toggle']); },
  mpSeek(ms) { calls.mp.push(['seek', ms]); },
  mpStop() { calls.mp.push(['stop']); },
  mpState() { return '{"playing":false}'; },
  speak(t, r) { calls.tts.push(['speak', t, r]); },
  ttsAi(u, h, b) { calls.tts.push(['ttsAi', u, h, b]); },
  ttsStop() { calls.tts.push(['ttsStop']); },
  stopSpeak() { calls.tts.push(['stopSpeak']); },
  setAvatar() { }, pickImage() { }, pickFile() { }, getPickedImage() { return ''; },
  getPickedFile() { return ''; }, getClipboard() { return ''; }, setClipboard() { },
  openUrl(u) { calls.ui.push(['openUrl', u]); }, vibrate() { },
  setWindowSize() { return ''; }, setWindowRect() { return ''; }, moveWindowTo() { return ''; },
  moveBy() { return ''; }, resizeWindow() { return ''; }, getWindowRect() { return '{}'; },
  getWindowLimits() { return JSON.stringify({ minW: 120, minH: 120, maxW: 1080, maxH: 2400, bw: 361, bh: 560, density: 2.75 }); },
  setTouchThrough() { }, getEnvInfo() { return JSON.stringify(ENVINFO); }
};

const Perm = {
  hasOverlay() { return true; }, requestOverlay() { },
  hasNotification() { return true; }, requestNotification() { },
  isNotificationChannelOn() { return true; }, requestNotificationChannel() { },
  hasAccessibility() { return true; }, requestAccessibility() { },
  canScreenshot() { return true; },
  hasAllFilesAccess() { return false; }, requestAllFilesAccess() { },
  workspaceState() { return JSON.stringify({ permission: false, created: false }); },
  createWorkspace() { return JSON.stringify({ ok: false, error: 'mock' }); },
  isIgnoringBattery() { return false; },
  requestIgnoreBattery() { }, getScreenSize() { return '{"w":1080,"h":2400,"density":2.75}'; },
  getWindowLimits() { return Android.getWindowLimits(); }, getEnvInfo() { return Android.getEnvInfo(); }
};
/* ======================= 组装 sandbox ======================= */
const win = {};
const sandbox = {
  window: win, document, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean,
  RegExp, Error, TypeError, RangeError, Map, Set, WeakMap, WeakSet, Symbol,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  Intl, Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Float64Array, ArrayBuffer,
  AbortController, Blob: function () { }, File: function () { }, FileReader: function () { this.readAsText = () => { }; },
  FormData: function () { this.append = () => { }; },
  // 真 WebView 里 URL 是构造函数；这里用 Node 的实现兜底，同时保留 blob 那两个方法
  URL: Object.assign(function (u, b) { return new NodeURL(u, b); },
    { createObjectURL: () => 'blob:x', revokeObjectURL() { } }),
  TextEncoder: function () { this.encode = () => new Uint8Array(); },
  TextDecoder: function () { this.decode = () => ''; },
  localStorage: {
    getItem: k => (store.has('ls:' + k) ? store.get('ls:' + k) : null),
    setItem: (k, v) => store.set('ls:' + k, String(v)),
    removeItem: k => store.delete('ls:' + k)
  },
  sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
  fetch: () => Promise.reject(new Error('no fetch')),
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 11; iQOO) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.4430.91 Mobile Safari/537.36', vibrate() { }, clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
  screen: { width: 1080, height: 2400, availWidth: 1080, availHeight: 2400 },
  location: { href: 'file:///android_asset/index.html', origin: 'file://', search: '' },
  history: { pushState() { }, replaceState() { } },
  Audio: function () {
    return {
      preload: '', src: '', currentTime: 0, duration: 0, volume: 1,
      play: () => Promise.resolve(), pause() { }, load() { }, removeAttribute() { },
      addEventListener() { }, canPlayType: () => ''
    };
  },
  Image: function () { const o = mkEl('img'); return o; },
  SpeechSynthesisUtterance: function (t) { this.text = t; },
  speechSynthesis: { speak() { }, cancel() { }, getVoices: () => [] },
  requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: id => clearTimeout(id),
  getComputedStyle: () => mkStyle(),
  matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { }, removeEventListener() { } }),
  Android, Perm
};
Object.assign(sandbox, {
  devicePixelRatio: 2.75, innerWidth: 393, innerHeight: 873,
  outerWidth: 393, outerHeight: 873, scrollX: 0, scrollY: 0,
  addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
  getSelection: () => ({ toString: () => '' }),
  alert() { }, confirm: () => true, prompt: () => null,
  open() { }, close() { }, focus() { }, blur() { },
  Android, Perm, document
});
Object.setPrototypeOf(sandbox, null);
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
Object.assign(win, sandbox);
// window 上也要能取到 localThis 语义
win.devicePixelRatio = 2.75; win.innerWidth = 393; win.innerHeight = 873;
win.localStorage = sandbox.localStorage; win.sessionStorage = sandbox.sessionStorage;
win.navigator = sandbox.navigator; win.screen = sandbox.screen; win.location = sandbox.location;
win.history = sandbox.history; win.Audio = sandbox.Audio; win.Image = sandbox.Image;
win.speechSynthesis = sandbox.speechSynthesis; win.SpeechSynthesisUtterance = sandbox.SpeechSynthesisUtterance;
win.getComputedStyle = sandbox.getComputedStyle; win.matchMedia = sandbox.matchMedia;
win.requestAnimationFrame = sandbox.requestAnimationFrame; win.cancelAnimationFrame = sandbox.cancelAnimationFrame;
win.fetch = sandbox.fetch; win.AbortController = AbortController; win.URL = sandbox.URL;
win.Blob = sandbox.Blob; win.FileReader = sandbox.FileReader; win.FormData = sandbox.FormData;
win.TextEncoder = sandbox.TextEncoder; win.TextDecoder = sandbox.TextDecoder;
win.Android = Android; win.Perm = Perm; win.document = document; win.console = console;
win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
win.setInterval = setInterval; win.clearInterval = clearInterval;

/* ======================= 跑 ======================= */
const errors = [];
const context = vm.createContext(sandbox);
try {
  vm.runInContext(js, context, { filename: 'index.html:inline', timeout: 20000 });
} catch (e) {
  errors.push('脚本执行（模块级 + boot）: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
}

const T = sandbox.window.__T;

function step(name, fn) {
  if (!T) { errors.push(name + ': 拿不到内部符号 __T（脚本没跑完）'); return; }
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log('  ✓ ' + name), e => {
        errors.push(name + ': ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
      });
    }
    console.log('  ✓ ' + name);
  } catch (e) {
    errors.push(name + ': ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }
}

(async () => {
  console.log('内部符号导出：' + (T ? 'OK（' + Object.keys(T).length + ' 个）' : '失败'));
  console.log('冒烟用例：');

  step('MP() 能拿到原生播放器句柄', () => {
    if (typeof T.MP !== 'function') throw new Error('MP 未定义');
    if (T.MP() !== Android) throw new Error('MP() 没返回 Android 桥');
  });

  await step('buildTools() 含音乐工具且开关生效', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    let names = T.buildTools().map(t => t.function.name);
    if (!names.includes('search_and_play_music')) throw new Error('缺 search_and_play_music');
    if (!names.includes('music_control')) throw new Error('缺 music_control');
    T.CONFIG.musicEnabled = false;
    const off = T.buildTools().map(t => t.function.name);
    T.CONFIG.musicEnabled = before;
    if (off.includes('music_control')) throw new Error('关掉音乐后 music_control 还能调');
    if (off.includes('search_and_play_music')) throw new Error('关掉音乐后 search_and_play_music 还能调');
  });

  await step('buildToolsPrompt() 含音乐段落', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    const p = T.buildToolsPrompt();
    T.CONFIG.musicEnabled = before;
    if (!/music_control/.test(p)) throw new Error('提示词里没列 music_control');
  });

  await step('Agent 新工具：应用解析、无限轮数和工作区开关结构', () => {
    if (T.CONFIG.agentToolRounds !== 0) throw new Error('默认工具轮数不是无限');
    if (!T.PLUGINS.some(p => p.id === 'agent') || !T.PLUGINS.some(p => p.id === 'files')) throw new Error('缺 Agent/工作区插件');
    const old = {
      enabled: T.CONFIG.agentEnabled, l1: T.CONFIG.agentL1, l3: T.CONFIG.agentL3, safety: T.CONFIG.agentSafety,
      access: Perm.hasAllFilesAccess, state: Perm.workspaceState
    };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL1 = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    Perm.hasAllFilesAccess = () => true;
    Perm.workspaceState = () => JSON.stringify({ permission: true, created: true });
    const names = T.buildTools().map(t => t.function.name);
    if (!names.includes('find_app') || !names.includes('watch_screen')) throw new Error('缺应用查询或限时观察工具');
    if (!names.includes('workspace_read') || !names.includes('workspace_write')) throw new Error('缺工作区读写工具');
    if (!names.includes('external_file_read') || !names.includes('external_file_write') || !names.includes('external_file_copy') || !names.includes('external_file_delete')) throw new Error('缺公共存储文件修改工具');
    for (const marker of ['external_file_write', 'external_file_copy', 'external_file_mkdir', 'external_file_delete']) {
      if (!html.includes("if (name === '" + marker + "')") || !html.includes('uiConfirm')) throw new Error(marker + ' 缺少逐次确认结构');
    }
    T.CONFIG.agentEnabled = old.enabled; T.CONFIG.agentL1 = old.l1; T.CONFIG.agentL3 = old.l3; T.CONFIG.agentSafety = old.safety;
    Perm.hasAllFilesAccess = old.access; Perm.workspaceState = old.state;
  });

  await step('记忆策略：默认新增，相似正文才追加合并', async () => {
    const before = T.MEM.length;
    const a = await T.execTool('save_memory', { title: '测试偏好A', content: '用户长期偏好使用纯文本记录项目进度。', category: '项目' });
    const b = await T.execTool('save_memory', { title: '测试偏好B', content: '用户长期偏好使用纯文本记录项目进度，并要求保留历史内容。', category: '项目' });
    const c = await T.execTool('save_memory', { title: '测试偏好C', content: '用户计划下周测试输入法兜底功能。', category: '项目' });
    if (!a.success || !b.success || !c.success) throw new Error('记忆工具调用失败');
    if (T.MEM.length !== before + 2) throw new Error('相似内容没有合并或新事实被错误合并');
    const merged = T.MEM.find(e => e.id === b.id);
    if (!merged || !merged.content.includes('纯文本记录项目进度') || !merged.content.includes('保留历史内容')) throw new Error('合并时没有保留并追加原文');
  });

  await step('搜索 → 播放：全链路打到原生 mpLoad', async () => {
    T.CONFIG.musicEnabled = true;
    const list = await T.mSearch('测试');
    if (!list || !list.length) throw new Error('搜索没结果');
    T.M.playlist = list;
    calls.mp.length = 0;
    await T.playAt(0);
    const load = calls.mp.find(c => c[0] === 'load');
    if (!load) throw new Error('playAt 没调 Android.mpLoad，实际调用：' + JSON.stringify(calls.mp));
    if (!/^https?:/.test(load[1])) throw new Error('mpLoad 的 url 不合法：' + load[1]);
  });

  await step('togglePlay / 播放模式 都不炸', () => {
    T.togglePlay();
    T.cyclePlayMode(); T.cyclePlayMode(); T.cyclePlayMode();
  });

  await step('AI 工具 music_control 各命令', async () => {
    T.CONFIG.musicEnabled = true;
    for (const cmd of ['pause', 'resume', 'next', 'prev', 'stop', 'favorite']) {
      const r = await T.execTool('music_control', { command: cmd });
      if (!r || r.success !== true) throw new Error(cmd + ' 失败: ' + JSON.stringify(r));
    }
  });

  await step('AI 工具 search_and_play_music', async () => {
    T.CONFIG.musicEnabled = true;
    const r = await T.execTool('search_and_play_music', { keyword: '测试', action: 'search' });
    if (!r.success) throw new Error(JSON.stringify(r));
    const r2 = await T.execTool('search_and_play_music', { keyword: '测试', action: 'play' });
    if (!r2.success) throw new Error(JSON.stringify(r2));
  });

  await step('原生回调 __mpState/__mpProgress/__mpDone/__mpCmd', () => {
    const w = sandbox.window;
    for (const f of ['__mpState', '__mpProgress', '__mpDone', '__mpCmd', '__miniToggle', '__miniMode', '__miniClose']) {
      if (typeof w[f] !== 'function') throw new Error('缺 window.' + f);
    }
    w.__mpState(JSON.stringify({ playing: true, dur: 180000, pos: 0 }));
    w.__mpProgress(5000, 180000);
    w.__mpCmd('next'); w.__mpCmd('prev'); w.__mpCmd('stop');
    w.__miniToggle(); w.__miniMode();
  });

  await step('歌词同步到原生迷你条', () => {
    calls.ui.length = 0;
    T.setLyric('测试歌词一句');
    if (!calls.ui.some(c => c[0] === 'setMiniLyric' && c[1] === '测试歌词一句'))
      throw new Error('没推 setMiniLyric：' + JSON.stringify(calls.ui));
    T.onLyricTime();
  });

  await step('TTS：markdown 剥离 + 分句', () => {
    const s = T.ttsStripMd('# 标题\n**粗体** `code`\n- 列表\n[链接](http://x)\n> 引用');
    if (/[*`#\[\]]/.test(s)) throw new Error('markdown 没剥干净：' + JSON.stringify(s));
    const seg = T.ttsSplit('第一句话。第二句话！第三句话？这是一个很长很长的句子，长到应该被单独切出来，因为它超过了长度上限。');
    if (!Array.isArray(seg) || !seg.length) throw new Error('分句失败');
  });

  await step('TTS：系统引擎调用 Android.speak', () => {
    T.CONFIG.ttsEngine = 'system';
    T.CONFIG.ttsEnabled = true;
    T.speakText('你好呀。');
    if (!calls.tts.some(c => c[0] === 'speak')) throw new Error('没调 Android.speak：' + JSON.stringify(calls.tts));
  });

  await step('TTS：自建引擎调用 Android.ttsAi 且 URL/body 正确', () => {
    T.CONFIG.ttsEngine = 'ai';
    T.CONFIG.ttsBaseUrl = 'https://api.example.com/v1';
    T.CONFIG.ttsApiKey = 'sk-test';
    T.CONFIG.ttsModel = 'tts-1';
    T.CONFIG.ttsVoice = 'nova';
    calls.tts.length = 0;
    T.speakText('你好呀。');
    const c = calls.tts.find(x => x[0] === 'ttsAi');
    if (!c) throw new Error('没调 Android.ttsAi：' + JSON.stringify(calls.tts));
    if (c[1] !== 'https://api.example.com/v1/audio/speech') throw new Error('URL 不对：' + c[1]);
    const body = JSON.parse(c[3]);
    if (body.model !== 'tts-1' || body.voice !== 'nova' || !body.input) throw new Error('body 不对：' + c[3]);
    if (!/Bearer sk-test/.test(c[2])) throw new Error('headers 缺鉴权：' + c[2]);
    T.stopTTS();
    T.CONFIG.ttsEngine = 'system';
  });

  await step('插件开关：关掉音乐后工具与提示词同时消失', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    T.togglePlug('music');
    const names = T.buildTools().map(t => t.function.name);
    const prompt = T.buildToolsPrompt();
    T.togglePlug('music');
    T.CONFIG.musicEnabled = before;
    if (names.includes('music_control') || names.includes('search_and_play_music'))
      throw new Error('关掉插件后工具还在');
    if (/music_control/.test(prompt)) throw new Error('关掉插件后提示词还在提');
  });

  await step('单项工具开关：只关一项不影响同组其它工具', () => {
    T.CONFIG.toolOff = {};
    T.toggleTool('music_control');            // 关掉
    let names = T.buildTools().map(t => t.function.name);
    let prompt = T.buildToolsPrompt();
    if (names.includes('music_control')) throw new Error('单项关闭后仍可调用');
    if (/music_control/.test(prompt)) throw new Error('单项关闭后提示词仍在提');
    if (!names.includes('search_and_play_music')) throw new Error('误伤了同组其它工具');
    T.toggleTool('music_control');            // 再开回来
    names = T.buildTools().map(t => t.function.name);
    if (!names.includes('music_control')) throw new Error('重新开启失败');
    T.CONFIG.toolOff = {};
  });

  await step('插件页：结构存在且渲染不炸', () => {
    for (const id of ['plugins', 'plug-list', 'btn-plug-page', 'plug-back', 'plug-market', 'plug-market-modal', 'plug-market-list', 'plug-preview-btn']) {
      if (!html.includes('id="' + id + '"')) throw new Error('index.html 里找不到 #' + id);
    }
    T.renderPlugins();
    T.renderPlugMarket();
    if (T.toolOn('read_screen') !== true) throw new Error('默认应为开启');
    T.CONFIG.toolOff = { read_screen: true };
    if (T.toolOn('read_screen') !== false) throw new Error('toolOff 未生效');
    T.CONFIG.toolOff = {};
  });

  await step('自定义插件：清单校验 + 工具注册 + 执行', async () => {
    const m = T.plugNormalize({
      manifestVersion: 1, apiVersion: '0.1', id: 'com.test.echo', name: '回声', icon: '📣',
      permissions: ['network.public'], grantedPermissions: ['network.public'],
      tools: [
        { name: 'echo_http', description: '回显', kind: 'http', permissions: ['network.public'],
          request: { method: 'GET', url: 'https://example.com/api?q={{q}}' } },
        { name: 'echo_js', description: '脚本', kind: 'js', permissions: [], code: 'async function run(a){return a;}' }
      ]
    });
    if (!m) throw new Error('合法清单被拒');
    if (T.plugNormalize({ id: 'x', name: 'x', tools: [] })) throw new Error('空工具清单应被拒');
    if (T.plugNormalize({ id: 'bad id', name: 'x', tools: [{ name: 't', kind: 'js', code: 'x' }] }))
      throw new Error('非法 id 应被拒');
    if (T.plugNormalize({ id: 'ok.id', name: 'x', tools: [{ name: 't', kind: 'nope' }] }))
      throw new Error('未知 kind 应被拒');
    T.USER_PLUGINS.push(m);
    T.refreshSystemPrompt(false);
    const names = T.buildTools().map(t => t.function.name);
    const prompt = T.buildToolsPrompt();
    if (!names.includes('echo_http') || !names.includes('echo_js'))
      throw new Error('自定义工具未注册：' + names.join(','));
    if (!/回声/.test(prompt)) throw new Error('提示词没包含自定义插件');
    const r = await T.execTool('echo_http', { q: 'hi' });
    if (!r.success) throw new Error('http 插件执行失败：' + JSON.stringify(r));
    if (!T.plugFind('echo_http')) throw new Error('plugFind 找不到自定义工具');
    T.USER_PLUGINS.length = 0;
    T.refreshSystemPrompt(false);
  });

  await step('插件权限声明、授权和本地市场结构', () => {
    const safe = { manifestVersion: 1, apiVersion: '0.1', id: 'com.test.safe', name: '安全插件', permissions: [], tools: [{ name: 'safe_tool', description: '安全工具', permissions: [], kind: 'js', code: 'async function run(a){return a;}' }] };
    const dangerous = { manifestVersion: 1, apiVersion: '0.1', id: 'com.test.danger', name: '危险插件', permissions: ['files.public.write'], tools: [{ name: 'danger_tool', description: '写文件', permissions: ['files.public.write'], kind: 'js', code: 'async function run(a){return a;}' }] };
    if (T.plugManifestError(safe)) throw new Error('安全清单不应被拒：' + T.plugManifestError(safe));
    if (T.plugManifestError(dangerous)) throw new Error('危险清单结构不应被拒：' + T.plugManifestError(dangerous));
    const missingToolPerm = Object.assign({}, safe, { tools: [{ name: 'safe_tool', description: '安全工具', kind: 'js', code: 'async function run(a){return a;}' }] });
    if (!T.plugManifestError(missingToolPerm)) throw new Error('缺少工具 permissions 时未拒绝');
    const n = T.plugNormalize(dangerous);
    if (!n || T.plugPermissionGranted(n, 'files.public.write')) throw new Error('危险能力不应在清单规整时默认授权');
    const granted = T.plugNormalize(Object.assign({}, dangerous, { grantedPermissions: ['files.public.write'] }));
    if (!T.plugPermissionGranted(granted, 'files.public.write')) throw new Error('显式授权危险能力后仍不可用');
    const ungranted = T.plugNormalize(Object.assign({}, dangerous, { grantedPermissions: [] }));
    if (T.plugPermissionGranted(ungranted, 'files.public.write')) throw new Error('未授权危险能力仍然可用');
    if (!Array.isArray(T.PLUGIN_MARKET_INDEX) || !T.PLUGIN_MARKET_INDEX.length) throw new Error('本地插件市场索引为空');
  });

  await step('自定义插件：本机地址与危险协议被拦截', () => {
    for (const u of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'file:///etc/passwd',
                     'javascript:alert(1)', 'http://169.254.1.1/x']) {
      if (!T.plugUrlAllowed(u)) throw new Error('未拦截：' + u);
    }
    if (T.plugUrlAllowed('https://api.example.com/v1/x')) throw new Error('正常 https 被误拦');
  });

  await step('插件沙箱模板：脚本可解析', () => {
    const h = T.PLUG_SANDBOX_HTML;
    if (!/__elly/.test(h) || !/parent\.postMessage/.test(h)) throw new Error('沙箱模板结构不对');
    if (!/Content-Security-Policy/.test(h) || !/default-src &#39;none&#39;/.test(h))
      throw new Error('沙箱模板缺少 CSP，插件可直接发网络请求');
    const m = h.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('沙箱模板缺少 script');
    new vm.Script(m[1]);   // 语法不合法会抛
    if (!/host\.request/.test(T.PLUG_HELP) || !/host\.callTool/.test(T.PLUG_HELP) || !/permissions/.test(T.PLUG_HELP)) throw new Error('格式说明缺少权限或 host 接口');
  });

  await step('版本比较与更新页结构', () => {
    if (T.cmpVer(T.verArr('v0.6.3'), T.verArr('0.6.2')) <= 0) throw new Error('新版本应更大');
    if (T.cmpVer(T.verArr('v0.6.2'), T.verArr('0.6.2')) !== 0) throw new Error('同版本应相等');
    if (T.cmpVer(T.verArr('0.6.10'), T.verArr('0.6.9')) <= 0) throw new Error('应按数字逐段比较');
    for (const id of ['update-modal', 'upd-go', 'upd-notes', 'plug-modal', 'plug-code']) {
      if (!html.includes('id="' + id + '"')) throw new Error('index.html 里找不到 #' + id);
    }
  });

  await step('人设/提示词组装', () => {
    const p = T.composeSystemPrompt();
    if (!p || p.length < 10) throw new Error('提示词为空');
    if (!/当前时间/.test(p)) throw new Error('提示词缺时间上下文');
    T.refreshSystemPrompt(false);
  });

  await step('settings 渲染 + 保存不炸', () => {
    T.renderSettings();
    T.saveSettings();
  });

  await step('引导页：权限项按系统版本过滤（Android 11 应有 channel、Android 7 不应有）', () => {
    const names = T.activePermItems().map(i => i.id);
    if (ENVINFO.sdk >= 26 && !names.includes('channel'))
      throw new Error('Android 8+ 上缺 channel 项：' + names);
    if (ENVINFO.sdk < 26 && names.includes('channel'))
      throw new Error('Android 7 上不该出现 channel 项：' + names);
    if (!names.includes('overlay') || !names.includes('notification'))
      throw new Error('缺必需项：' + names);
    if (T.activePermItems().filter(i => i.required).length !== 2)
      throw new Error('必需项数量不对，应为 2');
    T.showGuide();
  });

  await step('引导页：量不到页脚就降级成整页滚动（低版本兼容兜底）', () => {
    if (typeof T.ensureGuideFooterVisible !== 'function') throw new Error('兜底函数没导出');
    // 直接调用不应抛错；真实判定靠 getBoundingClientRect，假 DOM 里恒为矩形
    T.ensureGuideFooterVisible();
    T.hideGuide();
    T.ensureGuideFooterVisible();   // 隐藏状态下调用也得安全退出
  });

  await step('静态结构：「先跳过 / 下一步」确实在 DOM 里', () => {
    for (const id of ['guide-skip', 'guide-next', 'guide-steps']) {
      if (!html.includes('id="' + id + '"')) throw new Error('index.html 里找不到 #' + id);
    }
    if (!/\.guide-steps\{[^}]*min-height:0/.test(html))
      throw new Error('.guide-steps 缺 min-height:0 —— 页脚会被顶出屏幕');
  });

  await step('环境检测：WebView 版本分级', () => {
    const lv = T.webviewLevel();
    if (!['bad', 'old', 'ok', 'unknown'].includes(lv)) throw new Error('未知分级 ' + lv);
    const e = T.loadEnv();
    if (!e || e.sdk !== ENVINFO.sdk) throw new Error('读到的 sdk 不对：' + JSON.stringify(e));
    if (T.sdkAtLeast(26) !== (ENVINFO.sdk >= 26)) throw new Error('sdkAtLeast 判定不对');
  });

  console.log('');
  if (errors.length) {
    console.log('✗ 发现 ' + errors.length + ' 个问题：\n');
    errors.forEach((e, i) => console.log('[' + (i + 1) + '] ' + e + '\n'));
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
})().catch(e => {
  console.error('harness 自身出错：', e);
  process.exit(2);
});

// 看门狗：卡住就报出来，别静默挂着
setTimeout(() => {
  console.error('✗ 超时：有未完成的用例。已跑到的错误：');
  errors.forEach((e, i) => console.error('[' + (i + 1) + '] ' + e));
  process.exit(3);
}, 60000).unref();
