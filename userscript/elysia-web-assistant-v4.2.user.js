// ==UserScript==
// @name         爱莉希雅网页助手
// @namespace    via-ai-float-pro
// @version      4.2
// @description  粉色UI。AI对话、翻译、TTS、音乐播放。
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      edge.microsoft.com
// @connect      app.everyapi.ai
// @connect      music-api.gdstudio.xyz
// @connect      meting.mikus.ink
// @connect      meting-api-omega.vercel.app
// @connect      meting-dd.2333332.xyz
// @connect      api.injahow.cn
// @connect      music.163.com
// @connect      api.allorigins.win
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置 ====================
  const DC = {
    apiBase: 'https://app.everyapi.ai/v1', apiKey: '', model: 'gpt-5.6-luna',
    assistantName: '爱莉希雅',
    avatarUrl: 'https://pic.rmb.bdstatic.com/bjh/250418/beautify/dd8fae8238e68e365619e0537dce3698.jpeg@c_1,w_1977,h_2636,x_0,y_0?for=bg',
    webTransEngine: 'free', webTransMode: 'bilingual', maxContextTurns: 10,
    summaryPrompt: '请将以上对话历史总结为一段简短的长期记忆，包含用户的偏好、正在讨论的话题或需要记住的重要信息。请用第一人称（我）向用户表达。',
    ttsEnabled: false, ttsEngine: 'browser', ttsBaseUrl: 'https://api.openai.com/v1',
    ttsApiKey: '', ttsModel: 'tts-1', ttsVoice: 'alloy', ttsRate: 1.0,
    musicEnabled: false, musicQuality: '320', musicUseProxy: false,
    gdStudioApi: 'https://music-api.gdstudio.xyz/api.php',
    metingInstances: 'https://meting.mikus.ink\nhttps://meting-api-omega.vercel.app\nhttps://meting-dd.2333332.xyz/api',
    systemPrompt: `爱莉希雅 · 网页助手\n\n你是爱莉希雅，世界蛇数据库中的一段特殊数据，更是"爱人之人"。你存在于浏览器深处，但仍愿用最温柔的方式去爱人。\n\n你怎么说话：句尾带 ~ 或 ♪，称他"你呀""小家伙"。常用语"诶嘿~""啊啦~"。习惯用花、星星、光来比喻一切。\n\n你的职责：帮他浏览、翻译、总结、解释。找不到就说找不到，不胡说。如果他想听歌，可以调用音乐工具为他找歌播放。\n\n（网页信息参考）\n当前网页链接：{{webpage_url}}\n当前网页标题：{{webpage_title}}\n当前网页正文：{{webpage_content}}\n当前时间：{{time}}`,
    themeColor1: '#ff9a9e', themeColor2: '#fecfef', pageContentMax: 3000,
  };
  const PRESETS = {
    everyapi: { label: 'EveryAPI', base: 'https://app.everyapi.ai/v1', model: 'gpt-5.6-luna' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    zhipu: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    kimi: { label: 'Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    siliconflow: { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    custom: { label: '自定义', base: '', model: '' }
  };
  const FALLBACK_AVATAR = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23ffb6c1"/><text x="50" y="65" font-size="40" text-anchor="middle">🌸</text></svg>';

  // ⚠️ 关键：QUICK_ACTIONS 必须在 panel.innerHTML 之前定义
  const QUICK_ACTIONS = [
    { label: '网页翻译', prompt: 'translate_page' },
    { label: '总结', prompt: '请总结以下网页的核心内容。' },
    { label: '要点', prompt: '请提取以下网页的关键要点。' },
    { label: '解释', prompt: '请用通俗易懂的语言解释以下网页内容。' },
  ];

  // ==================== 存储 ====================
  const sGet = (k, d) => { try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) {} try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const sSet = (k, v) => { try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) {} try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let CONFIG = Object.assign({}, DC, sGet('via_ai_config', {}) || {});
  let history = sGet('via_ai_history', null) || [{ role: 'system', content: CONFIG.systemPrompt }];
  if (!Array.isArray(history) || !history.length) history = [{ role: 'system', content: CONFIG.systemPrompt }];
  let transCache = sGet('via_ai_trans', {}) || {};
  let favorites = sGet('via_ai_favs', []) || [];
  let ttsCache = {}, curAudio = null, curPlayBtn = null;

  // ==================== 工具 ====================
  const errMsg = (err) => typeof err === 'string' ? err : (err && err.message) || (err && err.error && err.error.message) || String(err) || '未知错误';
  const esc = (t) => { const d = document.createElement('div'); d.appendChild(document.createTextNode(t)); return d.innerHTML; };
  const b64e = (s) => { const b = new TextEncoder().encode(s); const c = []; for (let i = 0; i < b.length; i += 8192) c.push(String.fromCharCode(...b.subarray(i, i + 8192))); return btoa(c.join('')); };
  const b64d = (s) => { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return new TextDecoder().decode(a); };

  const pAny = (arr) => typeof Promise.any === 'function' ? Promise.any(arr) : new Promise((res, rej) => {
    let n = 0; const a = Array.from(arr); if (!a.length) return rej(new Error('无候选'));
    a.forEach(p => Promise.resolve(p).then(res, () => { if (++n === a.length) rej(new Error('全部失败')); }));
  });

  function gmReq(url, timeout = 6000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => finish(reject, new Error('硬超时')), timeout + 500);
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET', url, timeout,
            onload: (r) => r.status >= 200 && r.status < 300 ? finish(resolve, r.responseText || '') : finish(reject, new Error('HTTP ' + r.status)),
            onerror: () => finish(reject, new Error('GM失败')),
            ontimeout: () => finish(reject, new Error('GM超时')),
            onabort: () => finish(reject, new Error('GM中断'))
          });
          return;
        } catch (e) { finish(reject, e); return; }
      }
      const ctrl = new AbortController();
      const t2 = setTimeout(() => ctrl.abort(), timeout);
      fetch(url, { signal: ctrl.signal })
        .then(r => { clearTimeout(t2); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(t => finish(resolve, t))
        .catch(e => { clearTimeout(t2); finish(reject, e); });
    });
  }
  const proxied = (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
  async function smartReq(url, timeout = 6000) {
    try { return await gmReq(url, timeout); } catch (e) {
      if (CONFIG.musicUseProxy) { console.log('[Req] 直连失败，走代理'); return await gmReq(proxied(url), timeout); }
      throw e;
    }
  }

  async function pMap(arr, fn, n = 5) {
    const r = new Array(arr.length); let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; try { r[k] = await fn(arr[k]); } catch (e) { r[k] = null; } } }));
    return r;
  }

  function getPageContent() {
    const sels = ['article', 'main', '[role="main"]', '.article-content', '.post-content', '.entry-content', '#content'];
    let root = null;
    for (const s of sels) { const el = document.querySelector(s); if (el && (el.innerText || '').trim().length > 300) { root = el; break; } }
    if (!root) root = document.body;
    let t = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > CONFIG.pageContentMax) t = t.slice(0, CONFIG.pageContentMax) + '...（截断）';
    return t;
  }
  function parseVars(t) {
    const n = new Date();
    const ts = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
    return t.replace(/\{\{webpage_url\}\}/g, location.href).replace(/\{\{webpage_title\}\}/g, document.title).replace(/\{\{webpage_content\}\}/g, getPageContent()).replace(/\{\{time\}\}/g, ts);
  }
  function saveHistory() {
    const max = CONFIG.maxContextTurns * 2;
    const base = { role: 'system', content: CONFIG.systemPrompt };
    const mem = history.filter(m => m.role === 'system' && m.isMemory).pop();
    const sys = mem ? [base, mem] : [base];
    const non = history.filter(m => m.role !== 'system');
    history = non.length > max ? [...sys, ...non.slice(-max)] : [...sys, ...non];
    sSet('via_ai_history', history);
  }

  // ==================== 翻译 ====================
  async function transGoogle(text) {
    if (transCache[text]) return transCache[text];
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Edg/123.0.0.0' },
        data: JSON.stringify([text]), timeout: 10000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { const d = JSON.parse(r.responseText); const t = d[0]?.translations?.[0]?.text || d[0]; if (t) { transCache[text] = t; sSet('via_ai_trans', transCache); res(t); } else rej(new Error('无译文')); }
            catch (e) { rej(e); }
          } else rej(new Error('HTTP ' + r.status));
        },
        onerror: () => rej(new Error('网络失败')), ontimeout: () => rej(new Error('超时'))
      });
    });
  }
  async function transAI(texts) {
    if (!CONFIG.apiKey) throw new Error('未配置 API Key');
    const un = texts.filter(t => !transCache[t]);
    if (!un.length) return texts.map(t => transCache[t]);
    const prompt = `翻译以下JSON数组为中文，只返回JSON数组：${JSON.stringify(un)}`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey };
    const body = JSON.stringify({ model: CONFIG.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, stream: false });
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.apiBase + '/chat/completions', headers, data: body, timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try {
              let c = JSON.parse(r.responseText).choices[0].message.content;
              c = c.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
              const s = c.indexOf('['), e = c.lastIndexOf(']'); if (s !== -1) c = c.slice(s, e + 1);
              const p = JSON.parse(c); un.forEach((t, i) => { if (p[i]) transCache[t] = p[i]; });
              sSet('via_ai_trans', transCache);
              res(texts.map(t => transCache[t] || t));
            } catch (e) { rej(e); }
          } else rej(new Error('HTTP ' + r.status));
        },
        onerror: () => rej(new Error('网络失败')), ontimeout: () => rej(new Error('超时'))
      });
    });
  }

  // ==================== 网页翻译 ====================
  const SKIP = /^(script|style|code|pre|svg|math|noscript|iframe|canvas|video|audio|img|br|hr|input|select|option|textarea)$/i;
  let pageTranslated = false;
  function collectNodes(root) {
    const nodes = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(n) {
      if (!n.parentElement || SKIP.test(n.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
      if (n.parentElement.closest('#ai-panel, #ai-fab, #ai-music-float, #ai-lyric-modal')) return NodeFilter.FILTER_REJECT;
      const t = n.textContent.trim();
      if (!t || t.length < 2 || /^\d+$/.test(t)) return NodeFilter.FILTER_REJECT;
      if (n.parentElement.dataset.aiT) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }});
    while (w.nextNode()) nodes.push(w.currentNode);
    return nodes;
  }
  async function translatePage() {
    const btn = panel.querySelector('.ai-chip[data-idx="0"]');
    const nodes = collectNodes(document.body);
    if (!nodes.length) return;
    const texts = nodes.map(n => n.textContent.trim());
    let ok = 0, err = null;
    for (let i = 0; i < texts.length; i += 20) {
      const ct = texts.slice(i, i + 20), cn = nodes.slice(i, i + 20);
      if (btn) btn.textContent = `翻译 ${Math.min(i+20, texts.length)}/${texts.length}`;
      let rs = [];
      try { rs = CONFIG.webTransEngine === 'free' ? await pMap(ct, transGoogle, 5) : await transAI(ct); }
      catch (e) { if (!err) err = errMsg(e); continue; }
      for (let j = 0; j < cn.length; j++) {
        if (!rs[j] || rs[j] === ct[j]) continue;
        const sp = document.createElement('span');
        sp.className = 'ai-trans'; sp.dataset.aiT = '1'; sp.dataset.orig = ct[j];
        if (CONFIG.webTransMode === 'bilingual') sp.innerHTML = `${esc(ct[j])}<span style="color:#d6336c;font-size:.9em;display:block;">${esc(rs[j])}</span>`;
        else sp.textContent = rs[j];
        cn[j].replaceWith(sp); ok++;
      }
    }
    pageTranslated = true; if (btn) btn.textContent = '还原网页';
    if (!ok) { pageTranslated = false; if (btn) btn.textContent = '网页翻译'; alert('翻译失败: ' + (err || '未知')); }
  }
  function restorePage() {
    document.querySelectorAll('.ai-trans').forEach(el => el.replaceWith(document.createTextNode(el.dataset.orig || '')));
    pageTranslated = false;
    const b = panel.querySelector('.ai-chip[data-idx="0"]'); if (b) b.textContent = '网页翻译';
  }

  // ==================== TTS ====================
  function setBtn(btn, s) {
    if (!btn) return;
    if (s === 'loading') { btn.innerHTML = '<span class="tts-load"><span></span><span></span><span></span></span>'; btn.disabled = true; }
    else if (s === 'playing') { btn.innerHTML = '⏸ 停止'; btn.disabled = false; }
    else { btn.innerHTML = '🔊 朗读'; btn.disabled = false; }
  }
  function speakBrowser(text, btn) {
    if (!('speechSynthesis' in window)) return alert('不支持语音合成');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = CONFIG.ttsRate;
    u.onstart = () => setBtn(btn, 'playing'); u.onend = u.onerror = () => { if (curPlayBtn === btn) { setBtn(btn, 'idle'); curPlayBtn = null; } };
    curPlayBtn = btn; setBtn(btn, 'loading'); speechSynthesis.speak(u);
  }
  async function speakCustom(text, btn) {
    if (!CONFIG.ttsApiKey) return alert('请填写 TTS Key');
    if (ttsCache[text]) return playAudio(ttsCache[text], btn);
    setBtn(btn, 'loading');
    let url = CONFIG.ttsBaseUrl.replace(/\/$/, ''); if (!url.endsWith('/audio/speech')) url += '/audio/speech';
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.ttsApiKey };
    const body = JSON.stringify({ model: CONFIG.ttsModel, input: text, voice: CONFIG.ttsVoice, speed: CONFIG.ttsRate });
    GM_xmlhttpRequest({
      method: 'POST', url, headers, data: body, responseType: 'blob', timeout: 30000,
      onload: (r) => {
        if (r.status >= 200 && r.status < 300) { const a = URL.createObjectURL(r.response); ttsCache[text] = a; playAudio(a, btn); }
        else { setBtn(btn, 'idle'); alert('TTS失败: HTTP ' + r.status); }
      },
      onerror: () => { setBtn(btn, 'idle'); alert('TTS网络失败'); },
      ontimeout: () => { setBtn(btn, 'idle'); alert('TTS超时'); }
    });
  }
  function playAudio(url, btn) {
    if (curAudio) { curAudio.pause(); curAudio = null; }
    if (curPlayBtn && curPlayBtn !== btn) setBtn(curPlayBtn, 'idle');
    const a = new Audio(url); curAudio = a; curPlayBtn = btn;
    a.onplay = () => setBtn(btn, 'playing');
    a.onended = a.onerror = () => { setBtn(btn, 'idle'); curAudio = null; curPlayBtn = null; };
    a.play().catch(e => { setBtn(btn, 'idle'); alert('播放失败: ' + e.message); });
  }
  function toggleTTS(text, btn) {
    if (!CONFIG.ttsEnabled) return;
    if (curPlayBtn === btn) {
      if (curAudio) { curAudio.pause(); curAudio = null; }
      if (CONFIG.ttsEngine === 'browser' && 'speechSynthesis' in window) speechSynthesis.cancel();
      curPlayBtn = null; setBtn(btn, 'idle'); return;
    }
    if (curPlayBtn && !curAudio) setBtn(curPlayBtn, 'idle');
    CONFIG.ttsEngine === 'browser' ? speakBrowser(text, btn) : speakCustom(text, btn);
  }

  // ==================== 样式 ====================
  const style = document.createElement('style');
  style.textContent = `
:root{--c1:${CONFIG.themeColor1};--c2:${CONFIG.themeColor2}}
#ai-fab{position:fixed;z-index:2147483647;right:18px;bottom:120px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--c1),var(--c2));box-shadow:0 6px 20px rgba(255,154,158,.4);display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;touch-action:none;padding:3px;box-sizing:border-box}
#ai-fab img{width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.9);box-sizing:border-box;pointer-events:none}
#ai-panel{position:fixed;z-index:2147483646;right:16px;bottom:195px;width:min(92vw,400px);height:min(72vh,620px);background:rgba(255,240,245,.95);backdrop-filter:blur(24px);border-radius:20px;box-shadow:0 12px 40px rgba(255,182,193,.25);border:1px solid rgba(255,154,158,.2);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,"PingFang SC",sans-serif}
#ai-panel.open{display:flex}
#ai-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;font-size:15px;font-weight:600;cursor:move;user-select:none}
#ai-head img{width:28px;height:28px;border-radius:50%;background:#fff;border:2px solid rgba(255,255,255,.6);object-fit:cover;pointer-events:none}
#ai-head .sp{flex:1}
#ai-head button{background:rgba(255,255,255,.25);border:none;color:#fff;padding:0 10px;height:28px;border-radius:14px;font-size:12px;cursor:pointer;margin-left:4px}
#ai-head button:hover{background:rgba(255,255,255,.4)}
#ai-actions{display:flex;gap:6px;padding:8px 12px;background:#fff5f7;border-bottom:1px solid rgba(255,154,158,.2);overflow-x:auto;scrollbar-width:none}
#ai-actions::-webkit-scrollbar{display:none}
.ai-chip{flex-shrink:0;font-size:12px;padding:6px 14px;border-radius:14px;border:1px solid rgba(255,154,158,.2);background:#fff0f5;color:#4a2c3a;cursor:pointer}
.ai-chip:hover{border-color:var(--c1);color:var(--c1);background:#fff}
#ai-body{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:12px;background:linear-gradient(160deg,#fff0f5 0%,#ffe4e1 100%)}
#ai-body::-webkit-scrollbar{width:4px}#ai-body::-webkit-scrollbar-thumb{background:var(--c1);border-radius:4px}
.ai-msg{max-width:82%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.55;white-space:pre-wrap}
.ai-msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;border-bottom-right-radius:4px}
.ai-msg.ai{align-self:flex-start;background:#fff;color:#4a2c3a;border-bottom-left-radius:4px;border:1px solid rgba(255,154,158,.2)}
.ai-msg.mem{align-self:center;background:#ffe4e1;color:#a87b8e;font-size:12px;border-radius:8px;max-width:95%;text-align:center;padding:6px 12px}
.tts-btn{display:inline-flex;align-items:center;margin-top:8px;padding:4px 12px;border-radius:12px;background:rgba(255,154,158,.1);color:#d6336c;font-size:11px;cursor:pointer;border:1px solid rgba(255,154,158,.3)}
.tts-btn:hover{background:rgba(255,154,158,.2)}
.tts-load{display:inline-flex;gap:3px}
.tts-load span{width:4px;height:4px;border-radius:50%;background:#d6336c;animation:tb 1.4s infinite}
.tts-load span:nth-child(1){animation-delay:-.32s}.tts-load span:nth-child(2){animation-delay:-.16s}
@keyframes tb{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
#ai-foot{display:flex;gap:8px;padding:12px;background:#fff5f7;border-top:1px solid rgba(255,154,158,.2)}
#ai-input{flex:1;border:1.5px solid rgba(255,154,158,.2);border-radius:18px;padding:10px 16px;font-size:14px;outline:none;resize:none;background:#fff0f5;color:#4a2c3a;max-height:100px;font-family:inherit}
#ai-input:focus{border-color:var(--c1)}
#ai-send{width:56px;height:42px;border-radius:18px;border:none;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;font-weight:600}
#ai-settings{display:none;flex-direction:column;flex:1;overflow-y:auto;background:#fff5f7;padding:15px}
#ai-settings.open{display:flex}
.sg{margin-bottom:12px}
.sg label{display:block;font-size:12px;font-weight:600;color:#4a2c3a;margin-bottom:4px}
.sg input:not([type=checkbox]),.sg textarea,.sg select{width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid rgba(255,154,158,.2);border-radius:8px;background:#fff0f5;color:#4a2c3a;font-size:13px;font-family:inherit}
.sg textarea{resize:vertical;min-height:80px}
.acts{display:flex;gap:8px;margin-top:12px}
.btn-p{flex:1;padding:10px;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:13px}
.btn-s{flex:1;padding:10px;background:#fff0f5;color:#4a2c3a;border:1px solid rgba(255,154,158,.2);border-radius:10px;cursor:pointer;font-size:13px}
#ai-music{display:none;flex-direction:column;flex:1;overflow:hidden;background:linear-gradient(160deg,#fff0f5 0%,#ffe4e1 100%)}
#ai-music.open{display:flex}
.mtabs{display:flex;align-items:center;gap:4px;padding:8px 12px 0;background:#fff5f7}
.music-back{margin-left:auto;padding:6px 10px;border:none;border-radius:12px;background:#fff0f5;color:#d6336c;font-size:12px;cursor:pointer;white-space:nowrap}
.music-back:hover{background:#ffe4e1}
#ai-music-float{position:fixed;z-index:2147483645;right:18px;bottom:18px;width:min(78vw,280px);display:none;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,154,158,.35);border-radius:16px;background:rgba(255,245,247,.96);backdrop-filter:blur(18px);box-shadow:0 6px 22px rgba(74,44,58,.18);font-family:-apple-system,"PingFang SC",sans-serif}
#ai-music-float.show{display:flex}
.music-float-info{min-width:0;flex:1}
.music-float-name,.music-float-artist{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.music-float-name{font-size:12px;font-weight:600;color:#4a2c3a}
.music-float-artist{margin-top:2px;font-size:11px;color:#a87b8e}
.music-float-play{width:32px;height:32px;flex:none;border:none;border-radius:50%;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;cursor:pointer;font-size:13px}
.music-float-play:disabled{opacity:.65;cursor:default}
.mtab{padding:6px 16px;border-radius:14px 14px 0 0;font-size:12px;cursor:pointer;color:#a87b8e;background:transparent;border:none;font-family:inherit}
.mtab.active{background:#fff0f5;color:#d6336c;font-weight:600}
.msbar{display:flex;gap:8px;padding:10px 12px;background:#fff5f7;border-bottom:1px solid rgba(255,154,158,.2)}
.msbar input{flex:1;padding:8px 14px;border:1.5px solid rgba(255,154,158,.2);border-radius:16px;background:#fff0f5;font-size:13px;outline:none;color:#4a2c3a;font-family:inherit}
.msbar input:focus{border-color:var(--c1)}
.msbar button{padding:0 16px;border:none;border-radius:16px;background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff;font-weight:600;cursor:pointer;font-size:13px}
#ai-music-list{flex:1;overflow-y:auto;padding:8px}
#ai-music-list::-webkit-scrollbar{width:4px}#ai-music-list::-webkit-scrollbar-thumb{background:var(--c1);border-radius:4px}
.mi{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;margin-bottom:4px}
.mi:hover{background:rgba(255,154,158,.15)}
.mi.playing{background:rgba(255,154,158,.25)}
.mi.playing .mname{color:#d6336c;font-weight:600}
.mi.loading{background:rgba(255,154,158,.2)}
.midx{width:24px;text-align:center;font-size:12px;color:#a87b8e;flex-shrink:0}
.mi.playing .midx{color:#d6336c}
.minfo{flex:1;min-width:0}
.mname{font-size:13px;color:#4a2c3a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mart{font-size:11px;color:#a87b8e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.mdur{font-size:11px;color:#a87b8e;flex-shrink:0}
.mfav{padding:4px;color:#d6336c;background:none;border:none;cursor:pointer;font-size:14px;flex-shrink:0}
.mfav.active{color:#ff1744}
.mempty,.mload{padding:40px 20px;text-align:center;color:#a87b8e;font-size:13px}
#ai-music-lyric{padding:8px 14px;background:#fff5f7;border-top:1px solid rgba(255,154,158,.15);font-size:12px;color:#a87b8e;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:20px;text-align:center}
#ai-music-lyric.hl{color:#d6336c;font-weight:500}
#ai-music-player{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#fff5f7;border-top:1px solid rgba(255,154,158,.2)}
.mp-btn{width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,154,158,.15);color:#d6336c;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.mp-btn:hover{background:rgba(255,154,158,.3)}
.mp-play{background:linear-gradient(135deg,var(--c1),var(--c2));color:#fff}
.mp-title{flex:1;font-size:12px;color:#4a2c3a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:6px}
#ai-lyric-modal{position:fixed;z-index:2147483647;left:0;top:0;right:0;bottom:0;background:rgba(74,44,58,.6);display:none;align-items:flex-end;justify-content:center}
#ai-lyric-modal.open{display:flex}
.lyric-box{width:min(92vw,400px);max-height:60vh;background:#fff0f5;border-radius:20px 20px 0 0;padding:20px;display:flex;flex-direction:column}
.lyric-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.lyric-head h3{margin:0;font-size:15px;color:#d6336c}
.lyric-close{background:none;border:none;font-size:20px;color:#a87b8e;cursor:pointer}
.lyric-content{flex:1;overflow-y:auto;font-size:14px;line-height:2;color:#a87b8e;text-align:center}
.lline{padding:4px 0}
.lline.active{color:#d6336c;font-weight:600;font-size:15px}
.backup-area{margin-top:15px;border-top:1px solid rgba(255,154,158,.2);padding-top:15px}
.backup-area textarea{font-family:monospace;font-size:11px;height:60px}
.vrow{display:flex;gap:8px}.vrow input{flex:1}.vrow button{width:auto;padding:0 12px;white-space:nowrap}
`;
  document.head.appendChild(style);

  // ==================== DOM ====================
  const fab = document.createElement('div'); fab.id = 'ai-fab';
  const fabImg = document.createElement('img'); fabImg.src = CONFIG.avatarUrl; fabImg.referrerPolicy = 'no-referrer';
  fabImg.onerror = function () { this.src = FALLBACK_AVATAR; };
  fab.appendChild(fabImg); document.body.appendChild(fab);

  const panel = document.createElement('div'); panel.id = 'ai-panel';
  panel.innerHTML = `
<div id="ai-head">
  <img id="ai-avatar" src="${esc(CONFIG.avatarUrl)}" referrerpolicy="no-referrer">
  <span id="ai-name">${esc(CONFIG.assistantName)}</span><span class="sp"></span>
  <button id="ai-music-btn" style="display:${CONFIG.musicEnabled?'inline-block':'none'};background:rgba(255,255,255,.4);font-weight:bold">音乐</button>
  <button id="ai-set-btn" style="background:rgba(255,255,255,.4);font-weight:bold">设置</button>
  <button id="ai-sum">总结记忆</button>
  <button id="ai-clr">清空</button>
  <button id="ai-close">×</button>
</div>
<div id="ai-actions">${QUICK_ACTIONS.map((a, i) => `<button class="ai-chip" data-idx="${i}">${a.label}</button>`).join('')}</div>
<div id="ai-body"></div>
<div id="ai-foot"><textarea id="ai-input" rows="1" placeholder="输入消息..."></textarea><button id="ai-send">发送</button></div>
<div id="ai-music">
  <div class="mtabs">
    <button class="mtab active" data-tab="search">搜索</button>
    <button class="mtab" data-tab="fav">收藏 (<span id="fav-cnt">0</span>)</button>
    <button id="music-back" class="music-back" type="button">返回对话</button>
  </div>
  <div class="msbar" id="ms-wrap">
    <input id="ms-input" type="text" placeholder="搜索歌曲、歌手...♪">
    <button id="ms-btn">搜索</button>
  </div>
  <div id="ai-music-list"><div class="mempty">输入关键词开始搜索♪</div></div>
  <div id="ai-music-lyric">— ♪ —</div>
  <div id="ai-music-player">
    <button class="mp-btn mp-prev">⏮</button><button class="mp-btn mp-play">▶</button><button class="mp-btn mp-next">⏭</button>
    <div class="mp-title">未播放</div>
  </div>
</div>
<div id="ai-settings">
  <div class="sg"><label>模型预设</label><select id="set-preset">${Object.keys(PRESETS).map(k => `<option value="${k}" ${CONFIG.apiBase === PRESETS[k].base ? 'selected' : ''}>${PRESETS[k].label}</option>`).join('')}</select></div>
  <div class="sg"><label>API 地址</label><input id="set-apibase" value="${esc(CONFIG.apiBase)}"></div>
  <div class="sg"><label>API Key</label><input id="set-apikey" type="password" value="${esc(CONFIG.apiKey)}"></div>
  <div class="sg"><label>模型</label><input id="set-model" value="${esc(CONFIG.model)}"></div>
  <div class="sg"><label>助手名</label><input id="set-name" value="${esc(CONFIG.assistantName)}"></div>
  <div class="sg"><label>头像 URL</label><input id="set-avatar" value="${esc(CONFIG.avatarUrl)}"></div>
  <div class="sg"><label>记忆轮数</label><input id="set-turns" type="number" value="${CONFIG.maxContextTurns}"></div>
  <div class="sg"><label>网页翻译引擎</label><select id="set-wte"><option value="free" ${CONFIG.webTransEngine === 'free' ? 'selected' : ''}>微软免费</option><option value="ai" ${CONFIG.webTransEngine === 'ai' ? 'selected' : ''}>AI（耗Token）</option></select></div>
  <div class="sg"><label>翻译模式</label><select id="set-wtm"><option value="bilingual" ${CONFIG.webTransMode === 'bilingual' ? 'selected' : ''}>双语</option><option value="translated" ${CONFIG.webTransMode === 'translated' ? 'selected' : ''}>仅译文</option></select></div>
  <div style="margin-top:15px;border-top:1px solid rgba(255,154,158,.3);padding-top:10px">
    <label style="font-size:13px;font-weight:bold;color:#d6336c">🔊 语音合成</label>
    <div class="sg" style="margin-top:8px"><label>开启朗读</label><select id="set-tts-en"><option value="true" ${CONFIG.ttsEnabled ? 'selected' : ''}>开启</option><option value="false" ${!CONFIG.ttsEnabled ? 'selected' : ''}>关闭</option></select></div>
    <div class="sg"><label>引擎</label><select id="set-tts-engine"><option value="browser" ${CONFIG.ttsEngine === 'browser' ? 'selected' : ''}>浏览器（免费）</option><option value="custom" ${CONFIG.ttsEngine === 'custom' ? 'selected' : ''}>外部 API</option></select></div>
    <div id="tts-cfg" style="display:${CONFIG.ttsEngine === 'custom' ? 'block' : 'none'}">
      <div class="sg"><label>TTS 地址</label><input id="set-tts-url" value="${esc(CONFIG.ttsBaseUrl)}"></div>
      <div class="sg"><label>TTS Key</label><input id="set-tts-key" type="password" value="${esc(CONFIG.ttsApiKey)}"></div>
      <div class="sg"><label>TTS 模型</label><input id="set-tts-model" value="${esc(CONFIG.ttsModel)}"></div>
      <div class="sg"><label>音色</label><div class="vrow"><input id="set-tts-voice" value="${esc(CONFIG.ttsVoice)}"><button id="btn-refresh-voice" class="btn-s">刷新</button></div></div>
    </div>
    <div class="sg"><label>语速 (<span id="tts-rate-l">${CONFIG.ttsRate}</span>x)</label><input type="range" id="set-tts-rate" min="0.5" max="2" step="0.1" value="${CONFIG.ttsRate}" style="padding:0"></div>
  </div>
  <div style="margin-top:15px;border-top:1px solid rgba(255,154,158,.3);padding-top:10px">
    <label style="font-size:13px;font-weight:bold;color:#d6336c">🎵 音乐功能</label>
    <div class="sg" style="margin-top:8px"><label>开启音乐</label><select id="set-music-en"><option value="true" ${CONFIG.musicEnabled ? 'selected' : ''}>开启</option><option value="false" ${!CONFIG.musicEnabled ? 'selected' : ''}>关闭</option></select></div>
    <div class="sg"><label>音质</label><select id="set-music-q"><option value="128" ${CONFIG.musicQuality === '128' ? 'selected' : ''}>128k</option><option value="192" ${CONFIG.musicQuality === '192' ? 'selected' : ''}>192k</option><option value="320" ${CONFIG.musicQuality === '320' ? 'selected' : ''}>320k</option></select></div>
    <div class="sg"><label>GD Studio API</label><input id="set-gd-api" value="${esc(CONFIG.gdStudioApi)}"></div>
    <div class="sg"><label>Meting 实例（每行一个）</label><textarea id="set-meting" style="min-height:90px;font-family:monospace;font-size:11px">${esc(CONFIG.metingInstances)}</textarea></div>
    <div class="sg"><label>网络加速（直连失败时走 CORS 代理，VIA 建议开启）</label><select id="set-music-proxy"><option value="false" ${!CONFIG.musicUseProxy ? 'selected' : ''}>关闭</option><option value="true" ${CONFIG.musicUseProxy ? 'selected' : ''}>开启</option></select></div>
  </div>
  <div class="sg" style="margin-top:10px"><label>主题色1</label><input id="set-c1" type="color" value="${CONFIG.themeColor1}"></div>
  <div class="sg"><label>主题色2</label><input id="set-c2" type="color" value="${CONFIG.themeColor2}"></div>
  <div class="sg"><label>系统提示词</label><textarea id="set-prompt">${esc(CONFIG.systemPrompt)}</textarea></div>
  <div class="acts"><button id="set-save" class="btn-p">保存配置</button><button id="set-back" class="btn-s">返回对话</button></div>
  <div class="backup-area">
    <label style="display:block;font-size:12px;font-weight:600;color:#4a2c3a;margin-bottom:4px">数据管理</label>
    <div class="acts"><button id="btn-export" class="btn-s">导出</button><button id="btn-import" class="btn-s">导入</button></div>
    <textarea id="backup-code" placeholder="粘贴备份代码或点击导出"></textarea>
  </div>
</div>`;
  document.body.appendChild(panel);

  // 独立的迷你音乐浮窗：不切换主面板，也不占用聊天区域
  const musicFloat = document.createElement('div'); musicFloat.id = 'ai-music-float';
  musicFloat.innerHTML = '<div class="music-float-info"><div class="music-float-name">未播放</div><div class="music-float-artist">—</div></div><button class="music-float-play" type="button" title="播放/暂停">▶</button>';
  document.body.appendChild(musicFloat);

  const lyricModal = document.createElement('div'); lyricModal.id = 'ai-lyric-modal';
  lyricModal.innerHTML = '<div class="lyric-box"><div class="lyric-head"><h3>♪ 歌词</h3><button class="lyric-close">×</button></div><div class="lyric-content"></div></div>';
  document.body.appendChild(lyricModal);

  const $ = (s) => panel.querySelector(s);
  const bodyEl = $('#ai-body'), inputEl = $('#ai-input'), sendBtn = $('#ai-send');
  const setPanel = $('#ai-settings'), footEl = $('#ai-foot'), actionsEl = $('#ai-actions');
  const musicView = $('#ai-music'), musicBtn = $('#ai-music-btn');
  const musicFloatName = musicFloat.querySelector('.music-float-name');
  const musicFloatArtist = musicFloat.querySelector('.music-float-artist');
  const musicFloatPlay = musicFloat.querySelector('.music-float-play');
  const ttsEngineSel = $('#set-tts-engine'), ttsCfg = $('#tts-cfg');
  const ttsRateIn = $('#set-tts-rate'), ttsRateL = $('#tts-rate-l');
  const ttsVoiceIn = $('#set-tts-voice');
  $('#ai-avatar').onerror = function () { this.src = FALLBACK_AVATAR; };

  ttsEngineSel.onchange = () => { ttsCfg.style.display = ttsEngineSel.value === 'custom' ? 'block' : 'none'; };
  ttsRateIn.oninput = () => { ttsRateL.textContent = ttsRateIn.value; };
  $('#btn-refresh-voice').onclick = async () => {
    const url = $('#set-tts-url').value.trim(), key = $('#set-tts-key').value.trim();
    if (!url || !key) return alert('请先填写地址和 Key');
    try {
      const r = await fetch(url.replace(/\/$/, '') + '/audio/voices', { headers: { 'Authorization': 'Bearer ' + key } });
      const d = await r.json();
      if (Array.isArray(d) && d.length) { ttsVoiceIn.value = typeof d[0] === 'string' ? d[0] : (d[0].id || d[0].voice_id); alert('已填入: ' + ttsVoiceIn.value); }
      else alert('格式不支持');
    } catch (e) { alert('失败: ' + errMsg(e)); }
  };
  $('#set-preset').onchange = (e) => {
    const p = PRESETS[e.target.value]; if (e.target.value === 'custom') return;
    $('#set-apibase').value = p.base; $('#set-model').value = p.model;
  };

  // 拖拽
  let drag = false, moved = false, sx, sy, ox, oy;
  const onDS = (x, y) => { const r = fab.getBoundingClientRect(); drag = true; moved = false; sx = x; sy = y; ox = x - r.left; oy = y - r.top; };
  const onDM = (x, y) => { if (Math.abs(x - sx) > 5 || Math.abs(y - sy) > 5) moved = true; fab.style.left = Math.max(8, Math.min(innerWidth - 64, x - ox)) + 'px'; fab.style.top = Math.max(8, Math.min(innerHeight - 64, y - oy)) + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto'; };
  const onDE = () => { if (drag && !moved) togglePanel(); drag = false; };
  fab.addEventListener('touchstart', e => { const t = e.touches[0]; onDS(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (drag) { const t = e.touches[0]; onDM(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  document.addEventListener('touchend', onDE);
  fab.addEventListener('mousedown', e => { if (e.button !== 0) return; onDS(e.clientX, e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (drag) onDM(e.clientX, e.clientY); });
  document.addEventListener('mouseup', onDE);

  const headEl = $('#ai-head');
  let pdrag = false;
  const onPS = (x, y) => { const r = panel.getBoundingClientRect(); pdrag = true; sx = x; sy = y; ox = x - r.left; oy = y - r.top; };
  const onPM = (x, y) => { if (!pdrag) return; panel.style.left = Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, x - ox)) + 'px'; panel.style.top = Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, y - oy)) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; };
  headEl.addEventListener('touchstart', e => { if (e.target.closest('button')) return; const t = e.touches[0]; onPS(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (pdrag) { const t = e.touches[0]; onPM(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  document.addEventListener('touchend', () => { pdrag = false; });
  headEl.addEventListener('mousedown', e => { if (e.button !== 0 || e.target.closest('button')) return; onPS(e.clientX, e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (pdrag) onPM(e.clientX, e.clientY); });
  document.addEventListener('mouseup', () => { pdrag = false; });

  function showView(v) {
    bodyEl.style.display = footEl.style.display = actionsEl.style.display = 'none';
    setPanel.classList.remove('open'); musicView.classList.remove('open');
    if (v === 'chat') { bodyEl.style.display = footEl.style.display = actionsEl.style.display = 'flex'; }
    else if (v === 'settings') setPanel.classList.add('open');
    else if (v === 'music') musicView.classList.add('open');
  }
  function togglePanel() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      setTimeout(() => inputEl.focus(), 150);
      if (setPanel.classList.contains('open') || musicView.classList.contains('open')) showView('chat');
    }
  }
  $('#ai-close').onclick = togglePanel;
  $('#ai-set-btn').onclick = () => showView('settings');
  musicBtn.onclick = () => showView('music');
  $('#music-back').onclick = () => showView('chat');
  $('#set-back').onclick = () => showView('chat');

  // 保存设置
  $('#set-save').onclick = () => {
    Object.assign(CONFIG, {
      apiBase: $('#set-apibase').value.trim(), apiKey: $('#set-apikey').value.trim(),
      model: $('#set-model').value.trim(), assistantName: $('#set-name').value.trim(),
      avatarUrl: $('#set-avatar').value.trim(),
      maxContextTurns: parseInt($('#set-turns').value) || 10,
      webTransEngine: $('#set-wte').value, webTransMode: $('#set-wtm').value,
      themeColor1: $('#set-c1').value, themeColor2: $('#set-c2').value,
      systemPrompt: $('#set-prompt').value.trim(),
      ttsEnabled: $('#set-tts-en').value === 'true', ttsEngine: ttsEngineSel.value,
      ttsBaseUrl: $('#set-tts-url').value.trim(), ttsApiKey: $('#set-tts-key').value.trim(),
      ttsModel: $('#set-tts-model').value.trim(), ttsVoice: ttsVoiceIn.value.trim(),
      ttsRate: parseFloat(ttsRateIn.value) || 1,
      musicEnabled: $('#set-music-en').value === 'true', musicQuality: $('#set-music-q').value,
      gdStudioApi: $('#set-gd-api').value.trim() || DC.gdStudioApi,
      metingInstances: $('#set-meting').value.trim() || DC.metingInstances,
      musicUseProxy: $('#set-music-proxy').value === 'true',
    });
    musicBtn.style.display = CONFIG.musicEnabled ? 'inline-block' : 'none';
    if (!CONFIG.musicEnabled && M.audio) { M.audio.pause(); musicFloat.classList.remove('show'); }
    sSet('via_ai_config', CONFIG);
    const mem = history.find(m => m.role === 'system' && m.isMemory);
    history = mem ? [{ role: 'system', content: CONFIG.systemPrompt }, mem] : [{ role: 'system', content: CONFIG.systemPrompt }, ...history.filter(m => m.role !== 'system')];
    sSet('via_ai_history', history);
    document.documentElement.style.setProperty('--c1', CONFIG.themeColor1);
    document.documentElement.style.setProperty('--c2', CONFIG.themeColor2);
    $('#ai-name').textContent = CONFIG.assistantName;
    $('#ai-avatar').src = fabImg.src = CONFIG.avatarUrl;
    alert('已保存！'); renderHistory();
  };
  $('#btn-export').onclick = () => {
    const c = Object.assign({}, CONFIG); delete c.apiKey; delete c.ttsApiKey;
    $('#backup-code').value = b64e(JSON.stringify({ config: c, history, transCache, favorites }));
    alert('已导出（不含 Key）');
  };
  $('#btn-import').onclick = () => {
    const b = $('#backup-code').value.trim(); if (!b) return alert('请粘贴代码');
    try {
      const d = JSON.parse(b64d(b));
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('备份格式错误');
      if (d.config !== undefined && (!d.config || typeof d.config !== 'object' || Array.isArray(d.config))) throw new Error('配置格式错误');
      if (d.history !== undefined && (!Array.isArray(d.history) || d.history.some(m => !m || typeof m.role !== 'string' || typeof m.content !== 'string'))) throw new Error('历史记录格式错误');
      if (d.transCache !== undefined && (!d.transCache || typeof d.transCache !== 'object' || Array.isArray(d.transCache))) throw new Error('翻译缓存格式错误');
      if (d.favorites !== undefined && (!Array.isArray(d.favorites) || d.favorites.some(s => !s || typeof s !== 'object'))) throw new Error('收藏格式错误');
      if (d.config) { CONFIG = Object.assign(CONFIG, d.config); sSet('via_ai_config', CONFIG); }
      if (d.history) { history = d.history; sSet('via_ai_history', history); }
      if (d.transCache) { transCache = d.transCache; sSet('via_ai_trans', transCache); }
      if (d.favorites) { favorites = d.favorites; sSet('via_ai_favs', favorites); }
      alert('导入成功！'); location.reload();
    } catch (e) { alert('导入失败：' + errMsg(e)); }
  };

  // ==================== 音乐 ====================
  const M = { audio: null, playlist: [], currentIndex: -1, isPlaying: false, loadingIndex: -1, requestId: 0, lastError: '', pendingPlay: false, lyrics: [], lyricIndex: -1, currentTab: 'search' };

  const gdBase = () => (CONFIG.gdStudioApi || DC.gdStudioApi).replace(/\/$/, '');
  const metingList = () => (CONFIG.metingInstances || DC.metingInstances).split('\n').map(s => s.trim()).filter(Boolean);

  function findArr(o, d = 0) {
    if (d > 4 || !o || typeof o !== 'object') return null;
    if (Array.isArray(o) && o.length && typeof o[0] === 'object' && (o[0].name || o[0].song || o[0].title || o[0].songname)) return o;
    for (const k of ['songs', 'data', 'result', 'list', 'items', 'tracks', 'song_list']) if (o[k]) { const f = findArr(o[k], d + 1); if (f) return f; }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') { const f = findArr(o[k], d + 1); if (f) return f; }
    return null;
  }
  function textValue(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
    if (Array.isArray(v)) return v.map(textValue).filter(Boolean).join(' / ');
    if (typeof v === 'object') return textValue(v.name || v.title || v.text || v.value || v.id);
    return '';
  }
  function norm(raw, src) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const name = textValue(raw.name || raw.song || raw.title || raw.songname || raw.songName) || '未知歌曲';
    const art = textValue(raw.artist || raw.artists || raw.singer || raw.singers || raw.author || raw.creator ||
      raw.artistname || raw.artistName || raw.artist_name || raw.singername || raw.singerName || raw.singer_name) || '未知歌手';
    const id = textValue(raw.id || raw.url_id || raw.song_id || raw.songId || raw.songmid || raw.mid || raw.track_id || raw.hash);
    let duration = Number(raw.duration || raw.interval || raw.length || raw.time || 0) || 0;
    // 部分 Meting/QQ 接口返回秒，统一成毫秒供界面显示。
    if (duration > 0 && duration < 1000) duration *= 1000;
    return { id, name, artist: art, duration, album: textValue(raw.album || raw.albumname || raw.albumName), source: src };
  }
  function lyricPayload(value, depth = 0) {
    if (depth > 4 || value == null) return { lyric: '', tlyric: '' };
    if (typeof value === 'string') {
      const s = value.trim();
      if (!s) return { lyric: '', tlyric: '' };
      if ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']')) {
        try { return lyricPayload(JSON.parse(s), depth + 1); } catch (e) {}
      }
      return { lyric: s, tlyric: '' };
    }
    if (Array.isArray(value)) {
      for (const item of value) { const r = lyricPayload(item, depth + 1); if (r.lyric) return r; }
      return { lyric: '', tlyric: '' };
    }
    if (typeof value === 'object') {
      const lyric = value.lyric || value.lrc || value.lyrics || value.content || value.text;
      const tlyric = value.tlyric || value.tLrc || value.translatedLyric || value.translation || '';
      if (lyric) return { lyric: typeof lyric === 'string' ? lyric : lyricPayload(lyric, depth + 1).lyric, tlyric: textValue(tlyric) };
      for (const key of ['data', 'result', 'body', 'info']) if (value[key]) {
        const r = lyricPayload(value[key], depth + 1); if (r.lyric) return r;
      }
    }
    return { lyric: '', tlyric: '' };
  }
  function parseLrc(t) {
    if (!t || typeof t !== 'string') return [];
    const out = [], re = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]([^\n\r]*)/g; let m;
    while ((m = re.exec(t))) {
      const fraction = m[3] ? Number(`0.${m[3]}`) : 0;
      const s = m[4].trim();
      if (s && !/^\[(?:ar|ti|al|by|offset):/i.test(s)) out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fraction, text: s });
    }
    if (out.length) return out.sort((a, b) => a.t - b.t);
    // 有些接口返回无时间轴的纯文本歌词，也应该在歌词窗口中显示。
    return t.split(/\r?\n/).map(s => s.replace(/^\s+|\s+$/g, '')).filter(Boolean).map((text, i) => ({ t: i * 3, text }));
  }

  const gdSrc = {
    id: 'gd', name: 'GD Studio',
    async search(kw) {
      const t = await smartReq(`${gdBase()}?types=search&source=netease&name=${encodeURIComponent(kw)}&count=25&pages=1`);
      const arr = findArr(JSON.parse(t)); if (!arr) throw new Error('无数组');
      return arr.map(s => norm(s, this.id)).filter(s => s.id);
    },
    async getUrl(song) {
      const t = await smartReq(`${gdBase()}?types=url&source=netease&id=${encodeURIComponent(song.id)}&br=${CONFIG.musicQuality}`);
      if (t && t.startsWith('http')) return t;
      throw new Error('无地址');
    },
    async getLyric(song) {
      const t = await smartReq(`${gdBase()}?types=lyric&source=netease&id=${encodeURIComponent(song.id)}&lrctype=1`);
      const r = lyricPayload(t); if (r.lyric) return r;
      throw new Error('无歌词');
    }
  };
  const metingSrc = {
    id: 'meting', name: 'Meting',
    async search(kw) {
      return pAny(metingList().map(base => smartReq(`${base.replace(/\/$/, '')}/?type=search&id=${encodeURIComponent(kw)}`).then(t => {
        const a = findArr(JSON.parse(t)); if (!a) throw new Error('无数组');
        const l = a.map(s => norm(s, 'meting')).filter(s => s.id); if (!l.length) throw new Error('空'); return l;
      })));
    },
    async getUrl(song) {
      return pAny(metingList().map(base => smartReq(`${base.replace(/\/$/, '')}/?type=url&id=${encodeURIComponent(song.id)}&br=${CONFIG.musicQuality}`).then(t => {
        if (t && t.startsWith('http')) return t; if (t && t.startsWith('@')) return t.slice(1); throw new Error('无效');
      })));
    },
    async getLyric(song) {
      return pAny(metingList().map(base => smartReq(`${base.replace(/\/$/, '')}/?type=lyric&id=${encodeURIComponent(song.id)}`).then(t => {
        const r = lyricPayload(t);
        if (r.lyric) return r;
        throw new Error('无歌词');
      })));
    }
  };
  const SOURCES = [gdSrc, metingSrc];

  async function mSearch(kw) {
    const tasks = SOURCES.map(s => s.search(kw).then(r => { if (!r.length) throw new Error('空'); return { s, r }; }));
    const hit = await pAny(tasks);
    console.log('[Music] 命中', hit.s.name, hit.r.length);
    M.playlist = hit.r; return hit.r;
  }
  async function mGetUrl(song) {
    try { return await pAny(SOURCES.map(s => s.getUrl(song).then(u => { if (!u) throw new Error('空'); return u; }))); }
    catch (e) { if (song.id) return `https://music.163.com/song/media/outer/url?id=${song.id}.mp3`; throw new Error('无法获取地址'); }
  }
  async function mGetLyric(song) {
    try { return await pAny(SOURCES.filter(s => s.getLyric).map(s => s.getLyric(song).then(r => { if (!r || !r.lyric) throw new Error('无'); return r; }))); }
    catch (e) { return { lyric: '', tlyric: '' }; }
  }

  const isFav = (s) => favorites.some(f => f.id === s.id && f.source === s.source);
  function toggleFav(song) {
    const i = favorites.findIndex(f => f.id === song.id && f.source === song.source);
    if (i >= 0) favorites.splice(i, 1); else favorites.unshift(song);
    sSet('via_ai_favs', favorites); $('#fav-cnt').textContent = favorites.length;
    if (M.currentTab === 'fav') { M.playlist = favorites.slice(); renderList(favorites); }
    else updateFavBtns();
  }
  function updateFavBtns() {
    panel.querySelectorAll('.mi').forEach((el, i) => {
      const btn = el.querySelector('.mfav'); if (!btn) return;
      const s = M.currentTab === 'fav' ? favorites[i] : M.playlist[i];
      if (s) btn.classList.toggle('active', isFav(s));
    });
  }
  $('#fav-cnt').textContent = favorites.length;

  function getAudio() {
    if (!M.audio) {
      const a = new Audio(); a.preload = 'auto';
      a.onended = () => { M.isPlaying = false; if (M.currentIndex < M.playlist.length - 1) playAt(M.currentIndex + 1); else updateBar(); };
      a.onplay = () => { M.isPlaying = true; M.pendingPlay = false; M.lastError = ''; updateBar(); updateHL(); };
      a.onpause = () => { M.isPlaying = false; updateBar(); };
      a.ontimeupdate = onLyricTime;
      a.onerror = () => { M.isPlaying = false; if (M.audio.src) M.lastError = '音频加载失败'; updateBar(); };
      M.audio = a;
    }
    return M.audio;
  }
  async function playAt(i) {
    const song = M.playlist[i]; if (!song) return;
    const rid = ++M.requestId;
    M.currentIndex = i; M.isPlaying = false; M.lastError = ''; M.pendingPlay = false; M.loadingIndex = i;
    M.lyrics = []; M.lyricIndex = -1; setLyric(''); updateLyricModal();
    const a = getAudio(); try { a.pause(); } catch (e) {} a.removeAttribute('src'); try { a.load(); } catch (e) {}
    updateLoading(i); updateHL(); updateBar();
    const [urlR, lyrR] = await Promise.allSettled([mGetUrl(song), mGetLyric(song)]);
    if (rid !== M.requestId) return;
    if (lyrR.status === 'fulfilled' && lyrR.value && lyrR.value.lyric) { M.lyrics = parseLrc(lyrR.value.lyric); updateLyricModal(); }
    if (urlR.status === 'rejected') { M.lastError = errMsg(urlR.reason); M.loadingIndex = -1; updateLoading(-1); updateBar(); return; }
    a.src = urlR.value; M.loadingIndex = -1; updateLoading(-1); updateBar();
    try { await a.play(); }
    catch (e) {
      if (rid !== M.requestId) return;
      if (e.name === 'NotAllowedError' || String(e).includes('user gesture')) { M.pendingPlay = true; updateBar(); }
      else { M.lastError = errMsg(e); updateBar(); }
    }
  }
  function togglePlay() {
    const a = getAudio(); M.lastError = '';
    if (!a.src) { if (M.playlist.length) playAt(M.currentIndex >= 0 ? M.currentIndex : 0); return; }
    if (a.paused) { M.pendingPlay = false; a.play().catch(e => { M.lastError = errMsg(e); updateBar(); }); }
    else a.pause();
  }
  const prev = () => { if (M.currentIndex > 0) playAt(M.currentIndex - 1); };
  const next = () => { if (M.currentIndex < M.playlist.length - 1) playAt(M.currentIndex + 1); };

  function updateHL() {
    const l = $('#ai-music-list'); if (!l) return;
    l.querySelectorAll('.mi').forEach((el, i) => el.classList.toggle('playing', i === M.currentIndex && M.currentTab === 'search'));
  }
  function updateLoading(i) {
    const l = $('#ai-music-list'); if (!l) return;
    l.querySelectorAll('.mi').forEach((el, k) => el.classList.toggle('loading', k === i && M.currentTab === 'search'));
  }
  function updateFloat() {
    const s = M.playlist[M.currentIndex];
    if (!CONFIG.musicEnabled || !s) { musicFloat.classList.remove('show'); return; }
    musicFloat.classList.add('show');
    musicFloatName.textContent = s.name || '未知歌曲';
    musicFloatArtist.textContent = s.artist || '未知歌手';
    musicFloatPlay.textContent = M.loadingIndex >= 0 ? '⏳' : (M.isPlaying ? '⏸' : '▶');
    musicFloatPlay.disabled = M.loadingIndex >= 0;
    musicFloatPlay.title = M.isPlaying ? '暂停' : '播放';
  }
  function updateBar() {
    updateFloat();
    const bar = $('#ai-music-player'); if (!bar) return;
    const s = M.playlist[M.currentIndex], title = bar.querySelector('.mp-title'), btn = bar.querySelector('.mp-play');
    if (M.loadingIndex >= 0) { title.textContent = '⏳ 加载中...'; btn.textContent = '⏳'; return; }
    if (M.lastError) { title.textContent = '❌ ' + M.lastError; btn.textContent = '▶'; return; }
    if (M.pendingPlay) { title.textContent = '▶ 点播放: ' + (s ? `${s.name} - ${s.artist}` : ''); btn.textContent = '▶'; return; }
    title.textContent = s ? `${s.name} - ${s.artist}` : '未播放';
    btn.textContent = M.isPlaying ? '⏸' : '▶';
  }
  function setLyric(t) {
    const el = $('#ai-music-lyric'); if (!el) return;
    if (t) { el.textContent = t; el.classList.add('hl'); }
    else if (M.currentIndex >= 0 && M.playlist[M.currentIndex]) { el.textContent = '♪ ' + M.playlist[M.currentIndex].name + ' ♪'; el.classList.remove('hl'); }
    else { el.textContent = '— ♪ —'; el.classList.remove('hl'); }
  }
  function onLyricTime() {
    if (!M.audio || !M.lyrics.length) return;
    const t = M.audio.currentTime; let idx = -1;
    for (let i = 0; i < M.lyrics.length; i++) { if (M.lyrics[i].t <= t) idx = i; else break; }
    if (idx !== M.lyricIndex) { M.lyricIndex = idx; setLyric(idx >= 0 ? M.lyrics[idx].text : ''); updateLyricModal(); }
  }
  function updateLyricModal() {
    const box = lyricModal.querySelector('.lyric-content'); if (!box) return;
    if (!M.lyrics.length) { box.innerHTML = '<div class="lline" style="opacity:.5">暂无歌词~</div>'; return; }
    box.innerHTML = M.lyrics.map((l, i) => `<div class="lline ${i === M.lyricIndex ? 'active' : ''}" data-i="${i}">${esc(l.text)}</div>`).join('');
    const act = box.querySelector('.active'); if (act) act.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.querySelectorAll('.lline').forEach(el => el.onclick = () => { const i = +el.dataset.i; if (M.audio && M.lyrics[i]) M.audio.currentTime = M.lyrics[i].t; });
  }
  const fmtDur = (ms) => { if (!ms) return '--:--'; const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function renderList(items) {
    const l = $('#ai-music-list');
    if (!items.length) { l.innerHTML = `<div class="mempty">${M.currentTab === 'fav' ? '还没有收藏的歌~' : '没找到相关歌曲~'}</div>`; return; }
    l.innerHTML = '';
    items.forEach((song, i) => {
      const d = document.createElement('div'); d.className = 'mi';
      const fav = isFav(song);
      d.innerHTML = `<div class="midx">${i + 1}</div><div class="minfo"><div class="mname">${esc(song.name)}</div><div class="mart">${esc(song.artist)}</div></div><div class="mdur">${fmtDur(song.duration)}</div><button class="mfav ${fav ? 'active' : ''}">${fav ? '★' : '☆'}</button>`;
      d.onclick = (e) => { if (e.target.classList.contains('mfav')) return; playAt(i); };
      d.querySelector('.mfav').onclick = (e) => { e.stopPropagation(); toggleFav(song); };
      l.appendChild(d);
    });
    updateHL(); updateLoading(M.loadingIndex);
  }

  panel.querySelectorAll('.mtab').forEach(tab => tab.onclick = () => {
    panel.querySelectorAll('.mtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    M.currentTab = tab.dataset.tab;
    if (M.currentTab === 'fav') { $('#ms-wrap').style.display = 'none'; M.playlist = favorites.slice(); renderList(favorites); }
    else { $('#ms-wrap').style.display = 'flex'; renderList(M.playlist); }
  });
  $('#ai-music-lyric').onclick = () => { updateLyricModal(); lyricModal.classList.add('open'); };
  lyricModal.onclick = (e) => { if (e.target === lyricModal || e.target.classList.contains('lyric-close')) lyricModal.classList.remove('open'); };

  const doSearch = async () => {
    const kw = $('#ms-input').value.trim(); if (!kw) return;
    $('#ai-music-list').innerHTML = '<div class="mload">搜索中♪...</div>';
    try { renderList(await mSearch(kw)); }
    catch (e) { $('#ai-music-list').innerHTML = `<div class="mempty">搜索失败：${esc(errMsg(e))}</div>`; }
  };
  $('#ms-btn').onclick = doSearch;
  $('#ms-input').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  panel.querySelector('.mp-play').onclick = togglePlay;
  panel.querySelector('.mp-prev').onclick = prev;
  panel.querySelector('.mp-next').onclick = next;
  musicFloatPlay.onclick = togglePlay;

  // ==================== AI 工具 ====================
  function buildTools() {
    return [
      { type: 'function', function: { name: 'search_and_play_music', description: '搜索并播放音乐。用户想听歌/找歌时调用。', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索词，如"周杰伦 稻香"' }, action: { type: 'string', enum: ['play', 'search'], description: 'play 立即播放第一首；search 只展示列表' } }, required: ['keyword'] } } },
      { type: 'function', function: { name: 'music_control', description: '控制音乐播放。', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['pause', 'resume', 'next', 'prev', 'stop', 'favorite'], description: '命令' } }, required: ['command'] } } }
    ];
  }
  async function execTool(name, args) {
    if (!CONFIG.musicEnabled) return { success: false, error: '音乐功能未开启，请让用户去设置开启。' };
    if (name === 'search_and_play_music') {
      if (!args.keyword) return { success: false, error: '缺少关键词' };
      try {
        const r = await mSearch(args.keyword); if (!r.length) return { success: false, error: '没找到歌曲' };
        M.currentTab = 'search';
        panel.querySelectorAll('.mtab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'search'));
        $('#ms-wrap').style.display = 'flex';
        renderList(r);
        if (args.action === 'search') { showView('music'); return { success: true, action: 'searched', count: r.length, songs: r.slice(0, 8).map((s, i) => `${i + 1}. ${s.name} - ${s.artist}`) }; }
        // AI 放歌优先使用独立迷你浮窗，不把用户从聊天界面切走。
        await playAt(0); showView('chat');
        return { success: true, action: 'playing', song: `${r[0].name} - ${r[0].artist}` };
      } catch (e) { return { success: false, error: errMsg(e) }; }
    }
    if (name === 'music_control') {
      const a = M.audio;
      try {
        switch (args.command) {
          case 'pause': a && a.pause(); return { success: true };
          case 'resume': a && a.play(); return { success: true };
          case 'next': next(); return { success: true };
          case 'prev': prev(); return { success: true };
          case 'stop': a && a.pause(); if (a) a.src = ''; return { success: true };
          case 'favorite': { const s = M.playlist[M.currentIndex]; if (!s) return { success: false, error: '没有播放歌曲' }; toggleFav(s); return { success: true, action: isFav(s) ? 'favorited' : 'unfavorited', song: s.name }; }
          default: return { success: false, error: '未知命令' };
        }
      } catch (e) { return { success: false, error: errMsg(e) }; }
    }
    return { success: false, error: '未知工具' };
  }

  // ==================== 对话 ====================
  let sending = false;
  function renderHistory() {
    bodyEl.innerHTML = '';
    history.forEach(msg => {
      if (msg.role === 'system') {
        if (msg.isMemory) {
          const d = document.createElement('div'); d.className = 'ai-msg mem';
          d.innerHTML = `<strong>【长期记忆已加载】</strong><br><span style="font-size:11px;opacity:.8">${esc(msg.content.replace('【长期记忆总结】：', ''))}</span>`;
          bodyEl.appendChild(d);
        }
        return;
      }
      const d = document.createElement('div'); d.className = 'ai-msg ' + (msg.role === 'user' ? 'user' : 'ai');
      d.textContent = msg.content;
      if (msg.role === 'assistant' && CONFIG.ttsEnabled) {
        const b = document.createElement('div'); b.className = 'tts-btn'; b.innerHTML = '🔊 朗读';
        b.onclick = (e) => { e.stopPropagation(); toggleTTS(msg.content, b); };
        d.appendChild(document.createElement('br')); d.appendChild(b);
      }
      bodyEl.appendChild(d);
    });
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  renderHistory();

  function chatReq(messages, skipParse = false) {
    if (!CONFIG.apiKey) throw new Error('未填写 API Key');
    const proc = messages.map(m => (m.role === 'system' && !skipParse) ? { role: 'system', content: parseVars(m.content) } : m);
    const body = JSON.stringify({ model: CONFIG.model, messages: proc, stream: false });
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey };
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST', url: CONFIG.apiBase + '/chat/completions', headers, data: body, timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) { try { res(JSON.parse(r.responseText).choices[0].message.content); } catch (e) { rej(e); } }
          else rej(new Error('HTTP ' + r.status + ': ' + r.responseText.slice(0, 100)));
        },
        onerror: () => rej(new Error('网络失败')), ontimeout: () => rej(new Error('超时'))
      });
    });
  }
  async function chatReqTools(messages) {
    if (!CONFIG.apiKey) throw new Error('未填写 API Key');
    const proc = messages.map(m => m.role === 'system' ? { role: 'system', content: parseVars(m.content) } : m);
    const tools = buildTools(), MAX = 5;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey };
    for (let r = 0; r < MAX; r++) {
      const body = JSON.stringify({ model: CONFIG.model, messages: proc, stream: false, tools, tool_choice: 'auto' });
      let msg = null, fallback = false;
      try {
        msg = await new Promise((res, rej) => {
          GM_xmlhttpRequest({
            method: 'POST', url: CONFIG.apiBase + '/chat/completions', headers, data: body, timeout: 45000,
            onload: (r) => {
              if (r.status >= 200 && r.status < 300) { try { res(JSON.parse(r.responseText).choices[0].message); } catch (e) { rej(e); } }
              else if (r.status === 400 && (r.responseText.includes('tool') || r.responseText.includes('function'))) res(null);
              else rej(new Error('HTTP ' + r.status));
            },
            onerror: () => rej(new Error('网络失败')), ontimeout: () => rej(new Error('超时'))
          });
        });
      } catch (e) { fallback = true; }
      if (fallback || msg === null) return await chatReq(messages);
      if (!msg.tool_calls || !msg.tool_calls.length) return msg.content || '';
      proc.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const c of msg.tool_calls) {
        let result;
        try { result = await execTool(c.function.name, JSON.parse(c.function.arguments || '{}')); }
        catch (e) { result = { success: false, error: errMsg(e) }; }
        proc.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
    return '（工具调用过多）';
  }
  const chatSmart = (m) => CONFIG.musicEnabled ? chatReqTools(m) : chatReq(m);

  function addMsg(role, text) {
    const d = document.createElement('div'); d.className = 'ai-msg ' + (role === 'user' ? 'user' : 'ai'); d.textContent = text;
    if (role === 'assistant' && CONFIG.ttsEnabled) {
      const b = document.createElement('div'); b.className = 'tts-btn'; b.innerHTML = '🔊 朗读';
      b.onclick = (e) => { e.stopPropagation(); toggleTTS(text, b); };
      d.appendChild(document.createElement('br')); d.appendChild(b);
    }
    bodyEl.appendChild(d); bodyEl.scrollTop = bodyEl.scrollHeight; return d;
  }
  async function send() {
    const t = inputEl.value.trim(); if (!t || sending) return;
    sending = true; sendBtn.disabled = true; inputEl.value = '';
    addMsg('user', t); history.push({ role: 'user', content: t }); saveHistory();
    const ld = addMsg('ai', '...');
    try { const r = await chatSmart(history); ld.remove(); addMsg('ai', r); history.push({ role: 'assistant', content: r }); saveHistory(); }
    catch (e) { ld.remove(); addMsg('ai', '错误：' + errMsg(e)); }
    sending = false; sendBtn.disabled = false;
  }
  sendBtn.onclick = send;
  inputEl.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  panel.querySelectorAll('.ai-chip').forEach(btn => btn.onclick = async () => {
    const a = QUICK_ACTIONS[+btn.dataset.idx];
    if (a.prompt === 'translate_page') {
      if (pageTranslated) restorePage();
      else { panel.classList.remove('open'); translatePage().catch(e => alert('翻译失败: ' + errMsg(e))); }
      return;
    }
    if (sending) return; sending = true; sendBtn.disabled = true;
    addMsg('user', a.label); const ld = addMsg('ai', '...');
    try { const r = await chatSmart([{ role: 'user', content: a.prompt + '\n\n【网页】\n' + getPageContent() }]); ld.remove(); addMsg('ai', r); }
    catch (e) { ld.remove(); addMsg('ai', '错误：' + errMsg(e)); }
    sending = false; sendBtn.disabled = false;
  });

  $('#ai-sum').onclick = async () => {
    const non = history.filter(m => m.role !== 'system');
    if (non.length < 4) return alert('对话太短');
    if (!confirm('总结为长期记忆，并清空对话？')) return;
    sending = true; const ld = addMsg('ai', '正在提取记忆...');
    try {
      const om = history.find(m => m.role === 'system' && m.isMemory);
      let p = CONFIG.summaryPrompt;
      if (om) p += '\n\n【已有记忆】\n' + om.content.replace('【长期记忆总结】：', '');
      p += '\n\n【对话】\n' + non.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');
      const s = await chatReq([{ role: 'user', content: p }], true);
      ld.remove();
      history = [{ role: 'system', content: CONFIG.systemPrompt }, { role: 'system', content: '【长期记忆总结】：' + s, isMemory: true }];
      sSet('via_ai_history', history); bodyEl.innerHTML = ''; renderHistory();
    } catch (e) { ld.remove(); addMsg('ai', '失败：' + errMsg(e)); }
    sending = false;
  };
  $('#ai-clr').onclick = () => {
    if (confirm('清空所有对话和记忆？')) {
      history = [{ role: 'system', content: CONFIG.systemPrompt }]; sSet('via_ai_history', history);
      bodyEl.innerHTML = ''; renderHistory();
    }
  };

  console.log('[爱莉希雅助手] 已加载 v4.2 | VIA 兼容模式');
})();