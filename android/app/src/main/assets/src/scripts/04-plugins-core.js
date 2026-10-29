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
/* ----------------------------------------------------------
 *  运行时白名单常量。
 *  必须声明在这个文件里，不能留在 04b-plugin-runtime.js：
 *  下面第 143 行会在脚本加载时就把已存插件过一遍 plugNormalize，
 *  而 plugNormalizeSurface 是本包里的函数声明（会被提升），
 *  它引用的常量若是 const 且定义在后面的文件里，就会踩 TDZ ——
 *  ReferenceError: Cannot access 'PLUG_SURFACE_TYPES' before initialization。
 *  装过插件的机器起来就白屏、卸载重装才好，根因就是这一条。
 * ---------------------------------------------------------- */
const PLUG_SURFACE_TYPES = ['page', 'entry', 'sessionType', 'command', 'event', 'job', 'settings', 'renderer', 'adapter', 'theme'];
const PLUG_COMPONENT_TYPES = ['layout', 'text', 'stat', 'button', 'input', 'select', 'list', 'table', 'image',
  'progress', 'chart', 'tabs', 'modal', 'choice', 'form', 'divider', 'spacer'];
const PLUG_ACTION_TYPES = ['navigate', 'plugin.call', 'config.set', 'state.set', 'session.create', 'session.delete',
  'message.send', 'theme.apply', 'theme.reset', 'confirm', 'openUrl', 'clipboard.write', 'job.schedule',
  'dependency.install', 'custom'];
const PLUG_CONFIG_TYPES = ['string', 'number', 'boolean', 'enum', 'secret', 'path', 'model-ref', 'json'];
const PLUG_EVENT_NAMES = ['message.send', 'message.receive', 'session.create', 'session.delete', 'task.update',
  'job.run', 'plugin.enable', 'plugin.disable', 'dependency.ready', 'gateway.message'];
const PLUG_ENTRY_MOUNTS = ['plugins', 'chat.header', 'chat.footer', 'chat.composer.before', 'chat.message.after',
  'panel.home', 'panel.tabs', 'settings.section', 'session.create', 'task.detail', 'notification'];
const PLUG_SURFACE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
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
  'music.control': { label: '控制音乐', risk: '可搜索、播放、切歌、收藏和管理本地缓存' },
  'dependencies.manage': { label: '安装/卸载依赖', risk: '可从 HTTPS 下载并校验 SHA-256 后装进插件沙箱；APK 依赖仍走系统安装器确认' },
  'runtime.termux': { label: 'Termux 长任务', risk: '可在受控工作任务内用白名单执行器（node/python 等）启动长驻进程；每次派发仍需用户确认' }};
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
  search_and_play_music: 'music.control', music_control: 'music.control',
  // R-001：Termux 运行时只开放五个受控工具，root_operation 永远不给插件
  run_termux_job: 'runtime.termux', termux_job_status: 'runtime.termux',
  termux_job_output: 'runtime.termux', termux_job_cancel: 'runtime.termux',
  termux_jobs_list: 'runtime.termux'
};
const PLUG_PERMISSION_NAMES = Object.keys(PLUG_PERMISSION_INFO);
/* 0.12 / E5-001：依赖声明只认这五类；下载类必须 HTTPS + SHA-256。 */
const PLUG_DEP_KINDS = ['termux-pkg', 'npm', 'archive', 'binary', 'apk'];
const PLUG_DEP_HASH_KINDS = ['archive', 'binary', 'apk'];
const PLUG_DEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PLUG_DEP_NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@/._+-]{0,119}$/;
function plugDepIsHttps(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && !!x.hostname; } catch (e) { return false; }
}
/** 规整一条依赖声明；缺关键字段返回 null。 */
function plugNormalizeDependency(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const kind = String(d.kind || '').trim();
  const id = String(d.id || '').trim();
  const version = String(d.version || '').trim();
  if (PLUG_DEP_KINDS.indexOf(kind) < 0 || !PLUG_DEP_ID_RE.test(id) || !version) return null;
  const source = String(d.source || d.url || '').trim();
  const sha = String(d.sha256 || '').trim().toLowerCase();
  if (!source || source.length > 500) return null;
  if (PLUG_DEP_HASH_KINDS.indexOf(kind) >= 0) {
    if (!plugDepIsHttps(source) || !PLUG_SHA256_RE.test(sha)) return null;
  } else if (!PLUG_DEP_NAME_RE.test(source)) return null;
  const size = parseInt(d.size, 10);
  return {
    id, kind, version,
    source,
    sha256: PLUG_SHA256_RE.test(sha) ? sha : '',
    bin: String(d.bin || '').slice(0, 64),
    size: Number.isFinite(size) && size > 0 ? Math.min(size, 209715200) : 0,
    license: String(d.license || '').slice(0, 40),
    why: String(d.why || d.reason || '').slice(0, 200)
  };
}
/* 0.13 / R-002：清单 v2 的长驻运行时块。入口只认插件沙箱内的相对 .js 路径。 */
const PLUG_RUNTIME_KINDS = ['termux-node'];
const PLUG_RUNTIME_RESTART = ['none', 'on-failure', 'always'];
const PLUG_RUNTIME_ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,118}\.js$/;
function plugRuntimeIsObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
/** 规整 runtime 块；不合法返回 null。没声明就返回 null。 */
function plugNormalizeRuntime(raw) {
  if (!plugRuntimeIsObject(raw)) return null;
  const kind = String(raw.kind || '').trim();
  const entry = String(raw.entry || '').trim();
  if (PLUG_RUNTIME_KINDS.indexOf(kind) < 0) return null;
  if (!PLUG_RUNTIME_ENTRY_RE.test(entry) || entry.indexOf('..') >= 0) return null;
  const health = parseInt(raw.healthcheckMs, 10) || 15000;
  const logMax = parseInt(raw.logMaxBytes, 10) || 1048576;
  return {
    kind,
    entry,
    // source 为空表示入口文件由用户自己放进运行时工作区；有值则由宿主在启动前写入。
    source: typeof raw.source === 'string' ? raw.source.slice(0, 200000) : '',
    args: (Array.isArray(raw.args) ? raw.args : []).slice(0, 20).map(a => String(a).slice(0, 200)).filter(a => a.indexOf('\u0000') < 0),
    autostart: raw.autostart === true,
    // 启动前把插件配置写成 runtime-config.json，入口脚本从工作目录读取（避免把配置拼进代码）。
    configFile: raw.configFile === true,
    restart: PLUG_RUNTIME_RESTART.indexOf(String(raw.restart || '')) >= 0 ? String(raw.restart) : 'on-failure',
    healthcheckMs: Math.min(Math.max(health, 5000), 300000),
    logMaxBytes: Math.min(Math.max(logMax, 65536), 10485760)
  };
}
/** runtime 块的结构性错误；合法返回空串。 */
function plugRuntimeError(raw, declared) {
  if (raw === undefined) return '';
  if (!plugRuntimeIsObject(raw)) return 'runtime 必须是对象';
  if (PLUG_RUNTIME_KINDS.indexOf(String(raw.kind || '')) < 0) return 'runtime.kind 只支持 termux-node';
  if (!plugNormalizeRuntime(raw)) return 'runtime.entry 必须是插件沙箱内的相对 .js 路径';
  if (raw.source !== undefined && typeof raw.source !== 'string') return 'runtime.source 必须是字符串';
  if ((declared || []).indexOf('runtime.termux') < 0) return '声明 runtime 的插件必须同时申请 runtime.termux';
  if (raw.restart !== undefined && PLUG_RUNTIME_RESTART.indexOf(String(raw.restart)) < 0) return 'runtime.restart 只支持 none/on-failure/always';
  return '';
}
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
  // v2：功能由 surfaces 描述；v1：沿用 tools。二者都空才算无效清单。
  const manifestVersion = parseInt(m.manifestVersion, 10) || 1;
  const surfaces = manifestVersion === 2
    ? (Array.isArray(m.surfaces) ? m.surfaces : []).map(s => plugNormalizeSurface(s, declared)).filter(Boolean)
    : [];
  if (!tools.length && !surfaces.length) return null;
  const config = manifestVersion === 2 ? plugNormalizeConfig(m.config) : { version: 1, fields: [] };
  // 有权限的插件永远默认未授权；旧版未保存授权字段时也不能把声明当成授权。
  const hasPermissionState = Array.isArray(m.grantedPermissions);
  const granted = hasPermissionState
    ? plugNormalizePermissions(m.grantedPermissions).filter(p => declared.indexOf(p) >= 0)
    : [];
  return {
    manifestVersion: manifestVersion,
    apiVersion: String(m.apiVersion || (manifestVersion === 2 ? '0.2' : '0.1')).slice(0, 24),
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
    tools,
    surfaces,
    configVersion: config.version,
    configFields: config.fields,
    dependencies: (Array.isArray(m.dependencies) ? m.dependencies.slice(0, 40) : [])
      .map(plugNormalizeDependency).filter(Boolean),
    models: plugPlainObject(m.models) ? plugJsonSafe(m.models, 0) : {},
    runtime: manifestVersion === 2 ? plugNormalizeRuntime(m.runtime) : null
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
  if (raw.manifestVersion === 2) return plugManifestV2Error(raw);
  if (raw.manifestVersion !== 1) return '只支持 manifestVersion=1 或 2（数字）';
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
'清单 v2 可只声明 surfaces，用组件树组合页面、入口、会话与主题，宿主不预设插件类型：',
'  page / entry（mount 可为 chat.header、chat.footer、chat.composer.before、chat.message.after、settings.section 等）',
'  sessionType（stateSchema 默认值、opening、renderer 每轮模板、endWhen 结束条件）',
'  theme（tokens 只接受颜色、渐变、圆角、字号、字重、透明度、阴影；可全局或单会话应用与重置）',
'  command / event / job / settings / renderer / adapter',
'组件只由宿主渲染，插件不能写 HTML/CSS/JS；任意 CSS、url() 注入和脚本都会被丢弃。',
'示例清单与校验工具见仓库 plugin-examples/ 与 tools/plugin-validate.js。',
'远程市场索引只能由用户主动同步；每个远程清单必须使用 HTTPS，并在安装前通过索引提供的 SHA-256 校验。',
'请同时提供 README、权限理由、参数/返回值、错误处理、隐私说明、版本记录和测试步骤。'
].join('\n');

/* 本地插件市场索引：发布前可由构建流程同步为远程静态索引；本版本不执行上传。 */
const PLUGIN_MARKET_INDEX = [
  {
    "manifestVersion": 1,
    "apiVersion": "0.1",
    "id": "com.elly.market.text-tools",
    "name": "文本处理示例",
    "icon": "Aa",
    "version": "1.0.0",
    "author": "ElysiaFloat",
    "homepage": "https://github.com/xysy92ds/ElysiaFloat",
    "docs": "plugins/com.elly.market.text-tools/README.md",
    "desc": "无外部权限的文本统计与规范化示例，适合验证插件开发流程。",
    "permissions": [],
    "tools": [
      {
        "name": "text_inspect",
        "description": "统计文本字符数、行数和非空行数。不会访问网络、文件或设备。",
        "permissions": [],
        "parameters": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "description": "待统计文本"
            }
          },
          "required": [
            "text"
          ]
        },
        "kind": "js",
        "code": "async function run(args){var t=String(args.text||\"\");var lines=t?t.split(/\\r?\\n/):[];return {characters:t.length,lines:lines.length,nonEmptyLines:lines.filter(function(x){return x.trim();}).length};}"
      }
    ]
  }
];

refreshSystemPrompt();
let transCache = sGet('via_ai_trans', {}) || {};
let favorites = sGet('via_ai_favs', []) || [];
let sending = false;
let stopRequested = false;
let ACTIVE_RUN_TASK_ID = '';

