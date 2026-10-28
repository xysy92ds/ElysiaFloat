/* ==========================================================
 *  状态
 * ========================================================== */
let CONFIG = Object.assign({}, DC, sGet('via_ai_config', {}) || {});
/* E2-004：旧版本把 Key 直接存在 via_ai_config 里。启动时收进 AndroidKeyStore，
 * 再把剔除 Key 的副本写回，保证明文不再落盘；已迁移的用户则从密钥仓取回内存。 */
if (secretHydrate(CONFIG, SECRET_FIELDS_CFG, 'ai')) {
  sSet('via_ai_config', CONFIG);
}
if (!sGet('via_ai_task_timeout_v1200', false) && CONFIG.agentTaskTimeout === 90000) {
  CONFIG.agentTaskTimeout = 1200000;
  sSet('via_ai_task_timeout_v1200', true);
  sSet('via_ai_config', CONFIG);
}
if (!sGet('via_ai_context_turns_v35', false) && CONFIG.maxContextTurns === 10) {
  CONFIG.maxContextTurns = 35;
  sSet('via_ai_context_turns_v35', true);
  sSet('via_ai_config', CONFIG);
}

/* ==========================================================
 *  任务模型 v1：先隔离聊天、短任务、手机任务和工作任务上下文。
 *  后续 Agent 调度器、工作区和外部 Agent 都复用这套生命周期。
 * ========================================================== */
const TASK_KEY = 'via_ai_tasks_v1';
const TASK_CURRENT_KEY = 'via_ai_current_task_v1';
const TASK_TYPES = { chat: '聊天', quick: '快捷任务', device: '手机控制', workspace: '工作任务', external: '外部 Agent' };
const TASK_STATES = { new: '新建', active: '运行中', waiting_user: '等待确认', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', archived: '已归档' };
const TASK_TRANSITIONS = {
  new: ['active', 'cancelled', 'failed', 'archived'],
  active: ['waiting_user', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_user: ['active', 'paused', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'cancelled', 'failed', 'archived'],
  completed: ['archived', 'active'],   // 允许在同一任务里接着说下一句
  failed: ['active', 'archived'],
  cancelled: ['active', 'archived'],
  archived: []
};
/* ==========================================================
 *  设备任务状态机（G5-1）
 *  与任务的状态（active/paused/...）正交：这里只描述「设备动作的相位」。
 *  用户决定：不对“必须先读屏”做硬拦，入口自动补一次 orient 即可。
 * ========================================================== */
const DEVICE_PHASES = { idle: '空闲', orienting: '读取页面', planning: '规划', acting: '执行动作', verifying: '验证页面' };
const DEVICE_PHASE_TRANSITIONS = {
  idle: ['orienting', 'planning', 'acting'],
  orienting: ['planning', 'acting', 'idle'],
  planning: ['acting', 'idle'],
  acting: ['verifying', 'idle'],
  verifying: ['acting', 'orienting', 'idle']
};
function deviceState(t) {
  if (!t || typeof t !== 'object') return null;
  if (!t.device || typeof t.device !== 'object' || Array.isArray(t.device)) t.device = {};
  const d = t.device;
  if (!DEVICE_PHASES[d.phase]) d.phase = 'idle';
  if (!Number.isFinite(d.actionsUsed)) d.actionsUsed = 0;
  if (!Number.isFinite(d.failStreak)) d.failStreak = 0;
  if (typeof d.lastHash !== 'string') d.lastHash = '';
  if (typeof d.lastAction !== 'string') d.lastAction = '';
  if (!Number.isFinite(d.lastAt)) d.lastAt = 0;
  if (!Number.isFinite(d.readAt)) d.readAt = 0;
  return d;
}
function devicePhaseOf(id) {
  const t = TASKS.find(x => x.id === id); if (!t) return 'idle';
  return deviceState(t).phase;
}
/** 非法相位迁移不覆盖当前相位，只记事件并返回 false。 */
function deviceSetPhase(id, phase, meta) {
  const t = TASKS.find(x => x.id === id); if (!t) return false;
  const d = deviceState(t);
  if (!DEVICE_PHASES[phase]) return false;
  if (phase !== d.phase && (DEVICE_PHASE_TRANSITIONS[d.phase] || []).indexOf(phase) < 0) {
    taskEvent(id, 'invalid_device_phase', { from: d.phase, to: phase, action: (meta && meta.action) || '' });
    return false;
  }
  const prev = d.phase;
  d.phase = phase;
  if (meta && meta.action) d.lastAction = String(meta.action);
  t.updatedAt = taskNow();
  saveTasks();
  if (prev !== phase) taskEvent(id, 'device_phase', { from: prev, to: phase, action: (meta && meta.action) || '' });
  return true;
}
function deviceBudget(t) {
  const n = parseInt(CONFIG.deviceMaxActions, 10);
  return Math.max(20, Math.min(2000, isFinite(n) ? n : 120));
}
function deviceBudgetLeft(t) {
  const d = deviceState(t);
  return Math.max(0, deviceBudget(t) - (parseInt(d.actionsUsed, 10) || 0));
}
function deviceGrantMore(t) {
  const d = deviceState(t); if (!d) return 0;
  const chunk = Math.max(20, Math.min(2000, parseInt(CONFIG.deviceActionResumeChunk, 10) || 120));
  d.actionsUsed = Math.max(0, (parseInt(d.actionsUsed, 10) || 0) - chunk);
  saveTasks();
  return chunk;
}

function deviceReset(id) {
  const t = TASKS.find(x => x.id === id); if (!t) return;
  const d = deviceState(t);
  d.phase = 'idle'; d.failStreak = 0;
  t.updatedAt = taskNow(); saveTasks();
}

function taskNow() { return new Date().toISOString(); }
function taskId(type) { return 'task-' + type + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
function taskNormalize(t) {
  if (!t || typeof t !== 'object') return null;
  const type = TASK_TYPES[t.type] ? t.type : 'chat';
  return Object.assign({ id: taskId(type), type, title: TASK_TYPES[type], state: 'active', createdAt: taskNow(), updatedAt: taskNow(), goal: '', mode: type, context: { messages: [] }, workspaceId: '', currentStep: 0, totalSteps: 0, progress: '', error: '', artifacts: [], events: [] }, t, { type, state: TASK_STATES[t.state] ? t.state : 'active' });
}
let TASKS = (function () {
  const saved = sGet(TASK_KEY, []);
  const list = Array.isArray(saved) ? saved.map(taskNormalize).filter(Boolean) : [];
  if (!list.some(t => t.type === 'chat')) list.unshift(taskNormalize({ id: 'task-chat-main', type: 'chat', title: '当前聊天' }));
  return list.slice(0, 50);
})();
let CURRENT_TASK_ID = String(sGet(TASK_CURRENT_KEY, '') || '');
function currentTask() { return TASKS.find(t => t.id === CURRENT_TASK_ID) || TASKS[0]; }
function taskHistoryKey(id) { return 'via_ai_history_task_' + String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_'); }
// 旧版本曾把不同任务共用全局对话；非聊天任务首次升级时清空旧的共享上下文。
TASKS.forEach(t => {
  if (t.type !== 'chat' && (!t.context || t.context.taskScoped !== true)) {
    t.context = { messages: [], taskScoped: true };
    sSet(taskHistoryKey(t.id), []);
  }
});
if (!TASKS.some(t => t.id === CURRENT_TASK_ID)) CURRENT_TASK_ID = TASKS.find(t => t.type === 'chat').id;
/* 自愈：旧版本可能留下多个聊天任务，这里静默合并成一个（保留当前正在用的那个） */
if (TASKS.filter(t => t.type === 'chat').length > 1 && typeof taskEnsureChat === 'function') {
  try { taskEnsureChat(); } catch (e) {}
}
function taskSaveContext(t) {
  if (!t) return;
  t.context = t.context || {};
  t.context.taskScoped = true;
  t.context.messages = Array.isArray(history) ? history.slice() : (t.context.messages || []);
  sSet(taskHistoryKey(t.id), t.context.messages);
  t.updatedAt = taskNow();
}
function taskLoadContext(t) {
  if (!t) return;
  const stored = sGet(taskHistoryKey(t.id), null);
  const msgs = Array.isArray(stored) ? stored : (t.context && t.context.taskScoped && Array.isArray(t.context.messages) ? t.context.messages : []);
  history = msgs.length ? msgs : [{ role: 'system', content: CONFIG.systemPrompt }];
  if (!t.context) t.context = {};
  t.context.taskScoped = true;
  t.context.messages = history.slice();
  sSet(taskHistoryKey(t.id), history);
}
function saveTasks() { sSet(TASK_KEY, TASKS.slice(0, 50)); sSet(TASK_CURRENT_KEY, CURRENT_TASK_ID); }

/* ==========================================================
 *  G2-005 能力授权
 *  同一任务内 30 分钟复用；只放内存，进程重启即失效。
 *  简化的是“问人次数”：L3、无障碍、白名单、路径校验仍由原生门禁执行，
 *  密码框、发送消息、支付、卸载、外部删除依旧逐次确认。
 * ========================================================== */
const CONSENT_TTL_MS = 30 * 60 * 1000;
const CONSENTS = Object.create(null);
function consentKey(taskId, cap) { return String(taskId || '') + ':' + String(cap || ''); }
function consentGranted(taskId, cap) {
  if (!taskId || !cap) return false;
  const k = consentKey(taskId, cap), exp = CONSENTS[k] || 0;
  if (exp > Date.now()) return true;
  if (k in CONSENTS) delete CONSENTS[k];
  return false;
}
function consentGrant(taskId, cap) {
  if (!taskId || !cap) return false;
  CONSENTS[consentKey(taskId, cap)] = Date.now() + CONSENT_TTL_MS;
  try { taskEvent(taskId, 'consent_granted', { capability: String(cap), ttlSec: CONSENT_TTL_MS / 1000 }); } catch (e) {}
  return true;
}
function consentRevokeTask(taskId) {
  const prefix = consentKey(taskId, '');
  Object.keys(CONSENTS).forEach(k => { if (k.indexOf(prefix) === 0) delete CONSENTS[k]; });
  try { taskEvent(taskId, 'consent_revoked', {}); } catch (e) {}
}
/** 设备类动作：已授权直接过；未授权只问一次，拒绝返回 false */
async function ensureDeviceConsent(task) {
  if (!task) return false;
  if (consentGranted(task.id, 'device')) return true;
  const ok = await uiConfirm('这一步需要操作手机：读取屏幕、点击或输入。\n\n本次任务 30 分钟内不再重复询问；密码框、发送消息、支付和卸载仍会逐次确认。', '允许操作手机', '手机控制授权');
  if (!ok) return false;
  consentGrant(task.id, 'device');
  return true;
}
/** 公共存储写入/复制/建目录：同一任务授权一次；删除仍逐次确认 */
async function ensureExternalWriteConsent(task, detail, okText, title) {
  if (!task) return false;
  if (consentGranted(task.id, 'external_write')) return true;
  const ok = await uiConfirm(detail + '\n\n本次任务 30 分钟内不再逐次询问；删除仍需单次确认。', okText, title);
  if (!ok) return false;
  consentGrant(task.id, 'external_write');
  return true;
}

const QUICK_OPS = new Map();
function quickOperationBegin(title, goal, timeoutMs) {
  const t = taskNormalize({ id: 'quick-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), type: 'quick', title: title || '快捷操作', goal: goal || '', state: 'active', context: { messages: [], taskScoped: true }, deadline: Date.now() + (timeoutMs || 30000), progress: '处理中' });
  QUICK_OPS.set(t.id, t); return t;
}
function quickOperationFinish(id, state, error) {
  const t = QUICK_OPS.get(id); if (!t) return null;
  Object.assign(t, { state: state || 'completed', error: error || '', progress: state === 'completed' ? '已完成' : (error || '已停止'), deadline: 0, updatedAt: taskNow() });
  setTimeout(() => QUICK_OPS.delete(id), 1500); return t;
}
function chatTasks() { return TASKS.filter(t => t.type === 'chat'); }
/**
 * 永远只保留一个主聊天任务。
 * 旧版本在每次「使用聊天模式」或其它任务切回聊天时会新建聊天任务，
 * 导致主聊天越点越多且无法删除；这里在启动和进入聊天时自动合并。
 */
function taskEnsureChat() {
  let chats = chatTasks();
  if (!chats.length) {
    const t = taskNormalize({ id: 'task-chat-main-' + Date.now().toString(36), type: 'chat', title: '当前聊天' });
    TASKS.unshift(t);
    CURRENT_TASK_ID = t.id;
    saveTasks();
    return t;
  }
  if (chats.length > 1) {
    const keep = chats.find(c => c.id === CURRENT_TASK_ID) || chats[0];
    const drop = chats.filter(c => c.id !== keep.id);
    const merged = [{ role: 'system', content: CONFIG.systemPrompt }];
    const pushMsgs = (ctx) => {
      const arr = (ctx && Array.isArray(ctx.messages)) ? ctx.messages : [];
      arr.forEach(m => { if (m && m.role !== 'system') merged.push(m); });
    };
    pushMsgs(keep.context);
    drop.forEach(o => {
      pushMsgs(o.context);
      try { if (typeof clearTaskHistory === 'function') clearTaskHistory(o.id); } catch (e) {}
      try { sSet(taskHistoryKey(o.id), []); } catch (e) {}
    });
    keep.context = Object.assign({}, keep.context, { messages: merged, taskScoped: true });
    keep.title = '当前聊天';
    keep.updatedAt = taskNow();
    // 原地修改：任何持有 TASKS 引用的地方（UI/测试/副作用）都要看到同一个数组
    const keptChats = TASKS.filter(t => t.type !== 'chat' || t.id === keep.id);
    TASKS.splice(0, TASKS.length, ...keptChats);
    sSet(taskHistoryKey(keep.id), merged);
    if (!TASKS.some(t => t.id === CURRENT_TASK_ID)) CURRENT_TASK_ID = keep.id;
    saveTasks();
    chats = [keep];
  }
  return chats[0];
}

function taskBegin(type, title, goal, timeoutMs) {
  if (type === 'quick') return quickOperationBegin(title, goal, timeoutMs || 30000);
  // 聊天任务永远复用同一个主聊天：不新建、不重置预算
  if (type === 'chat') {
    const ct = taskEnsureChat();
    if (CURRENT_TASK_ID !== ct.id) { taskSaveContext(currentTask()); CURRENT_TASK_ID = ct.id; taskLoadContext(ct); saveTasks(); }
    return ct;
  }
  const old = currentTask();
  const t = (old && old.type === type && taskContinuable(old)) ? old : taskAdd(type, title || TASK_TYPES[type], goal || '');
  if (t.type === 'device') deviceReset(t.id);
  taskUpdate(t.id, { state: 'active', phase: 'planning', goal: goal || t.goal, deadline: Date.now() + (timeoutMs || CONFIG.agentTaskTimeout || 1200000), progress: '正在规划' });
  taskEvent(t.id, 'started', { type, goal: goal || t.goal });
  return t;
}
function taskTouch(id, progress, patch) {
  if (QUICK_OPS.has(id)) { Object.assign(QUICK_OPS.get(id), patch || {}, { progress: progress || '', updatedAt: taskNow() }); return QUICK_OPS.get(id); }
  return taskUpdate(id, Object.assign({ progress: progress || '' }, patch || {}));
}
function taskFinish(id, state, error) {
  if (QUICK_OPS.has(id)) return quickOperationFinish(id, state, error);
  deviceReset(id);
  return taskUpdate(id, { state: state || 'completed', error: error || '', progress: state === 'completed' ? '已完成' : (error || '已停止'), deadline: 0 });
}
function taskAdd(type, title, goal) { taskSaveContext(currentTask()); const t = taskNormalize({ type, title: title || TASK_TYPES[type], goal: goal || '', state: 'active' }); TASKS.unshift(t); CURRENT_TASK_ID = t.id; taskLoadContext(t); saveTasks(); renderTaskDrawer(); updateTaskMode(); refreshSystemPrompt(false); return t; }
function syncTaskWorkspace(t) { if (!t || t.type !== 'workspace' || !t.workspaceReady || !(HAS_PERM && Perm.updateTaskWorkspace)) return; try { Perm.updateTaskWorkspace(t.id, t.state || 'active', t.phase || '', t.progress || ''); } catch (e) {} }
function taskEvent(id, type, data) { const t = TASKS.find(x => x.id === id); if (!t) return; const event = { type: String(type || 'event'), at: taskNow(), data: data || {} }; t.events = Array.isArray(t.events) ? t.events : []; t.events.push(event); if (t.events.length > 100) t.events = t.events.slice(-100); t.updatedAt = taskNow(); saveTasks(); if (t.type === 'workspace' && t.workspaceReady && HAS_PERM && Perm.appendTaskLog) { try { Perm.appendTaskLog(t.id, JSON.stringify(event)); } catch (e) {} } }
function taskUpdate(id, patch) {
  const t = TASKS.find(x => x.id === id); if (!t) return null;
  const next = patch && patch.state ? String(patch.state) : t.state;
  if (next !== t.state && (!TASK_STATES[next] || !(TASK_TRANSITIONS[t.state] || []).includes(next))) {
    t.events = Array.isArray(t.events) ? t.events : [];
    t.events.push({ type: 'invalid_transition', at: taskNow(), data: { from: t.state, to: next } });
    if (t.events.length > 100) t.events = t.events.slice(-100);
    t.errorCode = 'INVALID_STATE_TRANSITION'; t.error = '非法任务状态迁移：' + t.state + ' → ' + next;
    t.updatedAt = taskNow(); saveTasks();
    return null;
  }
  Object.assign(t, patch || {}, { updatedAt: taskNow() });
  saveTasks(); syncTaskWorkspace(t); renderTaskDrawer(); updateTaskMode(); return t;
}
function taskPause(id) { const t = taskUpdate(id, { state: 'paused', progress: '已暂停' }); if (t && (id === CURRENT_TASK_ID || id === ACTIVE_RUN_TASK_ID)) { stopRequested = true; cancelTaskRequests(id); toast('任务已暂停'); } }
function taskResume(id) {
  const t = TASKS.find(x => x.id === id); if (!t) return;
  // 恢复即重置预算：否则长任务暂停后 deadline 早已过期，恢复会立刻 DEADLINE_EXCEEDED
  const budget = t.type === 'chat' ? 30000 : (CONFIG.agentTaskTimeout || 1200000);
  // 设备任务若因动作预算耗尽而暂停，恢复时补一批
  let progress = '等待继续';
  if (t.type === 'device') {
    const d = deviceState(t);
    if (deviceBudgetLeft(t) <= 0) {
      const granted = deviceGrantMore(t);
      progress = '已追加 ' + granted + ' 次动作预算，等待继续';
    }
  }
  const resumed = taskUpdate(id, { state: 'active', error: '', progress: progress, deadline: Date.now() + budget });
  if (!resumed) return;
  CURRENT_TASK_ID = id; saveTasks(); updateTaskMode();
  toast('任务已恢复；下一轮会重新检查任务现场');
}
function taskCancel(id) { const t = taskUpdate(id, { state: 'cancelled', progress: '已取消', deadline: 0 }); if (t && (id === CURRENT_TASK_ID || id === ACTIVE_RUN_TASK_ID)) { stopRequested = true; cancelTaskRequests(id); } toast('任务已停止'); }
function taskSetCurrent(id) {
  const t = TASKS.find(x => x.id === id); if (!t) return;
  taskSaveContext(currentTask());
  CURRENT_TASK_ID = id;
  taskLoadContext(t);
  saveHistory();
  taskSaveContext(t);
  saveTasks();
  renderTaskDrawer(); updateTaskMode(); refreshSystemPrompt(false);
  showView('chat'); renderHistory();
  toast('已切换到：' + t.title);
}
function clearTaskHistory(id) {
  sSet(taskHistoryKey(id), []);
  const t = TASKS.find(x => x.id === id);
  if (t) { t.context = { messages: [], taskScoped: true }; t.updatedAt = taskNow(); saveTasks(); }
}
async function deleteTask(id) {
  const t = TASKS.find(x => x.id === id); if (!t) return;
  if (t.type === 'chat' && chatTasks().length <= 1) return toast('至少要保留一个聊天，只能清空上下文');
  if (!(await uiConfirm(t.type === 'chat' ? '删除这个聊天记录？\n\n里面的消息会一起删除。' : '删除任务记录“' + t.title + '”？\n\n任务上下文会删除；工作区文件默认保留。', t.type === 'chat' ? '删除聊天' : '删除任务', '任务删除'))) return;
  const removeFiles = t.type === 'workspace' && await uiConfirm('是否同时删除该任务工作区文件？此操作不可恢复。', '删除文件', '工作区删除');
  if (removeFiles && HAS_PERM && Perm.deleteTaskWorkspace) { try { Perm.deleteTaskWorkspace(t.id); } catch (e) {} }
  consentRevokeTask(t.id);
  clearTaskHistory(t.id);
  // 原地删除，避免把 TASKS 换成新数组导致外部引用陈旧
  for (let i = TASKS.length - 1; i >= 0; i--) if (TASKS[i].id === id) TASKS.splice(i, 1);
  if (CURRENT_TASK_ID === id) { CURRENT_TASK_ID = (TASKS.find(x => x.type === 'chat') || TASKS[0] || {}).id || ''; taskLoadContext(currentTask()); }
  saveTasks(); renderTaskDrawer(); updateTaskMode(); renderHistory(); toast('任务已删除');
}
function taskModeText(t) { return t.type === 'chat' ? '聊天' : TASK_TYPES[t.type] || '任务'; }
function taskStateText(t) { return TASK_STATES[t.state] || '运行中'; }
function updateTaskMode() { const t = currentTask(); const mode = $('#mode-label'); if (mode) mode.textContent = taskModeText(t); const name = $('#name'); if (name) name.textContent = CONFIG.assistantName || '爱莉希雅'; }
function taskToolsAllowed(type, name, taskId) {
  const device = ['read_screen','screenshot','watch_screen','find_app','tap_screen','click_text','swipe_screen','input_text','press_key','launch_app','get_current_page'];
  const files = ['workspace_status','workspace_create','workspace_list','workspace_read','workspace_write','workspace_mkdir','external_file_list','external_file_read','external_file_write','external_file_copy','external_file_mkdir','external_file_delete'];
  const runtime = ['run_termux_job','termux_job_status','termux_job_output','termux_job_cancel','termux_jobs_list','root_operation'];
  const quick = ['quick'];
  if (quick.indexOf(type) >= 0) return true;
  if (name === 'read_screen_once') return true;
  if (device.indexOf(name) >= 0) {
    // 兼容现有聊天层的只读能力探测：真正的点击、输入和启动仍只能在 device/quick 任务中执行。
    if (type === 'chat') return ['find_app', 'watch_screen'].indexOf(name) >= 0;
    if (type === 'device' || type === 'quick') return true;
    // G2-005：工作任务里获准操作手机后，设备工具留在同一任务内执行，不再切任务。
    if (type === 'workspace') return consentGranted(taskId, 'device');
    return false;
  }
  if (files.indexOf(name) >= 0) return type === 'workspace';
  return true;
}
function taskRouteText(text, att) { if (att && att.kind === 'text') return 'workspace'; if (att && att.kind === 'image') return 'quick'; return classifyTask(text); }
/** 同一任务可以「继续」的状态：完成/失败/暂停后再说一句话，应该回到原任务而不是新建或跳走 */
function taskContinuable(t) {
  if (!t || t.type === 'quick') return false;
  return ['active', 'waiting_user', 'paused', 'completed', 'failed'].indexOf(t.state) >= 0;
}
async function routeTask(type, goal) {
  const old = currentTask();
  // 同类型且可继续 → 直接复用（保住工作区目录、上下文和任务记录）
  if (old.type === type && taskContinuable(old)) {
    // 工作区已就绪就不再重复创建/确认，避免"继续说话"时又弹一次或直接失败
    if (type === 'workspace' && old.workspaceReady !== true) {
      const ready = await ensureTaskWorkspace(old);
      if (!ready.ok) { toast(ready.error || '工作区不可用'); return null; }
    }
    return old;
  }
  if (type === 'chat') { taskSetCurrent(TASKS.find(t => t.type === 'chat').id); return currentTask(); }
  if (type === 'quick') return quickOperationBegin(String(goal || '快捷操作').slice(0, 30), goal || '', 30000);
  if (type === 'device') {
    // G2-005：已经在工作/手机任务里就直接复用，不再新建任务把原工作区留在后台。
    if (old && (old.type === 'device' || old.type === 'workspace') && taskContinuable(old)) {
      if (!(await ensureDeviceConsent(old))) return null;
      return old;
    }
    if (!(await uiConfirm('这需要进入手机控制模式。Agent 将读取屏幕，并可能操作白名单应用；高风险动作仍会再次确认。\n\n进入后本次任务 30 分钟内不再重复询问。', '进入手机控制', '任务模式确认'))) return null;
    const deviceTask = taskAdd('device', String(goal || '手机控制任务').slice(0, 30), goal || '');
    consentGrant(deviceTask.id, 'device');
    return deviceTask;
  }
  if (type === 'workspace') {
    if (!(await uiConfirm('这需要创建或切换到独立工作任务。工作区内写入免逐次确认，外部文件修改会先征求同意。', '进入工作任务', '任务模式确认'))) return null;
    const task = taskAdd('workspace', String(goal || '工作任务').slice(0, 30), goal || '');
    const ready = await ensureTaskWorkspace(task);
    if (!ready.ok) { taskFinish(task.id, 'failed', ready.error || '工作区创建失败'); toast(ready.error || '工作区创建失败'); return null; }
    return task;
  }
  return taskAdd(type, String(goal || TASK_TYPES[type]).slice(0, 30), goal || '');
}
async function runChatTask(task, runner) { return await runner(task); }
async function runQuickTask(task, runner) { return await runner(task); }
async function runDeviceTask(task, runner) { return await runner(task); }
async function runWorkspaceTask(task, runner) { return await runner(task); }
function renderTaskDrawer() { const box = $('#task-list'); if (!box) return; const list = TASKS.filter(t => t.state !== 'archived').slice(0, 12); const cur = currentTask();
  const detail = (cur && cur.type === 'workspace' && cur.workspaceReady) ? (function () {
    const idx = taskIndex(cur); const snaps = taskSnapshots(cur);
    const files = idx && Array.isArray(idx.files) ? idx.files.slice(0, 6) : [];
    const snapList = snaps && Array.isArray(snaps.snapshots) ? snaps.snapshots.slice(0, 4) : [];
    return '<div class="task-detail"><div class="task-detail-head">当前工作区：tasks/' + esc(cur.id) + '</div>' +
      '<div class="task-detail-meta">文件 ' + ((idx && idx.count) || 0) + ' 个 · 合计 ' + Math.round(((idx && idx.totalBytes) || 0) / 1024) + ' KB</div>' +
      (files.length ? '<div class="task-detail-files">' + files.map(f => '<div class="task-detail-file"><span>' + esc(f.relative) + '</span><span>' + Math.max(1, Math.round((f.size || 0) / 1024)) + ' KB</span></div>').join('') + '</div>' : '<div class="task-detail-meta">还没有文件。上传或让 Agent 写入后会出现在这里。</div>') +
      (snapList.length ? '<div class="task-detail-meta">最近快照：</div>' + snapList.map(s => '<div class="task-detail-file"><span>' + esc(s.relative) + '</span><button data-task-restore="' + esc(s.snapshot) + '">回滚</button></div>').join('') : '') +
      '<div class="acts"><button data-task-action="refresh">刷新工作区</button></div></div>';
  })() : '';
  box.innerHTML = detail + (list.length ? list.map(t => '<div class="task-row ' + (t.id === CURRENT_TASK_ID ? 'active' : '') + '" data-task-id="' + esc(t.id) + '"><div class="task-row-body"><div class="task-row-title">' + esc(t.title) + '</div><div class="task-row-meta">' + esc(taskModeText(t)) + ' · ' + esc(t.progress || '就绪') + '</div></div><span class="task-state">' + esc(taskStateText(t)) + '</span><span class="task-row-actions">' + (t.state === 'paused' ? '<button data-task-action="resume">继续</button>' : (t.state === 'active' ? '<button data-task-action="pause">暂停</button>' : '')) + ((t.state === 'active' || t.state === 'paused' || t.state === 'waiting_user') ? '<button data-task-action="cancel">停止</button>' : '') + '<button data-task-action="delete">删除</button>' + '</span></div>').join('') : '<div class="task-empty">还没有任务</div>');
}
function classifyTask(text) { const s = String(text || '').trim(); if (/放歌|播放|暂停音乐|下一首|上一首|总结屏幕|翻译屏幕|屏幕上|看看屏幕|截图|提取要点|解释屏幕/.test(s)) return 'quick'; if (/打开|启动|点击|按一下|滑动|输入|发送消息|回复消息|操作手机|控制手机/.test(s)) return 'device'; if (/整理文件|整理资料|修改项目|处理文件夹|生成报告|分析项目|批量|工作区|长期处理/.test(s)) return 'workspace'; return 'chat'; }
let history = sGet('via_ai_history', null) || [{ role: 'system', content: CONFIG.systemPrompt }];
if (!Array.isArray(history) || !history.length) history = [{ role: 'system', content: CONFIG.systemPrompt }];
const mainChatTask = TASKS.find(t => t.type === 'chat');
if (mainChatTask && Array.isArray(mainChatTask.context.messages) && mainChatTask.context.messages.length > 1) history = mainChatTask.context.messages;
else if (mainChatTask) { mainChatTask.context.messages = history; mainChatTask.context.taskScoped = true; saveTasks(); }
if (currentTask().type !== 'chat') taskLoadContext(currentTask());

/* ==========================================================
 *  人设 / 工具 分离后的迁移与组装
 * ========================================================== */
function plugOn(id) {
  const p = CONFIG.plugins || {};
  return p[id] !== false;   // 缺字段当开启，老配置直接平滑升级
}
/**
 * 单个工具是否对 AI 开放。CONFIG.toolOff 记录被手动关掉的工具，
 * 缺字段一律视为开启，因此新加工具 / 老配置都能直接兼容。
 */
function toolOn(name) {
  return !(CONFIG.toolOff && CONFIG.toolOff[name]);
}
function modelTimeout() {
  const n = parseInt(CONFIG.modelTimeoutMs, 10);
  return Math.max(60000, Math.min(1800000, isFinite(n) ? n : 600000));
}
/** 文件能力分层：L1 只读 / L2 工作区内写入 / L3+安全 工作区外写入与删除 */
const FILE_READ_TOOLS = ['workspace_status', 'workspace_create', 'workspace_list', 'workspace_read', 'workspace_preview',
  'external_file_list', 'external_file_read'];
const FILE_WRITE_SCOPED = ['workspace_write', 'workspace_mkdir', 'workspace_export'];
const FILE_WRITE_EXTERNAL = ['external_file_write', 'external_file_copy', 'external_file_mkdir', 'external_file_delete'];

function agentActionsOn() {
  return CONFIG.agentEnabled === true && CONFIG.agentL3 === true && CONFIG.agentSafety === true;
}
function agentLevelAtLeast(level) {
  if (CONFIG.agentEnabled !== true) return false;
  const l1 = CONFIG.agentL1 !== false;
  const l2 = CONFIG.agentL2 !== false;
  const l3 = CONFIG.agentL3 === true && CONFIG.agentSafety === true;
  if (level === 'L3') return l3;
  if (level === 'L2') return l2;
  return l1;
}
function agentReadOn() {
  return CONFIG.agentEnabled === true && CONFIG.agentL1 !== false;
}
function hasAllFilesAccess() {
  if (!(HAS_PERM && Perm.hasAllFilesAccess)) return false;
  try { return !!Perm.hasAllFilesAccess(); } catch (e) { return false; }
}
function workspaceState() {
  if (!(HAS_PERM && Perm.workspaceState)) return null;
  try { return JSON.parse(Perm.workspaceState() || '{}'); } catch (e) { return null; }
}
function workspaceReady() {
  const s = workspaceState();
  return !!(s && s.permission && s.created);
}
function taskWorkspaceState(task) {
  if (!task || !(HAS_PERM && Perm.taskWorkspaceState)) return null;
  try { return JSON.parse(Perm.taskWorkspaceState(task.id) || '{}'); } catch (e) { return null; }
}
function taskWorkspacePath(task, relative) {
  const p = String(relative || '').replace(/^[\\/]+/, '');
  if (!task || task.type !== 'workspace') return p;
  const prefix = 'tasks/' + task.id + '/';
  return p.indexOf(prefix) === 0 ? p : prefix + p;
}
function taskRelPath(task, path) {
  const p = String(path || '').replace(/^[\\/]+/, '');
  if (!task || task.type !== 'workspace') return p;
  const prefix = 'tasks/' + task.id + '/';
  return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p;
}
function taskIndex(task) {
  if (!task || task.type !== 'workspace' || !(HAS_PERM && Perm.taskWorkspaceIndex)) return null;
  try { return JSON.parse(Perm.taskWorkspaceIndex(task.id) || '{}'); } catch (e) { return null; }
}
function taskSnapshots(task) {
  if (!task || task.type !== 'workspace' || !(HAS_PERM && Perm.listTaskSnapshots)) return null;
  try { return JSON.parse(Perm.listTaskSnapshots(task.id) || '{}'); } catch (e) { return null; }
}
async function ensureTaskWorkspace(task) {
  if (!task || task.type !== 'workspace') return { ok: true };
  const existing = taskWorkspaceState(task);
  if (existing && existing.created) { task.workspaceId = 'tasks/' + task.id; task.workspaceReady = true; saveTasks(); return existing; }
  if (!(HAS_PERM && Perm.createTaskWorkspace)) return { ok: false, error: '当前环境不支持独立任务工作区' };
  try {
    const r = JSON.parse(Perm.createTaskWorkspace(task.id, task.title || '工作任务', task.goal || '') || '{}');
    if (r.ok) { task.workspaceId = 'tasks/' + task.id; task.workspaceReady = true; taskUpdate(task.id, { workspaceId: task.workspaceId, progress: '工作区已准备' }); }
    return r;
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}
async function importAttachmentToTask(task, att) {
  if (!task || task.type !== 'workspace' || !att || att.kind !== 'text') return { ok: true, skipped: true };
  if (!(HAS_PERM && Perm.importTaskText)) return { ok: false, error: '当前环境不支持导入任务文件' };
  // 解析出来的正文统一存成 .txt：原名是 report.docx 之类的话，存成 docx 会让后续读取误判
  const rawName = String(att.name || 'upload.txt');
  const baseName = rawName.replace(/\.[^.]*$/, '') || 'upload';
  const isPlain = /\.(txt|md|json|csv|tsv|log|xml|html|yml|yaml)$/i.test(rawName);
  const name = (att.source && att.source !== 'text' && !isPlain) ? (baseName + '.txt') : rawName;
  try { return JSON.parse(Perm.importTaskText(task.id, name, att.text || '') || '{}'); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
}
function agentActionNames() {
  return ['tap_screen', 'click_text', 'swipe_screen', 'input_text', 'press_key', 'launch_app'];
}
function hasA11y() {
  if (!(HAS_PERM && Perm.hasAccessibility)) return false;
  try { return !!Perm.hasAccessibility(); } catch (e) { return false; }
}
function canShot() {
  if (!(HAS_PERM && Perm.canScreenshot)) return false;
  try { return !!Perm.canScreenshot(); } catch (e) { return false; }
}
/** 这一组现在是不是真的能用（开关开着 + 外部条件满足）。 */
function groupLive(id) {
  if (!plugOn(id)) return false;
  if (id === 'screen') return hasA11y() || canShot();
  if (id === 'agent') return agentReadOn();
  if (id === 'files') return hasAllFilesAccess();
  if (id === 'music') return !!CONFIG.musicEnabled;
  return true;
}
function builtInToolPermission(name) {
  const p = PLUG_CAPABILITY_PERMS && PLUG_CAPABILITY_PERMS[name];
  return Array.isArray(p) ? p : (p ? [p] : []);
}
/** 单个工具现在能不能调（工具 JSON schema 和提示词两边共用这一份判断）。 */
function toolLive(name) {
  if (!toolOn(name)) return false;
  const cp = plugFind(name);
  if (cp) return cp.plugin.enabled !== false && plugToolPermissionsGranted(cp.plugin, cp.tool);
  if (name === 'read_screen_once') return plugOn('screen') && hasA11y();
  if (name === 'read_screen' || name === 'get_current_page') return plugOn('screen') && hasA11y() && agentReadOn();
  if (name === 'screenshot' || name === 'watch_screen') return plugOn('screen') && canShot()
    && agentReadOn() && CONFIG.agentL2 !== false;
  if (name === 'find_app') return plugOn('agent') && agentReadOn();
  if (agentActionNames().indexOf(name) >= 0) return plugOn('agent') && agentActionsOn();
  // 文件能力全部统一到 L1/L2/L3 + 安全开关，不再单独加一层"动作开关"
  if (FILE_READ_TOOLS.indexOf(name) >= 0) {
    return plugOn('files') && hasAllFilesAccess() && agentLevelAtLeast('L1');
  }
  if (FILE_WRITE_SCOPED.indexOf(name) >= 0) {
    // 工作区是受控写入区：L2 即可，不再要求 L3
    return plugOn('files') && workspaceReady() && agentLevelAtLeast('L2');
  }
  if (FILE_WRITE_EXTERNAL.indexOf(name) >= 0) {
    // 工作区外仍然要求 L3 + 安全开关 + 所有文件访问
    return plugOn('files') && hasAllFilesAccess() && agentLevelAtLeast('L3');
  }
  if (name === 'run_termux_job' || name === 'root_operation') return plugOn('runtime') && agentActionsOn();
  if (name === 'open_url' || name === 'set_clipboard') return plugOn('system');
  if (name === 'search_and_play_music' || name === 'music_control') return plugOn('music') && !!CONFIG.musicEnabled && !(CONFIG.toolOff && CONFIG.toolOff[name]);
  return plugOn('memory');   // 剩下的都是记忆组
}

/** 把“工具”那一段拼出来 —— 只列真的能用的，开关一关马上从提示词里消失。 */
function buildToolsPrompt() {
  const blocks = [], tips = [];
  PLUGINS.forEach(p => {
    if (!groupLive(p.id)) return;
    const names = p.tools.filter(toolLive);
    if (!names.length) return;
    blocks.push('【' + p.name + '】\n' + names.map(n => '· ' + n + '：' + TOOL_DOC[n]).join('\n'));
    if (PLUGIN_TIPS[p.id]) tips.push(PLUGIN_TIPS[p.id]);
  });
  // 自定义插件：只列出开启中的工具，说明取第一行，避免提示词过长
  USER_PLUGINS.forEach(p => {
    if (p.enabled === false) return;
    const names = p.tools.filter(t => toolLive(t.name));
    if (!names.length) return;
    blocks.push('【' + p.name + '（自定义插件）】\n' + names.map(t =>
      '· ' + t.name + '：' + String(t.description || '').split('\n')[0] + '（权限：' + plugToolPermissions(p, t).join('、') + '）').join('\n'));
  });
  if (!blocks.length) return '';

  const out = ['你还能真的动手，手里有这些工具：', blocks.join('\n')];
  if (plugOn('memory')) {
    out.push('关于记忆：你有一本自己的长期记忆库，存在他的手机里。每一轮你只会看到一份'
      + '「分类概览 + 重要 + 最近」的索引，正文不在眼前——需要细节就 list_memories 检索、'
      + 'read_memory 读全文，别拿标题猜内容。');
  }
  if (agentActionsOn()) out.push('手机行为：你可以自主选择 tap_screen、click_text、swipe_screen、input_text、press_key、launch_app 完成任务。每次行为后读取页面验证；发送、删除、支付、密码等高风险行为先向用户确认。要发送聊天消息时，输入完后用 press_key enter 提交，不要点被键盘挡住的按钮。只回话不调用工具等于没执行。');
  const ct = currentTask();
  if (ct && (ct.type === 'workspace' || ct.type === 'device' || ct.type === 'external')) {
    out.push('如果任务是接着上一轮继续（被中断/暂停/失败），先读取当前真实状态再动作，不要复述计划，也不要假装已经完成。');
  }
  if (tips.length) out.push(tips.join('\n'));
  return out.join('\n');
}

/** 时间之类的运行时信息，每轮都重新算。 */
function buildContextPrompt() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return '当前时间：' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 星期' + week + '。';
}

/** 三段合体。AI 读到的始终是完整信息，只是人不再能一不小心改坏工具说明。 */
function composeSystemPrompt() {
  const persona = String(CONFIG.persona || DC.persona || DEFAULT_PERSONA).trim();
  const active = currentTask();
  const isWork = !!active && (active.type === 'workspace' || active.type === 'device' || active.type === 'external');
  const parts = [];
  // 1) 规则与输出纪律永远最先，且不含人设
  parts.push(PROMPT_CORE);
  // 2) 模式决定主体：工作模式用标准 Agent 协议，人设只留给"汇报语气"
  if (isWork) {
    parts.push(PROMPT_WORK);
    if (CONFIG.workPrompt && active.type === 'workspace') parts.push('【工作偏好（用户自定义）】\n' + String(CONFIG.workPrompt).trim());
    parts.push(PROMPT_WORK_TONE + '\n人设参考：' + persona);
  } else {
    parts.push(persona);
    parts.push(PROMPT_CHAT_OUTPUT);
  }
  if (CONFIG.agentEnabled === true) parts.push(AGENT_SYSTEM_PROMPT);
  if (active && active.type === 'device') {
    const d = deviceState(active);
    parts.push('【手机控制任务】\n1. 动作用 read_screen 返回的 rx/ry 比例坐标，不要自己猜像素；\n2. 一次只做一个主要动作，做完系统会自动验证页面变化；\n3. 页面没变化时会警告，连续 3 次未生效会自动暂停；\n4. 密码框输入会请用户确认，其它输入不会打断；\n5. 只在白名单应用内操作，切到别处会被立刻终止；\n6. 动作预算 ' + (parseInt(d.actionsUsed, 10) || 0) + '/' + deviceBudget(active) + '，用完会暂停而不是失败，用户说继续就再给一批；\n7. 发送消息：输入完成后用 press_key enter 提交（或 click_text「发送」），不要点被键盘挡住的坐标；发送前系统会再确认；\n8. 只回话而没有调用工具等于什么都没做。上一轮被中断、失败或停过，先用 read_screen 读当前真实页面，再从那里继续，不许假装已经完成。');
  }
  const t = buildToolsPrompt();
  if (t) parts.push(t);
  parts.push(buildContextPrompt());
  return parts.filter(Boolean).join('\n\n');
}

/** 重建缓存并同步到 system 消息。改人设、改插件开关后都要叫一次。 */
function refreshSystemPrompt(syncHistory) {
  CONFIG.systemPrompt = composeSystemPrompt();
  if (syncHistory !== false) {
    if (!history.length || history[0].role !== 'system') history.unshift({ role: 'system', content: '' });
    history[0] = { role: 'system', content: CONFIG.systemPrompt };
  }
}

// 老版本的默认提示词没有工具说明：用户没改过就自动升级，改过就尊重他自己那份
if (CONFIG.systemPrompt === PROMPT_V1 || CONFIG.systemPrompt === PROMPT_V12) {
  CONFIG.systemPrompt = DC.systemPrompt;
}

/**
 * 人设初始化（只跑一次）：
 *   改过默认提示词的老用户 —— 把那份原文当成人设，并关闭自动工具段，
 *   以免把工具说明追加两遍。他们可以到设置里手动打开。
 *   用过默认提示词的 —— 直接换成干净的人设，工具段自动接上。
 */
/* 旧默认人设自动升级到「始源之律者」版本；用户自己写过的人设不动 */
if (CONFIG.persona && /^你是爱莉希雅，世界蛇数据库中的一段特殊数据/.test(String(CONFIG.persona))) {
  CONFIG.persona = DC.persona;
  sSet('via_ai_config', CONFIG);
}
if (!CONFIG.persona) {
  const builtin = [DC.systemPrompt, PROMPT_V12, PROMPT_V1];
  if (builtin.indexOf(String(CONFIG.systemPrompt || '')) >= 0) {
    CONFIG.persona = DEFAULT_PERSONA;
  } else {
    CONFIG.persona = String(CONFIG.systemPrompt || '').trim() || DEFAULT_PERSONA;
  }
  sSet('via_ai_config', CONFIG);
}
if (!CONFIG.plugins || typeof CONFIG.plugins !== 'object') CONFIG.plugins = Object.assign({}, DC.plugins);

