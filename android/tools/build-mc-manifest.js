#!/usr/bin/env node
/*
 * 生成 Minecraft 插件的 manifest.json，并同步 marketplace/index.json 的版本/权限/SHA-256。
 *
 * 用法：node tools/build-mc-manifest.js
 *
 * 清单里的 runtime.source 直接取自同目录 bot.js，避免二进制/Base64 与源码两份漂移。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'marketplace', 'plugins', 'com.elly.market.minecraft');
const BOT_FILE = path.join(PLUGIN_DIR, 'bot.js');
const MANIFEST_FILE = path.join(PLUGIN_DIR, 'manifest.json');
const INDEX_FILE = path.join(ROOT, 'marketplace', 'index.json');
// 远程索引要等推送后才有；APK 内置一份，装完就能在「插件市场」里直接安装 MC 插件。
const BUNDLE_FILE = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'src', 'scripts', '04a-mc-market.js');

const ID = 'com.elly.market.minecraft';
const VERSION = '0.3.1';
const PERMISSIONS = ['runtime.termux', 'dependencies.manage', 'network.local'];

const commandToolCode = [
  'async function run(args) {',
  '  var base = "http://127.0.0.1:39271";',
  '  var body = {};',
  '  Object.keys(args || {}).forEach(function (k) { body[k] = args[k]; });',
  '  if (!body.action) throw new Error("缺少 action");',
  '  var r;',
  '  try {',
  '    r = await host.request({ method: "POST", url: base + "/cmd", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeout: 45000 });',
  '  } catch (e) {',
  '    throw new Error("连不上 Minecraft bot（127.0.0.1:39271）：" + ((e && e.message) || e) + "。请先在插件设置里打开「运行面板」并点启动。");',
  '  }',
  '  var d = null;',
  '  try { d = JSON.parse((r && r.text) || "{}"); } catch (e) { throw new Error("bot 返回的不是 JSON"); }',
  '  if (!d || d.ok !== true) throw new Error((d && d.error) || "bot 执行失败");',
  '  return d;',
  '}'
].join('\n');

const statusToolCode = [
  'async function run() {',
  '  var r;',
  '  try {',
  '    r = await host.request({ method: "GET", url: "http://127.0.0.1:39271/status", timeout: 15000 });',
  '  } catch (e) {',
  '    throw new Error("连不上 Minecraft bot（127.0.0.1:39271）：" + ((e && e.message) || e) + "。请先在插件运行面板启动运行时。");',
  '  }',
  '  var d = null;',
  '  try { d = JSON.parse((r && r.text) || "{}"); } catch (e) { throw new Error("bot 返回的不是 JSON"); }',
  '  if (!d || d.ok !== true) throw new Error((d && d.error) || "bot 状态不可用");',
  '  return d;',
  '}'
].join('\n');

const chatToolCode = [
  'async function run(args) {',
  '  var since = Number((args && args.since) || 0);',
  '  var limit = Number((args && args.limit) || 30);',
  '  var r;',
  '  try {',
  '    r = await host.request({ method: "GET", url: "http://127.0.0.1:39271/chat?since=" + encodeURIComponent(since) + "&limit=" + encodeURIComponent(limit), timeout: 15000 });',
  '  } catch (e) {',
  '    throw new Error("连不上 Minecraft bot（127.0.0.1:39271）：" + ((e && e.message) || e) + "。请先在插件运行面板启动运行时。");',
  '  }',
  '  var d = null;',
  '  try { d = JSON.parse((r && r.text) || "{}"); } catch (e) { throw new Error("bot 返回的不是 JSON"); }',
  '  if (!d || d.ok !== true) throw new Error((d && d.error) || "读取聊天失败");',
  '  if (!d.count) return { ok: true, since: d.since, lastTs: d.lastTs, count: 0, messages: [], note: "这段时间没有新聊天；把 lastTs 作为下次的 since 继续往后读。" };',
  '  return d;',
  '}'
].join('\n');

function buildManifest(source) {
  return {
    manifestVersion: 2,
    apiVersion: '0.2',
    id: ID,
    name: 'Minecraft 联机助手',
    icon: '⛏',
    version: VERSION,
    author: 'ElysiaFloat',
    homepage: 'https://github.com/xysy92ds/ElysiaFloat',
    docs: 'plugins/' + ID + '/README.md',
    desc: '让 AI 陪你玩 Java 版 Minecraft：Termux 里常驻 Mineflayer bot，支持离线登录、移动、挖掘、放置、攻击、跟随、聊天、状态快照与动作审计。',
    permissions: PERMISSIONS,
    dependencies: [
      { kind: 'termux-pkg', id: 'nodejs', version: 'latest', source: 'nodejs', why: '运行 Mineflayer 桥接进程' },
      { kind: 'npm', id: 'mineflayer', version: 'latest', source: 'mineflayer', license: 'MIT', why: 'Minecraft Java 协议客户端' },
      { kind: 'npm', id: 'mineflayer-pathfinder', version: 'latest', source: 'mineflayer-pathfinder', license: 'MIT', why: '寻路、跟随与躲避' },
      { kind: 'npm', id: 'minecraft-data', version: 'latest', source: 'minecraft-data', license: 'MIT', why: '方块与实体数据' },
      { kind: 'npm', id: 'vec3', version: 'latest', source: 'vec3', license: 'MIT', why: '坐标向量' }
    ],
    runtime: {
      kind: 'termux-node',
      entry: 'bot.js',
      source: source,
      configFile: true,
      autostart: false,
      restart: 'on-failure',
      healthcheckMs: 15000,
      logMaxBytes: 2097152
    },
    surfaces: [
      {
        type: 'settings',
        id: 'mc-config',
        title: '连接与行为',
        desc: '配置服务器地址、离线用户名和行为边界。改动会立即保存，下次启动时生效。',
        config: {
          schemaVersion: 1,
          fields: [
            {
              key: 'host', type: 'string', label: '服务器地址', required: true, default: '127.0.0.1',
              desc: '同机就填 127.0.0.1，局域网填开房间那台设备的 IP。也可以直接粘贴游戏里的「Local game hosted on port 12345」，会自动取端口并连本机。'
            },
            {
              key: 'port', type: 'number', label: '端口', required: true, default: 25565, min: 1, max: 65535,
              desc: 'Java 版默认 25565；单人「对局域网开放」的端口每次随机，以游戏内提示为准。'
            },
            {
              key: 'username', type: 'string', label: '离线用户名', default: 'Elly',
              desc: '离线登录名，只允许字母、数字和下划线，最长 16 位。'
            },
            {
              key: 'version', type: 'string', label: '游戏版本', default: '',
              desc: '留空自动识别；协议不匹配时手填，例如 1.20.4。'
            },
            {
              key: 'allowActions', type: 'enum', label: '行为边界', default: 'full',
              options: [
                { value: 'full', label: '完整：移动、挖掘、放置、攻击' },
                { value: 'safe', label: '安全：只移动、寻路、聊天、查看' }
              ],
              desc: '安全模式下挖掘/放置/攻击/丢弃一律拒绝，AI 无法改变你的世界。'
            },
            {
              key: 'autoReconnect', type: 'boolean', label: '断线自动重连', default: true,
              desc: '在 bot 进程内部重连，退避最长 60 秒；关掉后断线就停在未连接状态。'
            },
            {
              key: 'allowedHosts', type: 'string', label: '授权服务器（可选）', default: '',
              desc: '逗号分隔的主机名或 IP；留空不限制。填了就只允许连列表里的地址。'
            }
          ]
        }
      },
      {
        type: 'page',
        id: 'mc-guide',
        title: '使用说明',
        icon: '📖',
        desc: '从装依赖到和 AI 一起联机的完整步骤。',
        tree: [
          { type: 'text', size: 'lg', text: 'Minecraft 联机助手（Java 版）' },
          { type: 'text', muted: true, text: 'bot 在 Termux 里常驻，App 只负责配置、启停、状态和日志；AI 通过受控工具给它下指令。' },
          { type: 'divider' },
          {
            type: 'list', items: [
              { title: '1. 准备环境', desc: '插件行 → 依赖，或打开运行面板点「一键准备环境」，装好 Node.js 与 mineflayer 等 npm 包。' },
              { title: '2. 开好世界', desc: 'Java 版单人游戏 → 对局域网开放，记下聊天栏里的「Local game hosted on port xxxxx」。' },
              { title: '3. 填配置', desc: '把提示整段粘到「服务器地址」即可；或手动填 IP:端口。离线用户名就是 bot 在游戏里的名字。' },
              { title: '4. 启动', desc: '运行面板点「启动」，首次会弹一次 Termux 派发确认；进入世界后状态会显示坐标、血量与同服玩家。' },
              { title: '5. 和 AI 协作', desc: '直接对 AI 说「让 bot 跟我走」「挖三格石头」；它调用 minecraft_bot 执行，minecraft_bot_status 看快照，minecraft_chat_read 读游戏内聊天。' },
              { title: '6. 停止', desc: '运行面板点「停止」。宿主不会静默拉起进程，异常退出只报告并给出重试建议。' },
              { title: '7. 事后核对', desc: '每个动作都记到工作目录的 audit.log；动作限频每分钟 30 个，超了会直接拒绝并说明原因。' }
            ]
          },
          { type: 'divider' },
          { type: 'text', muted: true, text: '限制：只支持 Java 版离线登录；不绕过反作弊、不自动交易、不群发；寻路不会挖穿你的建筑。' }
        ]
      }
    ],
    tools: [
      {
        name: 'minecraft_bot',
        description: '控制 Minecraft bot：移动、跳跃、看向、挖掘、放置、攻击敌对生物、躲避、寻路、跟随、装备、丢弃、聊天、停止。bot 未启动或未连接时返回明确错误。',
        permissions: ['network.local'],
        timeout: 60000,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['say', 'move', 'jump', 'look', 'lookAt', 'dig', 'digAt', 'place', 'placeAt', 'attack', 'attackNearest', 'flee', 'pathfind', 'follow', 'equip', 'toss', 'stop', 'status'],
              description: '要执行的动作'
            },
            text: { type: 'string', description: 'say 的聊天内容，最长 240 字' },
            direction: { type: 'string', enum: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'], description: 'move 的方向' },
            ticks: { type: 'integer', description: 'move 的持续 tick 数，1–200，默认 10' },
            yaw: { type: 'number', description: 'look 的水平朝向（弧度）' },
            pitch: { type: 'number', description: 'look 的俯仰（弧度）' },
            x: { type: 'number', description: 'lookAt / digAt / placeAt / pathfind 的 X' },
            y: { type: 'number', description: 'lookAt / digAt / placeAt / pathfind 的 Y' },
            z: { type: 'number', description: 'lookAt / digAt / placeAt / pathfind 的 Z' },
            player: { type: 'string', description: 'follow 的目标玩家名' },
            distance: { type: 'integer', description: 'follow 的保持距离，1–8，默认 2' },
            filter: { type: 'string', description: 'attackNearest 只允许 mob（不攻击玩家）' },
            item: { type: 'string', description: 'placeAt / equip / toss 的物品名，可用部分匹配' },
            count: { type: 'integer', description: 'toss 的数量，默认 1' },
            timeoutMs: { type: 'integer', description: 'pathfind 的超时，5000–60000，默认 25000' }
          },
          required: ['action']
        },
        kind: 'js',
        code: commandToolCode
      },
      {
        name: 'minecraft_bot_status',
        description: '读取 Minecraft bot 的状态快照：连接状态、坐标、血量、饥饿、背包、同服玩家、上次动作结果。',
        permissions: ['network.local'],
        timeout: 15000,
        parameters: { type: 'object', properties: {}, required: [] },
        kind: 'js',
        code: statusToolCode
      },
      {
        name: 'minecraft_chat_read',
        description: '读取游戏内聊天记录（别人说了什么）。只读，不会替玩家发话；用上次返回的 lastTs 作为下次的 since 可以只拿新增部分。',
        permissions: ['network.local'],
        timeout: 15000,
        parameters: {
          type: 'object',
          properties: {
            since: { type: 'number', description: '只取这个毫秒时间戳之后的消息，默认 0（取最近一批）' },
            limit: { type: 'integer', description: '最多返回多少条，1–100，默认 30' }
          },
          required: []
        },
        kind: 'js',
        code: chatToolCode
      }
    ]
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function main() {
  const source = fs.readFileSync(BOT_FILE, 'utf8');
  const manifest = buildManifest(source);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(MANIFEST_FILE, text);
  const digest = sha256(text);

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const entry = (index.plugins || []).filter(p => p.id === ID)[0];
  if (!entry) throw new Error('marketplace/index.json 里没有 ' + ID);
  entry.name = manifest.name;
  entry.version = VERSION;
  entry.description = manifest.desc;
  entry.permissions = PERMISSIONS.slice();
  entry.sha256 = digest;
  entry.docs = manifest.docs;
  entry.manifest = 'plugins/' + ID + '/manifest.json';
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n');

  // 内置市场条目：与 manifest.json 完全同源，避免两份漂移。
  const bundle = '/* 由 tools/build-mc-manifest.js 从 marketplace 清单生成，请勿手改。 */\n'
    + 'PLUGIN_MARKET_INDEX.push(' + JSON.stringify(manifest) + ');\n';
  fs.writeFileSync(BUNDLE_FILE, bundle);

  console.log('✓ manifest.json（' + Buffer.byteLength(text) + ' 字节，bot.js ' + Buffer.byteLength(source) + ' 字节）');
  console.log('✓ 内置市场条目 ' + path.relative(ROOT, BUNDLE_FILE) + '（' + Buffer.byteLength(bundle) + ' 字节）');
  console.log('✓ SHA-256 ' + digest);
  console.log('✓ marketplace/index.json 已同步到 v' + VERSION);
}

main();
