/* ==========================================================
 *  TTS（走原生）
 * ========================================================== */
function setBtn(btn, state) {
  if (!btn) return;
  if (state === 'loading') {
    btn.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    btn.disabled = true;
  } else if (state === 'playing') {
    btn.innerHTML = '⏸ 停止';
    btn.disabled = false;
  } else {
    btn.innerHTML = '🔊 朗读';
    btn.disabled = false;
  }
}
let curPlayBtn = null;

window.__ttsStart = function () {
  if (curPlayBtn) setBtn(curPlayBtn, 'playing');
};
window.__ttsDone = function () {
  if (curPlayBtn) setBtn(curPlayBtn, 'idle');
  curPlayBtn = null;
};
window.__ttsError = function (msg) {
  if (curPlayBtn) setBtn(curPlayBtn, 'idle');
  curPlayBtn = null;
  if (msg) toast('朗读失败：' + msg);
};

function stopTTS() {
  try { if (HAS_NATIVE && Android.ttsStop) Android.ttsStop(); } catch (e) {}
  try { if (HAS_NATIVE && Android.stopSpeak) Android.stopSpeak(); } catch (e) {}
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {}
}

/**
 * 把 markdown 去掉再读。不然它会一本正经地把「星号星号」也念出来。
 */
function ttsStripMd(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' 代码省略 ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[*`#]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按句切。切小了才能边下边播，不然要等整段语音全下完才出声。 */
function ttsSplit(text) {
  const enders = '。！？!?；;';
  const raw = [];
  let cur = '';
  for (const ch of String(text)) {
    cur += ch;
    if (enders.indexOf(ch) >= 0 || ch === '\n') {
      const t = cur.trim();
      if (t) raw.push(t);
      cur = '';
    }
  }
  const tail = cur.trim();
  if (tail) raw.push(tail);
  // 太短的句子并到前一句，别为了两个字发一次请求
  const merged = [];
  for (const p of raw) {
    if (merged.length && merged[merged.length - 1].length < 12) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  return merged.length ? merged : [String(text)];
}

function ttsAiRequest(seg) {
  const base = String(CONFIG.ttsBaseUrl || DC.ttsBaseUrl || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.ttsApiKey) headers['Authorization'] = 'Bearer ' + CONFIG.ttsApiKey;
  const body = {
    model: CONFIG.ttsModel || DC.ttsModel || 'tts-1',
    input: seg,
    voice: CONFIG.ttsVoice || DC.ttsVoice || 'alloy',
    response_format: 'mp3'
  };
  const sp = parseFloat(CONFIG.ttsRate) || 1;
  // speed 不是所有兼容接口都认，等于 1 时就不发了，少一个被 400 的理由
  if (Math.abs(sp - 1) > 0.01) body.speed = Math.max(0.25, Math.min(4, sp));
  return { url: base + '/audio/speech', headers, body };
}

/**
 * 真正开口。两条路都落到原生：
 *  - system：手机自带的 TTS 引擎
 *  - ai：JS 把请求拼好，原生负责下载 + 播放（和音乐共用一套唤醒锁，息屏也能出声）
 */
function speakText(text) {
  const clean = ttsStripMd(text);
  if (!clean) { toast('没有可朗读的内容'); return; }
  const engine = CONFIG.ttsEngine === 'ai' ? 'ai' : 'system';

  if (engine === 'ai') {
    if (!(HAS_NATIVE && Android.ttsAi)) { toast('当前环境不支持自建语音'); return; }
    if (!String(CONFIG.ttsBaseUrl || '').trim()) { toast('请先填写语音接口地址'); return; }
    try {
      stopTTS();
      // 一次全交出去：原生会一首接一首放，并趁上一句在播时先把下一句下好
      ttsSplit(clean).forEach(seg => {
        const r = ttsAiRequest(seg);
        Android.ttsAi(r.url, JSON.stringify(r.headers), JSON.stringify(r.body));
      });
    } catch (e) { toast('朗读失败：' + errMsg(e)); }
    return;
  }

  if (HAS_NATIVE && Android.speak) {
    try { Android.speak(clean, CONFIG.ttsRate); }
    catch (e) { toast('朗读失败：' + errMsg(e)); }
    return;
  }
  if ('speechSynthesis' in window) {
    try { speechSynthesis.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'zh-CN';
    u.rate = CONFIG.ttsRate;
    u.onstart = () => window.__ttsStart();
    u.onend = u.onerror = () => window.__ttsDone();
    speechSynthesis.speak(u);
    return;
  }
  toast('当前设备不支持朗读');
}

function toggleTTS(text, btn) {
  if (!CONFIG.ttsEnabled) return;
  if (curPlayBtn === btn) {
    stopTTS();
    setBtn(btn, 'idle');
    curPlayBtn = null;
    return;
  }
  if (curPlayBtn) {
    stopTTS();
    setBtn(curPlayBtn, 'idle');
  }
  curPlayBtn = btn;
  setBtn(btn, 'loading');
  speakText(text);
}

/* ---- 音色列表：从接口拉，拉不到就用内置的那份 ---- */
async function refreshVoices() {
  const base = String(CONFIG.ttsBaseUrl || '').replace(/\/+$/, '');
  if (!base) { toast('请先填写语音接口地址'); return; }
  const hint = $('#tts-voice-hint');
  if (hint) hint.textContent = '正在拉取...';
  try {
    const hdrs = {};
    if (CONFIG.ttsApiKey) hdrs['Authorization'] = 'Bearer ' + CONFIG.ttsApiKey;
    const r = await reqRequest({
      method: 'GET', url: base + '/audio/voices', headers: hdrs,
      timeoutMs: 15000, expect: 'json', retries: 1, source: 'system:tts'
    });
    let r2 = null;
    try { r2 = r.json; } catch (e) { throw new Error('返回的不是 JSON'); }
    const list = (r2 && (r2.data || r2.voices)) || [];
    const ids = list.map(v => (typeof v === 'string' ? v : (v.id || v.voice_id || v.name))).filter(Boolean);
    if (!ids.length) throw new Error('接口没有返回音色');
    TTS_VOICES.length = 0;
    ids.forEach(id => TTS_VOICES.push({ id: String(id), name: String(id) }));
    if (!CONFIG.ttsVoice && ids.length) CONFIG.ttsVoice = String(ids[0]);
    // 重绘前先把当前选择写回配置，否则切回来又变回默认引擎
    CONFIG.ttsEngine = groupVal('ttseng') === 'ai' ? 'ai' : 'system';
    sSet('via_ai_config', CONFIG);
    renderSettings();
    toast('拉到 ' + ids.length + ' 个音色 ♪');
  } catch (e) {
    if (hint) hint.textContent = '拉取失败（' + errMsg(e) + '），先用内置音色；很多接口本来就不提供这个列表，不影响朗读。';
  }
}

/* ==========================================================
 *  读屏 / 剪贴板
 * ========================================================== */
/** 工具调用用：不加长度门槛，看到什么给什么 */
function readScreenText() {
  if (HAS_PERM && Perm.getScreenText) {
    try { return (Perm.getScreenText() || '').trim(); } catch (e) {}
  }
  return '';
}
function readScreen(once) {
  // 一次性快捷操作优先走不受 Agent 总开关限制的原生读屏接口。
  const t = once && HAS_PERM && Perm.getScreenTextOnce ? String(Perm.getScreenTextOnce() || '') : readScreenText();
  return t && t.trim().length > 0 ? t.trim() : '';
}
/** 复制：优先走原生桥（WebView 里 navigator.clipboard 常被禁用） */
function copyToClipboard(text) {
  const t = String(text == null ? '' : text);
  if (!t) return false;
  try { if (HAS_NATIVE && Android.setClipboard) { Android.setClipboard(t); return true; } } catch (e) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return true; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {}
  return false;
}

/** 粘贴：把剪贴板内容插入光标位置（原生桥优先） */
function pasteIntoField(el) {
  if (!el) return false;
  const text = readClipboard();
  if (!text) { toast('读不到剪贴板：先点一下输入框，或用键盘上的“粘贴”键'); return false; }
  try {
    if (typeof el.selectionStart === 'number') {
      const s0 = el.selectionStart, e0 = el.selectionEnd;
      const v = String(el.value || '');
      el.value = v.slice(0, s0) + text + v.slice(e0);
      el.selectionStart = el.selectionEnd = s0 + text.length;
    } else {
      el.value = String(el.value || '') + text;
    }
    // Event 构造在部分 WebView/测试沙箱里不可用，包一层避免整个粘贴失败
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.focus(); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

function readClipboard() {
  try {
    if (HAS_NATIVE && Android.getClipboard) return Android.getClipboard() || '';
  } catch (e) {}
  return '';
}
/** 剪切板里的内容常带换行和前后空白，只取第一段有内容的行（API Key 一般就是这么复制的） */
function firstMeaningfulLine(s) {
  const lines = String(s == null ? '' : s).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}
/** 把剪贴板第一行填进输入框；填完短暂显示明文，方便核对 */
function fillPastedValue(input, v) {
  if (!input || !v) return;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (input.classList.contains('secret')) {
    input.classList.add('reveal');
    clearTimeout(input._revealT);
    input._revealT = setTimeout(() => input.classList.remove('reveal'), 2200);
  }
  toast('已粘贴，记得点「保存配置」~');
  vibrate(20);
}
function pasteIntoInput(input) {
  if (!input) return;
  const v = firstMeaningfulLine(readClipboard());
  if (v) { fillPastedValue(input, v); return; }
  // Android 10+ 常限制浮窗读剪贴板；再用 WebView 的剪贴板 API 兜底一次。
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(t => {
      const v2 = firstMeaningfulLine(t);
      if (v2) fillPastedValue(input, v2);
      else toast('剪贴板里没读到文字，先复制一下 API Key 吧~');
    }).catch(() => toast('剪贴板里没读到文字，先复制一下 API Key 吧~'));
    return;
  }
  toast('剪贴板里没读到文字，先复制一下 API Key 吧~');
}
function writeClipboard(t) {
  try {
    if (HAS_NATIVE && Android.setClipboard) { Android.setClipboard(t); return true; }
  } catch (e) {}
  return false;
}
function currentPageUrl() {
  if (HAS_PERM && Perm.getBrowserUrl) {
    try { return Perm.getBrowserUrl() || ''; } catch (e) {}
  }
  return '';
}
/**
 * 读屏一次并记录 hash（G5-1）。主动 orient 与动作前兜底都走这里。
 * G5-2 会在此基础上加摘要与 3s 缓存。
 */
/* ==========================================================
 *  G5-2 读屏摘要（分级软结构）+ 3s 缓存 + 比例坐标
 * ========================================================== */
const SCREEN_DIGEST_TTL = 3000;      // 3s 内重复读屏不再走无障碍树
let RAW_CACHE = { at: 0, data: null };
let LAST_DIGEST = { hash: '', at: 0 };

/** 清缓存（测试或切任务时用） */
function screenCacheClear() { RAW_CACHE = { at: 0, data: null }; LAST_DIGEST = { hash: '', at: 0 }; }

/** 原生原始节点：{ screen:{w,h}, count, nodes:[...] }（3s 内复用，避免重复遍历无障碍树） */
function rawScreenNodes(noCache) {
  const now = Date.now();
  if (!noCache && RAW_CACHE.data && now - RAW_CACHE.at < SCREEN_DIGEST_TTL) return RAW_CACHE.data;
  const fresh = readRawScreenNodes();
  RAW_CACHE = { at: Date.now(), data: fresh };
  return fresh;
}

function readRawScreenNodes() {
  if (HAS_PERM && Perm.getScreenDigest) {
    try {
      const o = JSON.parse(Perm.getScreenDigest() || '{}') || {};
      if (Array.isArray(o.nodes)) return o;
    } catch (e) {}
  }
  // 老版本原生没有 getScreenDigest：退化成旧接口 + 屏幕尺寸
  let nodes = [];
  try {
    if (HAS_PERM && Perm.getScreenNodes) nodes = JSON.parse(Perm.getScreenNodes() || '[]') || [];
  } catch (e) { nodes = []; }
  let w = 1080, h = 2400;
  try {
    const sz = HAS_PERM && Perm.getScreenSize ? JSON.parse(Perm.getScreenSize() || '{}') : null;
    if (sz && sz.w && sz.h) { w = sz.w; h = sz.h; }
  } catch (e) {}
  return { screen: { w, h }, count: nodes.length, nodes: nodes };
}

function nodeRatio(n, screen) {
  const rx = screen.w ? Math.min(1, Math.max(0, (Number(n.x || 0) + Number(n.w || 0) / 2) / screen.w)) : 0;
  const ry = screen.h ? Math.min(1, Math.max(0, (Number(n.y || 0) + Number(n.h || 0) / 2) / screen.h)) : 0;
  return { rx: Math.round(rx * 1000) / 1000, ry: Math.round(ry * 1000) / 1000 };
}

/**
 * 分级摘要。永不因为内容过长而失败：
 *   tier0 —— 可交互/密码/滚动节点（默认）
 *   tier1 —— 加纯文本行（detail:'more'）
 *   tier2 —— 全量分页（detail:'full'，每页 20 项）
 */
function screenDigest(opts) {
  const o = opts || {};
  const detail = o.detail === 'full' || o.detail === 'more' ? o.detail : 'basic';
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const raw = rawScreenNodes();
  const screen = { w: Number(raw.screen && raw.screen.w) || 1080, h: Number(raw.screen && raw.screen.h) || 2400 };
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  let pkg = '';
  try { if (HAS_PERM && Perm.getForegroundPackage) pkg = Perm.getForegroundPackage() || ''; } catch (e) {}

  const all = nodes.map((n, i) => {
    const r = nodeRatio(n, screen);
    return {
      i, t: String(n.t || ''),
      cx: Number(n.x || 0) + Math.round(Number(n.w || 0) / 2),
      cy: Number(n.y || 0) + Math.round(Number(n.h || 0) / 2),
      rx: r.rx, ry: r.ry,
      clk: !!n.clk, edt: !!n.edt, pwd: !!n.pwd, scr: !!n.scr, foc: !!n.foc,
      cls: String(n.cls || '')
    };
  });
  const interactive = all.filter(n => n.clk || n.edt || n.pwd || n.scr);
  const texts = all.filter(n => n.t);

  const pageHash = shortHash(pkg + '|' + texts.map(n => n.t).join('\n'));
  const now = Date.now();
  const repeated = !o.noCache && LAST_DIGEST.hash === pageHash && (now - LAST_DIGEST.at) < SCREEN_DIGEST_TTL;
  const ageMs = repeated ? now - LAST_DIGEST.at : 0;
  if (!o.noCache) LAST_DIGEST = { hash: pageHash, at: now };

  const digest = {
    package: pkg,
    screen,
    screenHash: pageHash,
    count: Number(raw.count) || nodes.length,
    tier0: interactive.slice(0, 40),
    tier1: null,
    tier2: null,
    note: ''
  };

  if (detail === 'more' || detail === 'full') {
    digest.tier1 = texts.slice(0, 120).map(n => n.t);
  }
  if (detail === 'full') {
    const per = 20;
    const start = (page - 1) * per;
    digest.tier2 = all.slice(start, start + per);
    digest.page = page;
    digest.pages = Math.max(1, Math.ceil(all.length / per));
  }

  // 超限只提示，不失败
  const hidden = [];
  if (interactive.length > 40) hidden.push(interactive.length - 40);
  if (texts.length > 120 && detail !== 'full') hidden.push(texts.length - 120);
  if (all.length > (Number(raw.count) || all.length)) hidden.push(all.length);
  if (hidden.length) digest.note = '还有 ' + Math.max.apply(null, hidden) + ' 项未列出，可用 read_screen {detail:"more"} 或 {detail:"full",page:n} 获取';

  if (repeated) digest.cached = true;
  if (repeated) digest.ageMs = ageMs;
  return digest;
}

/** 给动作前后的页面指纹：必须绕过缓存，否则验证会读到动作前的旧页面 */
function screenFingerprint() {
  const raw = rawScreenNodes(true);
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const texts = nodes.filter(n => n.t).map(n => n.t).join('\n');
  let pkg = '';
  try { if (HAS_PERM && Perm.getForegroundPackage) pkg = Perm.getForegroundPackage() || ''; } catch (e) {}
  return { package: pkg, hash: shortHash(pkg + '|' + texts), empty: texts.trim().length === 0, nodes: nodes.length };
}

async function deviceOrient(task) {
  let pkg = '';
  try { if (HAS_PERM && Perm.getForegroundPackage) pkg = Perm.getForegroundPackage() || ''; } catch (e) {}
  const text = readScreenText();
  const hash = shortHash(pkg + '|' + text);
  if (task) {
    const t = TASKS.find(x => x.id === (typeof task === 'string' ? task : task.id));
    if (t) {
      const d = deviceState(t);
      d.lastHash = hash; d.readAt = Date.now();
      t.lastScreenPackage = pkg;
      saveTasks();
    }
  }
  return { package: pkg, text, hash };
}

/* ==========================================================
 *  G5-3 自适应验证：每 150ms 取页面指纹，变化即返回，上限 2500ms
 * ========================================================== */
const DEVICE_WAIT_STEP = 150;
const DEVICE_WAIT_MAX = 2500;
const DEVICE_WAIT_EMPTY_EXTRA = 600;

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 等页面稳定（指纹变化或超时）。
 * before: 动作前的指纹（screenFingerprint() 的结果）
 * 返回结构化结果，调用方据此判定 PASS / NO_CHANGE / EMPTY / PACKAGE_CHANGED
 */
async function deviceWaitChange(before) {
  const t0 = Date.now();
  const beforeHash = (before && before.hash) || '';
  let last = null;
  while (Date.now() - t0 < DEVICE_WAIT_MAX) {
    await sleepMs(DEVICE_WAIT_STEP);
    last = screenFingerprint();
    if (last.hash !== beforeHash) break;
  }
  const waited = Date.now() - t0;
  const changed = !!last && last.hash !== beforeHash;
  if (changed && last.empty) {
    // 切页瞬间可能短暂空白，再宽限一次
    await sleepMs(DEVICE_WAIT_EMPTY_EXTRA);
    const again = screenFingerprint();
    last = again;
    return {
      changed: true, waitedMs: Date.now() - t0, empty: again.empty,
      package: again.package, hash: again.hash, nodes: again.nodes,
      packageChanged: !!(before && before.package && again.package && again.package !== before.package)
    };
  }
  return {
    changed,
    waitedMs: waited,
    empty: !!last && last.empty,
    package: (last && last.package) || '',
    hash: (last && last.hash) || beforeHash,
    nodes: (last && last.nodes) || 0,
    packageChanged: !!(before && before.package && last && last.package && last.package !== before.package)
  };
}

/**
 * 动作后的验证与判定。返回 { after, verdict, errorCode, error }
 * verdict: PASS / NO_CHANGE / EMPTY / PACKAGE_DENIED
 */
async function agentVerifyAction(before, opts) {
  screenCacheClear();              // 动作后页面已变，旧缓存必须作废
  const w = await deviceWaitChange(before);
  const after = {
    package: w.package,
    changed: w.changed,
    waitedMs: w.waitedMs,
    empty: w.empty,
    hash: w.hash,
    nodes: w.nodes,
    packageChanged: w.packageChanged,
    digest: (opts && opts.digest === false) ? null : screenDigest({ detail: 'basic' })
  };
  // 换到非白名单应用立即停（原生白名单是最终门禁，这里只是提前发现）
  if (w.packageChanged && w.package && HAS_PERM && Perm.getAgentWhitelist) {
    let list = [];
    try { list = JSON.parse(Perm.getAgentWhitelist() || '[]') || []; } catch (e) { list = []; }
    const allowAll = (() => { try { return !!JSON.parse(Perm.getAgentState() || '{}').allowAll; } catch (e) { return false; } })();
    if (!allowAll && list.length && list.indexOf(w.package) < 0) {
      return { after, verdict: 'PACKAGE_DENIED', errorCode: 'WHITELIST_DENIED', error: '已切换到白名单外的应用 [' + w.package + ']，已停止。' };
    }
  }
  if (w.empty) return { after, verdict: 'EMPTY', errorCode: 'VERIFY_EMPTY', error: '动作后页面为空（可能仍在加载或应用已退出）' };
  if (!w.changed) return { after, verdict: 'NO_CHANGE', errorCode: 'VERIFY_NO_CHANGE', error: '动作后页面没有变化，可能没有生效' };
  return { after, verdict: 'PASS', errorCode: '', error: '' };
}

/* ==========================================================
 *  G7-3 快速预览
 * ========================================================== */
function previewKindOf(path) {
  const p = String(path || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(p)) return 'image';
  if (/\.(md|markdown)$/.test(p)) return 'md';
  if (/\.csv$/.test(p)) return 'csv';
  if (/\.json$/.test(p)) return 'json';
  if (/\.html?$/.test(p)) return 'html';
  if (/\.(txt|log|ini|cfg|yml|yaml|xml|js|ts|py|kt|sh)$/.test(p)) return 'text';
  return 'other';
}

/** 把 JSON 美化，超长截断；解析失败就原样返回 */
function prettyIfJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
}

/** 打开预览弹层。path 是工作区内的相对路径（含 output/…） */
async function openPreview(path, title) {
  const modal = $('#preview-modal'), body = $('#pv-body'), meta = $('#pv-meta'), ttl = $('#pv-title');
  if (!modal) return;
  const rel = String(path || '');
  const kind = previewKindOf(rel);
  if (ttl) ttl.textContent = title || rel.split('/').pop() || '预览';
  if (meta) meta.textContent = rel + ' · ' + kind;
  if (body) body.textContent = '正在读取…';
  modal.classList.add('open');
  try {
    if (kind === 'image') {
      // 图片走原生字段：给出可访问的路径让 WebView 直接显示
      const src = HAS_PERM && Perm.workspaceFileUrl ? String(Perm.workspaceFileUrl(rel) || '') : '';
      if (body) {
        body.innerHTML = '';
        if (src) { const img = document.createElement('img'); img.src = src; body.appendChild(img); }
        else body.textContent = '图片无法在这里显示，文件在：' + rel;
      }
      if (meta) meta.textContent = rel + ' · 图片';
      return;
    }
    const raw = (HAS_PERM && Perm.agentWorkspaceRead) ? String(Perm.agentWorkspaceRead(rel, 200000) || '') : '';
    let r = {};
    try { r = JSON.parse(raw || '{}'); } catch (e) { r = {}; }
    if (!r || r.ok === false || r.text == null) {
      if (body) body.textContent = (r && r.error) ? ('读取失败：' + r.error) : '这个文件读不出正文，可能不是文本格式。';
      return;
    }
    let text = String(r.text || '');
    if (kind === 'json') text = prettyIfJson(text);
    const maxChars = 120000;
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    if (body) body.textContent = text;
    if (meta) {
      const lines = text.split('\n').length;
      meta.textContent = rel + ' · ' + kind + ' · ' + lines + ' 行 · ' + text.length + ' 字' + (truncated ? '（已截断）' : '');
    }
  } catch (e) {
    if (body) body.textContent = '预览失败：' + errMsg(e);
  }
}

function bindPreviewUI() {
  const modal = $('#preview-modal');
  if (!modal) return;
  const close = $('#pv-close');
  if (close) close.onclick = () => modal.classList.remove('open');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('open'); };
}

/** 导出成功后，在聊天里放一张可点开的小卡片（不占正文） */
function addExportCard(path, format) {
  const bodyEl = $('#body');
  if (!bodyEl) return;
  const d = document.createElement('div');
  d.className = 'export-card';
  const name = String(path || '').split('/').pop();
  const b = document.createElement('b');
  b.textContent = name;
  const span = document.createElement('span');
  span.textContent = '已导出 ' + (format || '').toUpperCase();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '预览';
  btn.onclick = (e) => { e.stopPropagation(); openPreview(path, name); };
  d.appendChild(b); d.appendChild(span); d.appendChild(btn);
  bodyEl.appendChild(d);
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

/** G5-5：动作审计（不记录输入内容，只记长度） */
function recordDeviceAction(task, action, args, v, r) {
  if (!task) return;
  const a = args || {};
  let target = '';
  if (action === 'click_text') target = String(a.text || '').slice(0, 12);
  else if (action === 'launch_app') target = String(a.app || a.package || '').slice(0, 24);
  else if (action === 'input_text') target = '（' + String(a.text || '').length + ' 字，内容不记录）';
  else if (action === 'tap_screen') target = 'rx=' + (a.rx !== undefined ? a.rx : a.x) + ' ry=' + (a.ry !== undefined ? a.ry : a.y);
  else if (action === 'press_key') target = String(a.key || '');
  else if (action === 'swipe_screen') target = 'swipe';
  try {
    taskEvent(task.id, 'device_action', {
      action: action,
      target: target,
      verdict: (v && v.verdict) || '',
      changed: !!(v && v.after && v.after.changed),
      waitedMs: (v && v.after && v.after.waitedMs) || 0,
      budget: (parseInt(deviceState(task).actionsUsed, 10) || 0) + '/' + deviceBudget(task),
      level: (r && r.level) || 'L3'
    });
  } catch (e) {}
}

/** 兼容旧调用（翻译/其它地方可能还在用） */
async function agentAfterAction() {
  const w = await deviceWaitChange(screenFingerprint());
  return { package: w.package, text: readScreenText().slice(0, 1200), readable: !w.empty };
}

/* ==========================================================
 *  截屏 / 识图
 * ========================================================== */
let pendingShotCancel = null;
function cancelScreenCapture(taskId) {
  if (pendingShotCancel && pendingShotCancel.taskId === taskId) pendingShotCancel.cancel();
}
function captureScreenJS() {
  return new Promise((resolve) => {
    if (!(HAS_PERM && Perm.captureScreen)) return resolve('');
    const taskId = (typeof ACTIVE_RUN_TASK_ID !== 'undefined' && ACTIVE_RUN_TASK_ID) ? ACTIVE_RUN_TASK_ID : (currentTask() && currentTask().id);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (pendingShotCancel && pendingShotCancel.taskId === taskId) pendingShotCancel = null;
      window.__shotDone = null;
      resolve(v || '');
    };
    const timer = setTimeout(() => finish(''), 45000);
    pendingShotCancel = { taskId, cancel: () => { clearTimeout(timer); finish(''); } };
    window.__shotDone = (d) => { clearTimeout(timer); finish(d); };
    try { Perm.captureScreen(); } catch (e) { clearTimeout(timer); finish(''); }
  });
}

/**
 * 识图兜底：对话模型不吃图片时，先用识图模型“看懂”截图，
 * 再把描述交给对话模型作答。对话模型自己能看图时不会走到这里。
 */
async function visionDescribe(dataUrl, hint) {
  const base = (CONFIG.visionBase || '').replace(/\/$/, '');
  if (!base || !CONFIG.visionKey || !CONFIG.visionModel) return '';
  const ask = hint || '这是用户手机当前的屏幕截图。请如实、详细地描述画面：是什么应用、有哪些文字、用户大概在做什么。用中文回答，不要编造看不到的内容。';
  const body = JSON.stringify({
    model: CONFIG.visionModel,
    stream: false,
    messages: [{ role: 'user', content: [
      { type: 'text', text: ask },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }]
  });
  const r = await reqRequest({
    method: 'POST', url: base + '/chat/completions',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.visionKey },
    body: body, timeoutMs: modelTimeout(), expect: 'json', retries: 0, source: 'system:vision'
  });
  const d = r.json;
  if (d.error) throw new Error(d.error.message || '识图接口错误');
  const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return typeof c === 'string' ? c : '';
}

/** execTool 截屏后把图片交给 chatReqTools 插入对话 */
let pendingShotImage = '';
let pendingShotImages = [];
let agentCapsuleActive = false;
function agentCapsuleOn(text) {
  if (!HAS_NATIVE || !Android.toCapsule) return false;
  try { Android.toCapsule(text || '正在读取屏幕'); agentCapsuleActive = true; return true; } catch (e) { return false; }
}
function agentCapsuleState(text, state) {
  if (!agentCapsuleActive || !HAS_NATIVE || !Android.capsuleState) return;
  try { Android.capsuleState(text, state); } catch (e) {}
}
function finishAgentCapsule(text) {
  if (!agentCapsuleActive) return false;
  let ok = false;
  try { ok = !!(HAS_NATIVE && Android.capsuleDone && Android.capsuleDone(text || '已完成 · 点我查看')); } catch (e) {}
  agentCapsuleActive = false;
  return ok;
}
async function watchScreenFrames(args) {
  const seconds = Math.max(1, Math.min(10, parseInt(args.seconds, 10) || 5));
  const fps = Math.max(1, Math.min(2, parseInt(args.fps, 10) || 1));
  const interval = Math.max(500, Math.round(1000 / fps));
  const maxFrames = Math.min(6, Math.max(1, seconds * fps));
  const frames = [];
  for (let i = 0; i < maxFrames; i++) {
    if (stopRequested) break;
    const shot = await captureScreenJS();
    if (shot) frames.push(shot);
    if (i + 1 < maxFrames) await new Promise(resolve => setTimeout(resolve, interval));
  }
  pendingShotImages = frames.slice(0, 4);
  pendingShotImage = pendingShotImages[pendingShotImages.length - 1] || '';
  return { frames: frames.length, seconds: seconds, fps: fps,
    note: frames.length ? '已完成限时观察，返回了 ' + frames.length + ' 帧画面。' : '观察期间没有截到画面。' };
}

