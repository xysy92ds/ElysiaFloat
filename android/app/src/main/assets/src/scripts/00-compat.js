
(function(){
'use strict';

/* ==========================================================
 *  旧版 WebView 兼容垫片
 * ========================================================== */
if (!Promise.allSettled) {
  Promise.allSettled = function(list) {
    return Promise.all(Array.from(list).map(function(p) {
      return Promise.resolve(p).then(
        function(v) { return { status: 'fulfilled', value: v }; },
        function(e) { return { status: 'rejected', reason: e }; }
      );
    }));
  };
}

/**
 * 给 <html> 挂上能力标记。
 * 老机器（Android 8 自带的老 WebView）缺 flex gap / backdrop-filter，
 * 光看版本号不可靠，所以直接拿两个 div 量一下最实在。
 * 这里必须在样式生效前跑完，否则会明显闪一下。
 */
function detectCaps() {
  const root = document.documentElement;

  // 这段脚本在 <head> 里，document.body 还不存在，所以挂到 <html> 上量。
  const host = document.body || document.documentElement;

  // flex gap：Chrome 84+。建个纵向 flex，看两个 10px 方块的总高是不是 22。
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;left:-9999px;top:0;display:flex;flex-direction:column;gap:2px';
    box.innerHTML = '<i style="height:10px"></i><i style="height:10px"></i>';
    host.appendChild(box);
    const ok = box.getBoundingClientRect().height > 21;
    host.removeChild(box);
    if (!ok) root.className += ' noflexgap';
  } catch (e) { root.className += ' noflexgap'; }

  // backdrop-filter：Chrome 76+（带 -webkit- 前缀的从 51 起）。
  try {
    const sup = (window.CSS && CSS.supports) ? CSS.supports.bind(CSS) : null;
    const has = sup && (sup('backdrop-filter', 'blur(1px)') ||
                        sup('-webkit-backdrop-filter', 'blur(1px)'));
    if (!has) root.className += ' nobackdrop';
  } catch (e) { root.className += ' nobackdrop'; }
}

detectCaps();

/* ==========================================================
 *  桥接层
 * ========================================================== */
const HAS_NATIVE = typeof Android !== 'undefined' && Android !== null;
const HAS_PERM   = typeof Perm !== 'undefined' && Perm !== null;

/**
 * 原生播放器句柄（AudioEngine 暴露在 Android 上的 mpXxx 一族）。
 * 拿到实例才走原生，否则说明跑在旧壳/浏览器里，退回 <audio>。
 * 注意：这里必须逐个试属性 —— HAS_NATIVE 在旧版 APK 里也是 true，
 * 但那时根本没有 mpLoad，光看 HAS_NATIVE 会一头撞进空方法。
 */
function MP() {
  if (!HAS_NATIVE) return null;
  try {
    return (typeof Android.mpLoad === 'function' &&
            typeof Android.mpToggle === 'function' &&
            typeof Android.mpStop === 'function') ? Android : null;
  } catch (e) { return null; }
}

/* ---------- 密钥仓（0.9 / E2-004） ---------- */
/**
 * 明文 Key 不再写进 via_ai_config。原生 SecretsVault 用 AndroidKeyStore 加密，
 * 这里只按名称存取。桥不可用时（旧 APK / 浏览器）secretStore.ok=false，
 * 调用方应继续允许旧行为，避免旧版本用户丢 Key。
 */
const SECRET_BRIDGE_OK = HAS_NATIVE && typeof Android.secretPut === 'function';
const secretStore = {
  ok: SECRET_BRIDGE_OK,
  put: (name, value) => {
    try { return !!(SECRET_BRIDGE_OK && Android.secretPut(String(name), String(value == null ? '' : value))); }
    catch (e) { return false; }
  },
  get: (name, def) => {
    try {
      if (!SECRET_BRIDGE_OK || typeof Android.secretGet !== 'function') return def === undefined ? '' : def;
      const v = Android.secretGet(String(name), def === undefined ? '' : String(def));
      return v == null ? (def === undefined ? '' : def) : String(v);
    } catch (e) { return def === undefined ? '' : def; }
  },
  has: (name) => {
    try { return !!(SECRET_BRIDGE_OK && Android.secretHas && Android.secretHas(String(name))); }
    catch (e) { return false; }
  },
  del: (name) => {
    try { return !!(SECRET_BRIDGE_OK && Android.secretDelete && Android.secretDelete(String(name))); }
    catch (e) { return false; }
  },
  list: () => {
    try {
      if (!SECRET_BRIDGE_OK || !Android.secretList) return [];
      const raw = Android.secretList();
      const arr = JSON.parse(raw || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
};

/** 会进密钥仓的配置字段；持久化配置里必须剔除。 */
const SECRET_FIELDS_CFG = ['apiKey', 'visionKey', 'ttsApiKey'];
const SECRET_FIELDS_MEM = ['vecKey'];
const SECRET_SCOPES = [
  { key: 'via_ai_config', fields: SECRET_FIELDS_CFG, prefix: 'ai' },
  { key: 'via_ai_mem_config', fields: SECRET_FIELDS_MEM, prefix: 'mem' }
];
function secretScopeOf(key) {
  for (let i = 0; i < SECRET_SCOPES.length; i++) if (SECRET_SCOPES[i].key === key) return SECRET_SCOPES[i];
  return null;
}

/** 把对象里的明文 Key 写进密钥仓；空值表示删除。只处理对象自身确实携带的字段。 */
function secretPersist(obj, fields, prefix) {
  if (!secretStore.ok || !obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!Object.prototype.hasOwnProperty.call(obj, f)) continue;
    const v = obj[f];
    const name = prefix + '.' + f;
    if (typeof v === 'string' && v) { if (secretStore.put(name, v)) n++; }
    else if (secretStore.del(name)) n++;
  }
  return n;
}

/** 启动时把旧明文 Key 收进密钥仓，或者把已保存的 Key 取回内存。 */
function secretHydrate(obj, fields, prefix) {
  if (!secretStore.ok || !obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const name = prefix + '.' + f;
    const cur = typeof obj[f] === 'string' ? obj[f] : '';
    if (cur) { if (secretStore.put(name, cur)) n++; }
    else {
      const got = secretStore.get(name, '');
      if (got) { obj[f] = got; n++; }
    }
  }
  return n;
}

/** 持久化前的副本：剔除 Key 字段，返回新对象；没有变化时返回原对象。 */
function stripSecretFields(key, value) {
  const scope = secretScopeOf(key);
  if (!scope || !secretStore.ok) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let out = value;
  for (let i = 0; i < scope.fields.length; i++) {
    const f = scope.fields[i];
    if (Object.prototype.hasOwnProperty.call(out, f)) {
      if (out === value) out = Object.assign({}, value);
      delete out[f];
    }
  }
  return out;
}

/* ---------- 存储 ---------- */
const sGet = (k, d) => {
  try {
    if (HAS_NATIVE && Android.getValue) {
      const v = Android.getValue(k, null);
      if (v !== null && v !== undefined && v !== '') {
        try { return JSON.parse(v); } catch (e) { return v; }
      }
      return d;
    }
  } catch (e) {}
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
  catch (e) { return d; }
};
const sSet = (k, v) => {
  try {
    const scope = secretScopeOf(k);
    if (scope && secretStore.ok && v && typeof v === 'object') {
      // 先落密钥仓，再写剔除 Key 的副本；顺序不能反，否则崩在中途会丢 Key。
      secretPersist(v, scope.fields, scope.prefix);
      v = stripSecretFields(k, v);
    }
  } catch (e) {}
  try {
    if (HAS_NATIVE && Android.setValue) { Android.setValue(k, JSON.stringify(v)); return; }
  } catch (e) {}
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
};

/* ---------- 网络：回调派发 ---------- */
const pendingReq = {};
let reqSeq = 0;
// P2 收尾：每次发送提升一次运行令牌；旧轮次的迟到回调直接丢弃。
let RUN_TOKEN = 0;
function runIsStale(token) { return token !== RUN_TOKEN; }
window.__gmCb = function(id, ok, code, text, err, metaJson){
  const p = pendingReq[id];
  if (!p) return;
  delete pendingReq[id];
  if (p.timer) clearTimeout(p.timer);
  if (p.token !== undefined && runIsStale(p.token)) {
    // 旧轮次的回调：直接以“已取消”结束，避免请求悬挂到超时
    try { p.reject(reqCancelledError('运行已被新的请求取代')); } catch (e) {}
    return;
  }
  let meta = null;
  if (metaJson) { try { meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson; } catch (e) { meta = null; } }
  if (ok) {
    p.resolve({ status: code, text: text, meta: meta || {} });
  } else {
    const e = new Error(err || ('HTTP ' + code));
    if (meta && meta.errorCode) e.code = meta.errorCode;
    e.requestError = true;
    e.status = code;
    e.meta = meta || null;
    p.reject(e);
  }
};

/**
 * 兼容适配层：所有出网请求最终都走 RequestManager（00b-request.js）。
 * 保留旧的 (method, url, headers, body, timeout, taskId) 签名与 {status,text} 返回值，
 * 这样 9 个旧调用点不用一次性重写也不会绕过统一策略。
 */
function nativeReq(method, url, headers, body, timeout, taskIdOverride) {
  return reqRequest({
    method: method,
    url: url,
    headers: headers || null,
    body: body || '',
    timeoutMs: timeout || 20000,
    taskId: taskIdOverride || '',
    retries: 2, source: 'legacy:compat'
  }).then(r => ({ status: r.status, text: r.text, json: r.json, contentType: r.contentType, url: r.url, elapsedMs: r.elapsedMs }));
}
function cancelTaskRequests(taskId) {
  Object.keys(pendingReq).forEach(id => {
    const p = pendingReq[id];
    if (!p || p.taskId !== taskId) return;
    if (HAS_NATIVE && Android.cancelRequest) { try { Android.cancelRequest(id); } catch (e) {} }
    if (p.timer) clearTimeout(p.timer);
    delete pendingReq[id];
    try { p.reject(reqCancelledError('任务已取消')); } catch (e) {}
  });
  if (typeof cancelPluginTask === 'function') { try { cancelPluginTask(taskId); } catch (e) {} }
  if (typeof cancelScreenCapture === 'function') { try { cancelScreenCapture(taskId); } catch (e) {} }
}
const gmGet = (url, t) => nativeReq('GET', url, null, null, t).then(r => r.text);

/* ---------- 其它 ---------- */
const pAny = (arr) => typeof Promise.any === 'function'
  ? Promise.any(arr)
  : new Promise((res, rej) => {
      let n = 0; const a = Array.from(arr);
      if (!a.length) return rej(new Error('无候选'));
      a.forEach(p => Promise.resolve(p).then(res, () => {
        if (++n === a.length) rej(new Error('全部失败'));
      }));
    });

async function pMap(arr, fn, n) {
  n = n || 5;
  const r = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) {
      const k = i++;
      try { r[k] = await fn(arr[k]); } catch (e) { r[k] = null; }
    }
  }));
  return r;
}

const errMsg = (err) => {
  if (typeof err === 'string') return err;
  const base = (err && err.message) || (err && err.error && err.error.message) || String(err || '') || '未知错误';
  const code = err && err.code;
  // 统一请求错误的错误码对用户可见，但不要重复拼接
  let out = base;
  if (code && String(base).indexOf(String(code)) < 0) out = base + '〔' + code + '〕';
  // 服务端不认模型名时，真正的原因几乎都是「Key 的分组不提供这个模型」，
  // 直接把排查方向写出来，省得对着 404 猜是不是没保存。
  if (/model_not_found|model is not available|模型不存在|model not found/i.test(out)) {
    out += '\n提示：当前 Key 的分组不提供这个模型名。请到 设置 → 模型 核对模型名，' +
      '或点「检测」从服务端拉一份可用列表；改完记得点保存。';
  }
  return out;
};

/** 从文本里摘掉"看起来像工具调用"的 JSON 片段（用括号配对扫描，避免误伤普通文字） */
function stripToolJsonSpans(text) {
  const src = String(text == null ? '' : text);
  let out = '', i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '{' && ch !== '[') { out += ch; i++; continue; }
    const open = ch, close = ch === '{' ? '}' : ']';
    let depth = 0, j = i, inStr = false, esc2 = false, ended = -1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (esc2) { esc2 = false; continue; }
        if (c === '\\') { esc2 = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { ended = j; break; } }
    }
    if (ended < 0) { out += ch; i++; continue; }          // 没有配对，按普通字符处理
    const span = src.slice(i, ended + 1);
    const looksTool = /"(tool_calls|tool_call|function_call|name|arguments|parameters)"\s*:/.test(span)
      && span.length <= 4000;
    if (looksTool) { i = ended + 1; continue; }            // 整段丢弃
    out += span; i = ended + 1;
  }
  return out;
}

/**
 * 清掉模型偶尔漏到正文里的「工具调用」与乱码。
 * 前端渲染统一走这里，避免把 JSON 伪代码/特殊 token 当成聊天内容显示。
 * 返回空串时调用方应跳过这条气泡（状态小字里已经有"正在执行 xx"了）。
 */
function cleanAssistantText(raw) {
  let t = String(raw == null ? '' : raw);
  // 1) 整块的工具调用标记
  t = t.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, '');
  t = t.replace(/<function_calls?>[\s\S]*?<\/function_calls?>/gi, '');
  t = t.replace(/<\|tool_call\|[\s\S]*?(?:<\|\/tool_call\|>|$)/gi, '');
  // 2) 围栏代码块里如果是工具调用 JSON，整块丢掉
  t = t.replace(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g, (m, body) => {
    const b = String(body || '').trim();
    if (/^[{[]/.test(b) && /"(name|tool_calls|function|arguments|parameters)"\s*:/.test(b)) return '';
    return m;
  });
  // 3) 正文里夹带的 JSON 工具调用：找出配对的 {...}，只要内容像工具调用就整段删掉
  t = stripToolJsonSpans(t);
  // 4) 特殊控制 token 与常见伪标记
  t = t.replace(/<\|[^|>]*\|>/g, '');
  t = t.replace(/<\/?(?:tool|function|result|observation|thinking)[^>]*>/gi, '');
  // 5) 乱码：替换字符、控制字符、零宽字符
  t = t.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E]/g, '');
  // 6) 收尾：压缩连续空行
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

const esc = (t) => {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(t == null ? '' : t)));
  return d.innerHTML;
};
const b64e = (s) => {
  // 不依赖 TextEncoder，兼容老 WebView
  return btoa(unescape(encodeURIComponent(String(s))));
};
const b64d = (s) => {
  return decodeURIComponent(escape(atob(String(s).replace(/\s+/g, ''))));
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ==========================================================
 *  运行环境探测
 *  低版本适配、排查远程问题都靠它。一次性拿完缓存住。
 * ========================================================== */
let ENV = null;
function loadEnv() {
  if (ENV) return ENV;
  try { ENV = JSON.parse(Perm.getEnvInfo()); } catch (e) { ENV = null; }
  if (!ENV || typeof ENV.sdk !== 'number') ENV = null;
  return ENV;
}
function sdkAtLeast(n) {
  const e = loadEnv();
  // 拿不到就当作满足，宁可多显示一项也不要漏掉该看的。
  return !e || e.sdk >= n;
}
function osAtLeast(n) { return sdkAtLeast(n); }

/** WebView 主版本号，比如 "138.0.7204.63" → 138；拿不到返回 0。 */
function webviewMajor() {
  const e = loadEnv();
  if (!e || !e.webviewVer) return 0;
  const m = String(e.webviewVer).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * WebView 版本要不要提醒。
 *   57 以下：padStart 之类的基础 API 都没了，真的会乱。
 *   57~83 ：能用，但 Flex gap / inset 这些要走到兼容分支。
 * 两种都已处理，只是告知一声，不让用户以为是坏了。
 */
function webviewLevel() {
  const v = webviewMajor();
  if (!v) return 'unknown';
  if (v < 57) return 'bad';
  if (v < 84) return 'old';
  return 'ok';
}

function renderEnvBox() {
  const box = $('#env-box');
  if (!box) return;
  const e = loadEnv();
  if (!e) {
    box.innerHTML = '<div class="env-row"><span>状态</span><span>拿不到环境信息</span></div>';
    return;
  }
  const wv = webviewMajor();
  const rows = [
    ['App 版本', e.appVer],
    ['Android', 'API ' + e.sdk + '（' + e.release + '）'],
    ['设备', e.brand + ' ' + e.model],
    ['WebView', e.webviewVer + '（' + e.webviewPkg + '）'],
    ['屏幕', e.screenW + '×' + e.screenH + ' @' + e.densityDpi + 'dpi'],
    ['缩放比 dpr', String(e.density)],
    ['兼容模式', document.documentElement.className.replace(/^\s+|\s+$/g, '') || '无'],
    ['窗口矩形', (function () {
      const r = readRect();
      return r && r.w ? (r.w + '×' + r.h + ' @' + r.x + ',' + r.y + '，缩放 '
        + (BASE ? (r.w / r.bw).toFixed(2) : '-') + 'x') : '-';
    })()]
  ];
  let html = rows.map(r =>
    '<div class="env-row"><span>' + esc(r[0]) + '</span><span>' + esc(String(r[1] == null ? '-' : r[1])) + '</span></div>'
  ).join('');

  if (wv && wv < 57) {
    html += '<div class="env-warn">这个系统里内置的 WebView 太旧了（Chrome ' + wv +
      '），部分功能可能显示异常。建议到应用商店更新「Android System WebView」，或者直接升级系统。</div>';
  } else if (wv && wv < 84) {
    html += '<div class="env-warn">WebView 版本偏旧（Chrome ' + wv +
      '），已自动开启兼容模式（间距、圆角等有细微差别），不影响正常使用。</div>';
  }
  box.innerHTML = html;
}

let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2400);
}
function vibrate(ms) {
  try { if (HAS_NATIVE && Android.vibrate) Android.vibrate(ms || 15); } catch (e) {}
}

/* ==========================================================
 *  启动守护
 *  原地升级后，如果某个脚本在初始化时抛异常（旧版 localStorage
 *  结构不兼容是常见原因），整个 bundle 会静默停摆：没有报错、
 *  没有界面，只剩空白。这里兜住异常并给一条自救路径，
 *  免得用户只能靠卸载重装。
 * ========================================================== */
let __bootOk = false;
let __bootTimer = null;
/** 启动真的走完了：撤掉超时器，并把「超时」误报出来的面板一起收走。 */
window.__bootDone = function () {
  __bootOk = true;
  if (__bootTimer) { clearTimeout(__bootTimer); __bootTimer = null; }
  const el = document.getElementById('boot-fail');
  if (el && el.parentNode) el.parentNode.removeChild(el);
};

function bootEsc(s) {
  // 不能用文件里的 esc：出错可能发生在它定义之前（TDZ），这里自带一份。
  const m = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  return String(s == null ? '' : s).replace(/[&<>]/g, c => m[c]);
}

function bootFail(reason) {
  if (__bootOk || document.getElementById('boot-fail')) return;
  const box = document.createElement('div');
  box.id = 'boot-fail';
  box.style.cssText = 'position:fixed;left:12px;right:12px;top:50%;transform:translateY(-50%);' +
    'z-index:2147483647;padding:16px;border-radius:14px;background:#fff6f9;color:#5b3a44;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.22);font:13px/1.6 system-ui,sans-serif';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:6px;font-size:14px">启动中途卡住了</div>' +
    '<div style="opacity:.78;margin-bottom:8px">下边是出错原因。多数情况是旧版本留下的本地数据跟新版本不兼容，' +
    '重置本地数据即可，不用卸载重装。</div>' +
    '<pre style="max-height:110px;overflow:auto;margin:0 0 10px;padding:8px;border-radius:8px;' +
    'background:rgba(0,0,0,.05);white-space:pre-wrap;word-break:break-all;font-size:11px">' +
    bootEsc(reason || '未知原因') + '</pre>' +
    '<div style="display:flex;gap:8px">' +
    '<button id="boot-retry" style="flex:1;padding:9px;border:0;border-radius:9px;' +
    'background:#ffd9e4;color:#a8324f;font-weight:600">重新加载</button>' +
    '<button id="boot-reset" style="flex:1;padding:9px;border:0;border-radius:9px;' +
    'background:#ff8fb1;color:#fff;font-weight:600">重置本地数据</button></div>';
  (document.body || document.documentElement).appendChild(box);
  // 点完立刻给反馈：重载是瞬时的，不给反馈用户会以为按钮没响应。
  document.getElementById('boot-retry').onclick = (ev) => {
    ev.target.textContent = '正在重新加载…';
    ev.target.disabled = true;
    setTimeout(() => location.reload(), 60);
  };
  document.getElementById('boot-reset').onclick = (ev) => {
    ev.target.textContent = '正在重置…';
    ev.target.disabled = true;
    try { localStorage.clear(); } catch (e) {}
    setTimeout(() => location.reload(), 60);
  };
}

window.addEventListener('error', (e) => bootFail((e && e.message) || '脚本执行出错'));
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  bootFail('异步任务出错：' + ((r && (r.message || r)) || '未知'));
});
// 冷启动第一次要跑完 25 个模块的初始化，老机器上 12 秒并不宽裕；
// 宁可多等一会儿，也不要冤枉好人。真卡死时下面这个面板照样会出来。
__bootTimer = setTimeout(() => { __bootTimer = null; bootFail('启动超时（20 秒内没走完初始化）'); }, 20000);

