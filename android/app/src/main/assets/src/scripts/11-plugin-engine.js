/* ==========================================================
 *  插件执行引擎
 *   - http 类：宿主直接发请求（先做 URL 校验）
 *   - js  类：丢进 sandbox iframe，插件只能通过 host.* 回调宿主
 *  所有 host 调用都回到这里统一校验，插件碰不到 Android.* 桥。
 * ========================================================== */

/** 网络能力按插件声明和用户授权分级；默认拒绝本机、局域网和链路本地地址。 */
function plugIsLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}
function plugUrlPermission(u) {
  try {
    const url = new URL(String(u));
    return plugIsLocalHost(url.hostname) ? 'network.local' : 'network.public';
  } catch (e) { return ''; }
}
function plugUrlAllowed(u, allowLocal) {
  let url;
  try { url = new URL(String(u)); } catch (e) { return '网址格式不正确'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只允许 http/https 请求';
  const host = String(url.hostname || '').toLowerCase();
  if (!host) return '网址缺少主机名';
  if (plugIsLocalHost(host) && !allowLocal) return '不允许访问本机或局域网地址；需要声明并开启 network.local';
  return '';
}
function plugNetworkAllowed(plugin, url) {
  const permission = plugUrlPermission(url);
  if (!permission || !plugPermissionGranted(plugin, permission)) return false;
  if (permission === 'network.local' && CONFIG.agentSafety !== true) return false;
  return !plugUrlAllowed(url, permission === 'network.local');
}

function plugParseBody(text) {
  if (typeof text !== 'string') return text;
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) return '';
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.parse(t); } catch (e) { /* 不是 JSON 就原样返回 */ }
  }
  return t.slice(0, 50000);
}

/** 统一入口：按工具的 kind 选择执行方式。 */
async function plugExec(plugin, tool, args, runTask) {
  if (!plugin || !tool) return plugFailure('PLUGIN_NOT_FOUND', '插件或工具不存在');
  if (plugin.enabled === false || plugin.state === 'disabled') return plugFailure('PLUGIN_DISABLED', '插件已停用');
  if (plugin.state === 'quarantined') return plugFailure('PLUGIN_QUARANTINED', '插件处于隔离状态，禁止调用');
  if (!plugToolPermissionsGranted(plugin, tool)) return plugFailure('PERMISSION_DENIED', '插件工具权限未获用户授权');
  plugin.invokeCount = (parseInt(plugin.invokeCount, 10) || 0) + 1;
  plugin.invokedAt = new Date().toISOString();
  plugSaveList();
  plugAudit('invoke', plugin, { tool: tool.name });
  if (tool.kind === 'http') {
    const r = tool.request;
    const url = plugTemplate(r.url, args);
    if (!plugNetworkAllowed(plugin, url)) {
      return plugFailure('NETWORK_PERMISSION_DENIED', '插件未获准访问该网络地址；请检查 permissions、用户授权和安全开关。');
    }
    const bad = plugUrlAllowed(url, plugUrlPermission(url) === 'network.local');
    if (bad) return plugFailure('INVALID_URL', bad);
    const headers = {};
    for (const k in r.headers) headers[k] = plugTemplate(String(r.headers[k]), args);
    const body = r.body ? plugTemplate(r.body, args) : '';
    try {
      const res = await reqRequest({
        method: r.method, url: url, headers: headers, body: body,
        timeoutMs: tool.timeout || 20000,
        taskId: (runTask && runTask.id) || '',
        source: 'plugin:' + plugin.id,
        expect: 'text', retries: 1
      });
      const data = plugParseBody(res.text);
      if (res.status < 200 || res.status >= 400) {
        return { success: false, errorCode: 'HTTP_ERROR', status: res.status, error: 'HTTP ' + res.status, data };
      }
      return { success: true, status: res.status, data, meta: { plugin: plugin.id, tool: tool.name } };
    } catch (e) { return plugFailure((e && e.code) || 'NETWORK_ERROR', errMsg(e)); }
  }
  return await plugExecJs(plugin, tool, args, runTask);
}

/* 沙箱页面：opaque origin，拿不到父页面的 DOM / Android 桥，只能 postMessage 回来。 */
const PLUG_SANDBOX_HTML = [
'<!doctype html><meta charset="utf-8">',
// 网络请求仍在沙箱中执行，但必须由 manifest permissions 声明并由宿主传入本次授权。
'<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39; &#39;unsafe-eval&#39;; connect-src http: https:">',
'<scr' + 'ipt>',
'(function(){',
'var allowLocal=false,allowPublic=false;',
'function publicUrl(u){try{var x=new URL(String(u),location.href),h=(x.hostname||"").toLowerCase(),local=h==="localhost"||h==="0.0.0.0"||h==="::1"||h==="[::1]"||h.endsWith(".localhost")||/^127\\./.test(h)||/^169\\.254\\./.test(h)||/^10\\./.test(h)||/^192\\.168\\./.test(h)||/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(h);return (x.protocol==="http:"||x.protocol==="https:")&&(local?allowLocal:allowPublic);}catch(e){return false;}}',
'var nativeFetch=window.fetch;',
'if(nativeFetch){window.fetch=function(input,init){var u=typeof input==="string"?input:(input&&input.url)||"";if(!publicUrl(u))return Promise.reject(new Error("插件网络地址被安全开关拦截"));return nativeFetch.call(window,input,init);};}',
'var NativeXHR=window.XMLHttpRequest;',
'if(NativeXHR){window.XMLHttpRequest=function(){var x=new NativeXHR(),open=x.open;x.open=function(m,u){if(!publicUrl(u))throw new Error("插件网络地址被安全开关拦截");return open.apply(x,arguments);};return x;};}',
'var NativeWS=window.WebSocket;',
'if(NativeWS){window.WebSocket=function(u,p){if(!publicUrl(u))throw new Error("插件网络地址被安全开关拦截");return p===undefined?new NativeWS(u):new NativeWS(u,p);};}',
'var pending={},seq=0;',
'function callHost(method,params){return new Promise(function(res,rej){var id="h"+(++seq);pending[id]={res:res,rej:rej};parent.postMessage({__elly:"host",id:id,method:method,params:params||{}},"*");});}',
'var host={',
'request:function(o){return callHost("request",o||{});},',
'toast:function(t){return callHost("toast",{text:String(t==null?"":t)});},',
'log:function(){var a=[],i;for(i=0;i<arguments.length;i++){var v=arguments[i];try{a.push(typeof v==="string"?v:JSON.stringify(v));}catch(e){a.push(String(v));}}return callHost("log",{args:a});},',
'openUrl:function(u){return callHost("openUrl",{url:String(u==null?"":u)});},',
'callTool:function(name,args){return callHost("callTool",{name:String(name||""),args:args||{}});},',
'clipboard:{write:function(t){return callHost("clipboardWrite",{text:String(t==null?"":t)});}},',
'storage:{',
'get:function(k){return callHost("storageGet",{key:String(k)}).then(function(r){return r?r.value:undefined;});},',
'set:function(k,v){return callHost("storageSet",{key:String(k),value:v});}}',
'};',
'window.addEventListener("message",function(ev){',
'var d=ev.data;if(!d||d.__elly!=="run")return;var rid=d.id;allowLocal=!!d.allowLocal;allowPublic=!!d.allowPublic;',
'Promise.resolve().then(function(){',
'var fn=new Function("host","\\"use strict\\";"+d.code+"\\n;return (typeof run===\\"function\\")?run:null;");',
'var run=fn(host);',
'if(typeof run!=="function")throw new Error("插件没有定义 run 函数");',
'return run(d.args||{});',
'}).then(function(v){parent.postMessage({__elly:"result",id:rid,ok:true,value:v},"*");},',
'function(e){parent.postMessage({__elly:"result",id:rid,ok:false,error:(e&&e.message)||String(e)},"*");});',
'});',
'window.addEventListener("message",function(ev){',
'var d=ev.data;if(!d||d.__elly!=="hostres")return;var p=pending[d.id];if(!p)return;delete pending[d.id];',
'if(d.ok)p.res(d.value);else p.rej(new Error(d.error||"host 调用失败"));',
'});',
'parent.postMessage({__elly:"ready"},"*");',
'})();',
'</scr' + 'ipt>'
].join('\n');

let plugFrame = null;
let plugSandboxReady = null;
let plugSandboxResolver = null;
let plugRunSeq = 0;
const plugRunPending = {};
let plugRunning = null;
let plugLock = Promise.resolve();
function cancelPluginTask(taskId) {
  if (!plugRunning || plugRunning.taskId !== taskId) return;
  Object.keys(plugRunPending).forEach(id => {
    const p = plugRunPending[id];
    if (!p) return;
    delete plugRunPending[id];
    if (p.timer) clearTimeout(p.timer);
    try { p.reject(new Error('任务已取消')); } catch (e) {}
  });
}

function ensurePlugSandbox() {
  if (plugFrame) return plugFrame;
  plugSandboxReady = new Promise((res) => { plugSandboxResolver = res; });
  const f = document.createElement('iframe');
  f.id = 'plug-sandbox';
  f.setAttribute('sandbox', 'allow-scripts');
  f.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0';
  f.srcdoc = PLUG_SANDBOX_HTML;
  document.body.appendChild(f);
  plugFrame = f;
  return f;
}

function respondPlugHost(id, ok, value) {
  try {
    plugFrame.contentWindow.postMessage({
      __elly: 'hostres', id, ok,
      value: ok ? value : undefined,
      error: ok ? '' : String(value || '')
    }, '*');
  } catch (e) {}
}

function onPlugSandboxMessage(ev) {
  if (plugFrame && ev.source && ev.source !== plugFrame.contentWindow) return;
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.__elly === 'ready') {
    if (plugSandboxResolver) { plugSandboxResolver(); plugSandboxResolver = null; }
    return;
  }
  if (d.__elly === 'result') {
    const p = plugRunPending[d.id];
    if (!p) return;
    delete plugRunPending[d.id];
    if (p.timer) clearTimeout(p.timer);
    if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || '插件执行失败'));
    return;
  }
  if (d.__elly === 'host') {
    plugHandleHost(d.method, d.params).then(
      v => respondPlugHost(d.id, true, v),
      e => respondPlugHost(d.id, false, errMsg(e))
    );
  }
}
window.addEventListener('message', onPlugSandboxMessage);

function plugStore(pid) {
  const all = sGet(PLUG_DATA_KEY, {}) || {};
  return (all[pid] && typeof all[pid] === 'object') ? all[pid] : {};
}
function plugSaveStore(pid, store) {
  const all = sGet(PLUG_DATA_KEY, {}) || {};
  all[pid] = store;
  sSet(PLUG_DATA_KEY, all);
}

async function plugHandleHost(method, params) {
  const p = params || {};
  const running = plugRunning || {};
  const hostTask = TASKS.find(t => t.id === running.taskId) || currentTask();
  const pid = running.pluginId || 'unknown';
  const plugin = USER_PLUGINS.filter(x => x.id === pid)[0] || null;
  if (!plugin) throw new Error('插件上下文不存在');
  if (method === 'request') {
    const m = String(p.method || 'GET').toUpperCase();
    const url = String(p.url || '');
    if (!plugNetworkAllowed(plugin, url)) throw new Error('插件未获准访问该网络地址；请检查 network.public/network.local 和安全开关');
    const bad = plugUrlAllowed(url, plugUrlPermission(url) === 'network.local');
    if (bad) throw new Error(bad);
    const headers = (p.headers && typeof p.headers === 'object') ? p.headers : {};
    const body = (p.body === undefined || p.body === null)
      ? '' : (typeof p.body === 'string' ? p.body : JSON.stringify(p.body));
    const t = Math.min(Math.max(parseInt(p.timeout, 10) || 20000, 1000), 60000);
    const r = await reqRequest({
      method: m, url: String(p.url), headers: headers, body: body,
      timeoutMs: t || 20000, taskId: (running.taskId || ''),
      source: 'plugin:' + pid, expect: 'text', retries: 1, maxBytes: 800000
    });
    return { status: r.status, text: String(r.text || '').slice(0, 200000) };
  }
  if (method === 'toast') { toast(String(p.text || '').slice(0, 200)); return true; }
  if (method === 'log') {
    try { console.log('[插件:' + pid + ']', (p.args || []).join(' ')); } catch (e) {}
    return true;
  }
  if (method === 'openUrl') {
    if (!plugPermissionGranted(plugin, 'system.open_url')) throw new Error('插件未声明或未获准 system.open_url');
    const url = String(p.url || '');
    const bad = plugUrlAllowed(url, false);
    if (bad) throw new Error(bad);
    if (HAS_NATIVE && Android.openUrl) Android.openUrl(url);
    return true;
  }
  if (method === 'clipboardWrite') {
    if (!plugPermissionGranted(plugin, 'clipboard.write')) throw new Error('插件未声明或未获准 clipboard.write');
    return writeClipboard(String(p.text || ''));
  }
  if (method === 'storageGet') {
    if (!plugPermissionGranted(plugin, 'storage.plugin')) throw new Error('插件未声明或未获准 storage.plugin');
    return { value: plugStore(pid)[String(p.key || '')] };
  }
  if (method === 'storageSet') {
    if (!plugPermissionGranted(plugin, 'storage.plugin')) throw new Error('插件未声明或未获准 storage.plugin');
    const s = plugStore(pid);
    s[String(p.key || '')] = p.value;
    plugSaveStore(pid, s);
    return true;
  }
  if (method === 'callTool') {
    const name = String(p.name || '');
    const permissions = plugCapabilityPermissions(name);
    if (name === 'read_screen_once' && !agentReadOn()) throw new Error('插件读取屏幕需要 Agent L1；请先在设置中开启 Agent 和 L1');
    if (!permissions.length || !permissions.every(permission => plugPermissionGranted(plugin, permission))) {
      throw new Error('插件未声明或未获准调用能力：' + name + '（需要：' + permissions.join('、') + '）');
    }
    if (plugFind(name)) throw new Error('插件不能通过 host.callTool 调用其它自定义插件');
    const runTask = hostTask;
    return await execTool(name, p.args && typeof p.args === 'object' ? p.args : {}, runTask);
  }
  throw new Error('未知的沙箱调用：' + method);
}

/** JS 插件：串行执行，保证 host 调用能对上当前插件。 */
function plugExecJs(plugin, tool, args, runTask) {
  const run = async () => {
    const f = ensurePlugSandbox();
    if (!plugSandboxReady) return plugFailure('SANDBOX_UNAVAILABLE', '插件沙箱不可用');
    try {
      await Promise.race([
        plugSandboxReady,
        new Promise((_, rej) => setTimeout(() => rej(new Error('插件沙箱初始化超时')), 3000))
      ]);
    } catch (e) { return plugFailure('SANDBOX_INIT_ERROR', errMsg(e)); }
    const id = 'p' + (++plugRunSeq);
    plugRunning = { pluginId: plugin.id, toolName: tool.name, taskId: runTask && runTask.id ? runTask.id : currentTask().id };
    try {
      const value = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          delete plugRunPending[id];
          reject(new Error('插件执行超时'));
        }, tool.timeout);
        plugRunPending[id] = { resolve, reject, timer };
        f.contentWindow.postMessage({ __elly: 'run', id, code: tool.code, args,
          allowLocal: plugPermissionGranted(plugin, 'network.local') && CONFIG.agentSafety === true,
          allowPublic: plugPermissionGranted(plugin, 'network.public') }, '*');
      });
      // 结果过大就截断，避免一条工具结果把上下文撑爆
      let out = value;
      try {
        const s0 = JSON.stringify(value);
        if (s0 && s0.length > 50000) out = { truncated: true, preview: s0.slice(0, 20000) };
      } catch (e) {}
      return { success: true, result: out, meta: { plugin: plugin.id, tool: tool.name } };
    } catch (e) {
      return plugFailure('PLUGIN_RUNTIME_ERROR', errMsg(e));
    } finally {
      plugRunning = null;
    }
  };
  const queued = plugLock.then(run, run);
  plugLock = queued.then(() => {}, () => {});
  return queued;
}

let toolsBroken = false;
/** 每轮新的用户消息都重新试一次工具调用：一次性的 400 不该毒化整个会话。 */
function resetToolFallback() { toolsBroken = false; }

/** 找出对话里最后一条带图片的 user 消息（截图 / 用户上传的图片） */
function lastImageMsgIndex(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
    if (m.content.some(p => p && p.type === 'image_url')) return i;
  }
  return -1;
}
/** 多模态消息里取出文字部分 */
function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.find(p => p && p.type === 'text');
    return t ? (t.text || '') : '';
  }
  return '';
}

async function chatReqTools(messages, hooks) {
  hooks = hooks || {};
  const runToken = RUN_TOKEN;
  if (!CONFIG.apiKey) throw new Error('未填写 API Key，请到设置里配置');
  if (toolsBroken) return await chatReq(messages);
  const proc = (function () {
    const memBlock = memResidentBlock();
    return messages.map((m, i) => {
      if (m.role !== 'system') return m;
      const c = parseVars(m.content);
      return { role: 'system', content: (i === 0 && memBlock) ? c + '\n\n' + memBlock : c };
    });
  })();
  const activeRunTask = hooks.task || currentTask();
  const taskId = activeRunTask && activeRunTask.id ? activeRunTask.id : currentTask().id;
  const tools = buildTools(activeRunTask);
  // 0 = 按任务时间运行，不设工具轮数上限；有限模式是用户主动选择的保护。
  const rawMaxRounds = parseInt(CONFIG.agentToolRounds, 10);
  const maxRounds = rawMaxRounds === 0
    ? Infinity
    : (Number.isFinite(rawMaxRounds) ? Math.max(1, rawMaxRounds) : 5);
  const maxRoundsForState = Number.isFinite(maxRounds) ? maxRounds : 0;
  const taskDeadline = activeRunTask && activeRunTask.state === 'active'
    ? (activeRunTask.deadline || Date.now() + (activeRunTask.type === 'chat' ? modelTimeout() : (CONFIG.agentTaskTimeout || 1200000))) : 0;
  if (activeRunTask && taskDeadline) taskTouch(activeRunTask.id, '正在处理', { deadline: taskDeadline });
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey };
  const url = CONFIG.apiBase.replace(/\/$/, '') + '/chat/completions';
  let imageMsg = null, imageDataUrl = '';
  const hasVision = !!(CONFIG.visionBase && CONFIG.visionKey && CONFIG.visionModel);

  let round = 0;
  while (round < maxRounds) {
    if (runIsStale(runToken) || stopRequested) {
      if (activeRunTask && taskDeadline) taskFinish(activeRunTask.id, 'cancelled', '用户停止了任务');
      return '（已由你停止本轮工具执行）';
    }
    if (taskDeadline && Date.now() >= taskDeadline) {
      taskFinish(activeRunTask.id, 'failed', '任务超过时间限制');
      return '（任务超过时间限制，已保存当前状态）';
    }
    round++;
    if (activeRunTask && taskDeadline) taskTouch(activeRunTask.id, '第 ' + round + ' 轮处理中', { currentStep: round, totalSteps: maxRoundsForState });
    if (hooks.onRound) { try { hooks.onRound(round, maxRoundsForState); } catch (e) {} }
    // 0.12：每轮推进持久会话心跳（内部 10s 节流，不会写爆存储）。
    if (activeRunTask && typeof persistHeartbeat === 'function') { try { persistHeartbeat(activeRunTask); } catch (e) {} }
    compactTaskMessages(proc);
    taskTouch(activeRunTask.id, '第 ' + round + ' 轮请求模型', { phase: 'planning', currentStep: round, totalSteps: maxRoundsForState });
    const body = JSON.stringify({ model: CONFIG.model, messages: (proc.some(m => m && m.role === 'user') ? proc : proc.concat([{ role: 'user', content: '（继续上一步）' }])), stream: false, tools, tool_choice: 'auto' });
    let msg = null, fallback = false, errText = '';
    try {
      // 模型单次预算 200s；有任务 deadline 时取剩余时间，且不超过 200s
      const modelBudget = modelTimeout();
      const remaining = taskDeadline ? Math.max(1000, Math.min(modelBudget, taskDeadline - Date.now())) : modelBudget;
      const resp = await reqRequest({
        method: 'POST', url: url, headers: headers, body: body,
        timeoutMs: remaining, deadlineAt: taskDeadline || 0, taskId: taskId,
        expect: 'json', retries: 0, source: 'model'
      });
      const d = resp.json;
      if (d.error) throw new Error(d.error.message || 'API 错误');
      msg = d.choices && d.choices[0] && d.choices[0].message;
      if (!msg) throw new Error('响应格式异常');
    } catch (e) {
      errText = errMsg(e);
      // 对话模型不吃图片 → 先用识图模型看懂，再换成文字重试（截图和用户上传的图片都走这里）
      const imgIdx = hasVision ? lastImageMsgIndex(proc) : -1;
      if (imgIdx >= 0) {
        const part = (proc[imgIdx].content || []).find(p => p && p.type === 'image_url');
        const data = part && part.image_url && part.image_url.url;
        const isShot = proc[imgIdx] === imageMsg;
        let desc = '';
        try {
          desc = await visionDescribe(data, isShot
            ? '这是用户手机当前的屏幕截图。请如实、详细地描述画面：是什么应用、有哪些文字、用户大概在做什么。用中文回答，不要编造看不到的内容。'
            : '这是用户主动发给你的图片。请如实、详细地描述画面：画的是什么、有哪些文字、大概是做什么用的。用中文回答，不要编造看不到的内容。');
        } catch (e2) { desc = ''; }
        if (data && desc) {
          const keep = textOfContent(proc[imgIdx].content);
          proc[imgIdx] = { role: 'user', content: (keep ? keep + '\n\n' : '') + '[识图模型对这张图片的描述]\n' + desc };
          if (isShot) { imageMsg = null; imageDataUrl = ''; }
          continue;
        }
      }
      // 只有「这个模型压根不支持工具调用」才降级成无工具对话。
      // 以前把任意 400 都当成工具不支持，一旦撞上上下文超长之类的普通 400，
      // 就会把 toolsBroken 永久置真 —— 之后每轮都不再发工具，
      // 表现就是「她只回话、不调用工具，怎么强调都没用」。
      const toolUnsupported = /tool[_ ]?call|tool[_ ]?choice|function[_ ]?call|does not support (tools|functions)|tools? (are|is) not supported|unsupported.{0,20}tool/i.test(errText);
      if (toolUnsupported) { fallback = true; } else { throw new Error(errText); }
    }
    if (fallback) { toolsBroken = true; return await chatReq(messages); }
    if (msg === null) return await chatReq(messages);
    if (!msg.tool_calls || !msg.tool_calls.length) {
      if (activeRunTask && taskDeadline) taskFinish(activeRunTask.id, 'completed');
      return msg.content || '';
    }

    taskTouch(activeRunTask.id, '正在执行工具', { phase: 'execute' });
    proc.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    // 模型可以在工具调用前先给出一段解释；它会作为独立的 AI 消息显示。
    if (msg.content && String(msg.content).trim() && hooks.onText) {
      try { hooks.onText(String(msg.content).trim()); } catch (e) {}
    }
    pendingShotImage = '';
    pendingShotImages = [];
    const runToolCall = async (c) => {
      if (hooks.onTool) { try { hooks.onTool(c.function.name); } catch (e) {} }
      let result;
      const actionName = c.function.name;
      let actionArgs = {};
      try { actionArgs = JSON.parse(c.function.arguments || '{}'); } catch (e) { return { c, result: { success: false, errorCode: 'BAD_ARGUMENTS', error: '工具参数不是合法 JSON' } }; }
      const deviceAction = isDeviceAction(actionName);
      const at = activeRunTask;
      // 相位与动作计数统一在 execTool 内部维护（单一入口），这里只做前后页面对比
      const beforeScreen = deviceAction ? deviceScreenSummary() : '';
      try { result = await execTool(actionName, actionArgs, activeRunTask); }
      catch (e) { result = { success: false, error: errMsg(e) }; }
      if (deviceAction && result && result.success !== false) {
        const afterScreen = deviceScreenSummary();
        const screenHash = shortHash(afterScreen);
        const same = at.lastAction === actionName && at.screenHash && at.screenHash === screenHash && shortHash(beforeScreen) === screenHash;
        const repeat = same ? (parseInt(at.repeatCount, 10) || 0) + 1 : 0;
        taskUpdate(at.id, { lastAction: actionName, screenHash, repeatCount: repeat });
        if (repeat >= 1) result = Object.assign({}, result, { warning: '动作完成后页面没有变化，可能没有生效。' });
        if (repeat >= 2) { result = { success: false, error: '连续重复动作且页面没有变化，已停止以避免误操作。', errorCode: 'REPEATED_NO_CHANGE' }; stopRequested = true; taskFinish(at.id, 'failed', result.error); }
      }
      return { c, result };
    };
    const calls = msg.tool_calls;
    // G5-1 执行计划：只读类工具并行；设备动作与其它工具按原顺序串行排队
    const { parIdx, serIdx } = planToolBatch(calls);
    if (serIdx.length) taskEvent(activeRunTask.id, 'device_queue', { total: calls.length, parallel: parIdx.length, serial: serIdx.length });
    const slot = new Array(calls.length);
    if (parIdx.length) {
      const done = await Promise.all(parIdx.map(i => runToolCall(calls[i])));
      parIdx.forEach((i, k) => { slot[i] = done[k]; });
    }
    for (const i of serIdx) {
      if (stopRequested) break;
      slot[i] = await runToolCall(calls[i]);
    }
    const results = slot.filter(Boolean);
    results.forEach(({ c, result }) => proc.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) }));
    // 0.12：工具动作计入持久会话预算；超限会由 persistBudgetCount 触发暂停（不是失败）。
    if (activeRunTask && typeof persistBudgetCount === 'function' && results.length) {
      try { persistBudgetCount(activeRunTask, 'actions', results.length); } catch (e) {}
    }
    if (runIsStale(runToken) || stopRequested) return '（已由你停止本轮工具执行）';
    if (parIdx.length > 1) taskEvent(activeRunTask.id, 'parallel_tools', { count: parIdx.length });
    taskTouch(activeRunTask.id, '已完成工具，正在验证', { phase: 'verify' });
    // tool 结果不能带图：截图/观察另行作为一条 user 消息交给模型。
    const shotList = pendingShotImages.length ? pendingShotImages : (pendingShotImage ? [pendingShotImage] : []);
    if (shotList.length) {
      imageDataUrl = shotList[shotList.length - 1];
      pendingShotImage = '';
      pendingShotImages = [];
      imageMsg = { role: 'user', content: [
        { type: 'text', text: shotList.length > 1 ? '（这是刚刚限时观察取得的屏幕画面，请比较这些画面后回答）' : '（这是刚刚截取的当前屏幕画面，请据此回答用户的问题）' },
        ...shotList.map(url => ({ type: 'image_url', image_url: { url: url } }))
      ] };
      proc.push(imageMsg);
    }
    if (stopRequested) return '（已由你停止本轮工具执行）';
  }
  const limitText = Number.isFinite(maxRounds) ? maxRounds + ' 轮' : '任务时间';
  if (activeRunTask && taskDeadline) taskFinish(activeRunTask.id, 'failed', '已达到工具轮数上限');
  return '（已达到设置的工具轮数 ' + limitText + '，本轮已停止。你可以在设置中调整。）';
}
function compactTaskMessages(list) {
  if (!Array.isArray(list) || list.length <= 26) return;
  // 开头的 system 必须留在最前；此外还至少要保留一条 user，
  // 否则尾部 24 条全是 assistant/tool 时，模型侧会直接 400
  // 「No user query found in messages」。
  const head = [];
  let i = 0;
  while (i < list.length && list[i] && list[i].role === 'system') { head.push(list[i]); i++; }
  const userMsg = list.slice(i).filter(m => m && m.role === 'user')[0] || null;
  const tail = list.slice(-24);
  const kept = head.slice();
  kept.push({ role: 'system', content: '[较早的工具结果已压缩；以当前任务状态和最近结果为准]' });
  if (userMsg && tail.indexOf(userMsg) < 0) kept.push(userMsg);
  list.splice(0, list.length, ...kept, ...tail);
}
function canParallelTool(name) {
  if (isDeviceAction(name)) return false;   // 设备动作必须串行，见 G5-1
  return ['find_app','read_screen','workspace_list','workspace_read','external_file_list','external_file_read','list_memories','read_memory'].indexOf(name) >= 0;
}
/**
 * 批次执行计划（G5-1）：只读类并行；其余（含所有设备动作）按原顺序串行。
 * 抽成纯函数便于测试，避免「顺序对不对」只能靠肉眼。
 */
function planToolBatch(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const parIdx = [], serIdx = [];
  list.forEach((c, i) => {
    const n = (c && c.function && c.function.name) || '';
    if (canParallelTool(n)) parIdx.push(i); else serIdx.push(i);
  });
  return { parIdx, serIdx, total: list.length };
}

function shortHash(text) {
  const s = String(text || ''); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function isDeviceAction(name) { return ['tap_screen','click_text','swipe_screen','input_text','press_key','launch_app'].indexOf(name) >= 0; }
function deviceScreenSummary() { try { return hasA11y() ? String(readScreen() || '').slice(0, 16000) : ''; } catch (e) { return ''; } }
const chatSmart = (m, hooks) => chatReqTools(m, hooks);

