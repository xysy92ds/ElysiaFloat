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

if (errors.length) {
  console.error('\n✗ 行为测试失败 ' + errors.length + ' 项：');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}
console.log('\n✓ 行为测试全部通过');
process.exit(0);
