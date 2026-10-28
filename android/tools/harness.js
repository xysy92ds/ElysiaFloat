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
  'togglePlug', 'toggleTool', 'toolOn', 'renderPlugins', 'renderPlugMarket', 'transBatch', 'refreshVoices', 'CONFIG', 'DC', 'PLUGINS', 'toolLive', 'mSearch', 'mGetUrl', 'parseMusicUrlResponse', 'getAudio', 'MP',
  'plugNormalize', 'plugManifestError', 'plugExec', 'plugUrlAllowed', 'plugFind', 'plugPermissionGranted', 'PLUG_PERMISSION_INFO', 'PLUGIN_MARKET_INDEX', 'USER_PLUGINS', 'verArr', 'cmpVer',
  'PLUG_SANDBOX_HTML', 'PLUG_HELP', 'MEM', 'memSimilarContent',
  'saveSettings', 'renderSettings', '$',
  'reqRequest', 'REQ_CODE', 'REQ_RETRY_DELAY', 'reqAuditList', 'reqAuditClear', 'reqToken', 'reqIsRetriable', 'reqHost', 'reqSameHostOnly', 'musicStripVolatile', 'musicRemember', 'M', 'execTool', 'USER_PLUGINS', 'taskAdd', 'taskUpdate', 'taskResume', 'taskCancel', 'errMsg', 'TASKS', 'MEMCFG', 'checkUpdate',  'chatReq', 'memEmbed',  'mGetLyric', 'deviceState', 'deviceSetPhase', 'devicePhaseOf', 'deviceReset', 'deviceOrient', 'canParallelTool', 'isDeviceAction', 'DEVICE_PHASES', 'planToolBatch', 'screenDigest', 'screenFingerprint', 'screenCacheClear', 'deviceWaitChange', 'agentVerifyAction', 'deviceBudget', 'deviceBudgetLeft', 'deviceGrantMore', 'recordDeviceAction', 'closeModal', 'taskEnsureChat', 'chatTasks', 'taskBegin', 'detectModels', 'memAutoTick', 'memAutoState', 'memSummarize', 'taskFinish', 'routeTask', 'taskContinuable', 'cleanAssistantText', 'taskSetCurrent', 'addMsg', 'copyToClipboard', 'pasteIntoField', 'readClipboard', 'bindCtxMenu', 'modelTimeout', 'agentLevelAtLeast', 'previewKindOf', 'openPreview', 'addExportCard', 'prettyIfJson', 'cancelTaskRequests', 'currentTask', 'reqCancelledError',
  'showGuide', 'hideGuide', 'ensureGuideFooterVisible', 'activePermItems', 'PERM_ITEMS',
  'consentGranted', 'consentGrant', 'consentRevokeTask', 'ensureDeviceConsent', 'taskToolsAllowed',
  'saveHistory', 'taskHistoryKey', 'clearTaskHistory', 'saveTasks',
  'renderGuideSteps', 'webviewLevel', 'loadEnv', 'sdkAtLeast', 'detectCaps', 'send',
  'secretStore', 'secretHydrate', 'secretPersist', 'stripSecretFields', 'SECRET_FIELDS_CFG', 'SECRET_FIELDS_MEM',
  'sSet', 'sGet',
  'providerEnsure', 'providerSummary', 'providerUpsert', 'providerBind', 'providerRemove', 'providerResolve', 'providerApply', 'PROVIDER_CAPS', 'PROVIDER_PURPOSES',
  'providerTest', 'providerFind', 'providerMigrate', 'providerSyncLegacy', 'providerKeyOf', 'providerInferCaps', 'PROVIDER_KINDS',
  'usageRecord', 'usageCheck', 'usageSummary', 'usageReset', 'usageLoad', 'usageLimits', 'USAGE_KEY',
  'autoConfirmActive', 'autoConfirmOn', 'autoConfirmOff', 'AUTO_CONFIRM', 'AUTO_CONFIRM_SCOPE', 'toggleAutoConfirm', 'updateAutoConfirmBtn',
  'showView', 'viewBack', 'currentViewId', 'VIEW_STACK', 'handleNativeBack', 'updateRunStatus'];
const cuts = js.lastIndexOf('})();');
if (cuts < 0) { console.error('没找到 IIFE 结尾'); process.exit(1); }
js = js.slice(0, cuts) + '\ntry { window.__T = {' + EXPORTS.join(',') + '}; window.__T.getHistory = function () { return history; }; } catch (e) { console.error("EXPORT FAIL", e); }\n' + js.slice(cuts);

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
/** 假密钥仓：只存内存，模拟 AndroidKeyStore 的密文仓，测试里可断言“明文没进 store”。 */
const vaultStore = new Map();
const calls = { mp: [], tts: [], ui: [], net: [], tools: [], ws: [] };
/** 可被测试改写的假页面：screenW/H + nodes */
const SCREEN_STUB = {
  name: '首页',
  nodes: [
    { t: '首页', x: 0, y: 0, w: 1080, h: 100, clk: false, cls: 'TextView' },
    { t: '搜索', x: 900, y: 100, w: 120, h: 90, clk: true, cls: 'Button' },
    { t: '输入框', x: 40, y: 200, w: 800, h: 90, clk: true, edt: true, foc: true, cls: 'EditText' },
    { t: '密码', x: 40, y: 320, w: 800, h: 90, clk: true, edt: true, pwd: true, cls: 'EditText' }
  ]
};
function stubDigest() {
  return { screen: { w: 1080, h: 2400 }, count: SCREEN_STUB.nodes.length, nodes: SCREEN_STUB.nodes };
}

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

/** 假响应体：所有假网络接口共用，避免 request/requestEx 两套数据不一致。 */
function fakeHttpBody(rawUrl) {
  let text = '[]';
  try {
    const u = decodeURIComponent(String(rawUrl));
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
    } else if (/notjson/.test(u)) {
      text = '<html>not json</html>';
    }
  } catch (e) { }
  return text;
}

const Android = {
  getValue(k, def) { return store.has(k) ? store.get(k) : (def === undefined ? null : def); },
  setValue(k, v) { store.set(k, String(v)); },
  secretPut(k, v) { vaultStore.set(String(k), String(v)); return true; },
  secretGet(k, def) { return vaultStore.has(String(k)) ? vaultStore.get(String(k)) : (def === undefined ? null : def); },
  secretHas(k) { return vaultStore.has(String(k)); },
  secretDelete(k) { return vaultStore.delete(String(k)); },
  secretList() { return JSON.stringify([...vaultStore.keys()].sort()); },
  clearAll() { store.clear(); vaultStore.clear(); },
  // 网络：把结果异步回抛给 window.__gmCb
  request(id, method, url, headersJson, body, timeout) {
    calls.net.push({ method, url });
    const text = fakeHttpBody(url);
    setTimeout(() => {
      try { sandbox.window.__gmCb(id, true, 200, text, ''); } catch (e) { }
    }, 0);
  },
  // 新接口：带状态码 / 错误码 / 大小上限，用来验证 RequestManager
  requestEx(id, method, url, headersJson, body, timeout, optsJson) {
    calls.net.push({ method, url, ex: true });
    let opts = {};
    try { opts = JSON.parse(optsJson || '{}'); } catch (e) { }
    const u = String(url);
    const reply = (ok, code, text, err, meta) => setTimeout(() => {
      try { sandbox.window.__gmCb(id, ok, code, text, err || '', JSON.stringify(meta || {})); } catch (e) { }
    }, 0);
    if (u.indexOf('__slow') >= 0) return;                       // 永不回，用来测超时
    if (u.indexOf('__500') >= 0) return reply(false, 500, '{"error":"boom"}', 'HTTP 500', { errorCode: 'HTTP_ERROR', status: 500 });
    if (u.indexOf('__429') >= 0) return reply(false, 429, '', 'HTTP 429', { errorCode: 'RATE_LIMITED', status: 429 });
    if (u.indexOf('__401') >= 0) return reply(false, 401, '', 'HTTP 401', { errorCode: 'AUTH_ERROR', status: 401 });
    if (u.indexOf('__loop') >= 0) return reply(false, 0, '', '超过最大重定向次数', { errorCode: 'REDIRECT_ERROR' });
    if (u.indexOf('__big') >= 0) return reply(false, 0, '', '响应超过上限', { errorCode: 'TOO_LARGE' });
    let text = fakeHttpBody(u);
    if (opts && opts.maxBytes && text.length > opts.maxBytes) return reply(false, 0, '', '响应超过上限', { errorCode: 'TOO_LARGE' });
    reply(true, 200, text, '', { errorCode: '', bytes: text.length, finalUrl: u, contentType: 'application/json' });
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
  getForegroundPackage() { return 'com.test.app'; },
  getScreenText() { return SCREEN_STUB.nodes.map(n => n.t).join('\n'); },
  getScreenTextOnce() { return SCREEN_STUB.nodes.map(n => n.t).join('\n'); },
  getScreenNodes() { return '[]'; },
  agentWorkspaceMkdir(path) { calls.ws.push(['mkdir', path]); return JSON.stringify({ ok: true, relative: path }); },
  agentWorkspaceWrite(path, text, overwrite) {
    calls.ws.push(['write', path, String(text || '').length, !!overwrite]);
    return JSON.stringify({ ok: true, relative: path, bytes: String(text || '').length });
  },
  agentWorkspaceList(path) { return JSON.stringify({ ok: true, path: path || '', entries: [] }); },
  agentWorkspaceRead(path) { return JSON.stringify({ ok: true, path: path, text: '' }); },
  snapshotTaskFile(id, path) { calls.ws.push(['snap', path]); return JSON.stringify({ ok: true, existed: false }); },
  getScreenDigest() { return JSON.stringify(stubDigest()); },
  getAgentWhitelist() { return JSON.stringify(Perm.__whitelist || ['com.test.app']); },
  getAgentState() { return JSON.stringify({ allowAll: false, l3: true, safety: true }); },
  agentTap(x, y) { calls.tools.push('tap:' + x + ',' + y); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app', label: 'tap' }); },
  agentClickText(t) { calls.tools.push('click:' + t); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app', label: t }); },
  agentSwipe() { calls.tools.push('swipe'); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app' }); },
  agentInputText(t) { calls.tools.push('input:' + t); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app' }); },
  agentKey(k) { calls.tools.push('key:' + k); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app' }); },
  agentLaunch(a) { calls.tools.push('launch:' + a); return JSON.stringify({ ok: true, level: 'L3', package: 'com.test.app', label: a }); },
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

module.exports = { html, js, sandbox, context, T, errors, calls, store, vaultStore, ENVINFO, Android, Perm, document, q1, mkEl, vm, SCREEN_STUB };
