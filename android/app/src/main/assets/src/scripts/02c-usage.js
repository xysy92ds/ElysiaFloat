/* ==========================================================
 *  用量与限额骨架（0.9 / E2-008）
 *
 *  只做本地统计，不联网、不上报：
 *   - 按天汇总调用次数与 token；
 *   - 按 Provider / 任务拆开，方便界面展示；
 *   - 限额为 0 表示不限；达到上限时聊天请求直接拦下。
 * ========================================================== */
const USAGE_KEY = 'via_ai_usage_v1';

function usageDay() {
  const n = new Date();
  const p = x => String(x).padStart(2, '0');
  return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate());
}

function usageBlank() {
  return {
    day: usageDay(),
    calls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    byProvider: {},
    byTask: {},
    lastAt: 0
  };
}

function usageNum(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

/** 读取今日用量；跨天自动归零。损坏数据按空账本处理。 */
function usageLoad() {
  let u = null;
  try {
    // sGet 在原生桥下已经解析成对象；浏览器兜底也可能返回字符串。
    const raw = sGet(USAGE_KEY, null);
    u = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { u = null; }
  if (!u || typeof u !== 'object' || Array.isArray(u) || u.day !== usageDay()) u = usageBlank();
  if (!u.tokens || typeof u.tokens !== 'object') u.tokens = { prompt: 0, completion: 0, total: 0 };
  if (!u.byProvider || typeof u.byProvider !== 'object') u.byProvider = {};
  if (!u.byTask || typeof u.byTask !== 'object') u.byTask = {};
  return u;
}

function usageSave(u) {
  sSet(USAGE_KEY, u);
  return u;
}

/** 记一次成功调用；usage 是响应里的 usage 对象，缺字段按 0 处理。 */
function usageRecord(providerId, taskId, usage) {
  const u = usageLoad();
  const raw = usage && typeof usage === 'object' ? usage : {};
  const prompt = usageNum(raw.prompt_tokens || raw.input_tokens);
  const completion = usageNum(raw.completion_tokens || raw.output_tokens);
  const total = usageNum(raw.total_tokens) || (prompt + completion);

  u.calls += 1;
  u.tokens.prompt += prompt;
  u.tokens.completion += completion;
  u.tokens.total += total;
  u.lastAt = Date.now();

  const add = (bucket, id) => {
    const key = String(id || 'unknown');
    const row = bucket[key] || (bucket[key] = { calls: 0, tokens: 0 });
    row.calls += 1;
    row.tokens += total;
  };
  add(u.byProvider, providerId || 'unknown');
  add(u.byTask, taskId || 'unknown');
  return usageSave(u);
}

/** 限额来自配置；未填写或 0 都表示不限。 */
function usageLimits() {
  const cfg = (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
  return {
    enabled: cfg.usageLimitEnabled !== false,
    calls: Math.max(0, parseInt(cfg.usageDailyCalls, 10) || 0),
    tokens: Math.max(0, parseInt(cfg.usageDailyTokens, 10) || 0)
  };
}

/** 返回空串表示还能调；否则返回超限原因。 */
function usageCheck() {
  const lim = usageLimits();
  if (!lim.enabled) return '';
  const u = usageLoad();
  if (lim.calls > 0 && u.calls >= lim.calls) return '调用 ' + u.calls + '/' + lim.calls;
  if (lim.tokens > 0 && u.tokens.total >= lim.tokens) return 'Token ' + u.tokens.total + '/' + lim.tokens;
  return '';
}

/** 界面摘要：数据可直接渲染，不含任何密钥。 */
function usageSummary() {
  const u = usageLoad();
  const byProvider = Object.keys(u.byProvider).map(id => ({
    id: id, calls: u.byProvider[id].calls, tokens: u.byProvider[id].tokens
  })).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
  const byTask = Object.keys(u.byTask).map(id => ({
    id: id, calls: u.byTask[id].calls, tokens: u.byTask[id].tokens
  })).sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
  return {
    day: u.day,
    calls: u.calls,
    tokens: { prompt: u.tokens.prompt, completion: u.tokens.completion, total: u.tokens.total },
    byProvider: byProvider,
    byTask: byTask,
    limits: usageLimits(),
    hit: usageCheck()
  };
}

function usageReset() {
  return usageSave(usageBlank());
}
