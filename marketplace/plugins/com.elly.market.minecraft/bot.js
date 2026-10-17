// ElysiaFloat Minecraft Bot
// 通过 JSON 指令文件接收 AI 控制，通过状态文件回报环境信息
// 依赖：mineflayer, mineflayer-pathfinder, minecraft-data, vec3

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const fs = require('fs');

const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '19132', 10),
  username: process.env.MC_USERNAME || 'Elly',
  cmdFile: process.env.MC_CMD_FILE || '/data/data/com.termux/files/home/mc-bot/cmd.json',
  statusFile: process.env.MC_STATUS_FILE || '/data/data/com.termux/files/home/mc-bot/status.json',
  chatLogFile: process.env.MC_CHAT_FILE || '/data/data/com.termux/files/home/mc-bot/chat.log'
};

let bot = null;
let currentAction = null;
let lastStatusUpdate = 0;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function writeStatus(extra) {
  if (!bot) return;
  const now = Date.now();
  if (now - lastStatusUpdate < 500) return; // 最多 2 次/秒
  lastStatusUpdate = now;
  try {
    const entity = bot.entity;
    const status = {
      ts: now,
      connected: true,
      username: bot.username,
      health: Math.round(bot.health * 10) / 10,
      hunger: Math.round(bot.food * 10) / 10,
      position: entity ? {
        x: Math.round(entity.position.x * 100) / 100,
        y: Math.round(entity.position.y * 100) / 100,
        z: Math.round(entity.position.z * 100) / 100,
        yaw: Math.round(entity.yaw * 100) / 100
      } : null,
      onGround: entity ? entity.onGround : false,
      inventory: bot.inventory.items().map(i => ({
        name: i.name, count: i.count, slot: i.slot
      })),
      equipment: bot.equipment ? Object.entries(bot.equipment).filter(([, v]) => v).map(([k, v]) => ({ slot: k, name: v.name })) : [],
      nearbyPlayers: Object.entries(bot.players).map(([name, p]) => ({
        name,
        pos: p.entity ? { x: Math.round(p.entity.position.x), y: Math.round(p.entity.position.y), z: Math.round(p.entity.position.z) } : null
      })).filter(p => p.pos),
      currentAction: currentAction ? { type: currentAction.type, at: currentAction.at } : null
    };
    if (extra) Object.assign(status, extra);
    fs.writeFileSync(CONFIG.statusFile, JSON.stringify(status, null, 2));
  } catch (e) {
    log('status write error: ' + e.message);
  }
}

function appendChat(username, message) {
  try {
    const line = JSON.stringify({ ts: Date.now(), user: username, msg: message }) + '\n';
    fs.appendFileSync(CONFIG.chatLogFile, line);
  } catch (e) {}
}

async function executeAction(action) {
  if (!bot) return { ok: false, error: 'not connected' };
  currentAction = { type: action.action || action.type, at: Date.now() };
  const type = action.action || action.type;
  try {
    switch (type) {
      case 'say': {
        bot.chat(String(action.text || ''));
        return { ok: true, action: 'say' };
      }
      case 'move': {
        const dir = String(action.direction || action.dir || 'forward');
        const ticks = Math.max(1, Math.min(200, parseInt(action.ticks || action.duration || 10, 10)));
        const valid = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
        if (!valid.includes(dir)) return { ok: false, error: 'invalid direction: ' + dir };
        bot.setControlState(dir, true);
        await bot.waitForTicks(ticks);
        bot.setControlState(dir, false);
        return { ok: true, action: 'move', direction: dir, ticks };
      }
      case 'look': {
        const yaw = parseFloat(action.yaw);
        const pitch = action.pitch != null ? parseFloat(action.pitch) : 0;
        if (isNaN(yaw)) return { ok: false, error: 'invalid yaw' };
        await bot.look(yaw, pitch);
        return { ok: true, action: 'look', yaw, pitch };
      }
      case 'lookAt': {
        const x = parseFloat(action.x), y = parseFloat(action.y), z = parseFloat(action.z);
        if ([x, y, z].some(isNaN)) return { ok: false, error: 'invalid coordinates' };
        await bot.lookAt(vec3(x, y, z));
        return { ok: true, action: 'lookAt' };
      }
      case 'dig': {
        const block = bot.blockAtCursor(5);
        if (!block) return { ok: false, error: 'no block in sight' };
        await bot.dig(block);
        return { ok: true, action: 'dig', block: block.name };
      }
      case 'digAt': {
        const x = parseInt(action.x), y = parseInt(action.y), z = parseInt(action.z);
        if ([x, y, z].some(isNaN)) return { ok: false, error: 'invalid coordinates' };
        const block = bot.blockAt(vec3(x, y, z));
        if (!block) return { ok: false, error: 'no block at position' };
        await bot.dig(block);
        return { ok: true, action: 'digAt', block: block.name, pos: { x, y, z } };
      }
      case 'place': {
        const block = bot.blockAtCursor(5);
        if (!block) return { ok: false, error: 'no block in sight to place against' };
        const facing = action.facing || 'top';
        const faceMap = { top: 1, bottom: 0, north: 2, south: 3, east: 5, west: 4 };
        await bot.placeBlock(block, new vec3(0, 0, 0));
        return { ok: true, action: 'place' };
      }
      case 'attack': {
        const target = bot.nearestEntity(e => e.type === 'mob' || e.type === 'player');
        if (!target) return { ok: false, error: 'no entity to attack' };
        await bot.attack(target);
        return { ok: true, action: 'attack', target: target.name || target.type };
      }
      case 'attackNearest': {
        const filter = action.filter || 'mob';
        const target = bot.nearestEntity(e => e.type === filter || (filter === 'player' && e.type === 'player'));
        if (!target) return { ok: false, error: 'no ' + filter + ' nearby' };
        await bot.attack(target);
        return { ok: true, action: 'attackNearest', target: target.name || target.type };
      }
      case 'activate': {
        bot.activateItem();
        return { ok: true, action: 'activate' };
      }
      case 'deactivate': {
        bot.deactivateItem();
        return { ok: true, action: 'deactivate' };
      }
      case 'equip': {
        const itemName = String(action.item || '');
        const item = bot.inventory.items().find(i => i.name.includes(itemName));
        if (!item) return { ok: false, error: 'item not found: ' + itemName };
        await bot.equip(item, action.hand || 'hand');
        return { ok: true, action: 'equip', item: item.name };
      }
      case 'toss': {
        const itemName = String(action.item || '');
        const item = bot.inventory.items().find(i => i.name.includes(itemName));
        if (!item) return { ok: false, error: 'item not found: ' + itemName };
        await bot.toss(item.type, null, action.count || item.count);
        return { ok: true, action: 'toss', item: item.name };
      }
      case 'pathfind': {
        const x = parseFloat(action.x), y = parseFloat(action.y), z = parseFloat(action.z);
        if ([x, y, z].some(isNaN)) return { ok: false, error: 'invalid coordinates' };
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
        await bot.pathfinder.goto(goal);
        return { ok: true, action: 'pathfind', target: { x, y, z } };
      }
      case 'pathfindToPlayer': {
        const targetName = String(action.player || '');
        const player = bot.players[targetName];
        if (!player || !player.entity) return { ok: false, error: 'player not found: ' + targetName };
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        const goal = new goals.GoalFollow(player.entity, 2);
        await bot.pathfinder.goto(goal);
        return { ok: true, action: 'pathfindToPlayer', player: targetName };
      }
      case 'stop': {
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
        ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach(c => bot.setControlState(c, false));
        return { ok: true, action: 'stop' };
      }
      case 'jump': {
        bot.setControlState('jump', true);
        await bot.waitForTicks(10);
        bot.setControlState('jump', false);
        return { ok: true, action: 'jump' };
      }
      case 'status': {
        return { ok: true, action: 'status' };
      }
      default:
        return { ok: false, error: 'unknown action: ' + type };
    }
  } catch (e) {
    return { ok: false, action: type, error: e.message };
  } finally {
    currentAction = null;
  }
}

function connect() {
  log(`Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}...`);
  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    hideErrors: false
  });

  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    log('Spawned in world');
    writeStatus({ event: 'spawn' });
  });

  bot.on('chat', (username, message) => {
    appendChat(username, message);
    log(`[CHAT] ${username}: ${message}`);
  });

  bot.on('playerJoined', (player) => {
    log(`Player joined: ${player.username}`);
  });

  bot.on('playerLeft', (player) => {
    log(`Player left: ${player.username}`);
  });

  bot.on('health', () => {
    writeStatus();
  });

  bot.on('death', () => {
    log('Died');
    writeStatus({ event: 'death' });
  });

  bot.on('kicked', (reason) => {
    log('Kicked: ' + reason);
    writeStatus({ event: 'kicked', reason: String(reason) });
  });

  bot.on('error', (err) => {
    log('Error: ' + err.message);
  });

  bot.on('end', () => {
    log('Disconnected');
    bot = null;
    writeStatus({ connected: false, event: 'end' });
    setTimeout(connect, 5000);
  });
}

// 主循环：读取指令文件并执行
async function mainLoop() {
  if (!bot) {
    setTimeout(mainLoop, 500);
    return;
  }
  try {
    const cmd = safeReadJson(CONFIG.cmdFile);
    if (cmd && cmd.action) {
      log('Executing: ' + cmd.action);
      const result = await executeAction(cmd);
      log('Result: ' + JSON.stringify(result));
      // 写入结果并删除指令文件
      const resultFile = CONFIG.cmdFile.replace(/\.json$/, '.result.json');
      fs.writeFileSync(resultFile, JSON.stringify({ ts: Date.now(), result }));
      try { fs.unlinkSync(CONFIG.cmdFile); } catch (e) {}
      writeStatus({ lastResult: result });
    } else {
      writeStatus();
    }
  } catch (e) {
    log('Loop error: ' + e.message);
  }
  setTimeout(mainLoop, 200);
}

connect();
setTimeout(mainLoop, 1000);
