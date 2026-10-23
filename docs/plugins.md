# 插件开发

ElysiaFloat 使用 **Manifest v1** 插件格式。一个插件由一个 JSON 清单和若干工具组成，工具可以用声明式 HTTP 请求实现，也可以在沙箱中运行 JavaScript。

插件不能直接访问 `Android` 桥、宿主页面、宿主存储、用户文件或其它插件。所有宿主能力都必须经过插件权限与原生策略校验。

## 1. 目录与文件

```text
marketplace/
├── index.json                    # 市场索引
├── schema/
│   ├── manifest-v1.json          # 插件清单 Schema
│   └── index-v1.json             # 索引 Schema
└── plugins/<plugin-id>/
    ├── manifest.json
    └── README.md
```

安装来源：

- 插件市场（只读索引，用户主动同步）；
- 本地 JSON 文件导入；
- URL 导入（HTTPS）。

## 2. 最小清单

```json
{
  "manifestVersion": 1,
  "apiVersion": "0.1",
  "id": "com.example.text",
  "name": "文本工具",
  "version": "1.0.0",
  "author": "Example",
  "desc": "处理传入文本",
  "permissions": [],
  "tools": [
    {
      "name": "text_length",
      "description": "返回文本字符数。输入 text，返回 characters；不访问网络或设备。",
      "permissions": [],
      "kind": "js",
      "parameters": {
        "type": "object",
        "properties": {
          "text": { "type": "string" }
        },
        "required": ["text"]
      },
      "code": "async function run(args){ return { characters: String(args.text || '').length }; }"
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifestVersion` | 是 | 固定为 `1` |
| `apiVersion` | 是 | 当前为 `"0.1"` |
| `id` | 是 | 2–64 位，允许字母、数字、`_`、`.`、`-` |
| `name` | 是 | 显示名称 |
| `version` | 是 | 插件版本 |
| `author` | 是 | 作者 |
| `desc` | 是 | 功能说明 |
| `permissions` | 是 | 插件级权限集合 |
| `tools` | 是 | 工具列表 |

## 3. 工具字段

必填：

- `name`：`^[A-Za-z][A-Za-z0-9_]{1,63}$`，全局唯一；
- `description`：给模型的调用说明，写清触发条件、参数、返回值与失败情况；
- `permissions`：该工具实际使用的最小权限集合，必须是插件级权限的子集；
- `kind`：`http` 或 `js`；
- `parameters`：JSON Schema 对象。

可选：

- `timeout`：1000–60000 毫秒，默认 15000；
- `request`：HTTP 工具的请求模板；
- `code`：JS 工具的源码。

## 4. 权限

插件根部的 `permissions` 是允许工具使用的能力集合。工具只能缩小，不能增加插件根部未声明的权限。

| 权限 | 用途 | 额外限制 |
|---|---|---|
| `network.public` | 公网 HTTP(S) 请求 | 必须经宿主发起 |
| `network.local` | 本机或局域网 HTTP(S) 请求 | 还需开启安全开关 |
| `system.open_url` | 打开系统链接 | 每次仍做 URL 校验 |
| `clipboard.write` | 写入剪贴板 | 只能写入，不能后台读取 |
| `storage.plugin` | 插件私有存储 | 仅限当前插件命名空间 |
| `files.public.read` | 读取公共存储 | 需文件权限与 Agent 条件 |
| `files.public.write` | 写入、复制、创建公共存储文件 | 修改前确认 |
| `files.public.delete` | 删除公共存储文件或目录 | 每次删除都确认 |
| `workspace.read` | 读取工作区 | 仍受 Agent 条件限制 |
| `workspace.write` | 修改工作区 | 授权期内免逐次确认 |
| `device.read` | 查询应用或界面信息 | 需 L1 与无障碍 |
| `device.screenshot` | 获取屏幕画面 | 需 L2 与截屏授权 |
| `device.action` | 点击、滑动、输入、启动应用 | 需 L3、安全开关与白名单 |
| `memory.read` | 读取长期记忆 | 只返回工具允许的数据 |
| `memory.write` | 新增或修改长期记忆 | 遵循记忆合并规则 |
| `memory.delete` | 删除长期记忆 | 仍需用户确认 |
| `music.control` | 搜索、播放、切歌、收藏 | 受音乐总开关与来源限制 |

安装不等于授权。权限流程为：**安装清单 → 用户启用并授权 → 每次调用再次校验**。

## 5. HTTP 工具

```json
{
  "name": "weather",
  "description": "根据 city 查询天气。返回 data；网络失败时返回错误。",
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

- `{{参数名}}` 会替换为模型传入的参数；
- 只允许 `http` / `https`；
- 未声明 `network.public` 或 `network.local` 时请求会被拒绝；
- 局域网与本机地址还需要安全开关。

## 6. JS 工具

```js
async function run(args) {
  return { ok: true, value: args.text };
}
```

源码必须定义 `async function run(args)`，执行环境只额外提供 `host` 对象。

### Host API

```js
// 网络请求（需 network.public / network.local）
const r = await host.request({
  method: 'GET',
  url: 'https://example.com/api',
  headers: { Accept: 'application/json' },
  body: '',
  timeout: 15000
});
// r = { status, text }

// 调用内置能力（权限必须是插件已声明的子集）
await host.callTool('external_file_read', { path: '/sdcard/Download/a.txt', max_chars: 20000 });
await host.callTool('external_file_write', { path: '/sdcard/Download/b.txt', content: 'hi', overwrite: true });

// 其它
await host.toast('处理完成');
await host.log({ phase: 'done' });
await host.openUrl('https://example.com');     // system.open_url
await host.clipboard.write('text');            // clipboard.write
const v = await host.storage.get('key');       // storage.plugin
await host.storage.set('key', v);              // storage.plugin
```

限制：

- `host.callTool` 只能调用内置工具，不能调用其它自定义插件；
- 文件写入、复制、建目录、删除与设备操作仍会经过权限、Agent 策略与确认流程；
- 沙箱内不能访问 `parent.document`、`Android`、宿主存储或网络之外的系统能力。

## 7. 返回值与错误

工具可以返回任意 JSON 可序列化值。宿主统一包装为：

```json
{
  "success": true,
  "result": {},
  "meta": { "plugin": "com.example.text", "tool": "text_length" }
}
```

失败时：

```json
{
  "success": false,
  "errorCode": "PERMISSION_DENIED",
  "error": "插件工具权限未获用户授权"
}
```

常见错误码：

| 错误码 | 含义 |
|---|---|
| `PLUGIN_NOT_FOUND` | 插件或工具不存在 |
| `PLUGIN_DISABLED` | 插件已停用 |
| `PLUGIN_QUARANTINED` | 插件处于隔离状态 |
| `PERMISSION_DENIED` | 权限未授权 |
| `NETWORK_PERMISSION_DENIED` | 网络权限或安全开关不满足 |
| `INVALID_URL` | 地址不合法或协议不允许 |
| `NETWORK_ERROR` | 网络请求失败 |
| `HTTP_ERROR` | HTTP 状态码异常 |
| `SANDBOX_INIT_ERROR` | 沙箱初始化失败 |
| `PLUGIN_RUNTIME_ERROR` | 插件代码异常或超时 |

不要吞掉异常：抛出后宿主会返回失败结果。

## 8. 市场索引

`marketplace/index.json` 使用 `indexVersion: 1`，每个条目包含：

- `id`、`name`、`version`、`author`、`description`；
- `manifest` 与 `docs` 的相对路径；
- `permissions`；
- `trust`、`reviewStatus`；
- `manifest.json` 的 SHA-256。

应用只在用户主动点击同步时读取索引；安装时重新下载清单，并校验 HTTPS 地址、Schema、插件 ID、版本与 SHA-256。

## 9. 提交要求

1. 使用 Manifest v1 与兼容的 `apiVersion`；
2. 声明最小插件级与工具级权限；
3. 为每个工具说明输入、返回值、错误与隐私影响；
4. 提供 `manifest.json` 与 `README.md`；
5. 不保存 Token、Cookie、设备路径与用户数据；
6. 通过清单校验、工具名冲突检查、沙箱语法检查与 SHA-256 生成；
7. 不在文档中宣称「审核通过」或「哈希匹配」代表绝对安全。

## 10. 安全提醒

插件权限不是 Android 权限，也不能绕过 Agent 等级、安全开关、应用白名单或文件确认。第三方插件可能包含代码错误、隐私泄露或恶意请求；安装前请阅读 README 与权限列表，不要向插件提供密码、API Key、Cookie 或不必要的个人数据。
