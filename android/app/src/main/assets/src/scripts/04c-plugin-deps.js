/* ==========================================================
 *  E5 插件依赖与运行时（0.12）
 *
 *  宿主只做四件事：
 *    1. 按清单校验依赖声明（HTTPS + SHA-256 必填）；
 *    2. 通过原生 DependencyRuntime 下载/校验/安装/卸载/回滚；
 *    3. 通过 Termux 固定命令模板检测/安装 termux-pkg 与 npm；
 *    4. 把缺失原因、体积、许可证、进度和日志摊给用户看。
 *
 *  安全边界：
 *    - 插件不能传任意 shell，只能选固定操作与白名单包名；
 *    - 没有 SHA-256 的下载类依赖一律不装；
 *    - APK 依赖只能交给系统安装器，绝不静默安装；
 *    - 所有安装/卸载都要用户确认。
 * ========================================================== */

const PLUG_DEP_CACHE_KEY = 'via_ai_plugin_dep_cache';
const PLUG_DEP_LOG_KEY = 'via_ai_plugin_dep_log';
const PLUG_DEP_LOG_MAX = 60;
const PLUG_DEP_KIND_LABEL = {
  'termux-pkg': 'Termux 包',
  'npm': 'npm 包',
  'archive': '压缩包',
  'binary': '可执行文件',
  'apk': 'APK'
};

function plugDepNative(name) {
  return HAS_PERM && typeof Perm[name] === 'function' ? Perm : null;
}
function plugDepJson(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : (fallback || null);
  } catch (e) { return fallback || null; }
}
function plugDepCacheAll() {
  const all = sGet(PLUG_DEP_CACHE_KEY, {});
  return plugPlainObject(all) ? all : {};
}
function plugDepCacheSet(pluginId, deps) {
  const all = plugDepCacheAll();
  all[String(pluginId)] = plugPlainObject(deps) ? deps : {};
  sSet(PLUG_DEP_CACHE_KEY, all);
}
/** 已安装表：优先问原生，原生不可用时退回上次缓存（只用于展示）。 */
function plugDepInstalledMap(pluginId) {
  const native = plugDepNative('getDependencyState');
  if (native) {
    const r = plugDepJson(native.getDependencyState(String(pluginId)), null);
    if (r && r.ok && plugPlainObject(r.deps)) {
      plugDepCacheSet(pluginId, r.deps);
      return r.deps;
    }
  }
  return plugPlainObject(plugDepCacheAll()[String(pluginId)]) ? plugDepCacheAll()[String(pluginId)] : {};
}
function plugDepStateOf(plugin, dep) {
  if (!plugin || !dep) return 'missing';
  const entry = plugDepInstalledMap(plugin.id)[dep.id];
  if (!entry) return 'missing';
  if (String(entry.version || '') !== String(dep.version || '')) return 'outdated';
  if (dep.sha256 && String(entry.sha256 || '').toLowerCase() !== String(dep.sha256).toLowerCase()) return 'outdated';
  return 'installed';
}
function plugDepStatusText(state) {
  return ({ installed: '已安装', outdated: '版本不符', missing: '未安装' })[state] || '未知';
}
function plugDepHumanSize(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '体积未知';
  if (v >= 1048576) return (Math.round(v / 1048576 * 10) / 10) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}
function plugDepAccess(plugin) {
  if (!plugin) return '插件不存在';
  if (plugStateOf(plugin) === 'disabled') return '插件已停用';
  if (!plugPermissionGranted(plugin, 'dependencies.manage')) return '未获准 dependencies.manage';
  return '';
}
function plugDepFind(plugin, depId) {
  return (plugin && Array.isArray(plugin.dependencies) ? plugin.dependencies : []).filter(d => d.id === String(depId))[0] || null;
}
/** 安装顺序：termux-pkg → npm → binary → archive → apk，再按声明顺序。 */
const PLUG_DEP_ORDER = { 'termux-pkg': 0, 'npm': 1, 'binary': 2, 'archive': 3, 'apk': 4 };
function plugDepPlan(plugin) {
  const deps = Array.isArray(plugin && plugin.dependencies) ? plugin.dependencies : [];
  return deps.map((d, i) => ({ dep: d, i, state: plugDepStateOf(plugin, d) }))
    .sort((a, b) => {
      const oa = PLUG_DEP_ORDER[a.dep.kind], ob = PLUG_DEP_ORDER[b.dep.kind];
      return ((oa === undefined ? 9 : oa) - (ob === undefined ? 9 : ob)) || (a.i - b.i);
    });
}
function plugDepMissing(plugin) {
  return plugDepPlan(plugin).filter(x => x.state !== 'installed').map(x => x.dep);
}

function plugDepLogAll() {
  const all = sGet(PLUG_DEP_LOG_KEY, {});
  return plugPlainObject(all) ? all : {};
}
function plugDepAppendLog(pluginId, line) {
  const all = plugDepLogAll();
  const key = String(pluginId || '');
  const list = Array.isArray(all[key]) ? all[key] : [];
  list.push({ at: new Date().toISOString(), text: String(line || '').slice(0, 300) });
  while (list.length > PLUG_DEP_LOG_MAX) list.shift();
  all[key] = list;
  sSet(PLUG_DEP_LOG_KEY, all);
}
function plugDepLogText(pluginId) {
  const list = plugDepLogAll()[String(pluginId || '')] || [];
  return list.map(x => '[' + String(x.at || '').slice(11, 19) + '] ' + x.text).join('\n');
}

/** 在插件页里轮询 Termux 固定任务；超时自动取消。 */
async function plugDepWaitTermux(runId, pluginId, timeoutMs) {
  const started = Date.now();
  let offset = 0;
  while (Date.now() - started < (timeoutMs || 600000)) {
    await new Promise(r => setTimeout(r, 1200));
    const st = plugDepJson(Perm.getTermuxJobStatus ? Perm.getTermuxJobStatus(runId) : '{}', {});
    const out = plugDepJson(Perm.readTermuxJobOutput ? Perm.readTermuxJobOutput(runId, offset) : '{}', {});
    if (out && out.output) {
      offset = Number(out.nextOffset) || offset;
      String(out.output).split(/\r?\n/).filter(Boolean).slice(-20)
        .forEach(line => plugDepAppendLog(pluginId, '· ' + line));
    }
    if (!st || !st.ok) continue;
    if (st.status === 'done') return { ok: true, exitCode: st.exitCode };
    if (st.status === 'failed') return { ok: false, error: '安装命令退出码 ' + st.exitCode };
  }
  try { if (Perm.cancelTermuxJob) Perm.cancelTermuxJob(runId); } catch (e) {}
  return { ok: false, error: '安装超时，已取消' };
}
function plugDepTermuxInfo() {
  if (!HAS_PERM || typeof Perm.getTermuxWorkerState !== 'function') return { installed: false, bridge: false };
  const s = plugDepJson(Perm.getTermuxWorkerState(), {});
  return { installed: s.installed === true, bridge: true };
}
function plugDepTermuxGuide() {
  return '需要先安装 Termux，并在 Termux 里执行：\n' +
    'pkg install -y termux-am\n' +
    'echo allow-external-apps=true >> ~/.termux/termux.properties\n' +
    '（然后重启 Termux）。\n' +
    '如果一键安装仍提示「未获得 Termux 命令执行权限」，请先确认 Termux 已安装，' +
    '再卸载重装本应用（权限只在安装时授予）。\n' +
    '本应用只使用固定命令模板，不会传任意 shell。';
}

/** 安装单个依赖：下载类走原生，包管理器类走 Termux 固定模板。 */
async function plugDepInstall(plugin, depId, opts) {
  opts = opts || {};
  const dep = plugDepFind(plugin, depId);
  if (!dep) return { ok: false, error: '依赖不存在：' + String(depId) };
  const denied = plugDepAccess(plugin);
  if (denied) return { ok: false, error: denied };
  if (plugDepStateOf(plugin, dep) === 'installed' && !opts.force) return { ok: true, already: true };

  const need = PLUG_DEP_HASH_KINDS.indexOf(dep.kind) >= 0;
  if (need && (!plugDepIsHttps(dep.source) || !PLUG_SHA256_RE.test(dep.sha256 || ''))) {
    return { ok: false, error: '下载类依赖必须使用 HTTPS 且提供 SHA-256；清单不完整，拒绝安装' };
  }
  if (!opts.confirmed) {
    const text = '安装依赖「' + dep.id + '」' + dep.version + '\n' +
      '类型：' + (PLUG_DEP_KIND_LABEL[dep.kind] || dep.kind) + '\n' +
      '来源：' + dep.source + '\n' +
      '体积：' + plugDepHumanSize(dep.size) + '\n' +
      '许可证：' + (dep.license || '未标注') + '\n' +
      (dep.why ? '用途：' + dep.why + '\n' : '') +
      (need ? '安装前会校验 SHA-256；校验失败会删除临时文件并中止。\n' : '使用 Termux/npm 自带的完整性校验。\n') +
      (dep.kind === 'apk' ? 'APK 只会交给系统安装器，仍需你在系统界面确认。\n' : '') +
      '是否继续？';
    if (!(await uiConfirm(text, '安装依赖', '依赖安装'))) return { ok: false, error: '用户取消' };
  }
  plugDepAppendLog(plugin.id, '准备安装 ' + dep.id + ' ' + dep.version);

  if (dep.kind === 'apk') {
    const r = await plugDepInstallNative(plugin, dep);
    if (!r.ok || !r.needsUserInstall) return r;
    if (!(await uiConfirm('APK 依赖已下载并通过 SHA-256 校验：' + (r.fileName || dep.id) + '\n接下来会打开系统安装界面，需要你手动确认。', '打开系统安装器', 'APK 依赖'))) {
      return { ok: false, error: '用户取消系统安装' };
    }
    const launched = plugDepJson(Perm.installDependencyApk ? Perm.installDependencyApk(String(r.fileName || '')) : '{}', {});
    plugDepAudit(plugin, 'dep_apk_install', dep.id);
    return launched && launched.ok ? { ok: true, needsUserInstall: true } : { ok: false, error: (launched && launched.error) || '系统安装器未启动' };
  }
  if (need) return await plugDepInstallNative(plugin, dep);

  // termux-pkg / npm
  const tx = plugDepTermuxInfo();
  if (!tx.installed) return { ok: false, error: 'Termux 未安装。\n' + plugDepTermuxGuide() };
  if (typeof Perm.runTermuxFixed !== 'function') return { ok: false, error: '当前原生桥不支持固定 Termux 依赖安装' };
  const req = {
    op: 'install', kind: dep.kind, name: dep.source,
    version: dep.version, bin: dep.bin || ''
  };
  plugDepAppendLog(plugin.id, 'Termux 安装 ' + dep.source + '@' + dep.version);
  let run;
  try { run = plugDepJson(Perm.runTermuxFixed(JSON.stringify(req)), {}); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
  if (!run || !run.ok || !run.runId) return { ok: false, error: (run && run.error) || 'Termux 未接受安装任务' };
  const done = await plugDepWaitTermux(run.runId, plugin.id);
  if (!done.ok) {
    plugDepAppendLog(plugin.id, '安装失败：' + done.error);
    plugDepAudit(plugin, 'dep_install_fail', dep.id);
    return done;
  }
  const rec = plugDepJson(Perm.recordDependency ? Perm.recordDependency(String(plugin.id), JSON.stringify(dep)) : '{}', {});
  if (!rec || !rec.ok) return { ok: false, error: (rec && rec.error) || '依赖记录写入失败' };
  plugDepAppendLog(plugin.id, '安装完成：' + dep.id);
  plugDepAudit(plugin, 'dep_install', dep.id);
  plugDepCacheSet(plugin.id, plugDepInstalledMap(plugin.id));
  return { ok: true };
}
async function plugDepInstallNative(plugin, dep) {
  if (typeof Perm.installDependency !== 'function') return { ok: false, error: '当前原生桥不支持依赖下载' };
  let r;
  try { r = plugDepJson(Perm.installDependency(String(plugin.id), JSON.stringify(dep)), {}); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
  if (r && r.ok) {
    plugDepAppendLog(plugin.id, '校验并装好：' + dep.id + (r.needsUserInstall ? '（待系统安装）' : ''));
    plugDepCacheSet(plugin.id, plugDepInstalledMap(plugin.id));
    plugDepAudit(plugin, 'dep_install', dep.id);
    return r;
  }
  plugDepAppendLog(plugin.id, '安装失败：' + ((r && (r.error || r.errorCode)) || '未知错误'));
  plugDepAudit(plugin, 'dep_install_fail', dep.id);
  return { ok: false, error: (r && (r.error || r.errorCode)) || '依赖安装失败' };
}
async function plugDepInstallAll(plugin) {
  const missing = plugDepMissing(plugin);
  if (!missing.length) return { ok: true, count: 0 };
  const denied = plugDepAccess(plugin);
  if (denied) return { ok: false, error: denied };
  const text = '将按顺序安装 ' + missing.length + ' 项缺失依赖：\n' +
    missing.map(d => '· ' + d.id + ' ' + d.version + '（' + (PLUG_DEP_KIND_LABEL[d.kind] || d.kind) + '，' + plugDepHumanSize(d.size) + '）').join('\n') +
    '\n\n下载类依赖会校验 SHA-256；APK 仍需系统安装器确认。';
  if (!(await uiConfirm(text, '安装全部', '依赖安装'))) return { ok: false, error: '用户取消' };
  let ok = 0, lastError = '';
  for (const dep of missing) {
    const r = await plugDepInstall(plugin, dep.id, { confirmed: true, force: true });
    if (r.ok) ok++;
    else { lastError = r.error || '安装失败'; break; }
  }
  return { ok: ok === missing.length, installed: ok, error: lastError };
}

async function plugDepUninstall(plugin, depId, opts) {
  const dep = plugDepFind(plugin, depId);
  if (!dep) return { ok: false, error: '依赖不存在' };
  const denied = plugDepAccess(plugin);
  if (denied) return { ok: false, error: denied };
  if (!opts || !opts.confirmed) {
    if (!(await uiConfirm('卸载依赖「' + dep.id + ' ' + dep.version + '」？\n只删除插件沙箱里的这一份，不动系统目录。', '卸载依赖', '依赖卸载'))) {
      return { ok: false, error: '用户取消' };
    }
  }
  if (typeof Perm.removeDependency !== 'function') return { ok: false, error: '当前原生桥不支持依赖卸载' };
  let r;
  try { r = plugDepJson(Perm.removeDependency(String(plugin.id), String(dep.id)), {}); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
  plugDepAppendLog(plugin.id, (r && r.ok ? '已卸载 ' : '卸载失败 ') + dep.id);
  if (r && r.ok) {
    const cache = plugDepInstalledMap(plugin.id);
    delete cache[dep.id];
    plugDepCacheSet(plugin.id, cache);
    plugDepAudit(plugin, 'dep_remove', dep.id);
  }
  return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '卸载失败' };
}
/** 逆序卸载：先卸声明里靠后的（通常是被依赖方）。 */
async function plugDepUninstallAll(plugin) {
  const installed = plugDepPlan(plugin).filter(x => x.state === 'installed').map(x => x.dep).reverse();
  if (!installed.length) return { ok: true, count: 0 };
  if (!(await uiConfirm('卸载「' + plugin.name + '」的全部 ' + installed.length + ' 项依赖？\n按逆序删除：' +
    installed.map(d => d.id).join(' → ') + '\n插件配置与会话不会被删除。', '全部卸载', '依赖卸载'))) {
    return { ok: false, error: '用户取消' };
  }
  let ok = 0;
  for (const dep of installed) {
    const r = await plugDepUninstall(plugin, dep.id, { confirmed: true });
    if (!r.ok) return { ok: false, installed: ok, error: r.error };
    ok++;
  }
  return { ok: true, installed: ok };
}

async function plugDepVerify(plugin, depId) {
  const dep = plugDepFind(plugin, depId);
  if (!dep) return { ok: false, error: '依赖不存在' };
  if (typeof Perm.verifyDependency !== 'function') return { ok: false, error: '当前原生桥不支持依赖校验' };
  let r;
  try { r = plugDepJson(Perm.verifyDependency(String(plugin.id), String(dep.id)), {}); }
  catch (e) { return { ok: false, error: errMsg(e) }; }
  plugDepAppendLog(plugin.id, (r && r.ok && r.verified ? '校验通过 ' : '校验未通过 ') + dep.id + (r && r.reason ? '：' + r.reason : ''));
  return r || { ok: false, error: '校验失败' };
}
function plugDepAudit(plugin, event, depId) {
  try { plugAudit(event, plugin, { tool: String(depId || '') }); } catch (e) {}
}

/** 插件页里的依赖面板（mode === 'deps'）。 */
function plugDepPanelHtml(plugin) {
  if (!plugin) return '<div class="mini-note">插件已不存在。</div>';
  const plan = plugDepPlan(plugin);
  const log = plugDepLogText(plugin.id);
  let html = '<div class="mini-note">依赖来自插件清单，宿主逐项校验 HTTPS + SHA-256。' +
    '没有哈希的下载一律拒绝；APK 只交给系统安装器；卸载按逆序删除，不动系统目录。</div>';
  if (!plan.length) {
    return html + '<div class="mini-note" style="margin-top:10px">这个插件没有声明依赖。</div>';
  }
  html += '<div class="pc-actions" style="margin-top:10px">' +
    '<button type="button" class="pc-btn pc-primary" data-dep-all="install"' + (plugDepAccess(plugin) ? ' disabled' : '') + '>安装全部缺失</button>' +
    '<button type="button" class="pc-btn pc-mini" data-dep-all="remove"' + (plugDepAccess(plugin) ? ' disabled' : '') + '>全部卸载</button>' +
    '</div>';
  html += plan.map(({ dep, state }) => {
    const ok = state === 'installed';
    const badge = '<span class="pc-badge' + (ok ? ' pc-badge-ok' : '') + '">' + plugEsc(plugDepStatusText(state)) + '</span>';
    const meta = [
      PLUG_DEP_KIND_LABEL[dep.kind] || dep.kind,
      dep.version,
      plugDepHumanSize(dep.size),
      dep.license ? '许可证 ' + dep.license : '许可证未标注'
    ].join(' · ');
    const src = dep.kind === 'termux-pkg' || dep.kind === 'npm' ? dep.source : dep.source;
    return '<div class="pc pc-row-item pc-dep-row">' +
      '<div class="pc-row-main">' +
      '<div class="pc-row-t">' + plugEsc(dep.id) + ' ' + badge + '</div>' +
      '<div class="pc-row-d">' + plugEsc(meta) + '</div>' +
      (dep.why ? '<div class="pc-row-d">' + plugEsc(dep.why) + '</div>' : '') +
      '<div class="pc-row-d pc-muted" style="word-break:break-all">来源：' + plugEsc(src) + '</div>' +
      (dep.sha256 ? '<div class="pc-row-d pc-muted" style="word-break:break-all">SHA-256：' + plugEsc(dep.sha256) + '</div>' : '<div class="pc-row-d pc-muted">包管理器自带完整性校验</div>') +
      '</div>' +
      '<div class="pc-actions">' +
      '<button type="button" class="pc-btn pc-mini" data-dep-install="' + plugEsc(dep.id) + '"' + (plugDepAccess(plugin) ? ' disabled' : '') + '>' + (ok ? '重装' : '安装') + '</button>' +
      '<button type="button" class="pc-btn pc-mini" data-dep-verify="' + plugEsc(dep.id) + '"' + (ok ? '' : ' disabled') + '>校验</button>' +
      '<button type="button" class="pc-btn pc-mini" data-dep-remove="' + plugEsc(dep.id) + '"' + (ok ? '' : ' disabled') + '>卸载</button>' +
      '</div></div>';
  }).join('');
  html += '<div class="pc-title" style="margin-top:12px">安装日志</div>' +
    '<pre id="dep-log" class="dep-log">' + plugEsc(log || '（还没有日志）') + '</pre>';
  return html;
}
function plugDepRefreshPanel() {
  if (typeof plugRenderPage === 'function' && PLUG_PAGE_CTX.mode === 'deps') { try { plugRenderPage(); } catch (e) {} }
}
async function plugDepHandleUi(el) {
  if (!el || !el.dataset) return false;
  const plugin = USER_PLUGINS.filter(p => p.id === PLUG_PAGE_CTX.pluginId)[0];
  if (!plugin) return false;
  if (el.dataset.depAll) {
    const r = el.dataset.depAll === 'install'
      ? await plugDepInstallAll(plugin)
      : await plugDepUninstallAll(plugin);
    if (!r.ok) toast(r.error || '操作失败');
    else toast(el.dataset.depAll === 'install' ? '依赖已处理' : '依赖已卸载');
    plugDepRefreshPanel();
    return true;
  }
  if (el.dataset.depInstall) {
    const r = await plugDepInstall(plugin, el.dataset.depInstall);
    toast(r.ok ? '依赖已安装' : (r.error || '安装失败'));
    plugDepRefreshPanel();
    return true;
  }
  if (el.dataset.depRemove) {
    const r = await plugDepUninstall(plugin, el.dataset.depRemove);
    toast(r.ok ? '依赖已卸载' : (r.error || '卸载失败'));
    plugDepRefreshPanel();
    return true;
  }
  if (el.dataset.depVerify) {
    const r = await plugDepVerify(plugin, el.dataset.depVerify);
    toast(r.ok && r.verified ? '校验通过' : ((r && (r.reason || r.error)) || '校验未通过'));
    plugDepRefreshPanel();
    return true;
  }
  return false;
}
function plugDepOpen(pid) {
  const plugin = USER_PLUGINS.filter(p => p.id === String(pid))[0];
  if (!plugin) { toast('插件不存在'); return; }
  PLUG_PAGE_CTX = { pluginId: plugin.id, surfaceId: '', mode: 'deps' };
  if (typeof showView === 'function') showView(PLUG_PAGE_VIEW, { noStack: true });
  if (typeof VIEW_STACK !== 'undefined' && VIEW_STACK[VIEW_STACK.length - 1] !== PLUG_PAGE_VIEW) VIEW_STACK.push(PLUG_PAGE_VIEW);
  plugRenderPage();
}
function plugDepCounts(plugin) {
  const plan = plugDepPlan(plugin);
  return { total: plan.length, installed: plan.filter(x => x.state === 'installed').length, missing: plan.filter(x => x.state !== 'installed').length };
}
