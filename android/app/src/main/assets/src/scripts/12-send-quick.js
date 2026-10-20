/* ==========================================================
 *  发送
 * ========================================================== */
/** 给刚发出的那条用户消息挂一张缩略图（只用于显示，不写进历史） */
function attachThumbToLast(dataUrl) {
  const last = $('#body').lastElementChild;
  if (!last || !dataUrl) return;
  const img = document.createElement('img');
  img.className = 'msg-thumb';
  img.src = dataUrl;
  last.appendChild(img);
}

async function send() {
  if (sending) {
    stopRequested = true;
    cancelTaskRequests(ACTIVE_RUN_TASK_ID || currentTask().id);
    toast('正在停止本轮工具执行…');
    return;
  }
  const inputEl = $('#input');
  let t = inputEl.value.trim();
  const att = pendingAttachment;
  // 部分输入法还在组词时读到的 value 是空的：先失焦让输入法提交，再读一次，
  // 避免「明明打了字，点发送却什么都不发生」。
  if (!t && !att && document.activeElement === inputEl) {
    try { inputEl.blur(); } catch (e) {}
    t = inputEl.value.trim();
  }
  if (!t && !att) return;
  // 正在某个持久任务（工作/手机）里时，普通文字继续留在该任务；
  // 只有明确的快捷屏幕指令或其它任务类型关键词才切换。
  // 之前所有普通句子都被归类成 chat，导致一发消息就跳回聊天页、工作任务里发不出东西。
  const cur = currentTask();
  let routeType = taskRouteText(t, att);
  // 完成/失败/暂停也要算「还在这个任务里」——否则任务一结束，下一句就跳回聊天页
  const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device')
    && ['active', 'waiting_user', 'paused', 'completed', 'failed'].indexOf(cur.state) >= 0;
  if (inPersistent && routeType === 'chat') routeType = cur.type;
  // 快捷操作默认不进入持久任务舱；只有用户明确新建工作任务/手机任务时才改变当前任务。
  if (routeType === 'quick') {
    const shortcut = /翻译屏幕/.test(t) ? 'trans_screen' : (/总结屏幕/.test(t) ? 'sum_screen' : (/提取要点|要点/.test(t) ? 'points' : (/解释屏幕|解释/.test(t) ? 'explain' : '')));
    if (shortcut) { inputEl.value = ''; await handleQuickAction(shortcut); return; }
  }
  // 统一落点：聊天、工作、设备任务都用同一段后续逻辑，只在这里一次性把「这轮消息进哪个任务」定死。
  // 曾经把 routedTask 写成 const，又在下面 chat 分支用 taskEnsureChat() 覆盖它，
  // 运行期必抛 "Assignment to constant variable"，且抛在清空输入和 addMsg 之前——
  // 表现就是「主聊天点发送没反应」，而工作区/设备任务不走那次赋值所以一直正常。
  // 现在把聊天任务的解析提前到这里，声明依然是 let，彻底消除这个分歧。
  let routedTask = await routeTask(routeType, t || (att && att.name) || TASK_TYPES[routeType]);
  if (!routedTask) return;
  if (routeType === 'chat') routedTask = taskEnsureChat();
  if (routeType === 'workspace') {
    const ready = await ensureTaskWorkspace(routedTask);
    if (!ready.ok) { taskFinish(routedTask.id, 'failed', ready.error || '工作区不可用'); toast(ready.error || '工作区不可用'); return; }
  }
  if (att && routeType === 'workspace') {
    const imported = await importAttachmentToTask(routedTask, att);
    if (!imported.ok) { taskFinish(routedTask.id, 'failed', imported.error || '文件导入失败'); toast(imported.error || '文件导入失败'); return; }
    routedTask.artifacts = routedTask.artifacts || []; if (imported.relative) routedTask.artifacts.push(imported.relative); saveTasks();
  }
  if (routeType !== 'quick') taskBegin(routeType, routedTask.title, t || routedTask.goal, routeType === 'chat' ? 30000 : CONFIG.agentTaskTimeout);
  stopRequested = false;
  RUN_TOKEN++;
  const myRunToken = RUN_TOKEN;
  sending = true; ACTIVE_RUN_TASK_ID = routedTask.id; $('#send').disabled = false; $('#send').textContent = '停止';
  inputEl.value = ''; inputEl.style.height = 'auto';

  addMsg('user', t || (att && att.kind === 'image' ? '（图片）' : '（文件）'));
  if (att && att.kind === 'image') attachThumbToLast(att.dataUrl);
  clearAttachment();

  const ld = addTyping();
  const live = makeAgentLive(ld);
  live.task = routedTask;
  try {
    let msgs;
    if (att && att.kind === 'image') {
      // 图片只放在本轮请求里，不写进本地历史：dataURL 太大会把设置存爆
      msgs = history.concat([{ role: 'user', content: [
        { type: 'text', text: t || '帮我看看这张图片~' },
        { type: 'image_url', image_url: { url: att.dataUrl } }
      ] }]);
      history.push({ role: 'user', content: (t ? t + ' ' : '') + '（我发了一张图片给你看）' });
    } else if (att && att.kind === 'text') {
      msgs = history.concat([{ role: 'user', content:
        '【我上传的文件：' + att.name + '】\n' + att.text + '\n\n' + (t || '帮我看看这个文件~') }]);
      history.push({ role: 'user', content: (t ? t + ' ' : '') + '（我上传了文件 ' + att.name + '）' });
    } else if (att) {
      const kb = Math.max(1, Math.round((att.size || 0) / 1024));
      msgs = history.concat([{ role: 'user', content:
        '（我上传了一个文件 ' + att.name + '，约 ' + kb + 'KB，这个格式我这边读不出正文）\n\n' + (t || '这个文件你能看懂吗？') }]);
      history.push({ role: 'user', content: (t ? t + ' ' : '') + '（我上传了文件 ' + att.name + '）' });
    } else {
      history.push({ role: 'user', content: t });
      msgs = history;
    }
    saveHistory();
    const r = await chatSmart(msgs, live);
    const parts = live.finish();
    parts.forEach(text => history.push({ role: 'assistant', content: text }));
    if (String(r || '').trim()) {
      addMsg('assistant', r);
      history.push({ role: 'assistant', content: r });
    }
    saveHistory();
    if (!runIsStale(myRunToken)) taskFinish(routedTask.id, 'completed');
    // 长期记忆：每 N 条消息自动整理一次（默认 50），可在设置里关掉
    try {
      const hit = memAutoTick();
      if (hit && MEMCFG.autoSummary !== false) setTimeout(() => { memSummarize({ auto: true }).catch(() => {}); }, 600);
    } catch (e) {}
  } catch (e) {
    live.finish();
    if (!runIsStale(myRunToken)) {
      if (e && e.code === 'CANCELLED') {
        // 用户主动停止 / 被新请求取代：不当作错误，只做中性收尾
        addMsg('assistant', '已停止本轮执行~');
        taskFinish(routedTask.id, 'cancelled', '用户停止或已取消');
      } else {
        addMsg('assistant', '错误：' + errMsg(e));
        taskFinish(routedTask.id, 'failed', errMsg(e));
      }
    }
  }
  finishAgentCapsule('已完成 · 点我查看');
  stopRequested = false;
  ACTIVE_RUN_TASK_ID = '';
  sending = false; $('#send').disabled = false; $('#send').textContent = '发送';
}

/** 发送壳：send() 前半段（路由 / 切任务）如果抛错，以前是静默失败，
 *  表现和「按钮点不动」一模一样。这里兜住异常、复位按钮并把原因说出来。 */
function sendSafe() {
  const fail = (e) => {
    sending = false;
    const b = $('#send'); if (b) { b.disabled = false; b.textContent = '发送'; }
    toast('发送失败：' + errMsg(e));
  };
  try {
    const p = send();
    if (p && p.catch) p.catch(fail);
  } catch (e) { fail(e); }
}

/* ==========================================================
 *  快捷操作
 * ========================================================== */
async function handleQuickAction(key) {
  if (key === 'clear_chat') { await clearCurrentChat(); return; }
  if (key === 'mem_sum') { await memSummarize(); return; }
  if (sending) { toast('正在思考中，稍等一下嘛~'); return; }

  // 翻译屏幕走自己的路：直接读节点树，发到「屏幕翻译」页，不进对话历史。
  if (key === 'trans_screen') {
    const qt = quickOperationBegin('翻译屏幕', '翻译当前屏幕', 30000);
    ACTIVE_RUN_TASK_ID = qt.id;
    try { await doTranslateScreen(); quickOperationFinish(qt.id, 'completed'); } catch (e) { quickOperationFinish(qt.id, 'failed', errMsg(e)); throw e; }
    finally { ACTIVE_RUN_TASK_ID = ''; }
    return;
  }

  let prompt = '', label = '';
  if (key === 'sum_screen') { label = '总结屏幕'; prompt = '请总结以下内容的核心要点：'; }
  else if (key === 'points') { label = '要点提炼'; prompt = '请提取以下内容的关键要点，用简洁的条目列出：'; }
  else if (key === 'explain') { label = '通俗解释'; prompt = '请用通俗易懂的语言解释以下内容：'; }
  else return;

  if (!hasA11y()) {
    toast('这项功能需要先开启无障碍读屏权限~');
    return;
  }
  const content = readScreen(true);
  if (!content) {
    toast('当前屏幕没有读到可用文字~ 请确认目标页面支持无障碍文本');
    return;
  }

  const qt = quickOperationBegin(label, label, 30000);
  // 先把浮窗收成小胶囊：屏幕不被挡，她也能看到干净画面。
  const useCapsule = capsuleOn(label + '中…');

  sending = true; ACTIVE_RUN_TASK_ID = qt.id; $('#send').disabled = true;
  addMsg('user', `【${label}】`);
  const ld = addTyping();
  const live = makeAgentLive(ld);
  live.task = qt;
  try {
    const r = await chatSmart([{ role: 'user', content: prompt + '\n\n' + content.slice(0, 6000) }], live);
    const parts = live.finish();
    addMsg('assistant', r);
    history.push({ role: 'user', content: `【${label}】` });
    parts.forEach(text => history.push({ role: 'assistant', content: text }));
    history.push({ role: 'assistant', content: r });
    saveHistory();
    TRANS.pending = 'chat';
    prepareResult(label + '好了 ♪ 点我看结果', useCapsule);
  } catch (e) {
    live.finish();
    const cancelled = e && e.code === 'CANCELLED';
    if (!cancelled) addMsg('assistant', '错误：' + errMsg(e));
    TRANS.pending = 'chat';
    prepareResult(cancelled ? label + '已取消' : label + '失败了', useCapsule);
    quickOperationFinish(qt.id, cancelled ? 'cancelled' : 'failed', cancelled ? '已取消' : errMsg(e));
  }
  if (QUICK_OPS.has(qt.id) && QUICK_OPS.get(qt.id).state === 'active') quickOperationFinish(qt.id, 'completed');
  ACTIVE_RUN_TASK_ID = '';
  sending = false; $('#send').disabled = false;
}

