/* ==========================================================
 *  主题
 * ========================================================== */
function applyTheme() {
  document.documentElement.style.setProperty('--c1', CONFIG.themeColor1);
  document.documentElement.style.setProperty('--c2', CONFIG.themeColor2);
  $('#name').textContent = CONFIG.assistantName;
  const av = $('#avatar');
  av.src = CONFIG.avatarUrl || FALLBACK_AVATAR;
  av.onerror = function () { this.onerror = null; this.src = FALLBACK_AVATAR; };
  // 与原生悬浮球保持同样的取景：object-fit:cover + object-position 控制竖向偏移
  av.style.objectPosition = 'center ' + (CONFIG.avatarFit || 'top');
  pushAvatar();
}

function pushAvatar() {
  try {
    if (HAS_NATIVE && Android.setAvatar) {
      Android.setAvatar(CONFIG.avatarUrl || '', CONFIG.avatarFit || 'top');
    }
  } catch (e) {}
}

/* ==========================================================
 *  快捷操作渲染
 * ========================================================== */
function renderActions() {
  const box = $('#quick-actions'); if (!box) return;
  box.innerHTML = '<button class="chip" data-key="trans_screen">翻译</button>' +
    '<button class="chip" data-key="sum_screen">总结</button>' +
    '<span class="quick-more-wrap"><button id="quick-more" class="chip">更多</button><span id="quick-extra" class="quick-extra"><button class="chip" data-key="points">要点</button><button class="chip" data-key="explain">解释</button><button class="chip" data-key="mem_sum">总结记忆</button><button class="chip" data-key="clear_chat">清空</button></span></span>';
  $$('#quick-actions [data-key]').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); $('#quick-extra').classList.remove('open'); handleQuickAction(btn.dataset.key); });
  const more = $('#quick-more'); if (more) more.onclick = (e) => { e.stopPropagation(); $('#quick-extra').classList.toggle('open'); };
  document.addEventListener('click', (e) => {
    const extra = $('#quick-extra');
    if (extra && !e.target.closest('.quick-more-wrap')) extra.classList.remove('open');
  });
}

/* ==========================================================
 *  对话渲染
 * ========================================================== */
function makeMsgEl(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : (role === 'mem' ? 'mem' : 'ai'));
  // 助手正文先清洗：工具调用伪代码/特殊 token/乱码不进聊天
  const body = role === 'assistant' ? cleanAssistantText(text) : text;
  const span = document.createElement('span');
  span.className = 'msg-body';
  span.textContent = body;
  d.appendChild(span);
  return d;
}

function attachTTS(el, text) {
  if (!CONFIG.ttsEnabled) return;
  const b = document.createElement('div');
  b.className = 'tts-btn';
  b.textContent = '🔊 朗读';
  b.onclick = (e) => { e.stopPropagation(); toggleTTS(text, b); };
  el.appendChild(document.createElement('br'));
  el.appendChild(b);
}

function renderHistory() {
  const bodyEl = $('#body');
  bodyEl.innerHTML = '';
  history.forEach(msg => {
    if (msg.role === 'system') {
      if (msg.isMemory) {
        const d = document.createElement('div');
        d.className = 'msg mem';
        d.innerHTML = `<strong>【长期记忆已加载】</strong><br><span style="font-size:11px;opacity:.8">${esc(String(msg.content).replace('【长期记忆总结】：', ''))}</span>`;
        bodyEl.appendChild(d);
      }
      return;
    }
    const d = makeMsgEl(msg.role, msg.content);
    if (msg.role === 'assistant') attachTTS(d, msg.content);
    bodyEl.appendChild(d);
  });
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

function addMsg(role, text) {
  if (role === 'assistant' && !cleanAssistantText(text)) return null;
  const d = makeMsgEl(role, text);
  if (role === 'assistant') attachTTS(d, d.textContent);
  const bodyEl = $('#body');
  bodyEl.appendChild(d);
  bodyEl.scrollTop = bodyEl.scrollHeight;
  return d;
}

function addTyping() {
  const d = document.createElement('div');
  d.className = 'msg ai typing';
  d.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="agent-status"></span>';
  const bodyEl = $('#body');
  bodyEl.appendChild(d);
  bodyEl.scrollTop = bodyEl.scrollHeight;
  return d;
}

const AGENT_TOOL_LABELS = {
  read_screen: '读取手机屏幕',
  get_current_page: '读取当前页面',
  screenshot: '查看手机画面',
  watch_screen: '观察手机画面',
  find_app: '查询设备应用',
  tap_screen: '点击屏幕',
  click_text: '点击文字',
  swipe_screen: '滑动屏幕',
  input_text: '输入文字',
  press_key: '执行系统按键',
  launch_app: '启动应用',
  workspace_status: '查看工作区状态',
  workspace_create: '创建工作区',
  workspace_list: '列出工作区文件',
  workspace_read: '读取工作区文件',
  workspace_write: '写入工作区文件',
  workspace_mkdir: '创建工作区目录',
  open_url: '打开链接',
  set_clipboard: '写入剪贴板',
  search_and_play_music: '搜索并播放音乐',
  music_control: '控制音乐',
  list_memories: '检索长期记忆',
  read_memory: '读取长期记忆',
  save_memory: '保存长期记忆',
  update_memory: '更新长期记忆',
  pin_memory: '调整重要记忆',
  delete_memory: '删除长期记忆'
};
function setAgentStatus(el, text) {
  if (!el) return;
  let s = el.querySelector('.agent-status');
  if (!text) { if (s) s.remove(); return; }
  if (!s) { s = document.createElement('span'); s.className = 'agent-status'; el.appendChild(s); }
  s.textContent = text;
  const bodyEl = $('#body');
  if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
}
function makeAgentLive(typing) {
  let current = typing;
  let round = 0, toolCount = 0;
  const parts = [];
  return {
    parts,
    onRound(n, max) {
      round = n;
      setAgentStatus(current, '第 ' + n + ' 轮处理中');
    },
    onText(text) {
      const t = cleanAssistantText(text);
      if (!t) return;                       // 只剩工具调用/乱码：不入聊天，状态小字已在提示
      if (current === typing) typing.remove();
      else setAgentStatus(current, '');
      current = addMsg('assistant', t) || current;
      parts.push(t);
    },
    onTool(name) {
      toolCount++;
      const label = AGENT_TOOL_LABELS[name] || name || '工具';
      setAgentStatus(current, '正在执行' + label + ' · 第 ' + round + ' 轮 · 已调用 ' + toolCount + ' 次');
    },
    finish() {
      setAgentStatus(current, '');
      if (typing && typing.parentNode) typing.remove();
      return parts.slice();
    }
  };
}

function saveHistory() {
  const max = CONFIG.maxContextTurns * 2;
  const base = { role: 'system', content: CONFIG.systemPrompt };
  const non = history.filter(m => m.role !== 'system');
  history = non.length > max ? [base, ...non.slice(-max)] : [base, ...non];
  const t = currentTask();
  if (t) taskSaveContext(t);
  if (!t || t.type === 'chat') sSet('via_ai_history', history);
}

