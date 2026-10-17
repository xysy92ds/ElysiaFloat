/* ==========================================================
 *  微软翻译
 * ========================================================== */
/* ==========================================================
 *  屏幕翻译
 *  文字来源：无障碍节点树（自带精确坐标）→ 不需要任何 OCR
 *  引擎：free = 微软免费 / ai = 自己的对话模型
 *  显示：translated = 仅译文（盖掉原文）/ bilingual = 双语（粉下划线 + 译文小牌）
 * ========================================================== */
const TRANS = {
  busy: false, items: [], engine: 'free', note: '',
  pending: 'chat', pinned: false, source: ''
};

/* ---- 一句话要不要翻 ---- */
function transHasWord(s) {
  return /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(s);
}
function transIsChinese(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const all = (s.match(/[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
  return all > 0 && cjk / all > 0.5;
}
function transNeed(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length < 2 || t.length > 1200) return false;
  if (!transHasWord(t)) return false;                              // 纯数字 / 符号 / emoji
  if (CONFIG.transSkipChinese !== false && transIsChinese(t)) return false;
  return true;
}

/* ---- 译文缓存（带上限，别把本地存储撞爆） ---- */
function transCachePut(k, v) {
  transCache[k] = v;
  const ks = Object.keys(transCache);
  if (ks.length > 1200) {
    for (let i = 0; i < ks.length - 900; i++) delete transCache[ks[i]];
  }
  sSet('via_ai_trans', transCache);
}

async function transGoogle(text) {
  if (transCache[text]) return transCache[text];
  const url = 'https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false';
  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify([text]);
  const r = await reqRequest({
    method: 'POST', url: url, headers: headers, body: body,
    timeoutMs: 12000, expect: 'json', retries: 1, source: 'system:translate'
  });
  let d = r.json;
  // 这个接口对 [x] 有时回 [{translations:[...]}]，有时回 [[{translations:[...]}]]，两种都吃
  if (Array.isArray(d) && d.length === 1 && Array.isArray(d[0])) d = d[0];
  const t = d[0] && d[0].translations && d[0].translations[0] && d[0].translations[0].text
    ? d[0].translations[0].text : d[0];
  if (t && typeof t === 'string') {
    transCachePut(text, t);
    return t;
  }
  throw new Error('无译文');
}

/** 一次翻一组，返回同长的数组（顺序一定对齐）。 */
async function transFreeMany(texts) {
  return await pMap(texts, async (t) => {
    try { return await transGoogle(t); } catch (e) { return t; }
  }, 4);
}

/** 把一批文字打包成 JSON 数组丢给对话模型，让它只回一个 JSON 数组。 */
async function transAI(texts) {
  if (!CONFIG.apiKey) throw new Error('未配置 API Key');
  const base = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  const prompt = '把下面这个 JSON 数组里的每一条翻译成简体中文。'
    + '必须只返回一个同样长度、同样顺序的 JSON 字符串数组，不要解释、不要加 ``` 代码块标记。'
    + '已经是中文的条目原样返回。\n' + JSON.stringify(texts);
  const r = await reqRequest({
    method: 'POST', url: base + '/chat/completions',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey },
    body: JSON.stringify({
      model: CONFIG.model, temperature: 0.1, stream: false,
      messages: [{ role: 'user', content: prompt }]
    }),
    timeoutMs: 200000, expect: 'json', retries: 2, source: 'system:translate-ai'
  });
  let txt = '';
  try { txt = r.json.choices[0].message.content || ''; } catch (e) { throw new Error('AI 返回的不是合法 JSON'); }
  txt = String(txt).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = txt.indexOf('['), b = txt.lastIndexOf(']');
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  let arr;
  try { arr = JSON.parse(txt); } catch (e) { throw new Error('AI 没按格式返回数组'); }
  if (!Array.isArray(arr)) throw new Error('AI 没按格式返回数组');
  return texts.map((t, i) => (typeof arr[i] === 'string' && arr[i]) ? arr[i] : t);
}

/** 按当前引擎翻一组（带缓存）。 */
async function transBatch(list) {
  const need = list.filter(t => transCache[t] === undefined);
  if (need.length) {
    let got;
    if (CONFIG.transEngine === 'ai') {
      got = await transAI(need);
    } else {
      got = await transFreeMany(need);
    }
    for (let i = 0; i < need.length; i++) {
      if (got[i] && got[i] !== need[i]) transCachePut(need[i], got[i]);
      else if (got[i] !== undefined) transCachePut(need[i], got[i]);
    }
  }
  return list.map(t => (transCache[t] === undefined ? t : transCache[t]));
}

/* ---- 从无障碍节点树做成待翻清单（带坐标） ---- */
function transItemsFromNodes(nodes) {
  const out = [];
  const seen = [];
  for (let i = 0; i < nodes.length && out.length < 150; i++) {
    const n = nodes[i];
    if (!n || !transNeed(n.t)) continue;
    const x = parseInt(n.x, 10), y = parseInt(n.y, 10);
    const w = parseInt(n.w, 10), h = parseInt(n.h, 10);
    if (!(w > 6 && h > 6) || w > 4000 || h > 600) continue;
    // 同一段文字的父子节点会重复出现，只留最外层那个
    let dup = false;
    for (let j = 0; j < seen.length; j++) {
      const s = seen[j];
      if (s.t !== n.t) continue;
      const inside = (x >= s.x && y >= s.y && x + w <= s.x + s.w && y + h <= s.y + s.h);
      const outside = (x <= s.x && y <= s.y && x + w >= s.x + s.w && y + h >= s.y + s.h);
      if (inside || outside) { dup = true; break; }
    }
    if (dup) continue;
    seen.push({ t: n.t, x: x, y: y, w: w, h: h });
    out.push({ src: n.t, dst: '', x: x, y: y, w: w, h: h });
  }
  return out;
}

/* ---- 拿不到节点树时的退化路径：只有文字、没有坐标 ---- */
function transItemsFromText() {
  const txt = readScreen();
  if (!txt) return [];
  const out = [];
  const seen = {};
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length && out.length < 90; i++) {
    const t = String(lines[i]).trim();
    if (!transNeed(t) || seen[t]) continue;
    seen[t] = 1;
    out.push({ src: t, dst: '', x: null, y: null, w: null, h: null });
  }
  return out;
}

/** 读当前屏幕 → 收集 → 翻译 → 渲染到「屏幕翻译」页。 */
async function doTranslateScreen() {
  if (TRANS.busy) { toast('正在翻译中，稍等一下嘛~'); return; }

  const useCapsule = capsuleOn('正在读屏幕…');
  TRANS.busy = true;
  TRANS.pending = 'translate';

  try {
    let nodes = [];
    if (HAS_PERM && Perm.getScreenNodes) {
      try { nodes = JSON.parse((Perm.getScreenNodesOnce ? Perm.getScreenNodesOnce() : Perm.getScreenNodes)() || '[]') || []; } catch (e) { nodes = []; }
    }

    let items = transItemsFromNodes(nodes);
    TRANS.source = items.length ? 'nodes' : 'text';
    if (!items.length) items = transItemsFromText();

    if (!items.length) {
      TRANS.items = [];
      TRANS.note = '没读到可翻译的文字';
      TRANS.engine = CONFIG.transEngine;
      renderTrans();
      prepareResult('翻译屏幕', useCapsule);
      return;
    }

    const uniq = [];
    for (let i = 0; i < items.length; i++) if (uniq.indexOf(items[i].src) < 0) uniq.push(items[i].src);

    const batches = [];
    for (let i = 0; i < uniq.length; i += 20) batches.push(uniq.slice(i, i + 20));

    if (useCapsule && HAS_NATIVE && Android.capsuleState) {
      try { Android.capsuleState('正在翻译 ' + uniq.length + ' 段…', 'busy'); } catch (e) {}
    }

    const results = await pMap(batches, async (b) => {
      try { return await transBatch(b); } catch (e) { return null; }
    }, 2);

    let failedBatches = 0;
    const fixed = {};
    for (let i = 0; i < batches.length; i++) {
      const r = results[i];
      if (!r) { failedBatches++; continue; }
      for (let j = 0; j < batches[i].length; j++) fixed[batches[i][j]] = r[j];
    }

    for (let i = 0; i < items.length; i++) {
      const t = fixed[items[i].src];
      items[i].dst = (t === undefined || t === null) ? '' : t;
    }
    const okCount = items.filter(x => x.dst && x.dst !== x.src).length;
    if (!okCount) throw new Error(failedBatches ? '翻译接口全部失败，检查一下网络？' : '什么都没翻出来');

    TRANS.items = items;
    TRANS.engine = CONFIG.transEngine;
    TRANS.note = (failedBatches ? '有 ' + failedBatches + ' 组失败 · ' : '')
      + (TRANS.source === 'nodes' ? '带坐标，可以贴到屏幕上' : '没拿到坐标，只能在这里看');
    renderTrans();
    prepareResult('翻译好了 ♪ 点我看结果', useCapsule);
  } catch (e) {
    TRANS.items = [];
    TRANS.note = '翻译失败：' + errMsg(e);
    renderTrans();
    prepareResult('翻译失败啦', useCapsule);
    toast('翻译失败：' + errMsg(e));
  } finally {
    TRANS.busy = false;
  }
}

/** 处理完了：如果确实收成了胶囊就亮红点；否则窗口本来就开着，直接展示。 */
function prepareResult(capsuleText, useCapsule) {
  if (agentCapsuleActive) finishAgentCapsule(capsuleText || '已完成 · 点我查看');
  if (useCapsule && capsuleFinish(capsuleText)) return;
  showView(TRANS.pending || 'chat');
}

function capsuleOn(text) {
  if (!HAS_NATIVE || !Android.toCapsule) return false;
  if (CONFIG.transAutoCapsule === false) return false;
  try { Android.toCapsule(text || '正在处理…'); return true; } catch (e) { return false; }
}
function capsuleFinish(text) {
  if (!HAS_NATIVE || !Android.capsuleDone) return false;
  try { return !!Android.capsuleDone(text || '好啦~'); } catch (e) { return false; }
}

/* ---- 渲染「屏幕翻译」页 ---- */
function renderTrans() {
  const list = $('#trans-list');
  if (!list) return;
  if (!TRANS.items.length) {
    list.innerHTML = '<div id="trans-empty">这次没读到可翻译的文字…<br>'
      + '确认一下无障碍服务开着，或者换个页面再试试？</div>';
  } else {
    list.innerHTML = TRANS.items.map(it =>
      '<div class="tcard">'
      + '<div class="ttsrc">' + esc(it.src) + '</div>'
      + '<div class="ttdst">' + esc(it.dst || '（这段没翻出来）') + '</div>'
      + '</div>').join('');
  }
  const ok = TRANS.items.filter(x => x.dst && x.dst !== x.src).length;
  const meta = $('#trans-meta');
  if (meta) {
    meta.innerHTML = '引擎 <b>' + (TRANS.engine === 'ai' ? 'AI' : '微软免费') + '</b> · '
      + '方式 <b>' + (CONFIG.transMode === 'bilingual' ? '双语' : '仅译文') + '</b> · '
      + '共 <b>' + TRANS.items.length + '</b> 段，翻出 <b>' + ok + '</b> 段'
      + (TRANS.note ? '<br>' + esc(TRANS.note) : '');
  }
}

/* ---- 把译文贴到屏幕上（原位覆盖） ---- */
function pinTransToScreen() {
  const items = TRANS.items.filter(it => it.x !== null && it.x !== undefined && it.dst && it.dst !== it.src);
  if (!items.length) { toast('还没有可以贴的译文哦~'); return; }
  if (!HAS_NATIVE || !Android.showTranslateOverlay) { toast('只有 App 里才能贴到屏幕上~'); return; }
  try {
    Android.showTranslateOverlay(JSON.stringify({
      mode: CONFIG.transMode === 'bilingual' ? 'bilingual' : 'translated',
      items: items.map(it => ({ x: it.x, y: it.y, w: it.w, h: it.h, t: it.dst }))
    }));
  } catch (e) { toast('贴上去失败了：' + errMsg(e)); return; }
  TRANS.pinned = true;
  if (HAS_NATIVE && Android.toCapsule && CONFIG.transAutoCapsule !== false) {
    try { Android.toCapsule('译文已贴上 · 点我还原'); } catch (e) {}
  }
  toast('译文贴上去了~ 点「还原屏幕」可以撤掉');
}

function bindTransUI() {
  $('#trans-back').onclick = () => { showView('chat'); };
  $('#trans-pin').onclick = pinTransToScreen;
  $('#trans-redo').onclick = () => { doTranslateScreen(); };
  $('#trans-copy').onclick = () => {
    const txt = TRANS.items.filter(x => x.dst && x.dst !== x.src)
      .map(x => x.src + '\n' + x.dst).join('\n\n');
    if (!txt) { toast('还没有译文哦~'); return; }
    if (writeClipboard(txt)) toast('译文已经复制啦~'); else toast('复制失败，长按文字试试~');
  };
}

window.__capsuleClick = function () {
  if (TRANS.pinned && HAS_NATIVE && Android.hideTranslateOverlay) {
    try { Android.hideTranslateOverlay(); } catch (e) {}
    TRANS.pinned = false;
  }
  showView(TRANS.pending || 'chat');
};
window.__transOverlayClosed = function () { TRANS.pinned = false; };

function splitChunks(text, limit) {
  const paras = String(text).split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const out = []; let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > limit && buf) { out.push(buf); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf) out.push(buf);
  return out.length ? out : [String(text).slice(0, limit)];
}

