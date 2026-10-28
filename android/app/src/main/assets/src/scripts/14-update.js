/* ==========================================================
 *  应用更新
 * ========================================================== */
const UPD = { checking: false, info: null, dlId: '' };

function verArr(s) {
  const m = String(s || '').match(/\d+(?:\.\d+)*/);
  return m ? m[0].split('.').map(n => parseInt(n, 10) || 0) : [];
}
function cmpVer(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkUpdate(manual) {
  if (UPD.checking) { if (manual) toast('正在检查，请稍候…'); return; }
  UPD.checking = true;
  if (manual) toast('正在检查更新…');
  try {
    const r = await reqRequest({
      method: 'GET', url: UPDATE_API,
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ElysiaFloat' },
      timeoutMs: 15000, expect: 'json', retries: 1, source: 'system:update'
    });
    const rel = r.json;
    const tag = String(rel.tag_name || rel.name || '').trim();
    const latest = verArr(tag);
    const cur = verArr((loadEnv() || {}).appVer || '0');
    CONFIG.lastUpdateCheck = Date.now();
    sSet('via_ai_config', CONFIG);
    if (!latest.length) throw new Error('无法解析版本号');
    if (cmpVer(latest, cur) > 0) {
      const apks = (rel.assets || []).filter(a => /\.apk$/i.test(a.name || ''));
      const key = tag.toLowerCase().replace(/^v/, '');
      const asset = apks.filter(a => String(a.name || '').toLowerCase().indexOf(key) >= 0)[0] || apks[0];
      UPD.info = {
        tag: tag || ('v' + latest.join('.')),
        notes: String(rel.body || '').slice(0, 1500),
        url: asset ? asset.browser_download_url : '',
        name: asset ? asset.name : '',
        page: rel.html_url || UPDATE_RELEASES
      };
      showUpdateModal();
    } else if (manual) {
      toast('已是最新版本（' + ((loadEnv() || {}).appVer || '?') + '）');
    }
  } catch (e) {
    if (manual) toast('检查更新失败：' + errMsg(e));
  } finally {
    UPD.checking = false;
  }
}

function showUpdateModal() {
  const info = UPD.info;
  if (!info) return;
  const t = $('#upd-title'), n = $('#upd-notes'), bar = $('#upd-progress'), go = $('#upd-go');
  if (!t) return;
  t.textContent = '发现新版本 ' + info.tag;
  n.textContent = info.notes || '（该版本没有填写更新说明）';
  if (bar) bar.style.width = '0%';
  if (go) { go.disabled = false; go.textContent = info.url ? '下载并安装' : '打开下载页'; }
  $('#update-modal').classList.add('open');
}

async function downloadUpdate() {
  const info = UPD.info;
  if (!info) return;
  if (!info.url) {
    try { if (HAS_NATIVE && Android.openUrl) Android.openUrl(info.page); } catch (e) {}
    return;
  }
  if (HAS_NATIVE && Android.canInstall) {
    let allowed = true;
    try { allowed = !!Android.canInstall(); } catch (e) { allowed = true; }
    if (!allowed) {
      const go = await uiConfirm('安装更新需要允许「安装未知应用」。现在去开启吗？', '去开启', '安装权限');
      if (go) { try { if (Android.requestInstallPermission) Android.requestInstallPermission(); } catch (e) {} }
      return;
    }
  }
  if (!(HAS_NATIVE && Android.downloadAndInstall)) {
    try { if (HAS_NATIVE && Android.openUrl) Android.openUrl(info.url); } catch (e) {}
    return;
  }
  UPD.dlId = 'u' + Date.now();
  const go = $('#upd-go');
  if (go) { go.disabled = true; go.textContent = '下载中…'; }
  try { Android.downloadAndInstall(UPD.dlId, info.url, info.name || ('ElysiaFloat-' + info.tag + '.apk')); }
  catch (e) { if (go) { go.disabled = false; go.textContent = '重试'; } toast('下载失败：' + errMsg(e)); }
}

window.__dlCb = function (id, pct, done, err, path) {
  if (id !== UPD.dlId) return;
  const bar = $('#upd-progress'), go = $('#upd-go');
  if (!done) { if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; return; }
  if (go) go.disabled = false;
  if (err) { if (go) go.textContent = '重试'; toast('下载失败：' + err); return; }
  if (bar) bar.style.width = '100%';
  if (go) go.textContent = '已开始安装';
  toast('安装包已下载，请按系统提示完成安装');
};

function organizeSettingsSections() {
  const root = $('#settings');
  if (!root) return;
  const nodes = Array.from(root.children);
  const save = root.querySelector('#settings-save-block');
  const spacer = root.querySelector('#settings-bottom-spacer');

  // E1-004：五个分组页签；每节归入固定分组，进入设置先看「AI 与模型」。
  const panels = {};
  const nav = document.createElement('div');
  nav.className = 'settings-tabs';
  SETTINGS_GROUPS.forEach(g => {
    const panel = document.createElement('div');
    panel.className = 'set-group';
    panel.dataset.group = g.id;
    panels[g.id] = panel;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-tab';
    btn.dataset.settingsGroup = g.id;
    btn.textContent = g.label;
    if (g.id === SETTINGS_GROUP) btn.classList.add('on');
    nav.appendChild(btn);
  });

  let current = panels['ai'];
  nodes.forEach(n => {
    if (n === save || n === spacer) return;
    if (n.classList && n.classList.contains('sec-title')) {
      const title = String(n.textContent || '').trim();
      const gid = SETTINGS_SECTION_GROUP[title] || 'advanced';
      current = panels[gid] || panels['ai'];
      current.appendChild(n);
      return;
    }
    current.appendChild(n);
  });
  Object.keys(panels).forEach(k => { panels[k].hidden = k !== SETTINGS_GROUP; });

  nav.onclick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-settings-group]') : null;
    if (!b) return;
    SETTINGS_GROUP = b.dataset.settingsGroup || 'ai';
    Object.keys(panels).forEach(k => { panels[k].hidden = k !== SETTINGS_GROUP; });
    Array.from(nav.children).forEach(x => {
      if (x.classList) x.classList.toggle('on', x.dataset && x.dataset.settingsGroup === SETTINGS_GROUP);
    });
    if (root.scrollTop !== undefined) root.scrollTop = 0;
  };

  const fragment = document.createDocumentFragment();
  fragment.appendChild(nav);
  SETTINGS_GROUPS.forEach(g => fragment.appendChild(panels[g.id]));
  if (save) fragment.appendChild(save);
  if (spacer) fragment.appendChild(spacer);
  root.innerHTML = '';
  root.appendChild(fragment);
}

function readAgentState() {
  try {
    if (HAS_PERM && Perm.getAgentState) return JSON.parse(Perm.getAgentState() || '{}');
  } catch (e) {}
  return { whitelist: [], allowAll: false, foregroundPackage: '' };
}
let agentAppQuery = '';
function renderAgentWhitelist() {
  const box = $('#agent-whitelist-list');
  if (!box) return;
  const state = readAgentState();
  const selected = new Set(Array.isArray(state.whitelist) ? state.whitelist : []);
  if (state.allowAll) {
    box.innerHTML = '<div class="plug-warn">警告：当前已允许所有应用。关闭后才会恢复白名单限制。</div><div class="acts"><button type="button" id="btn-agent-disable-all" class="btn-s">关闭允许所有应用</button></div>';
    const off = $('#btn-agent-disable-all');
    if (off) off.onclick = () => { if (HAS_PERM && Perm.setAgentAllowAll) Perm.setAgentAllowAll(false); renderAgentWhitelist(); toast('已恢复白名单限制'); };
    return;
  }
  let apps = [];
  try { apps = HAS_PERM && Perm.listAgentApps ? JSON.parse(Perm.listAgentApps() || '[]') : []; } catch (e) { apps = []; }
  apps.sort((a, b) => (selected.has(b.package) ? 1 : 0) - (selected.has(a.package) ? 1 : 0));
  const q = agentAppQuery.trim().toLowerCase();
  const filtered = q ? apps.filter(a => String(a.label || '').toLowerCase().indexOf(q) >= 0 || String(a.package || '').toLowerCase().indexOf(q) >= 0) : apps;
  const shown = filtered.slice(0, 160);
  box.innerHTML = (selected.size ? '<div class="mini-note">已允许 ' + selected.size + ' 个应用；当前显示 ' + shown.length + ' 个：</div>' : '<div class="mini-note">还没有加入应用。当前显示 ' + shown.length + ' 个可启动应用：</div>')
    + shown.map(a => `<div class="agent-app-row"><div class="agent-app-name">${esc(a.label || '未命名应用')}<span class="agent-app-pkg">${esc(a.package)}</span></div><button type="button" data-agent-package="${esc(a.package)}">${selected.has(a.package) ? '移除' : '加入'}</button></div>`).join('');
  if (!shown.length) box.innerHTML += '<div class="mini-note">没有匹配的可启动应用。可以搜索应用名或包名。</div>';
}
function bindAgentWhitelist() {
  const current = $('#btn-agent-current');
  if (current) current.onclick = () => {
    const pkg = readAgentState().foregroundPackage || '';
    if (!pkg) return toast('当前没有可识别的前台应用');
    if (HAS_PERM && Perm.addAgentWhitelist) Perm.addAgentWhitelist(pkg);
    renderAgentWhitelist();
    toast('已加入白名单：' + pkg);
  };
  const all = $('#btn-agent-all');
  if (all) all.onclick = async () => {
    const ok = await uiConfirm('警告：允许所有应用后，Agent 可读取并操作未单独选择的应用。银行、支付、密码管理器和输入法等敏感应用也可能受到影响。请确认你理解风险。', '允许所有应用', '白名单警告');
    if (!ok) return;
    if (HAS_PERM && Perm.setAgentAllowAll) Perm.setAgentAllowAll(true);
    renderAgentWhitelist();
  };
  const privacy = $('#btn-agent-privacy');
  if (privacy) privacy.onclick = () => uiConfirm('银行、支付、密码管理器、输入法、锁屏和系统设置属于隐私应用。加入前请确认风险；加入白名单也不能绕过 FLAG_SECURE 或系统权限。', '知道了', '隐私应用说明');
  const refresh = $('#btn-agent-refresh');
  if (refresh) refresh.onclick = renderAgentWhitelist;
  const search = $('#agent-app-search');
  if (search) search.oninput = () => { agentAppQuery = search.value; renderAgentWhitelist(); };
  const list = $('#agent-whitelist-list');
  if (list) list.onclick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-agent-package]') : null;
    if (!b) return;
    const pkg = b.dataset.agentPackage || '';
    const state = readAgentState();
    const selected = new Set(Array.isArray(state.whitelist) ? state.whitelist : []);
    if (selected.has(pkg)) {
      if (HAS_PERM && Perm.removeAgentWhitelist) Perm.removeAgentWhitelist(pkg);
      toast('已移出白名单');
    } else {
      if (HAS_PERM && Perm.addAgentWhitelist) Perm.addAgentWhitelist(pkg);
      toast('已加入白名单');
    }
    renderAgentWhitelist();
  };
  renderAgentWhitelist();
}
function renderRuntimeState() {
  const box = $('#runtime-state'); if (!box) return;
  try {
    const a = HAS_PERM && Perm.getAgentRuntimeState ? JSON.parse(Perm.getAgentRuntimeState() || '{}') : {};
    const t = HAS_PERM && Perm.getTermuxWorkerState ? JSON.parse(Perm.getTermuxWorkerState() || '{}') : {};
    const e = HAS_PERM && Perm.listExternalAgents ? JSON.parse(Perm.listExternalAgents() || '[]') : [];
    box.textContent = 'Android：可用 · 无障碍：' + (a.accessibility ? '已连接' : '未连接') + ' · Shizuku：' + (a.shizukuInstalled ? '已安装' : '未安装') + ' · Root：' + (a.rootAvailable ? '可检测到' : '未授权') + ' · Termux：' + (t.installed ? '已安装，未连接' : '未安装') + ' · 外部 Agent：' + (Array.isArray(e) ? e.length : 0) + ' 个';
  } catch (e) { box.textContent = '运行时状态暂时不可用。'; }
}
function renderWorkspaceState() {
  const box = $('#workspace-state');
  if (!box) return;
  const s = workspaceState();
  if (!s) { box.textContent = '当前环境不支持工作区状态查询。'; return; }
  if (!s.permission) { box.textContent = '状态：还没有开启“允许管理所有文件”。'; return; }
  box.textContent = s.created ? ('状态：工作区已创建 · ' + (s.items || 0) + ' 个项目 · Documents/ElysiaFloat/workspace') : '状态：权限已开启，但工作区尚未创建。';
}
function bindWorkspace() {
  const access = $('#btn-files-access');
  if (access) access.onclick = () => {
    if (HAS_PERM && Perm.requestAllFilesAccess) Perm.requestAllFilesAccess();
    setTimeout(renderWorkspaceState, 900);
    setTimeout(renderWorkspaceState, 1800);
  };
  const create = $('#btn-workspace-create');
  if (create) create.onclick = () => {
    if (!(HAS_PERM && Perm.createWorkspace)) return toast('当前环境不支持创建工作区');
    try {
      const r = JSON.parse(Perm.createWorkspace() || '{}');
      if (r.ok) toast('工作区已创建'); else toast(r.error || '工作区创建失败');
    } catch (e) { toast('工作区创建失败：' + errMsg(e)); }
    renderWorkspaceState();
    refreshSystemPrompt();
    renderPlugins();
  };
  const refresh = $('#btn-workspace-refresh');
  if (refresh) refresh.onclick = renderWorkspaceState;
  renderWorkspaceState();
}
function bindRuntime() {
  const refresh = $('#btn-runtime-refresh'); if (refresh) refresh.onclick = renderRuntimeState;
  const ext = $('#btn-external-agents'); if (ext) ext.onclick = () => { renderRuntimeState(); toast('外部 Agent 适配框架已就绪，具体适配需单独安装并确认~'); };
  renderRuntimeState();
}

/* ==========================================================
 *  设置分组（E1-004）与模型中心 UI（E2-001/005）
 * ========================================================== */
let SETTINGS_GROUP = 'ai';
const SETTINGS_GROUPS = [
  { id: 'ai', label: 'AI 与模型' },
  { id: 'appearance', label: '外观' },
  { id: 'permission', label: '权限' },
  { id: 'workspace', label: '工作区' },
  { id: 'advanced', label: '高级' }
];
const SETTINGS_SECTION_GROUP = {
  '模型中心': 'ai',
  'AI 与模型': 'ai',
  '语音合成': 'ai',
  '屏幕翻译': 'ai',
  '长期记忆': 'ai',
  '个性化与聊天风格': 'appearance',
  '音乐功能': 'appearance',
  'Agent 与工作台': 'permission',
  '应用白名单': 'permission',
  '权限': 'permission',
  '文件访问与工作区': 'workspace',
  '高级运行时': 'advanced',
  '插件与工具': 'advanced',
  '检查更新': 'advanced',
  '环境信息': 'advanced',
  '数据管理': 'advanced'
};

let PROVIDER_EDIT_ID = '';
function providerCapsHtml(caps) {
  return PROVIDER_CAPS.map(c =>
    '<label class="cap-chip"><input type="checkbox" value="' + esc(c) + '"'
    + (caps && caps.indexOf(c) >= 0 ? ' checked' : '') + '> ' + esc(PROVIDER_CAP_LABEL[c] || c) + '</label>'
  ).join('');
}
function providerCloseForm() {
  PROVIDER_EDIT_ID = '';
  const f = $('#provider-form'); if (f) f.hidden = true;
}
function providerOpenForm(id) {
  PROVIDER_EDIT_ID = id || '';
  const p = id ? providerFind(CONFIG, id) : null;
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v == null ? '' : String(v); };
  const title = $('#provider-form-title');
  if (title) title.textContent = p ? '编辑 Provider' : '添加 Provider';
  set('#prov-name', p ? p.name : '');
  set('#prov-kind', p ? p.kind : 'openai');
  set('#prov-base', p ? p.base : '');
  set('#prov-model', p ? p.model : '');
  const key = $('#prov-key');
  if (key) {
    key.value = '';
    key.placeholder = (p && providerKeyOf(p)) ? '已保存，留空表示不修改' : 'sk-...';
  }
  const caps = $('#prov-caps');
  if (caps) caps.innerHTML = providerCapsHtml(p ? p.capabilities : ['chat']);
  const form = $('#provider-form');
  if (form) {
    form.hidden = false;
    const anchor = $('#provider-form-title');
    if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'nearest' });
  }
}
function providerSaveForm() {
  const val = (sel) => { const el = $(sel); return el && el.value != null ? String(el.value).trim() : ''; };
  const name = val('#prov-name');
  if (!name) { toast('先给 Provider 起个名字'); return; }
  const base = val('#prov-base');
  if (base && !/^https?:\/\//i.test(base)) { toast('接口地址要以 http(s):// 开头'); return; }
  const existing = PROVIDER_EDIT_ID ? providerFind(CONFIG, PROVIDER_EDIT_ID) : null;
  const caps = $$('#prov-caps input').filter(x => x.checked).map(x => String(x.value));
  const id = PROVIDER_EDIT_ID || providerId('prov');
  const p = providerUpsert(CONFIG, {
    id: id,
    name: name,
    kind: val('#prov-kind') || 'openai',
    base: base,
    model: val('#prov-model'),
    capabilities: caps,
    secretRef: existing ? existing.secretRef : ('ai.provider.' + id),
    enabled: existing ? existing.enabled !== false : true
  }, val('#prov-key'));
  if (!p) { toast('Provider 保存失败'); return; }
  sSet('via_ai_config', CONFIG);
  providerCloseForm();
  renderProviderCenter();
  toast(existing ? 'Provider 已更新' : 'Provider 已添加');
}
async function providerRunTest(id) {
  const card = $$('[data-provider-result="' + id + '"]')[0];
  if (card) { card.hidden = false; card.textContent = '正在测试…'; }
  let r;
  try { r = await providerTest(CONFIG, id); }
  catch (e) { r = { ok: false, latencyMs: 0, status: 0, error: errMsg(e), models: [], capabilities: [] }; }
  const el = $$('[data-provider-result="' + id + '"]')[0];
  if (!el) return;
  el.hidden = false;
  if (!r.ok) {
    el.textContent = '测试失败：' + (r.error || ('HTTP ' + r.status)) + (r.latencyMs ? '（' + r.latencyMs + 'ms）' : '');
    return;
  }
  const capText = (r.capabilities || []).map(c => PROVIDER_CAP_LABEL[c] || c).join('、') || '未从模型名推断出';
  el.textContent = '连接正常 · ' + r.latencyMs + 'ms · ' + r.models.length + ' 个模型 · 可用能力：' + capText;
}
function renderProviderCenter() {
  const bindBox = $('#provider-bind-box');
  const list = $('#provider-list');
  if (!bindBox && !list) return;
  const providers = (CONFIG.providers || []).filter(p => p && p.enabled !== false);
  if (bindBox) {
    bindBox.innerHTML = ['chat', 'vision', 'embedding', 'tts'].map(purpose => {
      const usable = providers.filter(p => (p.capabilities || []).indexOf(purpose) >= 0);
      const cur = (CONFIG.bindings && CONFIG.bindings[purpose] && CONFIG.bindings[purpose].provider) || '';
      return '<div class="sg"><label>' + esc(PROVIDER_PURPOSE_LABEL[purpose] || purpose) + '</label>'
        + '<select data-bind-purpose="' + purpose + '"><option value="">自动选择</option>'
        + usable.map(p => '<option value="' + esc(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
        + '</select></div>';
    }).join('');
  }
  if (!list) return;
  const sum = providerSummary(CONFIG);
  if (!sum.length) {
    list.innerHTML = '<div class="mini-note">还没有 Provider。</div>';
    return;
  }
  list.innerHTML = sum.map(s =>
    '<div class="provider-card' + (s.enabled ? '' : ' off') + '">'
    + '<div class="provider-head"><b>' + esc(s.name) + '</b>'
    + '<span class="provider-kind">' + esc(s.kindLabel) + '</span>'
    + (s.hasKey ? '<span class="provider-key ok">已存 Key</span>' : '<span class="provider-key">未存 Key</span>')
    + '</div>'
    + '<div class="provider-meta">' + esc(s.base || '未填接口地址') + (s.model ? ' · ' + esc(s.model) : '') + '</div>'
    + '<div class="provider-caps">' + (s.capabilities.length
      ? s.capabilities.map(c => '<i>' + esc(PROVIDER_CAP_LABEL[c] || c) + '</i>').join('')
      : '<i>未标注能力</i>') + '</div>'
    + '<div class="provider-acts">'
    + '<button type="button" class="btn-s" data-provider-action="test" data-provider-id="' + esc(s.id) + '">测试连接</button>'
    + '<button type="button" class="btn-s" data-provider-action="edit" data-provider-id="' + esc(s.id) + '">编辑</button>'
    + '<button type="button" class="btn-s" data-provider-action="remove" data-provider-id="' + esc(s.id) + '">删除</button>'
    + '</div>'
    + '<div class="provider-result" data-provider-result="' + esc(s.id) + '" hidden></div>'
    + '</div>'
  ).join('');
}

function renderSettings() {
  const presetOpts = Object.keys(PRESETS).map(k => ({ v: k, t: PRESETS[k].label }));
  const showAvatar = (CONFIG.avatarUrl || '').indexOf('data:') === 0 ? AV_LOCAL : (CONFIG.avatarUrl || '');
  $('#settings').innerHTML = `
<div class="sec-title">模型中心</div>
<div class="mini-note" style="margin-top:8px">每个 Provider 是一个接口地址 + 一个密钥 + 一组能力标签。聊天、识图、向量、语音可分别绑定；Key 只保存在 AndroidKeyStore，导出与日志都不含 Key。</div>
<div id="provider-bind-box"></div>
<div id="provider-list" class="provider-list"></div>
<div class="acts" style="margin-top:8px"><button type="button" id="btn-provider-add" class="btn-s">添加 Provider</button></div>
<div id="provider-form" hidden>
  <div class="sub-title" id="provider-form-title">添加 Provider</div>
  <div class="sg" style="margin-top:8px"><label>名称</label><input id="prov-name" placeholder="例如 主模型 / 识图 / 备用"></div>
  <div class="sg"><label>类型</label><select id="prov-kind">
    ${Object.keys(PROVIDER_KINDS).map(k => '<option value="' + esc(k) + '">' + esc(PROVIDER_KINDS[k].label) + '</option>').join('')}
  </select></div>
  <div class="sg"><label>接口地址</label><input id="prov-base" placeholder="https://.../v1"></div>
  <div class="sg"><label>默认模型</label><input id="prov-model" placeholder="如 gpt-4o / claude-3-5-sonnet"></div>
  <div class="sg"><label>API Key</label>
    <div class="pin-row">
      <input id="prov-key" type="password" autocomplete="off" placeholder="sk-...">
      <button type="button" id="btn-paste-prov-key" class="btn-paste">粘贴</button>
    </div></div>
  <div class="sg"><label>能力</label><div id="prov-caps" class="cap-list"></div></div>
  <div class="acts"><button type="button" id="btn-provider-save" class="btn-p">保存 Provider</button><button type="button" id="btn-provider-cancel" class="btn-s">取消</button></div>
</div>

<div class="sec-title">AI 与模型</div>
<div class="sg"><label>模型预设</label>${chipGroup('preset', presetKey(), presetOpts)}</div>
<div class="sg"><label>API 地址</label><input id="set-apibase" value="${esc(CONFIG.apiBase)}"></div>
<div class="sg"><label>API Key</label>
  <div class="pin-row">
    <input id="set-apikey" class="secret" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(CONFIG.apiKey)}">
    <button type="button" id="btn-paste-key" class="btn-paste">粘贴</button>
  </div></div>
<div class="sg"><label>模型</label>
  <div class="pin-row">
    <input id="set-model" value="${esc(CONFIG.model)}">
    <button type="button" id="btn-detect-models" class="btn-paste">检测</button>
  </div></div>
<div id="model-detect-list" class="model-detect" hidden></div>
<div class="mini-note" id="model-detect-note" hidden></div>
<div class="sub-title">识图模型（可选）</div>
<div class="mini-note" style="margin-top:8px">对话模型不支持图片时，先用识图模型描述图片或截图，再交给对话模型回答。</div>
<div class="sg" style="margin-top:8px"><label>识图 API 地址</label><input id="set-vision-base" value="${esc(CONFIG.visionBase || '')}" placeholder="https://.../v1"></div>
<div class="sg"><label>识图 API Key</label><div class="pin-row"><input id="set-vision-key" class="secret" type="text" autocomplete="off" value="${esc(CONFIG.visionKey || '')}"><button type="button" id="btn-paste-vkey" class="btn-paste">粘贴</button></div></div>
<div class="sg"><label>识图模型</label><input id="set-vision-model" value="${esc(CONFIG.visionModel || '')}" placeholder="如 gpt-4o / qwen-vl-max"></div>
<div class="sec-title">个性化与聊天风格</div>
<div class="mini-note" style="margin-top:8px">头像、名称和聊天人设只影响普通聊天表达，不会覆盖 Agent 安全规则。</div>
<div class="sg"><label>助手名</label><input id="set-name" value="${esc(CONFIG.assistantName)}"></div>
<div class="sg"><label>头像（图片 URL 或本地照片）</label><input id="set-avatar" value="${esc(showAvatar)}"></div>
<div class="acts" style="margin-top:8px">
  <button id="btn-pick-avatar" class="btn-s">上传照片并裁剪</button>
</div>
<div class="mini-note">可填写网络图片地址，也可上传本地照片并裁剪为圆形头像。</div>
<div class="sg"><label>头像取景（竖图才看得出区别）</label>${chipGroup('fit', CONFIG.avatarFit || 'top', [{v:'top',t:'取上部'},{v:'center',t:'居中'},{v:'bottom',t:'取下部'}])}</div>
<div class="sg"><label>记忆轮数</label><input id="set-turns" type="number" value="${CONFIG.maxContextTurns}"></div>
<div class="sub-title">外观</div>
<div class="sg" style="margin-top:8px"><label>主题色 1</label>${swatchGroup('c1', CONFIG.themeColor1)}</div>
<div class="sg"><label>主题色 2</label>${swatchGroup('c2', CONFIG.themeColor2)}</div>
<div class="sub-title">自定义聊天人设</div>
<div class="mini-note" style="margin-top:8px">只用于普通聊天的身份、称呼和说话风格。工具能力和工作 Agent 提示词在其它分区独立管理。</div>
<div class="sg" style="margin-top:8px"><textarea id="set-persona" style="min-height:150px">${esc(CONFIG.persona || DC.persona)}</textarea></div>

<div class="sec-title">聊天与助手</div>
<div class="mini-note" style="margin-top:8px">普通聊天、放歌、翻译、屏幕总结、图片理解和用户主动提供的文件处理都属于短任务，不会自动创建长期工作任务。</div>
<div class="acts" style="margin-top:8px"><button id="btn-chat-mode" class="btn-p">使用聊天模式</button><button id="btn-new-quick" class="btn-s">查看快捷任务</button></div>

<div class="sec-title">Agent 与工作台</div>
<div class="mini-note" style="margin-top:8px">开启后，AI 可以在你授权的范围内自主读取手机、查看画面并执行行为。手机行为仍受白名单和安全开关保护。</div>
<div class="sg" style="margin-top:8px"><label>Agent 总开关</label>${toggleGroup('agentEnabled', CONFIG.agentEnabled === true ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>L1 · 读取手机信息</label>${toggleGroup('agentL1', CONFIG.agentL1 !== false ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>L2 · 查看手机画面</label>${toggleGroup('agentL2', CONFIG.agentL2 !== false ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>L3 · 操作手机</label>${toggleGroup('agentL3', CONFIG.agentL3 === true ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>安全开关</label>${toggleGroup('agentSafety', CONFIG.agentSafety === true ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>截图自动确认</label>${toggleGroup('agentAutoShot', CONFIG.agentAutoShot === true ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>读取方式</label>${toggleGroup('agentOnDemand', CONFIG.agentOnDemand !== false ? 'true' : 'false', [{v:'true',t:'按需读取'},{v:'false',t:'限时观察'}])}</div>
<div class="sg"><label>Agent 工具调用轮数</label>${chipGroup('agentToolRounds', String(parseInt(CONFIG.agentToolRounds, 10) || 0), [
  {v:'0',t:'按任务时间'}, {v:'5',t:'5 轮'}, {v:'10',t:'10 轮'}, {v:'20',t:'20 轮'}, {v:'50',t:'50 轮'}
])}</div>
<div class="sg"><label>单次 Agent 任务最长时间（秒）</label><input id="set-agent-timeout" type="number" min="15" max="7200" value="${Math.round((CONFIG.agentTaskTimeout || 1200000) / 1000)}"></div>
<div class="sg"><label>模型单次超时（秒）</label><input id="set-model-timeout" type="number" min="60" max="1800" value="${Math.round((CONFIG.modelTimeoutMs || 600000) / 1000)}"></div>
<div class="mini-note">生图、长推理、长文档改写都可能很久，默认 600 秒；识图和工具调用共用这个预算。执行中仍可随时点停止。</div>
<div class="sg"><label>手机动作预算（每次任务）</label><input id="set-device-max-actions" type="number" min="20" max="2000" value="${Math.max(20, Math.min(2000, parseInt(CONFIG.deviceMaxActions, 10) || 120))}"></div>
<div class="sg"><label>预算用完后每次追加</label><input id="set-device-resume-chunk" type="number" min="20" max="2000" value="${Math.max(20, Math.min(2000, parseInt(CONFIG.deviceActionResumeChunk, 10) || 120))}"></div>
<div class="mini-note">默认 1200 秒（20 分钟）。手机动作预算用完会**暂停**而不是失败，说「继续」就再给一批；对话聊天仍使用较短的 30 秒预算。</div>
<div class="sg"><label>工作 Agent 提示词</label><textarea id="set-work-prompt" style="min-height:120px">${esc(CONFIG.workPrompt || DC.workPrompt || '')}</textarea></div>
<div class="mini-note">这里只编辑工作偏好。系统安全规则、文件确认、Agent 权限和白名单不能被聊天人设或工作提示词覆盖。</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-agent-a11y" class="btn-s">开启无障碍</button>
  <button id="btn-agent-ime" class="btn-s">配置输入法兜底</button>
</div>
<div class="mini-note">输入文字时先尝试无障碍；失败后才使用爱莉希雅输入法。首次使用需要在系统输入法设置中启用，并由你手动切换；不会自动修改默认输入法。</div>

<div class="sec-title">高级运行时</div>
<div class="mini-note" style="margin-top:8px">Root、Shizuku、Termux 和外部 Agent 都是可选后端。当前只显示状态并建立受控协议，不会自动执行命令或安装外部 Agent。</div>
<div id="runtime-state" class="mini-note" style="margin-top:8px"></div>
<div class="acts" style="margin-top:8px"><button id="btn-runtime-refresh" class="btn-s">刷新运行时状态</button><button id="btn-external-agents" class="btn-s">查看外部 Agent</button></div>

<div class="sec-title">应用白名单</div>
<div class="mini-note" style="margin-top:8px">默认拒绝。只有加入白名单的应用才允许 L1/L2/L3 读取或操作；ElysiaFloat 自身不会加入。</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-agent-current" class="btn-p">添加当前应用</button>
  <button id="btn-agent-all" class="btn-s">允许所有应用</button>
</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-agent-privacy" class="btn-s">隐私应用说明</button>
  <button id="btn-agent-refresh" class="btn-s">刷新应用列表</button>
</div>
<div class="sg" style="margin-top:8px"><label>搜索应用名称或包名</label><input id="agent-app-search" placeholder="例如 QQ、电话、com.tencent..." value=""></div>
<div id="agent-whitelist-list" style="margin-top:8px"></div>

<div class="sec-title">文件访问与工作区</div>
<div class="mini-note" style="margin-top:8px">启用“允许管理所有文件”后，可以访问公共存储中的用户文件。工作区内的写入、覆盖、建目录不再逐次确认（覆盖前自动留快照）；工作区外的写入、覆盖、复制、建目录和删除仍会逐次弹窗确认，且确认不会永久授权。</div>
<div id="workspace-state" class="mini-note" style="margin-top:8px"></div>
<div class="acts" style="margin-top:8px">
  <button id="btn-files-access" class="btn-s">开启所有文件权限</button>
  <button id="btn-workspace-create" class="btn-p">创建工作区</button>
</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-workspace-refresh" class="btn-s">刷新工作区状态</button>
</div>

<div class="sec-title">语音合成</div>
<div class="sg" style="margin-top:8px"><label>开启朗读</label>${toggleGroup('tts', CONFIG.ttsEnabled ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>语音引擎</label>${toggleGroup('ttseng', (CONFIG.ttsEngine || 'system') === 'ai' ? 'ai' : 'system', [{v:'system',t:'系统自带'},{v:'ai',t:'自建音色'}])}</div>
<div class="mini-note">系统自带：使用手机内置语音引擎，无需联网。自建音色：使用下方接口，可选择音色。</div>

<div id="tts-ai-box" ${(CONFIG.ttsEngine || 'system') === 'ai' ? '' : 'hidden'}>
  <div class="sg"><label>接口地址</label><input id="set-tts-base" type="text" placeholder="https://api.openai.com/v1" value="${esc(CONFIG.ttsBaseUrl || '')}"></div>
  <div class="sg"><label>API Key</label><input id="set-tts-key" type="password" placeholder="sk-..." value="${esc(CONFIG.ttsApiKey || '')}"></div>
  <div class="sg"><label>模型</label><input id="set-tts-model" type="text" placeholder="tts-1 / gpt-4o-mini-tts" value="${esc(CONFIG.ttsModel || '')}"></div>
  <div class="sg"><label>音色</label>
    <select id="set-tts-voice">
      ${(TTS_VOICES.some(v => v.id === CONFIG.ttsVoice) ? TTS_VOICES : TTS_VOICES.concat([{ id: CONFIG.ttsVoice, name: CONFIG.ttsVoice + '（当前）' }]))
        .filter(v => v.id)
        .map(v => `<option value="${esc(v.id)}"${v.id === CONFIG.ttsVoice ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
    </select>
  </div>
  <div class="acts"><button id="btn-refresh-voice" class="btn-s">🔄 从接口拉取可用音色</button></div>
  <div class="mini-note" id="tts-voice-hint"></div>
</div>

<div class="sg"><label>语速</label>
  <div class="range-row">
    <input type="range" id="set-tts-rate" min="0.5" max="2" step="0.1" value="${CONFIG.ttsRate}">
    <span id="tts-rate-l">${CONFIG.ttsRate}x</span>
  </div></div>

<div class="sec-title">音乐功能</div>
<div class="sg" style="margin-top:8px"><label>开启音乐</label>${toggleGroup('music', CONFIG.musicEnabled ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>音质</label>${chipGroup('quality', CONFIG.musicQuality, [{v:'128',t:'128k'},{v:'192',t:'192k'},{v:'320',t:'320k'}])}</div>
<div class="sg"><label>音乐来源目录</label><input id="set-music-catalogs" value="${esc(CONFIG.musicCatalogs || DC.musicCatalogs)}" placeholder="netease,tencent,kugou,kuwo"></div>
<div class="mini-note">多个目录用逗号分隔。不可用来源会自动跳过，搜索结果会合并去重。</div>
<div class="sg"><label>自动缓存播放歌曲</label>${toggleGroup('musicAutoCache', CONFIG.musicAutoCache ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>保存播放历史</label>${toggleGroup('musicHistory', CONFIG.musicHistoryLimit === 0 ? 'false' : 'true', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>历史记录上限</label><input id="set-music-history-limit" type="number" min="20" max="500" value="${Math.max(20, Math.min(500, parseInt(CONFIG.musicHistoryLimit, 10) || 100))}"></div>
<div class="sg"><label>结果显示来源</label>${toggleGroup('musicSource', CONFIG.musicShowSource !== false ? 'true' : 'false', [{v:'true',t:'显示'},{v:'false',t:'隐藏'}])}</div>
<div class="mini-note">音乐页面会跟随上方“个性化与聊天风格”中的主题色；来源、历史和缓存信息只在音乐页面显示。</div>
<div class="sg"><label>GD Studio 接口</label>
  <input id="set-gd-api" value="${esc(CONFIG.gdStudioApi || DC.gdStudioApi || '')}" placeholder="https://.../api.php"></div>
<div class="sg"><label>自动整理长期记忆</label>${toggleGroup('memAutoSum', MEMCFG.autoSummary !== false ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>每多少条消息整理一次</label><input id="set-mem-every" type="number" min="10" max="500" value="${Math.max(10, Math.min(500, parseInt(MEMCFG.summaryEvery, 10) || 50))}"></div>
<div class="mini-note">到数量后会自动把这段对话里值得记住的内容整理进记忆库；也可以在聊天“更多 → 总结记忆”里手动触发。</div>
<div class="sg"><label>Meting 实例（每行一个）</label>
  <textarea id="set-meting" style="min-height:90px;font-family:monospace;font-size:11px">${esc(CONFIG.metingInstances)}</textarea></div>

<div class="sec-title">长期记忆</div>
<div class="mini-note" style="margin-top:8px">长期记忆保存在本机。每轮只加载概览与摘要，需要细节时由 AI 按需检索，因此记忆再多也不会拖慢对话。</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-mem-open" class="btn-p">打开记忆库（${MEM.length} 条）</button>
</div>
<div class="sg" style="margin-top:10px"><label>语义检索（可选，需要向量模型）</label>${toggleGroup('memvec', MEMCFG.vecEnabled ? 'true' : 'false', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="mini-note">关闭时按关键词检索；开启语义检索后结果更准确，但每存一条记忆会额外调用一次向量接口。</div>
<div class="sg"><label>向量 API 地址</label><input id="set-vec-base" value="${esc(MEMCFG.vecBase || '')}" placeholder="https://.../v1"></div>
<div class="sg"><label>向量 API Key</label>
  <div class="pin-row">
    <input id="set-vec-key" class="secret" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(MEMCFG.vecKey || '')}">
    <button type="button" id="btn-paste-vkey2" class="btn-paste">粘贴</button>
  </div></div>
<div class="sg"><label>向量模型</label><input id="set-vec-model" value="${esc(MEMCFG.vecModel || '')}" placeholder="如 text-embedding-3-small / bge-m3"></div>

<div class="sec-title">屏幕翻译</div>
<div class="mini-note" style="margin-top:8px">点「翻译屏幕」后，浮窗会先收成小胶囊以免遮挡，读取屏幕文字后再翻译。文字与位置直接来自无障碍节点，无需额外 OCR。</div>
<div class="sg" style="margin-top:8px"><label>翻译引擎</label>${toggleGroup('transEngine', CONFIG.transEngine || 'free', [{v:'free',t:'微软免费'},{v:'ai',t:'AI（耗Token）'}])}</div>
<div class="sg"><label>翻译方式</label>${toggleGroup('transMode', CONFIG.transMode || 'translated', [{v:'translated',t:'仅译文'},{v:'bilingual',t:'双语'}])}</div>
<div class="mini-note">仅译文：用主题色覆盖原文。双语：保留原文并添加下划线，译文附在下方。</div>
<div class="sg"><label>点完自动收成小胶囊</label>${toggleGroup('transCap', CONFIG.transAutoCapsule === false ? 'false' : 'true', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="sg"><label>跳过已经是中文的段落</label>${toggleGroup('transSkip', CONFIG.transSkipChinese === false ? 'false' : 'true', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>


<div class="sec-title">插件与工具</div>
<div class="mini-note" style="margin-top:8px">在这里管理 AI 可以使用的工具，并单独控制每一项是否对它开放。也支持安装自定义插件。</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-plug-page" class="btn-p">打开插件与工具</button>
</div>

<div class="sec-title">检查更新</div>
<div class="mini-note" style="margin-top:8px">从 GitHub Releases 检测新版本，并下载安装包。</div>
<div class="sg" style="margin-top:8px"><label>自动检查更新</label>${toggleGroup('autoupd', CONFIG.autoCheckUpdate === false ? 'false' : 'true', [{v:'true',t:'开启'},{v:'false',t:'关闭'}])}</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-check-update" class="btn-p">立即检查更新</button>
  <button id="btn-open-releases" class="btn-s">打开发布页</button>
</div>

<div class="sec-title">权限</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-perm-guide" class="btn-s">打开权限配置引导</button>
</div>
<div class="mini-note">可随时重新打开引导，补充悬浮窗、通知、无障碍等权限。</div>

<div class="sec-title">环境信息</div>
<div class="mini-note" style="margin-top:6px">遇到问题时，可将以下信息提供给开发者以便排查。</div>
<div id="env-box" style="margin-top:8px"></div>
<div class="acts">
  <button id="btn-copy-env" class="btn-s">复制环境信息</button>
</div>

<div class="sec-title">数据管理</div>
<div class="acts" style="margin-top:8px">
  <button id="btn-export" class="btn-s">导出</button>
  <button id="btn-import" class="btn-s">导入</button>
  <button id="btn-copy-backup" class="btn-s">复制</button>
</div>
<div class="sg" style="margin-top:8px">
  <textarea id="backup-code" placeholder="粘贴备份代码或点击导出" style="font-family:monospace;font-size:11px;min-height:70px"></textarea>
</div>
<div class="acts">
  <button id="btn-clear-all" class="btn-s" style="color:#d6336c;border-color:rgba(214,51,108,.35)">清除全部数据</button>
</div>

<div id="settings-save-block" class="acts settings-bottom" data-action="save-settings">
  <button id="set-back" type="button" class="settings-return" data-action="settings-back">← 返回对话</button>
  <button id="set-save" type="button" class="settings-inline-save" data-action="save-settings">保存设置</button>
</div>
<div id="settings-bottom-spacer" style="height:26px"></div>`;

  organizeSettingsSections();
  $('#settings').onclick = (e) => {
    const actionEl = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (actionEl && actionEl.dataset.action === 'save-settings') {
      e.preventDefault(); e.stopPropagation(); saveSettings(); return false;
    }
    if (actionEl && actionEl.dataset.action === 'settings-back') { showView('chat'); return false; }
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.id === 'btn-provider-add') { providerOpenForm(''); return; }
    if (b.id === 'btn-provider-save') { providerSaveForm(); return; }
    if (b.id === 'btn-provider-cancel') { providerCloseForm(); return; }
    if (b.id === 'btn-paste-prov-key') { pasteIntoInput($('#prov-key')); return; }
    const pa = b.closest('[data-provider-action]');
    if (pa) {
      const pid = pa.dataset.providerId || '';
      const act = pa.dataset.providerAction;
      if (act === 'test') { providerRunTest(pid); return; }
      if (act === 'edit') { providerOpenForm(pid); return; }
      if (act === 'remove') {
        uiConfirm('删除 Provider 会同时移除它的绑定与本地保存的 Key，确定吗？', '删除').then(ok => {
          if (!ok) return;
          providerRemove(CONFIG, pid);
          providerEnsure(CONFIG, MEMCFG);
          sSet('via_ai_config', CONFIG);
          renderProviderCenter();
          toast('已删除 Provider');
        });
        return;
      }
    }
    if (b.id === 'btn-plug-page') { showView('plugins'); return; }
    if (b.id === 'btn-chat-mode') { taskSetCurrent(taskEnsureChat().id); return; }
    if (b.id === 'btn-detect-models') { detectModels().catch(e => toast('检测失败：' + errMsg(e))); return; }
    if (b.dataset && b.dataset.idx !== undefined && b.classList && b.classList.contains('model-chip')) {
      const id = MODEL_DETECT_IDS[parseInt(b.dataset.idx, 10)];
      const mi = $('#set-model'); if (mi && id) mi.value = id;
      if (id) toast('已填入 ' + id + '，记得保存~');
      return;
    }
    if (b.id === 'btn-new-quick') { toast('快捷任务可从主界面按钮直接发起~'); return; }
    const grp = b.closest('[data-group]');
    if (!grp) return;
    if (b.classList.contains('swatch')) {
      Array.from(grp.querySelectorAll('.swatch')).forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      const inp = $('#set-' + grp.dataset.group); if (inp) inp.value = b.dataset.val;
      return;
    }
    if (AGENT_FLAG_KEYS[grp.dataset.group]) {
      handleAgentFlagClick(grp, b);
      return;
    }
    if (b.dataset.val === undefined) return;
    Array.from(grp.children).forEach(x => { if (x.tagName === 'BUTTON') x.classList.remove('on'); });
    b.classList.add('on');
    if (grp.dataset.group === 'preset' && b.dataset.val !== 'custom') {
      const p = PRESETS[b.dataset.val];
      if (p) { $('#set-apibase').value = p.base; $('#set-model').value = p.model; }
    }
    // 切到「自建音色」才展开那一段配置，免得设置页平白多五行
    if (grp.dataset.group === 'ttseng') {
      const box = $('#tts-ai-box');
      if (box) box.hidden = b.dataset.val !== 'ai';
    }
  };
  const rateIn = $('#set-tts-rate');
  rateIn.oninput = () => { $('#tts-rate-l').textContent = rateIn.value + 'x'; };
  const rv = $('#btn-refresh-voice');
  if (rv) rv.onclick = () => {
    // 先把当前填的值写回去，拉音色要用到刚填的地址和 Key
    CONFIG.ttsBaseUrl = $('#set-tts-base').value.trim();
    CONFIG.ttsApiKey = $('#set-tts-key').value.trim();
    refreshVoices();
  };
  const saveHandler = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } saveSettings(); return false; };
  const inlineSaveBtn = $('#set-save');
  if (inlineSaveBtn) {
    inlineSaveBtn.type = 'button';
    inlineSaveBtn.onclick = saveHandler;
    inlineSaveBtn.ontouchend = saveHandler;
    inlineSaveBtn.onpointerup = saveHandler;
    inlineSaveBtn.style.pointerEvents = 'auto';
    inlineSaveBtn.style.touchAction = 'manipulation';
  }
  const backBtn = $('#set-back'); if (backBtn) backBtn.onclick = () => showView('chat');
  const agentA11y = $('#btn-agent-a11y');
  if (agentA11y) agentA11y.onclick = () => {
    if (HAS_PERM && Perm.requestAccessibility) Perm.requestAccessibility();
  };
  const agentIme = $('#btn-agent-ime');
  if (agentIme) agentIme.onclick = () => {
    if (HAS_PERM && Perm.requestElysiaImeSettings) Perm.requestElysiaImeSettings();
  };
  $('#btn-pick-avatar').onclick = startPickAvatar;
  const pk = $('#btn-paste-key');
  if (pk) pk.onclick = () => pasteIntoInput($('#set-apikey'));
  const pvk = $('#btn-paste-vkey');
  if (pvk) pvk.onclick = () => pasteIntoInput($('#set-vision-key'));
  const pvk2 = $('#btn-paste-vkey2');
  if (pvk2) pvk2.onclick = () => pasteIntoInput($('#set-vec-key'));
  const mo = $('#btn-mem-open');
  if (mo) mo.onclick = () => showView('memory');
  $('#btn-export').onclick = exportData;
  $('#btn-import').onclick = importData;
  $('#btn-copy-backup').onclick = () => {
    const v = $('#backup-code').value.trim();
    if (!v) return toast('还没有备份码，先点导出吧~');
    toast(writeClipboard(v) ? '已复制到剪贴板' : '复制失败，请长按文本框手动复制');
  };
  $('#btn-clear-all').onclick = clearAll;
  const pgBtn = $('#btn-perm-guide');
  if (pgBtn) pgBtn.onclick = () => { showGuide(); };
  const chkBtn = $('#btn-check-update');
  if (chkBtn) chkBtn.onclick = () => checkUpdate(true);
  const relBtn = $('#btn-open-releases');
  if (relBtn) relBtn.onclick = () => {
    try { if (HAS_NATIVE && Android.openUrl) Android.openUrl(UPDATE_RELEASES); } catch (e) {}
  };

  $('#settings').onchange = (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.bindPurpose) return;
    const purpose = el.dataset.bindPurpose;
    const id = String(el.value || '');
    if (!CONFIG.bindings || typeof CONFIG.bindings !== 'object') CONFIG.bindings = {};
    if (!id) {
      delete CONFIG.bindings[purpose];
      providerEnsure(CONFIG, MEMCFG);
    } else if (!providerBind(CONFIG, purpose, id)) {
      toast('绑定失败：Provider 不支持该能力');
      return;
    }
    providerApply(CONFIG, purpose);
    sSet('via_ai_config', CONFIG);
    renderProviderCenter();
    toast(id ? '已绑定「' + (PROVIDER_PURPOSE_LABEL[purpose] || purpose) + '」用途' : '已改回自动选择');
  };
  bindAgentWhitelist();
  bindWorkspace();
  bindRuntime();
  renderProviderCenter();
  renderEnvBox();
  const ceBtn = $('#btn-copy-env');
  if (ceBtn) ceBtn.onclick = () => {
    const e = loadEnv();
    const r = readRect();
    const lines = e ? [
      'App ' + e.appVer,
      'Android API ' + e.sdk + ' (' + e.release + ')',
      'Device ' + e.brand + ' ' + e.model,
      'WebView ' + e.webviewVer + ' [' + e.webviewPkg + ']',
      'Screen ' + e.screenW + 'x' + e.screenH + ' @' + e.densityDpi + 'dpi dpr=' + e.density,
      'Compat ' + (document.documentElement.className || 'none'),
      'Window ' + (r && r.w ? (r.w + 'x' + r.h + ' @' + r.x + ',' + r.y) : '-'),
      'Base ' + (BASE ? (Math.round(BASE.w) + 'x' + Math.round(BASE.h)) : '-') +
        ' zoom=' + (ZOOM ? ZOOM.toFixed(3) : '-')
    ] : ['env unavailable'];
    toast(writeClipboard(lines.join('\n')) ? '环境信息已复制' : '复制失败，请长按文本手动选');
  };
}

function saveSettings() {
  // 任何设置项缺失都不应该让整次保存静默失败：统一走 val() 读取，异常照样提示出来。
  const val = (sel, d) => {
    try { const el = $(sel); return el && el.value != null ? String(el.value) : (d === undefined ? '' : String(d)); }
    catch (e) { return d === undefined ? '' : String(d); }
  };
  try {
    return doSaveSettings(val);
  } catch (e) {
    console.error('[saveSettings]', e);
    toast('保存失败：' + ((e && e.message) || e));
    return false;
  }
}
function doSaveSettings(val) {
  const avIn = val('#set-avatar').trim();
  Object.assign(CONFIG, {
    apiBase: val('#set-apibase').trim(),
    apiKey: val('#set-apikey').trim(),
    model: val('#set-model').trim(),
    assistantName: val('#set-name').trim() || DC.assistantName,
    maxContextTurns: parseInt(val('#set-turns'), 10) || 35,
    ttsEnabled: groupVal('tts') === 'true',
    ttsRate: parseFloat(val('#set-tts-rate')) || 1,
    ttsEngine: groupVal('ttseng') === 'ai' ? 'ai' : 'system',
    ttsBaseUrl: val('#set-tts-base').trim(),
    ttsApiKey: val('#set-tts-key').trim(),
    ttsModel: val('#set-tts-model').trim(),
    ttsVoice: val('#set-tts-voice'),
    musicEnabled: groupVal('music') === 'true',
    musicQuality: groupVal('quality') || '320',
    musicCatalogs: String(val('#set-music-catalogs') || DC.musicCatalogs).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).join(',') || DC.musicCatalogs,
    musicAutoCache: groupVal('musicAutoCache') === 'true',
    // 记忆自动整理
    _memAutoSummary: groupVal('memAutoSum') !== 'false',
    _memSummaryEvery: Math.max(10, Math.min(500, parseInt(val('#set-mem-every'), 10) || 50)),
    musicHistoryLimit: groupVal('musicHistory') === 'false' ? 0 : Math.max(20, Math.min(500, parseInt(val('#set-music-history-limit'), 10) || 100)),
    musicShowSource: groupVal('musicSource') !== 'false',
    avatarFit: groupVal('fit') || 'top',
    visionBase: val('#set-vision-base').trim(),
    visionKey: val('#set-vision-key').trim(),
    visionModel: val('#set-vision-model').trim(),
    gdStudioApi: val('#set-gd-api').trim() || DC.gdStudioApi,
    metingInstances: val('#set-meting').trim() || DC.metingInstances,
    themeColor1: val('#set-c1') || DC.themeColor1,
    themeColor2: val('#set-c2') || DC.themeColor2,
    transEngine: groupVal('transEngine') || DC.transEngine,
    transMode: groupVal('transMode') || DC.transMode,
    transAutoCapsule: groupVal('transCap') !== 'false',
    transSkipChinese: groupVal('transSkip') !== 'false',
    autoCheckUpdate: groupVal('autoupd') !== 'false',
    agentEnabled: groupVal('agentEnabled') === 'true',
    agentL1: groupVal('agentL1') !== 'false',
    agentL2: groupVal('agentL2') !== 'false',
    agentL3: groupVal('agentL3') === 'true',
    agentSafety: groupVal('agentSafety') === 'true',
    agentAutoShot: groupVal('agentAutoShot') === 'true',
    agentOnDemand: groupVal('agentOnDemand') !== 'false',
    agentToolRounds: Math.max(0, parseInt(groupVal('agentToolRounds'), 10) || 0),
    agentTaskTimeout: Math.max(15000, Math.min(7200000, (parseInt(val('#set-agent-timeout'), 10) || 1200) * 1000)),
    modelTimeoutMs: Math.max(60000, Math.min(1800000, (parseInt(val('#set-model-timeout'), 10) || 600) * 1000)),
    deviceMaxActions: Math.max(20, Math.min(2000, parseInt(val('#set-device-max-actions'), 10) || 120)),
    deviceActionResumeChunk: Math.max(20, Math.min(2000, parseInt(val('#set-device-resume-chunk'), 10) || 120)),
    workPrompt: val('#set-work-prompt').trim() || DC.workPrompt,
    // 人设只管普通聊天；工作提示词和工具说明由各自分层组装
    persona: val('#set-persona').trim() || DC.persona
  });
  if (avIn && avIn !== AV_LOCAL) CONFIG.avatarUrl = avIn;
  if (!CONFIG.avatarUrl) CONFIG.avatarUrl = DC.avatarUrl;
  if (CONFIG.avatarUrl.indexOf('data:') === 0) { const avEl = $('#set-avatar'); if (avEl) avEl.value = AV_LOCAL; }
  syncAgentFlagsToNative();
  toolsBroken = false;
  $('#btn-music').hidden = !CONFIG.musicEnabled;
  if (!CONFIG.musicEnabled) {
    if (MP()) { try { MP().mpStop(); } catch (e) {} }
    else if (M.audio) M.audio.pause();
    M.isPlaying = false; M.miniHidden = true; updateBar(); updateMini();
  }

  // 人设/插件可能变了，重拼一遍 system 消息（否则对话里还是旧的那份）
  refreshSystemPrompt();
  sSet('via_ai_config', CONFIG);
  saveHistory();
  renderPlugins();

  // 记忆库配置单独存（向量 + 自动整理）
  MEMCFG.autoSummary = CONFIG._memAutoSummary !== false;
  MEMCFG.summaryEvery = Math.max(10, Math.min(500, parseInt(CONFIG._memSummaryEvery, 10) || 50));
  delete CONFIG._memAutoSummary;
  delete CONFIG._memSummaryEvery;
  const vEn = groupVal('memvec');
  if (vEn !== null && vEn !== undefined) MEMCFG.vecEnabled = vEn === 'true';
  if ($('#set-vec-base')) MEMCFG.vecBase = val('#set-vec-base').trim();
  if ($('#set-vec-key')) MEMCFG.vecKey = val('#set-vec-key').trim();
  if ($('#set-vec-model')) MEMCFG.vecModel = val('#set-vec-model').trim();
  memSaveCfg();

  // E2-001~003：旧字段 → Provider 同步，Key 先进密钥仓，再回填绑定并持久化。
  providerSyncLegacy(CONFIG, MEMCFG);
  secretPersist(CONFIG, SECRET_FIELDS_CFG, 'ai');
  secretPersist(MEMCFG, SECRET_FIELDS_MEM, 'mem');
  providerEnsure(CONFIG, MEMCFG);
  const embedUse = providerResolve(CONFIG, 'embedding');
  if (embedUse) {
    MEMCFG.vecBase = embedUse.base;
    MEMCFG.vecModel = embedUse.model;
    if (secretStore.ok) MEMCFG.vecKey = embedUse.key;
  }
  sSet('via_ai_config', CONFIG);

  applyTheme();
  renderHistory();
  toast('已保存~');
  vibrate(20);
}
/**
 * 检测当前 API 地址 + Key 能用哪些模型。
 * 走统一 RequestManager（超时/重试/错误码一致），只读 /models，不会产生调用费用。
 */
let MODEL_DETECT_IDS = [];
async function detectModels() {
  const box = $('#model-detect-list'), note = $('#model-detect-note');
  const base = String(($('#set-apibase') && $('#set-apibase').value) || CONFIG.apiBase || '').trim().replace(/\/+$/, '');
  const key = String(($('#set-apikey') && $('#set-apikey').value) || CONFIG.apiKey || '').trim();
  if (!base) return toast('先填 API 地址');
  if (!key) return toast('先填 API Key');
  if (box) { box.hidden = false; box.innerHTML = '<div class="model-detect-loading">正在检测可用模型…</div>'; }
  if (note) { note.hidden = true; note.textContent = ''; }

  const tries = base.endsWith('/models') ? [base]
    : (base.indexOf('/v1') >= 0 ? [base + '/models'] : [base + '/models', base + '/v1/models']);
  let lastErr = null, ids = [];
  for (const url of tries) {
    try {
      const r = await reqRequest({
        method: 'GET', url: url,
        headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' },
        timeoutMs: 20000, expect: 'json', retries: 1, source: 'system:models'
      });
      const d = r.json || {};
      const list = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []);
      ids = list.map(x => (x && (x.id || x.name)) || '').filter(Boolean);
      if (ids.length) break;
    } catch (e) { lastErr = e; }
  }
  if (!ids.length) {
    if (box) box.innerHTML = '';
    if (note) { note.hidden = false; note.textContent = '检测失败：' + (lastErr ? errMsg(lastErr) : '接口没有返回模型列表'); }
    return;
  }
  ids.sort();
  MODEL_DETECT_IDS = ids.slice(0, 200);
  const cur = String(($('#set-model') && $('#set-model').value) || CONFIG.model || '');
  if (box) {
    // 用 DOM 节点构建，避免模型 id 里的特殊字符破坏 HTML 或转义失效
    box.innerHTML = '';
    MODEL_DETECT_IDS.forEach((id, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-chip';
      if (id === cur) b.classList.add('active');   // 用 classList 与 className 保持一致
      b.dataset.idx = String(i);
      b.textContent = id;
      box.appendChild(b);
    });
  }
  if (note) { note.hidden = false; note.textContent = '共 ' + ids.length + ' 个可用模型，点一个填入；填好记得保存。'; }
}

function exportData() {
  try {
    const c = Object.assign({}, CONFIG);
    // 导出一律不含 Key：即使密钥仓不可用也不外泄
    SECRET_FIELDS_CFG.forEach(k => { delete c[k]; });
    if (c.avatarUrl && c.avatarUrl.indexOf('data:') === 0) c.avatarUrl = '';
    const payload = { config: c, history, transCache, favorites, v: 1 };
    const code = b64e(JSON.stringify(payload));
    $('#backup-code').value = code;
    const ok = writeClipboard(code);
    toast(ok ? '已导出（不含 Key 与本地头像），已复制到剪贴板' : '已导出（不含 Key 与本地头像）');
  } catch (e) { toast('导出失败：' + errMsg(e)); }
}
function importData() {
  const raw = $('#backup-code').value.trim();
  if (!raw) return toast('请先粘贴备份代码');
  let d = null;
  try { d = JSON.parse(raw); }
  catch (e) {
    try { d = JSON.parse(b64d(raw)); }
    catch (e2) { return toast('导入失败：代码格式无效'); }
  }
  if (!d || typeof d !== 'object') return toast('导入失败：内容不是有效对象');
  try {
    if (d.config && typeof d.config === 'object') {
      const safe = {};
      for (const k in DC) if (k in d.config && typeof d.config[k] === typeof DC[k]) safe[k] = d.config[k];
      CONFIG = Object.assign(CONFIG, safe);
      if (!CONFIG.avatarUrl) CONFIG.avatarUrl = DC.avatarUrl;
      // 导入的是 WebView 配置，Agent 的最终门禁在原生 elly_agent 中；这里立即同步，
      // 不等用户再次打开设置或重启后才生效。
      syncAgentFlagsToNative();
      refreshSystemPrompt(false);
      sSet('via_ai_config', CONFIG);
    }
    if (Array.isArray(d.history)) {
      history = d.history.filter(m => m && typeof m === 'object'
        && typeof m.role === 'string' && typeof m.content === 'string');
      if (!history.length) history = [{ role: 'system', content: CONFIG.systemPrompt }];
      const target = currentTask();
      taskSaveContext(target);
      if (target.type === 'chat') sSet('via_ai_history', history);
    }
    if (d.transCache && typeof d.transCache === 'object' && !Array.isArray(d.transCache)) {
      const clean = {};
      for (const k in d.transCache) if (typeof d.transCache[k] === 'string') clean[k] = d.transCache[k];
      transCache = clean; sSet('via_ai_trans', transCache);
    }
    if (Array.isArray(d.favorites)) {
      favorites = d.favorites.filter(f => f && typeof f === 'object' && f.id && f.name);
      sSet('via_ai_favs', favorites);
    }
    toast('导入成功，正在重载…');
    setTimeout(() => location.reload(), 600);
  } catch (e) { toast('导入失败：' + errMsg(e)); }
}
async function clearAll() {
  if (!(await uiConfirm('将清空对话、记忆、收藏和所有设置，确定吗？', '清空'))) return;
  try { if (HAS_NATIVE && Android.clearAll) Android.clearAll(); } catch (e) {}
  try { localStorage.clear(); } catch (e) {}
  toast('已清除，正在重载…');
  setTimeout(() => location.reload(), 600);
}

