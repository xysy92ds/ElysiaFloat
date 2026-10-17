/* ==========================================================
 *  开放插件系统
 *  插件清单存在本机，每个插件声明若干工具，工具实现分两类：
 *    http —— 声明式请求（method/url/headers/body，支持 {{参数}} 占位）
 *    js   —— 自定义脚本，在 sandbox iframe 里运行，只能经过受控的 host.* 做事
 *  插件永远拿不到 Android.* 桥，能力边界由宿主校验。
 * ========================================================== */
const PLUG_KEY = 'via_ai_user_plugins';
const PLUG_DATA_KEY = 'via_ai_plugin_data';
const PLUG_AUDIT_KEY = 'via_ai_plugin_audit';
const PLUG_MARKET_CACHE_KEY = 'via_ai_plugin_market_cache';
const PLUG_MARKET_DEFAULT_URL = 'https://raw.githubusercontent.com/xysy92ds/ElysiaFloat/main/marketplace/index.json';
const PLUG_ID_RE = /^[A-Za-z0-9_.-]{2,64}$/;
const PLUG_SHA256_RE = /^[a-f0-9]{64}$/i;
const PLUG_TOOL_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const PLUG_PERMISSION_INFO = {
  'network.public': { label: '公网网络请求', risk: '可向互联网发送数据' },
  'network.local': { label: '局域网/本机网络请求', risk: '可访问局域网设备或本机服务' },
  'system.open_url': { label: '打开系统链接', risk: '可唤起浏览器或其它应用' },
  'clipboard.write': { label: '写入剪贴板', risk: '可改变系统剪贴板内容' },
  'storage.plugin': { label: '插件私有存储', risk: '可在本机保存插件数据' },
  'files.public.read': { label: '读取公共存储文件', risk: '可读取用户授权范围内的文件' },
  'files.public.write': { label: '写入公共存储文件', risk: '可修改或复制文件；每次操作仍需确认' },
  'files.public.delete': { label: '删除公共存储文件', risk: '可删除文件或目录；每次操作仍需确认' },
  'workspace.read': { label: '读取工作区', risk: '可读取工作区内容' },
  'workspace.write': { label: '写入工作区', risk: '可修改工作区；每次操作仍需确认' },
  'device.read': { label: '读取设备状态', risk: '可查询应用和界面信息' },
  'device.screenshot': { label: '获取屏幕画面', risk: '可能包含聊天、验证码或其它隐私' },
  'device.action': { label: '执行设备操作', risk: '可点击、滑动、输入或启动白名单应用' },
  'memory.read': { label: '读取长期记忆', risk: '可读取用户保存的记忆' },
  'memory.write': { label: '写入长期记忆', risk: '可新增或修改记忆' },
  'memory.delete': { label: '删除长期记忆', risk: '可请求删除记忆；仍需用户确认' },
  'music.control': { label: '控制音乐', risk: '可搜索、播放、切歌、收藏和管理本地缓存' }};
const PLUG_CAPABILITY_PERMS = {
  read_screen_once: 'device.read', external_file_list: 'files.public.read', external_file_read: 'files.public.read',
  external_file_write: 'files.public.write', external_file_copy: ['files.public.read', 'files.public.write'],
  external_file_mkdir: 'files.public.write', external_file_delete: 'files.public.delete',
  workspace_status: 'workspace.read', workspace_list: 'workspace.read', workspace_read: 'workspace.read',
  workspace_create: 'workspace.write', workspace_write: 'workspace.write', workspace_mkdir: 'workspace.write',
  read_screen: 'device.read', get_current_page: 'device.read', find_app: 'device.read',
  screenshot: 'device.screenshot', watch_screen: 'device.screenshot',
  tap_screen: 'device.action', click_text: 'device.action', swipe_screen: 'device.action',
  input_text: 'device.action', press_key: 'device.action', launch_app: 'device.action',
  open_url: 'system.open_url', set_clipboard: 'clipboard.write',
  list_memories: 'memory.read', read_memory: 'memory.read', list_memory_categories: 'memory.read',
  save_memory: 'memory.write', update_memory: 'memory.write', pin_memory: 'memory.write',
  delete_memory: 'memory.delete',
  search_and_play_music: 'music.control', music_control: 'music.control'
};
const PLUG_PERMISSION_NAMES = Object.keys(PLUG_PERMISSION_INFO);
function plugNormalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(String).map(s => s.trim()).filter(s => PLUG_PERMISSION_INFO[s])));
}
function plugHasUnknownPermissions(value) {
  return Array.isArray(value) && value.some(x => !PLUG_PERMISSION_INFO[String(x || '').trim()]);
}
const BUILTIN_TOOL_NAMES = (function () {
  const s = {};
  PLUGINS.forEach(p => p.tools.forEach(t => { s[t] = true; }));
  return s;
})();

let USER_PLUGINS = sGet(PLUG_KEY, null);
if (!Array.isArray(USER_PLUGINS)) USER_PLUGINS = [];
USER_PLUGINS = USER_PLUGINS.map(plugNormalize).filter(Boolean);
const plugSaveList = () => sSet(PLUG_KEY, USER_PLUGINS);
function plugAudit(event, plugin, details) {
  const rows = sGet(PLUG_AUDIT_KEY, []) || [];
  rows.push({
    event: String(event || 'unknown').slice(0, 40),
    pluginId: plugin && plugin.id ? String(plugin.id) : '',
    tool: details && details.tool ? String(details.tool).slice(0, 80) : '',
    source: plugin && plugin.source ? String(plugin.source).slice(0, 40) : '',
    at: new Date().toISOString()
  });
  while (rows.length > 100) rows.shift();
  sSet(PLUG_AUDIT_KEY, rows);
}
function plugFailure(code, message, details) {
  return { success: false, errorCode: String(code || 'PLUGIN_ERROR'), error: String(message || '插件执行失败'), details: details || null };
}
function plugSuccess(data, meta) {
  const out = { success: true, data: data };
  if (meta) out.meta = meta;
  return out;
}

/** 规整单个工具；不合法返回 null。 */
function plugNormalizeTool(t, declaredPermissions) {
  if (!t || typeof t !== 'object') return null;
  const name = String(t.name || '').trim();
  if (!PLUG_TOOL_RE.test(name)) return null;
  const kind = t.kind === 'http' ? 'http' : (t.kind === 'js' ? 'js' : '');
  if (!kind || plugHasUnknownPermissions(t.permissions)) return null;
  const permissions = Array.isArray(t.permissions)
    ? plugNormalizePermissions(t.permissions) : declaredPermissions.slice();
  if (permissions.some(p => declaredPermissions.indexOf(p) < 0)) return null;
  const out = {
    name,
    description: String(t.description || '').slice(0, 500),
    parameters: (t.parameters && typeof t.parameters === 'object')
      ? t.parameters : { type: 'object', properties: {} },
    kind,
    permissions,
    timeout: Math.min(Math.max(parseInt(t.timeout, 10) || 15000, 1000), 60000)
  };
  if (kind === 'http') {
    const r = (t.request && typeof t.request === 'object') ? t.request : {};
    out.request = {
      method: String(r.method || 'GET').toUpperCase(),
      url: String(r.url || ''),
      headers: (r.headers && typeof r.headers === 'object') ? r.headers : {},
      body: (r.body === undefined || r.body === null)
        ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    };
    if (!out.request.url) return null;
  } else {
    out.code = String(t.code || '');
    if (!out.code.trim()) return null;
  }
  return out;
}

/** 规整插件清单；不合法返回 null。旧版清单只保留无声明能力的安全运行方式。 */
function plugNormalize(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || '').trim();
  const name = String(m.name || '').trim();
  if (!PLUG_ID_RE.test(id) || !name || plugHasUnknownPermissions(m.permissions)) return null;
  const declared = Array.isArray(m.permissions) ? plugNormalizePermissions(m.permissions) : [];
  const tools = (Array.isArray(m.tools) ? m.tools : [])
    .map(t => plugNormalizeTool(t, declared)).filter(Boolean);
  if (!tools.length) return null;
  // 有权限的插件永远默认未授权；旧版未保存授权字段时也不能把声明当成授权。
  const hasPermissionState = Array.isArray(m.grantedPermissions);
  const granted = hasPermissionState
    ? plugNormalizePermissions(m.grantedPermissions).filter(p => declared.indexOf(p) >= 0)
    : [];
  return {
    manifestVersion: parseInt(m.manifestVersion, 10) || 1,
    apiVersion: String(m.apiVersion || '0.1').slice(0, 24),
    id, name,
    pluginType: ['chat', 'quick', 'device', 'workspace'].indexOf(String(m.pluginType || '').toLowerCase()) >= 0 ? String(m.pluginType).toLowerCase() : (declared.some(p => p.indexOf('workspace') === 0 || p.indexOf('files.') === 0) ? 'workspace' : (declared.some(p => p.indexOf('device.') === 0) ? 'device' : 'chat')),
    icon: String(m.icon || '🧩').slice(0, 4),
    version: String(m.version || '1.0.0').slice(0, 24),
    author: String(m.author || '').slice(0, 48),
    homepage: String(m.homepage || '').slice(0, 500),
    docs: String(m.docs || '').slice(0, 1000),
    desc: String(m.desc || '').slice(0, 300),
    permissions: declared,
    grantedPermissions: granted,
    enabled: m.enabled !== false && (!declared.length || hasPermissionState),
    state: m.state === 'quarantined' ? 'quarantined' : (m.state === 'disabled' ? 'disabled' : 'installed'),
    source: String(m.source || 'local').slice(0, 40),
    trust: String(m.trust || 'user-import').slice(0, 40),
    reviewStatus: String(m.reviewStatus || 'unreviewed').slice(0, 40),
    contentHash: String(m.contentHash || '').toLowerCase(),
    installedAt: m.installedAt || new Date().toISOString(),
    updatedAt: m.updatedAt || m.installedAt || new Date().toISOString(),
    invokedAt: m.invokedAt || '',
    invokeCount: Math.max(0, parseInt(m.invokeCount, 10) || 0),
    tools
  };
}
function plugPermissionDeclared(plugin, permission) {
  return !!(plugin && Array.isArray(plugin.permissions) && plugin.permissions.indexOf(permission) >= 0);
}
function plugPermissionGranted(plugin, permission) {
  return plugPermissionDeclared(plugin, permission) && Array.isArray(plugin.grantedPermissions)
    && plugin.grantedPermissions.indexOf(permission) >= 0;
}
function plugToolPermissions(plugin, tool) {
  return tool && Array.isArray(tool.permissions) ? tool.permissions : (plugin && plugin.permissions) || [];
}
function plugToolPermissionsGranted(plugin, tool) {
  return plugToolPermissions(plugin, tool).every(p => plugPermissionGranted(plugin, p));
}
function plugCapabilityPermissions(name) {
  const value = PLUG_CAPABILITY_PERMS[name];
  return Array.isArray(value) ? value : (value ? [value] : []);
}
function plugCapabilityPermission(name) { return plugCapabilityPermissions(name)[0] || ''; }
function plugPluginCanCall(plugin, name) {
  const permissions = plugCapabilityPermissions(name);
  return permissions.length > 0 && permissions.every(p => plugPermissionGranted(plugin, p));
}
function plugManifestError(raw) {
  if (!raw || typeof raw !== 'object') return '插件清单必须是对象';
  if (raw.manifestVersion !== 1) return '只支持 manifestVersion=1（数字）';
  if (typeof raw.apiVersion !== 'string' || !raw.apiVersion.trim()) return '缺少 apiVersion';
  if (!Array.isArray(raw.permissions)) return '必须显式声明 permissions 数组；无危险能力也请填写 []';
  if (plugHasUnknownPermissions(raw.permissions)) return 'permissions 含有未知能力';
  if (!Array.isArray(raw.tools) || !raw.tools.length) return '至少需要一个工具';
  const declared = plugNormalizePermissions(raw.permissions);
  const seen = {};
  for (const t of raw.tools) {
    if (!t || typeof t !== 'object') return '工具定义无效';
    if (seen[t.name]) return '工具名重复：' + t.name;
    seen[t.name] = true;
    if (!Array.isArray(t.permissions)) return '工具 ' + (t.name || '') + ' 必须显式声明 permissions 数组';
    if (plugHasUnknownPermissions(t.permissions)) return '工具 ' + (t.name || '') + ' 声明了未知能力';
    const effective = Array.isArray(t.permissions) ? plugNormalizePermissions(t.permissions) : declared;
    if (effective.some(p => declared.indexOf(p) < 0)) return '工具 ' + (t.name || '') + ' 使用了插件未声明的能力';
    if (t.kind === 'http' && !effective.some(p => p === 'network.public' || p === 'network.local')) {
      return 'HTTP 工具 ' + (t.name || '') + ' 必须声明 network.public 或 network.local';
    }
  }
  return '';
}

/** 按工具名找到「插件 + 工具」；找不到返回 null。 */
function plugFind(name) {
  for (let i = 0; i < USER_PLUGINS.length; i++) {
    const p = USER_PLUGINS[i];
    for (let j = 0; j < p.tools.length; j++) {
      if (p.tools[j].name === name) return { plugin: p, tool: p.tools[j] };
    }
  }
  return null;
}

/** 把 {{参数名}} 换成工具入参里的值。 */
function plugTemplate(s, args) {
  return String(s == null ? '' : s).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) =>
    (args && args[k] !== undefined && args[k] !== null) ? String(args[k]) : '');
}

/** 插件开发说明（插件页「格式说明」展示）。 */
const PLUG_HELP = [
'插件开发规范 v1：先声明能力，再实现工具。清单必须是有效 JSON，不要写 // 注释。',
'',
'{',
'  "manifestVersion": 1,',
'  "apiVersion": "0.1",',
'  "id": "com.example.demo",',
'  "name": "示例插件",',
'  "icon": "🧩",',
'  "version": "1.0.0",',
'  "author": "你的名字",',
'  "homepage": "https://example.com",',
'  "docs": "https://example.com/docs",',
'  "desc": "一句话说明插件用途、输入和输出",',
'  "permissions": ["network.public"],',
'  "tools": [',
'    {',
'      "name": "search_thing",',
'      "description": "什么时候调用、参数含义、返回值和失败情况",',
'      "permissions": ["network.public"],',
'      "parameters": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] },',
'      "kind": "http",',
'      "request": { "method": "GET", "url": "https://api.example.com/search?q={{q}}", "headers": {}, "body": "" }',
'    }',
'  ]',
'}',
'',
'permissions 是插件请求的能力，必须完整、最小化地填写。可用能力：',
'  network.public       公网 HTTP(S) 请求',
'  network.local        本机/局域网请求；需要用户开启安全开关',
'  system.open_url      调用系统浏览器打开链接',
'  clipboard.write      写入系统剪贴板',
'  storage.plugin       插件私有持久化存储',
'  files.public.read    读取公共存储文件',
'  files.public.write   写入、复制或创建公共存储文件；每次实际修改都会弹窗确认',
'  files.public.delete  删除公共存储文件；每次实际删除都会弹窗确认',
'  workspace.read       读取 ElysiaFloat 工作区',
'  workspace.write      修改工作区；每次实际修改都会弹窗确认',
'  device.read          读取设备应用或界面信息',
'  device.screenshot    获取屏幕画面；仍受 Agent L2 和用户确认控制',
'  device.action        点击、滑动、输入或启动应用；仍受 L3、白名单和安全开关控制',
'  memory.read/write/delete  读取、修改或请求删除长期记忆；删除仍需用户确认',
'',
'HTTP 工具必须声明 network.public 或 network.local。JS 工具应为每个工具填写最小 permissions。',
'{{参数名}} 会被替换成 AI 传入的对应参数；不要把密钥硬编码在插件清单或代码中。',
'',
'JS 工具代码必须定义 async function run(args)，运行在无 Android 桥的隔离沙箱中：',
'  host.request({ method, url, headers, body, timeout }) -> { status, text }',
'  host.callTool(name, args) -> 调用已声明且已获用户授权的内置能力',
'  host.toast(text)              显示提示',
'  host.openUrl(url)             打开系统链接，需要 system.open_url',
'  host.clipboard.write(text)    写入剪贴板，需要 clipboard.write',
'  host.storage.get/set          插件私有存储，需要 storage.plugin',
'  host.log(...)                 输出调试日志',
'',
'复制文件示例：await host.callTool("external_file_copy", { source: args.source, destination: args.destination });',
'读取文本示例：await host.callTool("external_file_read", { path: args.path, max_chars: 120000 });',
'',
'宿主仍会检查 Android 权限、Agent L1/L2/L3、安全开关、应用白名单和每次修改确认。',
'插件不能通过声明绕过用户未开启的能力，也不能调用其它自定义插件。',
'执行结果会保留 success；失败时还会提供 errorCode，例如 PERMISSION_DENIED、NETWORK_ERROR、HTTP_ERROR、PLUGIN_RUNTIME_ERROR。',
'远程市场索引只能由用户主动同步；每个远程清单必须使用 HTTPS，并在安装前通过索引提供的 SHA-256 校验。',
'请同时提供 README、权限理由、参数/返回值、错误处理、隐私说明、版本记录和测试步骤。'
].join('\n');

/* 本地插件市场索引：发布前可由构建流程同步为远程静态索引；本版本不执行上传。 */
const PLUGIN_MARKET_INDEX = [
  {
    manifestVersion: 1, apiVersion: '0.1', id: 'com.elly.market.text-tools',
    name: '文本处理示例', icon: 'Aa', version: '1.0.0', author: 'ElysiaFloat',
    desc: '无外部权限的文本统计与规范化示例，适合验证插件开发流程。',
    docs: 'marketplace/plugins/com.elly.market.text-tools/README.md', permissions: [],
    tools: [{ name: 'text_inspect', description: '统计文本字符数、行数和非空行数。', permissions: [], kind: 'js',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      code: 'async function run(args){var t=String(args.text||"");var lines=t? t.split(/\r?\n/):[];return {characters:t.length,lines:lines.length,nonEmptyLines:lines.filter(function(x){return x.trim();}).length};}' }]
  }
];

refreshSystemPrompt();
sSet('via_ai_history', history);
let transCache = sGet('via_ai_trans', {}) || {};
let favorites = sGet('via_ai_favs', []) || [];
let sending = false;
let stopRequested = false;
let ACTIVE_RUN_TASK_ID = '';

