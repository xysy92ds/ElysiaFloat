# ElysiaFloat 插件开发手册 v1

本文档面向人类开发者和代码生成模型，描述当前应用的 Manifest v1、权限、沙箱、市场安装和工具执行协议。将本文档、`schema/manifest-v1.json` 和一个示例插件一起提供给 AI，即可生成符合协议的插件；宿主仍会独立决定权限、策略和逐次确认。

## 1. 插件模型

插件由一个 JSON 清单和若干工具组成。工具有两种实现方式：

- `http`：宿主执行声明式 HTTP 请求；
- `js`：代码在 sandbox iframe 中执行，必须定义 `async function run(args)`。

插件不得访问 `Android`、宿主 DOM、宿主 localStorage、用户文件或其它插件。所有宿主能力都经过权限和原生策略检查。远程市场只提供用户主动触发的 HTTPS 只读索引同步；安装前还会校验 Manifest、ID/版本和 SHA-256。

## 2. 最小清单

无危险能力的插件：

```json
{
  "manifestVersion": 1,
  "apiVersion": "0.1",
  "id": "com.example.text",
  "name": "文本插件",
  "version": "1.0.0",
  "author": "Example",
  "desc": "处理传入文本",
  "permissions": [],
  "tools": [
    {
      "name": "text_length",
      "description": "返回文本字符数。输入 text，返回 characters；不会访问网络或设备。",
      "permissions": [],
      "kind": "js",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
      },
      "code": "async function run(args){return {characters:String(args.text||'').length};}"
    }
  ]
}
```

## 3. 权限清单

插件根部的 `permissions` 是允许工具使用的能力集合。工具可以进一步缩小权限，但不能增加插件根部没有声明的能力。

| 权限 | 用途 | 额外限制 |
|---|---|---|
| `network.public` | 公网 HTTP(S) | 必须通过宿主请求；不要把密钥写入清单 |
| `network.local` | 本机或局域网 HTTP(S) | 需要用户开启安全开关 |
| `system.open_url` | 打开系统链接 | 每次仍受宿主 URL 校验 |
| `clipboard.write` | 写入剪贴板 | 仅写入，不提供后台读取 |
| `storage.plugin` | 插件私有存储 | 仅限当前插件命名空间 |
| `files.public.read` | 读取公共存储 | 需要系统文件权限和 Agent 条件 |
| `files.public.write` | 写入、复制、创建公共存储文件 | 每次实际修改前弹窗确认 |
| `files.public.delete` | 删除公共存储文件或目录 | 每次删除前弹窗确认 |
| `workspace.read` | 读取 ElysiaFloat 工作区 | 仍受 Agent 条件限制 |
| `workspace.write` | 修改 ElysiaFloat 工作区 | 每次实际修改前弹窗确认 |
| `device.read` | 查询应用或界面信息 | 受 L1、无障碍和白名单条件限制 |
| `device.screenshot` | 获取屏幕画面 | 受 L2、截图确认和系统能力限制 |
| `device.action` | 点击、滑动、输入、启动应用 | 受 L3、白名单和安全开关限制 |
| `memory.read` | 读取长期记忆 | 只返回工具允许的记忆数据 |
| `memory.write` | 新增或修改长期记忆 | 仍遵循记忆新增和相似合并规则 |
| `memory.delete` | 请求删除长期记忆 | 每次删除还需用户确认 |

安装不等于授权。权限流程为：安装清单 → 用户启用并授权 → 每次调用再次校验。

## 4. Agent 能力与白名单（设备类插件必须阅读）

插件权限只是插件的声明，不是 Android 权限，也不是 Agent 授权。涉及设备、屏幕或文件的插件调用，必须同时满足下面的门禁：

| 插件声明 | 实际能力 | 宿主条件 |
|---|---|---|
| `device.read` | 查询应用、读取界面信息 | Agent 总开关 + L1 + 无障碍；应用操作还会检查目标应用策略 |
| `device.screenshot` | 获取屏幕画面 | Agent + L1/L2 + 无障碍或系统截屏授权；可能弹出隐私确认 |
| `device.action` | 点击、滑动、输入、按键、启动应用 | Agent + L3 + 安全开关 + 无障碍；启动/操作目标应用还必须通过白名单 |
| `files.public.read` / `workspace.read` | 读取公共存储或工作区 | Android 文件权限、Agent 条件和路径校验 |
| `files.public.write` / `workspace.write` | 写入、复制、建目录 | 上述条件，并且每次修改前用户确认 |

### 应用白名单的工作方式

白名单以 Android **包名**为键，不接受插件自行传入的“已授权”字段。正确的设备操作流程是：

1. 先用内置 `find_app` 查询设备中的真实应用名和包名；
2. 用户在 App 设置的 Agent 白名单中核对并加入目标包名；
3. 再通过 `host.callTool` 调用设备工具；
4. 宿主在每次调用时重新检查 Agent 等级、安全开关、前台应用和白名单。

查询到应用不等于允许操作；未加入白名单的 `launch_app` 或设备行为会返回权限拒绝。插件不能调用 `Android.*`、修改白名单、伪造包名，也不能通过 `host.callTool` 绕过内置工具的门禁。点击、滑动、输入后应重新读取页面验证结果；密码、发送、删除、支付等高风险行为仍需用户确认。

如果插件作者希望支持设备能力，应在 README 中写清：需要用户开启哪些 Agent 等级、无障碍/截图/文件权限、是否要求目标应用加入白名单，以及权限拒绝和用户取消时的行为。没有这些条件时，应提供只读或纯本地降级方案。

## 5. 工具字段

必填字段：

- `name`：`^[A-Za-z][A-Za-z0-9_]{1,63}$`，全局唯一；
- `description`：给 AI 的调用说明，必须写清触发条件、参数、返回值和失败情况；
- `permissions`：该工具实际使用的最小权限集合；
- `kind`：`http` 或 `js`；
- `parameters`：JSON Schema 对象。

可选字段：

- `timeout`：1000 到 60000 毫秒；
- `request`：HTTP 工具请求模板；
- `code`：JS 工具源码。

## 6. HTTP 工具

示例：

```json
{
  "name": "weather",
  "description": "根据 city 查询天气。返回 status 和 data；网络失败时返回错误。",
  "permissions": ["network.public"],
  "kind": "http",
  "timeout": 15000,
  "parameters": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  },
  "request": {
    "method": "GET",
    "url": "https://api.example.com/weather?city={{city}}",
    "headers": { "Accept": "application/json" },
    "body": ""
  }
}
```

`{{city}}` 会替换为 AI 传入的参数。HTTP 工具必须声明 `network.public` 或 `network.local`。宿主会拒绝未授权地址、危险协议和未声明的局域网请求。

## 7. JS 工具

```json
{
  "name": "copy_file",
  "description": "在用户确认后复制文件。需要 source 和 destination。",
  "permissions": ["files.public.read", "files.public.write"],
  "kind": "js",
  "parameters": {
    "type": "object",
    "properties": {
      "source": { "type": "string" },
      "destination": { "type": "string" }
    },
    "required": ["source", "destination"]
  },
  "code": "async function run(args){return await host.callTool('external_file_copy',{source:args.source,destination:args.destination,overwrite:false});}"
}
```

源码必须定义：

```js
async function run(args) {
  return { ok: true, data: args };
}
```

不要使用 `eval` 读取宿主对象，不要尝试访问 `parent.document`、`Android` 或宿主存储。

## 8. Host API

### `host.request`

需要 `network.public` 或 `network.local`：

```js
const r = await host.request({
  method: 'GET',
  url: 'https://example.com/api',
  headers: { Accept: 'application/json' },
  body: '',
  timeout: 15000
});
return { status: r.status, text: r.text };
```

### `host.callTool`

调用已声明且已授权的内置能力：

```js
await host.callTool('external_file_read', { path: args.path, max_chars: 120000 });
await host.callTool('external_file_write', { path: args.path, content: args.content, overwrite: true });
await host.callTool('external_file_copy', { source: args.source, destination: args.destination, overwrite: false });
```

不能调用其它自定义插件。文件写入、复制、创建目录、删除和危险设备行为仍会显示确认弹窗。

### 其它 API

```js
await host.toast('处理完成');
await host.log({ phase: 'done' });
await host.openUrl('https://example.com'); // 需要 system.open_url
await host.clipboard.write('text');         // 需要 clipboard.write
const value = await host.storage.get('key'); // 需要 storage.plugin
await host.storage.set('key', value);        // 需要 storage.plugin
```

## 9. 返回值和错误

工具可以返回 JSON 可序列化值。宿主保留 `success` 字段，并在失败时提供 `errorCode`。推荐：

```json
{
  "success": true,
  "data": {},
  "errorCode": "",
  "error": null
}
```

不要把异常吞掉；可以让异常抛出，宿主会返回失败结果。错误应区分：参数错误、权限拒绝、用户取消、网络错误、HTTP 错误、目标不存在、超时和插件内部错误。常见宿主错误码包括 `PERMISSION_DENIED`、`NETWORK_PERMISSION_DENIED`、`INVALID_URL`、`NETWORK_ERROR`、`HTTP_ERROR`、`SANDBOX_INIT_ERROR` 和 `PLUGIN_RUNTIME_ERROR`。

## 10. 开发文档最低要求

提交到市场的插件必须同时提供：

1. `manifest.json`；
2. `README.md`；
3. 权限理由和隐私说明；
4. 每个工具的输入、返回值和错误示例；
5. 测试步骤和已知限制；
6. 版本记录和兼容的 `apiVersion`；
7. 不包含密钥、Cookie、用户数据和设备路径的示例。

## 11. 给 AI 的生成提示词

可以把下面的任务交给代码生成模型：

> 阅读 ElysiaFloat Plugin Manifest v1 文档和 JSON Schema。请创建一个插件：先列出功能、数据流、最小权限和隐私风险，再生成合法的 `manifest.json`、完整 `README.md` 和测试用例。每个工具单独声明最小权限，不要使用未声明的 host API，不要硬编码密钥。涉及文件、设备、记忆或网络的操作必须通过 `host.callTool` 或 `host.request`，并说明用户确认和失败行为。
