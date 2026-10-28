/* ==========================================================
 *  自定义弹窗（替代原生 confirm，浮窗里才能正常显示）
 * ========================================================== */
let _modalCb = null;

/* 通用点击绑定：Android WebView 里单个 onclick 偶发被吞。
 * 同时挂 pointerup / touchend / click，并按时间做去重，避免同一手势重复触发。 */
function bindTap(el, fn) {
  if (!el) return;
  try { el.type = 'button'; } catch (e) {}
  el.style.pointerEvents = 'auto';
  el.style.touchAction = 'manipulation';
  let last = 0;
  const handler = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const now = Date.now();
    if (now - last < 350) return false;
    last = now;
    fn(e);
    return false;
  };
  el.onclick = handler;
  el.ontouchend = handler;
  el.onpointerup = handler;
}
/* ==========================================================
 *  长按菜单（复制 / 全选 / 粘贴）
 *  覆盖层窗口里系统 ActionMode 常被立刻 dismiss，这里补一个系统样式的兜底：
 *  只有长按才出现，不做常驻按钮。
 * ========================================================== */
let CTX_TARGET = null, CTX_TIMER = null, CTX_LAST_TOUCH = null, CTX_DOWN = false;
/** 长按刚弹出菜单时，抬手会立刻触发 touchend；这一下必须忽略，否则菜单「一闪就没」。 */
let CTX_HOLD_OPEN = false;

function ensureCtxMenu() {
  let m = $('#ctx-menu');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'ctx-menu';
  m.className = 'ctx-menu';
  m.hidden = true;
  document.body.appendChild(m);
  return m;
}

function hideCtxMenu() {
  const m = $('#ctx-menu');
  if (m) m.hidden = true;
  CTX_TARGET = null;
  CTX_HOLD_OPEN = false;
}

function ctxSelectionText() {
  try { const sel = window.getSelection(); return sel ? String(sel.toString() || '') : ''; } catch (e) { return ''; }
}

function showCtxMenu(x, y, items) {
  const m = ensureCtxMenu();
  m.innerHTML = '';
  items.forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    // 用 bindTap：touchend 就触发，早于下面 touchend 里的“0ms 后隐藏菜单”。
    // 原来用 onclick 时，菜单会在 click 派发前被隐藏，点「粘贴」永远没反应。
    bindTap(b, () => { hideCtxMenu(); try { it.run(); } catch (err) { toast('操作失败'); } });
    m.appendChild(b);
  });
  const w = window.innerWidth || 360, h = window.innerHeight || 640;
  m.hidden = false;
  const rect = m.getBoundingClientRect ? m.getBoundingClientRect() : { width: 120, height: 40 };
  const mw = rect.width || 120, mh = rect.height || 40;
  m.style.left = Math.max(6, Math.min(w - mw - 6, x - mw / 2)) + 'px';
  m.style.top = Math.max(6, Math.min(h - mh - 6, y - mh - 12)) + 'px';
}

/** 根据长按位置判断该弹哪些操作 */
function openCtxFor(target, x, y) {
  if (!target) return;
  const tag = String(target.tagName || '').toUpperCase();
  const sel = ctxSelectionText();
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    // 先让输入框拿到焦点：Android 10+ 只允许有焦点的应用读剪贴板，
    // 覆盖层窗口没焦点时 getClipboard() 会返回空，粘贴就永远「读不到剪贴板」。
    try { target.focus(); } catch (e) {}
    const items = [{ label: '粘贴', run: () => pasteIntoField(target) }];
    if (sel) items.unshift({ label: '复制', run: () => { if (copyToClipboard(sel)) toast('已复制'); } });
    items.push({ label: '全选', run: () => { try { target.select(); } catch (e) {} } });
    showCtxMenu(x, y, items);
    return;
  }
  // 正文：优先把选中的内容当作用户想复制的
  const msgEl = target.closest ? target.closest('.msg') : null;
  const text = sel || (msgEl ? String((msgEl.querySelector('.msg-body') || msgEl).textContent || '') : '');
  if (!text) return;
  showCtxMenu(x, y, [
    { label: sel ? '复制选中' : '复制这条', run: () => { if (copyToClipboard(text)) toast('已复制'); } },
    { label: '全选这段', run: () => {
        try {
          const r = document.createRange();
          const node = (msgEl && (msgEl.querySelector('.msg-body') || msgEl)) || target;
          r.selectNodeContents(node);
          const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r);
        } catch (e) {}
      } }
  ]);
}

function bindCtxMenu() {
  const cancel = () => { if (CTX_TIMER) { clearTimeout(CTX_TIMER); CTX_TIMER = null; } CTX_DOWN = false; };
  document.addEventListener('touchstart', (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (e.target && e.target.closest && e.target.closest('#ctx-menu')) return;
    hideCtxMenu();
    CTX_DOWN = true;
    CTX_LAST_TOUCH = { x: t.clientX, y: t.clientY, target: e.target };
    cancel2();
    CTX_TIMER = setTimeout(() => {
      if (!CTX_DOWN) return;
      const info = CTX_LAST_TOUCH;
      if (info) {
        CTX_HOLD_OPEN = true;   // 这一抬手不要关菜单，等用户去点菜单项
        openCtxFor(info.target, info.x, info.y);
      }
      CTX_TIMER = null;
    }, 550);
    function cancel2() { if (CTX_TIMER) { clearTimeout(CTX_TIMER); CTX_TIMER = null; } }
  }, { passive: true });
  // 长按期间手指几乎不可能完全不动：以前只要收到 touchmove 就取消，
  // 真机上轻微微抖（1~3px）就把菜单吞掉了，表现就是「长按没反应」。
  // 现在只有移动超过阈值才算滑动，才取消长按。
  const MOVE_TOLERANCE = 14;
  document.addEventListener('touchmove', (e) => {
    if (!CTX_DOWN) return;
    const t = e.touches && e.touches[0];
    if (!t || !CTX_LAST_TOUCH) { cancel(); return; }
    if (Math.abs(t.clientX - CTX_LAST_TOUCH.x) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - CTX_LAST_TOUCH.y) > MOVE_TOLERANCE) cancel();
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    cancel();
    // 点在菜单自己身上时不要隐藏：隐藏会发生在菜单项的 touchend 之后、click 之前。
    if (e.target && e.target.closest && e.target.closest('#ctx-menu')) return;
    // 长按抬手：菜单是刚弹出来的，这一下不能关，否则用户根本点不到。
    if (CTX_HOLD_OPEN) { CTX_HOLD_OPEN = false; return; }
    setTimeout(() => { if (!ctxSelectionText()) hideCtxMenu(); }, 0);
  }, { passive: true });
  document.addEventListener('touchcancel', () => { cancel(); hideCtxMenu(); }, { passive: true });
  document.addEventListener('click', (e) => {
    const m = $('#ctx-menu');
    if (m && !m.hidden && e.target !== m && !(m.contains && m.contains(e.target))) hideCtxMenu();
  });
}

function uiConfirm(msg, okText, title) {
  return new Promise((resolve) => {
    _modalCb = resolve;
    $('#modal-title').textContent = title || '请确认';
    $('#modal-msg').textContent = msg;
    $('#modal-ok').textContent = okText || '确定';
    $('#modal').classList.add('open');
  });
}
function closeModal(ok) {
  $('#modal').classList.remove('open');
  if (_modalCb) { const cb = _modalCb; _modalCb = null; cb(!!ok); }
}
function bindModal() {
  $('#modal-ok').onclick = () => closeModal(true);
  $('#modal-cancel').onclick = () => closeModal(false);
  $('#modal').onclick = (e) => { if (e.target === $('#modal')) closeModal(false); };
}

/* ==========================================================
 *  头像选择与裁剪
 * ========================================================== */
const AV_LOCAL = '（本地图片）';
const CP = { img: null, iw: 1, ih: 1, vp: 600, scale: 1, base: 1, min: 1, max: 1,
  tx: 0, ty: 0, drag: false, lx: 0, ly: 0, pinch: 0, pscale: 1 };

function openCropper(src) {
  const img = new Image();
  img.onload = () => {
    CP.img = img; CP.iw = img.naturalWidth || img.width; CP.ih = img.naturalHeight || img.height;
    CP.base = Math.max(CP.vp / CP.iw, CP.vp / CP.ih);
    CP.min = CP.base; CP.max = CP.base * 4;
    CP.scale = CP.base;
    CP.tx = (CP.vp - CP.iw * CP.scale) / 2;
    CP.ty = (CP.vp - CP.ih * CP.scale) / 2;
    cpClamp(); cpSyncZoom(); cpDraw();
    $('#crop-modal').classList.add('open');
  };
  img.onerror = () => toast('图片读取失败，换一张试试~');
  img.src = src;
}
function cpClamp() {
  const w = CP.iw * CP.scale, h = CP.ih * CP.scale;
  CP.tx = Math.min(0, Math.max(CP.vp - w, CP.tx));
  CP.ty = Math.min(0, Math.max(CP.vp - h, CP.ty));
}
function cpDraw() {
  const c = $('#crop-canvas'); if (!c || !CP.img) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, CP.vp, CP.vp);
  g.drawImage(CP.img, CP.tx, CP.ty, CP.iw * CP.scale, CP.ih * CP.scale);
}
function cpSyncZoom() {
  const z = Math.round(CP.scale / CP.base * 100);
  const r = $('#crop-zoom'); if (r) r.value = String(Math.min(400, Math.max(100, z)));
  const l = $('#crop-zoom-l'); if (l) l.textContent = (CP.scale / CP.base).toFixed(1) + 'x';
}
function cpZoomTo(scale) {
  const cx = (CP.vp / 2 - CP.tx) / CP.scale, cy = (CP.vp / 2 - CP.ty) / CP.scale;
  CP.scale = Math.min(CP.max, Math.max(CP.min, scale));
  CP.tx = CP.vp / 2 - cx * CP.scale;
  CP.ty = CP.vp / 2 - cy * CP.scale;
  cpClamp(); cpSyncZoom(); cpDraw();
}
function cpConfirm() {
  if (!CP.img) return;
  const out = 512, k = out / CP.vp;
  const c = document.createElement('canvas'); c.width = out; c.height = out;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, out, out);
  g.drawImage(CP.img, CP.tx * k, CP.ty * k, CP.iw * CP.scale * k, CP.ih * CP.scale * k);
  let data = '';
  try { data = c.toDataURL('image/jpeg', 0.9); }
  catch (e) { return toast('裁剪失败：' + errMsg(e)); }
  CONFIG.avatarUrl = data;
  sSet('via_ai_config', CONFIG);
  const inp = $('#set-avatar'); if (inp) inp.value = AV_LOCAL;
  applyTheme();
  $('#crop-modal').classList.remove('open');
  toast('头像已更新~');
}
function bindCrop() {
  const stage = $('#crop-modal .crop-stage');
  const rect = () => stage.getBoundingClientRect();
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      CP.drag = true; CP.lx = e.touches[0].clientX; CP.ly = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      CP.drag = false;
      CP.pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      CP.pscale = CP.scale;
    }
    e.preventDefault();
  }, { passive: false });
  stage.addEventListener('touchmove', (e) => {
    const r = rect();
    if (e.touches.length === 1 && CP.drag) {
      const t = e.touches[0];
      CP.tx += (t.clientX - CP.lx) * (CP.vp / r.width);
      CP.ty += (t.clientY - CP.ly) * (CP.vp / r.height);
      CP.lx = t.clientX; CP.ly = t.clientY;
      cpClamp(); cpDraw();
    } else if (e.touches.length === 2 && CP.pinch) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      cpZoomTo(CP.pscale * (d / CP.pinch));
    }
    e.preventDefault();
  }, { passive: false });
  const end = () => { CP.drag = false; CP.pinch = 0; };
  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', end);
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    CP.drag = true; CP.lx = e.clientX; CP.ly = e.clientY; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!CP.drag || !$('#crop-modal').classList.contains('open')) return;
    const r = rect();
    CP.tx += (e.clientX - CP.lx) * (CP.vp / r.width);
    CP.ty += (e.clientY - CP.ly) * (CP.vp / r.height);
    CP.lx = e.clientX; CP.ly = e.clientY;
    cpClamp(); cpDraw();
  });
  document.addEventListener('mouseup', () => { CP.drag = false; });
  $('#crop-zoom').oninput = () => cpZoomTo(CP.base * (parseInt($('#crop-zoom').value, 10) / 100));
  $('#crop-ok').onclick = cpConfirm;
  $('#crop-cancel').onclick = () => $('#crop-modal').classList.remove('open');
  $('#crop-modal').onclick = (e) => { if (e.target === $('#crop-modal')) $('#crop-modal').classList.remove('open'); };
}

/* ==========================================================
 *  输入框的「＋」：把图片 / 文件递给她看
 * ========================================================== */
let PICK_MODE = 'avatar';       // avatar = 裁头像；chat = 发给对话
let pendingAttachment = null;   // { kind:'image'|'text'|'file', ... }

function setAttachment(a) { pendingAttachment = a; renderAttach(); }
function clearAttachment() { pendingAttachment = null; renderAttach(); }
function renderAttach() {
  const bar = $('#attach-bar');
  if (!bar) return;
  const a = pendingAttachment;
  if (!a) { bar.hidden = true; bar.classList.remove('has-img'); return; }
  bar.hidden = false;
  const thumb = $('#attach-thumb');
  if (a.kind === 'image' && a.dataUrl) {
    bar.classList.add('has-img');
    if (thumb) thumb.src = a.dataUrl;
  } else {
    bar.classList.remove('has-img');
    if (thumb) thumb.removeAttribute('src');
  }
  const info = $('#attach-info');
  if (!info) return;
  if (a.kind === 'image') info.textContent = '图片 · 发送后她会看图';
  else if (a.kind === 'text') info.textContent = '文件 ' + a.name + ' · 约 ' + (a.text || '').length + ' 字' + (a.note ? ' · ' + a.note : '');
  else info.textContent = '文件 ' + a.name + ' · 读不出正文，只带文件名';
}

function startPickAttachment(which) {
  if (!HAS_NATIVE || !Android.pickImage) { toast('当前环境打不开系统选择器'); return; }
  PICK_MODE = 'chat';
  try {
    if (which === 'file') {
      if (Android.pickFile) Android.pickFile();
      else { PICK_MODE = 'avatar'; toast('这一版还不支持传文件~'); }
    } else {
      Android.pickImage();
    }
  } catch (e) { PICK_MODE = 'avatar'; toast('打开失败：' + errMsg(e)); }
}

function startPickAvatar() {
  if (HAS_NATIVE && Android.pickImage) {
    PICK_MODE = 'avatar';
    toast('请选择一张图片~');
    try { Android.pickImage(); } catch (e) { toast('无法打开相册：' + errMsg(e)); }
  } else {
    toast('当前环境不支持系统相册');
  }
}
window.__imgPicked = function () {
  let data = '';
  try { if (HAS_NATIVE && Android.getPickedImage) data = Android.getPickedImage() || ''; } catch (e) {}
  if (!data) { toast('没有读到图片'); return; }
  if (PICK_MODE === 'chat') {
    PICK_MODE = 'avatar';
    setAttachment({ kind: 'image', dataUrl: data });
    toast('图片加上啦，点发送她就能看到~');
    vibrate(15);
    return;
  }
  openCropper(data);
};
window.__imgPickFailed = function () { PICK_MODE = 'avatar'; toast('图片读取失败，换一张试试~'); };

window.__filePicked = function () {
  const pluginMode = PICK_MODE === 'plugin';
  PICK_MODE = 'avatar';
  let raw = '';
  try { if (HAS_NATIVE && Android.getPickedFile) raw = Android.getPickedFile() || ''; } catch (e) {}
  let f = null;
  try { f = JSON.parse(raw || '{}'); } catch (e) {}
  if (!f || !f.name) { pluginMode ? plugInstallError('没有读到文件。') : toast('没有读到文件'); return; }
  if (pluginMode) {
    if (!f.ok || !f.text) return plugInstallError('文件不是可读取的文本 JSON。');
    $('#plug-modal').classList.add('open');
    setPlugImportMode('file');
    return plugInstallFromText(f.text);
  }
  if (f.ok && f.text) {
    // G7-1：docx/xlsx/pptx/epub/pdf/zip 都由原生解析成正文，统一当文本附件发给模型
    const kindLabel = ({ docx: 'Word', xlsx: '表格', pptx: '幻灯片', epub: '电子书', pdf: 'PDF', zip: '压缩包', text: '文本' })[f.kind] || '';
    setAttachment({
      kind: 'text', name: f.name, text: f.text,
      source: f.kind || '', chars: f.chars || String(f.text).length, note: f.note || ''
    });
    let tip = '文件加上啦~';
    if (kindLabel) tip = kindLabel + '已解析 ' + (f.chars || String(f.text).length) + ' 字~';
    if (f.note) tip += '（' + f.note + '）';
    toast(tip);
  } else {
    setAttachment({ kind: 'file', name: f.name, size: f.size || 0, note: f.note || '' });
    toast(f.note || '这个格式读不出正文，只能带上文件名了~');
  }
  vibrate(15);
};
window.__filePickFailed = function () { PICK_MODE = 'avatar'; toast('文件读取失败，换一个试试~'); };

/* ==========================================================
 *  窗口等比缩放
 *
 *  关键约定（以前就是这里没对齐，才有「看得见却点不到」的问题）：
 *    BASE  = 布局基准尺寸，**恒定不变**。页面永远按 BASE 排版，再整体 scale。
 *    ZOOM  = ZOOM = 窗口宽 / BASE 宽  —— 由原生实际生效的矩形反推。
 *  于是「看得见的像素」和「吃触摸的像素」在数学上恒等，
 *  不依赖 dpr / screen.width / 取整方式这些各家不一的参数。
 * ========================================================== */
let BASE = null;   // 布局基准（css 像素），一直不变
let ZOOM = 1;      // 当前缩放比
let activeResize = null;

/** 设备像素比。个别老 WebView 会给出 0/undefined，得有个靠谱的退路。 */
function dpr() {
  const d = window.devicePixelRatio;
  if (d && d > 0) return d;
  return 1;
}

function readRect() {
  if (!(HAS_PERM && Perm.getWindowRect)) return null;
  try { return JSON.parse(Perm.getWindowRect()); } catch (e) { return null; }
}

/** 窗口尺寸上下限（物理像素），直接从原生拿 —— 不再猜 window.screen。 */
function readLimits() {
  if (!(HAS_PERM && Perm.getWindowLimits)) return null;
  try { return JSON.parse(Perm.getWindowLimits()); } catch (e) { return null; }
}

function applyZoom() {
  const app = $('#app');
  if (!app || !BASE) return;
  app.style.position = 'absolute';
  app.style.top = '0';
  app.style.left = '0';
  app.style.width = BASE.w + 'px';
  app.style.height = BASE.h + 'px';
  app.style.transformOrigin = 'top left';
  app.style.transform = Math.abs(ZOOM - 1) < 0.001 ? '' : 'scale(' + ZOOM + ')';
}

/** 按原生回传的矩形校正缩放比（这是唯一的事实来源）。 */
function applyRectToZoom(r) {
  if (!r || !r.w || !r.bw) return false;
  const d = dpr();
  // 物理像素 → css 像素（布局基准恒定，页面永远按它排版再整体缩放）
  BASE = { w: r.bw / d, h: (r.bh || r.bw) / d };
  ZOOM = r.w / r.bw;
  applyZoom();
  return true;
}

function initZoom() {
  const r = readRect();
  if (!r || !r.w || !r.bw) return;
  applyRectToZoom(r);
  reconcile(true);
}

/**
 * 面板和窗口脱节了就拉回来。
 * 正常路径下两边应该分毫不差，这个只当保险，所以平时几乎不消耗。
 */
function reconcile(force) {
  const app = $('#app');
  if (!app || !BASE || activeResize) return;
  const r = readRect();
  if (!r || !r.w || !r.bw) return;
  const d = dpr();
  const box = app.getBoundingClientRect();
  const wantW = Math.round(box.width * d);
  const wantH = Math.round(box.height * d);
  const off = Math.abs(wantW - r.w) + Math.abs(wantH - r.h);
  if (!force && off <= 3) return;
  applyRectToZoom(r);
}

/* 原生改了窗口矩形（拖拽、恢复展开、系统旋转）会主动叫一声 */
window.__onWinRect = function (r) {
  if (activeResize) return;
  applyRectToZoom(r);
};

function bindResize() {
  if (!(HAS_PERM && Perm.setWindowRect && Perm.getWindowRect)) return;
  const handles = $$('#app .rz');
  let sx = 0, sy = 0, rect0 = null;

  const down = (dir, x, y) => {
    if (!BASE) initZoom();
    rect0 = readRect();
    if (!rect0 || !rect0.w) { rect0 = null; return; }
    activeResize = dir; sx = x; sy = y;
  };

  const move = (x, y) => {
    if (!activeResize || !rect0) return;
    const d = dpr();
    const dx = (x - sx) * d, dy = (y - sy) * d;
    const hasE = activeResize.indexOf('e') >= 0, hasW = activeResize.indexOf('w') >= 0;
    const hasS = activeResize.indexOf('s') >= 0, hasN = activeResize.indexOf('n') >= 0;
    const tw = rect0.w + (hasE ? dx : 0) - (hasW ? dx : 0);
    const th = rect0.h + (hasS ? dy : 0) - (hasN ? dy : 0);

    // 只算一个比例 k：宽高和内容一起按 k 变，
    // 所以是「整体等比缩小」而不是「变窄把内容挤没了」。
    let k;
    if ((hasE || hasW) && (hasS || hasN)) k = Math.abs(dx) > Math.abs(dy) ? tw / rect0.w : th / rect0.h;
    else if (hasE || hasW) k = tw / rect0.w;
    else k = th / rect0.h;

    // 上下限按原生的口径先夹好，这样原生的 coerce 永远不会真的生效，
    // 宽高比就不会被压歪，也不会凭空多出一条透明死区。
    const lim = readLimits() || {};
    const kMin = Math.max((lim.minW || 1) / rect0.w, (lim.minH || 1) / rect0.h);
    const kMax = Math.max(kMin, Math.min(
      (lim.maxW || 1e9) / rect0.w,
      (lim.maxH || 1e9) / rect0.h
    ));
    k = Math.max(kMin, Math.min(k, kMax));

    const nw = Math.round(rect0.w * k);
    const nh = Math.round(rect0.h * k);
    let rx = rect0.x, ry = rect0.y;
    if (hasW) rx = rect0.x + rect0.w - nw;   // 拖左边：右边缘固定
    if (hasN) ry = rect0.y + rect0.h - nh;   // 拖上边：下边缘固定

    // 先本地渲染，手感才跟手；再请求窗口对齐。
    if (BASE) { ZOOM = nw / (BASE.w * d); applyZoom(); }
    let applied = null;
    try { applied = JSON.parse(Perm.setWindowRect(rx, ry, nw, nh)); } catch (e) {}
    // 原生真夹了的话（机型差异），就用它的口径覆盖，绝不留死区。
    // 没夹就不要再写一遍样式，白费一帧。
    if (applied && applied.w && applied.bw) {
      const z2 = applied.w / applied.bw;
      if (Math.abs(z2 - ZOOM) > 0.0005) applyRectToZoom(applied);
    }
  };

  const up = () => {
    if (!activeResize) return;
    activeResize = null; rect0 = null;
    reconcile(true);
  };

  handles.forEach((h) => {
    const dir = h.dataset.dir;
    h.addEventListener('touchstart', (e) => { const t = e.touches[0]; down(dir, t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
    h.addEventListener('mousedown', (e) => { if (e.button === 0) { down(dir, e.clientX, e.clientY); e.preventDefault(); } });
  });
  document.addEventListener('touchmove', (e) => { if (activeResize) { const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  document.addEventListener('mousemove', (e) => { if (activeResize) move(e.clientX, e.clientY); });
  document.addEventListener('touchend', up);
  document.addEventListener('touchcancel', up);
  document.addEventListener('mouseup', up);
}

