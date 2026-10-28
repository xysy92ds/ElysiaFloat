/* ==========================================================
 *  AI 请求
 * ========================================================== */
function parseVars(t) {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const ts = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
  let s = String(t).replace(/\{\{time\}\}/g, ts);
  // 其余变量按需惰性求值：提示词里写了才会去读，避免每次聊天都白描一遍屏幕
  if (s.indexOf('{{screen_text}}') >= 0) {
    s = s.replace(/\{\{screen_text\}\}/g, () => readScreenText() || '（读不到屏幕内容）');
  }
  if (s.indexOf('{{page_url}}') >= 0) {
    s = s.replace(/\{\{page_url\}\}/g, () => currentPageUrl() || '（未知）');
  }
  if (s.indexOf('{{clipboard}}') >= 0) {
    s = s.replace(/\{\{clipboard\}\}/g, () => readClipboard() || '（空）');
  }
  return s;
}

async function chatReq(messages, skipParse) {
  if (!CONFIG.apiKey) throw new Error('未填写 API Key，请到设置里配置');
  // E2-008：额度用尽时先拦下，不再发请求。
  const quota = usageCheck();
  if (quota) throw new Error('今日用量已达上限（' + quota + '）。可在 设置 → 模型中心 调整限额或重置今日用量。');
  const memBlock = memResidentBlock();
  const proc = messages.map((m, i) => {
    if (m.role !== 'system') return m;
    let c = skipParse ? m.content : parseVars(m.content);
    if (i === 0 && memBlock) c = c + '\n\n' + memBlock;
    return { role: 'system', content: c };
  });
  const body = JSON.stringify({ model: CONFIG.model, messages: proc, stream: false });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + CONFIG.apiKey
  };
  const r = await reqRequest({
    method: 'POST',
    url: CONFIG.apiBase.replace(/\/$/, '') + '/chat/completions',
    headers: headers, body: body,
    // 生图/长推理可能很久：预算走配置，重试降为 0（超时重试只会让用户多等一倍）
    timeoutMs: modelTimeout(), expect: 'json', retries: 0, source: 'model'
  });
  const d = r.json;
  if (d.error) throw new Error(d.error.message || 'API 错误');
  if (!d.choices || !d.choices[0]) throw new Error('响应格式异常');
  // E2-008：成功调用后按 Provider / 任务记账；统计失败不影响聊天。
  try {
    const use = providerResolve(CONFIG, 'chat');
    const pid = (use && use.provider && use.provider.id) || 'legacy-chat';
    const taskId = (typeof ACTIVE_RUN_TASK_ID !== 'undefined' && ACTIVE_RUN_TASK_ID)
      ? ACTIVE_RUN_TASK_ID : (currentTask() || {}).id;
    usageRecord(pid, taskId, d.usage);
  } catch (e) { }
  return d.choices[0].message.content || '';
}

