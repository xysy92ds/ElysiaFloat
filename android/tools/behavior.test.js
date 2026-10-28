/*
 * 行为测试 —— 在假 DOM 里跑真实脚本，验证「跨任务历史隔离」等行为契约。
 *
 *   node tools/behavior.test.js
 *
 * 与 smoke.js 共用 tools/harness.js；smoke 查「能不能跑」，这里查「跑起来后语义对不对」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { T, store, vaultStore } = require('./harness');

const SRC = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'src');
const errors = [];

function step(name, fn) {
  if (!T) { errors.push(name + ': 拿不到内部符号 __T'); return; }
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    errors.push(name + ': ' + e.message);
  }
}
function json(key) { return JSON.parse(store.get(key) || 'null'); }
function pushMsg(text) { T.getHistory().push({ role: 'user', content: String(text) }); }
function hasMsg(list, text) { return Array.isArray(list) && list.some(m => m && m.content === text); }

console.log('行为测试：');

step('主聊天：saveHistory 同时写任务上下文与全局历史', () => {
  const chat = T.taskEnsureChat();
  T.taskSetCurrent(chat.id);
  pushMsg('behavior-main');
  T.saveHistory();
  if (!hasMsg(json('via_ai_history'), 'behavior-main')) throw new Error('全局历史缺少主聊天消息');
  if (!hasMsg(json(T.taskHistoryKey(chat.id)), 'behavior-main')) throw new Error('任务历史缺少主聊天消息');
});

step('非聊天任务：只写任务历史，不污染全局历史', () => {
  const before = store.get('via_ai_history');
  const ws = T.taskAdd('workspace', '行为测试工作区', '');
  pushMsg('behavior-workspace');
  T.saveHistory();
  if (store.get('via_ai_history') !== before) throw new Error('非聊天任务写入了全局 via_ai_history');
  if (!hasMsg(json(T.taskHistoryKey(ws.id)), 'behavior-workspace')) throw new Error('工作区任务历史没有落盘');
});

step('切回主聊天：全局历史恢复，且不含工作区消息', () => {
  const chat = T.taskEnsureChat();
  T.taskSetCurrent(chat.id);
  const g = json('via_ai_history');
  if (!hasMsg(g, 'behavior-main')) throw new Error('切回聊天后主历史丢失');
  if (hasMsg(g, 'behavior-workspace')) throw new Error('工作区消息串进了主聊天');
});

step('源码里不再有未加保护的全局历史写入（N4-002 回归）', () => {
  const files = fs.readdirSync(path.join(SRC, 'scripts')).filter(f => f.endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(SRC, 'scripts', f), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.trim() === "sSet('via_ai_history', history);" && f !== '06-ui-render.js') {
        bad.push(f + ':' + (i + 1));
      }
    });
  }
  if (bad.length) throw new Error('仍有未保护的全局历史写入：' + bad.join(', '));
});

step('插件市场索引只剩 text-tools（N4-001 回归）', () => {
  const index = T.PLUGIN_MARKET_INDEX;
  if (!Array.isArray(index) || index.length !== 1) throw new Error('市场索引条目数应为 1，实际 ' + (index && index.length));
  if (index[0].id !== 'com.elly.market.text-tools') throw new Error('唯一示例不是 text-tools');
  const raw = JSON.stringify(index);
  if (/minecraft|termux/i.test(raw)) throw new Error('市场索引仍含 Minecraft / Termux 条目');
});

step('迁移基线已删除，且构建工具不再支持 --verify-migration', () => {
  if (fs.existsSync(path.join(SRC, '.migration-baseline.sha256'))) throw new Error('旧迁移基线仍在');
  const build = fs.readFileSync(path.join(__dirname, 'build-html.js'), 'utf8');
  if (build.indexOf('--verify-migration') >= 0) throw new Error('build-html.js 仍支持 --verify-migration');
});

step('能力授权：同任务生效、撤销后失效、不跨任务', () => {
  if (!T.consentGranted('behavior-a', 'device')) {
    T.consentGrant('behavior-a', 'device');
  }
  if (!T.consentGranted('behavior-a', 'device')) throw new Error('授权后未生效');
  if (T.consentGranted('behavior-b', 'device')) throw new Error('授权串到了其它任务');
  T.consentRevokeTask('behavior-a');
  if (T.consentGranted('behavior-a', 'device')) throw new Error('撤销后仍生效');
});

step('密钥安全：Key 进密钥仓，普通配置不再存明文（E2-004）', () => {
  const cfg = { apiBase: 'https://example.invalid/v1', apiKey: 'test-key-123456' };
  if (T.secretHydrate(cfg, T.SECRET_FIELDS_CFG, 'ai') < 1) throw new Error('迁移没有写入密钥仓');
  if (vaultStore.get('ai.apiKey') !== 'test-key-123456') throw new Error('密钥仓没有拿到 Key');
  T.sSet('via_ai_config', cfg);
  const saved = store.get('via_ai_config') || '';
  if (saved.indexOf('apiKey') >= 0 || saved.indexOf('test-key-123456') >= 0) {
    throw new Error('明文 Key 仍写进了 via_ai_config');
  }
  const again = T.sGet('via_ai_config', {});
  if (again.apiKey) throw new Error('sGet 仍能读到明文 Key');
  const empty = {};
  if (T.secretHydrate(empty, T.SECRET_FIELDS_CFG, 'ai') < 1 || empty.apiKey !== 'test-key-123456') {
    throw new Error('重启后没有从密钥仓取回 Key');
  }
  cfg.apiKey = '';
  T.sSet('via_ai_config', cfg);
  if (vaultStore.has('ai.apiKey')) throw new Error('清空 Key 后密钥仓仍保留旧值');
});

step('密钥安全：向量 Key 走同一策略（E2-004）', () => {
  const cfg = { vecBase: 'https://example.invalid/v1', vecKey: 'vec-key-987654' };
  T.sSet('via_ai_mem_config', cfg);
  const saved = store.get('via_ai_mem_config') || '';
  if (saved.indexOf('vecKey') >= 0 || saved.indexOf('vec-key-987654') >= 0) {
    throw new Error('向量明文 Key 仍落盘');
  }
  if (vaultStore.get('mem.vecKey') !== 'vec-key-987654') throw new Error('向量 Key 没进密钥仓');
  const restore = {};
  if (T.secretHydrate(restore, T.SECRET_FIELDS_MEM, 'mem') < 1 || restore.vecKey !== 'vec-key-987654') {
    throw new Error('向量 Key 无法从密钥仓取回');
  }
});

step('模型中心：旧扁平配置迁移成固定 Provider 且可重复执行（E2-001）', () => {
  const cfg = T.CONFIG;
  const n = (cfg.providers || []).length;
  T.providerEnsure(cfg);
  T.providerEnsure(cfg);
  if ((cfg.providers || []).length !== n) throw new Error('迁移重复执行后 Provider 数量变化');
  const chat = T.providerResolve(cfg, 'chat');
  if (!chat || !chat.provider) throw new Error('聊天用途没有解析到 Provider');
  if (!cfg.bindings || !cfg.bindings.chat || cfg.bindings.chat.provider !== chat.provider.id) {
    throw new Error('聊天绑定缺失');
  }
  const ids = cfg.providers.map(p => p.id);
  if (ids.indexOf('legacy-chat') < 0) throw new Error('缺少 legacy-chat');
});

step('模型中心：新 Provider 的 Key 只进密钥仓，配置不含明文（E2-002/003）', () => {
  const cfg = T.CONFIG;
  const p = T.providerUpsert(cfg, {
    id: 'beh-custom', name: '行为测试', kind: 'openai',
    base: 'https://example.invalid/v1', model: 'beh-model',
    capabilities: ['chat', 'vision']
  }, 'provider-secret-abc');
  if (!p) throw new Error('新增 Provider 失败');
  T.sSet('via_ai_config', cfg);
  const saved = store.get('via_ai_config') || '';
  if (saved.indexOf('provider-secret-abc') >= 0) throw new Error('Provider Key 写进了普通配置');
  if (vaultStore.get('ai.provider.beh-custom') !== 'provider-secret-abc') throw new Error('Provider Key 未进密钥仓');
  const sum = T.providerSummary(cfg).filter(x => x.id === 'beh-custom')[0];
  if (!sum || !sum.hasKey) throw new Error('摘要没有识别到已保存的 Key');
  if (JSON.stringify(sum).indexOf('provider-secret-abc') >= 0) throw new Error('摘要泄露了明文 Key');
});

step('模型中心：绑定备用 Provider 不改请求层代码（E2-003）', () => {
  const cfg = T.CONFIG;
  if (!T.providerBind(cfg, 'chat', 'beh-custom')) throw new Error('绑定失败');
  if (cfg.apiBase !== 'https://example.invalid/v1' || cfg.model !== 'beh-model') {
    throw new Error('绑定后旧字段没有回填：' + cfg.apiBase + ' / ' + cfg.model);
  }
  if (cfg.apiKey !== 'provider-secret-abc') throw new Error('绑定后没有从密钥仓取回 Key');
  T.sSet('via_ai_config', cfg);
  const saved = JSON.parse(store.get('via_ai_config') || '{}');
  if (!saved.bindings || !saved.bindings.chat || saved.bindings.chat.provider !== 'beh-custom') {
    throw new Error('绑定没有持久化');
  }
  if (saved.apiKey) throw new Error('持久化配置仍含 Key');
});

step('模型中心：删除 Provider 会清理绑定与专属密钥（E2-001）', () => {
  const cfg = T.CONFIG;
  if (!T.providerRemove(cfg, 'beh-custom')) throw new Error('删除失败');
  if (T.providerResolve(cfg, 'chat') == null) throw new Error('删除后没有回退到可用 Provider');
  if (cfg.bindings && cfg.bindings.chat && cfg.bindings.chat.provider === 'beh-custom') {
    throw new Error('删除后仍指向已删 Provider');
  }
  if (vaultStore.has('ai.provider.beh-custom')) throw new Error('专属密钥没有清理');
});

step('用量与限额：按 Provider / 任务记账并持久化（E2-008）', () => {
  T.usageReset();
  T.usageRecord('legacy-chat', 'task-a', { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  T.usageRecord('legacy-chat', 'task-b', { input_tokens: 5, output_tokens: 5 });
  const u = T.usageSummary();
  if (u.calls !== 2) throw new Error('调用次数应为 2，实际 ' + u.calls);
  if (u.tokens.total !== 40) throw new Error('Token 合计应为 40，实际 ' + u.tokens.total);
  if (u.tokens.prompt !== 15 || u.tokens.completion !== 25) throw new Error('输入/输出拆分不对');
  if (u.byProvider.length !== 1 || u.byProvider[0].id !== 'legacy-chat') throw new Error('Provider 统计不对');
  if (u.byTask.length !== 2) throw new Error('任务统计不对');
  const saved = JSON.parse(store.get(T.USAGE_KEY) || 'null');
  if (!saved || saved.calls !== 2) throw new Error('用量没有落盘');
  if (JSON.stringify(saved).indexOf('secret') >= 0) throw new Error('用量数据不应含密钥');
});

step('用量与限额：达到上限后拦下新请求（E2-008）', () => {
  const old = {
    calls: T.CONFIG.usageDailyCalls, tokens: T.CONFIG.usageDailyTokens,
    enabled: T.CONFIG.usageLimitEnabled
  };
  T.CONFIG.usageLimitEnabled = true;
  T.CONFIG.usageDailyCalls = 2;
  T.CONFIG.usageDailyTokens = 0;
  if (!T.usageCheck()) throw new Error('调用次数用尽后没有返回超限');
  T.CONFIG.usageDailyCalls = 0;
  T.CONFIG.usageDailyTokens = 40;
  if (!/Token/.test(T.usageCheck())) throw new Error('Token 用尽后没有返回超限');
  T.CONFIG.usageDailyCalls = 0;
  T.CONFIG.usageDailyTokens = 0;
  if (T.usageCheck() !== '') throw new Error('0 应表示不限');
  T.CONFIG.usageLimitEnabled = false;
  T.CONFIG.usageDailyCalls = 1;
  if (T.usageCheck() !== '') throw new Error('关闭限额后仍被拦');
  T.CONFIG.usageDailyCalls = old.calls;
  T.CONFIG.usageDailyTokens = old.tokens;
  T.CONFIG.usageLimitEnabled = old.enabled;
  T.usageReset();
});

step('会话级自动确认：只在当前任务生效、过期即失效并留审计（E1-003）', () => {
  const t = T.taskEnsureChat();
  T.autoConfirmOff('test');
  if (T.autoConfirmActive(t.id)) throw new Error('默认不应处于自动确认');
  T.autoConfirmOn(t.id);
  if (!T.autoConfirmActive(t.id)) throw new Error('开启后当前任务没有生效');
  const other = T.taskAdd('workspace', '自动确认隔离', '');
  if (T.autoConfirmActive(other.id)) throw new Error('自动确认串到了另一个任务');
  T.AUTO_CONFIRM.until = Date.now() - 1;
  if (T.autoConfirmActive(t.id)) throw new Error('过期后仍生效');
  const ev = (T.TASKS.find(x => x.id === t.id).events || []).filter(e => e.type === 'auto_confirm_on');
  if (!ev.length) throw new Error('缺少自动确认开启审计');
  const scope = ev[ev.length - 1].data && ev[ev.length - 1].data.scope;
  if (!Array.isArray(scope) || scope.indexOf('device') < 0 || scope.indexOf('external_write') < 0) {
    throw new Error('审计里没有记录生效范围');
  }
  T.autoConfirmOff('test');
  T.taskSetCurrent(t.id);
});

step('聊天首页与返回栈：次级页逐层退回聊天（E1-001/002）', () => {
  T.showView('settings');
  T.showView('music');
  if (T.currentViewId() !== 'music') throw new Error('没有切到音乐页');
  if (!T.handleNativeBack() || T.currentViewId() !== 'settings') {
    throw new Error('返回栈没有退回设置，实际：' + T.currentViewId());
  }
  if (!T.handleNativeBack() || T.currentViewId() !== 'chat') {
    throw new Error('返回栈没有退回聊天，实际：' + T.currentViewId());
  }
  if (T.VIEW_STACK.length !== 1 || T.VIEW_STACK[0] !== 'chat') throw new Error('聊天首页没有清空返回栈');
  if (T.handleNativeBack() !== false) throw new Error('聊天首页不应再拦截系统返回');
});

step('开放式运行时：v2 surface 隔离、私有存储与 secret 不落明文（E3-002/006/009）', () => {
  const raw = {
    manifestVersion: 2, apiVersion: '0.2', id: 'com.beh.runtime', name: '行为运行', version: '1.0.0',
    permissions: ['files.public.write'],
    config: { schemaVersion: 3, fields: [
      { key: 'name', type: 'string', label: '名称', default: '默认' },
      { key: 'token', type: 'secret', label: '密钥' }
    ] },
    surfaces: [
      { type: 'page', id: 'home', title: '首页', tree: { type: 'layout', children: [
        { type: 'text', text: '值：{{config.name}}' },
        { type: 'text', text: '<img src=x onerror=alert(1)>' }
      ] } },
      { type: 'command', id: 'cmd', command: '/beh', action: { type: 'state.set', path: 'hit', value: true } },
      { type: 'event', id: 'ev', on: 'task.update', action: { type: 'state.set', path: 'events', value: 1 } },
      { type: 'job', id: 'job1', every: 30, action: { type: 'state.set', path: 'job', value: 1 } }
    ]
  };
  if (T.plugManifestV2Error(raw)) throw new Error('v2 清单被拒：' + T.plugManifestV2Error(raw));
  const m = T.plugNormalize(Object.assign({}, raw, { grantedPermissions: ['files.public.write'] }));
  if (!m || m.surfaces.length !== 4) throw new Error('surface 未注册');
  T.USER_PLUGINS.push(m);
  if (!T.plugSurfaceFind('page', 'home', m.id)) throw new Error('启用插件未进入注册表');
  m.enabled = false; m.state = 'disabled';
  if (T.plugSurfaceFind('page', 'home', m.id)) throw new Error('停用插件仍出现在注册表');
  m.enabled = true; m.state = 'installed';
  T.plugStateSet(m, 'a.b', 2);
  if (T.plugStateGet(m).a.b !== 2) throw new Error('私有存储没有按命名空间写入');
  const savedState = store.get(T.PLUG_STATE_KEY) || '';
  if (savedState.indexOf('com.beh.runtime') < 0) throw new Error('私有存储没有命名空间');
  const cfg = T.plugConfigSet(m, 'name', '测试');
  if (!cfg.ok || T.plugConfigGet(m).name !== '测试') throw new Error('配置没有保存');
  const sec = T.plugConfigSet(m, 'token', 'beh-secret-xyz');
  if (!sec.ok) throw new Error('secret 配置保存失败');
  if ((store.get(T.PLUG_CONFIG_KEY) || '').indexOf('beh-secret-xyz') >= 0) throw new Error('secret 明文进了普通配置');
  if (vaultStore.get('plugin.com.beh.runtime.token') !== 'beh-secret-xyz') throw new Error('secret 没有进密钥仓');
  if (T.plugConfigGet(m).token !== '••••••') throw new Error('配置读取没有脱敏');
  const htmlForm = T.plugConfigFormHTML(m, null);
  if (htmlForm.indexOf('beh-secret-xyz') >= 0) throw new Error('配置表单泄露了 secret');
  const page = m.surfaces.filter(s => s.type === 'page')[0];
  const treeHtml = T.plugRenderTree(page.tree, { config: T.plugConfigGet(m), state: {}, session: {} });
  if (!/测试/.test(treeHtml)) throw new Error('页面绑定没有取到配置');
  if (/<img src=x/.test(treeHtml)) throw new Error('组件树注入了未转义的 HTML');
  const protoAttack = T.plugBindString('{{config.__proto__.polluted}}', { config: {} });
  if (protoAttack) throw new Error('数据绑定允许访问原型链');
  T.plugLifecycle(m, 'uninstall');
  if (JSON.stringify(T.plugStateGet(m)) !== '{}') throw new Error('卸载没有清理私有状态');
  if (vaultStore.has('plugin.com.beh.runtime.token')) throw new Error('卸载没有清理 secret');
  T.USER_PLUGINS.length = 0;
});

(async () => {
  // E3-004/007：动作权限、事件总线、限流与生命周期。
  try {
    const raw = {
      manifestVersion: 2, apiVersion: '0.2', id: 'com.beh.act', name: '动作插件', permissions: [],
      surfaces: [
        { type: 'page', id: 'home', title: '首页', tree: { type: 'text', text: 'hi' } },
        { type: 'event', id: 'ev', on: 'task.update', action: { type: 'state.set', path: 'ev', value: 1 } },
        { type: 'job', id: 'j', every: 30, action: { type: 'state.set', path: 'job', value: 1 } }
      ]
    };
    const m = T.plugNormalize(raw);
    T.USER_PLUGINS.push(m);
    const deny = await T.plugRunAction(m, { type: 'openUrl', url: 'https://example.com', permissions: ['system.open_url'] }, {});
    if (deny.ok !== false) throw new Error('未声明权限的动作没有被拒绝');
    const before = T.plugStateGet(m).ev || 0;
    T.plugEmit('task.update', { taskId: 'x' });
    await new Promise(r => setTimeout(r, 0));
    if ((T.plugStateGet(m).ev || 0) <= before) throw new Error('事件总线没有触发订阅动作');
    const jr = await T.plugRunJob(m.id, 'j');
    if (!jr.ok || T.plugStateGet(m).job !== 1) throw new Error('后台任务没有执行');
    let last = null;
    for (let i = 0; i < 31; i++) last = await T.plugRunAction(m, { type: 'state.set', path: 'n', value: i }, {});
    if (last.ok !== false) throw new Error('动作没有限流');
    T.plugLifecycle(m, 'uninstall');
    T.USER_PLUGINS.length = 0;
    if (T.plugSurfaceList('page').length) throw new Error('卸载后 surface 仍在');
    console.log('  ✓ 开放式运行时：动作权限、事件、后台任务、限流与卸载（E3-004/007）');
  } catch (e) {
    errors.push('开放式运行时：动作权限、事件、后台任务、限流与卸载（E3-004/007）: ' + e.message);
  }

  // E4-001/003/004/005：挂载点、主题作用域隔离、会话引擎与卸载清理。
  try {
    const raw = {
      manifestVersion: 2, apiVersion: '0.2', id: 'com.beh.e4', name: 'E4 行为', permissions: [],
      surfaces: [
        { type: 'theme', id: 'day', title: '白昼', tokens: { bg: '#ffffff', color: '#222222' } },
        { type: 'theme', id: 'night', title: '夜色', tokens: { bg: '#111111', color: '#eeeeee' } },
        { type: 'entry', id: 'hi', mount: 'chat.header', tree: { type: 'text', text: '头' } },
        { type: 'entry', id: 'aft', mount: 'chat.message.after', when: 'session', tree: { type: 'text', text: '尾' } },
        { type: 'renderer', id: 'round', tree: { type: 'choice', options: ['甲', '乙'], prompt: '第 {{session.round}} 轮' } },
        { type: 'sessionType', id: 'game', title: '游戏', opening: '开始', renderer: 'round',
          stateSchema: { properties: { round: { default: 0 }, score: { default: 0 } } }, endWhen: 'score >= 2' }
      ]
    };
    if (T.plugManifestV2Error(raw)) throw new Error('E4 清单被拒：' + T.plugManifestV2Error(raw));
    const m = T.plugNormalize(raw);
    T.USER_PLUGINS.push(m);
    if (T.plugThemesOf(m).length !== 2) throw new Error('主题包没有进入注册表');
    if (!/头/.test(T.plugMountHtml('chat.header'))) throw new Error('chat.header 挂载点没有渲染');
    if (T.plugMountHtml('chat.message.after')) throw new Error('when=session 的入口在聊天首页就出现了');
    const g = await T.plugRunAction(m, { type: 'theme.apply', theme: 'day', scope: 'global' }, {});
    if (!g.ok || (T.plugThemeRestore() || {}).themeId !== 'day') throw new Error('全局主题没有生效');
    const ses = await T.plugRunAction(m, { type: 'session.create', session: 'game' }, {});
    if (!ses.ok) throw new Error('会话创建失败：' + JSON.stringify(ses));
    const task = T.currentTask();
    if (!task.pluginSession || task.pluginSession.surfaceId !== 'game') throw new Error('会话没有绑定插件类型');
    if (!/尾/.test(T.plugMountHtml('chat.message.after'))) throw new Error('when=session 的入口在会话里没有出现');
    const sn = await T.plugRunAction(m, { type: 'theme.apply', theme: 'night', scope: 'session' }, {});
    if (!sn.ok || (T.plugThemeRestore() || {}).themeId !== 'night') throw new Error('会话主题没有生效');
    const chatTask = T.TASKS.filter(t => t.type === 'chat' && !t.pluginSession)[0];
    T.taskSetCurrent(chatTask.id);
    if ((T.plugThemeRestore() || {}).themeId !== 'day') throw new Error('会话主题污染了全局/其它任务');
    T.taskSetCurrent(task.id);
    if (!/第/.test(T.plugSessionAfterReply(task))) throw new Error('每轮模板没有拿到轮次');
    T.plugStateSet(m, 'score', 2);
    const endHtml = T.plugSessionAfterReply(task);
    if (!task.pluginSession.ended || !/结束/.test(endHtml)) throw new Error('结束条件没有生效');
    T.plugLifecycle(m, 'uninstall');
    T.USER_PLUGINS.length = 0;
    if (T.plugMountEntries('chat.header').length) throw new Error('卸载后挂载入口仍在');
    if ((T.plugThemeRestore() || {}).themeId === 'day') throw new Error('卸载没有清理主题');
    if (T.TASKS.some(t => t.id === task.id)) throw new Error('卸载没有清理会话任务');
    T.showView('chat');
    console.log('  ✓ 插件 UI 运行时：挂载点、主题作用域隔离、会话结束与卸载清理（E4-001/003/004/005）');
  } catch (e) {
    errors.push('插件 UI 运行时：挂载点、主题作用域隔离、会话结束与卸载清理（E4-001/003/004/005）: ' + e.message);
  }

  // E4 出口：三个验收插件只用 surface/组件/动作/job 组合，宿主零改动。
  try {
    const dir = path.join(__dirname, '..', 'plugin-examples');
    const load = f => T.plugNormalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

    const theme = load('theme-aurora.json');
    T.USER_PLUGINS.push(theme);
    if (T.plugThemesOf(theme).length !== 2) throw new Error('主题插件没有注册两个主题包');
    if (!/极光夜/.test(T.plugMountHtml('settings.section'))) throw new Error('主题插件没有挂到设置分区');
    const ap = await T.plugRunAction(theme, { type: 'theme.apply', theme: 'aurora', scope: 'global' }, {});
    if (!ap.ok || (T.plugThemeRestore() || {}).themeId !== 'aurora') throw new Error('主题插件应用失败');
    T.plugThemeReset('global');
    if (T.plugThemeRestore()) throw new Error('主题重置没有清空');
    T.plugLifecycle(theme, 'uninstall');
    T.USER_PLUGINS.length = 0;

    const game = load('dating-game.json');
    T.USER_PLUGINS.push(game);
    const sres = await T.plugRunAction(game, { type: 'session.create', session: 'date' }, {});
    if (!sres.ok) throw new Error('恋爱游戏会话创建失败');
    const gtask = T.currentTask();
    if (!/第/.test(T.plugSessionAfterReply(gtask))) throw new Error('恋爱游戏每轮模板没有渲染');
    T.plugStateSet(game, 'affinity', 3);
    const gend = T.plugSessionAfterReply(gtask);
    if (!gtask.pluginSession.ended || !/结束/.test(gend)) throw new Error('恋爱游戏结束条件没有生效');
    T.plugLifecycle(game, 'uninstall');
    T.USER_PLUGINS.length = 0;
    if (T.TASKS.some(t => t.id === gtask.id)) throw new Error('恋爱游戏卸载没有清理会话');

    const pomo = load('pomodoro.json');
    T.USER_PLUGINS.push(pomo);
    if (!/开始专注/.test(T.plugMountHtml('chat.header'))) throw new Error('番茄钟没有挂到聊天头部');
    const jr = await T.plugRunJob(pomo.id, 'remind');
    if (!jr || jr.ok !== true) throw new Error('番茄钟定时任务没有执行：' + JSON.stringify(jr));
    const stats = pomo.surfaces.filter(x => x.type === 'page')[0];
    if (!/完成番茄/.test(T.plugRenderTree(stats.tree, { state: T.plugStateGet(pomo), config: {}, session: {} }))) {
      throw new Error('番茄钟统计页没有渲染');
    }
    T.plugLifecycle(pomo, 'uninstall');
    T.USER_PLUGINS.length = 0;
    T.showView('chat');
    console.log('  ✓ 验收插件：主题包、恋爱游戏、番茄钟（E4 出口）');
  } catch (e) {
    errors.push('验收插件：主题包、恋爱游戏、番茄钟（E4 出口）: ' + e.message);
  }

  // E2-005：连接测试只探测 /models，不发付费推理请求。
  const calls = require('./harness').calls;
  try {
    const cfg = T.CONFIG;
    T.providerUpsert(cfg, {
      id: 'beh-test', name: '连接测试', kind: 'openai',
      base: 'https://example.invalid/v1', capabilities: ['chat']
    }, 'test-secret-xyz');
    calls.net.length = 0;
    const r = await T.providerTest(cfg, 'beh-test');
    if (!r || r.ok !== true) throw new Error('测试请求没有成功：' + JSON.stringify(r));
    const hit = calls.net.filter(c => /\/models$/.test(c.url));
    if (!hit.length) throw new Error('没有请求 /models：' + JSON.stringify(calls.net));
    if (!hit.every(c => c.method === 'GET')) throw new Error('连接测试应为 GET');
    if (calls.net.some(c => /completions|embeddings|audio\/speech/.test(c.url))) {
      throw new Error('连接测试发起了付费推理请求：' + JSON.stringify(calls.net));
    }
    const bad = await T.providerTest(cfg, 'missing-provider').then(() => null, e => e);
    if (!bad) throw new Error('不存在的 Provider 应拒绝');
    console.log('  ✓ 模型中心：连接测试只 GET /models（E2-005）');
  } catch (e) {
    errors.push('模型中心：连接测试只 GET /models（E2-005）: ' + e.message);
  }

  /* ================= 0.12 / E5 依赖管理 ================= */
  {
    const { calls } = require('./harness');
    const sha = 'a'.repeat(64);
    const mkDep = o => T.plugNormalizeDependency(o);

    try {
      if (mkDep({ id: 'a', kind: 'binary', version: '1', source: 'http://x/y', sha256: sha })) throw new Error('http 依赖未被拒绝');
      if (mkDep({ id: 'a', kind: 'binary', version: '1', source: 'https://x/y', sha256: '' })) throw new Error('缺哈希依赖未被拒绝');
      if (mkDep({ id: 'a', kind: 'weird', version: '1', source: 'https://x/y', sha256: sha })) throw new Error('未知 kind 未被拒绝');
      const good = mkDep({ id: 'bin', kind: 'binary', version: '1.0', source: 'https://x/y', sha256: sha, bin: 'tool', size: 12, license: 'MIT', why: 'test' });
      if (!good || good.id !== 'bin' || good.license !== 'MIT' || good.bin !== 'tool' || good.size !== 12) throw new Error('合法依赖字段被截断：' + JSON.stringify(good));
      if (!/dependencies\.manage/.test(JSON.stringify(T.PLUG_PERMISSION_INFO))) throw new Error('缺少 dependencies.manage 权限说明');
      console.log('  ✓ 依赖声明：HTTPS + SHA-256 强制，字段完整（E5-001）');
    } catch (e) { errors.push('依赖声明：HTTPS + SHA-256 强制，字段完整（E5-001）: ' + e.message); }

    try {
      const plugin = {
        id: 'dep-test', name: '依赖测试', enabled: true, version: '1.0.0',
        permissions: ['dependencies.manage'], grantedPermissions: ['dependencies.manage'],
        dependencies: [
          mkDep({ id: 'apk1', kind: 'apk', version: '1', source: 'https://x/a.apk', sha256: sha, size: 10 }),
          mkDep({ id: 'bin1', kind: 'binary', version: '1', source: 'https://x/b', sha256: sha, bin: 'b' }),
          mkDep({ id: 'pkg1', kind: 'termux-pkg', version: '1.2', source: 'ffmpeg' })
        ]
      };
      const plan = T.plugDepPlan(plugin).map(x => x.dep.id);
      if (plan.join(',') !== 'pkg1,bin1,apk1') throw new Error('安装顺序不对：' + plan.join(','));
      if (T.plugDepCounts(plugin).missing !== 3) throw new Error('缺失计数不对');
      calls.deps.length = 0;
      const r1 = await T.plugDepInstall(plugin, 'bin1', { confirmed: true, force: true });
      if (!r1.ok) throw new Error('binary 依赖安装失败：' + JSON.stringify(r1));
      if (T.plugDepStateOf(plugin, T.plugDepPlan(plugin).filter(x => x.dep.id === 'bin1')[0].dep) !== 'installed') throw new Error('安装后状态不是 installed');
      const v = await T.plugDepVerify(plugin, 'bin1');
      if (!v.ok || !v.verified) throw new Error('校验未通过：' + JSON.stringify(v));
      const r2 = await T.plugDepUninstall(plugin, 'bin1', { confirmed: true });
      if (!r2.ok) throw new Error('卸载失败');
      if (T.plugDepCounts(plugin).installed !== 0) throw new Error('卸载后仍有已安装');
      console.log('  ✓ 依赖安装/校验/卸载：走原生契约（E5-002/003）');
    } catch (e) { errors.push('依赖安装/校验/卸载：走原生契约（E5-002/003）: ' + e.message); }

    try {
      const plugin = {
        id: 'dep-apk', name: 'APK 测试', enabled: true,
        permissions: ['dependencies.manage'], grantedPermissions: ['dependencies.manage'],
        dependencies: [mkDep({ id: 'a1', kind: 'apk', version: '1', source: 'https://x/a.apk', sha256: sha })]
      };
      calls.deps.length = 0;
      const p = T.plugDepInstall(plugin, 'a1', { confirmed: true, force: true });
      await new Promise(r => setTimeout(r, 20));
      if (calls.deps.some(c => c[0] === 'apk')) throw new Error('APK 未经二次确认就调用系统安装器');
      T.closeModal(false);
      const denied = await p;
      if (denied.ok) throw new Error('用户取消后 APK 安装仍成功');
      const p2 = T.plugDepInstall(plugin, 'a1', { confirmed: true, force: true });
      await new Promise(r => setTimeout(r, 20));
      T.closeModal(true);
      const okr = await p2;
      if (!okr.ok || !calls.deps.some(c => c[0] === 'apk')) throw new Error('确认后没有启动系统安装器');
      console.log('  ✓ APK 依赖只交给系统安装器且需二次确认（E5-004）');
    } catch (e) { errors.push('APK 依赖只交给系统安装器且需二次确认（E5-004）: ' + e.message); }

    try {
      const plugin = {
        id: 'dep-termux', name: 'Termux 测试', enabled: true,
        permissions: ['dependencies.manage'], grantedPermissions: ['dependencies.manage'],
        dependencies: [mkDep({ id: 'p1', kind: 'termux-pkg', version: '6.0', source: 'ffmpeg' })]
      };
      calls.deps.length = 0;
      const r = await T.plugDepInstall(plugin, 'p1', { confirmed: true, force: true });
      if (!r.ok) throw new Error('Termux 固定模板安装失败：' + JSON.stringify(r));
      if (!calls.deps.some(c => c[0] === 'fixed' && /ffmpeg/.test(c[1]))) throw new Error('没有走固定模板');
      if (!calls.deps.some(c => c[0] === 'record')) throw new Error('安装后没有写 lockfile 记录');
      console.log('  ✓ Termux 依赖走固定模板并记录 lockfile（E5-005）');
    } catch (e) { errors.push('Termux 依赖走固定模板并记录 lockfile（E5-005）: ' + e.message); }

    try {
      const plugin = {
        id: 'dep-order', name: '卸载顺序', enabled: true,
        permissions: ['dependencies.manage'], grantedPermissions: ['dependencies.manage'],
        dependencies: [
          mkDep({ id: 'x1', kind: 'binary', version: '1', source: 'https://x/1', sha256: sha }),
          mkDep({ id: 'x2', kind: 'binary', version: '1', source: 'https://x/2', sha256: 'b'.repeat(64) })
        ]
      };
      await T.plugDepInstall(plugin, 'x1', { confirmed: true, force: true });
      await T.plugDepInstall(plugin, 'x2', { confirmed: true, force: true });
      calls.deps.length = 0;
      const p = T.plugDepUninstallAll(plugin);
      await new Promise(r => setTimeout(r, 10));
      T.closeModal(true);
      const r = await p;
      if (!r.ok) throw new Error('全部卸载失败：' + JSON.stringify(r));
      const removes = calls.deps.filter(c => c[0] === 'remove').map(c => c[2]);
      if (removes.join(',') !== 'x2,x1') throw new Error('卸载不是逆序：' + removes.join(','));
      console.log('  ✓ 全部卸载按声明逆序删除（E5-006）');
    } catch (e) { errors.push('全部卸载按声明逆序删除（E5-006）: ' + e.message); }
  }

  /* ================= 0.12 / E6 持久会话 ================= */
  {
    const { calls } = require('./harness');

    try {
      const t = T.taskAdd('device', '长任务', '持久测试');
      calls.deps.length = 0;
      const p = T.persistStart(t, { goal: '持久测试', minutes: 30 });
      if (!p || !p.enabled || !t.persist) throw new Error('持久会话未建立');
      if (!calls.deps.some(c => c[0] === 'wake-acquire')) throw new Error('未申请会话唤醒锁');
      const ph = T.persistHeartbeat(t, { phase: 'run', progress: '第 1 步' }, { force: true });
      if (!ph || t.persist.phase !== 'run') throw new Error('心跳未写入');
      if (!T.persistCheckpoint(t, 'step', '完成第一步')) throw new Error('检查点失败');
      const snap = JSON.parse(store.get(T.PERSIST_SNAPSHOT_KEY) || '{}');
      if (!snap[t.id] || snap[t.id].phase !== 'step') throw new Error('快照没有落盘');
      if (!/持久会话开始/.test(T.persistLogText(t.id))) throw new Error('会话日志缺失');
      const t2 = T.taskAdd('device', '恢复', '恢复测试');
      T.persistStart(t2);
      T.persistCheckpoint(t2, 'run', '运行中');
      t2.state = 'active';
      const n = T.persistRecoverAll();
      if (n < 1 || t2.state !== 'paused' || !/检查点/.test(t2.progress)) throw new Error('重启恢复没有转暂停：' + JSON.stringify({ n, st: t2.state, pg: t2.progress }));
      T.taskCancel(t.id); T.taskCancel(t2.id);
      console.log('  ✓ 持久会话：唤醒锁、心跳、检查点、重启恢复（E6-001~003）');
    } catch (e) { errors.push('持久会话：唤醒锁、心跳、检查点、重启恢复（E6-001~003）: ' + e.message); }

    try {
      const t = T.taskAdd('device', '预算', '预算测试');
      T.persistStart(t);
      t.persist.budget.actions = 2;
      if (T.persistBudgetCount(t, 'actions', 1)) throw new Error('未超预算就熔断');
      const hit = T.persistBudgetCount(t, 'actions', 2);
      if (!hit || t.state !== 'paused' || !/预算熔断/.test(t.persist.pausedReason || '')) throw new Error('预算熔断未暂停：' + JSON.stringify({ hit, st: t.state }));
      T.taskCancel(t.id);
      console.log('  ✓ 预算熔断只暂停、不判失败（E6-006）');
    } catch (e) { errors.push('预算熔断只暂停、不判失败（E6-006）: ' + e.message); }

    try {
      const t = T.taskAdd('device', '退避', '退避测试');
      T.persistStart(t);
      const r1 = T.persistBackoff(t, 'boom');
      if (r1.paused || r1.delay !== T.PERSIST_TUNING.backoffBase) throw new Error('首次退避不符合基数：' + JSON.stringify(r1));
      let last;
      for (let i = 0; i < 6; i++) last = T.persistBackoff(t, 'boom');
      if (!last.paused || t.state !== 'paused') throw new Error('连续异常没有转暂停：' + JSON.stringify(last));
      T.taskCancel(t.id);
      console.log('  ✓ 看门狗指数退避，连续异常转暂停（E6-005）');
    } catch (e) { errors.push('看门狗指数退避，连续异常转暂停（E6-005）: ' + e.message); }

    try {
      const t = T.taskAdd('device', '日志', '轮转测试');
      T.persistStart(t);
      for (let i = 0; i < 200; i++) T.persistLog(t.id, 'info', 'line-' + i);
      const list = JSON.parse(store.get(T.PERSIST_LOG_KEY) || '{}')[t.id];
      if (!list || list.length > T.PERSIST_TUNING.logMax) throw new Error('日志没有按上限轮转');
      const exp = T.persistExportLogs(t.id);
      if (/sk-[A-Za-z0-9]|ghp_/.test(exp)) throw new Error('导出日志没有脱敏');
      T.taskCancel(t.id);
      console.log('  ✓ 会话日志轮转与导出脱敏（E6-007）');
    } catch (e) { errors.push('会话日志轮转与导出脱敏（E6-007）: ' + e.message); }

    try {
      T.sSet('via_ai_plugin_jobs', { 'ghost:svc': { every: 60, nextRun: 0, failures: 0 } });
      for (let i = 0; i < 3; i++) {
        const cur = JSON.parse(store.get('via_ai_plugin_jobs') || '{}')['ghost:svc'] || {};
        T.persistSchedulerTick((Number(cur.nextRun) || Date.now()) + 1);
        await new Promise(r => setTimeout(r, 30));
      }
      const jobs = JSON.parse(store.get('via_ai_plugin_jobs') || '{}');
      const job = jobs['ghost:svc'];
      if (!job || !job.paused || !/连续失败 3 次/.test(job.error || '')) throw new Error('调度器失败未暂停：' + JSON.stringify(job));
      console.log('  ✓ 插件后台任务调度：失败退避 + 连续失败暂停（E6-005）');
    } catch (e) { errors.push('插件后台任务调度：失败退避 + 连续失败暂停（E6-005）: ' + e.message); }
  }

  /* ================= 0.12.1 清空对话 / 联网阅读 / 全用途绑定 ================= */
  {
    try {
      const chat = T.taskEnsureChat();
      T.taskSetCurrent(chat.id);
      pushMsg('clear-me');
      T.saveHistory();
      if (!hasMsg(T.getHistory(), 'clear-me')) throw new Error('测试消息没有写进历史');
      await T.clearCurrentChat();
      if (T.getHistory().filter(m => m.role !== 'system').length !== 0) throw new Error('清空后仍留有对话消息');
      if (hasMsg(json(T.taskHistoryKey(chat.id)), 'clear-me')) throw new Error('清空后任务历史仍保留旧消息');
      console.log('  ✓ 清空对话：当前任务历史与全局历史一起清空（0.12.1）');
    } catch (e) { errors.push('清空对话（0.12.1）: ' + e.message); }

    try {
      if (!T.webUrlCheck('https://example.com/a?b=1').ok) throw new Error('正常公网地址被拒绝');
      const bad = ['http://127.0.0.1/', 'http://localhost:8080/', 'http://192.168.1.1/', 'http://10.0.0.5/',
        'file:///etc/passwd', 'ftp://example.com/', 'https://user:pass@example.com/', 'http://[::1]/'];
      bad.forEach(u => { if (T.webUrlCheck(u).ok) throw new Error('不该放行的地址：' + u); });
      console.log('  ✓ 联网阅读：拒绝本机 / 内网 / 非 http 地址');
    } catch (e) { errors.push('联网阅读地址校验: ' + e.message); }

    try {
      const html = '<html><head><title>测试 &amp; 标题</title><style>p{color:red}</style></head>'
        + '<body><script>alert(1)</script><h1>你好</h1><p>第一段 &lt;保留&gt;</p><p>第二段</p></body></html>';
      if (T.htmlTitleOf(html) !== '测试 & 标题') throw new Error('标题提取不正确：' + T.htmlTitleOf(html));
      const text = T.htmlToText(html);
      if (/alert|color:red|<h1>|<p>/.test(text)) throw new Error('正文里仍含脚本/样式/标签：' + text);
      if (text.indexOf('你好') < 0 || text.indexOf('第一段 <保留>') < 0) throw new Error('正文提取不完整：' + text);
      console.log('  ✓ 联网阅读：HTML 去脚本样式并还原实体');
    } catch (e) { errors.push('联网阅读正文提取: ' + e.message); }

    try {
      const searx = T.webSearchParseSearx({ results: [
        { title: 'A', url: 'https://a.example/', content: '摘要 A' },
        { title: 'B', url: 'javascript:alert(1)' }
      ] });
      if (searx.length !== 1 || searx[0].url !== 'https://a.example/') throw new Error('SearXNG 解析不正确');
      const ddg = T.webSearchParseDdg('<a rel="nofollow" class="result__a" '
        + 'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2Fp%3Fx%3D1&amp;rut=abc">B 标题</a>'
        + '<a class="result__snippet">B 摘要</a>');
      if (!ddg.length || ddg[0].url !== 'https://b.example/p?x=1') throw new Error('DuckDuckGo 解析不正确：' + JSON.stringify(ddg));
      const bing = T.webSearchParseBing('<li class="b_algo"><h2><a href="https://c.example/">C</a></h2><p>C 摘要</p></li>');
      if (!bing.length || bing[0].url !== 'https://c.example/' || bing[0].snippet !== 'C 摘要') throw new Error('Bing 解析不正确：' + JSON.stringify(bing));
      console.log('  ✓ 联网阅读：三种搜索结果解析');
    } catch (e) { errors.push('联网阅读搜索结果解析: ' + e.message); }

    try {
      const cfg = T.CONFIG;
      T.providerUpsert(cfg, {
        id: 'beh-search', name: '网页搜索', kind: 'custom',
        base: 'https://searx.example', capabilities: ['search']
      }, 'search-secret-xyz');
      if (!T.providerBind(cfg, 'search', 'beh-search')) throw new Error('网页搜索用途绑定失败');
      const r = T.providerResolve(cfg, 'search');
      if (!r || r.provider.id !== 'beh-search') throw new Error('网页搜索用途没有解析到绑定 Provider');
      ['chat', 'vision', 'image', 'video', 'embedding', 'tts', 'asr', 'search'].forEach(p => {
        if (T.PROVIDER_PURPOSES.indexOf(p) < 0) throw new Error('缺少用途：' + p);
      });
      if (T.PROVIDER_CAPS.indexOf('search') < 0) throw new Error('缺少网页搜索能力标签');
      T.providerRemove(cfg, 'beh-search');
      console.log('  ✓ 模型中心：网页搜索与全部用途可独立绑定（0.12.1）');
    } catch (e) { errors.push('模型中心全用途绑定: ' + e.message); }
  }

  if (errors.length) {
    console.error('\n✗ 行为测试失败 ' + errors.length + ' 项：');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }
  console.log('\n✓ 行为测试全部通过');
  process.exit(0);
})();
