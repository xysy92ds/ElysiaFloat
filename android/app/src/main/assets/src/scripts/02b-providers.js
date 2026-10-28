/* ==========================================================
 *  模型中心（0.9 / E2-001~003）
 *
 *  Provider 注册表 + 能力标签 + 用途绑定。
 *  设计目标：
 *   - 新增 Provider 不需要改聊天请求代码；chatReq 继续读旧扁平字段。
 *   - 旧配置（apiBase/apiKey/model、vision*、tts*、vec*）自动迁移成 Provider。
 *   - Provider 只保存 secretRef（密钥仓名称），不保存明文 Key。
 * ========================================================== */
const PROVIDER_KINDS = {
  openai:    { label: 'OpenAI 兼容', defaultBase: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic',  defaultBase: 'https://api.anthropic.com/v1' },
  gemini:    { label: 'Gemini',     defaultBase: 'https://generativelanguage.googleapis.com/v1beta' },
  custom:    { label: '自定义',      defaultBase: '' }
};
const PROVIDER_CAPS = ['chat', 'vision', 'image', 'video', 'embedding', 'tts', 'asr', 'code'];
const PROVIDER_CAP_LABEL = {
  chat: '对话', vision: '识图', image: '生图', video: '视频',
  embedding: '向量', tts: '语音', asr: '语音识别', code: '代码'
};
/** 可绑定用途；chat / vision / tts 与现有请求路径一一对应。 */
const PROVIDER_PURPOSES = ['chat', 'vision', 'image', 'video', 'embedding', 'tts', 'asr'];
const PROVIDER_PURPOSE_LABEL = {
  chat: '聊天', vision: '识图', image: '生图', video: '视频',
  embedding: '向量', tts: '语音', asr: '语音识别'
};

function providerId(prefix) {
  return (prefix || 'p') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
}

/** 归一化一条 Provider；无效返回 null。任何明文 Key 字段一律丢弃。 */
function providerNormalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const kind = PROVIDER_KINDS[raw.kind] ? raw.kind : 'openai';
  const caps = Array.isArray(raw.capabilities)
    ? raw.capabilities.map(c => String(c)).filter(c => PROVIDER_CAPS.indexOf(c) >= 0)
    : [];
  return {
    id: id,
    name: String(raw.name || id).trim() || id,
    kind: kind,
    base: String(raw.base || '').trim(),
    model: String(raw.model || '').trim(),
    secretRef: String(raw.secretRef || ('ai.provider.' + id)).trim(),
    capabilities: caps,
    enabled: raw.enabled !== false
  };
}

function providerKeyOf(p) {
  if (!p || !p.secretRef || !secretStore.ok) return '';
  return secretStore.get(p.secretRef, '');
}

function providerFind(cfg, id) {
  if (!cfg || !Array.isArray(cfg.providers)) return null;
  for (let i = 0; i < cfg.providers.length; i++) {
    if (cfg.providers[i] && cfg.providers[i].id === id) return cfg.providers[i];
  }
  return null;
}

/** 把旧扁平配置迁成固定 id 的 Provider；重复执行不会新增。 */
function providerMigrate(cfg, aux) {
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  cfg.providers = cfg.providers.map(providerNormalize).filter(Boolean);

  function ensure(id, raw) {
    if (providerFind(cfg, id)) return;
    const p = providerNormalize(Object.assign({ id: id }, raw));
    if (p) cfg.providers.push(p);
  }

  ensure('legacy-chat', {
    name: '主模型', kind: 'openai',
    base: cfg.apiBase || DC.apiBase, model: cfg.model || DC.model,
    secretRef: 'ai.apiKey', capabilities: ['chat', 'code']
  });

  if (String(cfg.visionBase || '').trim()) {
    ensure('legacy-vision', {
      name: '识图模型', kind: 'openai',
      base: cfg.visionBase, model: cfg.visionModel,
      secretRef: 'ai.visionKey', capabilities: ['vision']
    });
  }
  if (String(cfg.ttsBaseUrl || '').trim()) {
    ensure('legacy-tts', {
      name: '语音合成', kind: 'openai',
      base: cfg.ttsBaseUrl, model: cfg.ttsModel,
      secretRef: 'ai.ttsApiKey', capabilities: ['tts']
    });
  }
  if (aux && String(aux.vecBase || '').trim()) {
    ensure('legacy-vector', {
      name: '向量模型', kind: 'openai',
      base: aux.vecBase, model: aux.vecModel,
      secretRef: 'mem.vecKey', capabilities: ['embedding']
    });
  }
  if (!cfg.bindings || typeof cfg.bindings !== 'object' || Array.isArray(cfg.bindings)) cfg.bindings = {};
  const bind = (purpose, id, model) => {
    const b = cfg.bindings[purpose];
    if (!b || !b.provider) cfg.bindings[purpose] = { provider: id, model: model || '' };
  };
  bind('chat', 'legacy-chat', cfg.model || '');
  if (providerFind(cfg, 'legacy-vision')) bind('vision', 'legacy-vision', cfg.visionModel || '');
  if (providerFind(cfg, 'legacy-tts')) bind('tts', 'legacy-tts', cfg.ttsModel || '');
  if (providerFind(cfg, 'legacy-vector')) bind('embedding', 'legacy-vector', (aux && aux.vecModel) || '');
}

/** 旧扁平字段改动后，把固定 id 的旧 Provider 同步过去，避免启动时回填过期值。 */
function providerSyncLegacy(cfg, aux) {
  const sync = (id, base, model) => {
    const p = providerFind(cfg, id);
    if (!p) return;
    p.base = String(base || '').trim();
    p.model = String(model || '').trim();
  };
  sync('legacy-chat', cfg.apiBase, cfg.model);
  sync('legacy-vision', cfg.visionBase, cfg.visionModel);
  sync('legacy-tts', cfg.ttsBaseUrl, cfg.ttsModel);
  if (aux) sync('legacy-vector', aux.vecBase, aux.vecModel);
  if (!String(cfg.visionBase || '').trim() && !String(cfg.visionKey || '').trim()) {
    cfg.providers = (cfg.providers || []).filter(p => !p || p.id !== 'legacy-vision');
    if (cfg.bindings && cfg.bindings.vision && cfg.bindings.vision.provider === 'legacy-vision') delete cfg.bindings.vision;
  }
}

/** 解析某用途实际使用的 Provider：绑定优先，失效则回退到第一个具备该能力的启用项。 */
function providerResolve(cfg, purpose) {
  if (!cfg || !Array.isArray(cfg.providers)) return null;
  const b = (cfg.bindings && cfg.bindings[purpose]) || null;
  let p = b && providerFind(cfg, b.provider);
  const usable = x => x && x.enabled !== false && (x.capabilities || []).indexOf(purpose) >= 0;
  if (!usable(p)) p = cfg.providers.filter(usable)[0] || null;
  if (!p) return null;
  return {
    provider: p,
    base: String(p.base || ''),
    key: providerKeyOf(p),
    model: (b && b.provider === p.id && b.model) || p.model || ''
  };
}

/** 兼容层：把绑定结果回填到旧字段；请求层继续读旧字段，不用改。 */
function providerApply(cfg, purpose) {
  const r = providerResolve(cfg, purpose);
  if (!r) return false;
  // 密钥仓不可用时保留旧扁平字段里的 Key，避免旧壳/浏览器直接丢 Key。
  const key = secretStore.ok ? r.key : null;
  if (purpose === 'chat') {
    cfg.apiBase = r.base; cfg.model = r.model;
    if (key !== null) cfg.apiKey = key;
  } else if (purpose === 'vision') {
    cfg.visionBase = r.base; cfg.visionModel = r.model;
    if (key !== null) cfg.visionKey = key;
  } else if (purpose === 'tts') {
    cfg.ttsBaseUrl = r.base; cfg.ttsModel = r.model;
    if (key !== null) cfg.ttsApiKey = key;
  }
  return true;
}

/** 新增或更新 Provider；secret 不为 undefined 时写密钥仓（空串表示删除）。 */
function providerUpsert(cfg, raw, secret) {
  const p = providerNormalize(raw);
  if (!p || !cfg) return null;
  if (secret !== undefined && secretStore.ok) secretStore.put(p.secretRef, secret || '');
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  cfg.providers = cfg.providers.filter(x => x && x.id !== p.id);
  cfg.providers.push(p);
  return p;
}

function providerRemove(cfg, id) {
  if (!cfg || !Array.isArray(cfg.providers)) return false;
  const p = providerFind(cfg, id);
  if (!p) return false;
  cfg.providers = cfg.providers.filter(x => x && x.id !== id);
  if (cfg.bindings) {
    PROVIDER_PURPOSES.forEach(k => {
      if (cfg.bindings[k] && cfg.bindings[k].provider === id) delete cfg.bindings[k];
    });
  }
  // 只删除本应用自己生成的 Provider 密钥；legacy-* 的明文迁移 Key 仍由旧字段管理。
  if (p.secretRef && p.secretRef.indexOf('ai.provider.') === 0) secretStore.del(p.secretRef);
  return true;
}

function providerBind(cfg, purpose, id, model) {
  if (!cfg || PROVIDER_PURPOSES.indexOf(purpose) < 0) return false;
  const p = providerFind(cfg, id);
  if (!p) return false;
  if (!cfg.bindings || typeof cfg.bindings !== 'object') cfg.bindings = {};
  cfg.bindings[purpose] = { provider: id, model: String(model || '') };
  providerApply(cfg, purpose);
  return true;
}

/** 启动与保存后的统一入口：迁移 + 回填。 */
function providerEnsure(cfg, aux) {
  if (!cfg) return cfg;
  providerMigrate(cfg, aux);
  PROVIDER_PURPOSES.forEach(k => providerApply(cfg, k));
  return cfg;
}

/** 列表用的脱敏摘要，永远不含 Key。 */
function providerSummary(cfg) {
  const list = (cfg && Array.isArray(cfg.providers)) ? cfg.providers : [];
  return list.map(p => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    kindLabel: (PROVIDER_KINDS[p.kind] || PROVIDER_KINDS.custom).label,
    base: p.base,
    model: p.model,
    capabilities: p.capabilities.slice(),
    enabled: p.enabled !== false,
    hasKey: !!providerKeyOf(p),
    legacy: p.id.indexOf('legacy-') === 0
  }));
}

/** 从模型名推断能力；只做提示，不写回配置。 */
function providerInferCaps(ids) {
  const caps = {};
  const list = Array.isArray(ids) ? ids : [];
  list.forEach(raw => {
    const s = String(raw || '').toLowerCase();
    if (!s) return;
    if (/embed/.test(s)) caps.embedding = 1;
    if (/tts|speech|audio/.test(s)) caps.tts = 1;
    if (/whisper|transcri|asr/.test(s)) caps.asr = 1;
    if (/vision|(^|[-_/])vl([-_/]|$)|4o|omni|gemini|claude|glm-4v|qwen.*vl/.test(s)) caps.vision = 1;
    if (/image|dall-e|imagen|flux|stable-diffusion|sd3/.test(s)) caps.image = 1;
    if (/video|sora|veo|kling|runway/.test(s)) caps.video = 1;
    if (/code|coder|codex/.test(s)) caps.code = 1;
    if (!/embed|tts|speech|whisper|transcri/.test(s)) caps.chat = 1;
  });
  return PROVIDER_CAPS.filter(c => caps[c]);
}

function providerTestHeaders(p, key) {
  const h = { 'Accept': 'application/json', 'User-Agent': 'ElysiaFloat' };
  if (p.kind === 'anthropic') {
    if (key) h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else if (p.kind !== 'gemini' && key) {
    h['Authorization'] = 'Bearer ' + key;
  }
  return h;
}

/**
 * E2-005：连接测试 + 能力探测。只 GET /models，不发起付费推理。
 * 返回 Promise<{ ok, latencyMs, status, error, models, capabilities }>。
 */
function providerTest(cfg, id) {
  const p = providerFind(cfg, id);
  if (!p) return Promise.reject(new Error('Provider 不存在'));
  if (!String(p.base || '').trim()) return Promise.reject(new Error('还没填接口地址'));
  const key = providerKeyOf(p);
  let url = String(p.base).replace(/\/+$/, '');
  if (url.indexOf('/models') < 0) url += '/models';
  if (p.kind === 'gemini' && key) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key);
  const t0 = Date.now();
  return reqRequest({
    method: 'GET', url: url,
    headers: providerTestHeaders(p, key),
    timeoutMs: 15000, expect: 'json', retries: 0, source: 'system:provider-test'
  }).then(r => {
    const d = r.json || {};
    const raw = Array.isArray(d.data) ? d.data : (Array.isArray(d.models) ? d.models : []);
    const ids = raw.map(x => (x && (x.id || x.name)) || '').filter(Boolean);
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      status: r.status || 200,
      error: '',
      models: ids.slice(0, 200),
      capabilities: providerInferCaps(ids)
    };
  }).catch(e => ({
    ok: false,
    latencyMs: Date.now() - t0,
    status: (e && e.status) || 0,
    error: errMsg(e),
    models: [],
    capabilities: []
  }));
}
