/* ==========================================================
 *  统一请求管理（G3）
 *  - 唯一出网入口：超时预算、重试退避、跳数上限、大小上限、
 *    错误码、任务绑定、脱敏审计
 *  - 审计只记「域名 + 状态码 + 耗时 + 错误码」，
 *    绝不记录 path/query、请求头、正文、Key
 * ========================================================== */
const REQ_CODE = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  HTTP_ERROR: 'HTTP_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  REDIRECT_ERROR: 'REDIRECT_ERROR',
  TOO_LARGE: 'TOO_LARGE',
  BAD_CONTENT_TYPE: 'BAD_CONTENT_TYPE',
  PARSE_ERROR: 'PARSE_ERROR',
  NO_TEXT: 'NO_TEXT',
  CANCELLED: 'CANCELLED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT'
};

const REQ_DEFAULTS = {
  method: 'GET',
  timeoutMs: 20000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirect: 5,
  retries: 2,
  expect: 'text',       // text | json | audio
  cacheable: false,
  sameHost: false,      // true = 禁止跨域跳转（Agent L2 未开启时给插件/Agent 用）
  deadlineAt: 0,
  taskId: ''
};

const REQ_RETRY_DELAY = [2000, 6000];      // 第 1、2 次重试前的等待
const REQ_RETRY_DELAY_429 = 10000;         // 限流退避更久
const REQ_AUDIT_MAX = 200;
const REQ_AUDIT = [];

function reqError(code, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.requestError = true;
  if (extra) Object.assign(e, extra);
  return e;
}

/** 只暴露域名，避免把签名参数写进日志。 */
function reqHost(url) {
  try { return String(new URL(String(url)).host || '') || ''; } catch (e) { return ''; }
}

function reqAuditPush(record) {
  REQ_AUDIT.push(record);
  while (REQ_AUDIT.length > REQ_AUDIT_MAX) REQ_AUDIT.shift();
}
function reqAuditList() { return REQ_AUDIT.slice(); }
function reqAuditClear() { REQ_AUDIT.length = 0; }

function reqIsRetriable(code, status) {
  if (code === REQ_CODE.NETWORK_ERROR || code === REQ_CODE.TIMEOUT) return true;
  if (code === REQ_CODE.RATE_LIMITED) return true;
  if (code === REQ_CODE.HTTP_ERROR && status >= 500) return true;
  return false;
}

/** 取消类错误：既带 code 又带 cancelled 标志，任何层都能正确识别。 */
function reqCancelledError(message, extra) {
  const e = reqError(REQ_CODE.CANCELLED, message || '请求已取消', extra);
  e.cancelled = true;
  return e;
}

function reqSleep(ms, token) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (token && token.cancelled) return reject(reqError(REQ_CODE.CANCELLED, '请求已取消'));
      resolve();
    }, ms);
    if (token) token.onCancel(() => { clearTimeout(t); reject(reqError(REQ_CODE.CANCELLED, '请求已取消')); });
  });
}

/** 简化取消令牌：setInterval 之外的场景不需要 AbortController。 */
function reqToken() {
  let cancelled = false;
  const hooks = [];
  return {
    get cancelled() { return cancelled; },
    onCancel(fn) { if (cancelled) { try { fn(); } catch (e) {} } else hooks.push(fn); },
    cancel() { if (cancelled) return; cancelled = true; hooks.splice(0).forEach(fn => { try { fn(); } catch (e) {} }); }
  };
}

/** 单次传输：只负责把请求发出去并拿回原始字节，不做重试。 */
function reqTransport(spec, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (HAS_NATIVE && Android.requestEx) {
      const id = 'q' + (++reqSeq);
      const timer = setTimeout(() => {
        if (pendingReq[id]) { delete pendingReq[id]; try { Android.cancelRequest(id); } catch (e) {} reject(reqError(REQ_CODE.TIMEOUT, '请求超时（' + Math.round(timeoutMs / 1000) + 's）')); }
      }, timeoutMs + 800);
      pendingReq[id] = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
        taskId: spec.taskId || currentTask().id,
        token: RUN_TOKEN
      };
      try {
        Android.requestEx(id, String(spec.method || 'GET').toUpperCase(), String(spec.url),
          JSON.stringify(spec.headers || {}), spec.body || '', Math.max(1000, Math.round(timeoutMs)),
          JSON.stringify({ maxBytes: spec.maxBytes, maxRedirect: spec.maxRedirect, cacheable: !!spec.cacheable, sameHost: !!spec.sameHost }));
      } catch (e) {
        clearTimeout(timer); delete pendingReq[id];
        reject(reqError(REQ_CODE.INVALID_ARGUMENT, '请求无法发起：' + ((e && e.message) || e)));
      }
      return;
    }

    if (HAS_NATIVE && Android.request) {
      // 旧原生接口：没有大小/跳数限制，但保持可用。
      const id = 'q' + (++reqSeq);
      const timer = setTimeout(() => {
        if (pendingReq[id]) { delete pendingReq[id]; reject(reqError(REQ_CODE.TIMEOUT, '请求超时')); }
      }, timeoutMs + 800);
      pendingReq[id] = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
        taskId: spec.taskId || currentTask().id,
        token: RUN_TOKEN
      };
      try { Android.request(id, String(spec.method || 'GET').toUpperCase(), String(spec.url), JSON.stringify(spec.headers || {}), spec.body || '', Math.max(1000, Math.round(timeoutMs))); }
      catch (e) { clearTimeout(timer); delete pendingReq[id]; reject(reqError(REQ_CODE.INVALID_ARGUMENT, '请求无法发起：' + ((e && e.message) || e))); }
      return;
    }

    // 无原生桥（浏览器调试）：fetch 兜底，会被 CORS 拦，仅用于本地冒烟。
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) try { ctrl.abort(); } catch (e) {} reject(reqError(REQ_CODE.TIMEOUT, '请求超时')); }, timeoutMs);
    const opt = { method: String(spec.method || 'GET').toUpperCase() };
    if (ctrl) opt.signal = ctrl.signal;
    if (spec.headers) opt.headers = spec.headers;
    if (spec.body) opt.body = spec.body;
    fetch(String(spec.url), opt).then(r => {
      return r.text().then(txt => {
        clearTimeout(timer);
        if (txt.length > spec.maxBytes) return reject(reqError(REQ_CODE.TOO_LARGE, '响应超过 ' + Math.round(spec.maxBytes / 1024) + 'KB'));
        if (!r.ok) {
          const code = r.status === 401 || r.status === 403 ? REQ_CODE.AUTH_ERROR
            : r.status === 429 ? REQ_CODE.RATE_LIMITED : REQ_CODE.HTTP_ERROR;
          return reject(reqError(code, 'HTTP ' + r.status, { status: r.status }));
        }
        resolve({ status: r.status, text: txt, contentType: (r.headers && r.headers.get && r.headers.get('content-type')) || '', meta: {} });
      });
    }).catch(e => {
      clearTimeout(timer);
      if (e && e.requestError) return reject(e);
      reject(reqError(REQ_CODE.NETWORK_ERROR, (e && e.message) || '网络错误'));
    });
  });
}

function reqNormalize(spec) {
  const s = Object.assign({}, REQ_DEFAULTS);
  Object.keys(spec || {}).forEach(k => { if (spec[k] !== undefined && spec[k] !== null) s[k] = spec[k]; });
  s.method = String(s.method || 'GET').toUpperCase();
  s.maxBytes = Math.max(1024, parseInt(s.maxBytes, 10) || REQ_DEFAULTS.maxBytes);
  s.maxRedirect = Math.max(0, Math.min(10, parseInt(s.maxRedirect, 10) || 0));
  s.retries = Math.max(0, Math.min(4, parseInt(s.retries, 10) || 0));
  s.timeoutMs = Math.max(1000, Math.min(600000, parseInt(s.timeoutMs, 10) || REQ_DEFAULTS.timeoutMs));
  if (s.sameHost === false && s.source) s.sameHost = reqSameHostOnly(s.source);
  return s;
}

/**
 * 统一请求入口。
 * spec: { url, method, headers, body, timeoutMs, deadlineAt, retries, maxBytes,
 *         maxRedirect, expect, taskId, cacheable, token, source }
 * 返回: { ok:true, status, text, json?, contentType, elapsedMs, url, source }
 */
async function reqRequest(spec) {
  const s = reqNormalize(spec);
  if (!s.url) throw reqError(REQ_CODE.INVALID_ARGUMENT, '缺少请求地址');
  const started = Date.now();
  const maxAttempts = 1 + s.retries;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (s.token && s.token.cancelled) throw reqError(REQ_CODE.CANCELLED, '请求已取消');

    let timeoutMs = s.timeoutMs;
    if (s.deadlineAt) {
      const left = s.deadlineAt - Date.now();
      if (left <= 500) {
        const e = reqError(REQ_CODE.DEADLINE_EXCEEDED, '任务已到时间上限');
        reqAuditPush({ at: Date.now(), host: reqHost(s.url), status: 0, code: e.code, ms: Date.now() - started, source: s.source || '', attempts: attempt });
        throw e;
      }
      timeoutMs = Math.min(timeoutMs, left);
    }

    try {
      const raw = await reqTransport(s, timeoutMs);
      const meta = raw.meta || {};
      if (meta.errorCode) throw reqError(meta.errorCode, reqErrMsg(meta.errorCode, raw.status, meta), { status: raw.status });

      const text = String(raw.text || '');
      if (text.length > s.maxBytes) throw reqError(REQ_CODE.TOO_LARGE, '响应超过上限');

      const contentType = String(raw.contentType || meta.contentType || '').toLowerCase();
      let json;
      if (s.expect === 'json') {
        try { json = JSON.parse(text); } catch (e) {
          throw reqError(REQ_CODE.PARSE_ERROR, '返回内容不是有效 JSON', { status: raw.status });
        }
      } else if (s.expect === 'audio') {
        if (contentType && contentType.indexOf('audio') < 0 && contentType.indexOf('video') < 0 && contentType.indexOf('octet-stream') < 0 && contentType.indexOf('mpeg') < 0) {
          throw reqError(REQ_CODE.BAD_CONTENT_TYPE, '不是音频内容（' + contentType + '）', { status: raw.status });
        }
      }
      if (!text) {
        // 空响应在音乐/正文场景是明确失败，其它场景交给调用方判断
        if (s.expect === 'audio') throw reqError(REQ_CODE.NO_TEXT, '返回内容为空');
      }

      reqAuditPush({ at: Date.now(), host: reqHost(s.url), status: raw.status, code: 'OK', ms: Date.now() - started, source: s.source || '', attempts: attempt });
      return {
        ok: true,
        status: raw.status,
        text,
        json,
        contentType,
        elapsedMs: Date.now() - started,
        url: String(meta.finalUrl || s.url),
        source: s.source || ''
      };
    } catch (e) {
      if (e && !e.requestError && (e.cancelled || /取消|已停止|cancel/i.test(String(e.message || '')))) {
        // 兼容历史用法：任何层抛出的“取消”语义都不能被当成可重试的网络错误
        lastErr = reqCancelledError((e && e.message) || '请求已取消');
      } else {
        lastErr = e && e.requestError ? e : reqError(REQ_CODE.NETWORK_ERROR, (e && e.message) || '网络错误');
      }
      if (lastErr.code === REQ_CODE.CANCELLED) {
        reqAuditPush({ at: Date.now(), host: reqHost(s.url), status: 0, code: lastErr.code, ms: Date.now() - started, source: s.source || '', attempts: attempt });
        throw lastErr;
      }
      const canRetry = attempt < maxAttempts && reqIsRetriable(lastErr.code, lastErr.status);
      reqAuditPush({ at: Date.now(), host: reqHost(s.url), status: lastErr.status || 0, code: lastErr.code, ms: Date.now() - started, source: s.source || '', attempts: attempt, retry: canRetry });
      if (!canRetry) throw lastErr;
      const wait = lastErr.code === REQ_CODE.RATE_LIMITED
        ? REQ_RETRY_DELAY_429
        : (REQ_RETRY_DELAY[Math.min(attempt - 1, REQ_RETRY_DELAY.length - 1)] || 2000);
      try { await reqSleep(wait, s.token); } catch (e2) { throw e2; }
    }
  }
  throw lastErr || reqError(REQ_CODE.NETWORK_ERROR, '请求失败');
}

/**
 * 跨域跳转是否允许：系统级来源（音乐/更新/翻译/记忆/TTS/模型）始终允许，
 * 因为 CDN 302 是正常业务；
 * Agent / 插件发起的外联才受 Agent L2 开关约束（用户 2026-10-17 决定）。
 */
function reqSameHostOnly(source) {
  const s = String(source || '');
  if (s.indexOf('plugin') === 0 || s === 'agent' || s.indexOf('agent:') === 0) {
    // 「允许跳到任意域名」属于 Agent L2 能力：L2 开启（默认）放开，关闭则严格同域。
    // 注意不能用 agentActionsOn()：那是 L3 动作开关，会误伤普通插件。
    return CONFIG.agentL2 === false;
  }
  return false;
}

function reqErrMsg(code, status, meta) {
  if (code === REQ_CODE.AUTH_ERROR) return 'HTTP ' + (status || 401) + '（认证失败，检查 Key/权限）';
  if (code === REQ_CODE.RATE_LIMITED) return 'HTTP 429（请求过快，已自动退避）';
  if (code === REQ_CODE.TOO_LARGE) return '响应超过大小上限';
  if (code === REQ_CODE.REDIRECT_ERROR) return '重定向异常（跳数超限或地址不合法）';
  if (code === REQ_CODE.TIMEOUT) return '请求超时';
  return 'HTTP ' + (status || 0);
}

/** 给用户的短文案：友好提示 + 小字错误码。 */
function reqErrText(e) {
  const code = (e && e.code) || '';
  const msg = (e && e.message) || '未知错误';
  return code ? (msg + '〔' + code + '〕') : msg;
}
