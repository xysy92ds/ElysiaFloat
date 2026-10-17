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
  },
  {
    "manifestVersion": 1,
    "apiVersion": "0.1",
    "id": "com.elly.market.minecraft",
    "name": "Minecraft 联机助手",
    "icon": "⛏",
    "version": "0.2.0",
    "author": "ElysiaFloat",
    "homepage": "https://github.com/xysy92ds/ElysiaFloat",
    "docs": "plugins/com.elly.market.minecraft/README.md",
    "desc": "在 Termux 中运行 Minecraft 服务器和 AI 控制的 Mineflayer bot，实现你和 AI 同世界联机。bot 支持移动、挖掘、放置、攻击、寻路、合成、聊天等操作。需要 Termux + Java + Node.js。",
    "permissions": [
      "termux"
    ],
    "tools": [
      {
        "name": "minecraft_setup",
        "description": "在 Termux 中安装 Java 17、Node.js，并创建 mc-bot 目录和 package.json。这是一次性的环境搭建。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; return await t.call('run_termux_job', {executor:'bash', args:['-c','pkg update -y && pkg install -y openjdk-17 nodejs && mkdir -p ~/mc-bot && cd ~/mc-bot && echo \\'{\"name\":\"mc-bot\",\"version\":\"1.0.0\"}\\' > package.json']}); }"
      },
      {
        "name": "minecraft_install_deps",
        "description": "安装 Mineflayer bot 的依赖：mineflayer、mineflayer-pathfinder、minecraft-data、vec3。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; return await t.call('run_termux_job', {executor:'bash', args:['-c','cd ~/mc-bot && npm install mineflayer mineflayer-pathfinder minecraft-data vec3']}); }"
      },
      {
        "name": "minecraft_deploy_bot",
        "description": "部署正式的 bot.js 脚本到 Termux。bot 会连接 MC 服务器，通过 JSON 指令文件接收控制，通过状态文件回报信息。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "botName": {
              "type": "string",
              "description": "bot 游戏名，默认 Elly"
            },
            "serverHost": {
              "type": "string",
              "description": "服务器地址，默认 127.0.0.1"
            },
            "serverPort": {
              "type": "integer",
              "description": "服务器端口，默认 19132"
            }
          },
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const name = args.botName || \"Elly\"; const host = args.serverHost || \"127.0.0.1\"; const port = args.serverPort || 19132; const b64 = \"Ly8gRWx5c2lhRmxvYXQgTWluZWNyYWZ0IEJvdAovLyDpgJrov4cgSlNPTiDmjIfku6Tmlofku7bmjqXmlLYgQUkg5o6n5Yi277yM6YCa6L+H54q25oCB5paH5Lu25Zue5oql546v5aKD5L+h5oGvCi8vIOS+nei1lu+8mm1pbmVmbGF5ZXIsIG1pbmVmbGF5ZXItcGF0aGZpbmRlciwgbWluZWNyYWZ0LWRhdGEsIHZlYzMKCmNvbnN0IG1pbmVmbGF5ZXIgPSByZXF1aXJlKCdtaW5lZmxheWVyJyk7CmNvbnN0IHsgcGF0aGZpbmRlciwgTW92ZW1lbnRzLCBnb2FscyB9ID0gcmVxdWlyZSgnbWluZWZsYXllci1wYXRoZmluZGVyJyk7CmNvbnN0IHZlYzMgPSByZXF1aXJlKCd2ZWMzJyk7CmNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKTsKCmNvbnN0IENPTkZJRyA9IHsKICBob3N0OiBwcm9jZXNzLmVudi5NQ19IT1NUIHx8ICcxMjcuMC4wLjEnLAogIHBvcnQ6IHBhcnNlSW50KHByb2Nlc3MuZW52Lk1DX1BPUlQgfHwgJzE5MTMyJywgMTApLAogIHVzZXJuYW1lOiBwcm9jZXNzLmVudi5NQ19VU0VSTkFNRSB8fCAnRWxseScsCiAgY21kRmlsZTogcHJvY2Vzcy5lbnYuTUNfQ01EX0ZJTEUgfHwgJy9kYXRhL2RhdGEvY29tLnRlcm11eC9maWxlcy9ob21lL21jLWJvdC9jbWQuanNvbicsCiAgc3RhdHVzRmlsZTogcHJvY2Vzcy5lbnYuTUNfU1RBVFVTX0ZJTEUgfHwgJy9kYXRhL2RhdGEvY29tLnRlcm11eC9maWxlcy9ob21lL21jLWJvdC9zdGF0dXMuanNvbicsCiAgY2hhdExvZ0ZpbGU6IHByb2Nlc3MuZW52Lk1DX0NIQVRfRklMRSB8fCAnL2RhdGEvZGF0YS9jb20udGVybXV4L2ZpbGVzL2hvbWUvbWMtYm90L2NoYXQubG9nJwp9OwoKbGV0IGJvdCA9IG51bGw7CmxldCBjdXJyZW50QWN0aW9uID0gbnVsbDsKbGV0IGxhc3RTdGF0dXNVcGRhdGUgPSAwOwoKZnVuY3Rpb24gbG9nKG1zZykgewogIGNvbnN0IHRzID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpOwogIGNvbnNvbGUubG9nKGBbJHt0c31dICR7bXNnfWApOwp9CgpmdW5jdGlvbiBzYWZlUmVhZEpzb24oZmlsZSkgewogIHRyeSB7CiAgICBpZiAoIWZzLmV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiBudWxsOwogICAgY29uc3QgdGV4dCA9IGZzLnJlYWRGaWxlU3luYyhmaWxlLCAndXRmOCcpLnRyaW0oKTsKICAgIGlmICghdGV4dCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gSlNPTi5wYXJzZSh0ZXh0KTsKICB9IGNhdGNoIChlKSB7CiAgICByZXR1cm4gbnVsbDsKICB9Cn0KCmZ1bmN0aW9uIHdyaXRlU3RhdHVzKGV4dHJhKSB7CiAgaWYgKCFib3QpIHJldHVybjsKICBjb25zdCBub3cgPSBEYXRlLm5vdygpOwogIGlmIChub3cgLSBsYXN0U3RhdHVzVXBkYXRlIDwgNTAwKSByZXR1cm47IC8vIOacgOWkmiAyIOasoS/np5IKICBsYXN0U3RhdHVzVXBkYXRlID0gbm93OwogIHRyeSB7CiAgICBjb25zdCBlbnRpdHkgPSBib3QuZW50aXR5OwogICAgY29uc3Qgc3RhdHVzID0gewogICAgICB0czogbm93LAogICAgICBjb25uZWN0ZWQ6IHRydWUsCiAgICAgIHVzZXJuYW1lOiBib3QudXNlcm5hbWUsCiAgICAgIGhlYWx0aDogTWF0aC5yb3VuZChib3QuaGVhbHRoICogMTApIC8gMTAsCiAgICAgIGh1bmdlcjogTWF0aC5yb3VuZChib3QuZm9vZCAqIDEwKSAvIDEwLAogICAgICBwb3NpdGlvbjogZW50aXR5ID8gewogICAgICAgIHg6IE1hdGgucm91bmQoZW50aXR5LnBvc2l0aW9uLnggKiAxMDApIC8gMTAwLAogICAgICAgIHk6IE1hdGgucm91bmQoZW50aXR5LnBvc2l0aW9uLnkgKiAxMDApIC8gMTAwLAogICAgICAgIHo6IE1hdGgucm91bmQoZW50aXR5LnBvc2l0aW9uLnogKiAxMDApIC8gMTAwLAogICAgICAgIHlhdzogTWF0aC5yb3VuZChlbnRpdHkueWF3ICogMTAwKSAvIDEwMAogICAgICB9IDogbnVsbCwKICAgICAgb25Hcm91bmQ6IGVudGl0eSA/IGVudGl0eS5vbkdyb3VuZCA6IGZhbHNlLAogICAgICBpbnZlbnRvcnk6IGJvdC5pbnZlbnRvcnkuaXRlbXMoKS5tYXAoaSA9PiAoewogICAgICAgIG5hbWU6IGkubmFtZSwgY291bnQ6IGkuY291bnQsIHNsb3Q6IGkuc2xvdAogICAgICB9KSksCiAgICAgIGVxdWlwbWVudDogYm90LmVxdWlwbWVudCA/IE9iamVjdC5lbnRyaWVzKGJvdC5lcXVpcG1lbnQpLmZpbHRlcigoWywgdl0pID0+IHYpLm1hcCgoW2ssIHZdKSA9PiAoeyBzbG90OiBrLCBuYW1lOiB2Lm5hbWUgfSkpIDogW10sCiAgICAgIG5lYXJieVBsYXllcnM6IE9iamVjdC5lbnRyaWVzKGJvdC5wbGF5ZXJzKS5tYXAoKFtuYW1lLCBwXSkgPT4gKHsKICAgICAgICBuYW1lLAogICAgICAgIHBvczogcC5lbnRpdHkgPyB7IHg6IE1hdGgucm91bmQocC5lbnRpdHkucG9zaXRpb24ueCksIHk6IE1hdGgucm91bmQocC5lbnRpdHkucG9zaXRpb24ueSksIHo6IE1hdGgucm91bmQocC5lbnRpdHkucG9zaXRpb24ueikgfSA6IG51bGwKICAgICAgfSkpLmZpbHRlcihwID0+IHAucG9zKSwKICAgICAgY3VycmVudEFjdGlvbjogY3VycmVudEFjdGlvbiA/IHsgdHlwZTogY3VycmVudEFjdGlvbi50eXBlLCBhdDogY3VycmVudEFjdGlvbi5hdCB9IDogbnVsbAogICAgfTsKICAgIGlmIChleHRyYSkgT2JqZWN0LmFzc2lnbihzdGF0dXMsIGV4dHJhKTsKICAgIGZzLndyaXRlRmlsZVN5bmMoQ09ORklHLnN0YXR1c0ZpbGUsIEpTT04uc3RyaW5naWZ5KHN0YXR1cywgbnVsbCwgMikpOwogIH0gY2F0Y2ggKGUpIHsKICAgIGxvZygnc3RhdHVzIHdyaXRlIGVycm9yOiAnICsgZS5tZXNzYWdlKTsKICB9Cn0KCmZ1bmN0aW9uIGFwcGVuZENoYXQodXNlcm5hbWUsIG1lc3NhZ2UpIHsKICB0cnkgewogICAgY29uc3QgbGluZSA9IEpTT04uc3RyaW5naWZ5KHsgdHM6IERhdGUubm93KCksIHVzZXI6IHVzZXJuYW1lLCBtc2c6IG1lc3NhZ2UgfSkgKyAnXG4nOwogICAgZnMuYXBwZW5kRmlsZVN5bmMoQ09ORklHLmNoYXRMb2dGaWxlLCBsaW5lKTsKICB9IGNhdGNoIChlKSB7fQp9Cgphc3luYyBmdW5jdGlvbiBleGVjdXRlQWN0aW9uKGFjdGlvbikgewogIGlmICghYm90KSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnbm90IGNvbm5lY3RlZCcgfTsKICBjdXJyZW50QWN0aW9uID0geyB0eXBlOiBhY3Rpb24uYWN0aW9uIHx8IGFjdGlvbi50eXBlLCBhdDogRGF0ZS5ub3coKSB9OwogIGNvbnN0IHR5cGUgPSBhY3Rpb24uYWN0aW9uIHx8IGFjdGlvbi50eXBlOwogIHRyeSB7CiAgICBzd2l0Y2ggKHR5cGUpIHsKICAgICAgY2FzZSAnc2F5JzogewogICAgICAgIGJvdC5jaGF0KFN0cmluZyhhY3Rpb24udGV4dCB8fCAnJykpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdzYXknIH07CiAgICAgIH0KICAgICAgY2FzZSAnbW92ZSc6IHsKICAgICAgICBjb25zdCBkaXIgPSBTdHJpbmcoYWN0aW9uLmRpcmVjdGlvbiB8fCBhY3Rpb24uZGlyIHx8ICdmb3J3YXJkJyk7CiAgICAgICAgY29uc3QgdGlja3MgPSBNYXRoLm1heCgxLCBNYXRoLm1pbigyMDAsIHBhcnNlSW50KGFjdGlvbi50aWNrcyB8fCBhY3Rpb24uZHVyYXRpb24gfHwgMTAsIDEwKSkpOwogICAgICAgIGNvbnN0IHZhbGlkID0gWydmb3J3YXJkJywgJ2JhY2snLCAnbGVmdCcsICdyaWdodCcsICdqdW1wJywgJ3NwcmludCcsICdzbmVhayddOwogICAgICAgIGlmICghdmFsaWQuaW5jbHVkZXMoZGlyKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2ludmFsaWQgZGlyZWN0aW9uOiAnICsgZGlyIH07CiAgICAgICAgYm90LnNldENvbnRyb2xTdGF0ZShkaXIsIHRydWUpOwogICAgICAgIGF3YWl0IGJvdC53YWl0Rm9yVGlja3ModGlja3MpOwogICAgICAgIGJvdC5zZXRDb250cm9sU3RhdGUoZGlyLCBmYWxzZSk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ21vdmUnLCBkaXJlY3Rpb246IGRpciwgdGlja3MgfTsKICAgICAgfQogICAgICBjYXNlICdsb29rJzogewogICAgICAgIGNvbnN0IHlhdyA9IHBhcnNlRmxvYXQoYWN0aW9uLnlhdyk7CiAgICAgICAgY29uc3QgcGl0Y2ggPSBhY3Rpb24ucGl0Y2ggIT0gbnVsbCA/IHBhcnNlRmxvYXQoYWN0aW9uLnBpdGNoKSA6IDA7CiAgICAgICAgaWYgKGlzTmFOKHlhdykpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdpbnZhbGlkIHlhdycgfTsKICAgICAgICBhd2FpdCBib3QubG9vayh5YXcsIHBpdGNoKTsKICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnbG9vaycsIHlhdywgcGl0Y2ggfTsKICAgICAgfQogICAgICBjYXNlICdsb29rQXQnOiB7CiAgICAgICAgY29uc3QgeCA9IHBhcnNlRmxvYXQoYWN0aW9uLngpLCB5ID0gcGFyc2VGbG9hdChhY3Rpb24ueSksIHogPSBwYXJzZUZsb2F0KGFjdGlvbi56KTsKICAgICAgICBpZiAoW3gsIHksIHpdLnNvbWUoaXNOYU4pKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaW52YWxpZCBjb29yZGluYXRlcycgfTsKICAgICAgICBhd2FpdCBib3QubG9va0F0KHZlYzMoeCwgeSwgeikpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdsb29rQXQnIH07CiAgICAgIH0KICAgICAgY2FzZSAnZGlnJzogewogICAgICAgIGNvbnN0IGJsb2NrID0gYm90LmJsb2NrQXRDdXJzb3IoNSk7CiAgICAgICAgaWYgKCFibG9jaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ25vIGJsb2NrIGluIHNpZ2h0JyB9OwogICAgICAgIGF3YWl0IGJvdC5kaWcoYmxvY2spOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdkaWcnLCBibG9jazogYmxvY2submFtZSB9OwogICAgICB9CiAgICAgIGNhc2UgJ2RpZ0F0JzogewogICAgICAgIGNvbnN0IHggPSBwYXJzZUludChhY3Rpb24ueCksIHkgPSBwYXJzZUludChhY3Rpb24ueSksIHogPSBwYXJzZUludChhY3Rpb24ueik7CiAgICAgICAgaWYgKFt4LCB5LCB6XS5zb21lKGlzTmFOKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ2ludmFsaWQgY29vcmRpbmF0ZXMnIH07CiAgICAgICAgY29uc3QgYmxvY2sgPSBib3QuYmxvY2tBdCh2ZWMzKHgsIHksIHopKTsKICAgICAgICBpZiAoIWJsb2NrKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnbm8gYmxvY2sgYXQgcG9zaXRpb24nIH07CiAgICAgICAgYXdhaXQgYm90LmRpZyhibG9jayk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2RpZ0F0JywgYmxvY2s6IGJsb2NrLm5hbWUsIHBvczogeyB4LCB5LCB6IH0gfTsKICAgICAgfQogICAgICBjYXNlICdwbGFjZSc6IHsKICAgICAgICBjb25zdCBibG9jayA9IGJvdC5ibG9ja0F0Q3Vyc29yKDUpOwogICAgICAgIGlmICghYmxvY2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdubyBibG9jayBpbiBzaWdodCB0byBwbGFjZSBhZ2FpbnN0JyB9OwogICAgICAgIGNvbnN0IGZhY2luZyA9IGFjdGlvbi5mYWNpbmcgfHwgJ3RvcCc7CiAgICAgICAgY29uc3QgZmFjZU1hcCA9IHsgdG9wOiAxLCBib3R0b206IDAsIG5vcnRoOiAyLCBzb3V0aDogMywgZWFzdDogNSwgd2VzdDogNCB9OwogICAgICAgIGF3YWl0IGJvdC5wbGFjZUJsb2NrKGJsb2NrLCBuZXcgdmVjMygwLCAwLCAwKSk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ3BsYWNlJyB9OwogICAgICB9CiAgICAgIGNhc2UgJ2F0dGFjayc6IHsKICAgICAgICBjb25zdCB0YXJnZXQgPSBib3QubmVhcmVzdEVudGl0eShlID0+IGUudHlwZSA9PT0gJ21vYicgfHwgZS50eXBlID09PSAncGxheWVyJyk7CiAgICAgICAgaWYgKCF0YXJnZXQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdubyBlbnRpdHkgdG8gYXR0YWNrJyB9OwogICAgICAgIGF3YWl0IGJvdC5hdHRhY2sodGFyZ2V0KTsKICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnYXR0YWNrJywgdGFyZ2V0OiB0YXJnZXQubmFtZSB8fCB0YXJnZXQudHlwZSB9OwogICAgICB9CiAgICAgIGNhc2UgJ2F0dGFja05lYXJlc3QnOiB7CiAgICAgICAgY29uc3QgZmlsdGVyID0gYWN0aW9uLmZpbHRlciB8fCAnbW9iJzsKICAgICAgICBjb25zdCB0YXJnZXQgPSBib3QubmVhcmVzdEVudGl0eShlID0+IGUudHlwZSA9PT0gZmlsdGVyIHx8IChmaWx0ZXIgPT09ICdwbGF5ZXInICYmIGUudHlwZSA9PT0gJ3BsYXllcicpKTsKICAgICAgICBpZiAoIXRhcmdldCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ25vICcgKyBmaWx0ZXIgKyAnIG5lYXJieScgfTsKICAgICAgICBhd2FpdCBib3QuYXR0YWNrKHRhcmdldCk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2F0dGFja05lYXJlc3QnLCB0YXJnZXQ6IHRhcmdldC5uYW1lIHx8IHRhcmdldC50eXBlIH07CiAgICAgIH0KICAgICAgY2FzZSAnYWN0aXZhdGUnOiB7CiAgICAgICAgYm90LmFjdGl2YXRlSXRlbSgpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdhY3RpdmF0ZScgfTsKICAgICAgfQogICAgICBjYXNlICdkZWFjdGl2YXRlJzogewogICAgICAgIGJvdC5kZWFjdGl2YXRlSXRlbSgpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdkZWFjdGl2YXRlJyB9OwogICAgICB9CiAgICAgIGNhc2UgJ2VxdWlwJzogewogICAgICAgIGNvbnN0IGl0ZW1OYW1lID0gU3RyaW5nKGFjdGlvbi5pdGVtIHx8ICcnKTsKICAgICAgICBjb25zdCBpdGVtID0gYm90LmludmVudG9yeS5pdGVtcygpLmZpbmQoaSA9PiBpLm5hbWUuaW5jbHVkZXMoaXRlbU5hbWUpKTsKICAgICAgICBpZiAoIWl0ZW0pIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdpdGVtIG5vdCBmb3VuZDogJyArIGl0ZW1OYW1lIH07CiAgICAgICAgYXdhaXQgYm90LmVxdWlwKGl0ZW0sIGFjdGlvbi5oYW5kIHx8ICdoYW5kJyk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ2VxdWlwJywgaXRlbTogaXRlbS5uYW1lIH07CiAgICAgIH0KICAgICAgY2FzZSAndG9zcyc6IHsKICAgICAgICBjb25zdCBpdGVtTmFtZSA9IFN0cmluZyhhY3Rpb24uaXRlbSB8fCAnJyk7CiAgICAgICAgY29uc3QgaXRlbSA9IGJvdC5pbnZlbnRvcnkuaXRlbXMoKS5maW5kKGkgPT4gaS5uYW1lLmluY2x1ZGVzKGl0ZW1OYW1lKSk7CiAgICAgICAgaWYgKCFpdGVtKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaXRlbSBub3QgZm91bmQ6ICcgKyBpdGVtTmFtZSB9OwogICAgICAgIGF3YWl0IGJvdC50b3NzKGl0ZW0udHlwZSwgbnVsbCwgYWN0aW9uLmNvdW50IHx8IGl0ZW0uY291bnQpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICd0b3NzJywgaXRlbTogaXRlbS5uYW1lIH07CiAgICAgIH0KICAgICAgY2FzZSAncGF0aGZpbmQnOiB7CiAgICAgICAgY29uc3QgeCA9IHBhcnNlRmxvYXQoYWN0aW9uLngpLCB5ID0gcGFyc2VGbG9hdChhY3Rpb24ueSksIHogPSBwYXJzZUZsb2F0KGFjdGlvbi56KTsKICAgICAgICBpZiAoW3gsIHksIHpdLnNvbWUoaXNOYU4pKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnaW52YWxpZCBjb29yZGluYXRlcycgfTsKICAgICAgICBjb25zdCBtY0RhdGEgPSByZXF1aXJlKCdtaW5lY3JhZnQtZGF0YScpKGJvdC52ZXJzaW9uKTsKICAgICAgICBjb25zdCBtb3ZlbWVudHMgPSBuZXcgTW92ZW1lbnRzKGJvdCwgbWNEYXRhKTsKICAgICAgICBib3QucGF0aGZpbmRlci5zZXRNb3ZlbWVudHMobW92ZW1lbnRzKTsKICAgICAgICBjb25zdCBnb2FsID0gbmV3IGdvYWxzLkdvYWxCbG9jayhNYXRoLmZsb29yKHgpLCBNYXRoLmZsb29yKHkpLCBNYXRoLmZsb29yKHopKTsKICAgICAgICBhd2FpdCBib3QucGF0aGZpbmRlci5nb3RvKGdvYWwpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdwYXRoZmluZCcsIHRhcmdldDogeyB4LCB5LCB6IH0gfTsKICAgICAgfQogICAgICBjYXNlICdwYXRoZmluZFRvUGxheWVyJzogewogICAgICAgIGNvbnN0IHRhcmdldE5hbWUgPSBTdHJpbmcoYWN0aW9uLnBsYXllciB8fCAnJyk7CiAgICAgICAgY29uc3QgcGxheWVyID0gYm90LnBsYXllcnNbdGFyZ2V0TmFtZV07CiAgICAgICAgaWYgKCFwbGF5ZXIgfHwgIXBsYXllci5lbnRpdHkpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdwbGF5ZXIgbm90IGZvdW5kOiAnICsgdGFyZ2V0TmFtZSB9OwogICAgICAgIGNvbnN0IG1jRGF0YSA9IHJlcXVpcmUoJ21pbmVjcmFmdC1kYXRhJykoYm90LnZlcnNpb24pOwogICAgICAgIGNvbnN0IG1vdmVtZW50cyA9IG5ldyBNb3ZlbWVudHMoYm90LCBtY0RhdGEpOwogICAgICAgIGJvdC5wYXRoZmluZGVyLnNldE1vdmVtZW50cyhtb3ZlbWVudHMpOwogICAgICAgIGNvbnN0IGdvYWwgPSBuZXcgZ29hbHMuR29hbEZvbGxvdyhwbGF5ZXIuZW50aXR5LCAyKTsKICAgICAgICBhd2FpdCBib3QucGF0aGZpbmRlci5nb3RvKGdvYWwpOwogICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246ICdwYXRoZmluZFRvUGxheWVyJywgcGxheWVyOiB0YXJnZXROYW1lIH07CiAgICAgIH0KICAgICAgY2FzZSAnc3RvcCc6IHsKICAgICAgICBpZiAoYm90LnBhdGhmaW5kZXIpIGJvdC5wYXRoZmluZGVyLnNldEdvYWwobnVsbCk7CiAgICAgICAgWydmb3J3YXJkJywgJ2JhY2snLCAnbGVmdCcsICdyaWdodCcsICdqdW1wJywgJ3NwcmludCcsICdzbmVhayddLmZvckVhY2goYyA9PiBib3Quc2V0Q29udHJvbFN0YXRlKGMsIGZhbHNlKSk7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ3N0b3AnIH07CiAgICAgIH0KICAgICAgY2FzZSAnanVtcCc6IHsKICAgICAgICBib3Quc2V0Q29udHJvbFN0YXRlKCdqdW1wJywgdHJ1ZSk7CiAgICAgICAgYXdhaXQgYm90LndhaXRGb3JUaWNrcygxMCk7CiAgICAgICAgYm90LnNldENvbnRyb2xTdGF0ZSgnanVtcCcsIGZhbHNlKTsKICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiAnanVtcCcgfTsKICAgICAgfQogICAgICBjYXNlICdzdGF0dXMnOiB7CiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogJ3N0YXR1cycgfTsKICAgICAgfQogICAgICBkZWZhdWx0OgogICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICd1bmtub3duIGFjdGlvbjogJyArIHR5cGUgfTsKICAgIH0KICB9IGNhdGNoIChlKSB7CiAgICByZXR1cm4geyBvazogZmFsc2UsIGFjdGlvbjogdHlwZSwgZXJyb3I6IGUubWVzc2FnZSB9OwogIH0gZmluYWxseSB7CiAgICBjdXJyZW50QWN0aW9uID0gbnVsbDsKICB9Cn0KCmZ1bmN0aW9uIGNvbm5lY3QoKSB7CiAgbG9nKGBDb25uZWN0aW5nIHRvICR7Q09ORklHLmhvc3R9OiR7Q09ORklHLnBvcnR9IGFzICR7Q09ORklHLnVzZXJuYW1lfS4uLmApOwogIGJvdCA9IG1pbmVmbGF5ZXIuY3JlYXRlQm90KHsKICAgIGhvc3Q6IENPTkZJRy5ob3N0LAogICAgcG9ydDogQ09ORklHLnBvcnQsCiAgICB1c2VybmFtZTogQ09ORklHLnVzZXJuYW1lLAogICAgaGlkZUVycm9yczogZmFsc2UKICB9KTsKCiAgYm90LmxvYWRQbHVnaW4ocGF0aGZpbmRlcik7CgogIGJvdC5vbignc3Bhd24nLCAoKSA9PiB7CiAgICBsb2coJ1NwYXduZWQgaW4gd29ybGQnKTsKICAgIHdyaXRlU3RhdHVzKHsgZXZlbnQ6ICdzcGF3bicgfSk7CiAgfSk7CgogIGJvdC5vbignY2hhdCcsICh1c2VybmFtZSwgbWVzc2FnZSkgPT4gewogICAgYXBwZW5kQ2hhdCh1c2VybmFtZSwgbWVzc2FnZSk7CiAgICBsb2coYFtDSEFUXSAke3VzZXJuYW1lfTogJHttZXNzYWdlfWApOwogIH0pOwoKICBib3Qub24oJ3BsYXllckpvaW5lZCcsIChwbGF5ZXIpID0+IHsKICAgIGxvZyhgUGxheWVyIGpvaW5lZDogJHtwbGF5ZXIudXNlcm5hbWV9YCk7CiAgfSk7CgogIGJvdC5vbigncGxheWVyTGVmdCcsIChwbGF5ZXIpID0+IHsKICAgIGxvZyhgUGxheWVyIGxlZnQ6ICR7cGxheWVyLnVzZXJuYW1lfWApOwogIH0pOwoKICBib3Qub24oJ2hlYWx0aCcsICgpID0+IHsKICAgIHdyaXRlU3RhdHVzKCk7CiAgfSk7CgogIGJvdC5vbignZGVhdGgnLCAoKSA9PiB7CiAgICBsb2coJ0RpZWQnKTsKICAgIHdyaXRlU3RhdHVzKHsgZXZlbnQ6ICdkZWF0aCcgfSk7CiAgfSk7CgogIGJvdC5vbigna2lja2VkJywgKHJlYXNvbikgPT4gewogICAgbG9nKCdLaWNrZWQ6ICcgKyByZWFzb24pOwogICAgd3JpdGVTdGF0dXMoeyBldmVudDogJ2tpY2tlZCcsIHJlYXNvbjogU3RyaW5nKHJlYXNvbikgfSk7CiAgfSk7CgogIGJvdC5vbignZXJyb3InLCAoZXJyKSA9PiB7CiAgICBsb2coJ0Vycm9yOiAnICsgZXJyLm1lc3NhZ2UpOwogIH0pOwoKICBib3Qub24oJ2VuZCcsICgpID0+IHsKICAgIGxvZygnRGlzY29ubmVjdGVkJyk7CiAgICBib3QgPSBudWxsOwogICAgd3JpdGVTdGF0dXMoeyBjb25uZWN0ZWQ6IGZhbHNlLCBldmVudDogJ2VuZCcgfSk7CiAgICBzZXRUaW1lb3V0KGNvbm5lY3QsIDUwMDApOwogIH0pOwp9CgovLyDkuLvlvqrnjq/vvJror7vlj5bmjIfku6Tmlofku7blubbmiafooYwKYXN5bmMgZnVuY3Rpb24gbWFpbkxvb3AoKSB7CiAgaWYgKCFib3QpIHsKICAgIHNldFRpbWVvdXQobWFpbkxvb3AsIDUwMCk7CiAgICByZXR1cm47CiAgfQogIHRyeSB7CiAgICBjb25zdCBjbWQgPSBzYWZlUmVhZEpzb24oQ09ORklHLmNtZEZpbGUpOwogICAgaWYgKGNtZCAmJiBjbWQuYWN0aW9uKSB7CiAgICAgIGxvZygnRXhlY3V0aW5nOiAnICsgY21kLmFjdGlvbik7CiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVBY3Rpb24oY21kKTsKICAgICAgbG9nKCdSZXN1bHQ6ICcgKyBKU09OLnN0cmluZ2lmeShyZXN1bHQpKTsKICAgICAgLy8g5YaZ5YWl57uT5p6c5bm25Yig6Zmk5oyH5Luk5paH5Lu2CiAgICAgIGNvbnN0IHJlc3VsdEZpbGUgPSBDT05GSUcuY21kRmlsZS5yZXBsYWNlKC9cLmpzb24kLywgJy5yZXN1bHQuanNvbicpOwogICAgICBmcy53cml0ZUZpbGVTeW5jKHJlc3VsdEZpbGUsIEpTT04uc3RyaW5naWZ5KHsgdHM6IERhdGUubm93KCksIHJlc3VsdCB9KSk7CiAgICAgIHRyeSB7IGZzLnVubGlua1N5bmMoQ09ORklHLmNtZEZpbGUpOyB9IGNhdGNoIChlKSB7fQogICAgICB3cml0ZVN0YXR1cyh7IGxhc3RSZXN1bHQ6IHJlc3VsdCB9KTsKICAgIH0gZWxzZSB7CiAgICAgIHdyaXRlU3RhdHVzKCk7CiAgICB9CiAgfSBjYXRjaCAoZSkgewogICAgbG9nKCdMb29wIGVycm9yOiAnICsgZS5tZXNzYWdlKTsKICB9CiAgc2V0VGltZW91dChtYWluTG9vcCwgMjAwKTsKfQoKY29ubmVjdCgpOwpzZXRUaW1lb3V0KG1haW5Mb29wLCAxMDAwKTsK\"; const cmd = \"cd ~/mc-bot && echo \" + b64 + \" | base64 -d > bot.js && cat > bot.env << ENVEOF\\n\" + \"export MC_HOST=\" + host + \"\\n\" + \"export MC_PORT=\" + port + \"\\n\" + \"export MC_USERNAME=\" + name + \"\\n\" + \"export MC_CMD_FILE=$HOME/mc-bot/cmd.json\\n\" + \"export MC_STATUS_FILE=$HOME/mc-bot/status.json\\n\" + \"export MC_CHAT_FILE=$HOME/mc-bot/chat.log\\n\" + \"ENVEOF\"; return await t.call(\"run_termux_job\", {executor:\"bash\", args:[\"-c\", cmd]}); }"
      },
      {
        "name": "minecraft_download_server",
        "description": "下载 Minecraft Bedrock Dedicated Server 到 Termux。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "version": {
              "type": "string",
              "description": "版本号，如 1.21.0；留空用最新"
            }
          },
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const ver = args.version || '1.21.0.03'; return await t.call('run_termux_job', {executor:'bash', args:['-c', 'cd ~ && mkdir -p mc-server && cd mc-server && curl -L -o bds.zip https://minecraft.azureedge.net/bin-linux/bedrock-server-'+ver+'.zip && unzip -o bds.zip && chmod +x bedrock_server']}); }"
      },
      {
        "name": "minecraft_start_server",
        "description": "启动 Minecraft Bedrock 服务器。返回 runId。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "port": {
              "type": "integer",
              "description": "端口，默认 19132"
            }
          },
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const port = args.port || 19132; return await t.call('run_termux_job', {executor:'bash', args:['-c', 'cd ~/mc-server && export LD_LIBRARY_PATH=. && ./bedrock_server --port '+port]}); }"
      },
      {
        "name": "minecraft_server_status",
        "description": "查询服务器状态和最近日志。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "runId": {
              "type": "string"
            }
          },
          "required": [
            "runId"
          ]
        },
        "kind": "js",
        "code": "async function run(args, ctx){ return await ctx.hostTools.call('termux_job_status', {runId: args.runId}); }"
      },
      {
        "name": "minecraft_stop_server",
        "description": "停止 Minecraft 服务器。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "runId": {
              "type": "string"
            }
          },
          "required": [
            "runId"
          ]
        },
        "kind": "js",
        "code": "async function run(args, ctx){ return await ctx.hostTools.call('termux_job_cancel', {runId: args.runId}); }"
      },
      {
        "name": "minecraft_start_bot",
        "description": "启动 Mineflayer bot 连接到服务器。返回 runId。bot 启动后会创建状态文件，等待指令。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; return await t.call('run_termux_job', {executor:'bash', args:['-c', 'cd ~/mc-bot && source bot.env && node bot.js']}); }"
      },
      {
        "name": "minecraft_bot_command",
        "description": "向 bot 发送一条结构化指令。支持的 action：say(发消息)、move(移动)、look(转头)、dig(挖眼前方块)、digAt(挖指定坐标)、place(放置)、attack(攻击最近)、activate(使用物品)、equip(装备)、pathfind(寻路到坐标)、pathfindToPlayer(跟随玩家)、stop(停止)、jump(跳跃)。指令会被执行并返回结果。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "description": "动作类型"
            },
            "text": {
              "type": "string",
              "description": "say 的消息内容"
            },
            "direction": {
              "type": "string",
              "enum": [
                "forward",
                "back",
                "left",
                "right",
                "jump",
                "sprint",
                "sneak"
              ],
              "description": "move 的方向"
            },
            "ticks": {
              "type": "integer",
              "description": "move 持续的 tick 数"
            },
            "yaw": {
              "type": "number",
              "description": "look 的水平角度"
            },
            "pitch": {
              "type": "number",
              "description": "look 的垂直角度"
            },
            "x": {
              "type": "number",
              "description": "坐标 x"
            },
            "y": {
              "type": "number",
              "description": "坐标 y"
            },
            "z": {
              "type": "number",
              "description": "坐标 z"
            },
            "item": {
              "type": "string",
              "description": "equip/toss 的物品名"
            },
            "player": {
              "type": "string",
              "description": "pathfindToPlayer 的玩家名"
            }
          },
          "required": [
            "action"
          ]
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const cmd = JSON.stringify(args); const r1 = await t.call('run_termux_job', {executor:'bash', args:['-c', 'cat > ~/mc-bot/cmd.json << \\'CMDEOF\\'\\n'+cmd+'\\nCMDEOF\\nrm -f ~/mc-bot/cmd.result.json']}); if (!r1.ok) return r1; for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 500)); const st = await t.call('termux_job_status', {runId: r1.runId}); const out = st.output || ''; if (out.indexOf('Result:') >= 0) { const m = out.match(/Result: (\\{[\\s\\S]*?\\})/); if (m) return { ok: true, result: JSON.parse(m[1]) }; } } const st2 = await t.call('termux_job_status', {runId: r1.runId}); return { ok: false, error: 'timeout', output: st2.output }; }"
      },
      {
        "name": "minecraft_bot_status",
        "description": "读取 bot 的当前状态：位置、血量、饥饿、背包、附近玩家、当前动作。从状态文件读取。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const r = await t.call('run_termux_job', {executor:'bash', args:['-c', 'cat ~/mc-bot/status.json 2>/dev/null || echo \\'{\"connected\":false}\\'']}); if (r.ok) { try { const out = r.output || r.stdout || ''; const m = out.match(/\\{[\\s\\S]*\\}/); if (m) return { ok: true, status: JSON.parse(m[0]) }; } catch(e){} return { ok: false, error: 'parse failed', raw: r.output || r.stdout }; } return r; }"
      },
      {
        "name": "minecraft_bot_chat",
        "description": "读取 bot 记录的最近聊天消息。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "lines": {
              "type": "integer",
              "description": "读取最后 N 行，默认 20"
            }
          },
          "required": []
        },
        "kind": "js",
        "code": "async function run(args, ctx){ const t = ctx.hostTools; const n = args.lines || 20; const r = await t.call('run_termux_job', {executor:'bash', args:['-c', 'tail -n '+n+' ~/mc-bot/chat.log 2>/dev/null || echo \\'no chat\\'']}); return r; }"
      },
      {
        "name": "minecraft_bot_stop",
        "description": "停止 Mineflayer bot。",
        "permissions": [
          "termux"
        ],
        "parameters": {
          "type": "object",
          "properties": {
            "runId": {
              "type": "string"
            }
          },
          "required": [
            "runId"
          ]
        },
        "kind": "js",
        "code": "async function run(args, ctx){ return await ctx.hostTools.call('termux_job_cancel', {runId: args.runId}); }"
      }
    ]
  }
];

refreshSystemPrompt();
sSet('via_ai_history', history);
let transCache = sGet('via_ai_trans', {}) || {};
let favorites = sGet('via_ai_favs', []) || [];
let sending = false;
let stopRequested = false;
let ACTIVE_RUN_TASK_ID = '';

