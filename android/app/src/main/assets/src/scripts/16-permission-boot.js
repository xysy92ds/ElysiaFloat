/* ==========================================================
 *  权限引导
 * ========================================================== */
const PERM_ITEMS = [
  { id: 'overlay', name: '悬浮窗权限', required: true,
    desc: '必需。没有它，爱莉希雅就只能缩在 App 里，没法浮在桌面上陪你。',
    check: () => (HAS_PERM && Perm.hasOverlay) ? Perm.hasOverlay() : false,
    request: () => { if (HAS_PERM && Perm.requestOverlay) Perm.requestOverlay(); },
    wait: 800 },
  { id: 'notification', name: '通知权限', required: true,
    desc: 'Android 13+ 需要它，浮窗才能稳定常驻，不被系统清掉。',
    check: () => (HAS_PERM && Perm.hasNotification) ? Perm.hasNotification() : true,
    request: () => { if (HAS_PERM && Perm.requestNotification) Perm.requestNotification(); },
    wait: 500 },
  // Android 8+ 特有：用户一旦关掉这个通知渠道，前台服务会被系统直接杀掉，
  // 浮窗消失、息屏断掉都是这个原因，而 hasNotification() 在 8~12 上是恒真，
  // 查不出来，所以单列一项。
  { id: 'channel', name: '通知渠道未被关闭', required: false,
    when: () => sdkAtLeast(26),
    desc: 'Android 8+ 专属。如果把「爱莉希雅浮窗」或「正在播放」这两条通知关掉，浮窗后台会被系统清理 —— 浮窗凭空消失、息屏音乐断掉，十有八九都是这里。',
    check: () => (HAS_PERM && Perm.isNotificationChannelOn) ? Perm.isNotificationChannelOn() : true,
    request: () => { if (HAS_PERM && Perm.requestNotificationChannel) Perm.requestNotificationChannel(); },
    wait: 800 },
  { id: 'battery', name: '后台保活', required: false,
    desc: '可选，但听歌建议开。加入电池优化白名单，浮窗和后台播放不会被系统杀掉。\n注意：它管的是「进程别被杀」，管不了「息屏后 CPU 睡着」—— 后者已经由原生播放器的唤醒锁解决了，所以这一个不开也能息屏听歌。',
    check: () => (HAS_PERM && Perm.isIgnoringBattery) ? Perm.isIgnoringBattery() : false,
    request: () => { if (HAS_PERM && Perm.requestIgnoreBattery) Perm.requestIgnoreBattery(); },
    wait: 800 },
  { id: 'accessibility', name: '无障碍权限', required: false,
    desc: '可选但强烈推荐。开启后能读取屏幕内容，帮你翻译、总结当前页面。',
    check: () => (HAS_PERM && Perm.hasAccessibility) ? Perm.hasAccessibility() : false,
    request: () => { if (HAS_PERM && Perm.requestAccessibility) Perm.requestAccessibility(); },
    wait: 800 },
  { id: 'all-files', name: '允许管理所有文件', required: false,
    desc: '使用 Agent 工作区时需要。授权后仍只允许 Agent 访问 Documents/ElysiaFloat/workspace，不会直接把其它目录交给模型。',
    check: () => (HAS_PERM && Perm.hasAllFilesAccess) ? Perm.hasAllFilesAccess() : false,
    request: () => { if (HAS_PERM && Perm.requestAllFilesAccess) Perm.requestAllFilesAccess(); },
    wait: 900 }
];
const permState = {};

/** 当前真正展示的权限项（带 when 的按系统版本过滤，避免老系统上一堆无效项）。 */
function activePermItems() {
  return PERM_ITEMS.filter(i => !i.when || i.when());
}

function renderGuideSteps() {
  const box = $('#guide-steps');
  const items = activePermItems();
  box.innerHTML = items.map(item => {
    const ok = !!permState[item.id];
    const cls = ok ? 'ok' : (item.required ? 'need' : '');
    const badge = ok ? '已完成' : (item.required ? '必需' : '推荐');
    const btn = ok
      ? `<button class="step-btn ghost" data-perm="${item.id}">重新授权</button>`
      : `<button class="step-btn" data-perm="${item.id}">去授权</button>`;
    const icon = ok ? '✓' : '!';
    return `<div class="step ${cls}" data-step="${item.id}">
      <div class="step-icon">${icon}</div>
      <div class="step-body">
        <div class="step-name">${esc(item.name)}<span class="step-badge">${badge}</span></div>
        <div class="step-desc">${esc(item.desc)}</div>
        ${btn}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.step-btn').forEach(b => {
    b.onclick = () => {
      const item = PERM_ITEMS.find(x => x.id === b.dataset.perm);
      if (!item) return;
      item.request();
      setTimeout(refreshPermState, item.wait);
      setTimeout(refreshPermState, 1500);
      vibrate(15);
    };
  });
  updateGuideNext();
}
function refreshPermState() {
  let changed = false;
  activePermItems().forEach(item => {
    let v = false;
    try { v = !!item.check(); } catch (e) { v = false; }
    if (permState[item.id] !== v) { permState[item.id] = v; changed = true; }
  });
  if (changed) renderGuideSteps();
}
function updateGuideNext() {
  const allRequiredOk = activePermItems().filter(i => i.required).every(i => permState[i.id]);
  const btn = $('#guide-next');
  btn.disabled = !allRequiredOk;
  btn.textContent = allRequiredOk ? '开始使用 ♪' : '还有必需权限未开启';
}
function showGuide() {
  $('#guide').classList.add('show');
  const av = $('#guide-avatar');
  av.src = CONFIG.avatarUrl || FALLBACK_AVATAR;
  av.onerror = function () { this.onerror = null; this.src = FALLBACK_AVATAR; };
  refreshPermState();
  renderGuideSteps();
  // 布局要等一帧才算完，量两次（下一帧 + 350ms）防字体/头像晚到把高度撑变
  requestAnimationFrame(() => ensureGuideFooterVisible());
  try { bindCtxMenu(); } catch (e) {}
  try { bindPreviewUI(); } catch (e) {}
  setTimeout(() => ensureGuideFooterVisible(), 350);
}

/**
 * 「先跳过 / 下一步」永远得点得到 —— 不靠推导，靠量。
 *
 * 正常情况 flex 已经把页脚钉在卡片底部（.guide-steps 上那个 min-height:0）。
 * 但百分比高度 + flex 在不同 WebView 版本上偶有差异，一旦哪条链断掉，
 * 页脚就会被内容顶出屏幕，且外层又不滚 —— 用户就只能看到一个没有出口的页面。
 * 所以这里量一下页脚的实际位置，真出界了就把卡片放开成自适应高度，
 * 改由最外层 #guide 整页滚动。降级后一定点得到，只是长得没那么好看而已。
 */
function ensureGuideFooterVisible() {
  const card = $('#guide .guide-card');
  const steps = $('#guide-steps');
  const foot = $('#guide .guide-foot');
  if (!card || !steps || !foot) return;
  if (!$('#guide').classList.contains('show')) return;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (vh < 120) return;
  const fr = foot.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  if (fr.height > 0 && fr.bottom <= vh - 2 && cr.height <= vh + 2) return;
  // 页脚出界 或 卡片本身比窗口还高 → 降级
  card.style.height = 'auto';
  card.style.maxHeight = 'none';
  steps.style.flex = '0 0 auto';
  steps.style.overflowY = 'visible';
  steps.style.minHeight = '0';
}
function hideGuide() {
  $('#guide').classList.remove('show');
  if (HAS_PERM && Perm.setGuideDone) try { Perm.setGuideDone(); } catch (e) {}
}

/* 首次启动公告：只记录“我知道了”，不把公告阅读当成永久权限授权。 */
/* 公告按「版本号」记录：每个版本首次进入都提示一次，跨版本自动重新出现。 */
const ANNOUNCEMENT_FALLBACK_VER = '0.7.0';
const ANNOUNCEMENT_REPO = 'https://github.com/xysy92ds/ElysiaFloat';
function announcementKey() {
  const raw = String((loadEnv() || {}).appVer || ANNOUNCEMENT_FALLBACK_VER).trim()
    .replace(/[^0-9A-Za-z._-]/g, '');
  return 'via_ai_announcement_v' + (raw || ANNOUNCEMENT_FALLBACK_VER);
}
function showAnnouncement(force) {
  if (!force && sGet(announcementKey(), false)) return;
  const modal = $('#announcement-modal');
  if (modal) {
    const app = $('#app');
    if (app) app.classList.add('announcement-visible');
    modal.classList.add('open');
  }
}
function hideAnnouncement() {
  const modal = $('#announcement-modal');
  if (modal) modal.classList.remove('open');
  const app = $('#app');
  if (app) app.classList.remove('announcement-visible');
  sSet(announcementKey(), true);
}
function bindAnnouncement() {
  const close = $('#announcement-close');
  if (close) close.onclick = hideAnnouncement;
  const repo = $('#announcement-repo');
  if (repo) repo.onclick = () => {
    try {
      if (HAS_NATIVE && Android.openUrl) Android.openUrl(ANNOUNCEMENT_REPO);
      else if (window.open) window.open(ANNOUNCEMENT_REPO, '_blank');
    } catch (e) {}
  };
  const modal = $('#announcement-modal');
  if (modal) modal.onclick = (e) => { if (e.target === modal) hideAnnouncement(); };
  // 权限引导页先完成首帧布局，公告随后显示并盖在引导页上；关闭后仍可继续授权。
  setTimeout(() => showAnnouncement(false), 700);
}
function bindGuide() {
  $('#guide-next').onclick = () => {
    if ($('#guide-next').disabled) return;
    hideGuide();
    toast('准备完成，交给我吧~ ♪');
  };
  $('#guide-skip').onclick = () => {
    const missing = activePermItems().filter(i => i.required && !permState[i.id]);
    if (missing.length) {
      toast('还有必需权限没开哦\n' + missing.map(m => '· ' + m.name).join('\n'));
      return;
    }
    hideGuide();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPermState();
  });
  // 旋转 / 分屏 / 拖动改窗口大小后，页脚可能又被顶出去
  window.addEventListener('resize', () => {
    if ($('#guide').classList.contains('show')) ensureGuideFooterVisible();
  });
  setInterval(() => {
    if ($('#guide').classList.contains('show')) {
      refreshPermState();
      ensureGuideFooterVisible();
    }
  }, 2000);

  let guideDone = false;
  if (HAS_PERM && Perm.isGuideDone) {
    try { guideDone = Perm.isGuideDone(); } catch (e) {}
  }
  setTimeout(() => {
    refreshPermState();
    const missing = activePermItems().filter(i => i.required && !permState[i.id]);
    if (!guideDone || missing.length) showGuide();
  }, 400);
}

/* ==========================================================
 *  原生 → JS 接口
 * ========================================================== */
window.EllyAPI = {
  openSettings() { showView('settings'); },
  openMusic() { renderMusicTab('search'); showView('music'); },
  onShow() {},
  onHide() {}
};

/* ==========================================================
 *  启动
 * ========================================================== */
function boot() {
  // 内置头像 → 原始外链
  if (CONFIG.avatarUrl === OLD_LOCAL_AVATAR) {
    CONFIG.avatarUrl = DC.avatarUrl;
    sSet('via_ai_config', CONFIG);
  }
  memMigrateLegacy();   // 旧版那条单一「长期记忆总结」→ 记忆库里的 1 条
  showView('chat');     // E1-001：启动永远落在聊天首页
  applyTheme();
  renderActions();
  renderSettings();
  renderHistory();
  bindHeader();
  bindTaskUI();
  bindInput();
  bindMusicUI();
  bindPluginsPage();
  bindUpdateModal();
  bindMemory();
  bindTransUI();
  bindDrag();
  bindGuide();
  bindModal();
  bindCrop();
  bindResize();
  initZoom();
  bindAnnouncement();

  // 系统旋转 / 分屏改变窗口尺寸时，面板得跟着对账（原生不一定能及时推过来）
  window.addEventListener('resize', () => { setTimeout(() => reconcile(true), 60); });
  window.addEventListener('orientationchange', () => { setTimeout(() => reconcile(true), 300); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => reconcile(true), 60);
  });

  const lv = webviewLevel();
  if (lv === 'bad') {
    setTimeout(() => toast('系统 WebView 版本过低，可能显示异常，建议更新「Android System WebView」', 5200), 1600);
  }
  renderEnvBox();   // 这时 BASE/ZOOM 才算好了，环境面板里那行窗口信息才准

  $('#btn-music').hidden = !CONFIG.musicEnabled;
  $('#fav-cnt').textContent = favorites.length;

  // 首次进入 / 距上次检查超过 24 小时，自动检查一次更新（不打扰，只有真的有新版才弹窗）
  try {
    const last = CONFIG.lastUpdateCheck || 0;
    if (CONFIG.autoCheckUpdate !== false && (Date.now() - last > 24 * 3600 * 1000)) {
      setTimeout(() => { checkUpdate(false); }, 3000);
    }
  } catch (e) {}

  // 0.11：启动时恢复插件主题并挂载聊天入口（失败不影响主流程）。
  try { if (typeof plugThemeRestore === 'function') plugThemeRestore(); } catch (e) {}
  try { if (typeof plugMountRefresh === 'function') plugMountRefresh(); } catch (e) {}

  // 0.12：进程重启后合并检查点（活跃会话转暂停），再启动后台任务调度。
  try { if (typeof persistRecoverAll === 'function') persistRecoverAll(); } catch (e) {}
  try { if (typeof persistSchedulerStart === 'function') persistSchedulerStart(); } catch (e) {}

  console.log('[Elly] 就绪 ♪ 记忆 ' + MEM.length + ' 条 · 插件 ' + USER_PLUGINS.length + ' 个');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else boot();

})();
