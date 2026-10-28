// ElysiaFloat Minecraft 桥接进程（0.3.0）
//
// 由宿主 runtime 启动：宿主把插件配置写成工作目录里的 runtime-config.json，
// 本进程读取后连接游戏、接受本机 HTTP 指令，并把状态写回同一目录。
//
//   读：runtime-config.json
//   写：status.json（状态快照）、chat.log（聊天尾部）、audit.log（动作审计）
//   听：127.0.0.1:39271  GET /status · GET /health · GET /chat · POST /cmd
//
// 依赖（全局 npm，由插件运行面板安装）：
//   mineflayer mineflayer-pathfinder minecraft-data vec3
// 只支持 Java 版离线登录（局域网房间或 online-mode=false 的服务器）。

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const CONTROL_PORT = 39271;
const STATUS_INTERVAL_MS = 2000;
const CHAT_MAX_BYTES = 65536;
const AUDIT_MAX_BYTES = 262144;
const MAX_TARGET_DISTANCE = 128;
const MAX_BODY_BYTES = 65536;
const RATE_LIMIT_PER_MIN = 30;   // 每分钟最多 30 个动作，超了直接拒绝，避免把服务器刷到踢人
const CHAT_READ_MAX = 100;

/* Termux 的 npm 是全局安装，默认不会进 require 解析路径。 */
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
process.env.NODE_PATH = [path.join(PREFIX, 'lib', 'node_modules'), '/usr/local/lib/node_modules', process.env.NODE_PATH || '']
  .filter(Boolean).join(':');
try { require('module')._initPaths(); } catch (e) { /* 旧版 Node 没有 _initPaths */ }

function log(msg) {
  console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + msg);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return text.trim() ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}
function writeJsonAtomic(file, value) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (e) {
    log('写 ' + path.basename(file) + ' 失败：' + e.message);
  }
}

/* ---------------- 配置 ---------------- */

const rawStart = readJson(path.join(process.cwd(), 'runtime-config.json')) || {};
const cfg = (rawStart.config && typeof rawStart.config === 'object') ? rawStart.config : {};

/** 解析 host/port：支持直接粘贴游戏里的「Local game hosted on port 12345」。 */
function parseEndpoint(hostInput, portInput) {
  let host = String(hostInput == null ? '' : hostInput).trim().replace(/^https?:\/\//i, '');
  let port = parseInt(portInput, 10) || 0;
  const m = host.match(/hosted on port\s+(\d{1,5})/i);
  if (m) {
    // 单人开房间时端口是随机的，世界里只会给出端口；对局就在本机。
    return { host: '127.0.0.1', port: parseInt(m[1], 10), fromLanHint: true };
  }
  const withPort = host.match(/^([A-Za-z0-9._-]+):(\d{1,5})$/);
  if (withPort) {
    host = withPort[1];
    if (!port) port = parseInt(withPort[2], 10);
  }
  if (!host) host = '127.0.0.1';
  if (!port) port = 25565;
  return { host, port, fromLanHint: false };
}

const endpoint = parseEndpoint(cfg.host, cfg.port);
const CONFIG = {
  host: endpoint.host,
  port: endpoint.port,
  username: String(cfg.username || 'Elly').trim().slice(0, 16) || 'Elly',
  version: String(cfg.version || '').trim(),
  allowActions: String(cfg.allowActions || 'full') === 'safe' ? 'safe' : 'full',
  autoReconnect: cfg.autoReconnect !== false,
  allowedHosts: String(cfg.allowedHosts || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
};
const SAFE_MODE = CONFIG.allowActions === 'safe';
const DANGEROUS_ACTIONS = ['dig', 'digAt', 'place', 'placeAt', 'attack', 'attackNearest', 'toss'];

/* ---------------- 状态文件 ---------------- */

let bot = null;
let connecting = false;
let reconnects = 0;
let reconnectTimer = null;
let stopping = false;
let lastResult = null;
let lastError = '';
let lastEvent = 'start';
let dirty = true;
let lastStatusWrite = 0;
let movements = null;
let currentAction = '';

/** 状态快照：面板按 username/health/food/position/onGround/players/connected/event 读取。 */
function snapshot() {
  const entity = bot && bot.entity;
  const state = {
    ts: Date.now(),
    plugin: (rawStart.plugin && rawStart.plugin.name) || 'Minecraft 联机助手',
    connected: !!(bot && bot.entity),
    connecting: connecting,
    host: CONFIG.host,
    port: CONFIG.port,
    lanHint: endpoint.fromLanHint,
    username: bot ? bot.username : CONFIG.username,
    version: bot ? bot.version : (CONFIG.version || ''),
    allowActions: CONFIG.allowActions,
    autoReconnect: CONFIG.autoReconnect,
    reconnects: reconnects,
    controlPort: CONTROL_PORT,
    health: bot && bot.health != null ? Math.round(bot.health * 10) / 10 : null,
    food: bot && bot.food != null ? Math.round(bot.food * 10) / 10 : null,
    position: entity ? {
      x: Math.round(entity.position.x * 100) / 100,
      y: Math.round(entity.position.y * 100) / 100,
      z: Math.round(entity.position.z * 100) / 100,
      yaw: Math.round(entity.yaw * 100) / 100
    } : null,
    onGround: entity ? !!entity.onGround : null,
    players: bot && bot.players ? Object.keys(bot.players).filter(n => n !== bot.username) : [],
    nearbyPlayers: bot && bot.players ? Object.keys(bot.players).filter(n => n !== bot.username && bot.players[n].entity).map(n => {
      const e = bot.players[n].entity;
      return { name: n, pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } };
    }) : [],
    // 连接尚未进入世界时 inventory 还没有，取快照不能因为只读状态把进程带崩。
    inventory: bot && bot.inventory && typeof bot.inventory.items === 'function'
      ? bot.inventory.items().slice(0, 36).map(i => ({ name: i.name, count: i.count })) : [],
    currentAction: currentAction || null,
    lastResult: lastResult,
    lastError: lastError,
    event: lastEvent
  };
  return state;
}
function writeStatus(force) {
  const now = Date.now();
  if (!force && !dirty && now - lastStatusWrite < STATUS_INTERVAL_MS) return;
  lastStatusWrite = now;
  dirty = false;
  let snap;
  try { snap = snapshot(); } catch (e) { log('生成状态失败：' + e.message); return; }
  writeJsonAtomic(path.join(process.cwd(), 'status.json'), snap);
}

/* ---------------- 聊天记录 ---------------- */

function appendChat(user, msg) {
  try {
    const file = path.join(process.cwd(), 'chat.log');
    const line = JSON.stringify({ ts: Date.now(), user: String(user || ''), msg: String(msg || '').slice(0, 300) }) + '\n';
    if (fs.existsSync(file) && fs.statSync(file).size + line.length > CHAT_MAX_BYTES) {
      const keep = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, keep.slice(Math.floor(keep.length / 2)));
    }
    fs.appendFileSync(file, line);
  } catch (e) { /* 聊天记录失败不影响主流程 */ }
}

/** 读最近聊天：since 是毫秒时间戳，返回其后的消息（最多 CHAT_READ_MAX 条）。 */
function readChat(sinceTs, limit) {
  const file = path.join(process.cwd(), 'chat.log');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { return []; }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let item;
    try { item = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!item || typeof item.ts !== 'number') continue;
    if (sinceTs > 0 && item.ts <= sinceTs) continue;
    out.push({ ts: item.ts, user: String(item.user || ''), msg: String(item.msg || '') });
  }
  return out.slice(-limit);
}

/* ---------------- 审计 ---------------- */

/** 每个被执行的指令都落一行 JSON，便于事后核对 AI 到底做了什么。 */
function audit(record) {
  try {
    const file = path.join(process.cwd(), 'audit.log');
    const line = JSON.stringify(record) + '\n';
    if (fs.existsSync(file) && fs.statSync(file).size + line.length > AUDIT_MAX_BYTES) {
      const keep = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, keep.slice(Math.floor(keep.length / 2)));
    }
    fs.appendFileSync(file, line);
  } catch (e) { /* 审计失败不影响主流程 */ }
}

const actionTimes = [];
function rateLimited() {
  const now = Date.now();
  while (actionTimes.length && now - actionTimes[0] > 60000) actionTimes.shift();
  if (actionTimes.length >= RATE_LIMIT_PER_MIN) return true;
  actionTimes.push(now);
  return false;
}

/** 审计里只保留动作和关键参数，不落整段聊天以外的自由文本。 */
function auditArgs(cmd) {
  const keys = ['direction', 'ticks', 'x', 'y', 'z', 'player', 'distance', 'item', 'count', 'filter', 'timeoutMs'];
  const out = {};
  keys.forEach(k => { if (cmd[k] != null) out[k] = typeof cmd[k] === 'string' ? cmd[k].slice(0, 64) : cmd[k]; });
  if (cmd.text != null) out.text = String(cmd.text).slice(0, 80);
  return out;
}

/* ---------------- 动作 ---------------- */

function fail(message) { return { ok: false, error: message }; }

function distTo(p) {
  const e = bot && bot.entity;
  if (!e || !p) return 0;
  const dx = e.position.x - p.x, dy = e.position.y - p.y, dz = e.position.z - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function intArg(v, name) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error('参数 ' + name + ' 必须是整数');
  return n;
}
function numArg(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('参数 ' + name + ' 必须是数字');
  return n;
}
function itemByName(name) {
  const key = String(name || '').toLowerCase();
  const items = bot.inventory.items();
  return key ? (items.filter(i => i.name === key)[0] || items.filter(i => i.name.indexOf(key) >= 0)[0] || null) : null;
}
function findPlaceableItem(hint) {
  const hinted = hint ? itemByName(hint) : null;
  if (hinted) return hinted;
  if (!hint) {
    const blocks = (bot.registry && bot.registry.blocksByName) || {};
    const hit = bot.inventory.items().filter(i => !!blocks[i.name])[0];
    if (hit) return hit;
  }
  return null;
}
function unitFace(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) return { x: Math.sign(dx), y: 0, z: 0 };
  if (Math.abs(dy) >= Math.abs(dz)) return { x: 0, y: Math.sign(dy), z: 0 };
  return { x: 0, y: 0, z: Math.sign(dz) };
}
/** 在 target 格放方块：找一个相邻实心方块当参考面。 */
async function placeAt(targetPos, itemName) {
  const vec3 = require('vec3');
  const target = bot.blockAt(new vec3(targetPos.x, targetPos.y, targetPos.z));
  if (!target) return fail('目标位置不在已加载的区块里');
  if (target.name !== 'air' && target.name !== 'cave_air' && target.name !== 'void_air') return fail('目标位置不是空气：' + target.name);
  const item = findPlaceableItem(itemName);
  if (!item) return fail(itemName ? ('背包里没有方块：' + itemName) : '背包里没有可放置的方块');
  await bot.equip(item, 'hand');
  const around = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (const off of around) {
    const pos = { x: target.position.x + off[0], y: target.position.y + off[1], z: target.position.z + off[2] };
    const ref = bot.blockAt(new vec3(pos.x, pos.y, pos.z));
    if (!ref || ref.name === 'air' || ref.name === 'cave_air' || ref.name === 'void_air') continue;
    const face = unitFace(ref.position, target.position);
    await bot.placeBlock(ref, new vec3(face.x, face.y, face.z));
    return { ok: true, action: 'placeAt', block: item.name, pos: targetPos };
  }
  return fail('目标四周没有可依附的方块');
}
function nearestHostile(range) {
  return bot.nearestEntity(e => e !== bot.entity && e.type !== 'player' &&
    /(zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|phantom|pillager|vindicator|ravager|blaze|slime|magma_cube|wither)/i.test(e.name || '') &&
    distTo(e.position) <= range);
}
async function gotoWithTimeout(goal, timeoutMs) {
  const timer = sleep(timeoutMs).then(() => 'timeout');
  const run = bot.pathfinder.goto(goal).then(() => 'ok', e => 'error:' + e.message);
  const out = await Promise.race([run, timer]);
  if (out !== 'ok') {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    if (out === 'timeout') return fail('寻路超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
    return fail('寻路失败：' + out.slice(6));
  }
  return null;
}

async function execute(cmd) {
  const type = String(cmd.action || '').trim();
  if (!type) return fail('缺少 action');
  if (!bot || !bot.entity) return fail('bot 尚未连接游戏');
  if (SAFE_MODE && DANGEROUS_ACTIONS.indexOf(type) >= 0) {
    return fail('当前是安全模式（只允许移动/寻路/聊天/查看）；要挖掘、放置或攻击请到插件配置把「行为边界」改成完整');
  }
  const vec3 = require('vec3');
  currentAction = type;
  try {
    switch (type) {
      case 'say': {
        const text = String(cmd.text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
        if (!text) return fail('聊天内容不能为空');
        bot.chat(text);
        return { ok: true, action: 'say', text };
      }
      case 'move': {
        const dir = String(cmd.direction || cmd.dir || 'forward');
        const valid = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
        if (valid.indexOf(dir) < 0) return fail('无效方向：' + dir + '（可用 ' + valid.join('/') + '）');
        const ticks = Math.max(1, Math.min(200, intArg(cmd.ticks == null ? 10 : cmd.ticks, 'ticks')));
        bot.setControlState(dir, true);
        await bot.waitForTicks(ticks);
        bot.setControlState(dir, false);
        return { ok: true, action: 'move', direction: dir, ticks };
      }
      case 'jump': {
        bot.setControlState('jump', true);
        await bot.waitForTicks(10);
        bot.setControlState('jump', false);
        return { ok: true, action: 'jump' };
      }
      case 'look': {
        const yaw = numArg(cmd.yaw, 'yaw');
        const pitch = cmd.pitch == null ? 0 : numArg(cmd.pitch, 'pitch');
        await bot.look(yaw, pitch, true);
        return { ok: true, action: 'look', yaw, pitch };
      }
      case 'lookAt': {
        await bot.lookAt(new vec3(numArg(cmd.x, 'x'), numArg(cmd.y, 'y'), numArg(cmd.z, 'z')), true);
        return { ok: true, action: 'lookAt' };
      }
      case 'dig': {
        const block = bot.blockAtCursor(4);
        if (!block) return fail('视线 4 格内没有方块');
        await bot.dig(block);
        return { ok: true, action: 'dig', block: block.name };
      }
      case 'digAt': {
        const pos = { x: intArg(cmd.x, 'x'), y: intArg(cmd.y, 'y'), z: intArg(cmd.z, 'z') };
        if (distTo(pos) > MAX_TARGET_DISTANCE) return fail('目标太远（上限 ' + MAX_TARGET_DISTANCE + ' 格）');
        const block = bot.blockAt(new vec3(pos.x, pos.y, pos.z));
        if (!block) return fail('目标位置不在已加载的区块里');
        if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return fail('目标位置已经是空气');
        await bot.dig(block);
        return { ok: true, action: 'digAt', block: block.name, pos };
      }
      case 'place': {
        const ref = bot.blockAtCursor(4);
        if (!ref) return fail('视线 4 格内没有可依附的方块');
        return await placeAt({ x: ref.position.x, y: ref.position.y + 1, z: ref.position.z }, cmd.item);
      }
      case 'placeAt': {
        const pos = { x: intArg(cmd.x, 'x'), y: intArg(cmd.y, 'y'), z: intArg(cmd.z, 'z') };
        if (distTo(pos) > MAX_TARGET_DISTANCE) return fail('目标太远（上限 ' + MAX_TARGET_DISTANCE + ' 格）');
        return await placeAt(pos, cmd.item);
      }
      case 'attack': {
        const target = bot.nearestEntity(e => e !== bot.entity && (e.type === 'mob' || e.type === 'hostile') && distTo(e.position) <= 4);
        if (!target) return fail('4 格内没有可以攻击的生物');
        await bot.attack(target);
        return { ok: true, action: 'attack', target: target.name || target.username || target.type };
      }
      case 'attackNearest': {
        if (cmd.filter === 'player') return fail('不允许攻击玩家；只允许攻击敌对生物');
        const target = nearestHostile(16);
        if (!target) return fail('16 格内没有敌对生物');
        await bot.attack(target);
        return { ok: true, action: 'attackNearest', target: target.name || target.type };
      }
      case 'flee': {
        const threat = nearestHostile(16);
        if (!threat) return fail('16 格内没有需要躲避的敌对生物');
        const { goals } = require('mineflayer-pathfinder');
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 12)), true);
        await sleep(3000);
        try { bot.pathfinder.setGoal(null); } catch (e) {}
        return { ok: true, action: 'flee', from: threat.name || threat.type, distance: Math.round(distTo(threat.position)) };
      }
      case 'pathfind': {
        const pos = { x: Math.floor(numArg(cmd.x, 'x')), y: Math.floor(numArg(cmd.y, 'y')), z: Math.floor(numArg(cmd.z, 'z')) };
        if (distTo(pos) > MAX_TARGET_DISTANCE) return fail('目标太远（上限 ' + MAX_TARGET_DISTANCE + ' 格）');
        const { goals } = require('mineflayer-pathfinder');
        const bad = await gotoWithTimeout(new goals.GoalBlock(pos.x, pos.y, pos.z), Math.max(5000, Math.min(60000, intArg(cmd.timeoutMs == null ? 25000 : cmd.timeoutMs, 'timeoutMs'))));
        return bad || { ok: true, action: 'pathfind', pos };
      }
      case 'follow': {
        const name = String(cmd.player || '').trim();
        if (!name) return fail('需要 player 参数');
        const p = bot.players[name];
        if (!p || !p.entity) return fail('找不到玩家：' + name);
        const { goals } = require('mineflayer-pathfinder');
        const distance = Math.max(1, Math.min(8, intArg(cmd.distance == null ? 2 : cmd.distance, 'distance')));
        bot.pathfinder.setGoal(new goals.GoalFollow(p.entity, distance), true);
        return { ok: true, action: 'follow', player: name, distance, note: '跟随会持续到 stop' };
      }
      case 'equip': {
        const item = itemByName(cmd.item);
        if (!item) return fail('背包里没有物品：' + String(cmd.item || ''));
        await bot.equip(item, cmd.hand === 'off-hand' ? 'off-hand' : 'hand');
        return { ok: true, action: 'equip', item: item.name };
      }
      case 'toss': {
        const item = itemByName(cmd.item);
        if (!item) return fail('背包里没有物品：' + String(cmd.item || ''));
        const count = Math.max(1, Math.min(item.count, intArg(cmd.count == null ? 1 : cmd.count, 'count')));
        await bot.toss(item.type, null, count);
        return { ok: true, action: 'toss', item: item.name, count };
      }
      case 'stop': {
        try { bot.pathfinder.setGoal(null); } catch (e) {}
        ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach(c => bot.setControlState(c, false));
        try { bot.stopDigging(); } catch (e) {}
        return { ok: true, action: 'stop' };
      }
      case 'status':
        return { ok: true, action: 'status', status: snapshot() };
      default:
        return fail('未知动作：' + type + '（可用 say/move/jump/look/lookAt/dig/digAt/place/placeAt/attack/attackNearest/flee/pathfind/follow/equip/toss/stop/status）');
    }
  } catch (e) {
    return fail(type + ' 失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    currentAction = '';
    dirty = true;
  }
}

/* ---------------- 连接 ---------------- */

function loadMineflayer() {
  let mineflayer, pathfinderMod, mcDataFn;
  try {
    mineflayer = require('mineflayer');
    pathfinderMod = require('mineflayer-pathfinder');
    mcDataFn = require('minecraft-data');
    require('vec3');
  } catch (e) {
    log('缺少 Node 依赖：' + e.message);
    log('请先在插件运行面板点「一键准备环境」，或在 Termux 里执行：npm install -g mineflayer mineflayer-pathfinder minecraft-data vec3');
    lastError = '缺少 Node 依赖：' + e.message;
    lastEvent = 'missing-dependency';
    writeStatus(true);
    process.exit(2);
  }
  return { mineflayer, pathfinderMod, mcDataFn };
}

function connect() {
  if (stopping) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connecting = true;
  lastEvent = reconnects > 0 ? 'reconnect' : 'connecting';
  dirty = true;
  writeStatus(true);
  log('连接 ' + CONFIG.host + ':' + CONFIG.port + '（离线登录，玩家名 ' + CONFIG.username + '）');
  const { mineflayer, pathfinderMod, mcDataFn } = loadMineflayer();
  let next;
  try {
    next = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      auth: 'offline',
      version: CONFIG.version || false,
      hideErrors: true
    });
  } catch (e) {
    connecting = false;
    lastError = '创建连接失败：' + e.message;
    lastEvent = 'error';
    dirty = true;
    writeStatus(true);
    scheduleReconnect();
    return;
  }
  bot = next;
  next.loadPlugin(pathfinderMod.pathfinder);

  next.on('spawn', () => {
    connecting = false;
    reconnects = 0;
    lastError = '';
    lastEvent = 'spawn';
    log('已进入世界，版本 ' + next.version);
    try {
      movements = new pathfinderMod.Movements(next, mcDataFn(next.version));
      movements.canDig = false;          // 寻路不挖方块，避免破坏你的世界
      movements.allow1by1towers = false; // 不自动垫柱子
      next.pathfinder.setMovements(movements);
    } catch (e) { log('寻路初始化失败：' + e.message); }
    dirty = true;
    writeStatus(true);
  });

  next.on('chat', (username, message) => {
    if (!username || username === next.username) return;
    appendChat(username, message);
    log('[聊天] ' + username + ': ' + message.slice(0, 160));
    dirty = true;
  });

  next.on('playerJoined', p => { log('玩家进入：' + p.username); dirty = true; });
  next.on('playerLeft', p => { log('玩家离开：' + p.username); dirty = true; });
  next.on('health', () => { dirty = true; });
  next.on('death', () => {
    lastEvent = 'death';
    lastError = 'bot 死亡，等待复活或服务器处理';
    log('bot 死亡，坐标 ' + JSON.stringify(next.entity ? next.entity.position : null));
    dirty = true;
    writeStatus(true);
  });
  next.on('kicked', reason => {
    lastError = '被服务器踢出：' + (typeof reason === 'string' ? reason : JSON.stringify(reason)).slice(0, 300);
    lastEvent = 'kicked';
    log(lastError);
    dirty = true;
  });
  next.on('error', err => {
    lastError = '连接错误：' + (err && err.message ? err.message : String(err));
    lastEvent = 'error';
    log(lastError);
    dirty = true;
  });
  next.on('end', reason => {
    connecting = false;
    bot = null;
    lastEvent = 'end';
    log('连接结束（' + String(reason || '未知') + '）');
    dirty = true;
    writeStatus(true);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stopping || !CONFIG.autoReconnect || reconnectTimer) return;
  reconnects++;
  const delay = Math.min(60000, 3000 * Math.pow(2, Math.min(reconnects - 1, 5)));
  lastEvent = 'waiting-reconnect';
  log(Math.round(delay / 1000) + ' 秒后重连（第 ' + reconnects + ' 次）');
  dirty = true;
  writeStatus(true);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

/* ---------------- 本机控制接口 ---------------- */

const queue = [];
let running = false;

function enqueue(cmd) {
  return new Promise((resolve, reject) => {
    if (queue.length >= 8) return reject(new Error('命令队列已满，请稍后再试'));
    queue.push({ cmd, resolve, reject });
    pump();
  });
}
async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  const started = Date.now();
  const cmd = job.cmd || {};
  const action = String(cmd.action || '').trim();
  try {
    // status 是只读快照，不参与限频；其它动作每分钟最多 RATE_LIMIT_PER_MIN 个。
    let result;
    if (action !== 'status' && rateLimited()) {
      result = { ok: false, error: '动作太频繁：每分钟最多 ' + RATE_LIMIT_PER_MIN + ' 个，请稍后再试' };
    } else {
      result = await execute(cmd);
    }
    lastResult = { ts: Date.now(), action: action, ok: result.ok, error: result.error || '' };
    if (result.ok) lastError = ''; else lastError = String(result.error || '');
    audit({ ts: Date.now(), action: action, ok: result.ok === true, error: result.ok ? '' : String(result.error || '').slice(0, 240), ms: Date.now() - started, args: auditArgs(cmd) });
    dirty = true;
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    running = false;
    writeStatus(true);
    if (queue.length) pump();
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
  res.end(body);
}
function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function readQuery(req, key) {
  const q = String((req.url || '')).split('?')[1] || '';
  const parts = q.split('&');
  for (let i = 0; i < parts.length; i++) {
    const kv = parts[i].split('=');
    if (decodeURIComponent(kv[0] || '') === key) {
      try { return decodeURIComponent(kv.slice(1).join('=') || ''); } catch (e) { return ''; }
    }
  }
  return '';
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: '只接受本机连接' }); return; }
    const url = String(req.url || '/').split('?')[0];
    if (req.method === 'GET' && (url === '/status' || url === '/health')) {
      sendJson(res, 200, Object.assign({ ok: true }, snapshot()));
      return;
    }
    if (req.method === 'GET' && url === '/chat') {
      const since = Math.max(0, parseInt(readQuery(req, 'since'), 10) || 0);
      const limit = Math.max(1, Math.min(CHAT_READ_MAX, parseInt(readQuery(req, 'limit'), 10) || 30));
      const messages = readChat(since, limit);
      const lastTs = messages.length ? messages[messages.length - 1].ts : since;
      sendJson(res, 200, { ok: true, since: since, lastTs: lastTs, count: messages.length, messages: messages });
      return;
    }
    if (req.method !== 'POST' || url !== '/cmd') {
      sendJson(res, 404, { ok: false, error: '未知接口：' + req.method + ' ' + url + '（可用 GET /status、GET /chat、POST /cmd）' });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { sendJson(res, 413, { ok: false, error: '请求体过大' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let cmd;
      try { cmd = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) { sendJson(res, 400, { ok: false, error: '指令必须是对象' }); return; }
      enqueue(cmd).then(
        r => sendJson(res, 200, r),
        e => sendJson(res, 429, { ok: false, error: (e && e.message) || '执行失败' })
      );
    });
    req.on('error', () => { try { res.destroy(); } catch (e) {} });
  });
  server.on('error', e => {
    lastError = '控制端口 ' + CONTROL_PORT + ' 不可用：' + e.message;
    lastEvent = 'error';
    log(lastError);
    dirty = true;
    writeStatus(true);
    process.exit(3);
  });
  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    log('控制接口已就绪：http://127.0.0.1:' + CONTROL_PORT + '（只监听本机）');
  });
  return server;
}

/* ---------------- 启动 ---------------- */

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('收到 ' + signal + '，正在停止…');
  try { if (bot) bot.quit(); } catch (e) {}
  lastEvent = 'stopped';
  lastError = '';
  dirty = true;
  writeStatus(true);
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => {
  log('未捕获异常：' + (e && e.stack ? e.stack : e));
  lastError = '未捕获异常：' + (e && e.message ? e.message : e);
  dirty = true;
  writeStatus(true);
});

function validateConfig() {
  const bad = [];
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(CONFIG.host)) bad.push('host 不合法：' + CONFIG.host);
  if (!(CONFIG.port >= 1 && CONFIG.port <= 65535)) bad.push('port 不合法：' + CONFIG.port);
  if (!/^[A-Za-z0-9_]{1,16}$/.test(CONFIG.username)) bad.push('用户名只允许字母、数字和下划线，最长 16 位');
  if (CONFIG.allowedHosts.length && CONFIG.allowedHosts.indexOf(CONFIG.host.toLowerCase()) < 0) {
    bad.push('host ' + CONFIG.host + ' 不在授权列表（' + CONFIG.allowedHosts.join('、') + '）里');
  }
  return bad;
}

function main() {
  log('ElysiaFloat Minecraft 桥接进程启动，工作目录 ' + process.cwd());
  const bad = validateConfig();
  if (bad.length) {
    lastError = bad.join('；');
    lastEvent = 'config-error';
    dirty = true;
    writeStatus(true);
    log('配置错误：' + lastError);
    process.exit(2);
    return;
  }
  log('目标 ' + CONFIG.host + ':' + CONFIG.port +
    (endpoint.fromLanHint ? '（已从「Local game hosted on port」解析为本机端口）' : '') +
    '；行为边界 ' + (SAFE_MODE ? '安全模式' : '完整') + '；自动重连 ' + (CONFIG.autoReconnect ? '开' : '关'));
  startServer();
  writeStatus(true);
  connect();
  setInterval(() => { dirty = true; writeStatus(false); }, STATUS_INTERVAL_MS);
}

main();
