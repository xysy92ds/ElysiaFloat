/* ==========================================================
 *  联网阅读（0.12.1）
 *
 *  两个面向 AI 的只读工具：
 *   - fetch_url：抓取用户给的网址，去掉脚本/样式后返回标题与正文
 *   - web_search：按关键词搜索网页，返回标题、链接、摘要
 *
 *  安全边界：
 *   - 只允许 http/https 公网地址，拒绝本机、内网、链路本地地址
 *   - 不执行网页脚本，不加载网页里的任何代码
 *   - 响应有大小与字数上限，超时即失败
 * ========================================================== */
const WEB_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 ElysiaFloat/0.12';
const WEB_FETCH_MAX_BYTES = 1500000;
const WEB_SEARCH_MAX_BYTES = 900000;
const WEB_TEXT_MAX = 20000;

/** 是否为内网 / 本机 / 链路本地地址 */
function webHostPrivate(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.indexOf(':') >= 0) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return webHostPrivate(mapped[1]);
    return false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;   // 域名交给 DNS，不在本地判断
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (p.some(n => n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] >= 224) return true;
  return false;
}

/** 校验网址：返回 { ok, url, error } */
function webUrlCheck(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: '缺少网址' };
  let u;
  try { u = new URL(text); } catch (e) { return { ok: false, error: '网址格式不正确' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只支持 http / https 地址' };
  if (u.username || u.password) return { ok: false, error: '网址里不能带账号密码' };
  if (!u.hostname) return { ok: false, error: '网址缺少主机名' };
  if (webHostPrivate(u.hostname)) return { ok: false, error: '不能访问本机或内网地址' };
  return { ok: true, url: u.href };
}

function decodeWebEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·' };
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (all, g) {
    if (g.charAt(0) === '#') {
      const n = g.charAt(1).toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return n > 0 && n < 1114112 ? String.fromCodePoint(n) : all;
    }
    const v = map[g.toLowerCase()];
    return v === undefined ? all : v;
  });
}

/** HTML → 纯文本：去掉脚本、样式、注释和标签，压缩空白 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeWebEntities(s);
  s = s.replace(/\r/g, '\n').replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ ]+/g, '\n').replace(/[ ]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function htmlTitleOf(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

/** fetch_url：抓网页正文 */
async function webFetchTool(args) {
  const checked = webUrlCheck(args && args.url);
  if (!checked.ok) return { success: false, errorCode: 'INVALID_URL', error: checked.error };
  const maxChars = Math.max(500, Math.min(20000, parseInt(args && args.max_chars, 10) || 8000));
  let r;
  try {
    r = await reqRequest({
      url: checked.url,
      method: 'GET',
      headers: {
        'User-Agent': WEB_UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
      },
      timeoutMs: 20000,
      retries: 0,
      maxRedirect: 3,
      maxBytes: WEB_FETCH_MAX_BYTES,
      expect: 'text',
      source: 'web:fetch'
    });
  } catch (e) {
    return { success: false, errorCode: (e && e.code) || 'FETCH_FAILED', error: '抓取失败：' + errMsg(e) };
  }
  const finalCheck = webUrlCheck(r.url || checked.url);
  if (!finalCheck.ok) return { success: false, errorCode: 'REDIRECT_BLOCKED', error: '页面跳转到了不允许的地址' };
  const ct = String(r.contentType || '').toLowerCase();
  const looksHtml = /html|xml/.test(ct) || /^\s*</.test(String(r.text || ''));
  if (ct && !looksHtml && !/text\/|json|plain/.test(ct)) {
    return { success: false, errorCode: 'UNSUPPORTED_CONTENT', error: '这个地址返回的是 ' + ct + '，不是可读的网页正文' };
  }
  const raw = String(r.text || '');
  if (!raw.trim()) return { success: false, errorCode: 'EMPTY_PAGE', error: '页面没有可读内容' };
  const title = looksHtml ? htmlTitleOf(raw) : '';
  const full = looksHtml ? htmlToText(raw) : raw;
  const text = full.slice(0, maxChars);
  return {
    success: true,
    url: finalCheck.url,
    title: title,
    chars: full.length,
    truncated: full.length > text.length,
    text: text
  };
}

/* ---------------- 网页搜索 ---------------- */

function webSearchProviderCfg() {
  if (typeof providerResolve !== 'function') return null;
  let r = null;
  try { r = providerResolve(CONFIG, 'search'); } catch (e) {}
  if (!r || !String(r.base || '').trim()) return null;
  return r;
}

function webSearchParseSearx(data) {
  const list = data && Array.isArray(data.results) ? data.results : [];
  const out = [];
  list.forEach(item => {
    if (!item || !item.url) return;
    const url = String(item.url);
    if (!/^https?:/i.test(url)) return;
    out.push({
      title: String(item.title || url).slice(0, 160),
      url: url,
      snippet: String(item.content || '').replace(/\s+/g, ' ').slice(0, 280)
    });
  });
  return out;
}

function webSearchParseDdg(html) {
  const s = String(html || '');
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(s)) && out.length < 12) {
    let href = decodeWebEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (e) {} }
    if (href.indexOf('//') === 0) href = 'https:' + href;
    if (!/^https?:/i.test(href)) continue;
    const chunk = s.slice(re.lastIndex, re.lastIndex + 4000);
    const sn = chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|span)>/i);
    out.push({
      title: htmlToText(m[2]).slice(0, 160),
      url: href,
      snippet: sn ? htmlToText(sn[1]).slice(0, 280) : ''
    });
  }
  return out;
}

function webSearchParseBing(html) {
  const blocks = String(html || '').split(/<li class="b_algo"/i).slice(1);
  const out = [];
  blocks.forEach(b => {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) return;
    const href = decodeWebEntities(a[1]);
    if (!/^https?:/i.test(href)) return;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({
      title: htmlToText(a[2]).slice(0, 160),
      url: href,
      snippet: p ? htmlToText(p[1]).slice(0, 280) : ''
    });
  });
  return out;
}

async function webSearchSearx(provider, query) {
  let base = String(provider.base || '').replace(/\/+$/, '');
  if (!/\/search$/.test(base)) base += '/search';
  const headers = { 'Accept': 'application/json', 'User-Agent': WEB_UA };
  if (provider.key) headers['Authorization'] = 'Bearer ' + provider.key;
  const r = await reqRequest({
    url: base + '?q=' + encodeURIComponent(query) + '&format=json&language=zh-CN&safesearch=1',
    method: 'GET', headers: headers,
    timeoutMs: 15000, retries: 0, maxRedirect: 2, maxBytes: WEB_SEARCH_MAX_BYTES,
    expect: 'json', source: 'web:search'
  });
  return webSearchParseSearx(r.json);
}

async function webSearchDdg(query) {
  const r = await reqRequest({
    url: 'https://html.duckduckgo.com/html/',
    method: 'POST',
    headers: {
      'User-Agent': WEB_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    body: 'q=' + encodeURIComponent(query) + '&kl=cn-zh',
    timeoutMs: 15000, retries: 0, maxRedirect: 3, maxBytes: WEB_SEARCH_MAX_BYTES,
    expect: 'text', source: 'web:search'
  });
  return webSearchParseDdg(r.text);
}

async function webSearchBing(query) {
  const r = await reqRequest({
    url: 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-Hans',
    method: 'GET',
    headers: { 'User-Agent': WEB_UA, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeoutMs: 15000, retries: 0, maxRedirect: 3, maxBytes: WEB_SEARCH_MAX_BYTES,
    expect: 'text', source: 'web:search'
  });
  return webSearchParseBing(r.text);
}

/** web_search：先自建 SearXNG，再 DuckDuckGo，最后 Bing */
async function webSearchTool(args) {
  const query = String(args && args.query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!query) return { success: false, errorCode: 'INVALID_QUERY', error: '缺少搜索关键词' };
  const count = Math.max(1, Math.min(10, parseInt(args && args.count, 10) || 8));
  const errors = [];
  const tried = [];
  const provider = webSearchProviderCfg();
  if (provider) {
    tried.push('searxng');
    try {
      const rs = await webSearchSearx(provider, query);
      if (rs.length) return { success: true, query: query, engine: 'searxng', count: Math.min(rs.length, count), results: rs.slice(0, count) };
      errors.push('SearXNG：没有结果');
    } catch (e) { errors.push('SearXNG：' + errMsg(e)); }
  }
  tried.push('duckduckgo');
  try {
    const rs = await webSearchDdg(query);
    if (rs.length) return { success: true, query: query, engine: 'duckduckgo', count: Math.min(rs.length, count), results: rs.slice(0, count) };
    errors.push('DuckDuckGo：没有结果');
  } catch (e) { errors.push('DuckDuckGo：' + errMsg(e)); }
  tried.push('bing');
  try {
    const rs = await webSearchBing(query);
    if (rs.length) return { success: true, query: query, engine: 'bing', count: Math.min(rs.length, count), results: rs.slice(0, count) };
    errors.push('Bing：没有结果');
  } catch (e) { errors.push('Bing：' + errMsg(e)); }
  return { success: false, errorCode: 'SEARCH_FAILED', error: '搜索失败：' + errors.join('；'), tried: tried };
}
