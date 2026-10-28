/* ==========================================================
 *  设置页
 * ========================================================== */
function toggleGroup(id, value, opts) {
  return `<div class="tgl" data-group="${id}">` + opts.map(o =>
    `<button type="button" data-val="${esc(o.v)}" class="${String(o.v) === String(value) ? 'on' : ''}">${esc(o.t)}</button>`
  ).join('') + `</div>`;
}
function chipGroup(id, value, opts) {
  return `<div class="chips" data-group="${id}">` + opts.map(o =>
    `<button type="button" data-val="${esc(o.v)}" class="${String(o.v) === String(value) ? 'on' : ''}">${esc(o.t)}</button>`
  ).join('') + `</div>`;
}
function swatchGroup(id, value) {
  const colors = ['#ff9a9e','#fecfef','#d6336c','#f6b8d0','#c084fc','#818cf8',
    '#60a5fa','#34d399','#fbbf24','#fb7185','#a78bfa','#f472b6'];
  const list = colors.slice();
  if (value && list.indexOf(value) < 0) list.unshift(value);
  return `<div class="swatches" data-group="${id}">` + list.map(c =>
    `<button type="button" class="swatch ${String(c).toLowerCase() === String(value).toLowerCase() ? 'on' : ''}" data-val="${esc(c)}" style="background:${esc(c)}"></button>`
  ).join('') + `<input class="hexin" id="set-${id}" value="${esc(value || '')}"></div>`;
}
function presetKey() {
  const ks = Object.keys(PRESETS);
  for (let i = 0; i < ks.length; i++) {
    if (PRESETS[ks[i]].base && PRESETS[ks[i]].base === CONFIG.apiBase) return ks[i];
  }
  return 'custom';
}
function groupVal(id) {
  const el = document.querySelector('#settings [data-group="' + id + '"] .on');
  return el ? el.dataset.val : '';
}
const AGENT_FLAG_KEYS = {
  agentEnabled: 'agentEnabled', agentL1: 'agentL1', agentL2: 'agentL2',
  agentL3: 'agentL3', agentSafety: 'agentSafety', agentAutoShot: 'agentAutoShot',
  agentOnDemand: 'agentOnDemand'
};
function syncAgentFlagsToNative() {
  if (!(HAS_PERM && Perm.setAgentFlag)) return;
  Object.keys(AGENT_FLAG_KEYS).forEach(key => {
    try { Perm.setAgentFlag(AGENT_FLAG_KEYS[key], CONFIG[key] === true); } catch (e) {}
  });
}
function persistAgentFlag(key, value) {
  CONFIG[key] = !!value;
  if (HAS_PERM && Perm.setAgentFlag) {
    try { Perm.setAgentFlag(AGENT_FLAG_KEYS[key] || key, !!value); } catch (e) {}
  }
  refreshSystemPrompt();
  sSet('via_ai_config', CONFIG);
}
async function enableAgentL3() {
  for (let n = 5; n > 0; n--) {
    toast('L3 将在 ' + n + ' 秒后进入确认…');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return await uiConfirm('警告：L3 将允许 Agent 操作白名单应用，包括点击、滑动、输入和系统按键。请确认你理解并承担误操作风险。\n\n免责声明：Agent 可能因页面变化、识别错误或应用限制产生错误行为。', '确认开启 L3', '操作手机');
}
async function enableAgentSafety() {
  return await uiConfirm('警告：安全开关会开放产品中原本被隐藏或限制的高风险能力。请确认你理解隐私泄露、误操作、网络访问和数据损失风险。\n\n免责声明：开启后请自行承担使用风险，Android 系统和目标应用的安全限制仍然有效。', '确认开启', '安全开关');
}
async function handleAgentFlagClick(group, button) {
  const key = group && group.dataset ? group.dataset.group : '';
  if (!AGENT_FLAG_KEYS[key]) return false;
  const value = button.dataset.val === 'true';
  if (key === 'agentL3' && value && CONFIG.agentL3 !== true) {
    if (!await enableAgentL3()) return true;
  }
  if (key === 'agentSafety' && value && CONFIG.agentSafety !== true) {
    if (!await enableAgentSafety()) return true;
  }
  Array.from(group.children).forEach(x => { if (x.tagName === 'BUTTON') x.classList.remove('on'); });
  button.classList.add('on');
  persistAgentFlag(key, value);
  toast(value ? '已开启' : '已关闭');
  vibrate(15);
  return true;
}

/**
 * 插件与工具页。开关直接读 CONFIG.plugins / CONFIG.toolOff，
 * 跟 toolLive() / buildToolsPrompt() 共用一份状态，切换后提示词和可调工具同时生效。
 */
function plugPermissionSummary(p) {
  const perms = Array.isArray(p.permissions) ? p.permissions : [];
  if (!perms.length) return '无额外危险能力';
  return perms.map(x => {
    const i = PLUG_PERMISSION_INFO[x];
    return i ? i.label + '（' + i.risk + '）' : x;
  }).join('、');
}
function plugPermissionsHTML(p) {
  const perms = Array.isArray(p.permissions) ? p.permissions : [];
  const granted = Array.isArray(p.grantedPermissions) ? p.grantedPermissions : [];
  return '<div class="plug-group-desc">声明能力：' + esc(plugPermissionSummary(p)) +
    (perms.length ? '<br>用户授权：' + esc(granted.map(x => PLUG_PERMISSION_INFO[x] ? PLUG_PERMISSION_INFO[x].label : x).join('、') || '尚未授权') : '') + '</div>';
}
function renderPlugins() {
  const box = $('#plug-list');
  if (!box) return;
  let html = PLUGINS.map(p => {
    const on = plugOn(p.id);
    const live = groupLive(p.id);
    // 开关开着但外部条件不足（比如无障碍未授权）时，说明为什么暂时无法调用
    let warn = '';
    if (on && !live) {
      if (p.id === 'screen') warn = '⚠️ 无障碍权限未开启，这组工具暂时无法调用。';
      else if (p.id === 'music') warn = '⚠️ 音乐总开关未开启，音乐工具不会提供给 AI。';
      else if (p.id === 'files') warn = '⚠️ 文件访问权限未开启，文件工具暂时无法调用。';
      else if (p.id === 'agent') warn = '⚠️ Agent/L1 未开启，手机工具暂时无法调用。';
    }
    const rows = p.tools.map(t => {
      const ton = on && toolOn(t);
      return `<div class="plug-tool ${ton ? '' : 'off'}">
        <div class="plug-tool-body">
          <div class="plug-tool-name">${esc(t)}</div>
          <div class="plug-tool-desc">${esc(TOOL_DOC[t] || '')}</div>
        </div>
        <button type="button" class="plug-sw ${ton ? 'on' : ''}" data-tool-sw="${esc(t)}"
          aria-label="${ton ? '关闭' : '开启'}${esc(t)}"></button>
      </div>`;
    }).join('');
    return `<div class="plug-group">
      <div class="plug-group-hd">
        <span class="plug-group-ic">${p.icon}</span>
        <span class="plug-group-name">${esc(p.name)}</span>
        <button type="button" class="plug-sw ${on ? 'on' : ''}" data-plug-sw="${p.id}"
          aria-label="${on ? '关闭' : '开启'}${esc(p.name)}"></button>
      </div>
      <div class="plug-group-desc">${esc(p.desc)}</div>
      ${warn ? '<div class="plug-warn">' + esc(warn) + '</div>' : ''}
      ${rows}
    </div>`;
  }).join('');

  html += plugCustomHtml();
  // E3-002：插件自己在清单里声明的页面/入口/命令/任务，宿主不写死类型。
  html += plugRuntimeEntriesHtml();
  box.innerHTML = html;
}

/** 自定义插件区块：已安装的插件 + 空状态提示。 */
function plugCustomHtml() {
  let html = '<div class="sec-title" style="margin-top:16px">🧩 自定义插件</div>';
  if (!USER_PLUGINS.length) {
    return html + '<div class="mini-note" style="margin-top:6px">还没有安装自定义插件。点上方「导入插件」，粘贴插件清单即可安装。</div>';
  }
  html += '<div class="mini-note" style="margin-top:6px">自定义插件在隔离沙箱中运行，无法直接访问系统；JS 可直接访问公网，本机能力仍经过安全策略。</div>';
  html += USER_PLUGINS.map(p => {
    const on = p.enabled !== false;
    const rows = p.tools.map(t => {
      const ton = on && toolOn(t.name);
      return `<div class="plug-tool ${ton ? '' : 'off'}">
        <div class="plug-tool-body">
          <div class="plug-tool-name">${esc(t.name)}</div>
          <div class="plug-tool-desc">${esc(t.description || '')}${t.permissions && t.permissions.length ? '<br>工具能力：' + esc(t.permissions.map(x => PLUG_PERMISSION_INFO[x] ? PLUG_PERMISSION_INFO[x].label : x).join('、')) : ''}</div>
        </div>
        <button type="button" class="plug-sw ${ton ? 'on' : ''}" data-tool-sw="${esc(t.name)}"
          aria-label="${ton ? '关闭' : '开启'}${esc(t.name)}"></button>
      </div>`;
    }).join('');
    return `<div class="plug-group">
      <div class="plug-group-hd">
        <span class="plug-group-ic">${esc(p.icon)}</span>
        <span class="plug-group-name">${esc(p.name)}
          <span class="plug-sub">v${esc(p.version)}${p.author ? ' · ' + esc(p.author) : ''}</span></span>
        <button type="button" class="plug-mini" data-plug-del="${esc(p.id)}">删除</button>
        <button type="button" class="plug-sw ${on ? 'on' : ''}" data-cplug-sw="${esc(p.id)}"
          aria-label="${on ? '关闭' : '开启'}${esc(p.name)}"></button>
      </div>
      ${p.desc ? '<div class="plug-group-desc">' + esc(p.desc) + '</div>' : ''}
      <div class="plug-market-meta"><b>类型：</b>${esc(({chat:'聊天插件',quick:'快捷任务插件',device:'手机插件',workspace:'工作插件'}[p.pluginType] || '聊天插件'))}</div>
      ${plugPermissionsHTML(p)}
      ${rows}
    </div>`;
  }).join('');
  return html;
}

async function toggleUserPlug(id) {
  const p = USER_PLUGINS.filter(x => x.id === id)[0];
  if (!p) return;
  const next = p.enabled === false;
  if (next && p.permissions && p.permissions.length) {
    const text = '插件「' + p.name + '」请求以下能力：\n\n' + p.permissions.map(x => '- ' + (PLUG_PERMISSION_INFO[x] ? PLUG_PERMISSION_INFO[x].label : x) + '：' + (PLUG_PERMISSION_INFO[x] ? PLUG_PERMISSION_INFO[x].risk : '')).join('\n') + '\n\n是否授权并启用？';
    if (!(await uiConfirm(text, '授权并启用', '插件能力授权'))) return;
    p.grantedPermissions = p.permissions.slice();
  }
  p.enabled = next;
  p.state = next ? 'installed' : 'disabled';
  p.updatedAt = new Date().toISOString();
  if (!next) p.grantedPermissions = [];
  plugSaveList();
  plugAudit(next ? 'enable' : 'disable', p);
  plugLifecycle(p, next ? 'enable' : 'disable');
  refreshSystemPrompt();
  toolsBroken = false;
  saveHistory();
  renderPlugins();
  renderPlugPreview();
  toast(p.enabled ? '已启用该插件' : '已停用该插件');
  vibrate(15);
}

let PLUG_REMOTE_MARKET = [];
let PLUG_REMOTE_MARKET_URL = PLUG_MARKET_DEFAULT_URL;
let PLUG_MARKET_PAGE = 1;
const PLUG_MARKET_PAGE_SIZE = 6;
try {
  const cachedMarket = sGet(PLUG_MARKET_CACHE_KEY, null);
  if (cachedMarket && Array.isArray(cachedMarket.plugins)) {
    PLUG_REMOTE_MARKET = cachedMarket.plugins;
    PLUG_REMOTE_MARKET_URL = String(cachedMarket.url || PLUG_MARKET_DEFAULT_URL);
  }
} catch (e) {}

function plugMarketResolveUrl(base, value) {
  try {
    const u = new URL(String(value || ''), String(base || ''));
    if (u.protocol !== 'https:') return '';
    if (plugIsLocalHost(u.hostname)) return '';
    return u.href;
  } catch (e) { return ''; }
}
async function plugSha256(text) {
  try {
    if (HAS_NATIVE && typeof Android.sha256 === 'function') return String(Android.sha256(String(text || '')) || '').toLowerCase();
  } catch (e) {}
  try {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
      return Array.from(new Uint8Array(bytes)).map(x => ('0' + x.toString(16)).slice(-2)).join('');
    }
  } catch (e) {}
  return '';
}
function plugMarketIndexError(data, baseUrl) {
  if (!data || typeof data !== 'object') return '远程索引不是对象';
  if (data.indexVersion !== 1) return '只支持 indexVersion=1';
  if (data.manifestVersion !== 1) return '远程索引的 manifestVersion 不受支持';
  if (!Array.isArray(data.plugins) || data.plugins.length > 200) return 'plugins 必须是最多 200 项的数组';
  const seen = {};
  for (const p of data.plugins) {
    if (!p || typeof p !== 'object') return '索引包含无效条目';
    const id = String(p.id || '');
    if (!PLUG_ID_RE.test(id)) return '索引包含无效插件 id：' + id;
    if (seen[id]) return '索引中插件 id 重复：' + id;
    seen[id] = true;
    if (!String(p.name || '').trim() || !String(p.version || '').trim()) return '插件 ' + id + ' 缺少 name 或 version';
    const manifest = plugMarketResolveUrl(baseUrl, p.manifest);
    if (!manifest) return '插件 ' + id + ' 的 manifest 地址必须是 HTTPS 公网地址';
    if (!PLUG_SHA256_RE.test(String(p.sha256 || ''))) return '插件 ' + id + ' 缺少有效 SHA-256';
    if (p.permissions !== undefined && (!Array.isArray(p.permissions) || plugHasUnknownPermissions(p.permissions))) return '插件 ' + id + ' 的权限声明无效';
  }
  return '';
}
function plugMarketStatus(text, bad) {
  const box = $('#plug-market-status');
  if (box) { box.textContent = text || ''; box.style.color = bad ? '#d6336c' : ''; }
}
async function syncPlugMarket() {
  const input = $('#plug-market-url');
  const url = String((input && input.value) || PLUG_REMOTE_MARKET_URL || PLUG_MARKET_DEFAULT_URL).trim();
  if (!plugMarketResolveUrl(url, url)) return plugMarketStatus('远程市场地址必须是 HTTPS 公网地址。', true);
  plugMarketStatus('正在读取远程只读索引…');
  try {
    const res = await reqRequest({
      method: 'GET', url: url, headers: { Accept: 'application/json' },
      timeoutMs: 15000, expect: 'text', retries: 1, source: 'system:plugin-market'
    });
    if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
    const data = JSON.parse(String(res.text || '').replace(/^\uFEFF/, ''));
    const bad = plugMarketIndexError(data, url);
    if (bad) throw new Error(bad);
    PLUG_REMOTE_MARKET = data.plugins.map(p => Object.assign({}, p, {
      marketSource: 'remote',
      manifestUrl: plugMarketResolveUrl(url, p.manifest),
      indexUrl: url
    }));
    PLUG_REMOTE_MARKET_URL = url;
    sSet(PLUG_MARKET_CACHE_KEY, { url, fetchedAt: new Date().toISOString(), plugins: PLUG_REMOTE_MARKET });
    if (input) input.value = url;
    renderPlugMarket();
    plugMarketStatus('已同步 ' + PLUG_REMOTE_MARKET.length + ' 个远程条目（只读，未自动安装）。');
    toast('远程插件索引同步完成');
  } catch (e) {
    plugMarketStatus('同步失败：' + errMsg(e), true);
  }
}
function plugMarketEntries() {
  const out = PLUGIN_MARKET_INDEX.map(p => Object.assign({}, p, { marketSource: 'local', trust: p.trust || 'local-example' }));
  const ids = {};
  out.forEach(p => { ids[p.id] = true; });
  PLUG_REMOTE_MARKET.forEach(p => { if (!ids[p.id]) out.push(p); });
  return out;
}
function renderPlugMarket() {
  const box = $('#plug-market-list');
  if (!box) return;
  const input = $('#plug-market-url');
  if (input && !input.value) input.value = PLUG_REMOTE_MARKET_URL;
  const query = String(($('#plug-market-search') && $('#plug-market-search').value) || '').trim().toLowerCase();
  const all = plugMarketEntries().filter(p => !query || [p.name, p.description, p.desc, p.author, p.id].join(' ').toLowerCase().indexOf(query) >= 0);
  const pages = Math.max(1, Math.ceil(all.length / PLUG_MARKET_PAGE_SIZE));
  PLUG_MARKET_PAGE = Math.max(1, Math.min(PLUG_MARKET_PAGE, pages));
  const entries = all.slice((PLUG_MARKET_PAGE - 1) * PLUG_MARKET_PAGE_SIZE, PLUG_MARKET_PAGE * PLUG_MARKET_PAGE_SIZE);
  box.innerHTML = entries.map(p => {
    const remote = p.marketSource === 'remote';
    const installed = USER_PLUGINS.some(x => x.id === p.id);
    const trust = p.trust || (remote ? 'remote-unreviewed' : 'local-example');
    const status = p.reviewStatus || (remote ? 'unreviewed' : 'bundled');
    const installedPlugin = USER_PLUGINS.filter(x => x.id === p.id)[0] || null;
    const updateAvailable = !!(remote && installedPlugin && cmpVer(verArr(String(p.version || '0')), verArr(String(installedPlugin.version || '0'))) > 0);
    const buttonText = updateAvailable ? '更新' : (installedPlugin ? '已安装' : '安装');
    const buttonDisabled = installedPlugin && !updateAvailable;
    return '<div class="plug-market-card">' +
      '<div class="plug-group-hd"><span class="plug-group-ic">' + esc(p.icon || '🧩') + '</span><span class="plug-group-name">' + esc(p.name) + '<span class="plug-sub">v' + esc(p.version) + '</span></span><button class="plug-mini" data-market-install="' + esc(p.id) + '" data-market-source="' + esc(p.marketSource) + '"' + (buttonDisabled ? ' disabled' : '') + '>' + buttonText + '</button></div>' +
      '<div class="plug-group-desc">' + esc(p.desc || p.description || '') + '</div>' +
      '<div class="plug-market-meta"><b>来源：</b>' + esc(remote ? '远程只读索引' : 'APK 内置索引') + '　<b>信任：</b>' + esc(trust) + '　<b>审核：</b>' + esc(status) +
      (remote ? '<br><b>完整性：</b>安装前校验 SHA-256' : '') + '</div>' + plugPermissionsHTML(p) + '</div>';
  }).join('') || '<div class="mini-note">没有匹配的插件。</div>';
  const count = $('#plug-market-count'); if (count) count.textContent = all.length + ' 个插件';
  const pageNo = $('#plug-market-page-no'); if (pageNo) pageNo.textContent = '第 ' + PLUG_MARKET_PAGE + ' / ' + pages + ' 页';
  const prev = $('#plug-market-prev'), next = $('#plug-market-next');
  if (prev) prev.disabled = PLUG_MARKET_PAGE <= 1;
  if (next) next.disabled = PLUG_MARKET_PAGE >= pages;
}
async function installMarketPlugin(id, source) {
  let raw = source === 'remote'
    ? PLUG_REMOTE_MARKET.filter(x => x.id === id)[0]
    : PLUGIN_MARKET_INDEX.filter(x => x.id === id)[0];
  if (!raw) return toast('找不到市场插件');
  const existing = USER_PLUGINS.filter(x => x.id === raw.id)[0] || null;
  const isUpdate = !!(existing && source === 'remote' && cmpVer(verArr(String(raw.version || '0')), verArr(String(existing.version || '0'))) > 0);
  if (existing && !isUpdate) return toast('插件已安装，当前没有更高版本');
  let manifest = raw;
  let contentHash = '';
  if (source === 'remote') {
    const url = plugMarketResolveUrl(raw.indexUrl || PLUG_REMOTE_MARKET_URL, raw.manifestUrl || raw.manifest);
    if (!url || !PLUG_SHA256_RE.test(String(raw.sha256 || ''))) return toast('远程插件缺少安全地址或 SHA-256');
    try {
      const res = await reqRequest({
        method: 'GET', url: url, headers: { Accept: 'application/json' },
        timeoutMs: 20000, expect: 'text', retries: 1, maxBytes: 2 * 1024 * 1024, source: 'system:plugin-install'
      });
      if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
      contentHash = await plugSha256(res.text);
      if (!contentHash || contentHash !== String(raw.sha256).toLowerCase()) return toast('远程插件完整性校验失败，已拒绝安装');
      manifest = JSON.parse(String(res.text || '').replace(/^\uFEFF/, ''));
      if (manifest.id !== raw.id || String(manifest.version || '') !== String(raw.version || '')) return toast('远程清单与索引版本不一致，已拒绝安装');
      const indexPerms = (Array.isArray(raw.permissions) ? raw.permissions : []).map(String).sort().join(',');
      const manifestPerms = (Array.isArray(manifest.permissions) ? manifest.permissions : []).map(String).sort().join(',');
      if (indexPerms !== manifestPerms) return toast('远程清单权限与索引不一致，已拒绝安装');
    } catch (e) { return toast('获取远程插件失败：' + errMsg(e)); }
  }
  const manifestError = plugManifestError(manifest);
  if (manifestError) return toast('市场插件清单无效：' + manifestError);
  const m = plugNormalize(manifest);
  if (!m) return toast('市场插件清单无效');
  m.source = source === 'remote' ? 'remote-market' : 'bundled-market';
  m.trust = raw.trust || (source === 'remote' ? 'remote-unreviewed' : 'local-example');
  m.reviewStatus = raw.reviewStatus || (source === 'remote' ? 'unreviewed' : 'bundled');
  m.contentHash = contentHash;
  m.installedAt = new Date().toISOString();
  m.updatedAt = m.installedAt;
  m.grantedPermissions = [];
  m.enabled = !m.permissions.length;
  const warning = source === 'remote'
    ? '\n\n来源：远程只读市场\n信任状态：' + m.trust + '\n审核状态：' + m.reviewStatus + '\n已校验 SHA-256，但完整性校验不代表代码安全。'
    : '';
  const action = isUpdate ? '更新' : '安装';
  if (!(await uiConfirm(action + '「' + m.name + '」？' + warning + '\n\n声明能力：' + plugPermissionSummary(m) + '\n\n更新或安装后仍需单独授权危险能力。', action, action + '市场插件'))) return;
  if (existing) {
    m.installedAt = existing.installedAt || m.installedAt;
    // 更新后只保留新清单仍声明的授权；新增权限不会自动继承。
    m.grantedPermissions = (existing.grantedPermissions || []).filter(p => m.permissions.indexOf(p) >= 0);
    m.enabled = existing.enabled === true && m.permissions.every(p => m.grantedPermissions.indexOf(p) >= 0);
    USER_PLUGINS = USER_PLUGINS.filter(x => x.id !== m.id);
  }
  if (m.permissions.length && !m.permissions.every(p => m.grantedPermissions.indexOf(p) >= 0)) m.enabled = false;
  USER_PLUGINS.push(m);
  plugSaveList();
  plugAudit(isUpdate ? 'update' : 'install', m, { source: m.source });
  plugLifecycle(m, 'install');
  renderPlugins(); renderPlugPreview(); renderPlugMarket();
  toast(isUpdate ? '已更新市场插件' : '已安装市场插件');
}
function renderPlugPreview() {
  const box = $('#plug-preview');
  if (box) box.textContent = buildToolsPrompt() || '（当前没有任何可用工具）';
}

function togglePlug(id) {
  CONFIG.plugins = CONFIG.plugins || {};
  CONFIG.plugins[id] = !plugOn(id);
  refreshSystemPrompt();          // 提示词里的工具段立刻跟着变
  toolsBroken = false;            // 工具集变了，下次重新试一遍 tools 调用
  sSet('via_ai_config', CONFIG);
  saveHistory();
  renderPlugins();
  renderPlugPreview();
  toast(plugOn(id) ? '已开启该组工具' : '已关闭该组工具');
  vibrate(15);
}
/** 单独开关某一项工具；开启时自动打开它所属的组。 */
function toggleTool(name) {
  const owner = PLUGINS.filter(p => p.tools.indexOf(name) >= 0)[0];
  // 以「实际是否开放」为准：组被关掉时，点单项开关应该是重新打开它
  const liveOn = toolOn(name) && (!owner || plugOn(owner.id));
  CONFIG.toolOff = CONFIG.toolOff || {};
  if (liveOn) {
    CONFIG.toolOff[name] = true;
  } else {
    delete CONFIG.toolOff[name];
    if (owner) {
      CONFIG.plugins = CONFIG.plugins || {};
      CONFIG.plugins[owner.id] = true;
    }
  }
  refreshSystemPrompt();
  toolsBroken = false;
  sSet('via_ai_config', CONFIG);
  saveHistory();
  renderPlugins();
  renderPlugPreview();
  toast(liveOn ? '已关闭该工具' : '已开启该工具');
  vibrate(15);
}

/* ==========================================================
 *  插件安装 / 删除
 * ========================================================== */
let PLUG_IMPORT_MODE = 'text';
function setPlugImportMode(mode) {
  PLUG_IMPORT_MODE = mode;
  ['text', 'file', 'url'].forEach(x => {
    const box = $('#plug-source-' + x); if (box) box.classList.toggle('open', x === mode);
    const btn = $('#plug-mode-' + x); if (btn) btn.classList.toggle('btn-p', x === mode);
  });
}
function openPlugInstall(mode) {
  const box = $('#plug-modal');
  if (!box) return;
  const code = $('#plug-code');
  if (code) code.value = '';
  const msg = $('#plug-modal-msg');
  if (msg) { msg.textContent = ''; msg.className = 'mini-note'; }
  setPlugImportMode(mode || 'text');
  box.classList.add('open');
}
async function plugInstallFromUrl() {
  const input = $('#plug-import-url');
  const url = String((input && input.value) || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch (e) { return plugInstallError('URL 格式无效。'); }
  if (parsed.protocol !== 'https:' || plugIsLocalHost(parsed.hostname)) return plugInstallError('URL 必须是 HTTPS 公网地址。');
  try {
    const r = await reqRequest({
      method: 'GET', url: url, headers: { Accept: 'application/json' },
      timeoutMs: 20000, expect: 'text', retries: 1, maxBytes: 2 * 1024 * 1024, source: 'system:plugin-install'
    });
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    await plugInstallFromText(r.text);
  } catch (e) { plugInstallError('读取 URL 失败：' + errMsg(e)); }
}
function pickPlugFile() {
  if (!HAS_NATIVE || !Android.pickFile) return plugInstallError('当前环境不支持文件选择。');
  PICK_MODE = 'plugin';
  try { Android.pickFile(); } catch (e) { plugInstallError('打开文件选择器失败：' + errMsg(e)); }
}

function plugInstallError(msg) {
  const el = $('#plug-modal-msg');
  if (el) { el.textContent = msg; el.className = 'plug-modal-err'; }
}

async function plugInstallFromText(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim()); }
  catch (e) { return plugInstallError('不是有效的 JSON：' + errMsg(e)); }
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.plugins)) list = data.plugins;
  else if (data && data.id) list = [data];
  else return plugInstallError('清单格式不对：需要单个插件对象，或含 plugins 数组的对象。');

  const accepted = [];
  for (const raw of list) {
    const manifestError = plugManifestError(raw);
    if (manifestError) return plugInstallError('插件清单不符合规范：' + manifestError);
    const m = plugNormalize(raw);
    if (!m) return plugInstallError('插件清单不完整：需要合法的 id、name、版本协议，以及至少一个工具或 surface。');
    if (USER_PLUGINS.some(p => p.id === m.id)) return plugInstallError('插件 id 已存在：' + m.id);
    for (const t of m.tools) {
      if (BUILTIN_TOOL_NAMES[t.name]) return plugInstallError('工具名与内置工具冲突：' + t.name);
      if (USER_PLUGINS.some(p => p.tools.some(x => x.name === t.name))
          || accepted.some(a => a.tools.some(x => x.name === t.name)))
        return plugInstallError('工具名重复：' + t.name);
    }
    accepted.push(m);
  }
  if (!accepted.length) return plugInstallError('没有可安装的插件。');

  const names = accepted.map(p => '「' + p.name + '」').join('、');
  const tools = accepted.reduce((n, p) => n + p.tools.length + (p.surfaces || []).length, 0);
  const ok = await uiConfirm(
    '即将安装 ' + names + '，共 ' + tools + ' 个工具/扩展点。\n\n'
    + '声明能力：' + accepted.map(p => p.name + '：' + plugPermissionSummary(p)).join('；') + '\n\n'
    + '安装只保存清单，不代表永久授权。启用插件或调用危险能力时仍会按用户权限和每次操作确认执行。\n\n'
    + '请只安装你信任来源的插件。确认安装吗？',
    '安装', '安装插件'
  );
  if (!ok) return;
  accepted.forEach(p => {
    p.grantedPermissions = [];
    // 有能力声明的插件先安装为停用状态；启用按钮会逐次展示授权说明。
    if (p.permissions.length) p.enabled = false;
    USER_PLUGINS.push(p);
    plugLifecycle(p, 'install');
  });
  plugSaveList();
  refreshSystemPrompt();
  toolsBroken = false;
  saveHistory();
  $('#plug-modal').classList.remove('open');
  renderPlugins();
  renderPlugPreview();
  toast('已安装 ' + names);
}

async function plugDelete(id) {
  const p = USER_PLUGINS.filter(x => x.id === id)[0];
  if (!p) return;
  const ok = await uiConfirm('确定删除插件「' + p.name + '」吗？它的工具会立即从 AI 手里消失。', '删除', '删除插件');
  if (!ok) return;
  plugLifecycle(p, 'uninstall');
  USER_PLUGINS = USER_PLUGINS.filter(x => x.id !== id);
  plugSaveList();
  plugAudit('uninstall', p);
  refreshSystemPrompt();
  toolsBroken = false;
  saveHistory();
  renderPlugins();
  renderPlugPreview();
  toast('已删除插件');
}

