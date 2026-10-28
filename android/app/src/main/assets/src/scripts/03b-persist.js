/* ==========================================================
 *  E6 持久会话与长时运行（0.12）
 *
 *  目标：息屏 8 小时会话不丢；进程被杀后能恢复；随时可停。
 *  实现边界：
 *    - 会话状态挂在任务对象上，检查点另存一份快照，重启后合并；
 *    - 心跳只在 JS 活着时推进，原生部分由前台服务 + 唤醒锁保活；
 *    - 看门狗只暂停、不重置预算，恢复时沿用检查点；
 *    - 调度器运行插件 job，失败指数退避，连续失败转暂停；
 *    - 日志按会话分桶，超限轮转，导出时脱敏。
 * ========================================================== */

const PERSIST_SNAPSHOT_KEY = 'via_ai_persist_snapshots';
const PERSIST_LOG_KEY = 'via_ai_persist_logs';
const PERSIST_TUNING = {
  heartbeatMs: 10000,        // 心跳最小写入间隔
  staleMs: 90000,            // 超过这个时间没心跳视为异常（仅参考）
  idlePauseMs: 300000,       // 活跃会话 5 分钟没心跳 → 看门狗暂停
  maxRestarts: 5,            // 连续失败 5 次转暂停
  backoffBase: 5000,
  backoffMax: 300000,
  wakeRefreshMs: 600000,     // 每 10 分钟续一次唤醒锁
  logMax: 120,
  logChars: 24000,
  totalLogChars: 180000,
  tickMs: 30000
};
const PERSIST_JOB_RUNNING = Object.create(null);
let PERSIST_TIMER = 0;

function persistNow() { return new Date().toISOString(); }
function persistMs(iso) { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? t : 0; }
function persistClamp(n, lo, hi, def) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
function persistSnapshots() {
  const all = sGet(PERSIST_SNAPSHOT_KEY, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}
function persistSaveSnapshots(all) { sSet(PERSIST_SNAPSHOT_KEY, all || {}); }
function persistLogsAll() {
  const all = sGet(PERSIST_LOG_KEY, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}
function persistSaveLogs(all) { sSet(PERSIST_LOG_KEY, all || {}); }

/** 确保任务上有持久会话结构；不合法字段就地修正。 */
function persistEnsure(t, opts) {
  if (!t || typeof t !== 'object') return null;
  opts = opts || {};
  const p = (t.persist && typeof t.persist === 'object' && !Array.isArray(t.persist)) ? t.persist : {};
  const now = persistNow();
  p.enabled = opts.enabled !== undefined ? !!opts.enabled : (p.enabled !== false);
  p.goal = String(p.goal || opts.goal || t.goal || t.title || '').slice(0, 300);
  p.phase = String(p.phase || opts.phase || 'running').slice(0, 40);
  p.progress = String(p.progress || opts.progress || t.progress || '').slice(0, 300);
  p.plan = Array.isArray(p.plan) ? p.plan.slice(0, 30).map(x => ({
    id: String((x && x.id) || '').slice(0, 64),
    title: String((x && x.title) || '').slice(0, 120),
    status: ['pending', 'active', 'done', 'failed'].indexOf(String(x && x.status)) >= 0 ? x.status : 'pending'
  })).filter(x => x.id || x.title) : [];
  const budget = (p.budget && typeof p.budget === 'object') ? p.budget : {};
  p.budget = {
    minutes: persistClamp(budget.minutes, 0, 2880, opts.minutes || 480),
    tokens: persistClamp(budget.tokens, 0, 50000000, opts.tokens || 0),
    actions: persistClamp(budget.actions, 0, 100000, opts.actions || 0),
    cost: Math.max(0, Number(budget.cost) || Number(opts.cost) || 0)
  };
  const used = (p.used && typeof p.used === 'object') ? p.used : {};
  p.used = {
    tokens: Math.max(0, parseInt(used.tokens, 10) || 0),
    actions: Math.max(0, parseInt(used.actions, 10) || 0),
    minutes: Math.max(0, Number(used.minutes) || 0),
    cost: Math.max(0, Number(used.cost) || 0)
  };
  p.startedAt = p.startedAt || now;
  p.heartbeatAt = p.heartbeatAt || now;
  p.checkpointAt = p.checkpointAt || '';
  p.restarts = Math.max(0, parseInt(p.restarts, 10) || 0);
  p.nextRunAt = Math.max(0, parseInt(p.nextRunAt, 10) || 0);
  p.lastError = String(p.lastError || '').slice(0, 300);
  p.pausedReason = String(p.pausedReason || '').slice(0, 200);
  p.wakeAt = Math.max(0, parseInt(p.wakeAt, 10) || 0);
  t.persist = p;
  return p;
}
function persistAcquireWake(t, minutes) {
  if (!t || !HAS_PERM || typeof Perm.acquireSessionWakeLock !== 'function') return false;
  const p = persistEnsure(t);
  try {
    const r = JSON.parse(Perm.acquireSessionWakeLock(JSON.stringify({ taskId: t.id, minutes: persistClamp(minutes, 5, 480, 480) })) || '{}');
    if (r && r.ok !== false) p.wakeAt = Date.now();
    return !!(r && r.ok !== false);
  } catch (e) { return false; }
}
function persistReleaseWake(t) {
  if (!HAS_PERM || typeof Perm.releaseSessionWakeLock !== 'function') return false;
  const p = t && t.persist;
  if (p) p.wakeAt = 0;
  try { Perm.releaseSessionWakeLock(); return true; } catch (e) { return false; }
}
function persistStart(t, opts) {
  if (!t) return null;
  const p = persistEnsure(t, opts);
  p.enabled = true;
  p.startedAt = p.startedAt || persistNow();
  p.heartbeatAt = persistNow();
  p.pausedReason = '';
  persistAcquireWake(t, p.budget.minutes);
  persistCheckpoint(t, 'running', t.progress || '开始长时运行');
  persistLog(t.id, 'start', '持久会话开始：' + (p.goal || t.title || t.id));
  return p;
}
function persistHeartbeat(t, patch, opts) {
  if (!t || !t.persist || !t.persist.enabled) return false;
  const p = persistEnsure(t);
  const now = Date.now();
  const last = persistMs(p.heartbeatAt);
  if (!(opts && opts.force) && last && now - last < PERSIST_TUNING.heartbeatMs) {
    if (patch) Object.assign(p, patch);
    return true;
  }
  p.heartbeatAt = persistNow();
  const start = persistMs(p.startedAt) || now;
  p.used.minutes = Math.round((now - start) / 60000 * 10) / 10;
  if (patch && typeof patch === 'object') {
    if (patch.phase) p.phase = String(patch.phase).slice(0, 40);
    if (patch.progress) p.progress = String(patch.progress).slice(0, 300);
    if (patch.goal) p.goal = String(patch.goal).slice(0, 300);
    if (patch.plan) p.plan = patch.plan;
  }
  if (now - (p.wakeAt || 0) > PERSIST_TUNING.wakeRefreshMs) persistAcquireWake(t, p.budget.minutes);
  t.updatedAt = persistNow();
  saveTasks();
  return true;
}
function persistCheckpoint(t, phase, progress, extra) {
  if (!t) return false;
  const p = persistEnsure(t);
  if (phase) p.phase = String(phase).slice(0, 40);
  if (progress) p.progress = String(progress).slice(0, 300);
  p.checkpointAt = persistNow();
  const snaps = persistSnapshots();
  snaps[t.id] = {
    taskId: t.id,
    goal: p.goal,
    phase: p.phase,
    progress: p.progress,
    plan: p.plan.slice(),
    used: Object.assign({}, p.used),
    restarts: p.restarts,
    at: p.checkpointAt,
    extra: extra && typeof extra === 'object' ? JSON.parse(JSON.stringify(extra)) : null
  };
  persistSaveSnapshots(snaps);
  t.updatedAt = persistNow();
  saveTasks();
  return true;
}
function persistLog(taskId, level, message) {
  const key = String(taskId || '');
  if (!key) return false;
  const all = persistLogsAll();
  const list = Array.isArray(all[key]) ? all[key] : [];
  list.push({ at: persistNow(), level: String(level || 'info').slice(0, 12), msg: String(message || '').slice(0, 300) });
  while (list.length > PERSIST_TUNING.logMax) list.shift();
  while (list.length && JSON.stringify(list).length > PERSIST_TUNING.logChars) list.shift();
  all[key] = list;
  // 全局轮转：总量超限时先删最旧的会话日志，避免 localStorage 被长任务撑爆。
  let total = 0;
  Object.keys(all).forEach(k => { total += JSON.stringify(all[k]).length; });
  if (total > PERSIST_TUNING.totalLogChars) {
    Object.keys(all).sort((a, b) => persistMs((all[a][0] || {}).at) - persistMs((all[b][0] || {}).at))
      .forEach(k => { if (total > PERSIST_TUNING.totalLogChars) { total -= JSON.stringify(all[k]).length; delete all[k]; } });
  }
  persistSaveLogs(all);
  return true;
}
function persistLogText(taskId) {
  const list = persistLogsAll()[String(taskId || '')] || [];
  return list.map(x => '[' + String(x.at || '').slice(11, 19) + '][' + x.level + '] ' + x.msg).join('\n');
}
/** 导出日志：去掉可能的密钥形状，只留任务 id 与脱敏文本。 */
function persistExportLogs(taskId) {
  const text = persistLogText(taskId)
    .replace(/(sk-|ghp_|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s]+/gi, '$1=***');
  return text;
}

function persistBudgetExceeded(t) {
  const p = t && t.persist;
  if (!p) return '';
  const b = p.budget, u = p.used;
  if (b.minutes > 0 && u.minutes >= b.minutes) return '时长';
  if (b.tokens > 0 && u.tokens >= b.tokens) return 'token';
  if (b.actions > 0 && u.actions >= b.actions) return '动作数';
  if (b.cost > 0 && u.cost >= b.cost) return '费用';
  return '';
}
function persistBudgetCount(t, field, n) {
  if (!t || !t.persist || !t.persist.enabled) return false;
  const p = persistEnsure(t);
  const key = ['tokens', 'actions', 'cost', 'minutes'].indexOf(String(field)) >= 0 ? String(field) : '';
  if (!key) return false;
  p.used[key] = Math.max(0, (Number(p.used[key]) || 0) + (Number(n) || 0));
  const over = persistBudgetExceeded(t);
  if (over) {
    persistPause(t, '预算熔断：' + over + '已超限，已暂停（不是失败）');
    return true;
  }
  return false;
}
/** 看门狗暂停：保留检查点与预算，随时可恢复。 */
function persistPause(t, reason) {
  if (!t) return false;
  const p = persistEnsure(t);
  p.pausedReason = String(reason || '已暂停').slice(0, 200);
  persistCheckpoint(t, 'paused', p.progress);
  persistLog(t.id, 'pause', p.pausedReason);
  if (typeof taskPause === 'function') {
    try { taskPause(t.id); } catch (e) {}
  }
  persistReleaseWake(t);
  return true;
}
function persistBackoff(t, error) {
  if (!t) return { paused: false, delay: 0 };
  const p = persistEnsure(t);
  p.restarts = Math.max(1, (parseInt(p.restarts, 10) || 0) + 1);
  p.lastError = String(error || '运行异常').slice(0, 300);
  const delay = Math.min(PERSIST_TUNING.backoffMax,
    PERSIST_TUNING.backoffBase * Math.pow(2, Math.max(0, p.restarts - 1)));
  p.nextRunAt = Date.now() + delay;
  persistLog(t.id, 'watchdog', '第 ' + p.restarts + ' 次异常：' + p.lastError + '；' + Math.round(delay / 1000) + ' 秒后重试');
  if (p.restarts > PERSIST_TUNING.maxRestarts) {
    persistPause(t, '看门狗：连续 ' + p.restarts + ' 次异常，已暂停并保留检查点');
    return { paused: true, delay: 0 };
  }
  t.updatedAt = persistNow();
  saveTasks();
  return { paused: false, delay: delay };
}
function persistBackoffReset(t) {
  if (!t || !t.persist) return false;
  t.persist.restarts = 0;
  t.persist.nextRunAt = 0;
  t.persist.lastError = '';
  t.updatedAt = persistNow();
  saveTasks();
  return true;
}
/** 启动恢复：进程重启后所有 active 的持久会话都转 paused，并合并检查点。 */
function persistRecoverAll() {
  const snaps = persistSnapshots();
  let recovered = 0;
  (typeof TASKS !== 'undefined' ? TASKS : []).forEach(t => {
    if (!t || !t.persist || !t.persist.enabled) return;
    const p = persistEnsure(t);
    const snap = snaps[t.id];
    if (snap && typeof snap === 'object') {
      if (snap.goal) p.goal = String(snap.goal).slice(0, 300);
      if (snap.phase) p.phase = String(snap.phase).slice(0, 40);
      if (snap.progress) p.progress = String(snap.progress).slice(0, 300);
      if (Array.isArray(snap.plan)) p.plan = snap.plan.slice(0, 30);
      if (snap.used && typeof snap.used === 'object') p.used = Object.assign({}, p.used, snap.used);
      p.checkpointAt = String(snap.at || p.checkpointAt || '');
    }
    if (t.state === 'active') {
      t.state = 'paused';
      t.progress = '上次运行中断，检查点已保存；点恢复继续';
      t.error = '';
      p.pausedReason = '进程重启自动恢复';
      p.heartbeatAt = persistNow();
      t.events = Array.isArray(t.events) ? t.events : [];
      t.events.push({ type: 'persist_recovered', at: persistNow(), data: { checkpointAt: p.checkpointAt } });
      if (t.events.length > 100) t.events = t.events.slice(-100);
      persistLog(t.id, 'recover', '进程重启：已从检查点恢复（' + (p.phase || 'running') + '）');
      recovered++;
    }
    p.wakeAt = 0;
  });
  if (recovered) saveTasks();
  return recovered;
}
function persistActiveSessions() {
  return (typeof TASKS !== 'undefined' ? TASKS : [])
    .filter(t => t && t.persist && t.persist.enabled && (t.state === 'active' || t.state === 'waiting_user'));
}

/* ---------------- 插件后台任务调度器（E6-005） ---------------- */
function persistJobStore() {
  const all = sGet(PLUG_JOBS_KEY, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}
function persistJobSplit(key) {
  const i = String(key).lastIndexOf(':');
  return i > 0 ? { pluginId: String(key).slice(0, i), surfaceId: String(key).slice(i + 1) } : null;
}
function persistJobBackoff(job) {
  const fails = Math.max(0, parseInt(job.failures, 10) || 0);
  return Math.min(3600000, PERSIST_TUNING.backoffBase * Math.pow(2, Math.max(0, fails - 1)));
}
function persistSchedulerTick(now) {
  now = now || Date.now();
  const jobs = persistJobStore();
  let ran = 0;
  Object.keys(jobs).slice(0, 60).forEach(key => {
    const job = jobs[key];
    if (!job || job.paused) return;
    // nextRun 缺省 / 为 0 表示「立即到期」，不能被 falsy 判断当成未排期。
    if (job.nextRun && job.nextRun > now) return;
    if (PERSIST_JOB_RUNNING[key]) return;
    const ids = persistJobSplit(key);
    if (!ids) return;
    if (typeof plugRunJob !== 'function') return;
    PERSIST_JOB_RUNNING[key] = true;
    Promise.resolve().then(() => plugRunJob(ids.pluginId, ids.surfaceId))
      .then(r => {
        if (!r || r.ok === false) throw new Error((r && r.error) || '后台任务失败');
        job.failures = 0;
        job.lastError = '';
        job.lastRun = Date.now();
        job.nextRun = Date.now() + Math.max(10, parseInt(job.every, 10) || 60) * 1000;
        ran++;
      })
      .catch(e => {
        job.failures = (parseInt(job.failures, 10) || 0) + 1;
        job.lastError = errMsg(e);
        job.nextRun = Date.now() + persistJobBackoff(job);
        if (job.failures >= 3) { job.paused = true; job.error = '连续失败 3 次，已暂停'; }
      })
      .then(() => {
        delete PERSIST_JOB_RUNNING[key];
        sSet(PLUG_JOBS_KEY, jobs);
      });
  });
  // 看门狗：活跃持久会话心跳断掉 → 暂停（不是失败），保留检查点。
  persistActiveSessions().forEach(t => {
    if (t.state !== 'active') return;
    if (typeof sending !== 'undefined' && sending && ACTIVE_RUN_TASK_ID === t.id) return;
    const last = persistMs(t.persist.heartbeatAt);
    if (last && now - last > PERSIST_TUNING.idlePauseMs) {
      persistPause(t, '看门狗：心跳停止超过 ' + Math.round(PERSIST_TUNING.idlePauseMs / 60000) + ' 分钟');
    }
  });
  return ran;
}
function persistSchedulerStart() {
  if (PERSIST_TIMER) return PERSIST_TIMER;
  PERSIST_TIMER = setInterval(() => {
    try { persistSchedulerTick(); } catch (e) { /* 单个 tick 异常不能影响聊天 */ }
  }, PERSIST_TUNING.tickMs);
  return PERSIST_TIMER;
}
function persistSchedulerStop() {
  if (PERSIST_TIMER) { clearInterval(PERSIST_TIMER); PERSIST_TIMER = 0; }
}
function persistJobsSummary() {
  const jobs = persistJobStore();
  const keys = Object.keys(jobs);
  return {
    total: keys.length,
    paused: keys.filter(k => jobs[k] && jobs[k].paused).length,
    failures: keys.reduce((n, k) => n + (parseInt(jobs[k] && jobs[k].failures, 10) || 0), 0)
  };
}

/* ---------------- 保活引导（E6-008） ---------------- */
function persistKeepAliveState() {
  const battery = HAS_PERM && typeof Perm.isIgnoringBattery === 'function' ? !!Perm.isIgnoringBattery() : false;
  const noti = HAS_PERM && typeof Perm.hasNotification === 'function' ? !!Perm.hasNotification() : true;
  const channel = HAS_PERM && typeof Perm.isNotificationChannelOn === 'function' ? !!Perm.isNotificationChannelOn() : true;
  return { battery, notification: noti, channel };
}
function persistKeepAliveGuideHtml() {
  const s = persistKeepAliveState();
  return '<div class="mini-note" style="margin-top:8px">长时运行需要三层保活：前台服务（已内置）、电池优化白名单、厂商自启动设置。' +
    '<br>电池白名单：' + (s.battery ? '已加入' : '未加入（建议开启）') +
    ' · 通知：' + (s.notification ? '已允许' : '未允许') +
    ' · 通知渠道：' + (s.channel ? '正常' : '被关闭，前台服务可能被杀') +
    '<br>厂商路径：小米/红米 → 设置→应用→爱莉希雅→省电策略→无限制；华为/荣耀 → 应用启动管理→手动管理；' +
    'OPPO/一加/realme → 电池→应用耗电管理→允许后台运行；vivo/iQOO → 电池→后台耗电管理→允许；三星 → 电池→不受限制。' +
    '<br>提醒：息屏 8 小时仍可能被系统回收；恢复入口在任务抽屉，检查点会自动合并。</div>';
}
function persistStatusLine() {
  const active = persistActiveSessions();
  const jobs = persistJobsSummary();
  const s = persistKeepAliveState();
  return '长时会话：' + active.length + ' 个运行中 · 插件后台任务：' + jobs.total + ' 个（暂停 ' + jobs.paused + '）' +
    ' · 电池白名单：' + (s.battery ? '已加入' : '未加入');
}
