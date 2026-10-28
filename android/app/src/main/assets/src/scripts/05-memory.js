/* ==========================================================
 *  长期记忆库（v0.4）
 *  记忆不再塞进对话历史。它是一份独立档案，存在本机，
 *  每轮只把「分类概览 + 重要 + 最近」这一小块喂给模型（体积恒定，
 *  和总条数无关），细节由 AI 自己用工具按需查阅。
 *  条目：{id, cat, tags[], title, content, pinned, hits, src, createdAt, updatedAt, emb?}
 * ========================================================== */
const MEM_KEY = 'via_ai_memories';
const MEMCFG_KEY = 'via_ai_mem_config';
const MEM_CATS = ['关于你', '人际关系', '项目', '约定', '事件', '知识', '情绪', '其他'];
const MEM_PIN_MAX = 8;   // 常驻区最多放几条「重要」
const MEM_NEW_MAX = 5;   // 常驻区最多放几条「最近」

let MEM = sGet(MEM_KEY, null);
if (!Array.isArray(MEM)) MEM = [];
MEM = MEM.filter(e => e && typeof e === 'object').map(memNormalize);

let MEMCFG = Object.assign({
  vecEnabled: false, vecBase: '', vecKey: '', vecModel: '', autoSummary: true, summaryEvery: 50
}, sGet(MEMCFG_KEY, {}) || {});
/* 向量 Key 同样进密钥仓；旧明文在启动时迁移。 */
if (secretHydrate(MEMCFG, SECRET_FIELDS_MEM, 'mem')) {
  sSet(MEMCFG_KEY, MEMCFG);
}
const MEM_AUTO_KEY = 'via_ai_mem_auto_state';
function memAutoState() { const o = sGet(MEM_AUTO_KEY, null); return (o && typeof o === 'object') ? o : { since: 0, lastAt: 0, running: false }; }
function memAutoSave(o) { sSet(MEM_AUTO_KEY, o || {}); }
/** 记录一条新消息；到阈值返回 true（调用方决定是否立刻总结） */
function memAutoTick() {
  if (MEMCFG.autoSummary === false) return false;
  const st = memAutoState();
  st.since = (parseInt(st.since, 10) || 0) + 1;
  const every = Math.max(10, Math.min(500, parseInt(MEMCFG.summaryEvery, 10) || 50));
  const hit = st.since >= every;
  if (hit) st.since = 0;
  memAutoSave(st);
  return hit;
}

const memSaveAll = () => { sSet(MEM_KEY, MEM); };
const memSaveCfg = () => { sSet(MEMCFG_KEY, MEMCFG); };
const memNowISO = () => new Date().toISOString();
const memNewId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const memCat = (e) => (e && e.cat) ? String(e.cat) : '其他';

function memNormalize(e) {
  return {
    id: e.id || memNewId(),
    cat: String(e.cat || e.category || '其他'),
    tags: Array.isArray(e.tags) ? e.tags.map(String).filter(Boolean) : [],
    title: String(e.title || '').slice(0, 80) || '（无标题）',
    content: String(e.content || ''),
    pinned: !!e.pinned,
    hits: parseInt(e.hits, 10) || 0,
    src: String(e.src || 'user'),
    createdAt: e.createdAt || memNowISO(),
    updatedAt: e.updatedAt || e.createdAt || memNowISO(),
    emb: typeof e.emb === 'string' ? e.emb : ''
  };
}

function memFind(id) {
  return MEM.find(e => e.id === id) || null;
}

function memAdd(o) {
  const e = memNormalize({
    id: memNewId(), cat: o.cat, tags: o.tags, title: o.title, content: o.content,
    pinned: o.pinned, src: o.src || 'ai', createdAt: memNowISO(), updatedAt: memNowISO()
  });
  MEM.push(e);
  memSaveAll();
  memTouchEmbed(e);
  return e;
}

function memUpdate(id, patch) {
  const e = memFind(id);
  if (!e) return null;
  if (patch.title !== undefined) e.title = String(patch.title).slice(0, 80) || e.title;
  if (patch.content !== undefined) e.content = String(patch.content);
  if (patch.cat !== undefined) e.cat = String(patch.cat || '其他');
  if (patch.tags !== undefined) e.tags = (Array.isArray(patch.tags) ? patch.tags : []).map(String).filter(Boolean);
  if (patch.pinned !== undefined) e.pinned = !!patch.pinned;
  e.updatedAt = memNowISO();
  memSaveAll();
  memTouchEmbed(e);
  return e;
}

function memCompareText(text) {
  return String(text || '').toLowerCase()
    .replace(/[\s\u3000,.;:!?，。！？、；：]+/g, '')
    .trim();
}
function memSimilarContent(a, b) {
  const x = memCompareText(a), y = memCompareText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 很短的共同词不能证明是同一条事实，避免“喜欢音乐”合并“喜欢音乐会”。
  if (Math.min(x.length, y.length) >= 12 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return true;
  if (Math.min(x.length, y.length) < 18) return false;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ax = grams(x), by = grams(y);
  let hit = 0;
  ax.forEach(g => { if (by.has(g)) hit++; });
  const union = new Set([...ax, ...by]).size;
  return union > 0 && hit / union >= 0.82;
}
function memFindSimilar(content) {
  return MEM.find(e => memSimilarContent(e.content, content)) || null;
}
function memAppendContent(e, content, tags) {
  const incoming = String(content || '').trim();
  if (!e || !incoming) return e;
  const old = String(e.content || '').trim();
  if (!memSimilarContent(old, incoming)) return null;
  if (memCompareText(old) !== memCompareText(incoming) && !old.includes(incoming)) {
    e.content = old ? old + '\n\n' + incoming : incoming;
  }
  if (Array.isArray(tags)) e.tags = Array.from(new Set((e.tags || []).concat(tags.map(String).filter(Boolean))));
  e.updatedAt = memNowISO();
  memSaveAll();
  memTouchEmbed(e);
  return e;
}

function memDel(id) {
  const i = MEM.findIndex(e => e.id === id);
  if (i < 0) return false;
  MEM.splice(i, 1);
  memSaveAll();
  return true;
}

/* ---- 向量（可选，纯锦上添花：没配就用关键词打分） ---- */
function embPack(arr) {
  if (!arr || !arr.length) return '';
  const u8 = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.max(-1, Math.min(1, Number(arr[i]) || 0));
    u8[i] = Math.round((v + 1) / 2 * 255);
  }
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return 'q8:' + btoa(s);
}
function embUnpack(str) {
  if (!str || str.indexOf('q8:') !== 0) return null;
  try {
    const s = atob(str.slice(3));
    const f = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) f[i] = (s.charCodeAt(i) / 255) * 2 - 1;
    return f;
  } catch (e) { return null; }
}
function memCos(a, b) {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; d += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return d / Math.sqrt(na * nb);
}
function memVecReady() {
  return !!(MEMCFG.vecEnabled && MEMCFG.vecBase && MEMCFG.vecKey && MEMCFG.vecModel);
}
async function memEmbed(texts) {
  if (!memVecReady()) throw new Error('未启用向量检索或配置不全');
  const body = JSON.stringify({ model: MEMCFG.vecModel, input: texts });
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MEMCFG.vecKey };
  const r = await reqRequest({
    method: 'POST', url: MEMCFG.vecBase.replace(/\/$/, '') + '/embeddings',
    headers: headers, body: body,
    timeoutMs: 60000, expect: 'json', retries: 2, source: 'system:memory'
  });
  const d = r.json;
  if (d.error) throw new Error(d.error.message || '向量接口错误');
  if (!d.data || !d.data.length) throw new Error('向量接口返回异常');
  return d.data.map(x => x.embedding || x.embeddings || []);
}
/** 后台给条目算向量，失败就算了，不影响任何功能 */
async function memTouchEmbed(e) {
  if (!memVecReady() || e.emb) return;
  try {
    const r = await memEmbed([(e.title || '') + '\n' + (e.content || '').slice(0, 1200)]);
    if (r && r[0] && r[0].length) { e.emb = embPack(r[0]); memSaveAll(); }
  } catch (err) {}
}

/* ---- 检索 ---- */
function memKeywords(s) {
  const t = String(s || '').toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]/g) || [];
  const stop = { '的': 1, '了': 1, '是': 1, '我': 1, '你': 1, '他': 1, '她': 1, '它': 1,
    '和': 1, '与': 1, '在': 1, '有': 1, '吗': 1, '呢': 1, '吧': 1, '啊': 1, '就': 1, '都': 1,
    'the': 1, 'a': 1, 'an': 1, 'is': 1, 'to': 1, 'of': 1, 'and': 1, 'my': 1, 'me': 1 };
  const uniq = [];
  for (const x of t) if (!stop[x] && uniq.indexOf(x) < 0) uniq.push(x);
  if (t.length > 1 && uniq.length && /[a-z0-9]/.test(t.join(''))) {
    // 英文/拼音：额外把整串当成一个词，方便匹配 "react native"
    const whole = t.join(' ');
    if (whole.indexOf(' ') > 0 && uniq.indexOf(whole) < 0) uniq.push(whole);
  }
  return uniq;
}
function memScore(e, kws) {
  if (!kws.length) return 0;
  const title = String(e.title || '').toLowerCase();
  const body = String(e.content || '').toLowerCase();
  const tags = (e.tags || []).join(' ').toLowerCase();
  const cat = memCat(e).toLowerCase();
  let sc = 0;
  for (const k of kws) {
    if (!k) continue;
    if (title.indexOf(k) >= 0) sc += 6;
    if (tags.indexOf(k) >= 0) sc += 4;
    if (cat.indexOf(k) >= 0) sc += 2;
    if (body.indexOf(k) >= 0) sc += 1;
  }
  return sc;
}
/** 统一入口：关键词（+可选向量）混合检索，返回排好序的条目 */
async function memSearch(opts) {
  const o = opts || {};
  const kws = memKeywords(o.keyword || '');
  const limit = Math.max(1, Math.min(50, parseInt(o.limit, 10) || 15));
  let pool = MEM.slice();
  if (o.category) pool = pool.filter(e => memCat(e) === o.category);

  let qv = null;
  if (memVecReady() && o.keyword) {
    try { const r = await memEmbed([o.keyword]); qv = (r && r[0] && r[0].length) ? r[0] : null; } catch (e) { qv = null; }
  }

  const scored = pool.map(e => {
    const base = memScore(e, kws);
    let bonus = 0;
    if (qv) {
      const ev = embUnpack(e.emb);
      if (ev && ev.length === qv.length) bonus += memCos(ev, qv) * 10;
    }
    if (e.pinned) bonus += 1.5;                    // 重要的稍微往上抬
    bonus += Math.min(3, (e.hits || 0) * 0.3);     // 常用的也抬一点
    return { e, base: base, sc: base + bonus, bonus: bonus };
  });

  if (kws.length || qv) {
    // 带关键词搜索时，没沾上边的就别硬凑上来（只有向量特别高或者重要到离谱的才留）
    const kept = scored.filter(x => x.base > 0 || (qv && x.bonus > 4));
    if (kept.length) {
      kept.sort((a, b) => b.sc - a.sc || String(b.e.updatedAt).localeCompare(String(a.e.updatedAt)));
      return kept.slice(0, limit).map(x => x.e);
    }
    return [];
  }
  scored.sort((a, b) => String(b.e.updatedAt || '').localeCompare(String(a.e.updatedAt || '')));
  return scored.slice(0, limit).map(x => x.e);
}

/* ---- 常驻区：每轮都进 prompt 的那一小块，体积恒定 ---- */
function memResidentBlock() {
  if (!MEM.length) return '';
  const counts = {};
  MEM.forEach(e => { const c = memCat(e); counts[c] = (counts[c] || 0) + 1; });
  const catLine = Object.keys(counts).map(c => c + '×' + counts[c]).join('、');
  const pins = MEM.filter(e => e.pinned)
    .sort((a, b) => (b.hits || 0) - (a.hits || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MEM_PIN_MAX);
  const pinIds = {};
  pins.forEach(e => { pinIds[e.id] = 1; });
  const recents = MEM.slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter(e => !pinIds[e.id])
    .slice(0, MEM_NEW_MAX);
  const line = (e) => '- [' + e.id + '] ' + (e.title || '（无标题）') + '（' + memCat(e) + '）';
  let s = '【长期记忆库】本机存着 ' + MEM.length + ' 条记忆，分类：' + catLine + '。\n';
  s += '下面只列出了索引，正文不在上下文里。需要细节时用 list_memories 检索、read_memory 读取，不要凭标题猜内容。\n';
  if (pins.length) s += '★ 重要：\n' + pins.map(line).join('\n') + '\n';
  if (recents.length) s += '☆ 最近：\n' + recents.map(line).join('\n') + '\n';
  s += '聊天中出现新的长期信息时，默认使用 save_memory 新增；类别相同不影响新增。只有正文高度相似且属于同一事实时才合并，并保留原文、在末尾追加补充；删除必须得到用户明确同意。';
  return s;
}

/* ---- 迁移旧版那条「【长期记忆总结】」 ---- */
function memMigrateLegacy() {
  const old = history.filter(m => m.role === 'system' && m.isMemory).pop();
  if (!old) return;
  const text = String(old.content || '').replace('【长期记忆总结】：', '').trim();
  if (text) {
    const dup = MEM.some(e => e.content.trim() === text);
    if (!dup) memAdd({ title: '早期对话总结', content: text, cat: '事件', tags: ['总结', '迁移'], src: 'migrate', pinned: true });
  }
  history = history.filter(m => !(m.role === 'system' && m.isMemory));
  if (!history.length) history = [{ role: 'system', content: CONFIG.systemPrompt }];
  saveHistory();
}

/* ---- 导出 ---- */
function memExportJSON() {
  const payload = { v: 1, type: 'elly-memory', exportedAt: memNowISO(), memories: MEM };
  return JSON.stringify(payload, null, 2);
}
function memExportMarkdown() {
  let s = '# 爱莉希雅的长期记忆\n\n';
  s += '> 导出时间：' + memNowISO() + '，共 ' + MEM.length + ' 条\n\n';
  const byCat = {};
  MEM.forEach(e => { const c = memCat(e); (byCat[c] = byCat[c] || []).push(e); });
  const order = MEM_CATS.concat(Object.keys(byCat).filter(c => MEM_CATS.indexOf(c) < 0));
  order.forEach(c => {
    const list = byCat[c];
    if (!list || !list.length) return;
    s += '## ' + c + '\n\n';
    list.forEach(e => {
      s += '### ' + (e.pinned ? '★ ' : '') + e.title + '\n\n';
      s += (e.content || '').trim() + '\n\n';
      const meta = [];
      if (e.tags && e.tags.length) meta.push('标签：' + e.tags.join('、'));
      meta.push('创建：' + String(e.createdAt).slice(0, 10));
      meta.push('更新：' + String(e.updatedAt).slice(0, 10));
      s += '_' + meta.join('　|　') + '_\n\n';
    });
  });
  return s;
}
/** 从 Markdown 里尽量还原条目（不认识的一律进「其他」，不会丢内容） */
function memParseMarkdown(md) {
  const out = [];
  let cat = '其他', cur = null, buf = [];
  const flush = () => {
    if (!cur) return;
    const body = buf.join('\n').trim();
    out.push(memNormalize({ cat: cat, title: cur.title, content: body || cur.title, pinned: cur.pinned, tags: [], src: 'import' }));
    cur = null; buf = [];
  };
  String(md).split(/\r?\n/).forEach(raw => {
    const line = raw;
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { flush(); cur = { title: h3[1].replace(/^★\s*/, '').trim(), pinned: /^★/.test(h3[1].trim()) }; return; }
    if (h2) { flush(); cat = h2[1].trim(); return; }
    if (!cur) return;
    if (/^_.*_$/.test(line.trim())) return;   // 元信息行
    if (/^>/.test(line.trim())) return;        // 引用
    buf.push(line);
  });
  flush();
  return out.filter(e => e.title && e.title !== '（无标题）');
}
function memImport(text, replace) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('内容是空的');
  let items = null;
  try {
    const d = JSON.parse(raw);
    if (Array.isArray(d)) items = d;
    else if (d && Array.isArray(d.memories)) items = d.memories;
  } catch (e) {
    try {
      const d = JSON.parse(b64d(raw));
      if (Array.isArray(d)) items = d;
      else if (d && Array.isArray(d.memories)) items = d.memories;
    } catch (e2) { items = null; }
  }
  if (!items) items = memParseMarkdown(raw);
  if (!items || !items.length) throw new Error('没解析出任何记忆');

  if (replace) MEM = [];
  let added = 0, skipped = 0;
  items.forEach(it => {
    if (!it || typeof it !== 'object') return;
    const e = memNormalize(Object.assign({}, it, { src: it.src || 'import' }));
    const same = MEM.find(x => x.content.trim() === e.content.trim() && x.title === e.title);
    if (same) { skipped++; return; }
    // 导入的 id 可能和现有的撞车
    while (MEM.some(x => x.id === e.id)) e.id = memNewId();
    e.emb = '';   // 向量是模型相关的，重新算
    MEM.push(e);
    added++;
    if (memVecReady()) memTouchEmbed(e);
  });
  memSaveAll();
  return { added: added, skipped: skipped };
}

/* ---- 记忆页 UI ---- */
const MEMUI = { cat: '', keyword: '', toolsOpen: false, editing: null };

function memEsc(s) { return esc(String(s == null ? '' : s)); }
function memDate(s) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function memCardHTML(e) {
  const tags = (e.tags || []).map(t => '<span class="mem-tag">#' + memEsc(t) + '</span>').join('');
  return '<div class="mem-card' + (e.pinned ? ' pin' : '') + '" data-id="' + memEsc(e.id) + '">' +
    '<div class="mem-hd">' +
      (e.pinned ? '<span class="mem-pin">★</span>' : '') +
      '<span class="mem-title">' + memEsc(e.title) + '</span>' +
      '<span class="mem-cat">' + memEsc(memCat(e)) + '</span>' +
    '</div>' +
    '<div class="mem-body">' + memEsc(e.content) + '</div>' +
    '<div class="mem-ft">' + (tags || '<span class="mem-tag">无标签</span>') +
      '<span class="mem-meta">' + memDate(e.updatedAt) + (e.hits ? ' · 读过' + e.hits + '次' : '') + '</span></div>' +
    '<div class="mem-ops">' +
      '<button data-op="edit">编辑</button>' +
      '<button data-op="pin">' + (e.pinned ? '取消重要' : '设为重要') + '</button>' +
      '<button data-op="del" class="danger">删除</button>' +
    '</div>' +
  '</div>';
}

async function renderMemory() {
  const el = $('#memory');
  if (!el) return;
  const counts = {};
  MEM.forEach(e => { const c = memCat(e); counts[c] = (counts[c] || 0) + 1; });
  const all = MEM_CATS.concat(Object.keys(counts).filter(c => MEM_CATS.indexOf(c) < 0));
  let ch = '<button data-cat="" class="' + (MEMUI.cat ? '' : 'on') + '">全部<span class="cnt">' + MEM.length + '</span></button>';
  all.forEach(c => {
    const n = counts[c] || 0;
    if (!n && MEM_CATS.indexOf(c) >= 0) return;
    ch += '<button data-cat="' + memEsc(c) + '" class="' + (MEMUI.cat === c ? 'on' : '') + '">' +
      memEsc(c) + '<span class="cnt">' + n + '</span></button>';
  });
  $('#mem-cats').innerHTML = ch;
  $$('#mem-cats button').forEach(b => {
    b.onclick = () => { MEMUI.cat = b.dataset.cat || ''; renderMemory(); };
  });

  let list;
  try { list = await memSearch({ keyword: MEMUI.keyword, category: MEMUI.cat, limit: 50 }); }
  catch (e) { list = MEM.slice(0, 50); }
  if (!list.length) {
    $('#mem-list').innerHTML = '<div id="mem-empty">' + (MEM.length ? '没有匹配的记忆~' :
      '还没有记忆。<br>多和' + memEsc(CONFIG.assistantName || '她') + '聊几句，我会自己记下来；<br>也可以点右上角「＋ 新建」手动添加。') + '</div>';
    return;
  }
  $('#mem-list').innerHTML = list.map(memCardHTML).join('');
  $$('#mem-list .mem-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('.mem-body').onclick = () => card.classList.toggle('open');
    card.querySelector('.mem-title').onclick = () => card.classList.toggle('open');
    card.querySelectorAll('.mem-ops button').forEach(btn => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const op = btn.dataset.op;
        if (op === 'edit') openMemEditor(id);
        else if (op === 'pin') {
          const e = memFind(id);
          if (!e) return;
          memUpdate(id, { pinned: !e.pinned });
          toast(e.pinned ? '已设为重要' : '已取消重要');
          renderMemory();
        } else if (op === 'del') {
          const e = memFind(id);
          if (!e) return;
          if (!(await uiConfirm('删除这条记忆？\n\n' + e.title, '删除', '确认删除'))) return;
          memDel(id);
          toast('已删除');
          renderMemory();
        }
      };
    });
  });
}

function openMemEditor(id) {
  const e = id ? memFind(id) : null;
  MEMUI.editing = id || null;
  const cats = MEM_CATS.concat(MEM.map(x => memCat(x)).filter((c, i, a) => a.indexOf(c) === i && MEM_CATS.indexOf(c) < 0));
  $('#mem-edit').innerHTML =
    '<h3>' + (e ? '编辑记忆' : '新建记忆') + '</h3>' +
    '<div class="sg"><label>标题（一句话，越具体越好搜）</label>' +
      '<input id="me-title" type="text" value="' + (e ? memEsc(e.title) : '') + '" placeholder="例如：用户喜欢喝无糖可乐"></div>' +
    '<div class="sg"><label>分类</label><input id="me-cat" type="text" list="me-cat-list" value="' + (e ? memEsc(memCat(e)) : '') + '" placeholder="选一个或自己写一个">' +
      '<datalist id="me-cat-list">' + cats.map(c => '<option value="' + memEsc(c) + '"></option>').join('') + '</datalist></div>' +
    '<div class="sg"><label>标签（用逗号分隔）</label>' +
      '<input id="me-tags" type="text" value="' + (e ? memEsc((e.tags || []).join('，')) : '') + '" placeholder="可乐，饮食，偏好"></div>' +
    '<div class="sg"><label>正文</label>' +
      '<textarea id="me-content" placeholder="把事情写清楚，以后你自己能看懂">' + (e ? memEsc(e.content) : '') + '</textarea></div>' +
    '<label class="mem-switch"><input type="checkbox" id="me-pin"' + (e && e.pinned ? ' checked' : '') + '>设为重要（常驻在每轮对话里）</label>' +
    '<div class="acts"><button class="btn-p" id="me-save">保存</button><button class="btn-s" id="me-cancel">取消</button></div>' +
    (e ? '<div class="acts" style="margin-top:8px"><button class="btn-s" id="me-del" style="color:#d6336c">删除这条</button></div>' : '');
  $('#mem-edit').classList.add('open');

  const close = () => { $('#mem-edit').classList.remove('open'); MEMUI.editing = null; };
  $('#me-cancel').onclick = close;
  $('#me-save').onclick = () => {
    const title = $('#me-title').value.trim();
    const content = $('#me-content').value.trim();
    const cat = $('#me-cat').value.trim() || '其他';
    const tags = $('#me-tags').value.split(/[，,、;；]/).map(s => s.trim()).filter(Boolean);
    const pinned = $('#me-pin').checked;
    if (!title) return toast('标题不能为空');
    if (!content) return toast('正文不能为空');
    if (MEMUI.editing) memUpdate(MEMUI.editing, { title: title, content: content, cat: cat, tags: tags, pinned: pinned });
    else memAdd({ title: title, content: content, cat: cat, tags: tags, pinned: pinned, src: 'user' });
    close();
    toast('已保存~');
    renderMemory();
  };
  if ($('#me-del')) $('#me-del').onclick = async () => {
    if (!(await uiConfirm('删除这条记忆？', '删除', '确认删除'))) return;
    memDel(MEMUI.editing);
    close();
    toast('已删除');
    renderMemory();
  };
}

/** 把对话里值得长期记住的东西整理进记忆库（让 AI 自己决定存什么） */
async function memSummarize(opts) {
  const auto = !!(opts && opts.auto);
  const non = history.filter(m => m.role !== 'system');
  if (non.length < 4) { if (!auto) toast('对话太短，再聊几句吧~'); return; }
  if (sending && !auto) return;
  if (auto) {
    const st = memAutoState();
    if (st.running) return;
    st.running = true; memAutoSave(st);
  }
  const idx = MEM.length
    ? MEM.map(e => '- [' + e.id + '] ' + e.title + '（' + memCat(e) + '）：' + String(e.content || '').replace(/\s+/g, ' ').slice(0, 220)).join('\n')
    : '（记忆库现在还是空的）';
  const convo = non.map(m => (m.role === 'user' ? '用户' : (CONFIG.assistantName || 'AI')) + '：' + textOfContent(m.content)).join('\n');
  if (!auto && !(await uiConfirm('把这段对话里值得长期记住的东西整理进记忆库？', '开始整理', '总结记忆'))) {
    const st0 = memAutoState(); st0.running = false; memAutoSave(st0);
    return;
  }

  sending = true;
  const ld = addTyping();
  let ok = false;
  try {
    const p = (CONFIG.summaryPrompt || DC.summaryPrompt) +
      '\n\n【本次任务】你现在不是在和用户聊天，而是在整理自己的长期记忆库。请优先使用 save_memory 新增下面这段对话中值得长期保留的信息：\n' +
      '· 用户的偏好、习惯、身份、人际关系\n· 正在进行的项目、约定、待办\n· 值得记住的事件和结论\n' +
      '不要记录寒暄、临时问答、以及能从常识推断出来的东西。\n' +
      '记忆规则：类别相同也可以新增，不得因为类别相同就调用 update_memory。只有已有正文与新内容高度相似、且明确是同一事实时，才允许合并。合并必须保留已有正文，并把新内容完整追加在后面，不得缩短、改写或覆盖。若内容是新的事实或相似度不足，必须新增。\n' +
      '下面是已有记忆索引（含正文摘要），仅用于判断是否高度相似：\n' + idx +
      '\n\n【本次对话】\n' + convo;
    await chatReqTools([
      { role: 'system', content: CONFIG.systemPrompt },
      { role: 'user', content: p }
    ]);
    ok = true;
  } catch (e) {
    ld.remove();
    addMsg('assistant', '整理记忆失败：' + errMsg(e));
  }
  const st1 = memAutoState(); st1.running = false; st1.lastAt = Date.now(); memAutoSave(st1);
  if (ok) {
    ld.remove();
    toast(auto ? '已自动整理记忆：现在共 ' + MEM.length + ' 条' : '记忆已整理：现在共 ' + MEM.length + ' 条');
    renderMemory();
    if (await uiConfirm('要不要顺便把当前任务对话清空？', '清空对话', '清理对话')) {
      await clearCurrentChat();
    }
    renderMemory();
  }
  sending = false;
}

function bindMemory() {
  const back = $('#mem-back');
  if (!back) return;
  back.onclick = () => showView('chat');
  $('#mem-sum').onclick = memSummarize;
  $('#mem-new').onclick = () => openMemEditor(null);
  $('#mem-tools-btn').onclick = () => {
    MEMUI.toolsOpen = !MEMUI.toolsOpen;
    $('#mem-tools').classList.toggle('open', MEMUI.toolsOpen);
  };
  const doSearch = () => { MEMUI.keyword = $('#mem-search').value.trim(); renderMemory(); };
  $('#mem-search-btn').onclick = doSearch;
  $('#mem-search').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };

  $('#mem-export-json').onclick = () => {
    if (!MEM.length) return toast('还没有记忆可以导出哦');
    $('#mem-code').value = memExportJSON();
    MEMUI.toolsOpen = true; $('#mem-tools').classList.add('open');
    toast('已生成 JSON，可复制保存');
  };
  $('#mem-export-md').onclick = () => {
    if (!MEM.length) return toast('还没有记忆可以导出哦');
    $('#mem-code').value = memExportMarkdown();
    MEMUI.toolsOpen = true; $('#mem-tools').classList.add('open');
    toast('已生成 Markdown，可复制保存');
  };
  $('#mem-copy').onclick = () => {
    const v = $('#mem-code').value.trim();
    if (!v) return toast('先点导出吧~');
    toast(writeClipboard(v) ? '已复制到剪贴板' : '复制失败，请长按文本框手动复制');
  };
  const doImport = async (replace) => {
    const raw = $('#mem-code').value.trim();
    if (!raw) return toast('请先粘贴记忆数据');
    if (replace && !(await uiConfirm('覆盖导入会清空现有的 ' + MEM.length + ' 条记忆，确定吗？', '覆盖', '确认覆盖'))) return;
    try {
      const r = memImport(raw, replace);
      $('#mem-code').value = '';
      toast('导入完成：新增 ' + r.added + ' 条' + (r.skipped ? '，跳过重复 ' + r.skipped + ' 条' : ''));
      renderMemory();
    } catch (e) { toast('导入失败：' + errMsg(e)); }
  };
  $('#mem-import').onclick = () => doImport(false);
  $('#mem-import-replace').onclick = () => doImport(true);
}

