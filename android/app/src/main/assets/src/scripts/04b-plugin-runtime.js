/* ==========================================================
 *  E3 开放式插件运行时（0.10）
 *
 *  宿主只提供原语：
 *    surface  —— 插件注册页面/入口/会话类型/命令/事件/任务/设置/模板/适配器
 *    component —— 声明式组件树（插件不写 HTML/CSS/JS）
 *    action   —— 宿主校验权限后执行的通用动作
 *    event    —— 事件总线
 *    host     —— 受控 Host API
 *  插件清单 v2 的功能全部由 surfaces 描述，宿主不预设插件类型。
 *  v1 清单（tools）继续按原样工作，不迁移也能运行。
 * ========================================================== */

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
const PLUG_CONFIG_KEY = 'via_ai_plugin_config';
const PLUG_STATE_KEY = 'via_ai_plugin_state';
const PLUG_JOBS_KEY = 'via_ai_plugin_jobs';
const PLUG_THEME_KEY = 'via_ai_theme';
const PLUG_PAGE_VIEW = 'plug-page';
const PLUG_MAX_TREE_DEPTH = 12;
const PLUG_MAX_TREE_NODES = 300;

const PLUG_ACTION_REFS = Object.create(null);
let PLUG_ACTION_SEQ = 0;
const PLUG_RATE = Object.create(null);
const PLUG_RATE_LIMIT = 30;
const PLUG_RATE_WINDOW_MS = 60000;
let PLUG_PAGE_CTX = { pluginId: '', surfaceId: '', mode: 'page' };

/** 运行时转义：不依赖 DOM，组件树/配置表单在任何环境都能得到一致结果。 */
function plugEsc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function plugSafeId(v) { const s = String(v == null ? '' : v).trim(); return PLUG_SURFACE_ID_RE.test(s) ? s : ''; }
function plugPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function plugJsonSafe(v, depth) {
  if (depth > 6) return null;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plugJsonSafe(x, depth + 1));
  if (!plugPlainObject(v)) return null;
  const out = {};
  Object.keys(v).slice(0, 100).forEach(k => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
    out[String(k).slice(0, 64)] = plugJsonSafe(v[k], depth + 1);
  });
  return out;
}

/* ---------------- 配置 Schema ---------------- */
function plugNormalizeField(f) {
  if (!plugPlainObject(f)) return null;
  const key = plugSafeId(f.key || f.name);
  if (!key) return null;
  const type = PLUG_CONFIG_TYPES.indexOf(String(f.type || '')) >= 0 ? String(f.type) : 'string';
  const out = {
    key, type,
    label: String(f.label || f.title || key).slice(0, 80),
    desc: String(f.desc || f.description || '').slice(0, 300),
    placeholder: String(f.placeholder || '').slice(0, 120),
    default: plugJsonSafe(f.default, 0),
    required: f.required === true
  };
  if (type === 'enum') {
    out.options = (Array.isArray(f.options) ? f.options : []).slice(0, 50)
      .map(o => (plugPlainObject(o)
        ? { value: String(o.value == null ? '' : o.value).slice(0, 80), label: String(o.label || o.value || '').slice(0, 80) }
        : { value: String(o == null ? '' : o).slice(0, 80), label: String(o == null ? '' : o).slice(0, 80) }))
      .filter(o => o.value !== '');
  }
  if (type === 'number') {
    out.min = Number.isFinite(Number(f.min)) ? Number(f.min) : null;
    out.max = Number.isFinite(Number(f.max)) ? Number(f.max) : null;
  }
  return out;
}
function plugNormalizeConfig(cfg) {
  const src = Array.isArray(cfg) ? { fields: cfg } : (plugPlainObject(cfg) ? cfg : {});
  const fields = (Array.isArray(src.fields) ? src.fields : (Array.isArray(src.schema) ? src.schema : []))
    .slice(0, 80).map(plugNormalizeField).filter(Boolean);
  return { version: Math.max(1, parseInt(src.schemaVersion || src.version, 10) || 1), fields };
}

/* ---------------- surface / action 规整 ---------------- */
function plugNormalizeAction(a, declared) {
  if (!plugPlainObject(a)) return null;
  const type = PLUG_ACTION_TYPES.indexOf(String(a.type || '')) >= 0 ? String(a.type) : '';
  if (!type) return null;
  const permissions = Array.isArray(a.permissions) ? plugNormalizePermissions(a.permissions) : [];
  if (permissions.some(p => declared.indexOf(p) < 0)) return null;
  const out = { type, permissions, confirm: a.confirm === true || typeof a.confirm === 'string' ? String(a.confirm || '').slice(0, 200) : '' };
  ['target', 'page', 'to', 'view', 'tool', 'key', 'path', 'value', 'text', 'url', 'session', 'job', 'message',
    'label', 'okText', 'title', 'sid', 'theme', 'scope', 'mount', 'mode'].forEach(k => {
    if (a[k] !== undefined) out[k] = plugJsonSafe(a[k], 0);
  });
  if (a.args !== undefined) out.args = plugJsonSafe(a.args, 0);
  return out;
}
function plugNormalizeSurface(s, declared) {
  if (!plugPlainObject(s)) return null;
  const type = PLUG_SURFACE_TYPES.indexOf(String(s.type || '')) >= 0 ? String(s.type) : '';
  const id = plugSafeId(s.id);
  if (!type || !id) return null;
  const permissions = Array.isArray(s.permissions) ? plugNormalizePermissions(s.permissions) : [];
  if (permissions.some(p => declared.indexOf(p) < 0)) return null;
  const out = {
    type, id,
    title: String(s.title || s.name || id).slice(0, 80),
    icon: String(s.icon || '').slice(0, 4),
    desc: String(s.desc || s.description || '').slice(0, 300),
    sort: Number.isFinite(Number(s.sort)) ? Number(s.sort) : 100,
    permissions,
    action: plugNormalizeAction(s.action, declared)
  };
  if (type === 'page') {
    out.tree = plugJsonSafe(s.tree, 0);
    out.renderer = String(s.renderer || '').slice(0, 64);
    out.style = plugNormalizeStyle(s.style);
  } else if (type === 'entry') {
    out.mount = PLUG_ENTRY_MOUNTS.indexOf(String(s.mount || '')) >= 0 ? String(s.mount) : 'plugins';
    out.tree = plugJsonSafe(s.tree, 0);
    out.renderer = String(s.renderer || '').slice(0, 64);
    out.when = ['always', 'chat', 'session'].indexOf(String(s.when || '')) >= 0 ? String(s.when) : 'always';
    out.style = plugNormalizeStyle(s.style);
  } else if (type === 'sessionType') {
    out.prompt = String(s.prompt || s.systemPrompt || '').slice(0, 4000);
    out.opening = String(s.opening || s.greeting || '').slice(0, 2000);
    out.stateSchema = plugJsonSafe(s.stateSchema, 0);
    out.endWhen = String(s.endWhen || '').slice(0, 200);
    out.renderer = String(s.renderer || s.template || '').slice(0, 64);
    out.deletable = s.deletable !== false;
    out.vars = plugJsonSafe(s.vars, 0);
  } else if (type === 'command') {
    const cmd = String(s.command || '').trim();
    if (!/^\/[A-Za-z0-9_-]{1,32}$/.test(cmd)) return null;
    out.command = cmd;
  } else if (type === 'event') {
    const on = String(s.on || '').trim();
    if (on !== '*' && PLUG_EVENT_NAMES.indexOf(on) < 0) return null;
    out.on = on;
  } else if (type === 'job') {
    const every = Math.max(10, Math.min(86400, parseInt(s.every || (s.schedule && s.schedule.every), 10) || 60));
    out.every = every;
  } else if (type === 'settings') {
    out.config = plugNormalizeConfig(s.schema || s.config);
  } else if (type === 'renderer') {
    out.tree = plugJsonSafe(s.tree, 0);
  } else if (type === 'theme') {
    out.tokens = plugNormalizeThemeTokens(s.tokens || s.style);
    out.background = plugSafeImage(s.background);
    out.dark = s.dark === true;
  } else if (type === 'adapter') {
    out.kind = ['model', 'gateway', 'files', 'media'].indexOf(String(s.kind || '')) >= 0 ? String(s.kind) : 'model';
  }
  return out;
}
function plugManifestV2Error(raw) {
  if (typeof raw.apiVersion !== 'string' || !raw.apiVersion.trim()) return 'v2 清单缺少 apiVersion';
  if (!Array.isArray(raw.permissions)) return 'v2 清单必须显式声明 permissions 数组';
  if (plugHasUnknownPermissions(raw.permissions)) return 'permissions 含有未知能力';
  if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) return 'dependencies 必须是数组';
  if (Array.isArray(raw.dependencies) && raw.dependencies.length > 40) return 'dependencies 最多 40 项';
  if (raw.models !== undefined && !plugPlainObject(raw.models)) return 'models 必须是对象';
  if (!Array.isArray(raw.surfaces) || !raw.surfaces.length) return 'v2 清单至少需要一个 surface';
  if (raw.surfaces.length > 80) return 'surfaces 最多 80 项';
  const declared = plugNormalizePermissions(raw.permissions);
  const seen = {};
  for (const s of raw.surfaces) {
    if (!plugPlainObject(s)) return 'surface 定义无效';
    if (PLUG_SURFACE_TYPES.indexOf(String(s.type || '')) < 0) return '未知 surface 类型：' + String(s.type || '');
    const id = plugSafeId(s.id);
    if (!id) return 'surface id 无效：' + String(s.id || '');
    if (!plugNormalizeSurface(s, declared)) return 'surface ' + id + ' 声明无效（检查权限/命令/事件/动作）';
    if (seen[s.type + ':' + id]) return 'surface 重复：' + s.type + ':' + id;
    seen[s.type + ':' + id] = true;
  }
  return '';
}

/* ---------------- 注册表 ---------------- */
function plugStateOf(p) { return (p && (p.enabled === false || p.state === 'disabled')) ? 'disabled' : (p && p.state) || 'installed'; }
function plugPluginSurfaces(plugin, type) {
  if (!plugin || !Array.isArray(plugin.surfaces)) return [];
  return plugin.surfaces.filter(s => !type || s.type === type)
    .sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));
}
/** 跨插件注册表：只返回已启用插件；按插件启用状态与 surface sort 排序。 */
function plugSurfaceList(type) {
  const out = [];
  USER_PLUGINS.forEach(p => {
    if (plugStateOf(p) === 'disabled') return;
    plugPluginSurfaces(p, type).forEach(s => out.push({ plugin: p, surface: s }));
  });
  return out;
}
function plugSurfaceFind(type, id, pluginId) {
  const list = plugSurfaceList(type);
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].surface.id) !== String(id)) continue;
    if (pluginId && list[i].plugin.id !== pluginId) continue;
    return list[i];
  }
  return null;
}
function plugSurfaceEnabled(plugin, surface) {
  if (!plugin || !surface) return false;
  if (plugStateOf(plugin) === 'disabled') return false;
  if (!Array.isArray(surface.permissions) || !surface.permissions.length) return true;
  return surface.permissions.every(p => plugPermissionGranted(plugin, p));
}

/* ---------------- 生命周期 / 事件 ---------------- */
function plugLifecycle(plugin, phase, payload) {
  if (!plugin) return false;
  const p = String(phase || '');
  if (p === 'uninstall') {
    plugStateClear(plugin);
    plugConfigClear(plugin);
    const jobs = sGet(PLUG_JOBS_KEY, {}) || {};
    delete jobs[plugin.id];
    sSet(PLUG_JOBS_KEY, jobs);
    plugThemeClearPlugin(plugin.id);
    // 删除该插件创建的会话，避免卸载后留下无法归属的任务。
    try {
      const doomed = (typeof TASKS !== 'undefined' ? TASKS : []).filter(t => t && t.pluginSession && t.pluginSession.pluginId === plugin.id);
      if (doomed.length) {
        const ids = doomed.map(t => t.id);
        doomed.forEach(t => {
          const i = TASKS.indexOf(t);
          if (i >= 0) TASKS.splice(i, 1);
          try { sSet(taskHistoryKey(t.id), []); } catch (e) {}
        });
        if (ids.indexOf(CURRENT_TASK_ID) >= 0) {
          const chat = TASKS.filter(t => t.type === 'chat')[0];
          CURRENT_TASK_ID = chat ? chat.id : '';
          if (chat) taskLoadContext(chat);
        }
        saveTasks();
        plugAudit('session_cleanup', plugin, { tool: String(ids.length) });
      }
    } catch (e) {}
  }
  plugAudit('lifecycle_' + p, plugin, { tool: (payload && payload.surface) || '' });
  if (p === 'enable' || p === 'disable') {
    plugEmit('plugin.' + p, { pluginId: plugin.id });
  }
  return true;
}
function plugEmit(event, payload) {
  const name = String(event || '');
  if (!name) return 0;
  let n = 0;
  plugSurfaceList('event').forEach(entry => {
    const s = entry.surface;
    if (s.on !== '*' && s.on !== name && s.on !== name.split('.')[0]) return;
    if (!s.action) return;
    n++;
    Promise.resolve().then(() => plugRunAction(entry.plugin, s.action, { event: name, payload: plugJsonSafe(payload, 0) }))
      .catch(e => plugAudit('event_error', entry.plugin, { tool: s.id }));
    if (name.indexOf('message.') === 0) { /* 只在事件层面通知，不改聊天主路径 */ }
  });
  return n;
}

/* ---------------- 私有存储 ---------------- */
function plugStateAll() { const all = sGet(PLUG_STATE_KEY, {}); return plugPlainObject(all) ? all : {}; }
function plugStateGet(plugin) {
  if (!plugin) return {};
  const all = plugStateAll();
  const version = plugin.configVersion || 1;
  const entry = plugPlainObject(all[plugin.id]) ? all[plugin.id] : null;
  if (entry && (parseInt(entry.version, 10) || 1) === version && plugPlainObject(entry.data)) return entry.data;
  if (entry) {
    // Schema 版本变化：0.10 只做安全重置并留审计，插件数据不会被串到新版本。
    plugAudit('state_migrated', plugin, { tool: 'v' + (entry.version || 1) + '->v' + version });
  }
  const fresh = { version, data: {} };
  all[plugin.id] = fresh;
  sSet(PLUG_STATE_KEY, all);
  return fresh.data;
}
function plugStateSave(plugin, data) {
  const all = plugStateAll();
  all[plugin.id] = { version: plugin.configVersion || 1, data: plugJsonSafe(data, 0) || {} };
  sSet(PLUG_STATE_KEY, all);
}
function plugStateSet(plugin, path, value) {
  if (!plugin) return false;
  const key = String(path || '').trim();
  if (!key || key.length > 80) return false;
  const data = plugStateGet(plugin);
  const parts = key.split('.').filter(Boolean);
  if (!parts.length || parts.some(x => x === '__proto__' || x === 'constructor' || x === 'prototype')) return false;
  let cur = data;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!plugPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = plugJsonSafe(value, 0);
  const text = JSON.stringify(data);
  if (text.length > 200000) return false;
  plugStateSave(plugin, data);
  return true;
}
function plugStateClear(plugin) {
  if (!plugin) return;
  const all = plugStateAll();
  delete all[plugin.id];
  sSet(PLUG_STATE_KEY, all);
}
function plugStorageExport(plugin) {
  if (!plugin) return '{}';
  return JSON.stringify({ pluginId: plugin.id, version: plugin.configVersion || 1, data: plugStateGet(plugin) });
}
function plugConfigAll() { const all = sGet(PLUG_CONFIG_KEY, {}); return plugPlainObject(all) ? all : {}; }
function plugConfigGet(plugin) {
  if (!plugin) return {};
  const all = plugConfigAll();
  const data = plugPlainObject(all[plugin.id]) ? all[plugin.id] : {};
  const out = {};
  (plugin.configFields || []).forEach(f => {
    if (f.type === 'secret') {
      if (secretStore.ok && secretStore.get(plugSecretName(plugin.id, f.key), '')) out[f.key] = '••••••';
    } else if (Object.prototype.hasOwnProperty.call(data, f.key)) {
      out[f.key] = data[f.key];
    } else if (f.default !== null && f.default !== undefined) {
      out[f.key] = f.default;
    }
  });
  return out;
}
function plugSecretName(pid, key) { return 'plugin.' + String(pid || '') + '.' + String(key || ''); }
function plugConfigClear(plugin) {
  if (!plugin) return;
  const all = plugConfigAll();
  delete all[plugin.id];
  sSet(PLUG_CONFIG_KEY, all);
  (plugin.configFields || []).forEach(f => {
    if (f.type !== 'secret') return;
    try { if (secretStore.ok) secretStore.del(plugSecretName(plugin.id, f.key)); } catch (e) {}
  });
}
function plugConfigSet(plugin, key, value) {
  if (!plugin) return { ok: false, error: '插件不存在' };
  const field = (plugin.configFields || []).filter(f => f.key === String(key))[0];
  if (!field) return { ok: false, error: '未知配置项：' + String(key) };
  const all = plugConfigAll();
  const data = plugPlainObject(all[plugin.id]) ? all[plugin.id] : {};
  if (field.type === 'secret') {
    if (!secretStore.ok) return { ok: false, error: '密钥仓不可用' };
    const v = String(value == null ? '' : value);
    if (v) secretStore.put(plugSecretName(plugin.id, field.key), v);
    else secretStore.del(plugSecretName(plugin.id, field.key));
    plugAudit('config_secret', plugin, { tool: field.key });
    return { ok: true };
  }
  let v = value;
  if (field.type === 'number') {
    v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, error: '必须是数字' };
    if (field.min !== null && v < field.min) return { ok: false, error: '小于最小值' };
    if (field.max !== null && v > field.max) return { ok: false, error: '大于最大值' };
  } else if (field.type === 'boolean') {
    v = value === true || value === 'true';
  } else if (field.type === 'enum') {
    const ok = (field.options || []).some(o => o.value === String(value));
    if (!ok) return { ok: false, error: '不在可选范围内' };
    v = String(value);
  } else if (field.type === 'json') {
    try { v = typeof value === 'string' ? JSON.parse(value) : plugJsonSafe(value, 0); }
    catch (e) { return { ok: false, error: 'JSON 格式不正确' }; }
  } else {
    v = String(value == null ? '' : value).slice(0, 4000);
  }
  data[field.key] = plugJsonSafe(v, 0);
  all[plugin.id] = data;
  sSet(PLUG_CONFIG_KEY, all);
  return { ok: true };
}

/* ---------------- 数据绑定与组件树 ---------------- */
function plugCtxValue(ctx, path) {
  const parts = String(path || '').split('.');
  let cur = ctx;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return '';
    if (parts[i] === '__proto__' || parts[i] === 'constructor' || parts[i] === 'prototype') return '';
    cur = cur[parts[i]];
  }
  if (cur == null) return '';
  if (typeof cur === 'object') { try { return JSON.stringify(cur); } catch (e) { return ''; } }
  return String(cur);
}
function plugBindString(value, ctx) {
  return String(value == null ? '' : value).replace(/\{\{\s*(state|config|session|plugin)\.([A-Za-z0-9_.-]+)\s*\}\}/g,
    (m, scope, path) => plugCtxValue((ctx || {})[scope] || {}, path));
}
function plugBindValue(v, ctx, depth) {
  if (typeof v === 'string') return plugBindString(v, ctx);
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plugBindValue(x, ctx, (depth || 0) + 1));
  if (!plugPlainObject(v)) return v;
  const out = {};
  Object.keys(v).slice(0, 100).forEach(k => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
    out[k] = plugBindValue(v[k], ctx, (depth || 0) + 1);
  });
  return out;
}
function plugSafeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (plugIsLocalHost(url.hostname)) return '';
    return url.href;
  } catch (e) { return ''; }
}
function plugSafeImage(u) {
  const s = String(u == null ? '' : u);
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s.slice(0, 500000);
  return plugSafeUrl(s);
}
function plugRegisterAction(plugin, action) {
  if (!plugin || !action) return '';
  const token = 'pa' + (++PLUG_ACTION_SEQ);
  PLUG_ACTION_REFS[token] = { pluginId: plugin.id, action };
  const keys = Object.keys(PLUG_ACTION_REFS);
  if (keys.length > 500) keys.slice(0, keys.length - 400).forEach(k => { delete PLUG_ACTION_REFS[k]; });
  return token;
}
function plugActionAttr(plugin, action) {
  if (!action) return '';
  return ' data-plug-act="' + plugEsc(plugRegisterAction(plugin, action)) + '"';
}
function plugUnknownNode(node) {
  return '<div class="pc pc-unknown">未知组件：' + plugEsc(String((node && node.type) || '?')) + '</div>';
}
function plugRenderNode(node, ctx) {
  if (node == null) return '';
  if (typeof node === 'string') return '<div class="pc pc-text">' + plugEsc(plugBindString(node, ctx)) + '</div>';
  if (Array.isArray(node)) return node.map(n => plugRenderNode(n, ctx)).join('');
  if (!plugPlainObject(node)) return '';
  if ((ctx && ctx.__depth) > PLUG_MAX_TREE_DEPTH) return '<div class="pc pc-unknown">组件嵌套过深</div>';
  const n = plugBindValue(node, ctx);
  const t = String(n.type || '');
  if (PLUG_COMPONENT_TYPES.indexOf(t) < 0) return plugUnknownNode(n);
  const kicker = (m) => plugEsc(plugBindString(m, ctx));
  try {
    if (t === 'layout' || t === 'modal' || t === 'form') {
      const children = n.children || n.body || [];
      const dir = t === 'layout' && n.dir === 'row' ? ' pc-row' : '';
      const cls = t === 'modal' ? ' pc-modal' : (t === 'form' ? ' pc-form' : ' pc-layout');
      let out = '<div class="pc' + cls + dir + '"' + plugStyleAttr(n.style) + '>';
      if (t === 'form' && n.title) out += '<div class="pc-title">' + kicker(n.title) + '</div>';
      out += plugRenderNode(children, ctx);
      if (t === 'form' && n.submit) out += plugRenderNode(Object.assign({ type: 'button' }, n.submit), ctx);
      out += '</div>';
      return out;
    }
    if (t === 'text') {
      const size = ['sm', 'md', 'lg'].indexOf(String(n.size || '')) >= 0 ? ' pc-' + n.size : '';
      return '<div class="pc pc-text' + (n.muted ? ' pc-muted' : '') + size + '"' + plugStyleAttr(n.style) + '>' + kicker(n.text != null ? n.text : n.value) + '</div>';
    }
    if (t === 'stat') {
      return '<div class="pc pc-stat"' + plugStyleAttr(n.style) + '><div class="pc-stat-v">' + kicker(n.value) + '</div><div class="pc-stat-l">' + kicker(n.label) + '</div></div>';
    }
    if (t === 'button') {
      return '<button type="button" class="pc-btn' + (n.primary ? ' pc-primary' : '') + '"' + plugStyleAttr(n.style) + plugActionAttr(ctx.plugin, n.action) + '>' + kicker(n.label || n.text) + '</button>';
    }
    if (t === 'input') {
      return '<label class="pc pc-field"><span>' + kicker(n.label) + '</span><input class="pc-input" data-plug-cfg="' + plugEsc(plugSafeId(n.key)) + '" value="' + kicker(n.value) + '" placeholder="' + kicker(n.placeholder) + '"></label>';
    }
    if (t === 'select') {
      const opts = (Array.isArray(n.options) ? n.options : []).slice(0, 50).map(o => {
        const v = plugPlainObject(o) ? o.value : o, l = plugPlainObject(o) ? (o.label || o.value) : o;
        const sel = String(v == null ? '' : v) === String(n.value) ? ' selected' : '';
        return '<option value="' + plugEsc(String(v == null ? '' : v)) + '"' + sel + '>' + plugEsc(String(l == null ? '' : l)) + '</option>';
      }).join('');
      return '<label class="pc pc-field"><span>' + kicker(n.label) + '</span><select class="pc-input" data-plug-cfg="' + plugEsc(plugSafeId(n.key)) + '">' + opts + '</select></label>';
    }
    if (t === 'list') {
      const items = (Array.isArray(n.items) ? n.items : []).slice(0, 100).map(it => {
        const title = plugPlainObject(it) ? (it.title || it.label || '') : it;
        const desc = plugPlainObject(it) ? (it.desc || '') : '';
        const act = plugPlainObject(it) && it.action ? ' ' + plugActionAttr(ctx.plugin, it.action) : '';
        return '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(String(title)) + '</div>' +
          (desc ? '<div class="pc-row-d">' + plugEsc(String(desc)) + '</div>' : '') + '</div>' +
          (act ? '<button type="button" class="pc-btn pc-mini"' + act + '>' + plugEsc(String(it.label || '打开')) + '</button>' : '') + '</div>';
      }).join('');
      return '<div class="pc pc-list">' + (items || '<div class="pc-muted">暂无内容</div>') + '</div>';
    }
    if (t === 'table') {
      const cols = (Array.isArray(n.columns) ? n.columns : []).slice(0, 12);
      const rows = (Array.isArray(n.rows) ? n.rows : []).slice(0, 100);
      let html = '<table class="pc pc-table"><thead><tr>' + cols.map(c => '<th>' + plugEsc(String(c.label || c)) + '</th>').join('') + '</tr></thead><tbody>';
      rows.forEach(r => { html += '<tr>' + cols.map((c, i) => '<td>' + plugEsc(String(Array.isArray(r) ? r[i] : (r && r[i]))) + '</td>').join('') + '</tr>'; });
      return html + '</tbody></table>';
    }
    if (t === 'image') {
      const src = plugSafeImage(n.src);
      if (!src) return '<div class="pc pc-unknown">图片地址不可用</div>';
      return '<img class="pc pc-img" src="' + plugEsc(src) + '" alt="' + kicker(n.alt) + '"' + (n.height ? ' style="max-height:' + Math.max(20, Math.min(400, parseInt(n.height, 10) || 160)) + 'px"' : '') + '>';
    }
    if (t === 'progress') {
      const v = Math.max(0, Math.min(100, Number(n.value) || 0));
      return '<div class="pc pc-progress"><div class="pc-bar" style="width:' + v + '%"></div></div>' +
        (n.label ? '<div class="pc-muted">' + kicker(n.label) + '</div>' : '');
    }
    if (t === 'chart') {
      const bars = (Array.isArray(n.bars) ? n.bars : []).slice(0, 30);
      const max = Math.max(1, ...bars.map(b => Math.max(0, Number(b && b.value) || 0)));
      return '<div class="pc pc-chart">' + bars.map(b =>
        '<div class="pc-chart-col"><div class="pc-chart-bar" style="height:' + Math.round(100 * Math.max(0, Number(b && b.value) || 0) / max) + '%"></div>' +
        '<div class="pc-chart-l">' + plugEsc(String((b && b.label) || '')) + '</div></div>').join('') + '</div>';
    }
    if (t === 'tabs') {
      const tabs = (Array.isArray(n.tabs) ? n.tabs : []).slice(0, 10);
      return '<div class="pc pc-tabs">' + tabs.map(x =>
        '<div class="pc-tab"><div class="pc-title">' + plugEsc(String((x && x.label) || '')) + '</div>' + plugRenderNode((x && x.children) || [], ctx) + '</div>').join('') + '</div>';
    }
    if (t === 'choice') {
      const opts = (Array.isArray(n.options) ? n.options : []).slice(0, 20).map(o => {
        const label = plugPlainObject(o) ? (o.label || o.value) : o;
        const act = plugPlainObject(o) ? o.action : null;
        return '<button type="button" class="pc-btn" ' + (act ? plugActionAttr(ctx.plugin, act) : 'data-plug-choice="' + plugEsc(String(label)) + '"') + '>' + plugEsc(String(label == null ? '' : label)) + '</button>';
      }).join('');
      // 自定义输入始终保留：插件只能给建议，不能锁死输入框。
      const custom = n.custom === false ? '' : '<button type="button" class="pc-btn pc-mini" data-plug-choice-custom="1">' +
        plugEsc(String(n.customLabel || '自定义输入…')) + '</button>';
      return '<div class="pc pc-choice"' + plugStyleAttr(n.style) + '>' + (n.prompt ? '<div class="pc-text">' + kicker(n.prompt) + '</div>' : '') + opts + custom + '</div>';
    }
    if (t === 'divider') return '<div class="pc pc-divider"></div>';
    if (t === 'spacer') return '<div class="pc pc-spacer"></div>';
  } catch (e) {
    return '<div class="pc pc-unknown">组件渲染失败：' + plugEsc(String(n.type)) + '</div>';
  }
  return plugUnknownNode(n);
}
function plugRenderTree(tree, ctx) {
  const state = Object.assign({ __depth: 0, plugin: null, state: {}, config: {}, session: {}, pluginInfo: {} }, ctx || {});
  const walk = (node, depth) => {
    if (depth > PLUG_MAX_TREE_DEPTH) return '<div class="pc pc-unknown">组件嵌套过深</div>';
    if (Array.isArray(node)) return node.slice(0, PLUG_MAX_TREE_NODES).map(n => walk(n, depth + 1)).join('');
    if (!plugPlainObject(node)) return plugRenderNode(node, state);
    // 只把当前层绑定一遍，子节点递归时仍用同一上下文
    return plugRenderNode(node, Object.assign({}, state, { __depth: depth }));
  };
  try { return walk(tree, 0); }
  catch (e) { return '<div class="pc pc-unknown">组件树渲染失败</div>'; }
}

/* ---------------- 样式令牌白名单 / 主题包（E4-002/003） ---------------- */
const PLUG_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)|transparent|currentColor)$/;
const PLUG_LEN_RE = /^(0|\d{1,3}(?:\.\d{1,2})?(?:px|%|rem|em))$/;
const PLUG_WEIGHT_RE = /^(normal|bold|[1-9]00)$/;
const PLUG_SHADOW_RE = /^(none|\d{1,3}px \d{1,3}px \d{1,3}px(?: \d{1,3}px)?(?: #[0-9a-fA-F]{3,8})?)$/;
const PLUG_STYLE_KEYS = ['bg', 'color', 'radius', 'padding', 'margin', 'fontSize', 'fontWeight', 'opacity', 'shadow'];
function plugColorOk(v) { return PLUG_COLOR_RE.test(String(v == null ? '' : v).trim()); }
function plugGradientOk(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^linear-gradient\(\s*(0|45|90|135|180|225|270)deg\s*,\s*([^,]+)\s*,\s*([^,]+)\s*\)$/.exec(s);
  return !!m && plugColorOk(m[2]) && plugColorOk(m[3]);
}
/** 把插件声明的样式令牌过白名单；不认识的键直接丢弃，绝不透传任意 CSS。 */
function plugNormalizeStyle(style) {
  if (!plugPlainObject(style)) return null;
  const out = {};
  PLUG_STYLE_KEYS.forEach(k => {
    const v = style[k];
    if (v == null || v === '') return;
    const s = String(v).trim().slice(0, 80);
    if (k === 'bg') { if (plugColorOk(s) || plugGradientOk(s)) out.bg = s; }
    else if (k === 'color') { if (plugColorOk(s)) out.color = s; }
    else if (k === 'radius' || k === 'padding' || k === 'margin' || k === 'fontSize') { if (PLUG_LEN_RE.test(s)) out[k] = s; }
    else if (k === 'fontWeight') { if (PLUG_WEIGHT_RE.test(s)) out.fontWeight = s; }
    else if (k === 'opacity') { const n = Number(s); if (Number.isFinite(n) && n >= 0 && n <= 1) out.opacity = String(n); }
    else if (k === 'shadow') { if (PLUG_SHADOW_RE.test(s)) out.shadow = s; }
  });
  if (plugPlainObject(style.image)) out.image = plugSafeImage(style.image.src || style.image);
  else if (style.image) out.image = plugSafeImage(style.image);
  return Object.keys(out).length ? out : null;
}
function plugNormalizeThemeTokens(tokens) { return plugNormalizeStyle(tokens); }
function plugStyleAttr(style) {
  if (!style) return '';
  const css = [];
  if (style.bg) css.push('background:' + style.bg);
  if (style.color) css.push('color:' + style.color);
  if (style.radius) css.push('border-radius:' + style.radius);
  if (style.padding) css.push('padding:' + style.padding);
  if (style.margin) css.push('margin:' + style.margin);
  if (style.fontSize) css.push('font-size:' + style.fontSize);
  if (style.fontWeight) css.push('font-weight:' + style.fontWeight);
  if (style.opacity) css.push('opacity:' + style.opacity);
  if (style.shadow) css.push('box-shadow:' + style.shadow);
  if (style.image) css.push('background-image:url("' + style.image + '")', 'background-size:cover');
  return css.length ? ' style="' + plugEsc(css.join(';')) + '"' : '';
}
function plugThemesOf(plugin) { return plugin ? plugPluginSurfaces(plugin, 'theme') : []; }
function plugThemeFind(pluginId, themeId) {
  const plugin = USER_PLUGINS.filter(p => p.id === String(pluginId))[0];
  if (!plugin) return null;
  const s = plugThemesOf(plugin).filter(x => x.id === String(themeId))[0];
  return s ? { plugin, surface: s } : null;
}
function plugThemeState() {
  const all = sGet(PLUG_THEME_KEY, {});
  const out = plugPlainObject(all) ? all : {};
  if (!plugPlainObject(out.byTask)) out.byTask = {};
  if (!plugPlainObject(out.global)) out.global = null;
  return out;
}
/** 亮度对比：只对十六进制颜色做，返回 null 表示无法判断。 */
function plugHexLum(hex) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function plugThemeContrast(tokens) {
  if (!tokens || !tokens.bg || !tokens.color) return { ok: true, ratio: null };
  const a = plugHexLum(tokens.bg), b = plugHexLum(tokens.color);
  if (a == null || b == null) return { ok: true, ratio: null };
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return { ok: ratio >= 3, ratio: Math.round(ratio * 100) / 100 };
}
function plugPaintTheme(theme) {
  const root = document.documentElement;
  const app = $('#app');
  if (!root || !root.style) return;
  const t = theme && theme.tokens ? theme.tokens : {};
  if (root.classList) root.classList.toggle('plug-themed', !!theme);
  root.style.setProperty('--plug-bg', t.bg || '');
  root.style.setProperty('--plug-msg-bg', t.bg || '');
  root.style.setProperty('--plug-fg', t.color || '');
  root.style.setProperty('--plug-radius', t.radius || '');
  root.style.setProperty('--plug-font', t.fontSize || '');
  root.style.setProperty('--plug-shadow', t.shadow || '');
  const img = theme && theme.background ? theme.background : '';
  if (app && app.style) app.style.backgroundImage = img ? 'url("' + img + '")' : '';
}
function plugThemeApply(plugin, themeId, scope, taskId) {
  if (!plugin) return { ok: false, error: '插件不存在' };
  const hit = plugThemesOf(plugin).filter(t => t.id === String(themeId))[0];
  if (!hit) return { ok: false, error: '主题包不存在：' + String(themeId) };
  if (!plugSurfaceEnabled(plugin, hit)) return { ok: false, error: '主题权限未授权或插件已停用' };
  const theme = { pluginId: plugin.id, themeId: hit.id, tokens: hit.tokens || null, background: hit.background || '' };
  const all = plugThemeState();
  scope = scope === 'session' ? 'session' : 'global';
  if (scope === 'session' && taskId) all.byTask[String(taskId)] = theme;
  else all.global = theme;
  sSet(PLUG_THEME_KEY, all);
  const contrast = plugThemeContrast(theme.tokens || {});
  if (!contrast.ok) plugAudit('theme_contrast', plugin, { tool: hit.id + ':' + contrast.ratio });
  plugAudit('theme_apply', plugin, { tool: hit.id + ':' + scope });
  plugPaintTheme(theme);
  return { ok: true, contrast: contrast, themeId: hit.id, scope: scope };
}
function plugThemeReset(scope, taskId) {
  const all = plugThemeState();
  if (scope === 'session' && taskId) delete all.byTask[String(taskId)];
  else if (scope === 'session') all.byTask = {};
  else all.global = null;
  sSet(PLUG_THEME_KEY, all);
  plugThemeRestore();
  return { ok: true };
}
function plugThemeRestore() {
  const all = plugThemeState();
  const task = String(CURRENT_TASK_ID || '');
  const theme = (task && all.byTask[task]) || all.global || null;
  plugPaintTheme(theme);
  return theme;
}
function plugThemeClearPlugin(pluginId) {
  const all = plugThemeState();
  let changed = false;
  if (all.global && all.global.pluginId === pluginId) { all.global = null; changed = true; }
  Object.keys(all.byTask || {}).forEach(k => {
    if (all.byTask[k] && all.byTask[k].pluginId === pluginId) { delete all.byTask[k]; changed = true; }
  });
  if (changed) { sSet(PLUG_THEME_KEY, all); plugThemeRestore(); }
}

/* ---------------- 挂载点注册表（E4-001） ---------------- */
function plugMountEntries(mount) {
  return plugSurfaceList('entry').filter(e => e.surface.mount === String(mount)).sort((a, b) =>
    (a.surface.sort - b.surface.sort) || String(a.plugin.id + ':' + a.surface.id).localeCompare(String(b.plugin.id + ':' + b.surface.id)));
}
function plugMountVisible(entry) {
  if (!entry || !entry.surface) return false;
  const task = (typeof TASKS !== 'undefined' ? TASKS : []).filter(t => t.id === CURRENT_TASK_ID)[0];
  if (entry.surface.when === 'session') return !!(task && task.pluginSession);
  if (entry.surface.when === 'chat') return !!(task && task.type === 'chat');
  return true;
}
function plugSurfaceTree(plugin, surface, ctx) {
  let tree = surface && surface.tree;
  if (!tree && surface && surface.renderer) {
    const r = plugPluginSurfaces(plugin, 'renderer').filter(x => x.id === surface.renderer)[0];
    if (r) tree = r.tree;
  }
  return tree ? plugRenderTree(tree, ctx) : '';
}
function plugMountHtml(mount, ctx) {
  const list = plugMountEntries(mount).filter(plugMountVisible);
  if (!list.length) return '';
  return list.map(entry => {
    const plugin = entry.plugin, surface = entry.surface;
    const c = Object.assign({}, ctx || {}, {
      plugin: plugHostApi(plugin, surface),
      pluginInfo: { id: plugin.id, name: plugin.name, version: plugin.version },
      state: plugStateGet(plugin),
      config: plugConfigGet(plugin),
      session: { id: CURRENT_TASK_ID || '', surface: surface.id }
    });
    const body = plugSurfaceTree(plugin, surface, c) ||
      (surface.action ? '<button type="button" class="pc-btn pc-mini"' + plugActionAttr(plugin, surface.action) + '>' +
        plugEsc(surface.action.label || surface.title) + '</button>' : '');
    if (!body) return '';
    return '<div class="plug-mount plug-mount-' + plugEsc(mount).replace(/\./g, '-') + '" data-plug-mount="' +
      plugEsc(mount) + '">' + body + '</div>';
  }).join('');
}
/** 把入口挂到聊天页的头部/输入区/消息后；容器不存在时静默跳过。 */
function plugMountRefresh() {
  const slots = [['chat.header', '#plug-mount-head'], ['chat.footer', '#plug-mount-foot'],
    ['chat.composer.before', '#plug-mount-composer']];
  slots.forEach(([mount, sel]) => {
    const el = $(sel);
    if (el) el.innerHTML = plugMountHtml(mount);
  });
}

/* ---------------- 会话类型引擎（E4-004/005/006） ---------------- */
function plugSessionOfTask(task) {
  if (!task || !task.pluginSession) return null;
  const plugin = USER_PLUGINS.filter(p => p.id === task.pluginSession.pluginId)[0];
  if (!plugin) return null;
  const surface = plugPluginSurfaces(plugin, 'sessionType').filter(s => s.id === task.pluginSession.surfaceId)[0];
  return surface ? { plugin, surface } : null;
}
function plugSessionState(plugin, surface) {
  const data = plugStateGet(plugin);
  const schema = plugPlainObject(surface.stateSchema) ? surface.stateSchema : {};
  const props = plugPlainObject(schema.properties) ? schema.properties : {};
  Object.keys(props).slice(0, 40).forEach(k => {
    if (Object.prototype.hasOwnProperty.call(data, k)) return;
    const d = props[k] && props[k].default;
    data[k] = d === undefined ? null : plugJsonSafe(d, 0);
  });
  if (!Object.prototype.hasOwnProperty.call(data, 'round')) data.round = 0;
  plugStateSave(plugin, data);
  return data;
}
function plugSessionEnded(surface, state) {
  const m = /^([A-Za-z0-9_.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(String(surface && surface.endWhen || '').trim());
  if (!m) return false;
  const left = plugCtxValue({ state: state || {} }, 'state.' + m[1]);
  const right = String(m[3]).trim().replace(/^['"]|['"]$/g, '');
  const ln = Number(left), rn = Number(right);
  const numeric = left !== '' && right !== '' && Number.isFinite(ln) && Number.isFinite(rn);
  if (m[2] === '==') return numeric ? ln === rn : String(left) === right;
  if (m[2] === '!=') return numeric ? ln !== rn : String(left) !== right;
  if (!numeric) return false;
  if (m[2] === '>') return ln > rn;
  if (m[2] === '<') return ln < rn;
  if (m[2] === '>=') return ln >= rn;
  return ln <= rn;
}
function plugAppendCard(html) {
  const bodyEl = $('#body');
  if (!bodyEl || !html) return null;
  const d = document.createElement('div');
  d.className = 'msg ai plug-card';
  try { d.innerHTML = html; } catch (e) {}
  bodyEl.appendChild(d);
  bodyEl.scrollTop = bodyEl.scrollHeight;
  return d;
}
/** 每轮回复后：渲染命名模板、推进 round、检查结束条件。只影响插件自己的会话。 */
function plugSessionAfterReply(task) {
  const hit = plugSessionOfTask(task);
  if (!hit) return false;
  const { plugin, surface } = hit;
  if (task.pluginSession.ended) return false;
  const state = plugSessionState(plugin, surface);
  if (plugSessionEnded(surface, state)) {
    task.pluginSession.ended = true;
    plugStateSet(plugin, 'round', (parseInt(state.round, 10) || 0));
    saveTasks();
    plugEmit('session.delete', { pluginId: plugin.id, surfaceId: surface.id, taskId: task.id, ended: true });
    const endedHtml = '<div class="pc pc-text pc-muted">这场会话已经结束了。你可以返回聊天，或新建一场。</div>';
    plugAppendCard(endedHtml);
    plugAudit('session_end', plugin, { tool: surface.id });
    return endedHtml;
  }
  const ctx = {
    plugin: plugHostApi(plugin, surface),
    pluginInfo: { id: plugin.id, name: plugin.name, version: plugin.version },
    state: state,
    config: plugConfigGet(plugin),
    session: { id: task.id, surface: surface.id, vars: (task.pluginSession.vars || {}), round: parseInt(state.round, 10) || 0 }
  };
  const html = plugSurfaceTree(plugin, surface, ctx);
  const next = (parseInt(state.round, 10) || 0) + 1;
  plugStateSet(plugin, 'round', next);
  if (html) plugAppendCard(html);
  return html;
}

/* ---------------- 动作 ---------------- */
function plugRateOk(plugin, name) {
  const key = String(plugin.id) + ':' + String(name);
  const now = Date.now();
  const rec = PLUG_RATE[key] || { start: now, count: 0 };
  if (now - rec.start > PLUG_RATE_WINDOW_MS) { rec.start = now; rec.count = 0; }
  rec.count++;
  PLUG_RATE[key] = rec;
  return rec.count <= PLUG_RATE_LIMIT;
}
function plugActionPermissionCheck(plugin, action) {
  const need = Array.isArray(action.permissions) ? action.permissions : [];
  return need.every(p => plugPermissionGranted(plugin, p));
}
async function plugRunAction(plugin, action, ctx) {
  if (!plugin || !action) return { ok: false, error: '动作不存在' };
  if (plugStateOf(plugin) === 'disabled') return { ok: false, error: '插件已停用' };
  if (!plugActionPermissionCheck(plugin, action)) return { ok: false, error: '动作权限未获授权' };
  if (!plugRateOk(plugin, 'action')) return { ok: false, error: '动作过于频繁，已限流' };
  ctx = ctx || {};
  if (action.confirm) {
    if (!(await uiConfirm(String(action.confirm), '继续', '插件操作'))) return { ok: false, error: '用户取消' };
  }
  try {
    if (action.type === 'navigate') {
      const target = String(action.page || action.to || action.target || '');
      if (target === 'chat' || target === 'settings' || target === 'plugins' || target === 'plug-market' ||
        target === 'music' || target === 'memory' || target === 'translate') {
        showView(target);
        return { ok: true };
      }
      const hit = plugSurfaceFind('page', target, plugin.id);
      if (!hit) return { ok: false, error: '目标页面不存在' };
      plugOpenPage(plugin.id, target);
      return { ok: true };
    }
    if (action.type === 'plugin.call') {
      const name = String(action.tool || action.target || '');
      const tool = (plugin.tools || []).filter(t => t.name === name)[0];
      if (!tool) return { ok: false, error: '插件工具不存在：' + name };
      const r = await plugExec(plugin, tool, plugPlainObject(action.args) ? action.args : {});
      return { ok: r && r.success !== false, data: r };
    }
    if (action.type === 'config.set') {
      const r = plugConfigSet(plugin, action.key, action.value);
      if (r.ok && typeof renderPlugins === 'function') { try { renderPlugins(); } catch (e) {} }
      return r;
    }
    if (action.type === 'state.set') {
      if (!plugStateSet(plugin, action.path || action.key, action.value)) return { ok: false, error: '状态写入失败' };
      if (typeof plugRenderPage === 'function') { try { plugRenderPage(); } catch (e) {} }
      return { ok: true };
    }
    if (action.type === 'session.create') {
      const sid = String(action.session || action.target || '');
      return plugSessionCreate(plugin, sid, action.value);
    }
    if (action.type === 'session.delete') {
      return plugSessionDelete(plugin, String(action.session || action.target || ''), ctx.sessionId || '');
    }
    if (action.type === 'message.send') {
      const text = String(action.text || action.message || '').slice(0, 4000);
      if (!text) return { ok: false, error: '消息为空' };
      const input = $('#input');
      if (!input) return { ok: false, error: '输入框不可用' };
      input.value = text;
      if (typeof sendSafe === 'function') sendSafe();
      return { ok: true };
    }
    if (action.type === 'openUrl') {
      if (!plugPermissionGranted(plugin, 'system.open_url')) return { ok: false, error: '缺少 system.open_url 授权' };
      const url = plugSafeUrl(action.url);
      if (!url) return { ok: false, error: '网址不合法' };
      if (HAS_NATIVE && Android.openUrl) Android.openUrl(url);
      return { ok: true };
    }
    if (action.type === 'clipboard.write') {
      if (!plugPermissionGranted(plugin, 'clipboard.write')) return { ok: false, error: '缺少 clipboard.write 授权' };
      await writeClipboard(String(action.text || action.value || '').slice(0, 20000));
      return { ok: true };
    }
    if (action.type === 'job.schedule') {
      const sid = String(action.job || action.target || '');
      return plugJobSchedule(plugin, sid);
    }
    if (action.type === 'theme.apply') {
      return plugThemeApply(plugin, String(action.theme || action.target || ''), String(action.scope || 'global'),
        String(action.session || ctx.sessionId || CURRENT_TASK_ID || ''));
    }
    if (action.type === 'theme.reset') {
      return plugThemeReset(String(action.scope || 'global'), String(action.session || ctx.sessionId || CURRENT_TASK_ID || ''));
    }
    if (action.type === 'dependency.install') return { ok: false, error: '依赖安装将在 0.12 提供' };
    if (action.type === 'confirm') return { ok: true };
    if (action.type === 'custom') return { ok: false, error: '0.10 不执行插件自定义代码；请使用通用动作' };
  } catch (e) {
    plugAudit('action_error', plugin, { tool: action.type });
    return { ok: false, error: errMsg(e) };
  }
  return { ok: false, error: '未知动作：' + action.type };
}

/* ---------------- 会话 / 任务 ---------------- */
function plugSessionCreate(plugin, surfaceId, vars) {
  if (!plugin) return { ok: false, error: '插件不存在' };
  const hit = plugPluginSurfaces(plugin, 'sessionType').filter(s => s.id === String(surfaceId))[0];
  if (!hit) return { ok: false, error: '会话类型不存在：' + String(surfaceId) };
  if (!plugSurfaceEnabled(plugin, hit)) return { ok: false, error: '会话类型权限未授权' };
  const t = taskAdd('chat', hit.title, hit.prompt || hit.title);
  t.pluginSession = { pluginId: plugin.id, surfaceId: hit.id, vars: plugJsonSafe(vars || hit.vars, 0) || {}, round: 0, ended: false };
  t.title = hit.title;
  plugSessionState(plugin, hit);
  saveTasks();
  if (hit.opening) {
    history.push({ role: 'assistant', content: hit.opening });
    saveHistory();
    try { addMsg('assistant', hit.opening); } catch (e) {}
  }
  plugAudit('session_create', plugin, { tool: hit.id });
  plugEmit('session.create', { pluginId: plugin.id, surfaceId: hit.id, taskId: t.id });
  return { ok: true, taskId: t.id };
}
function plugSessionDelete(plugin, surfaceId, taskId) {
  if (!plugin) return { ok: false, error: '插件不存在' };
  const target = TASKS.filter(t => t && t.pluginSession && t.pluginSession.pluginId === plugin.id
    && (!surfaceId || t.pluginSession.surfaceId === String(surfaceId))
    && (!taskId || t.id === String(taskId)))[0];
  if (!target) return { ok: false, error: '没有可删除的插件会话' };
  const chat = TASKS.filter(t => t.type === 'chat' && t.id !== target.id)[0];
  TASKS = TASKS.filter(t => t.id !== target.id);
  try { sSet(taskHistoryKey(target.id), []); } catch (e) {}
  if (CURRENT_TASK_ID === target.id) {
    CURRENT_TASK_ID = (chat && chat.id) || '';
    if (chat) taskLoadContext(chat);
  }
  saveTasks();
  plugAudit('session_delete', plugin, { tool: String(target.id) });
  plugEmit('session.delete', { pluginId: plugin.id, taskId: target.id });
  return { ok: true };
}
function plugJobSchedule(plugin, surfaceId) {
  const hit = plugPluginSurfaces(plugin, 'job').filter(s => s.id === String(surfaceId))[0];
  if (!hit) return { ok: false, error: '后台任务不存在：' + String(surfaceId) };
  const jobs = sGet(PLUG_JOBS_KEY, {}) || {};
  const key = plugin.id + ':' + hit.id;
  jobs[key] = { every: hit.every, lastRun: (jobs[key] && jobs[key].lastRun) || 0, nextRun: Date.now() + hit.every * 1000 };
  sSet(PLUG_JOBS_KEY, jobs);
  plugAudit('job_schedule', plugin, { tool: hit.id });
  return { ok: true, every: hit.every };
}
async function plugRunJob(pluginId, surfaceId) {
  const plugin = USER_PLUGINS.filter(p => p.id === String(pluginId))[0];
  if (!plugin) return { ok: false, error: '插件不存在' };
  const hit = plugPluginSurfaces(plugin, 'job').filter(s => s.id === String(surfaceId))[0];
  if (!hit) return { ok: false, error: '后台任务不存在' };
  if (!plugSurfaceEnabled(plugin, hit)) return { ok: false, error: '插件已停用或权限未授权' };
  const jobs = sGet(PLUG_JOBS_KEY, {}) || {};
  jobs[plugin.id + ':' + hit.id] = Object.assign({ every: hit.every }, jobs[plugin.id + ':' + hit.id] || {}, { lastRun: Date.now() });
  sSet(PLUG_JOBS_KEY, jobs);
  plugAudit('job_run', plugin, { tool: hit.id });
  if (!hit.action) return { ok: true };
  return await plugRunAction(plugin, hit.action, { job: hit.id });
}

/* ---------------- Host API ---------------- */
function plugHostApi(plugin, surface) {
  if (!plugin) return null;
  const sid = surface ? surface.id : '';
  return {
    id: plugin.id,
    apiVersion: plugin.apiVersion,
    surface: {
      list: type => plugPluginSurfaces(plugin, type).map(s => ({ id: s.id, type: s.type, title: s.title })),
      get: (type, id) => { const s = plugPluginSurfaces(plugin, type).filter(x => x.id === String(id))[0]; return s ? { id: s.id, type: s.type, title: s.title } : null; }
    },
    config: {
      get: key => { const all = plugConfigGet(plugin); return key ? all[key] : all; },
      set: (key, value) => plugConfigSet(plugin, key, value)
    },
    state: {
      get: key => { const data = plugStateGet(plugin); return key ? plugCtxValue({ state: data }, 'state.' + key) : data; },
      set: (key, value) => plugStateSet(plugin, key, value),
      clear: () => { plugStateClear(plugin); return true; },
      export: () => plugStorageExport(plugin)
    },
    session: {
      create: (surfaceId, vars) => plugSessionCreate(plugin, surfaceId || sid, vars),
      remove: (surfaceId, taskId) => plugSessionDelete(plugin, surfaceId || sid, taskId)
    },
    panel: {
      openPage: id => { plugOpenPage(plugin.id, id); return true; }
    },
    log: function () {
      const args = Array.prototype.slice.call(arguments).map(x => { try { return JSON.stringify(x); } catch (e) { return String(x); } });
      try { console.log('[插件:' + plugin.id + ']', args.join(' ')); } catch (e) {}
      return true;
    },
    model: {
      resolve: purpose => { const r = providerResolve(CONFIG, purpose || 'chat'); return r && r.provider ? { id: r.provider.id, kind: r.provider.kind, model: r.provider.model, capabilities: r.provider.capabilities } : null; },
      summary: () => providerSummary(CONFIG).map(p => ({ id: p.id, kind: p.kind, capabilities: p.capabilities, hasKey: p.hasKey }))
    },
    dependency: {
      list: () => (plugin.dependencies || []).slice()
    },
    job: {
      schedule: id => plugJobSchedule(plugin, id || sid),
      list: () => plugPluginSurfaces(plugin, 'job').map(s => ({ id: s.id, every: s.every }))
    }
  };
}

/* ---------------- UI：插件页面 / 入口 / 配置表单 ---------------- */
function plugSurfaceSessionKey(plugin, surface) { return String(plugin.id) + ':' + String(surface.id); }
function plugOpenPage(pid, sid) {
  const plugin = USER_PLUGINS.filter(p => p.id === String(pid))[0];
  if (!plugin) return;
  const surface = plugPluginSurfaces(plugin, 'page').filter(s => s.id === String(sid))[0];
  if (!surface) { toast('插件页面不存在'); return; }
  if (!plugSurfaceEnabled(plugin, surface)) { toast('插件已停用或页面权限未授权'); return; }
  PLUG_PAGE_CTX = { pluginId: plugin.id, surfaceId: surface.id, mode: 'page' };
  if (typeof showView === 'function') showView(PLUG_PAGE_VIEW, { noStack: true });
  if (typeof VIEW_STACK !== 'undefined') {
    if (VIEW_STACK[VIEW_STACK.length - 1] !== PLUG_PAGE_VIEW) VIEW_STACK.push(PLUG_PAGE_VIEW);
  }
  plugRenderPage();
}
function plugOpenConfig(pid, sid) {
  const plugin = USER_PLUGINS.filter(p => p.id === String(pid))[0];
  if (!plugin) return;
  const surface = sid ? plugPluginSurfaces(plugin, 'settings').filter(s => s.id === String(sid))[0] : null;
  PLUG_PAGE_CTX = { pluginId: plugin.id, surfaceId: surface ? surface.id : '', mode: 'config' };
  if (typeof showView === 'function') showView(PLUG_PAGE_VIEW, { noStack: true });
  if (typeof VIEW_STACK !== 'undefined') {
    if (VIEW_STACK[VIEW_STACK.length - 1] !== PLUG_PAGE_VIEW) VIEW_STACK.push(PLUG_PAGE_VIEW);
  }
  plugRenderPage();
}
function plugConfigFieldsOf(plugin, surface) {
  if (surface && surface.config && surface.config.fields.length) return surface.config;
  return { version: plugin.configVersion || 1, fields: plugin.configFields || [] };
}
function plugConfigFormHTML(plugin, surface) {
  const fields = plugConfigFieldsOf(plugin, surface).fields;
  if (!fields.length) return '<div class="mini-note">这个插件没有可配置项。</div>';
  const values = plugConfigGet(plugin);
  return '<div class="pc pc-form">' + fields.map(f => {
    const v = values[f.key] == null ? '' : values[f.key];
    const label = '<div class="pc-field-label">' + plugEsc(f.label) + (f.required ? ' *' : '') + '</div>' +
      (f.desc ? '<div class="mini-note">' + plugEsc(f.desc) + '</div>' : '');
    if (f.type === 'boolean') {
      return '<label class="pc pc-field pc-check">' + label + '<input type="checkbox" data-plug-cfg="' + plugEsc(f.key) + '"' + (v === true || v === 'true' ? ' checked' : '') + '></label>';
    }
    if (f.type === 'enum') {
      const opts = (f.options || []).map(o => '<option value="' + plugEsc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') + '>' + plugEsc(o.label) + '</option>').join('');
      return '<label class="pc pc-field">' + label + '<select class="pc-input" data-plug-cfg="' + plugEsc(f.key) + '">' + opts + '</select></label>';
    }
    if (f.type === 'json') {
      let text = ''; try { text = typeof v === 'string' ? v : JSON.stringify(v || '', null, 2); } catch (e) { text = ''; }
      return '<label class="pc pc-field">' + label + '<textarea class="pc-input" rows="4" data-plug-cfg="' + plugEsc(f.key) + '">' + plugEsc(text) + '</textarea></label>';
    }
    const inputType = (f.type === 'number' || f.type === 'secret') ? (f.type === 'number' ? 'number' : 'password') : 'text';
    return '<label class="pc pc-field">' + label + '<input class="pc-input" type="' + inputType + '" data-plug-cfg="' + plugEsc(f.key) + '" value="' + plugEsc(f.type === 'secret' ? '' : String(v)) + '"' +
      (f.type === 'secret' && v ? ' placeholder="已保存，留空表示不修改"' : ' placeholder="' + plugEsc(f.placeholder) + '"') +
      (f.min != null ? ' min="' + plugEsc(String(f.min)) + '"' : '') + (f.max != null ? ' max="' + plugEsc(String(f.max)) + '"' : '') + '></label>';
  }).join('') + '<div class="mini-note">配置改动会立即保存；secret 字段只进密钥仓，导出与日志不会包含明文。</div></div>';
}
function plugRenderPage() {
  const titleEl = $('#plug-page-title'), body = $('#plug-page-body');
  if (!titleEl || !body) return;
  const plugin = USER_PLUGINS.filter(p => p.id === PLUG_PAGE_CTX.pluginId)[0];
  if (!plugin) { titleEl.textContent = '插件页面'; body.innerHTML = '<div class="mini-note">插件已不存在。</div>'; return; }
  if (PLUG_PAGE_CTX.mode === 'config') {
    const surface = PLUG_PAGE_CTX.surfaceId ? plugPluginSurfaces(plugin, 'settings').filter(s => s.id === PLUG_PAGE_CTX.surfaceId)[0] : null;
    titleEl.textContent = (surface ? surface.title : '插件配置') + ' · ' + plugin.name;
    body.innerHTML = plugConfigFormHTML(plugin, surface);
    return;
  }
  const surface = plugPluginSurfaces(plugin, 'page').filter(s => s.id === PLUG_PAGE_CTX.surfaceId)[0];
  if (!surface) { titleEl.textContent = plugin.name; body.innerHTML = '<div class="mini-note">页面不存在。</div>'; return; }
  titleEl.textContent = (surface.icon ? surface.icon + ' ' : '') + surface.title + ' · ' + plugin.name;
  let tree = surface.tree;
  if (!tree && surface.renderer) {
    const r = plugPluginSurfaces(plugin, 'renderer').filter(x => x.id === surface.renderer)[0];
    if (r) tree = r.tree;
  }
  const host = plugHostApi(plugin, surface);
  const ctx = {
    plugin: host,
    pluginInfo: { id: plugin.id, name: plugin.name, version: plugin.version },
    state: plugStateGet(plugin),
    config: plugConfigGet(plugin),
    session: { id: '', surface: surface.id }
  };
  let html = '';
  if (surface.desc) html += '<div class="mini-note">' + plugEsc(surface.desc) + '</div>';
  html += tree ? plugRenderTree(tree, ctx) : '<div class="mini-note">这个页面没有声明组件树。</div>';
  if (surface.action) {
    html += '<div class="pc-actions"><button type="button" class="pc-btn pc-primary"' + plugActionAttr(plugin, surface.action) + '>' +
      plugEsc(surface.action.label || '执行') + '</button></div>';
  }
  body.innerHTML = html;
}
function plugRuntimeEntriesHtml() {
  const groups = USER_PLUGINS.filter(p => Array.isArray(p.surfaces) && p.surfaces.length);
  if (!groups.length) return '';
  let html = '<div class="sec-title" style="margin-top:16px">🧩 插件页面与入口</div>';
  html += '<div class="mini-note" style="margin-top:6px">这些页面、入口、命令和后台任务都由插件清单声明，宿主没有为某个插件写死入口。</div>';
  groups.forEach(p => {
    const enabled = plugStateOf(p) !== 'disabled';
    const pages = plugPluginSurfaces(p, 'page');
    const settings = plugPluginSurfaces(p, 'settings');
    const entries = plugPluginSurfaces(p, 'entry');
    const sessions = plugPluginSurfaces(p, 'sessionType');
    const commands = plugPluginSurfaces(p, 'command');
    const jobs = plugPluginSurfaces(p, 'job');
    const renderers = plugPluginSurfaces(p, 'renderer');
    const adapters = plugPluginSurfaces(p, 'adapter');
    const themes = plugPluginSurfaces(p, 'theme');
    if (!pages.length && !settings.length && !entries.length && !sessions.length && !commands.length && !jobs.length && !themes.length) return;
    let block = '<div class="plug-group"><div class="plug-group-hd"><span class="plug-group-ic">' + plugEsc(p.icon) + '</span><span class="plug-group-name">' + plugEsc(p.name) +
      '<span class="plug-sub">v' + plugEsc(p.version) + ' · 开放运行时</span></span>' + (enabled ? '' : '<span class="plug-sub">已停用</span>') + '</div>';
    const nav = (label, pid, sid, disabled) => '<button type="button" class="pc-btn pc-mini" data-plug-open="' + plugEsc(pid + ':' + sid) + '"' + (disabled ? ' disabled' : '') + '>' + plugEsc(label) + '</button>';
    pages.forEach(s => { block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(s.title) + '</div><div class="pc-row-d">页面 · ' + plugEsc(s.id) + '</div></div>' + nav('打开', p.id, s.id, !enabled) + '</div>'; });
    settings.forEach(s => { block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(s.title) + '</div><div class="pc-row-d">设置分区 · ' + plugEsc(s.id) + '</div></div>' + nav('配置', p.id, s.id, !enabled) + '</div>'; });
    entries.forEach(s => {
      const token = plugRegisterAction(p, s.action);
      block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(s.title) + '</div><div class="pc-row-d">入口 · ' + plugEsc(s.mount) + '</div></div>' +
        '<button type="button" class="pc-btn pc-mini" data-plug-act="' + plugEsc(token) + '"' + (enabled && s.action ? '' : ' disabled') + '>触发</button></div>';
    });
    sessions.forEach(s => {
      const token = plugRegisterAction(p, { type: 'session.create', session: s.id, permissions: s.permissions });
      block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(s.title) + '</div><div class="pc-row-d">会话类型 · ' + plugEsc(s.id) + '</div></div>' +
        '<button type="button" class="pc-btn pc-mini" data-plug-act="' + plugEsc(token) + '"' + (enabled ? '' : ' disabled') + '>新建</button></div>';
    });
    themes.forEach(s => {
      const apply = plugRegisterAction(p, { type: 'theme.apply', theme: s.id, scope: 'global', permissions: s.permissions });
      const reset = plugRegisterAction(p, { type: 'theme.reset', scope: 'global', permissions: s.permissions });
      const mark = s.background ? ' · 含背景图' : '';
      block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">' + plugEsc(s.title) + '</div><div class="pc-row-d">主题包 · ' + plugEsc(s.id) + mark + '</div></div>' +
        '<button type="button" class="pc-btn pc-mini" data-plug-act="' + plugEsc(apply) + '"' + (enabled ? '' : ' disabled') + '>应用</button>' +
        '<button type="button" class="pc-btn pc-mini" data-plug-act="' + plugEsc(reset) + '"' + (enabled ? '' : ' disabled') + '>重置</button></div>';
    });
    if (commands.length) block += '<div class="pc-row-d">命令：' + plugEsc(commands.map(s => s.command).join(' ')) + '</div>';
    if (jobs.length) block += '<div class="pc-row-d">后台任务：' + plugEsc(jobs.map(s => s.id + '（每 ' + s.every + ' 秒）').join('、')) + '</div>';
    if (renderers.length) block += '<div class="pc-row-d">渲染模板：' + plugEsc(renderers.map(s => s.id).join('、')) + '</div>';
    if (adapters.length) block += '<div class="pc-row-d">适配器（0.15 开放实现）：' + plugEsc(adapters.map(s => s.id + ':' + s.kind).join('、')) + '</div>';
    if (!settings.length && (p.configFields || []).length) {
      block += '<div class="pc-row-item"><div class="pc-row-main"><div class="pc-row-t">插件配置</div><div class="pc-row-d">' + plugEsc((p.configFields || []).length + ' 项') + '</div></div>' + nav('配置', p.id, '', !enabled) + '</div>';
    }
    html += block + '</div>';
  });
  return html;
}
async function plugHandleUiAction(el) {
  if (!el || !el.dataset) return false;
  const token = el.dataset.plugAct;
  if (token) {
    const ref = PLUG_ACTION_REFS[token];
    if (!ref) { toast('这个动作已过期，请重新打开页面'); return true; }
    const plugin = USER_PLUGINS.filter(p => p.id === ref.pluginId)[0];
    if (!plugin) { toast('插件已不存在'); return true; }
    const r = await plugRunAction(plugin, ref.action, { sessionId: '' });
    if (!r || r.ok === false) toast((r && r.error) || '动作执行失败');
    return true;
  }
  if (el.dataset.plugChoice) {
    // 选择项只填入输入框，发送仍由用户决定；自定义输入不受限制。
    const input = $('#input');
    if (input) { input.value = String(el.dataset.plugChoice); input.focus(); }
    return true;
  }
  if (el.dataset.plugChoiceCustom) {
    const input = $('#input');
    if (input) { input.value = ''; input.focus(); }
    return true;
  }
  if (el.dataset.plugOpen) {
    const parts = String(el.dataset.plugOpen).split(':');
    plugOpenPage(parts[0], parts.slice(1).join(':'));
    return true;
  }
  if (el.dataset.plugConfig) {
    const parts = String(el.dataset.plugConfig).split(':');
    plugOpenConfig(parts[0], parts.slice(1).join(':'));
    return true;
  }
  return false;
}
function plugHandleConfigChange(el) {
  if (!el || !el.dataset || !el.dataset.plugCfg) return false;
  const plugin = USER_PLUGINS.filter(p => p.id === PLUG_PAGE_CTX.pluginId)[0];
  if (!plugin) return true;
  const key = String(el.dataset.plugCfg);
  const field = (plugConfigFieldsOf(plugin, PLUG_PAGE_CTX.surfaceId ? plugPluginSurfaces(plugin, 'settings').filter(s => s.id === PLUG_PAGE_CTX.surfaceId)[0] : null).fields || [])
    .filter(f => f.key === key)[0];
  if (!field) return true;
  let value = el.type === 'checkbox' ? !!el.checked : el.value;
  // secret 留空表示保持原值，不覆盖密钥仓。
  if (field.type === 'secret' && !String(value || '')) return true;
  const r = plugConfigSet(plugin, key, value);
  if (!r.ok) toast(r.error || '配置保存失败');
  else plugAudit('config_set', plugin, { tool: key });
  return true;
}
function plugCommandFind(text) {
  const s = String(text || '').trim();
  if (s.charAt(0) !== '/') return null;
  const cmd = s.split(/\s+/)[0];
  const hit = plugSurfaceList('command').filter(x => x.surface.command === cmd)[0];
  if (!hit) return null;
  return { plugin: hit.plugin, surface: hit.surface, args: s.slice(cmd.length).trim() };
}
async function plugCommandRun(hit, rawArgs) {
  if (!hit) return { ok: false, error: '命令不存在' };
  if (!plugSurfaceEnabled(hit.plugin, hit.surface)) return { ok: false, error: '插件已停用或命令权限未授权' };
  plugAudit('command', hit.plugin, { tool: hit.surface.id });
  const action = hit.surface.action;
  if (!action) return { ok: true };
  const args = String(rawArgs || '');
  const act = JSON.parse(JSON.stringify(action));
  if (act.type === 'message.send') act.text = String(act.text || '').replace(/\{\{\s*args\s*\}\}/g, args);
  return await plugRunAction(hit.plugin, act, { command: hit.surface.command, args });
}
