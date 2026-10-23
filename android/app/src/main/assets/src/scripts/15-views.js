/* ==========================================================
 *  视图切换
 * ========================================================== */
function showView(v) {
  const bodyEl = $('#body'), footEl = $('#foot'), actionsEl = $('#actions');
  const settings = $('#settings'), music = $('#music'), mini = $('#mini-player'),
    memory = $('#memory'), memEdit = $('#mem-edit'), trans = $('#trans'),
    plugins = $('#plugins'), plugMarketPage = $('#plug-market-page');
  const attachEl = $('#attach-bar');
  bodyEl.style.display = 'none';
  footEl.style.display = 'none';
  actionsEl.style.display = 'none';
  if (attachEl) attachEl.style.display = 'none';
  settings.classList.remove('open');
  music.classList.remove('open');
  if (plugins) plugins.classList.remove('open');
  if (plugMarketPage) plugMarketPage.classList.remove('open');
  if (memory) memory.classList.remove('open');
  if (memEdit) memEdit.classList.remove('open');
  if (trans) trans.classList.remove('open');
  mini.style.display = v === 'chat' ? '' : 'none';
  if (v === 'chat') {
    bodyEl.style.display = 'flex';
    footEl.style.display = 'flex';
    actionsEl.style.display = 'flex';
    if (attachEl) attachEl.style.display = '';
    bodyEl.scrollTop = bodyEl.scrollHeight;
    updateMini();
  } else if (v === 'settings') settings.classList.add('open');
  else if (v === 'plugins' && plugins) { plugins.classList.add('open'); renderPlugins(); }
  else if (v === 'plug-market' && plugMarketPage) { plugMarketPage.classList.add('open'); renderPlugMarket(); }
  else if (v === 'music') music.classList.add('open');
  else if (v === 'memory' && memory) {
    memory.classList.add('open');
    const s = $('#mem-search');
    if (s) s.value = MEMUI.keyword;
    renderMemory();
  }
  else if (v === 'translate' && trans) {
    trans.classList.add('open');
    renderTrans();
  }
}

/**
 * 插件与工具页的交互：返回设置、查看 AI 说明、开关整组或单项工具。
 */
function bindPluginsPage() {
  const back = $('#plug-back');
  if (back) back.onclick = () => showView('settings');

  const pb = $('#plug-preview-btn');
  if (pb) pb.onclick = () => {
    const box = $('#plug-preview');
    if (!box) return;
    const show = box.style.display === 'none';
    if (show) renderPlugPreview();
    box.style.display = show ? 'block' : 'none';
    pb.textContent = show ? '收起 AI 说明' : 'AI 说明';
  };

  const hb = $('#plug-help');
  if (hb) hb.onclick = () => {
    const box = $('#plug-help-box');
    if (!box) return;
    const show = box.style.display === 'none';
    if (show) box.textContent = PLUG_HELP;
    box.style.display = show ? 'block' : 'none';
    hb.textContent = show ? '收起说明' : '格式说明';
  };

  const list = $('#plug-list');
  if (list) list.onclick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.dataset.plugSw) { togglePlug(b.dataset.plugSw); return; }
    if (b.dataset.cplugSw) { toggleUserPlug(b.dataset.cplugSw); return; }
    if (b.dataset.toolSw) { toggleTool(b.dataset.toolSw); return; }
    if (b.dataset.plugDel) { plugDelete(b.dataset.plugDel); return; }
  };

  const market = $('#plug-market');
  if (market) market.onclick = () => showView('plug-market');
  const marketBack = $('#plug-market-back');
  if (marketBack) marketBack.onclick = () => showView('plugins');
  const marketSourceToggle = $('#plug-market-source-toggle');
  if (marketSourceToggle) marketSourceToggle.onclick = () => {
    const box = $('#plug-market-url-box');
    if (box) box.hidden = !box.hidden;
  };
  const marketSync = $('#plug-market-sync');
  if (marketSync) marketSync.onclick = syncPlugMarket;
  const marketList = $('#plug-market-list');
  if (marketList) marketList.onclick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-market-install]') : null;
    if (b && !b.disabled) installMarketPlugin(b.dataset.marketInstall, b.dataset.marketSource || 'local');
  };
  const marketSearch = $('#plug-market-search');
  if (marketSearch) marketSearch.oninput = () => { PLUG_MARKET_PAGE = 1; renderPlugMarket(); };
  const marketSearchBtn = $('#plug-market-search-btn');
  if (marketSearchBtn) marketSearchBtn.onclick = () => { PLUG_MARKET_PAGE = 1; renderPlugMarket(); };
  const marketPrev = $('#plug-market-prev');
  if (marketPrev) marketPrev.onclick = () => { PLUG_MARKET_PAGE--; renderPlugMarket(); };
  const marketNext = $('#plug-market-next');
  if (marketNext) marketNext.onclick = () => { PLUG_MARKET_PAGE++; renderPlugMarket(); };
  const inst = $('#plug-install');
  if (inst) inst.onclick = () => openPlugInstall('text');
  ['text', 'file', 'url'].forEach(mode => { const b = $('#plug-mode-' + mode); if (b) b.onclick = () => setPlugImportMode(mode); });
  const pick = $('#plug-file-pick'); if (pick) pick.onclick = pickPlugFile;
  const loadUrl = $('#plug-url-load'); if (loadUrl) loadUrl.onclick = plugInstallFromUrl;
  const pc = $('#plug-cancel');
  if (pc) pc.onclick = () => $('#plug-modal').classList.remove('open');
  const pok = $('#plug-ok');
  if (pok) pok.onclick = () => PLUG_IMPORT_MODE === 'url' ? plugInstallFromUrl() : plugInstallFromText($('#plug-code').value);
  const pm = $('#plug-modal');
  if (pm) pm.onclick = (e) => { if (e.target === pm) pm.classList.remove('open'); };
  $$('.plug-risk-close').forEach(b => b.onclick = () => { const x = $('#' + b.dataset.closeRisk); if (x) x.remove(); });
}

/** 更新弹窗的关闭 / 下载按钮。 */
function bindUpdateModal() {
  const later = $('#upd-later');
  if (later) later.onclick = () => $('#update-modal').classList.remove('open');
  const go = $('#upd-go');
  if (go) go.onclick = downloadUpdate;
  const m = $('#update-modal');
  if (m) m.onclick = (e) => { if (e.target === m) m.classList.remove('open'); };
}

/* ==========================================================
 *  音乐 UI
 * ========================================================== */
function renderMusicCacheInfo() {
  const box = $('#music-cache-info'); if (!box) return;
  try {
    const info = HAS_NATIVE && Android.getMusicCacheInfo ? JSON.parse(Android.getMusicCacheInfo() || '{}') : {};
    const mb = ((Number(info.bytes || 0) / 1024 / 1024) || 0).toFixed(1);
    box.textContent = '本地缓存：' + (info.count || 0) + ' 首 / ' + mb + ' MB · ' + (info.path || '暂不可见');
  } catch (e) { box.textContent = '本地缓存状态暂不可用'; }
}

function bindMusicUI() {
  $$('.mtab').forEach(tab => { tab.onclick = () => renderMusicTab(tab.dataset.tab); });
  $('#music-back').onclick = () => showView('chat');
  $('#fav-cnt').textContent = favorites.length;

  const doSearch = async (append) => {
    const kw = $('#ms-input').value.trim();
    if (!kw) return;
    $('#music-list').innerHTML = `<div class="mload">${append ? '继续搜索中' : '搜索中'}♪...</div>`;
    try { await mSearch(kw, !!append); renderMusicTab('search'); }
    catch (e) { $('#music-list').innerHTML = `<div class="mempty">搜索失败：${esc(errMsg(e))}</div>`; }
  };
  $('#ms-btn').onclick = () => doSearch(false);
  $('#ms-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(false); } };
  const more = $('#music-more');
  if (more) more.onclick = () => doSearch(true);

  $('#music-player .mp-play').onclick = togglePlay;
  $('#music-player .mp-prev').onclick = playPrev;
  $('#music-player .mp-next').onclick = () => playNext(false);
  $('#music-player .mp-mode').onclick = cyclePlayMode;

  const progEl = $('#mp-progress');
  let progDrag = false;
  const seekTo = (clientX) => {
    const dur = M.dur || 0;
    if (!dur) return;
    const r = progEl.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const ms = Math.round(p * dur);
    M.pos = ms;
    const n = MP();
    if (n) { try { n.mpSeek(ms); } catch (e) {} }
    else if (M.audio) M.audio.currentTime = ms / 1000;
    M.lyricIndex = -1; onLyricTime(); updateProgress();
  };
  progEl.addEventListener('touchstart', e => { progDrag = true; seekTo(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
  progEl.addEventListener('touchmove', e => { if (progDrag) { seekTo(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
  progEl.addEventListener('touchend', () => { progDrag = false; });
  progEl.addEventListener('mousedown', e => { progDrag = true; seekTo(e.clientX); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (progDrag) seekTo(e.clientX); });
  document.addEventListener('mouseup', () => { progDrag = false; });

  const clearCache = $('#music-clear-cache');
  if (clearCache) clearCache.onclick = async () => {
    if (!(await uiConfirm('清理全部音乐缓存？不会删除收藏、历史和播放队列。', '清理缓存', '音乐缓存'))) return;
    const n = HAS_NATIVE && Android.clearMusicCache ? Android.clearMusicCache() : 0;
    M.cache = []; musicSaveCacheRecords(); M.downloads = {};
    toast('已清理 ' + n + ' 个缓存文件'); renderMusicTab('cache');
  };
  $('#music-lyric').onclick = () => { updateLyricModal(); $('#lyric-modal').classList.add('open'); };
  $('#lyric-modal').onclick = (e) => {
    if (e.target === $('#lyric-modal') || e.target.classList.contains('lyric-close')) $('#lyric-modal').classList.remove('open');
  };

  const mini = $('#mini-player');
  mini.querySelector('.mini-play').onclick = () => { M.miniHidden = false; togglePlay(); };
  mini.querySelector('.mini-close').onclick = () => { M.miniHidden = true; mini.classList.remove('show'); };
  mini.querySelector('.mini-info').onclick = () => showView('music');
  bindMusicContextMenu();
  renderMusicTab('search');
}

/* ==========================================================
 *  顶栏按钮
 * ========================================================== */
function bindTaskUI() {
  const menu = $('#task-menu'), drawer = $('#task-drawer'), close = $('#task-close');
  let holdTimer = null, held = false;
  const startHold = (row) => { clearTimeout(holdTimer); held = false; holdTimer = setTimeout(() => { held = true; deleteTask(row.dataset.taskId); }, 650); };
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  if (menu) menu.onclick = () => { renderTaskDrawer(); drawer.classList.toggle('open'); };
  if (close) close.onclick = () => drawer.classList.remove('open');
  // 顶栏模式标签：在任务里点它随时回到聊天；已在聊天时点它打开任务舱
  const modeLabel = $('#mode-label');
  if (modeLabel) {
    modeLabel.style.cursor = 'pointer';
    modeLabel.onclick = () => {
      const t = currentTask();
      if (t && t.type !== 'chat') {
        taskSetCurrent(taskEnsureChat().id);
        toast('已回到聊天');
      } else {
        renderTaskDrawer();
        if (drawer) drawer.classList.toggle('open');
      }
    };
  }
  const list = $('#task-list');
  if (list) {
    list.addEventListener('touchstart', e => { const row = e.target.closest && e.target.closest('[data-task-id]'); if (row && !e.target.closest('button')) startHold(row); }, { passive: true });
    list.addEventListener('touchmove', cancelHold, { passive: true });
    list.addEventListener('touchend', cancelHold, { passive: true });
    list.addEventListener('contextmenu', e => { const row = e.target.closest && e.target.closest('[data-task-id]'); if (row) { e.preventDefault(); deleteTask(row.dataset.taskId); } });
  }
  if (list) list.onclick = async (e) => { const row = e.target.closest ? e.target.closest('[data-task-id]') : null; const act = e.target.closest ? e.target.closest('[data-task-action]') : null; const restoreBtn = e.target.closest ? e.target.closest('[data-task-restore]') : null;
    if (held) { held = false; return; }
    if (restoreBtn) { const cur = currentTask(); if (!(HAS_PERM && Perm.restoreTaskFile)) return; if (await uiConfirm('回滚文件到快照？\n\n' + restoreBtn.dataset.taskRestore + '\n\n当前内容会先自动备份。', '确认回滚', '工作区回滚')) { try { const r = JSON.parse(Perm.restoreTaskFile(cur.id, restoreBtn.dataset.taskRestore) || '{}'); toast(r.ok ? '已回滚：' + r.restored : (r.error || '回滚失败')); } catch (err) { toast('回滚失败'); } renderTaskDrawer(); } return; }
    if (act && act.dataset.taskAction === 'refresh') { renderTaskDrawer(); return; }
    if (!row) return; if (act) { const id = row.dataset.taskId; if (act.dataset.taskAction === 'pause') taskPause(id); else if (act.dataset.taskAction === 'resume') taskResume(id); else if (act.dataset.taskAction === 'cancel') taskCancel(id); else if (act.dataset.taskAction === 'delete') deleteTask(id); return; } drawer.classList.remove('open'); taskSetCurrent(row.dataset.taskId); };
  const nw = $('#task-new-work');
  if (nw) nw.onclick = async () => { const t = taskAdd('workspace', '新工作任务', ''); const ready = await ensureTaskWorkspace(t); drawer.classList.remove('open'); toast(ready.ok ? '已创建工作任务和独立工作区：' + t.title : (ready.error || '工作区创建失败')); };
  renderTaskDrawer(); updateTaskMode();
}
function handleNativeBack() {
  const drawer = $('#task-drawer'); if (drawer && drawer.classList.contains('open')) { drawer.classList.remove('open'); return true; }
  const market = $('#plug-market-page'); if (market && market.classList.contains('open')) { showView('plugins'); return true; }
  const plugins = $('#plugins'); if (plugins && plugins.classList.contains('open')) { showView('settings'); return true; }
  const open = ['settings','music','memory','trans'].some(id => { const x = $('#' + id); return x && (x.classList.contains('open') || x.style.display === 'flex'); });
  if (open) { showView('chat'); return true; }
  return false;
}
window.__nativeBack = handleNativeBack;
function bindHeader() {
  const setBtn = $('#btn-set'); if (setBtn) setBtn.onclick = () => showView('settings');
  const memBtn = $('#btn-mem'); if (memBtn) memBtn.onclick = () => showView('memory');
  const musicBtn = $('#btn-music'); if (musicBtn) musicBtn.onclick = () => { renderMusicTab('search'); showView('music'); };
  $('#btn-close').onclick = () => {
    if (HAS_NATIVE && Android.closeFloat) Android.closeFloat();
  };
  bindMinButton();
  const clearBtn = $('#btn-clr'); if (clearBtn) clearBtn.onclick = async () => {    if (!(await uiConfirm('清空当前对话？（记忆库会保留）', '清空'))) return;
    history = [{ role: 'system', content: CONFIG.systemPrompt }];
    saveHistory();
    renderHistory();
    toast('已清空对话，记忆还在~');
  };
}

/**
 * 顶栏的「－」：收成悬浮小球（原来那个小窗，与聊天窗互相切换）。
 * 注意：小胶囊（capsule）**不是**这个按钮做的事情——
 * 小胶囊只用于「读屏类快捷指令」（翻译屏幕 / 总结屏幕 / 要点 / 解释），
 * 目的是把浮窗挪开、不挡屏幕；音乐迷你条又是另一个完全独立的东西。
 */
function bindMinButton() {
  const b = $('#btn-min');
  if (!b) return;
  b.onclick = () => {
    try { if (HAS_NATIVE && Android.minimizeToBubble) Android.minimizeToBubble(); } catch (e) {}
  };
}

/* ==========================================================
 *  输入区
 * ========================================================== */
function bindInput() {
  const inputEl = $('#input');
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSafe(); }
  });
  bindTap($('#send'), sendSafe);
  bindTap($('#btn-plus'), () => $('#plus-modal').classList.add('open'));
  $('#plus-image').onclick = () => { $('#plus-modal').classList.remove('open'); startPickAttachment('image'); };
  $('#plus-file').onclick = () => { $('#plus-modal').classList.remove('open'); startPickAttachment('file'); };
  $('#plus-cancel').onclick = () => $('#plus-modal').classList.remove('open');
  $('#plus-modal').onclick = (e) => { if (e.target === $('#plus-modal')) $('#plus-modal').classList.remove('open'); };
  $('#attach-del').onclick = clearAttachment;
}

/* ==========================================================
 *  拖拽（Android 侧 WindowManager 移动）
 * ========================================================== */
function bindDrag() {
  const headEl = $('#head');
  let lastX = 0, lastY = 0, isDown = false;

  const start = (x, y) => {
    if (!HAS_PERM || !Perm.moveWindow) return;
    isDown = true; lastX = x; lastY = y;
  };
  const move = (x, y) => {
    if (!isDown) return;
    const dx = x - lastX, dy = y - lastY;
    lastX = x; lastY = y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    // screenX 是 css px，原生 moveBy 要物理 px
    const d = window.devicePixelRatio || 1;
    try { Perm.moveWindow(Math.round(dx * d), Math.round(dy * d)); } catch (e) {}
  };
  const end = () => { isDown = false; };

  headEl.addEventListener('touchstart', e => {
    if (e.target.closest('button')) return;
    const t = e.touches[0];
    start(t.screenX, t.screenY);
  }, { passive: true });
  headEl.addEventListener('touchmove', e => {
    if (!isDown) return;
    const t = e.touches[0];
    move(t.screenX, t.screenY);
    e.preventDefault();
  }, { passive: false });
  headEl.addEventListener('touchend', end);
  headEl.addEventListener('touchcancel', end);

  headEl.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    start(e.screenX, e.screenY);
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => { if (isDown) move(e.screenX, e.screenY); });
  document.addEventListener('mouseup', end);
}

