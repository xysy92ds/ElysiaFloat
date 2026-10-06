# 🧩 ElysiaFloat 插件开发指南

ElysiaFloat 的插件就是**一段 JSON 清单**：声明这个插件叫什么、包含哪些工具、每个工具怎么执行。
安装后，这些工具会像内置工具一样暴露给 AI —— AI 能读到它们的说明、按参数调用，执行结果再喂回给 AI。

插件支持两种实现方式：

| `kind` | 运行方式 | 适合做什么 |
|---|---|---|
| `"http"` | 纯声明式 HTTP 请求，由宿主代发 | 调 REST API、查天气、查汇率、读 RSS、对接你自己的服务 |
| `"js"` | 一段 JavaScript，在**隔离沙箱**里运行 | 需要多次请求、字段重组、计算、条件判断的复杂逻辑 |

> 本文档就是**实现规范**。只要严格按照它写，插件一定能被正确识别和执行。
> 把本文档连同需求一起丢给 AI，它就能写出适配的插件（文末附了一段现成的生成提示词）。

---

## 目录

- [一分钟示例](#一分钟示例)
- [插件清单字段总表](#插件清单字段总表)
- [工具字段总表](#工具字段总表)
- [HTTP 工具](#http-工具)
- [JS 工具](#js-工具)
- [host API 参考](#host-api-参考)
- [安全模型](#安全模型)
- [完整示例](#完整示例)
- [常见错误](#常见错误)
- [安装与调试](#安装与调试)
- [给 AI 的生成提示词](#给-ai-的生成提示词)

---

## 一分钟示例

把下面这段 JSON 复制到 App 里：**设置 → 插件与工具 → 导入插件 → 粘贴 → 安装**。

```json
{
  "id": "com.example.weather",
  "name": "天气查询",
  "icon": "🌤️",
  "version": "1.0.0",
  "author": "你的名字",
  "desc": "查询指定城市的当前天气",
  "tools": [
    {
      "name": "get_weather",
      "description": "查询某座城市的当前天气。返回温度、天气状况、湿度。",
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "城市名，例如 上海" }
        },
        "required": ["city"]
      },
      "kind": "http",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/weather?city={{city}}"
      }
    }
  ]
}
```

安装后，跟 AI 说「上海天气怎么样」，它就会调用 `get_weather`。

---

## 插件清单字段总表

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string | ✅ | — | 插件唯一标识。正则 `^[A-Za-z0-9_.-]{2,64}$`，建议用反向域名，如 `com.yourname.tool` |
| `name` | string | ✅ | — | 插件显示名，不能为空 |
| `icon` | string | ❌ | `🧩` | 一个 emoji 或 1~2 个字符（内部截断到 4 个字符） |
| `version` | string | ❌ | `1.0.0` | 插件版本（最长 24 字符） |
| `author` | string | ❌ | `""` | 作者（最长 48 字符） |
| `desc` | string | ❌ | `""` | 一句话说明（最长 300 字符），显示在插件卡片上 |
| `enabled` | bool | ❌ | `true` | 安装后默认是否启用 |
| `tools` | array | ✅ | — | 工具列表，**至少一个合法工具**，否则整包拒收 |

**导入时接受的三种外层形态**（选任意一种即可）：

```jsonc
// ① 单个插件对象
{ "id": "...", "name": "...", "tools": [ ... ] }

// ② 包含 plugins 数组的对象（可一次装多个插件）
{ "plugins": [ { ... }, { ... } ] }

// ③ 直接是数组
[ { ... }, { ... } ]
```

**唯一性约束**（任一不满足会在安装时被拒绝并提示原因）：

- 插件 `id` 不能与已安装插件重复。
- 工具 `name` 不能与任何**内置工具**重复，也不能与任何已安装 / 同批安装的工具重复。

---

## 工具字段总表

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ✅ | — | 工具名。正则 `^[A-Za-z][A-Za-z0-9_]{1,63}$`：**以字母开头**，只含字母/数字/下划线，长度 **2~64** |
| `description` | string | ❌ | `""` | **给 AI 看的说明**：什么时候用、参数含义、返回什么。写得越清楚，AI 调用得越准（最长 500 字符） |
| `parameters` | object | ❌ | `{ "type": "object", "properties": {} }` | 标准 JSON Schema，会原样作为函数的 `parameters` 交给模型 |
| `kind` | string | ✅ | — | `"http"` 或 `"js"`，其它值一律非法 |
| `timeout` | int | ❌ | `15000` | 执行超时（毫秒），会被夹到 **1000 ~ 60000** 之间 |

> `name` 建议全小写 + 下划线，例如 `get_weather`、`translate_text`、`list_issues`。
> 不要用中文、空格、连字符或大写开头。

---

## HTTP 工具

`kind: "http"` 时，额外需要一个 `request` 对象：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `request.method` | string | ❌ | `GET` | 自动转大写，支持 GET/POST/PUT/PATCH/DELETE 等 |
| `request.url` | string | ✅ | — | 请求地址，**不能为空**，只允许 `http` / `https` |
| `request.headers` | object | ❌ | `{}` | 请求头，键值都为字符串 |
| `request.body` | string \| object | ❌ | `""` | 请求体。字符串原样发送；对象会自动 `JSON.stringify` |

### 参数占位符

`url`、每个 `headers` 的值、`body` 里都可以写 `{{参数名}}`。
执行时会被替换成 AI 传入的对应参数：

```
https://api.example.com/search?q={{keyword}}&page={{page}}
Authorization: Bearer {{token}}
{"city": "{{city}}"}
```

规则：

- 占位符正则：`\{\{\s*([A-Za-z0-9_]+)\s*\}\}`（花括号内允许空格）。
- 参数不存在、为 `null` 或 `undefined` → 替换成**空字符串**。
- 替换发生在 URL / 请求头 / body 上；`method` 不做替换。
- ⚠️ 替换是**纯文本拼接**，不会做 URL 编码。如果参数可能含有空格、中文、`&`、`?` 等，请让 AI 传入已编码的值，或改用 `kind: "js"` 用 `encodeURIComponent` 自己拼。

### 执行结果

返回给 AI 的对象：

```jsonc
// 成功
{ "success": true, "status": 200, "data": <解析后的内容> }

// 失败（网络错误 / 非法地址 / 超时）
{ "success": false, "error": "错误原因" }
```

`data` 的解析规则：

- 响应体以 `{` 或 `[` 开头 → 尝试 `JSON.parse`，成功则给对象，失败则给字符串。
- 其它情况 → 原样字符串（最多 50000 字符）。
- 会去掉开头的 BOM。

> HTTP 工具由**原生侧**代发（`HttpURLConnection`），因此不受 WebView 跨域限制，也不会带上网页的 cookie。

---

## JS 工具

`kind: "js"` 时，额外需要一个 `code` 字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | ✅ | JavaScript 源码，**必须定义 `run` 函数**，不能为空 |

### 写法约定

`code` 会被这样包装执行：

```js
const host = { /* 见下 */ };
const fn = new Function('host', '"use strict";' + YOUR_CODE + '\n;return (typeof run === "function") ? run : null;');
const run = fn(host);
return await run(args);   // args 就是 AI 传入的参数对象
```

所以你的代码里：

- 直接定义 `async function run(args) { ... }` 即可（也可以定义普通函数 `function run(args){}`）。
- 可以使用作用域里的 `host` 对象。
- 顶部处于严格模式（`"use strict"`）。
- 返回值会被序列化后交给 AI。**请返回简单、可 JSON 序列化的值**（对象 / 数组 / 字符串 / 数字 / 布尔）。
- 单次返回值若序列化后超过 50000 字符，会被替换成 `{ truncated: true, preview: "前20000字符" }`。

### 最小示例

```json
{
  "name": "echo_text",
  "description": "把传入的文字原样返回，用于测试。",
  "parameters": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"]
  },
  "kind": "js",
  "code": "async function run(args){ return { echoed: args.text }; }"
}
```

### 带网络请求的示例

```js
async function run(args) {
  const url = 'https://api.github.com/repos/' + encodeURIComponent(args.repo);
  const r = await host.request({
    url: url,
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ElysiaFloat' }
  });
  if (r.status !== 200) return { error: 'HTTP ' + r.status };
  const info = JSON.parse(r.text);
  return {
    full_name: info.full_name,
    stars: info.stargazers_count,
    description: info.description
  };
}
```

---

## host API 参考

`host` 是沙箱提供给插件的唯一能力入口，**全部返回 Promise**，请用 `await`。
除 `host.request` / `host.openUrl` 会对 URL 做安全校验外，其余都是本地无网络操作。

### `host.request(options)`

发起一个 HTTP 请求（由宿主代发，带完整安全校验）。

```js
const r = await host.request({
  method: 'GET',                 // 默认 'GET'，自动转大写
  url: 'https://api.example.com/x', // 必填，仅 http/https
  headers: { 'Authorization': 'Bearer xxx' }, // 可选
  body: '{"a":1}',               // 可选，字符串；对象会自动 JSON.stringify
  timeout: 20000                 // 可选，1000~60000，默认 20000
});
// r = { status: 200, text: '响应正文（最多 200000 字符）' }
```

- 失败（网络错误、非法 URL、超时）会 **throw**，请用 `try/catch` 包住。
- 响应正文不会自动解析 JSON，需要 `JSON.parse(r.text)`。

### `host.toast(text)`

在界面上弹一条短提示（最多 200 字符）。适合调试或给用户反馈。

```js
await host.toast('查询完成 ♪');
```

### `host.log(...args)`

输出调试日志到 App 控制台（`console.log`）。参数会转成字符串。

```js
await host.log('args =', args);
```

### `host.openUrl(url)`

用系统浏览器打开一个链接。URL 同样受安全校验限制。

```js
await host.openUrl('https://example.com');
```

### `host.clipboard.write(text)`

写入系统剪贴板。

```js
await host.clipboard.write('复制这段文字');
```

### `host.storage.get(key)` / `host.storage.set(key, value)`

插件的**私有键值存储**（按插件 `id` 隔离，持久化在本机）。

```js
const n = (await host.storage.get('runCount')) || 0;
await host.storage.set('runCount', n + 1);

const cfg = await host.storage.get('config'); // 不存在时返回 undefined
```

- `key` 会转成字符串。
- `value` 必须是可序列化的值（对象 / 数组 / 基本类型）。
- 不同插件的存储互不可见。

> 插件**没有**、也不需要 `localStorage`、`sessionStorage`、cookie —— 它们在沙箱里不可用。请统一用 `host.storage`。

---

## 安全模型

插件被刻意限制在一个很窄的盒子里，请务必理解，不要设计越界的功能：

- **隔离沙箱**：JS 插件运行在 `<iframe sandbox="allow-scripts">` 里，是 **opaque origin**。
  - 拿不到 App 的 `Android.*` 桥、拿不到父页面 DOM、拿不到别的插件数据、没有文件系统访问。
- **禁止自带网络**：沙箱文档带 CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'`。
  - 插件**无法**使用 `fetch` / `XMLHttpRequest` / `WebSocket` / `<img>` 等直接联网。
  - 所有网络请求**只能**通过 `host.request`，由宿主统一校验后发出。
- **URL 白名单校验**：`host.request` 与 `host.openUrl` 都会检查地址：
  - 只允许 `http:` 与 `https:`；
  - 拒绝本机与链路本地地址：`localhost`、`*.localhost`、`0.0.0.0`、`::1`、`[::1]`、`127.*`、`169.254.*`；
  - 其它协议（`file:`、`ftp:`、`javascript:` 等）一律拒绝。
- **串行执行**：同一时刻只运行一个 JS 插件任务，保证 `host` 调用与当前插件对应。
- **超时**：每个工具执行超过 `timeout`（默认 15 秒）会被中止。
- **安装确认**：安装任何插件前都会向你展示并征求确认 —— 请**只安装你信任来源的插件**。

> 安全边界意味着：插件能做的最"危险"的事，就是在你批准安装后，向公开的 http(s) 地址发请求、写剪贴板、打开链接。
> 即便如此，恶意插件仍可能把你的参数转发到第三方服务器，所以来源不可信的插件不要装。

---

## 完整示例

### 例 1 · 纯 HTTP 查汇率

```json
{
  "id": "com.example.fx",
  "name": "汇率查询",
  "icon": "💱",
  "version": "1.0.0",
  "desc": "查询两种货币之间的汇率",
  "tools": [
    {
      "name": "get_fx_rate",
      "description": "查询 from 货币兑换到 to 货币的当前汇率。",
      "parameters": {
        "type": "object",
        "properties": {
          "from": { "type": "string", "description": "源货币代码，如 USD" },
          "to": { "type": "string", "description": "目标货币代码，如 CNY" }
        },
        "required": ["from", "to"]
      },
      "kind": "http",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/rate?base={{from}}&symbols={{to}}",
        "headers": { "Accept": "application/json" }
      }
    }
  ]
}
```

### 例 2 · JS 多步骤：仓库信息 + 最近 Release

```json
{
  "id": "com.example.github",
  "name": "GitHub 助手",
  "icon": "🐙",
  "version": "1.0.0",
  "author": "你",
  "desc": "读取 GitHub 仓库的概览信息",
  "tools": [
    {
      "name": "github_repo_info",
      "description": "读取某个 GitHub 仓库的 star 数、语言、描述和最新 release 标签。",
      "parameters": {
        "type": "object",
        "properties": {
          "repo": { "type": "string", "description": "owner/name，例如 xysy92ds/ElysiaFloat" }
        },
        "required": ["repo"]
      },
      "kind": "js",
      "timeout": 20000,
      "code": "async function run(args){\n  if(!args.repo) return { error: '缺少 repo 参数' };\n  const base = 'https://api.github.com/repos/' + encodeURIComponent(args.repo);\n  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ElysiaFloat' };\n  try {\n    const repo = JSON.parse((await host.request({ url: base, headers: h })).text);\n    let tag = null;\n    try {\n      const rel = JSON.parse((await host.request({ url: base + '/releases/latest', headers: h })).text);\n      tag = rel.tag_name || null;\n    } catch(e) {}\n    await host.storage.set('lastRepo', args.repo);\n    return {\n      full_name: repo.full_name,\n      stars: repo.stargazers_count,\n      language: repo.language,\n      description: repo.description,\n      latest_release: tag\n    };\n  } catch(e) {\n    return { error: String(e && e.message || e) };\n  }\n}"
    }
  ]
}
```

### 例 3 · 一个插件多工具 + 私有存储计数

```json
{
  "id": "com.example.notes",
  "name": "便签",
  "icon": "📝",
  "version": "1.0.0",
  "desc": "把笔记存在插件私有存储里",
  "tools": [
    {
      "name": "note_save",
      "description": "保存一条笔记（覆盖同名笔记）。",
      "parameters": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["title", "content"]
      },
      "kind": "js",
      "code": "async function run(args){\n  var all = (await host.storage.get('notes')) || {};\n  all[args.title] = { content: args.content, at: Date.now() };\n  await host.storage.set('notes', all);\n  await host.toast('已保存：' + args.title);\n  return { saved: args.title, total: Object.keys(all).length };\n}"
    },
    {
      "name": "note_list",
      "description": "列出所有已保存笔记的标题。",
      "parameters": { "type": "object", "properties": {} },
      "kind": "js",
      "code": "async function run(args){\n  var all = (await host.storage.get('notes')) || {};\n  return { titles: Object.keys(all) };\n}"
    }
  ]
}
```

---

## 常见错误

| 现象 / 报错 | 原因 | 解决 |
|---|---|---|
| `不是有效的 JSON` | 清单不是合法 JSON（多了逗号、用了单引号、注释没删） | 用严格 JSON：双引号、无尾逗号、无注释 |
| `清单格式不对` | 外层既不是插件对象、也不是 `{plugins:[]}` 或数组 | 改成三种合法形态之一 |
| `插件清单不完整` | 缺 `id`/`name`，或没有一个合法工具 | 补齐必填字段 |
| `插件 id 已存在` | 同 id 已装 | 换一个 id，或先删除旧插件 |
| `工具名与内置工具冲突` / `工具名重复` | 工具名撞车 | 换一个全局唯一的工具名 |
| 工具压根没出现在插件页 | `plugNormalizeTool` 把它判为非法后**静默丢弃** | 检查 `name` 正则（字母开头、2~64、仅字母数字下划线）和 `kind` 是否为 `"http"`/`"js"` |
| `网址格式不正确` / `只允许 http/https 请求` / `不允许访问本机地址` | URL 非法或被安全策略拦截 | 换成公网 http(s) 地址 |
| `插件执行超时` | 超过 `timeout` | 调大 `timeout`（最大 60000）或优化逻辑 |
| `插件没有定义 run 函数` | `code` 里没写 `run` | 定义 `async function run(args){...}` |
| JS 里 `fetch is not defined` / 请求被 CSP 拦 | 沙箱禁止自带网络 | 改用 `host.request` |
| 参数没被替换 | 占位符名与 `parameters` 属性名不一致 | 保证 `{{name}}` 与 AI 传入的键名一致 |

---

## 安装与调试

1. **导入**：设置 → 插件与工具 → 导入插件 → 粘贴 JSON → 安装 → 确认。
2. **查看**：安装后出现在「🧩 自定义插件」区域，可整体开关、也可**逐个工具**开关。
   关闭的工具会立即从 AI 的工具列表和提示词中消失。
3. **删除**：点插件卡片右侧「删除」。
4. **调试 JS 插件**：用 `await host.log(...)` 输出中间值；用 `await host.toast(...)` 看即时反馈。
5. **看 AI 实际拿到了什么**：插件页点「AI 说明」，会显示当前喂给模型的所有工具描述。
6. **格式速查**：插件页点「格式说明」可随时查看精简版清单模板。

---

## 给 AI 的生成提示词

需要让 AI 帮你写插件时，把下面这段连同需求一起发给它：

```
请为 ElysiaFloat 写一个插件清单（JSON）。严格遵守以下规范：

1. 输出一个 JSON 对象，字段：id（反向域名，^[A-Za-z0-9_.-]{2,64}$）、name、icon（emoji）、
   version、author、desc、tools（数组，至少 1 个）。
2. 每个工具字段：name（^[A-Za-z][A-Za-z0-9_]{1,63}$，字母开头，仅字母数字下划线）、
   description（给 AI 看的中文说明）、parameters（JSON Schema）、kind（"http" 或 "js"）、
   可选 timeout（毫秒，1000~60000）。
3. kind="http" 时提供 request：{ method, url, headers, body }，
   url/headers/body 里可用 {{参数名}} 占位，参数名必须与 parameters 的属性名一致。
   注意占位符是纯文本拼接、不做 URL 编码；参数可能含中文/空格时改用 kind="js"。
4. kind="js" 时提供 code：必须定义 async function run(args){ ... }。
   - 只能用 host 对象的能力，全部返回 Promise：
       host.request({method,url,headers,body,timeout}) -> {status, text}
       host.toast(text) / host.log(...) / host.openUrl(url)
       host.clipboard.write(text)
       host.storage.get(key) / host.storage.set(key, value)
   - 禁止使用 fetch / XMLHttpRequest / localStorage / window / document（沙箱里没有）。
   - 网络请求必须走 host.request，并用 try/catch 处理异常。
   - run 的返回值必须是可 JSON 序列化的简单值。
5. 只允许访问公网 http/https，禁止 localhost、127.*、169.254.*。
6. 只输出 JSON，不要输出解释、不要用 Markdown 代码块以外的文字。

我的需求是：<在这里写你要的功能>
```

---

## 参考

- 插件执行与校验逻辑：`android/app/src/main/assets/index.html` 中的
  `plugNormalize` / `plugNormalizeTool` / `plugUrlAllowed` / `plugExec` /
  `plugExecJs` / `plugHandleHost` / `PLUG_SANDBOX_HTML`。
- App 内精简版说明：插件页「格式说明」按钮。
- 项目总览：[`README.md`](README.md)
