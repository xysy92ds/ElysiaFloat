/*
 * 运行期冒烟测试 —— 用假的 DOM/桥接把 assets/index.html 里的脚本真跑一遍。
 *
 * 加载器已抽到 tools/harness.js，行为测试 tools/behavior.test.js 共用同一套沙箱。
 *
 * 用法：node tools/smoke.js
 */
'use strict';

const { html, sandbox, T, errors, calls, store, ENVINFO, Android, Perm, vm, SCREEN_STUB } = require('./harness');
const h_perm = Perm;


function step(name, fn) {
  if (!T) { errors.push(name + ': 拿不到内部符号 __T（脚本没跑完）'); return; }
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => console.log('  ✓ ' + name), e => {
        errors.push(name + ': ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
      });
    }
    console.log('  ✓ ' + name);
  } catch (e) {
    errors.push(name + ': ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }
}

(async () => {
  console.log('内部符号导出：' + (T ? 'OK（' + Object.keys(T).length + ' 个）' : '失败'));
  console.log('冒烟用例：');

  step('MP() 能拿到原生播放器句柄', () => {
    if (typeof T.MP !== 'function') throw new Error('MP 未定义');
    if (T.MP() !== Android) throw new Error('MP() 没返回 Android 桥');
  });

  await step('buildTools() 含音乐工具且开关生效', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    let names = T.buildTools().map(t => t.function.name);
    if (!names.includes('search_and_play_music')) throw new Error('缺 search_and_play_music');
    if (!names.includes('music_control')) throw new Error('缺 music_control');
    T.CONFIG.musicEnabled = false;
    const off = T.buildTools().map(t => t.function.name);
    T.CONFIG.musicEnabled = before;
    if (off.includes('music_control')) throw new Error('关掉音乐后 music_control 还能调');
    if (off.includes('search_and_play_music')) throw new Error('关掉音乐后 search_and_play_music 还能调');
  });

  await step('buildToolsPrompt() 含音乐段落', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    const p = T.buildToolsPrompt();
    T.CONFIG.musicEnabled = before;
    if (!/music_control/.test(p)) throw new Error('提示词里没列 music_control');
  });

  await step('Agent 新工具：应用解析、无限轮数和工作区开关结构', () => {
    if (T.CONFIG.agentToolRounds !== 0) throw new Error('默认工具轮数不是无限');
    if (!html.includes('rawMaxRounds') || !html.includes('maxRounds = rawMaxRounds === 0') || !html.includes("{v:'0',t:'按任务时间'}")) throw new Error('0 轮配置没有真正接入按任务时间语义');
    if (!T.PLUGINS.some(p => p.id === 'agent') || !T.PLUGINS.some(p => p.id === 'files')) throw new Error('缺 Agent/工作区插件');
    const old = {
      enabled: T.CONFIG.agentEnabled, l1: T.CONFIG.agentL1, l3: T.CONFIG.agentL3, safety: T.CONFIG.agentSafety,
      access: Perm.hasAllFilesAccess, state: Perm.workspaceState
    };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL1 = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    Perm.hasAllFilesAccess = () => true;
    Perm.workspaceState = () => JSON.stringify({ permission: true, created: true });
    const names = T.buildTools().map(t => t.function.name);
    if (!names.includes('find_app') || !names.includes('watch_screen')) throw new Error('缺应用查询或限时观察工具');
    if (!names.includes('workspace_read') || !names.includes('workspace_write')) throw new Error('缺工作区读写工具');
    if (!names.includes('external_file_read') || !names.includes('external_file_write') || !names.includes('external_file_copy') || !names.includes('external_file_delete')) throw new Error('缺公共存储文件修改工具');
    for (const marker of ['external_file_write', 'external_file_copy', 'external_file_mkdir', 'external_file_delete']) {
      if (!html.includes("if (name === '" + marker + "')") || !html.includes('uiConfirm')) throw new Error(marker + ' 缺少逐次确认结构');
    }
    T.CONFIG.agentEnabled = old.enabled; T.CONFIG.agentL1 = old.l1; T.CONFIG.agentL3 = old.l3; T.CONFIG.agentSafety = old.safety;
    Perm.hasAllFilesAccess = old.access; Perm.workspaceState = old.state;
  });

  await step('记忆策略：默认新增，相似正文才追加合并', async () => {
    const before = T.MEM.length;
    const a = await T.execTool('save_memory', { title: '测试偏好A', content: '用户长期偏好使用纯文本记录项目进度。', category: '项目' });
    const b = await T.execTool('save_memory', { title: '测试偏好B', content: '用户长期偏好使用纯文本记录项目进度，并要求保留历史内容。', category: '项目' });
    const c = await T.execTool('save_memory', { title: '测试偏好C', content: '用户计划下周测试输入法兜底功能。', category: '项目' });
    if (!a.success || !b.success || !c.success) throw new Error('记忆工具调用失败');
    if (T.MEM.length !== before + 2) throw new Error('相似内容没有合并或新事实被错误合并');
    const merged = T.MEM.find(e => e.id === b.id);
    if (!merged || !merged.content.includes('纯文本记录项目进度') || !merged.content.includes('保留历史内容')) throw new Error('合并时没有保留并追加原文');
  });

  await step('音乐播放地址响应解析：兼容 GD/CRMusic/Meting JSON', () => {
    const p = T.parseMusicUrlResponse;
    if (!p) throw new Error('缺少 parseMusicUrlResponse');
    const samples = [
      ['https://cdn.example/a.mp3', 'https://cdn.example/a.mp3'],
      ['{"url":"https://cdn.example/b.mp3"}', 'https://cdn.example/b.mp3'],
      ['{"data":{"media_url":"https://cdn.example/c.m4a"}}', 'https://cdn.example/c.m4a'],
      ['{"play_urls":[{"url":"https://cdn.example/d.ogg"}]}', 'https://cdn.example/d.ogg']
    ];
    samples.forEach(([input, expected]) => { if (p(input, 'test') !== expected) throw new Error('解析失败：' + input); });
    if (p('', 'empty') !== '') throw new Error('空响应没有返回空值');
  });

  await step('搜索 → 播放：全链路打到原生 mpLoad', async () => {
    T.CONFIG.musicEnabled = true;
    const list = await T.mSearch('测试');
    if (!list || !list.length) throw new Error('搜索没结果');
    T.M.playlist = list;
    calls.mp.length = 0;
    await T.playAt(0);
    const load = calls.mp.find(c => c[0] === 'load');
    if (!load) throw new Error('playAt 没调 Android.mpLoad，实际调用：' + JSON.stringify(calls.mp));
    if (!/^https?:/.test(load[1])) throw new Error('mpLoad 的 url 不合法：' + load[1]);
  });

  await step('togglePlay / 播放模式 都不炸', () => {
    T.togglePlay();
    T.cyclePlayMode(); T.cyclePlayMode(); T.cyclePlayMode();
  });

  await step('AI 工具 music_control 各命令', async () => {
    T.CONFIG.musicEnabled = true;
    for (const cmd of ['pause', 'resume', 'next', 'prev', 'stop', 'favorite']) {
      const r = await T.execTool('music_control', { command: cmd });
      if (!r || r.success !== true) throw new Error(cmd + ' 失败: ' + JSON.stringify(r));
    }
  });

  await step('AI 工具 search_and_play_music', async () => {
    T.CONFIG.musicEnabled = true;
    const r = await T.execTool('search_and_play_music', { keyword: '测试', action: 'search' });
    if (!r.success) throw new Error(JSON.stringify(r));
    const r2 = await T.execTool('search_and_play_music', { keyword: '测试', action: 'play' });
    if (!r2.success) throw new Error(JSON.stringify(r2));
  });

  await step('原生回调 __mpState/__mpProgress/__mpDone/__mpCmd', () => {
    const w = sandbox.window;
    for (const f of ['__mpState', '__mpProgress', '__mpDone', '__mpCmd', '__miniToggle', '__miniMode', '__miniClose']) {
      if (typeof w[f] !== 'function') throw new Error('缺 window.' + f);
    }
    w.__mpState(JSON.stringify({ playing: true, dur: 180000, pos: 0 }));
    w.__mpProgress(5000, 180000);
    w.__mpCmd('next'); w.__mpCmd('prev'); w.__mpCmd('stop');
    w.__miniToggle(); w.__miniMode();
  });

  await step('歌词同步到原生迷你条', () => {
    calls.ui.length = 0;
    T.setLyric('测试歌词一句');
    if (!calls.ui.some(c => c[0] === 'setMiniLyric' && c[1] === '测试歌词一句'))
      throw new Error('没推 setMiniLyric：' + JSON.stringify(calls.ui));
    T.onLyricTime();
  });

  await step('TTS：markdown 剥离 + 分句', () => {
    const s = T.ttsStripMd('# 标题\n**粗体** `code`\n- 列表\n[链接](http://x)\n> 引用');
    if (/[*`#\[\]]/.test(s)) throw new Error('markdown 没剥干净：' + JSON.stringify(s));
    const seg = T.ttsSplit('第一句话。第二句话！第三句话？这是一个很长很长的句子，长到应该被单独切出来，因为它超过了长度上限。');
    if (!Array.isArray(seg) || !seg.length) throw new Error('分句失败');
  });

  await step('TTS：系统引擎调用 Android.speak', () => {
    T.CONFIG.ttsEngine = 'system';
    T.CONFIG.ttsEnabled = true;
    T.speakText('你好呀。');
    if (!calls.tts.some(c => c[0] === 'speak')) throw new Error('没调 Android.speak：' + JSON.stringify(calls.tts));
  });

  await step('TTS：自建引擎调用 Android.ttsAi 且 URL/body 正确', () => {
    T.CONFIG.ttsEngine = 'ai';
    T.CONFIG.ttsBaseUrl = 'https://api.example.com/v1';
    T.CONFIG.ttsApiKey = 'sk-test';
    T.CONFIG.ttsModel = 'tts-1';
    T.CONFIG.ttsVoice = 'nova';
    calls.tts.length = 0;
    T.speakText('你好呀。');
    const c = calls.tts.find(x => x[0] === 'ttsAi');
    if (!c) throw new Error('没调 Android.ttsAi：' + JSON.stringify(calls.tts));
    if (c[1] !== 'https://api.example.com/v1/audio/speech') throw new Error('URL 不对：' + c[1]);
    const body = JSON.parse(c[3]);
    if (body.model !== 'tts-1' || body.voice !== 'nova' || !body.input) throw new Error('body 不对：' + c[3]);
    if (!/Bearer sk-test/.test(c[2])) throw new Error('headers 缺鉴权：' + c[2]);
    T.stopTTS();
    T.CONFIG.ttsEngine = 'system';
  });

  await step('插件开关：关掉音乐后工具与提示词同时消失', () => {
    const before = T.CONFIG.musicEnabled;
    T.CONFIG.musicEnabled = true;
    T.togglePlug('music');
    const names = T.buildTools().map(t => t.function.name);
    const prompt = T.buildToolsPrompt();
    T.togglePlug('music');
    T.CONFIG.musicEnabled = before;
    if (names.includes('music_control') || names.includes('search_and_play_music'))
      throw new Error('关掉插件后工具还在');
    if (/music_control/.test(prompt)) throw new Error('关掉插件后提示词还在提');
  });

  await step('单项工具开关：只关一项不影响同组其它工具', () => {
    const before = T.CONFIG.musicEnabled;
    const oldOff = T.CONFIG.toolOff;
    T.CONFIG.musicEnabled = true;
    T.CONFIG.toolOff = {};
    T.toggleTool('music_control');
    let names = T.buildTools().map(t => t.function.name);
    let prompt = T.buildToolsPrompt();
    if (names.includes('music_control')) throw new Error('单项关闭后仍可调用');
    if (prompt.indexOf('· music_control：') >= 0) throw new Error('单项关闭后提示词仍在提');
    if (!names.includes('search_and_play_music')) throw new Error('误伤了同组其它工具');
    T.toggleTool('music_control');            // 再开回来
    T.CONFIG.toolOff = oldOff;
    T.CONFIG.musicEnabled = before;
  });

  await step('音乐系统：搜索/收藏/历史/队列/缓存 UI 与主题设置结构', () => {
    for (const id of ['music','music-list','music-more','music-clear-cache','music-lyric','music-player','set-music-catalogs','set-music-history-limit']) {
      if (!html.includes('id="' + id + '"')) throw new Error('音乐结构缺少 #' + id);
    }
    for (const tab of ['search','fav','history','queue','cache']) {
      if (!html.includes('data-tab="' + tab + '"')) throw new Error('音乐 Tab 缺少 ' + tab);
    }
    if (!/musicAutoCache/.test(html) || !/musicShowSource/.test(html)) throw new Error('音乐设置没有接入配置');
    if (!html.includes('id="music-context-menu"') || !html.includes('data-music-action="delete"') || !html.includes('data-music-action="cache"')) throw new Error('音乐长按菜单缺少删除/缓存操作');
    if (!/\.music-more\[hidden\][\s\S]*display:none/.test(html)) throw new Error('加载更多按钮隐藏规则缺失');
    if (!/\.mcover[\s\S]*var\(--c1\)/.test(html) || !/\.mp-play[\s\S]*var\(--c1\)/.test(html)) throw new Error('音乐 UI 没有使用主题变量');
  });

  await step('插件配置面板：内置音乐工具可见且与 Agent 工具集一致', () => {
    const music = T.PLUGINS.find(p => p.id === 'music');
    if (!music || !music.tools.includes('search_and_play_music') || !music.tools.includes('music_control')) throw new Error('音乐插件组未注册');
    if (!/music\.control/.test(html) || !/search_and_play_music/.test(html) || !/music_control/.test(html)) throw new Error('音乐插件权限/工具映射缺失');
    const old = T.CONFIG.musicEnabled;
    const oldOff = T.CONFIG.toolOff;
    T.CONFIG.musicEnabled = true; T.CONFIG.toolOff = {};
    const names = T.buildTools().map(x => x.function.name);
    const prompt = T.buildToolsPrompt();
    T.CONFIG.musicEnabled = old; T.CONFIG.toolOff = oldOff;
    if (!names.includes('search_and_play_music') || !names.includes('music_control')) throw new Error('音乐工具未进入 Agent tools schema');
    if (!/search_and_play_music/.test(prompt) || !/music_control/.test(prompt)) throw new Error('音乐工具未进入 Agent 提示词');
  });



  await step('自定义插件：清单校验 + 工具注册 + 执行', async () => {
    const m = T.plugNormalize({
      manifestVersion: 1, apiVersion: '0.1', id: 'com.test.echo', name: '回声', icon: '📣',
      permissions: ['network.public'], grantedPermissions: ['network.public'],
      tools: [
        { name: 'echo_http', description: '回显', kind: 'http', permissions: ['network.public'],
          request: { method: 'GET', url: 'https://example.com/api?q={{q}}' } },
        { name: 'echo_js', description: '脚本', kind: 'js', permissions: [], code: 'async function run(a){return a;}' }
      ]
    });
    if (!m) throw new Error('合法清单被拒');
    if (T.plugNormalize({ id: 'x', name: 'x', tools: [] })) throw new Error('空工具清单应被拒');
    if (T.plugNormalize({ id: 'bad id', name: 'x', tools: [{ name: 't', kind: 'js', code: 'x' }] }))
      throw new Error('非法 id 应被拒');
    if (T.plugNormalize({ id: 'ok.id', name: 'x', tools: [{ name: 't', kind: 'nope' }] }))
      throw new Error('未知 kind 应被拒');
    T.USER_PLUGINS.push(m);
    T.refreshSystemPrompt(false);
    const names = T.buildTools().map(t => t.function.name);
    const prompt = T.buildToolsPrompt();
    if (!names.includes('echo_http') || !names.includes('echo_js'))
      throw new Error('自定义工具未注册：' + names.join(','));
    if (!/回声/.test(prompt)) throw new Error('提示词没包含自定义插件');
    const r = await T.execTool('echo_http', { q: 'hi' });
    if (!r.success) throw new Error('http 插件执行失败：' + JSON.stringify(r));
    if (!T.plugFind('echo_http')) throw new Error('plugFind 找不到自定义工具');
    T.USER_PLUGINS.length = 0;
    T.refreshSystemPrompt(false);
  });

  await step('插件权限声明、授权和本地市场结构', () => {
    const safe = { manifestVersion: 1, apiVersion: '0.1', id: 'com.test.safe', name: '安全插件', permissions: [], tools: [{ name: 'safe_tool', description: '安全工具', permissions: [], kind: 'js', code: 'async function run(a){return a;}' }] };
    const dangerous = { manifestVersion: 1, apiVersion: '0.1', id: 'com.test.danger', name: '危险插件', permissions: ['files.public.write'], tools: [{ name: 'danger_tool', description: '写文件', permissions: ['files.public.write'], kind: 'js', code: 'async function run(a){return a;}' }] };
    if (T.plugManifestError(safe)) throw new Error('安全清单不应被拒：' + T.plugManifestError(safe));
    if (T.plugManifestError(dangerous)) throw new Error('危险清单结构不应被拒：' + T.plugManifestError(dangerous));
    const missingToolPerm = Object.assign({}, safe, { tools: [{ name: 'safe_tool', description: '安全工具', kind: 'js', code: 'async function run(a){return a;}' }] });
    if (!T.plugManifestError(missingToolPerm)) throw new Error('缺少工具 permissions 时未拒绝');
    const n = T.plugNormalize(dangerous);
    if (!n || T.plugPermissionGranted(n, 'files.public.write')) throw new Error('危险能力不应在清单规整时默认授权');
    const granted = T.plugNormalize(Object.assign({}, dangerous, { grantedPermissions: ['files.public.write'] }));
    if (!T.plugPermissionGranted(granted, 'files.public.write')) throw new Error('显式授权危险能力后仍不可用');
    const ungranted = T.plugNormalize(Object.assign({}, dangerous, { grantedPermissions: [] }));
    if (T.plugPermissionGranted(ungranted, 'files.public.write')) throw new Error('未授权危险能力仍然可用');
    if (!Array.isArray(T.PLUGIN_MARKET_INDEX) || !T.PLUGIN_MARKET_INDEX.length) throw new Error('本地插件市场索引为空');
    if (!/music\.control/.test(html) || !/read_screen_once/.test(html)) throw new Error('插件宿主能力映射缺少音乐或一次性读屏');
    if (!/sha256|HTTPS|远程/.test(T.PLUG_HELP)) throw new Error('插件说明缺少远程市场完整性说明');
  });

  await step('自定义插件：本机地址与危险协议被拦截', () => {
    for (const u of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'file:///etc/passwd',
                     'javascript:alert(1)', 'http://169.254.1.1/x']) {
      if (!T.plugUrlAllowed(u)) throw new Error('未拦截：' + u);
    }
    if (T.plugUrlAllowed('https://api.example.com/v1/x')) throw new Error('正常 https 被误拦');
  });

  await step('插件沙箱模板：脚本可解析', () => {
    const h = T.PLUG_SANDBOX_HTML;
    if (!/__elly/.test(h) || !/parent\.postMessage/.test(h)) throw new Error('沙箱模板结构不对');
    if (!/Content-Security-Policy/.test(h) || !/default-src &#39;none&#39;/.test(h))
      throw new Error('沙箱模板缺少 CSP，插件可直接发网络请求');
    const m = h.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('沙箱模板缺少 script');
    new vm.Script(m[1]);   // 语法不合法会抛
    if (!/host\.request/.test(T.PLUG_HELP) || !/host\.callTool/.test(T.PLUG_HELP) || !/permissions/.test(T.PLUG_HELP)) throw new Error('格式说明缺少权限或 host 接口');
  });

  await step('版本比较与更新页结构', () => {
    if (T.cmpVer(T.verArr('v0.6.3'), T.verArr('0.6.2')) <= 0) throw new Error('新版本应更大');
    if (T.cmpVer(T.verArr('v0.6.2'), T.verArr('0.6.2')) !== 0) throw new Error('同版本应相等');
    if (T.cmpVer(T.verArr('0.6.10'), T.verArr('0.6.9')) <= 0) throw new Error('应按数字逐段比较');
    for (const id of ['update-modal', 'upd-go', 'upd-notes', 'plug-modal', 'plug-code']) {
      if (!html.includes('id="' + id + '"')) throw new Error('index.html 里找不到 #' + id);
    }
  });

  await step('人设/提示词组装', () => {
    const p = T.composeSystemPrompt();
    if (!p || p.length < 10) throw new Error('提示词为空');
    if (!/当前时间/.test(p)) throw new Error('提示词缺时间上下文');
    T.refreshSystemPrompt(false);
  });

  await step('设置渲染 + 保存不炸', () => {
    T.renderSettings();
    T.saveSettings();
  });

  await step('P1 收尾：任务文件索引、快照、回滚和任务详情结构', () => {
    for (const marker of ['taskWorkspaceIndex', 'snapshotTaskFile', 'listTaskSnapshots', 'restoreTaskFile']) {
      if (!html.includes(marker)) throw new Error('缺少任务工作区桥：' + marker);
    }
    for (const marker of ['function taskIndex', 'function taskSnapshots', 'task-detail', 'data-task-restore', 'taskRelPath']) {
      if (!html.includes(marker)) throw new Error('缺少任务详情/回滚结构：' + marker);
    }
    if (!/snapshotTaskFile\(wt\.id, taskRelPath/.test(html)) throw new Error('workspace_write 未在写入前保存快照');
  });

  await step('G2：运行上下文绑定和 QuickOperation 取消边界', () => {
    if (!/const activeRunTask = hooks\.task \|\| currentTask\(\)/.test(html)) throw new Error('chatReqTools 未使用显式任务上下文');
    if (!/execTool\(actionName, actionArgs, activeRunTask\)/.test(html)) throw new Error('工具执行未绑定当前任务');
    if (!/taskIdOverride \|\| ''/.test(html)) throw new Error('兼容层没有把任务 ID 交给 RequestManager');
    if (!/spec\.taskId \|\| currentTask\(\)\.id/.test(html)) throw new Error('RequestManager 没有绑定任务 ID');
    if (!/taskId: taskId/.test(html)) throw new Error('模型请求没有显式传入任务 ID');
    if (!/ACTIVE_RUN_TASK_ID/.test(html) || !/cancelTaskRequests\(ACTIVE_RUN_TASK_ID/.test(html)) throw new Error('停止操作未绑定活动任务');
    if (!/live\.task = qt/.test(html) || !/live\.task = routedTask/.test(html)) throw new Error('QuickOperation/普通任务未注入运行上下文');
    if (!/TASK_TRANSITIONS/.test(html) || !/INVALID_STATE_TRANSITION/.test(html)) throw new Error('任务非法状态迁移门禁缺失');
  });

  await step('设置保存按钮：始终可点且不被窗口缩放热区遮挡', () => {
    const fs = require('fs'), path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/src/styles/main.css'), 'utf8');
    const bottom = (css.match(/\.settings-bottom\{[^}]*\}/g) || []).join('\n');
    if (!bottom) throw new Error('缺少 .settings-bottom 样式');
    if (!/position:\s*sticky/.test(bottom)) throw new Error('底部操作条应该一直可见(sticky)');
    // 有效偏移 = bottom + padding-bottom，必须大于缩放热区的 22px
    const mb = bottom.match(/bottom:\s*(\d+)(?:px)?/);
    const mp = bottom.match(/padding:\s*[^;]*?\s(\d+)px\s*;/);
    const off = (mb ? parseInt(mb[1], 10) : 0) + (mp ? parseInt(mp[1], 10) : 0);
    if (!mb) throw new Error('sticky 缺少 bottom 偏移');
    if (!mp) throw new Error('缺少 padding-bottom，无法把按钮抬出缩放热区');
    if (off <= 22) throw new Error('按钮有效偏移 ' + off + 'px 会落入缩放热区(.rz 底部 22px)，点击会被吃掉');
    const rz = (css.match(/\.rz\{[^}]*\}/g) || []).join('');
    if (!/z-index:\s*60/.test(rz)) throw new Error('缩放热区层级变化，需要重新确认遮挡关系');
    if (!/id="settings-bottom-spacer" style="height:(\d+)px"/.test(html)) throw new Error('缺少底部占位块');
    if (parseInt(RegExp.$1, 10) < off) throw new Error('底部占位小于 sticky 偏移，最后一项会被盖住');
    if (html.indexOf('settings-save-float') >= 0) throw new Error('不应再有悬浮保存按钮');
  });

  await step('设置保存：保存函数读取的每个控件都真的存在', () => {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/src/scripts/14-update.js'), 'utf8');
    const r0 = src.indexOf("$('#settings').innerHTML = `");
    const r1 = src.indexOf('`;', r0);
    const tpl = src.slice(r0, r1);
    const have = new Set((tpl.match(/id="([a-z0-9\-]+)"/g) || []).map(x => x.slice(4, -1)));
    // swatchGroup 会额外生成 <input id="set-<group>">
    (tpl.match(/swatchGroup\('([a-z0-9\-]+)'/g) || []).forEach(x => have.add('set-' + x.split("'")[1]));
    const d0 = src.indexOf('function doSaveSettings(');
    const d1 = src.indexOf('function exportData(', d0);
    const ids = Array.from(new Set((src.slice(d0, d1).match(/#set-[a-z0-9\-]+/g) || []))).map(x => x.slice(1));
    if (ids.length < 10) throw new Error('保存函数解析异常');
    const missing = ids.filter(id => !have.has(id));
    if (missing.length) throw new Error('保存时会读到不存在的控件：' + missing.join(', '));
  });

  await step('G2：长任务预算和设置保存按钮结构', () => {
    if (!/agentTaskTimeout: 1200000/.test(html) || !/max="7200"/.test(html) || !/Math\.min\(7200000/.test(html)) throw new Error('长任务默认预算或最大值未接入');
    if (!/id="set-save"[^>]*type="button"/.test(html) || !/const saveHandler/.test(html)) throw new Error('设置保存按钮未绑定可靠点击处理');
    if (!html.includes('id="set-device-max-actions"')) throw new Error('缺少手机动作预算设置项');
    if (!html.includes('id="set-device-resume-chunk"')) throw new Error('缺少预算追加设置项');
    if (!/via_ai_task_timeout_v1200/.test(html)) throw new Error('旧 90 秒默认值没有迁移逻辑');
  });

  await step('G3：RequestManager 错误码、重试、上限与取消', async () => {
    const C = T.REQ_CODE;
    const d0 = T.REQ_RETRY_DELAY[0], d1 = T.REQ_RETRY_DELAY[1];
    T.REQ_RETRY_DELAY[0] = 1; T.REQ_RETRY_DELAY[1] = 1;   // 测试里不真等 2s/6s
    const expectFail = async (spec, code, label) => {
      try { await T.reqRequest(spec); } catch (e) {
        if (e.code !== code) throw new Error(label + ' 错误码应为 ' + code + '，实际 ' + e.code);
        return e;
      }
      throw new Error(label + ' 本应失败却成功了');
    };
    try {
      T.reqAuditClear();
      // 500 可重试：1 + 2 次重试 = 3 次尝试
      await expectFail({ url: 'https://x.test/__500', retries: 2 }, C.HTTP_ERROR, 'HTTP 500');
      const rows500 = T.reqAuditList();
      if (rows500.length !== 3) throw new Error('500 应重试到 3 次尝试，实际 ' + rows500.length);
      if (rows500[2].attempts !== 3) throw new Error('最后一次尝试序号错误');

      T.reqAuditClear();
      // 401 绝不重试
      await expectFail({ url: 'https://x.test/__401', retries: 3 }, C.AUTH_ERROR, 'HTTP 401');
      if (T.reqAuditList().length !== 1) throw new Error('401 不应重试，实际尝试 ' + T.reqAuditList().length + ' 次');

      T.reqAuditClear();
      // 429 可重试，但这里用 retries:0 避免真等 10s
      await expectFail({ url: 'https://x.test/__429', retries: 0 }, C.RATE_LIMITED, 'HTTP 429');
      if (!T.reqIsRetriable(C.RATE_LIMITED, 429)) throw new Error('429 应被标记为可重试');

      // 大小上限 / 跳数上限 / JSON 解析 / 任务预算 / 取消
      await expectFail({ url: 'https://x.test/__big', retries: 2 }, C.TOO_LARGE, '超大响应');
      if (T.reqAuditList().filter(r => r.code === C.TOO_LARGE).length !== 1) throw new Error('TOO_LARGE 不应重试');
      await expectFail({ url: 'https://x.test/__loop', retries: 2 }, C.REDIRECT_ERROR, '重定向异常');
      await expectFail({ url: 'https://x.test/notjson', expect: 'json', retries: 0 }, C.PARSE_ERROR, '非 JSON');
      await expectFail({ url: 'https://x.test/ok', deadlineAt: Date.now() - 1000, retries: 0 }, C.DEADLINE_EXCEEDED, '任务预算耗尽');
      await expectFail({ url: 'https://x.test/__slow', timeoutMs: 1000, retries: 0 }, C.TIMEOUT, '超时');
      const tok = T.reqToken(); tok.cancel();
      await expectFail({ url: 'https://x.test/ok', token: tok, retries: 0 }, C.CANCELLED, '取消');

      // 正常请求 + JSON 解析
      const okRes = await T.reqRequest({ url: 'https://x.test/chat/completions', method: 'POST', body: '{}', expect: 'json', retries: 0, source: 'model' });
      if (!okRes.json || !okRes.json.choices) throw new Error('正常 JSON 请求解析失败');
      if (okRes.status !== 200) throw new Error('正常请求状态码错误');

      // 审计脱敏：只留域名，不留 path/query/凭据
      const dump = JSON.stringify(T.reqAuditList());
      if (dump.indexOf('x.test') < 0) throw new Error('审计没有记录域名');
      if (/\/__500|\/chat\/completions|\?/.test(dump)) throw new Error('审计泄露了路径或查询串');
      if (/apikey|api_key|Authorization|Bearer/i.test(dump)) throw new Error('审计泄露了凭据');
    } finally {
      T.REQ_RETRY_DELAY[0] = d0; T.REQ_RETRY_DELAY[1] = d1;
      T.reqAuditClear();
    }
  });

  await step('G3-4：无绕过入口、跨域策略与直链不落盘', () => {
    // 1) 除兼容层外，不再有模块直接调用 nativeReq
    const files = require('fs').readdirSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts'));
    const offenders = files.filter(f => f !== '00-compat.js').filter(f => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts', f), 'utf8');
      return /\bnativeReq\s*\(/.test(src);
    });
    if (offenders.length) throw new Error('仍有模块绕过 RequestManager：' + offenders.join(', '));
    if (/Android\.request(Ex)?\s*\(/.test(html.replace(/00b-request[\s\S]*?\/\* ={10,}/, ''))) {
      // 只允许出现在 RequestManager 自己的传输层
      const idx = html.indexOf('Android.requestEx');
      const idx2 = html.indexOf('Android.request(');
      if (idx < 0 || idx2 < 0) throw new Error('原生请求入口缺失');
    }

    // 2) 跨域跳转策略：系统级始终允许；插件/Agent 受 L2 约束
    if (T.reqSameHostOnly('music:gd')) throw new Error('音乐不应该被限制跨域（CDN 302 是正常业务）');
    if (T.reqSameHostOnly('system:update')) throw new Error('更新检查不应被限制跨域');
    if (T.reqSameHostOnly('system:translate')) throw new Error('翻译不应被限制跨域');
    const wasL2 = T.CONFIG.agentL2;
    T.CONFIG.agentL2 = false;
    if (!T.reqSameHostOnly('plugin:abc')) throw new Error('L2 关闭时插件应禁止跨域跳转');
    if (!T.reqSameHostOnly('agent')) throw new Error('L2 关闭时 Agent 应禁止跨域跳转');
    T.CONFIG.agentL2 = true;
    if (T.reqSameHostOnly('plugin:abc')) throw new Error('L2 开启时插件应允许跨域跳转');
    if (T.reqSameHostOnly('agent')) throw new Error('L2 开启时 Agent 应允许跨域跳转');
    if (T.reqSameHostOnly('system:update')) throw new Error('L2 开关不应影响系统级请求');
    T.CONFIG.agentL2 = wasL2;

    // 3) 短时签名直链不写进历史/队列/缓存/收藏
    const song = { id: 9, source: 'gd', name: 'x', artist: 'y',
      playUrl: 'https://cdn.test/a.mp3?sig=abc', play_url: 'https://cdn.test/a.mp3?sig=abc',
      url: 'https://cdn.test/a.mp3?sig=abc', urls: ['https://cdn.test/a.mp3?sig=abc'],
      expiresAt: 123, coverUrl: 'https://img.test/c.jpg' };
    const clean = T.musicStripVolatile(song);
    ['playUrl', 'play_url', 'url', 'urls', 'expiresAt'].forEach(k => {
      if (k in clean) throw new Error('易失字段 ' + k + ' 没有被剥离');
    });
    if (clean.coverUrl !== 'https://img.test/c.jpg') throw new Error('封面地址不应被误删');
    if (clean.id !== 9 || clean.name !== 'x') throw new Error('歌曲身份字段不应被删');

    // 4) 所有出网调用都带 source，便于来源健康与审计归类
    // 用「调用点往后 800 字符内必须有 source」判断，避免被 body 里的 }) 截断
    const noSource = files.filter(f => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts', f), 'utf8');
      let i = -1;
      while ((i = src.indexOf('reqRequest(', i + 1)) >= 0) {
        if (src.slice(i, i + 800).indexOf('source:') < 0) return true;
      }
      return false;
    });
    if (noSource.length) throw new Error('这些文件的请求缺少 source 标记：' + noSource.join(', '));
  });

  await step('G3-2：插件错误码透传 + 音乐直链不落盘（运行时）', async () => {
    // 插件 HTTP 失败时应把 RequestManager 的归一错误码透出来，而不是一律 NETWORK_ERROR
    const m = T.plugNormalize({
      manifestVersion: 1, apiVersion: '0.1', id: 'com.test.err', name: '错误插件', icon: '⚠',
      permissions: ['network.public'], grantedPermissions: ['network.public'],
      tools: [{ name: 'err_http', description: '错误', kind: 'http', permissions: ['network.public'],
        request: { method: 'GET', url: 'https://example.com/__401' } }]
    });
    if (!m) throw new Error('测试插件清单被拒');
    T.USER_PLUGINS.push(m);
    T.refreshSystemPrompt(false);
    const r = await T.execTool('err_http', {});
    T.USER_PLUGINS.length = 0;
    T.refreshSystemPrompt(false);
    if (r.success) throw new Error('401 应当失败');
    if (r.errorCode !== 'AUTH_ERROR') throw new Error('插件错误码未透传，实际 ' + r.errorCode);

    // 播放历史里的歌曲不应带短时签名直链
    T.musicRemember({ id: 777, source: 'gd', name: '测试', artist: 'A',
      playUrl: 'https://cdn.test/x.mp3?sig=1', url: 'https://cdn.test/x.mp3?sig=1', expiresAt: 1 });
    const last = T.M.history[0];
    if (!last || last.id !== 777) throw new Error('历史没有记录歌曲');
    if ('playUrl' in last || 'url' in last || 'expiresAt' in last) throw new Error('历史里仍存了短时直链');
  });

  await step('G3 加固：取消语义、停止中性化、恢复重置预算、错误码可见', async () => {
    const C = T.REQ_CODE;
    const d0 = T.REQ_RETRY_DELAY[0], d1 = T.REQ_RETRY_DELAY[1];
    T.REQ_RETRY_DELAY[0] = 1; T.REQ_RETRY_DELAY[1] = 1;
    try {
      // 1) 任务取消必须立刻以 CANCELLED 结束，不能被当成可重试的网络错误
      T.reqAuditClear();
      const p1 = T.reqRequest({ url: 'https://x.test/__slow', timeoutMs: 30000, retries: 2, source: 'test:cancel' });
      await new Promise(r => setTimeout(r, 20));
      T.cancelTaskRequests(T.currentTask().id);
      let err1 = null;
      try { await p1; } catch (e) { err1 = e; }
      if (!err1) throw new Error('取消后请求本应失败');
      if (err1.code !== C.CANCELLED) throw new Error('取消应返回 CANCELLED，实际 ' + err1.code);
      if (T.reqIsRetriable(err1.code, err1.status)) throw new Error('CANCELLED 不应可重试');
      // 只统计本用例自己的请求：其它用例残留的定时器/请求可能同时写审计
      const audit1 = T.reqAuditList().filter(r => r.source === 'test:cancel');
      if (audit1.length !== 1) throw new Error('取消后应只尝试 1 次，实际 ' + audit1.length + '（' + audit1.map(r => r.code).join(',') + '）');

      // 2) 历史遗留的裸 Error('...取消...') 也不能被当成可重试
      const tok = T.reqToken(); tok.cancel();
      let err2 = null;
      try { await T.reqRequest({ url: 'https://x.test/ok', token: tok, retries: 2 }); } catch (e) { err2 = e; }
      if (!err2 || err2.code !== C.CANCELLED) throw new Error('token 取消未返回 CANCELLED');

      // 3) 恢复任务必须重置 deadline（否则长任务恢复即 DEADLINE_EXCEEDED）
      const t = T.taskAdd('workspace', '长任务', '测试');
      T.taskUpdate(t.id, { deadline: Date.now() - 5000 });
      const before = T.TASKS.find(x => x.id === t.id).deadline;
      T.taskResume(t.id);
      const after = T.TASKS.find(x => x.id === t.id).deadline;
      if (!(after > Date.now())) throw new Error('恢复后 deadline 未刷新（' + before + ' → ' + after + '）');
      T.taskCancel(t.id);

      // 4) 错误码对用户可见（errMsg 追加〔CODE〕）
      const e3 = { message: 'HTTP 429', code: 'RATE_LIMITED' };
      const shown = T.errMsg(e3);
      if (shown.indexOf('RATE_LIMITED') < 0) throw new Error('errMsg 未显示错误码：' + shown);
      if (T.errMsg({ message: 'RATE_LIMITED 已说明', code: 'RATE_LIMITED' }).indexOf('〔') >= 0) throw new Error('错误码重复拼接');
      if (T.errMsg('纯文本错误') !== '纯文本错误') throw new Error('字符串错误被改写');

      // 5) 停止时不再把取消当错误展示
      const src = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts/12-send-quick.js'), 'utf8');
      if (!/e\.code === 'CANCELLED'/.test(src)) throw new Error('停止路径未区分取消');
      if (!/已停止本轮执行/.test(src)) throw new Error('停止时缺少中性提示');
      if (!/taskFinish\(routedTask\.id, 'cancelled'/.test(src)) throw new Error('停止后任务状态未标为 cancelled');
    } finally {
      T.REQ_RETRY_DELAY[0] = d0; T.REQ_RETRY_DELAY[1] = d1;
      T.reqAuditClear();
    }
  });

  await step('G5-1：设备动作状态机与串行队列', async () => {
    if (!T.DEVICE_PHASES || !T.deviceSetPhase) throw new Error('设备状态机未接入');

    // 1) 相位迁移：合法通过、非法被拒且不改状态
    const dt = T.taskAdd('device', '状态机测试', 'tap something');
    T.deviceReset(dt.id);
    if (T.devicePhaseOf(dt.id) !== 'idle') throw new Error('复位后不是 idle');
    if (!T.deviceSetPhase(dt.id, 'orienting')) throw new Error('idle→orienting 应允许');
    if (!T.deviceSetPhase(dt.id, 'acting')) throw new Error('orienting→acting 应允许');
    if (!T.deviceSetPhase(dt.id, 'verifying')) throw new Error('acting→verifying 应允许');
    if (!T.deviceSetPhase(dt.id, 'idle')) throw new Error('verifying→idle 应允许');
    // idle 直接跳 verifying 非法：必须被拒且相位不变
    if (T.deviceSetPhase(dt.id, 'verifying')) throw new Error('idle→verifying 应被判非法');
    if (T.devicePhaseOf(dt.id) !== 'idle') throw new Error('非法迁移改变了相位');
    const bad = (T.TASKS.find(x => x.id === dt.id).events || []).some(e => e.type === 'invalid_device_phase');
    if (!bad) throw new Error('非法迁移没有留事件');

    // 2) 批次计划：只读并行、设备串行、保持原始下标
    const plan = T.planToolBatch([
      { function: { name: 'read_screen' } },
      { function: { name: 'tap_screen' } },
      { function: { name: 'list_memories' } },
      { function: { name: 'click_text' } }
    ]);
    if (plan.parIdx.join(',') !== '0,2') throw new Error('并行组下标错误：' + plan.parIdx.join(','));
    if (plan.serIdx.join(',') !== '1,3') throw new Error('串行组下标错误：' + plan.serIdx.join(','));
    const onlyDev = T.planToolBatch([{ function: { name: 'tap_screen' } }, { function: { name: 'swipe_screen' } }]);
    if (onlyDev.parIdx.length !== 0 || onlyDev.serIdx.join(',') !== '0,1') throw new Error('纯设备批次不应有并行项');

    // 3) 设备动作永远不进并行组
    ['tap_screen','click_text','swipe_screen','input_text','press_key','launch_app'].forEach(n => {
      if (T.canParallelTool(n)) throw new Error(n + ' 不应允许并行');
    });
    if (!T.canParallelTool('read_screen')) throw new Error('read_screen 应允许并行');

    // 4) 动作计数 + 执行顺序：两个设备动作必须串行，且顺序与模型给出的一致
    //    先打开 L3 + 安全开关（设备动作的硬门禁）
    const keep = { agentEnabled: T.CONFIG.agentEnabled, agentL3: T.CONFIG.agentL3, agentSafety: T.CONFIG.agentSafety };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    calls.tools.length = 0;
    T.deviceReset(dt.id);
    const r1 = await T.execTool('tap_screen', { x: 10, y: 20 }, T.TASKS.find(x => x.id === dt.id));
    const r2 = await T.execTool('click_text', { text: '搜索' }, T.TASKS.find(x => x.id === dt.id));
    if (!r1.success || !r2.success) throw new Error('设备动作执行失败');
    const seq = calls.tools.join(',');
    if (seq !== 'tap:10,20,click:搜索') throw new Error('设备动作顺序错误：' + seq);
    const ds = T.deviceState(T.TASKS.find(x => x.id === dt.id));
    if (ds.actionsUsed !== 2) throw new Error('动作计数应为 2，实际 ' + ds.actionsUsed);

    // 5) 非设备工具的并行组不会打乱设备动作顺序（同一批次里读屏可与设备动作共存）
    calls.tools.length = 0;
    await Promise.all([T.execTool('read_screen', {}, T.TASKS.find(x => x.id === dt.id))]);
    if (calls.tools.length) throw new Error('读屏不应被计为设备动作');

    T.taskCancel(dt.id);
    if (T.devicePhaseOf(dt.id) !== 'idle') throw new Error('取消后相位应复位');
    T.CONFIG.agentEnabled = keep.agentEnabled; T.CONFIG.agentL3 = keep.agentL3; T.CONFIG.agentSafety = keep.agentSafety;
  });

  await step('G5-2：读屏分级摘要、缓存与比例坐标', () => {
    T.screenCacheClear();
    // 默认 basic：只有可交互节点，带比例坐标
    const d0 = T.screenDigest({});
    if (!d0.screen || d0.screen.w !== 1080 || d0.screen.h !== 2400) throw new Error('摘要缺少屏幕尺寸');
    if (!d0.tier0.length) throw new Error('tier0 为空');
    if (d0.tier1 !== null) throw new Error('basic 不应返回 tier1');
    const search = d0.tier0.find(n => n.t === '搜索');
    if (!search) throw new Error('tier0 缺少可点击节点');
    if (!(search.rx > 0 && search.rx <= 1 && search.ry >= 0 && search.ry <= 1)) throw new Error('比例坐标越界：' + search.rx + ',' + search.ry);
    if (search.rx < 0.8) throw new Error('右侧按钮的 rx 应该接近 1');
    if (!d0.tier0.some(n => n.pwd)) throw new Error('密码标记丢失');
    if (!d0.tier0.some(n => n.edt)) throw new Error('可编辑标记丢失');

    // 缓存：3s 内第二次读屏命中
    const d1 = T.screenDigest({});
    if (!d1.cached) throw new Error('第二次读屏应命中缓存');
    if (!(d1.ageMs >= 0)) throw new Error('缓存缺少 ageMs');

    // more：带文本行
    const d2 = T.screenDigest({ detail: 'more' });
    if (!Array.isArray(d2.tier1) || !d2.tier1.length) throw new Error('detail=more 应返回 tier1');

    // full：分页，且不因为超长而失败
    const d3 = T.screenDigest({ detail: 'full', page: 1 });
    if (!Array.isArray(d3.tier2) || !d3.tier2.length) throw new Error('detail=full 应返回 tier2');
    if (d3.pages < 1) throw new Error('缺少页数');
    T.screenCacheClear();
  });

  await step('G5-3：自适应验证判定（变化/不变/空页/白名单）', async () => {
    const keep = T.CONFIG.agentEnabled;
    T.CONFIG.agentEnabled = true;

    // 1) 页面不变 → NO_CHANGE
    const fp = T.screenFingerprint();
    const v1 = await T.agentVerifyAction(fp);
    if (v1.verdict !== 'NO_CHANGE') throw new Error('不变时应为 NO_CHANGE，实际 ' + v1.verdict);
    if (!(v1.after.waitedMs >= 150)) throw new Error('应至少轮询一次');

    // 2) 页面变化 → PASS（在动作前取指纹，再改 fake 屏幕）
    const before = T.screenFingerprint();
    SCREEN_STUB.nodes.push({ t: '新页面', x: 0, y: 400, w: 1080, h: 100, clk: false, cls: 'TextView' });
    const v2 = await T.agentVerifyAction(before);
    if (v2.verdict !== 'PASS') throw new Error('变化时应为 PASS，实际 ' + v2.verdict);
    if (v2.after.waitedMs > 2500) throw new Error('轮询超时超过上限');

    // 3) 空页 → EMPTY（验证会多等一次）
    const before2 = T.screenFingerprint();
    const saved = SCREEN_STUB.nodes.slice();
    SCREEN_STUB.nodes.length = 0;
    const v3 = await T.agentVerifyAction(before2);
    if (v3.verdict !== 'EMPTY') throw new Error('空页应为 EMPTY，实际 ' + v3.verdict);
    if (!v3.after.changed) throw new Error('空页应记录为变化过');

    // 4) 切到白名单外应用 → PACKAGE_DENIED
    SCREEN_STUB.nodes.length = 0;
    saved.forEach(n => SCREEN_STUB.nodes.push(n));
    const before3 = T.screenFingerprint();
    SCREEN_STUB.nodes.push({ t: '别的应用', x: 0, y: 500, w: 1080, h: 100, clk: false, cls: 'TextView' });
    h_perm.getForegroundPackage = () => 'com.evil.app';
    const v4 = await T.agentVerifyAction(before3);
    if (v4.verdict !== 'PACKAGE_DENIED') throw new Error('切到白名单外应为 PACKAGE_DENIED，实际 ' + v4.verdict);
    h_perm.getForegroundPackage = () => 'com.test.app';

    // 还原
    SCREEN_STUB.nodes.length = 0;
    saved.forEach(n => SCREEN_STUB.nodes.push(n));
    T.CONFIG.agentEnabled = keep;
    T.screenCacheClear();
  });

  await step('G5-4：密码框确认与动作预算暂停/继续', async () => {
    const keep = { agentEnabled: T.CONFIG.agentEnabled, agentL3: T.CONFIG.agentL3, agentSafety: T.CONFIG.agentSafety, max: T.CONFIG.deviceMaxActions };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    const task = T.taskAdd('device', '密码与预算', 'test');
    const taskObj = () => T.TASKS.find(x => x.id === task.id);
    const modalOpen = () => { try { return T.$('#modal').classList.contains('open'); } catch (e) { return false; } };

    // 1) 普通输入（焦点是普通输入框之外的场景）：不弹确认
    SCREEN_STUB.nodes.forEach(n => { if (n.t === '输入框') n.foc = false; if (n.t === '密码') n.pwd = false; });
    calls.tools.length = 0;
    const r1 = await T.execTool('input_text', { text: 'hello' }, taskObj());
    if (modalOpen()) throw new Error('非密码输入不应弹确认');
    if (!r1.success) throw new Error('普通输入应成功：' + JSON.stringify(r1));
    if (calls.tools.indexOf('input:hello') < 0) throw new Error('普通输入没有真正执行');

    // 2) 焦点在密码框：必须先确认；确认后才执行
    SCREEN_STUB.nodes.forEach(n => { if (n.t === '输入框') n.foc = false; if (n.t === '密码') n.pwd = true, n.foc = true; });
    T.screenCacheClear();
    calls.tools.length = 0;
    const p2 = T.execTool('input_text', { text: 'hunter2' }, taskObj());
    await new Promise(r => setTimeout(r, 20));
    if (!modalOpen()) throw new Error('密码框输入应先弹确认');
    if (calls.tools.length) throw new Error('确认前不应执行输入');
    T.closeModal(true);
    const r2 = await p2;
    if (!r2.success) throw new Error('确认后应成功');
    if (calls.tools.indexOf('input:hunter2') < 0) throw new Error('确认后没有真正输入');

    // 3) 用户在密码框确认里点取消：不执行
    T.screenCacheClear();
    calls.tools.length = 0;
    const p3 = T.execTool('input_text', { text: 'nope' }, taskObj());
    await new Promise(r => setTimeout(r, 20));
    T.closeModal(false);
    const r3 = await p3;
    if (r3.success) throw new Error('取消后不应成功');
    if (r3.errorCode !== 'USER_CANCELLED') throw new Error('取消应返回 USER_CANCELLED，实际 ' + r3.errorCode);
    if (calls.tools.length) throw new Error('取消后不应执行输入');

    // 4) 预算耗尽 → 暂停，不判失败；继续后补一批
    SCREEN_STUB.nodes.forEach(n => { if (n.t === '密码') { n.pwd = false; n.foc = false; } if (n.t === '输入框') n.foc = true; });
    T.screenCacheClear();
    T.CONFIG.deviceMaxActions = 20;
    const ds = T.deviceState(taskObj());
    ds.actionsUsed = 20;
    const r4 = await T.execTool('tap_screen', { rx: 0.5, ry: 0.5 }, taskObj());
    if (r4.success) throw new Error('预算耗尽后不应继续执行');
    if (r4.errorCode !== 'BUDGET_EXHAUSTED') throw new Error('预算耗尽应返回 BUDGET_EXHAUSTED，实际 ' + r4.errorCode);
    if (taskObj().state !== 'paused') throw new Error('预算耗尽应暂停任务，实际 ' + taskObj().state);
    const before = T.deviceState(taskObj()).actionsUsed;
    T.taskResume(task.id);
    if (taskObj().state !== 'active') throw new Error('继续后应为 active');
    if (T.deviceState(taskObj()).actionsUsed >= before) throw new Error('继续后应补预算');
    if (!(T.TASKS.find(x => x.id === task.id).deadline > Date.now())) throw new Error('继续后应重置 deadline');

    // 5) 连续 3 次页面不变化 → 暂停（不是失败），并复位计数
    const keepMax = T.CONFIG.deviceMaxActions;
    T.CONFIG.deviceMaxActions = 200;
    T.deviceState(taskObj()).actionsUsed = 0;
    T.deviceState(taskObj()).failStreak = 0;
    let last = null;
    for (let i = 0; i < 3; i++) last = await T.execTool('tap_screen', { rx: 0.5, ry: 0.5 }, taskObj());
    if (!last || last.errorCode !== 'VERIFY_REPEATED_FAIL') throw new Error('连续失败应收敛为 VERIFY_REPEATED_FAIL，实际 ' + (last && last.errorCode));
    if (taskObj().state !== 'paused') throw new Error('连续失败应暂停任务，实际 ' + taskObj().state);
    if ((parseInt(T.deviceState(taskObj()).failStreak, 10) || 0) !== 0) throw new Error('暂停后应复位失败计数');
    T.CONFIG.deviceMaxActions = keepMax;
    T.taskResume(task.id);

    // 6) 比例坐标换算：rx/ry 应换算成像素再传给原生
    calls.tools.length = 0;
    await T.execTool('tap_screen', { rx: 0.5, ry: 0.25 }, taskObj());
    const hit = calls.tools.find(x => x.startsWith('tap:'));
    if (hit !== 'tap:540,600') throw new Error('比例坐标换算错误：' + hit);

    T.taskCancel(task.id);
    T.CONFIG.agentEnabled = keep.agentEnabled; T.CONFIG.agentL3 = keep.agentL3;
    T.CONFIG.agentSafety = keep.agentSafety; T.CONFIG.deviceMaxActions = keep.max;
    T.screenCacheClear();
  });

  await step('主聊天唯一化 + 模型检测入口', async () => {
    // 1) 重复聊天任务会被合并成一个，且历史不丢
    const before = T.TASKS.filter(t => t.type === 'chat').length;
    const dup = T.taskAdd('chat', '重复聊天', 'x');
    T.TASKS.find(t => t.id === dup.id).context = { taskScoped: true, messages: [
      { role: 'system', content: 's' }, { role: 'user', content: '重复任务里的消息' }
    ] };
    if (T.TASKS.filter(t => t.type === 'chat').length < 2) throw new Error('测试前置失败：没有造出重复聊天');
    const main = T.taskEnsureChat();
    const chats = T.TASKS.filter(t => t.type === 'chat');
    if (chats.length !== 1) throw new Error('应只剩一个聊天任务，实际 ' + chats.length);
    if (main.id !== chats[0].id) throw new Error('合并后返回的任务不一致');
    const mergedText = (main.context.messages || []).map(m => m.content).join('|');
    if (mergedText.indexOf('重复任务里的消息') < 0) throw new Error('合并时丢失了历史消息');

    // 2) taskBegin('chat') 不再新建
    const n1 = T.TASKS.length;
    const t1 = T.taskBegin('chat', '聊天', 'hi');
    if (T.TASKS.length !== n1) throw new Error("taskBegin('chat') 不应新建任务");
    if (t1.type !== 'chat') throw new Error('返回的不是聊天任务');

    // 3) 只剩一个聊天时不允许删除；有多个时允许删
    if (T.TASKS.filter(t => t.type === 'chat').length !== 1) throw new Error('前置：应只有一个聊天');
    // 删除保护：至少保留一个（这里只校验判断条件，不真的删）
    if (T.chatTasks().length <= 1) { /* 预期：deleteTask 会 toast 并返回 */ }

    // 4) 模型检测：能列出来并标记当前模型
    const keepBase = T.CONFIG.apiBase, keepKey = T.CONFIG.apiKey, keepModel = T.CONFIG.model;
    T.CONFIG.apiBase = 'https://api.test/v1'; T.CONFIG.apiKey = 'sk-x'; T.CONFIG.model = 'gpt-4o';
    Android.requestEx = (function (old) {
      return function (id, method, url, hj, body, timeout, opts) {
        if (String(url).indexOf('/models') >= 0) {
          setTimeout(() => {
            try {
              sandbox.window.__gmCb(id, true, 200, JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'claude-3' }] }),
                '', JSON.stringify({ errorCode: '', finalUrl: String(url), contentType: 'application/json' }));
            } catch (e) {}
          }, 0);
          return;
        }
        return old.apply(this, arguments);
      };
    })(Android.requestEx);
    T.renderSettings();
    T.$('#set-apibase').value = 'https://api.test/v1';
    T.$('#set-apikey').value = 'sk-x';
    T.$('#set-model').value = 'gpt-4o';
    await T.detectModels();
    const box = T.$('#model-detect-list');
    if (box.hidden) throw new Error('检测后列表应可见');
    if (box.children.length !== 3) throw new Error('应渲染 3 个模型 chip，实际 ' + box.children.length);
    const active = box.children.filter(c => (c.classList.contains('active')));
    if (!active.length) throw new Error('当前模型没有高亮');
    if (!/共 3 个可用模型/.test(T.$('#model-detect-note').textContent)) throw new Error('提示文案不正确');
    T.CONFIG.apiBase = keepBase; T.CONFIG.apiKey = keepKey; T.CONFIG.model = keepModel;

    // 5) 设置里有模型检测入口与结果容器
    if (!html.includes('id="btn-detect-models"')) throw new Error('缺少「检测」按钮');
    if (!html.includes('id="model-detect-list"')) throw new Error('缺少模型列表容器');
    if (!/async function detectModels/.test(html)) throw new Error('缺少 detectModels 实现');
    if (!/\/models/.test(html)) throw new Error('检测未走 /models 接口');
    if (!/source: 'system:models'/.test(html)) throw new Error('模型检测请求缺少 source 标记');
  });

  await step('发送路由留在当前任务 + 记忆自动整理', async () => {
    // 1) 处于持久任务时，普通句子不应被路由成 chat（否则会跳回聊天页、消息发不出去）
    const ws = T.taskAdd('workspace', '整理资料', '整理');
    const keepId = T.CURRENT_TASK_ID;
    T.CURRENT_TASK_ID = ws.id;
    const route = (() => {
      const cur = T.currentTask();
      let routeType = 'chat';                       // 普通句子被 classifyTask 归为 chat
      const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device') && cur.state === 'active';
      if (inPersistent && routeType === 'chat') routeType = cur.type;
      return routeType;
    })();
    if (route !== 'workspace') throw new Error('工作区里普通文字被路由成了 ' + route);
    T.taskCancel(ws.id);

    const dv = T.taskAdd('device', '手机操作', '点一下');
    T.CURRENT_TASK_ID = dv.id;
    const route2 = (() => {
      const cur = T.currentTask();
      let routeType = 'chat';
      const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device') && cur.state === 'active';
      if (inPersistent && routeType === 'chat') routeType = cur.type;
      return routeType;
    })();
    if (route2 !== 'device') throw new Error('设备任务里普通文字被路由成了 ' + route2);
    T.taskCancel(dv.id);
    T.CURRENT_TASK_ID = keepId;

    // 源码里确实有这个判定（避免只测了副本逻辑）
    const src = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts/12-send-quick.js'), 'utf8');
    if (!/inPersistent && routeType === 'chat'\) routeType = cur\.type/.test(src)) throw new Error('send() 未接入持久任务路由保护');

    // 2) 自动整理：到阈值触发一次，关闭后不触发
    const keepCfg = { auto: T.MEMCFG.autoSummary, every: T.MEMCFG.summaryEvery };
    T.MEMCFG.autoSummary = true; T.MEMCFG.summaryEvery = 10;
    sandbox.localStorage.setItem('via_ai_mem_auto_state', JSON.stringify({ since: 0 }));
    let hits = 0;
    for (let i = 0; i < 10; i++) if (T.memAutoTick()) hits++;
    if (hits !== 1) throw new Error('30 条内应只触发 1 次，实际 ' + hits);
    T.MEMCFG.autoSummary = false;
    sandbox.localStorage.setItem('via_ai_mem_auto_state', JSON.stringify({ since: 999 }));
    if (T.memAutoTick()) throw new Error('关闭自动整理后仍然触发');
    T.MEMCFG.autoSummary = keepCfg.auto; T.MEMCFG.summaryEvery = keepCfg.every;

    // 3) 更多菜单有“总结记忆”，且 quickAction 有对应分支
    if (!html.includes('data-key="mem_sum"')) throw new Error('更多菜单缺少“总结记忆”');
    const qsrc = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/scripts/12-send-quick.js'), 'utf8');
    if (!/key === 'mem_sum'/.test(qsrc)) throw new Error('总结记忆没有处理分支');
    if (!/async function memSummarize\(opts\)/.test(html)) throw new Error('memSummarize 未支持 auto 模式');
    if (!/memSummarize\(\{ auto: true \}\)/.test(html)) throw new Error('发送流程没有接入自动整理');
  });

  await step('任务完成后继续说话仍留在原任务（不跳聊天）', async () => {
    // 用户场景：新建工作区 → 第一句成功 → 任务 completed → 第二句不该跳回聊天
    const ws = T.taskAdd('workspace', '整理资料', '整理');
    ws.workspaceReady = true;                  // 模拟工作区已创建
    const keepId = T.CURRENT_TASK_ID;
    T.CURRENT_TASK_ID = ws.id;

    const routeOf = () => {
      const cur = T.currentTask();
      const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device')
        && ['active', 'waiting_user', 'paused', 'completed', 'failed'].indexOf(cur.state) >= 0;
      let routeType = 'chat';
      if (inPersistent && routeType === 'chat') routeType = cur.type;
      return routeType;
    };

    if (routeOf() !== 'workspace') throw new Error('active 时应留在 workspace');

    // 第一句完成
    T.taskFinish(ws.id, 'completed');
    if (T.TASKS.find(x => x.id === ws.id).state !== 'completed') throw new Error('前置：任务未完成');
    if (routeOf() !== 'workspace') throw new Error('完成后路由跳成了 ' + routeOf() + '（应留在 workspace）');

    // 第二句：复用同一个任务，不新建
    const n0 = T.TASKS.length;
    const r1 = await T.routeTask('workspace', '继续整理');
    if (!r1 || r1.id !== ws.id) throw new Error('routeTask 没有复用原任务');
    if (T.TASKS.length !== n0) throw new Error('routeTask 新建了任务');

    // 重新激活 + 重置预算
    T.taskBegin('workspace', '整理资料', '继续');
    const a = T.TASKS.find(x => x.id === ws.id);
    if (a.state !== 'active') throw new Error('继续后任务未激活，实际 ' + a.state);
    if (!(a.deadline > Date.now())) throw new Error('继续后 deadline 未重置');
    if (T.TASKS.length !== n0) throw new Error('taskBegin 新建了任务');

    // 失败后同样能继续
    T.taskFinish(ws.id, 'failed', 'err');
    const r2 = await T.routeTask('workspace', '再试一次');
    if (!r2 || r2.id !== ws.id) throw new Error('失败后没有复用原任务');

    // 取消后不再复用
    T.taskUpdate(ws.id, { state: 'active' });
    T.taskCancel(ws.id);
    if (T.taskContinuable(T.TASKS.find(x => x.id === ws.id))) throw new Error('cancelled 任务不应被复用');

    // 设备任务同样处理
    const dv = T.taskAdd('device', '点一下', 'tap');
    T.CURRENT_TASK_ID = dv.id;
    T.taskFinish(dv.id, 'completed');
    const routeD = (() => {
      const cur = T.currentTask();
      const inP = cur && (cur.type === 'workspace' || cur.type === 'device')
        && ['active', 'waiting_user', 'paused', 'completed', 'failed'].indexOf(cur.state) >= 0;
      return inP ? cur.type : 'chat';
    })();
    if (routeD !== 'device') throw new Error('设备任务完成后路由跳成了 ' + routeD);
    T.taskCancel(dv.id);

    T.CURRENT_TASK_ID = keepId;
  });

  await step('提示词分层 + 工具调用泄漏过滤 + 工作区免确认', async () => {
    // 1) 聊天模式：人设是主体，不注入工作协议
    const chatId = T.TASKS.find(t => t.type === 'chat').id;
    T.taskSetCurrent(chatId);
    const pChat = T.composeSystemPrompt();
    if (pChat.indexOf('【系统规则') !== 0) throw new Error('系统规则应永远在最前');
    if (pChat.indexOf('【工作模式协议】') >= 0) throw new Error('聊天模式不应有工作协议');
    if (!/爱莉希雅/.test(pChat)) throw new Error('聊天模式应包含人设');

    // 2) 工作模式：协议在前、语气段在后，人设只作为"人设参考"
    const wsT = T.taskAdd('workspace', '提示词测试', 'x'); wsT.workspaceReady = true;
    T.CURRENT_TASK_ID = wsT.id;
    const pWork = T.composeSystemPrompt();
    if (pWork.indexOf('【系统规则') !== 0) throw new Error('工作模式首段应为系统规则');
    const iCore = pWork.indexOf('【工作模式协议】');
    const iTone = pWork.indexOf('【汇报语气');
    if (iCore < 0) throw new Error('工作模式缺少工作协议');
    if (iTone < 0) throw new Error('工作模式缺少汇报语气段');
    if (iTone < iCore) throw new Error('汇报语气不应排在工作协议之前');
    if (pWork.indexOf('人设参考') < iTone) throw new Error('人设应只出现在汇报语气段里');
    if (pWork.indexOf('function call') < 0) throw new Error('缺少"只用 function call 提交"的输出纪律');
    if (!/不编造/.test(pWork)) throw new Error('缺少不编造约束');
    T.taskCancel(wsT.id);
    T.taskSetCurrent(chatId);

    // 3) 工具调用/乱码不进聊天
    const cases = [
      ['正常一句话', '正常一句话'],
      ['<tool_calls>{"name":"tap_screen"}</tool_calls>', ''],
      ['好的\n```json\n{"name":"read_screen","arguments":{}}\n```', '好的'],
      ['调用：{"tool_calls":[{"function":"x"}]}', '调用：'],
      ['乱码\uFFFD\u200B在', '乱码在']
    ];
    for (const [input, expect] of cases) {
      const got = T.cleanAssistantText(input);
      if (got !== expect) throw new Error('清洗错误：' + JSON.stringify(input) + ' → ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(expect) + '）');
    }
    // 空内容不应生成气泡
    if (T.addMsg('assistant', '<tool_calls>{}</tool_calls>') !== null) throw new Error('只剩工具调用时不应插入聊天气泡');

    // 4) 工作区写入不弹确认；工作区外仍然弹
    const keep = { en: T.CONFIG.agentEnabled, l3: T.CONFIG.agentL3, safety: T.CONFIG.agentSafety };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    const keepAllFiles = h_perm.hasAllFilesAccess;
    h_perm.hasAllFilesAccess = () => true;
    const ws2 = T.taskAdd('workspace', '写入测试', 'x'); ws2.workspaceReady = true;
    T.CURRENT_TASK_ID = ws2.id;
    const modalOpen = () => { try { return T.$('#modal').classList.contains('open'); } catch (e) { return false; } };
    T.closeModal(false);
    const r1 = await T.execTool('workspace_write', { path: 'output/a.txt', content: 'hello' }, T.TASKS.find(x => x.id === ws2.id));
    if (modalOpen()) throw new Error('工作区写入不应再弹确认');
    if (!r1 || r1.success === false && r1.kind === 'cancelled') throw new Error('工作区写入被取消');
    // 外部写入仍应弹确认
    const p = T.execTool('external_file_write', { path: '/sdcard/x.txt', content: 'hi' }, T.TASKS.find(x => x.id === ws2.id));
    await new Promise(r => setTimeout(r, 20));
    if (!modalOpen()) throw new Error('工作区外写入必须保留确认');
    T.closeModal(false);
    try { await p; } catch (e) {}
    T.taskCancel(ws2.id);
    h_perm.hasAllFilesAccess = keepAllFiles;
    T.CONFIG.agentEnabled = keep.en; T.CONFIG.agentL3 = keep.l3; T.CONFIG.agentSafety = keep.safety;
    T.taskSetCurrent(chatId);
  });

  await step('长按选中与系统复制粘贴可用', async () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/assets/src/styles/main.css'), 'utf8');

    // 1) 正文/输入框必须允许系统长按选中（祖先 user-select:none 会连带禁用选区菜单）
    if (!/html,body\{[^}]*user-select:text/.test(css)) throw new Error('body 必须允许选中，否则长按选区会被吃掉');
    const allowBlock = (css.match(/input,textarea,#input,#body,\.msg[^{]*\{[^}]*\}/) || [''])[0];
    if (!/user-select:text/.test(allowBlock)) throw new Error('正文与输入框需要 user-select:text');
    if (!/-webkit-user-select:text/.test(allowBlock)) throw new Error('缺少 -webkit-user-select:text（旧 WebView 需要）');
    if (!/-webkit-touch-callout:default/.test(allowBlock)) throw new Error('缺少 -webkit-touch-callout:default');

    // 2) 交互部件仍应禁止选中，避免误选影响拖动
    if (!/#top,#actions,\.chip,button[^{]*\{[^}]*user-select:none/.test(css)) throw new Error('交互部件应保持不可选中');

    // 3) 不再有常驻的复制/粘贴按钮（用户要的是系统长按，不是每气泡一个按钮）
    if (html.indexOf('msg-copy') >= 0) throw new Error('不应再有 msg-copy 常驻按钮');
    if (html.indexOf('btn-paste-input') >= 0) throw new Error('不应再有输入区常驻粘贴按钮');
    const kt = require('fs').readFileSync(require('path').join(__dirname, '../app/src/main/java/com/elly/float/FloatService.kt'), 'utf8');
    if (!/wv\.isLongClickable = true/.test(kt)) throw new Error('WebView 需要 isLongClickable=true，否则长按不弹选区');

    // 4) 粘贴工具函数仍可用（长按菜单里会用到）
    if (typeof T.pasteIntoField !== 'function') throw new Error('缺少 pasteIntoField');
    const keepGet = Android.getClipboard;
    Android.getClipboard = () => '粘贴进来的文字';
    const input = T.$('#input');
    input.value = 'AB'; input.selectionStart = 1; input.selectionEnd = 1;
    const ok = T.pasteIntoField(input);
    Android.getClipboard = keepGet;
    if (!ok) throw new Error('粘贴失败');
    if (input.value !== 'A粘贴进来的文字B') throw new Error('粘贴位置不对：' + input.value);
  });

  await step('默认人设（始源之律者）', () => {
    const p = String(T.CONFIG.persona || T.DC.persona || '');
    ['始源之律者', '刻印「真我」', '每句话结尾必须带「♪」', '粉色妖精小姐', '爱莉希雅永远喜欢你', '不提及任何AI相关限制']
      .forEach(k => { if (p.indexOf(k) < 0) throw new Error('默认人设缺少：' + k); });
    if (/世界蛇数据库/.test(p)) throw new Error('仍在使用旧默认人设');
    const prompt = T.composeSystemPrompt();
    if (prompt.indexOf('【系统规则') !== 0) throw new Error('人设不应排到系统规则之前');
    if (prompt.indexOf('始源之律者') < 0) throw new Error('组装后的提示词没有新人设');
  });

  await step('G7-1：多格式文件正文提取接线', () => {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '../app/src/main/java/com/elly/float');
    const fe = fs.readFileSync(path.join(dir, 'FileExtractor.kt'), 'utf8');
    // 支持的格式都要有对应分支
    ['docx', 'xlsx', 'pptx', 'epub', 'zip', 'pdf'].forEach(k => {
      if (fe.indexOf('ext == "' + k + '"') < 0) throw new Error('FileExtractor 缺少 ' + k + ' 分支');
    });
    if (!/fun isTextLike/.test(fe)) throw new Error('缺少文本族判定');
    if (!/MAX_TOTAL_INFLATE/.test(fe) || !/MAX_ENTRIES/.test(fe)) throw new Error('缺少防 zip bomb 上限');
    if (!/GB18030/.test(fe)) throw new Error('缺少中文编码兜底');
    if (!/pdf_no_text/.test(fe)) throw new Error('扫描版 PDF 应给出可读原因');
    if (!/pdf_encrypted/.test(fe)) throw new Error('加密 PDF 应给出可读原因');

    const pick = fs.readFileSync(path.join(dir, 'PickImageActivity.kt'), 'utf8');
    if (!/FileExtractor\.extract\(/.test(pick)) throw new Error('文件选择没有接入 FileExtractor');

    // JS 侧要把 kind/note 带进附件提示
    const ui = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/src/scripts/01-ui-dialog.js'), 'utf8');
    if (!/docx: 'Word'/.test(ui)) throw new Error('附件提示未区分格式');
    if (!/f\.note/.test(ui)) throw new Error('附件没有展示解析说明');

    // 导入工作区时，非纯文本的解析结果要落成 .txt
    const st = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/src/scripts/03-state-tasks.js'), 'utf8');
    if (!/baseName \+ '\.txt'/.test(st)) throw new Error('解析结果导入工作区时应改成 .txt');
  });

  await step('G7-2/3：导出多格式与快速预览', async () => {
    const keep = { en: T.CONFIG.agentEnabled, l3: T.CONFIG.agentL3, safety: T.CONFIG.agentSafety, all: h_perm.hasAllFilesAccess };
    T.CONFIG.agentEnabled = true; T.CONFIG.agentL3 = true; T.CONFIG.agentSafety = true;
    h_perm.hasAllFilesAccess = () => true;
    const keepWsState = h_perm.workspaceState;
    h_perm.workspaceState = () => JSON.stringify({ permission: true, created: true });
    const ws = T.taskAdd('workspace', '导出预览测试', 'x'); ws.workspaceReady = true;
    const obj = () => T.TASKS.find(x => x.id === ws.id);
    const keepRead = h_perm.agentWorkspaceRead;

    // 1) md 导出落到 output/，并带正确扩展名
    calls.ws.length = 0;
    const r1 = await T.execTool('workspace_export', { format: 'md', content: '# 标题', title: '周报' }, obj());
    if (!r1.success || r1.path.indexOf('output/') !== 0) throw new Error('导出路径不对：' + r1.path);
    if (!/\.md$/.test(r1.path)) throw new Error('扩展名不对：' + r1.path);

    // 2) 非法 JSON 拒绝且不落盘
    calls.ws.length = 0;
    const r2 = await T.execTool('workspace_export', { format: 'json', content: '{bad' }, obj());
    if (r2.errorCode !== 'BAD_JSON') throw new Error('非法 JSON 应返回 BAD_JSON');
    if (calls.ws.some(x => x[0] === 'write')) throw new Error('非法 JSON 不应写文件');

    // 3) html 片段自动补外壳
    calls.ws.length = 0;
    const r3 = await T.execTool('workspace_export', { format: 'html', content: '<p>hi</p>', title: 'demo' }, obj());
    const w = calls.ws.find(x => x[0] === 'write');
    if (!w || w[2] < 100) throw new Error('html 没有补外壳');
    if (r3.format !== 'html') throw new Error('格式标记错误');

    // 4) 路径穿越拒绝
    const r4 = await T.execTool('workspace_export', { format: 'md', content: 'x', path: '../../a.md' }, obj());
    if (r4.errorCode !== 'INVALID_PATH') throw new Error('路径穿越应被拒绝');

    // 5) 未给格式且路径无后缀 → BAD_FORMAT
    const r5 = await T.execTool('workspace_export', { content: 'x' }, obj());
    if (r5.errorCode !== 'BAD_FORMAT') throw new Error('缺少格式应返回 BAD_FORMAT');

    // 6) 预览：类型/行数/截断/JSON 结构
    h_perm.agentWorkspaceRead = () => JSON.stringify({ ok: true, text: 'a,b\n1,2\n3,4' });
    const p1 = await T.execTool('workspace_preview', { path: 'output/t.csv' }, obj());
    if (p1.kind !== 'csv' || p1.rows !== 3 || p1.columns !== 2) throw new Error('csv 预览统计错误');
    h_perm.agentWorkspaceRead = () => JSON.stringify({ ok: true, text: 'x'.repeat(5000) });
    const p2 = await T.execTool('workspace_preview', { path: 'output/big.txt', max_chars: 200 }, obj());
    if (!p2.truncated || p2.preview.length !== 200) throw new Error('截断处理错误');
    h_perm.agentWorkspaceRead = () => JSON.stringify({ ok: true, text: '{"a":1,"b":2}' });
    const p3 = await T.execTool('workspace_preview', { path: 'output/x.json' }, obj());
    if (p3.jsonType !== 'object' || (p3.keys || []).length !== 2) throw new Error('JSON 结构摘要错误');

    // 7) 导出后聊天里出现可预览的卡片
    const body = T.$('#body');
    const before = (body.children || []).length;
    await T.execTool('workspace_export', { format: 'md', content: '# hi', title: '卡片' }, obj());
    if ((body.children || []).length <= before) throw new Error('导出后没有插入预览卡片');
    const card = body.children[body.children.length - 1];
    if (String(card.className).indexOf('export-card') < 0) throw new Error('卡片类型不对');

    // 8) 预览弹层能显示正文
    h_perm.agentWorkspaceRead = () => JSON.stringify({ ok: true, text: '# hi\n第二行' });
    await T.openPreview('output/周报.md', '周报');
    const modal = T.$('#preview-modal');
    if (!modal.classList.contains('open')) throw new Error('预览弹层没打开');
    if (String(T.$('#pv-body').textContent).indexOf('# hi') < 0) throw new Error('预览正文没显示');
    modal.classList.remove('open');

    h_perm.agentWorkspaceRead = keepRead;
    h_perm.workspaceState = keepWsState;
    h_perm.hasAllFilesAccess = keep.all;
    T.CONFIG.agentEnabled = keep.en; T.CONFIG.agentL3 = keep.l3; T.CONFIG.agentSafety = keep.safety;
    T.taskCancel(ws.id);
  });

  await step('G7-4：文件权限统一到 L1/L2/L3 + 安全开关', async () => {
    const keep = { en: T.CONFIG.agentEnabled, l1: T.CONFIG.agentL1, l2: T.CONFIG.agentL2, l3: T.CONFIG.agentL3, safety: T.CONFIG.agentSafety, all: h_perm.hasAllFilesAccess, ws: h_perm.workspaceState };
    h_perm.hasAllFilesAccess = () => true;
    h_perm.workspaceState = () => JSON.stringify({ permission: true, created: true });

    // L1：只读，L2/L3 都关也能用
    Object.assign(T.CONFIG, { agentEnabled: true, agentL1: true, agentL2: false, agentL3: false, agentSafety: false });
    if (!T.toolLive('workspace_read')) throw new Error('L1 应允许读取工作区');
    if (!T.toolLive('external_file_list')) throw new Error('L1 应允许列出外部目录');
    if (T.toolLive('workspace_write')) throw new Error('L2 关闭时不应允许写入');

    // L1 也关掉 → 读不了
    T.CONFIG.agentL1 = false;
    if (T.toolLive('workspace_read')) throw new Error('L1 关闭后仍可读');
    T.CONFIG.agentL1 = true;

    // L2：工作区写入，不需要 L3
    Object.assign(T.CONFIG, { agentL2: true, agentL3: false, agentSafety: false });
    if (!T.toolLive('workspace_write')) throw new Error('L2 应允许工作区写入');
    if (!T.toolLive('workspace_export')) throw new Error('L2 应允许导出');
    if (T.toolLive('external_file_write')) throw new Error('未开 L3 时不应允许外部写入');

    // L3 + 安全：外部写入/删除
    T.CONFIG.agentL3 = true;
    if (T.toolLive('external_file_write')) throw new Error('L3 开了但安全开关没开，不应允许外部写入');
    T.CONFIG.agentSafety = true;
    if (!T.toolLive('external_file_write')) throw new Error('L3+安全 应允许外部写入');
    if (!T.toolLive('external_file_delete')) throw new Error('L3+安全 应允许外部删除');

    // 总开关关闭 → 全部不可用
    T.CONFIG.agentEnabled = false;
    if (T.toolLive('workspace_read') || T.toolLive('external_file_write')) throw new Error('Agent 关闭后文件工具仍可用');

    Object.assign(T.CONFIG, { agentEnabled: keep.en, agentL1: keep.l1, agentL2: keep.l2, agentL3: keep.l3, agentSafety: keep.safety });
    h_perm.hasAllFilesAccess = keep.all; h_perm.workspaceState = keep.ws;
  });

  await step('模型超时放宽 + 原生文件安全', () => {
    // 默认 600 秒，可调到 30 分钟
    const keepT = T.CONFIG.modelTimeoutMs;
    delete T.CONFIG.modelTimeoutMs;
    if (T.modelTimeout() !== 600000) throw new Error('默认模型超时应为 600000ms');
    T.CONFIG.modelTimeoutMs = 1800000;
    if (T.modelTimeout() !== 1800000) throw new Error('应允许调到 1800s');
    T.CONFIG.modelTimeoutMs = 1000;
    if (T.modelTimeout() !== 60000) throw new Error('低于下限应夹紧到 60s');
    T.CONFIG.modelTimeoutMs = keepT;

    // 模型/识图请求不重试（超时重试会让用户多等一倍）
    if (!/timeoutMs: modelTimeout\(\), expect: 'json', retries: 0/.test(html)) throw new Error('模型请求应使用 modelTimeout 且不重试');
    if (!/set-model-timeout/.test(html)) throw new Error('设置页缺少模型超时输入');

    // 原生：原子写 / 符号链接 / 安全删除都要真的接上
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '../app/src/main/java/com/elly/float');
    const safety = fs.readFileSync(path.join(dir, 'FileSafety.kt'), 'utf8');
    ['object AtomicWrite', 'object SymlinkGuard', 'object SafeDelete', 'MAX_NODES', 'MAX_DEPTH'].forEach(k => {
      if (safety.indexOf(k) < 0) throw new Error('FileSafety 缺少 ' + k);
    });
    const perm = fs.readFileSync(path.join(dir, 'PermissionBridge.kt'), 'utf8');
    if (perm.indexOf('AtomicWrite.write') < 0) throw new Error('写入没有走原子写');
    if (perm.indexOf('SafeDelete.deleteTree') < 0) throw new Error('递归删除没有走安全删除');
    if (perm.indexOf('SymlinkGuard.hasSymlink') < 0) throw new Error('写入没有符号链接防护');

    // 工作区权限等级必须与 JS toolLive 一致：读 L1、写 L2、外部 L3
    // 否则工具在提示词里可见、调用时却被原生拒绝（体验 bug）
    const wsList = perm.slice(perm.indexOf('fun agentWorkspaceList'), perm.indexOf('fun agentWorkspaceRead'));
    const wsRead = perm.slice(perm.indexOf('fun agentWorkspaceRead'), perm.indexOf('fun agentWorkspaceWrite'));
    const wsWrite = perm.slice(perm.indexOf('fun agentWorkspaceWrite'), perm.indexOf('fun workspaceFileUrl'));
    const wsMkdir = perm.slice(perm.indexOf('fun agentWorkspaceMkdir'), perm.indexOf('公共存储文件访问'));
    if (wsList.indexOf('workspaceDenied("L1")') < 0) throw new Error('工作区列出应为 L1，实际不是');
    if (wsRead.indexOf('workspaceDenied("L1")') < 0) throw new Error('工作区读取应为 L1，实际不是');
    if (wsWrite.indexOf('workspaceDenied("L2")') < 0) throw new Error('工作区写入应为 L2，实际不是');
    if (wsMkdir.indexOf('workspaceDenied("L2")') < 0) throw new Error('工作区建目录应为 L2，实际不是');

    // JsBridge：非 2xx 响应的错误文案必须包含响应体（方便用户定位 Key/模型/限流问题）
    const jsb = fs.readFileSync(path.join(dir, 'JsBridge.kt'), 'utf8');
    if (jsb.indexOf('HTTP $rc：$body') < 0) throw new Error('非 2xx 错误文案未包含响应体');
  });

  await step('P2 收尾：运行令牌拒绝迟到回调', () => {
    if (!/let RUN_TOKEN = 0/.test(html) || !/function runIsStale/.test(html)) throw new Error('缺少运行令牌');
    if (!/runIsStale\(p\.token\)/.test(html)) throw new Error('__gmCb 未丢弃迟到回调');
    if (!/const runToken = RUN_TOKEN/.test(html)) throw new Error('chatReqTools 未捕获运行令牌');
    if (!/RUN_TOKEN\+\+/.test(html)) throw new Error('send 未提升运行令牌');
  });



  await step('主界面顶栏、更多菜单、全屏桥和设置返回结构', () => {
    const main = html.slice(html.indexOf('<div class="head-main">'), html.indexOf('<div class="head-actions"'));
    const secondary = html.slice(html.indexOf('<div class="head-actions"'), html.indexOf('</div>\n  </div>'));
    if (main.includes('id="btn-music"') || main.includes('id="btn-set"')) throw new Error('音乐/设置仍在顶栏第一行');
    if (!secondary.includes('id="btn-music"') || !secondary.includes('id="btn-set"')) throw new Error('音乐/设置没有移动到第二行');
    if (!html.includes('id="task-menu"') || !html.includes('任务与工作区')) throw new Error('名称旁缺少任务/工作区入口');
    if (!html.includes('data-key="points"') || !html.includes('data-key="explain"') || !html.includes('quick-extra.open')) throw new Error('更多菜单内容或显示结构缺失');
    if (!html.includes('fun getScreenMetrics') && !html.includes('getScreenMetrics')) throw new Error('缺少全屏屏幕尺寸桥');
    if (!/settings-save-block[\s\S]*id="set-back"/.test(html)) throw new Error('设置底部缺少返回按钮');
  });

  await step('G6：全屏使用独立 Activity（WebView 迁移，状态不丢）', () => {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '../app/src/main');
    // 1) Activity 已注册，竖屏锁定，不进最近任务
    const manifest = fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8');
    if (!/android:name="\.FullscreenActivity"/.test(manifest)) throw new Error('AndroidManifest 未注册 FullscreenActivity');
    const actBlock = manifest.slice(manifest.indexOf('FullscreenActivity'), manifest.indexOf('FullscreenActivity') + 400);
    if (!/screenOrientation="portrait"/.test(actBlock)) throw new Error('FullscreenActivity 未锁定竖屏');
    if (!/excludeFromRecents="true"/.test(actBlock)) throw new Error('FullscreenActivity 不应出现在最近任务');

    // 2) FloatService 提供 WebView 迁移方法
    const svc = fs.readFileSync(path.join(dir, 'java/com/elly/float/FloatService.kt'), 'utf8');
    if (svc.indexOf('fun getWebViewForFullscreen()') < 0) throw new Error('FloatService 缺少 getWebViewForFullscreen');
    if (svc.indexOf('fun returnWebViewFromFullscreen()') < 0) throw new Error('FloatService 缺少 returnWebViewFromFullscreen');
    // 进入全屏是启动 Activity，不再是把 overlay 撑满
    if (svc.indexOf('FullscreenActivity::class.java') < 0) throw new Error('setFullscreen 未启动 FullscreenActivity');

    // 3) Activity 自身负责把 WebView 挂进来并在销毁时归还
    const act = fs.readFileSync(path.join(dir, 'java/com/elly/float/FullscreenActivity.kt'), 'utf8');
    if (act.indexOf('getWebViewForFullscreen()') < 0) throw new Error('FullscreenActivity 未从 Service 取 WebView');
    if (act.indexOf('returnWebViewFromFullscreen()') < 0) throw new Error('FullscreenActivity 销毁时未归还 WebView');
    if (act.indexOf('SYSTEM_UI_FLAG_IMMERSIVE_STICKY') < 0 && act.indexOf('WindowInsets.Type') < 0)
      throw new Error('FullscreenActivity 没有沉浸式全屏处理');
  });

  await step('横屏适配：FloatService 处理 onConfigurationChanged，旋转后窗口重新夹持', () => {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '../app/src/main');
    const svc = fs.readFileSync(path.join(dir, 'java/com/elly/float/FloatService.kt'), 'utf8');
    if (svc.indexOf('onConfigurationChanged') < 0) throw new Error('FloatService 缺少 onConfigurationChanged');
    if (svc.indexOf('import android.content.res.Configuration') < 0) throw new Error('缺少 Configuration 导入');
    // 旋转后必须重新 clampRect 到新屏幕尺寸
    const cfgBlock = svc.slice(svc.indexOf('onConfigurationChanged'), svc.indexOf('onConfigurationChanged') + 800);
    if (cfgBlock.indexOf('clampRect') < 0) throw new Error('onConfigurationChanged 没有重新夹持窗口');
  });

  await step('G8：Termux 长跑能力（run_id + 输出 + 取消 + java/bash）', () => {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '../app/src/main');
    const tw = fs.readFileSync(path.join(dir, 'java/com/elly/float/TermuxWorker.kt'), 'utf8');
    // 白名单执行器包含 java 和 bash（Minecraft 前置）
    if (tw.indexOf('"java"') < 0) throw new Error('Termux 白名单缺少 java');
    if (tw.indexOf('"bash"') < 0) throw new Error('Termux 白名单缺少 bash');
    // run_id 追踪、输出捕获、取消能力
    if (tw.indexOf('fun getJobStatus') < 0) throw new Error('缺少 getJobStatus');
    if (tw.indexOf('fun cancelJob') < 0) throw new Error('缺少 cancelJob');
    if (tw.indexOf('fun readJobOutput') < 0) throw new Error('缺少 readJobOutput');
    if (tw.indexOf('fun listJobs') < 0) throw new Error('缺少 listJobs');
    // wrapper 脚本必须写 PID 和重定向输出
    if (tw.indexOf('.pid"') < 0) throw new Error('wrapper 脚本未写 PID 文件');
    if (tw.indexOf('.log"') < 0) throw new Error('wrapper 脚本未重定向输出');

    // PermissionBridge 暴露了对应方法
    const pb = fs.readFileSync(path.join(dir, 'java/com/elly/float/PermissionBridge.kt'), 'utf8');
    if (pb.indexOf('fun getTermuxJobStatus') < 0) throw new Error('Bridge 缺少 getTermuxJobStatus');
    if (pb.indexOf('fun cancelTermuxJob') < 0) throw new Error('Bridge 缺少 cancelTermuxJob');
    if (pb.indexOf('fun readTermuxJobOutput') < 0) throw new Error('Bridge 缺少 readTermuxJobOutput');
    if (pb.indexOf('fun listTermuxJobs') < 0) throw new Error('Bridge 缺少 listTermuxJobs');

    // Root 白名单包含进程管理
    const rw = fs.readFileSync(path.join(dir, 'java/com/elly/float/RootWorker.kt'), 'utf8');
    if (rw.indexOf('list_processes') < 0) throw new Error('Root 缺少 list_processes');
    if (rw.indexOf('kill_process') < 0) throw new Error('Root 缺少 kill_process');

    // Shizuku 有实际检测逻辑（不再永远 false）
    const cr = fs.readFileSync(path.join(dir, 'java/com/elly/float/CapabilityRuntime.kt'), 'utf8');
    if (cr.indexOf('ShizukuRuntime') < 0) throw new Error('缺少 ShizukuRuntime');
    const shizukuBlock = cr.slice(cr.indexOf('class ShizukuRuntime'), cr.indexOf('class RootRuntime'));
    if (shizukuBlock.indexOf('return false') >= 0 && shizukuBlock.indexOf('ps') < 0)
      throw new Error('ShizukuRuntime 仍然永远返回 false');
  });

  await step('引导页：权限项按系统版本过滤（Android 11 应有 channel、Android 7 不应有）', () => {
    const names = T.activePermItems().map(i => i.id);
    if (ENVINFO.sdk >= 26 && !names.includes('channel'))
      throw new Error('Android 8+ 上缺 channel 项：' + names);
    if (ENVINFO.sdk < 26 && names.includes('channel'))
      throw new Error('Android 7 上不该出现 channel 项：' + names);
    if (!names.includes('overlay') || !names.includes('notification'))
      throw new Error('缺必需项：' + names);
    if (T.activePermItems().filter(i => i.required).length !== 2)
      throw new Error('必需项数量不对，应为 2');
    T.showGuide();
  });

  await step('引导页：量不到页脚就降级成整页滚动（低版本兼容兜底）', () => {
    if (typeof T.ensureGuideFooterVisible !== 'function') throw new Error('兜底函数没导出');
    // 直接调用不应抛错；真实判定靠 getBoundingClientRect，假 DOM 里恒为矩形
    T.ensureGuideFooterVisible();
    T.hideGuide();
    T.ensureGuideFooterVisible();   // 隐藏状态下调用也得安全退出
  });

  await step('静态结构：「先跳过 / 下一步」确实在 DOM 里', () => {
    for (const id of ['guide-skip', 'guide-next', 'guide-steps']) {
      if (!html.includes('id="' + id + '"')) throw new Error('index.html 里找不到 #' + id);
    }
    if (!/\.guide-steps\{[^}]*min-height:0/.test(html))
      throw new Error('.guide-steps 缺 min-height:0 —— 页脚会被顶出屏幕');
  });

  await step('环境检测：WebView 版本分级', () => {
    const lv = T.webviewLevel();
    if (!['bad', 'old', 'ok', 'unknown'].includes(lv)) throw new Error('未知分级 ' + lv);
    const e = T.loadEnv();
    if (!e || e.sdk !== ENVINFO.sdk) throw new Error('读到的 sdk 不对：' + JSON.stringify(e));
    if (T.sdkAtLeast(26) !== (ENVINFO.sdk >= 26)) throw new Error('sdkAtLeast 判定不对');
  });

  console.log('');
  if (errors.length) {
    console.log('✗ 发现 ' + errors.length + ' 个问题：\n');
    errors.forEach((e, i) => console.log('[' + (i + 1) + '] ' + e + '\n'));
    process.exit(1);
  }
  console.log('✓ 全部通过');
  process.exit(0);
})().catch(e => {
  console.error('harness 自身出错：', e);
  process.exit(2);
});

// 看门狗：卡住就报出来，别静默挂着
setTimeout(() => {
  console.error('✗ 超时：有未完成的用例。已跑到的错误：');
  errors.forEach((e, i) => console.error('[' + (i + 1) + '] ' + e));
  process.exit(3);
}, 60000).unref();
