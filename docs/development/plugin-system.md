# 当前插件系统与插件市场

本文档描述当前应用中的插件组件、权限协议、执行边界、市场索引和生命周期。开发者写插件时还应同时阅读 `marketplace/PLUGIN_DEVELOPMENT.md` 和 `marketplace/schema/manifest-v1.json`。

## 1. 插件组件

插件由 Manifest v1 和一个或多个工具组成。宿主支持两种工具实现：

- `http`：宿主根据请求模板代发 HTTP(S) 请求；
- `js`：代码在 `iframe sandbox="allow-scripts"` 中运行，通过受控 `host.*` API 与宿主交互。

插件沙箱不能直接访问：

- `Android` 原生桥；
- 宿主 DOM、宿主 localStorage 和其它 WebView 对象；
- 其它自定义插件；
- 用户文件、模型 API Key、Cookie 或宿主插件私有存储。

## 2. Manifest v1

最小结构如下：

```json
{
  "manifestVersion": 1,
  "apiVersion": "0.1",
  "id": "com.example.text",
  "name": "文本工具",
  "version": "1.0.0",
  "permissions": [],
  "tools": [
    {
      "name": "text_length",
      "description": "统计输入文本字符数并返回 characters。",
      "permissions": [],
      "parameters": { "type": "object", "properties": { "text": { "type": "string" } } },
      "kind": "js",
      "code": "async function run(args){return {characters:String(args.text||'').length};}"
    }
  ]
}
```

插件级 `permissions` 是最大能力集合，工具级 `permissions` 只能缩小集合，不能增加插件级未声明的能力。HTTP 工具必须声明 `network.public` 或 `network.local`。

## 3. 权限和执行门禁

执行顺序为：

```text
Manifest 校验
  -> 安装确认
  -> 危险插件默认停用
  -> 用户启用并授权
  -> 工具开关和插件状态检查
  -> Android 权限 / Agent 等级 / 安全开关 / 白名单检查
  -> 文件操作逐次确认
  -> 工具执行
```

当前能力包括：

| 权限 | 宿主限制 |
|---|---|
| `network.public` | 仅 HTTP/HTTPS 公网地址 |
| `network.local` | 需要安全开关；阻止危险协议和未授权本机地址 |
| `system.open_url` | 只能打开经过 URL 校验的系统链接 |
| `clipboard.write` | 只提供写入，不提供后台读取 |
| `storage.plugin` | 仅当前插件命名空间 |
| `files.public.read` | 受公共存储路径和 Android 权限限制 |
| `files.public.write` | 写入、复制、建目录前每次确认 |
| `files.public.delete` | 删除前每次确认 |
| `workspace.read/write` | 工作区路径和 Agent 策略限制；修改前每次确认 |
| `device.read` | 受 L1、无障碍和白名单限制 |
| `device.screenshot` | 受 L2、截屏能力和用户策略限制 |
| `device.action` | 受 L3、安全开关、白名单和设备策略限制 |
| `memory.read/write/delete` | 记忆策略限制；删除仍需用户确认 |

清单中的声明不是授权。即使用户已经启用插件，文件修改仍不会变成永久授权。

## 4. 工具执行结果

为保持与既有工具调用兼容，结果保留 `success` 字段；插件失败时同时提供 `errorCode`：

```json
{
  "success": false,
  "errorCode": "PERMISSION_DENIED",
  "error": "插件工具权限未获用户授权",
  "details": null
}
```

常见错误码：

- `PLUGIN_NOT_FOUND`
- `PLUGIN_DISABLED`
- `PLUGIN_QUARANTINED`
- `PERMISSION_DENIED`
- `NETWORK_PERMISSION_DENIED`
- `INVALID_URL`
- `NETWORK_ERROR`
- `HTTP_ERROR`
- `SANDBOX_UNAVAILABLE`
- `SANDBOX_INIT_ERROR`
- `PLUGIN_RUNTIME_ERROR`

HTTP 响应状态不在 200 至 399 范围时返回 `HTTP_ERROR`。工具超时、沙箱初始化失败和运行期异常不会被伪装成成功结果。

## 5. Host API

JS 工具可以使用：

```js
await host.request({ method: 'GET', url, headers, body, timeout });
await host.callTool('external_file_read', { path, max_chars: 120000 });
await host.toast('完成');
await host.openUrl('https://example.com');
await host.clipboard.write('text');
await host.storage.get('key');
await host.storage.set('key', value);
await host.log({ phase: 'done' });
```

`host.callTool` 只能调用已声明且已授权的内置能力，不能调用其它自定义插件。文件和设备能力仍由宿主再次检查。

## 6. 插件状态与生命周期

宿主保存以下插件状态：

- `installed`：已安装；
- `disabled`：用户停用或权限未满足；
- `quarantined`：预留给完整性或撤销状态异常的隔离状态；
- `source`：用户导入、本地市场或远程市场；
- `trust`：来源标签，不是安全保证；
- `reviewStatus`：索引提供的公开审核状态；
- `contentHash`：远程清单安装时校验的 SHA-256；
- `invokeCount`、`invokedAt`：调用统计，不保存调用参数。

当前生命周期操作为安装、启用、停用、调用和卸载。宿主为这些操作写入有限长度的审计记录，记录插件 ID、工具名、来源和时间，不记录文件内容、网络请求体或用户消息。插件代码没有自动 `onInstall`、`onEnable` 等回调，避免安装时执行隐蔽代码。

## 7. 市场索引

应用包含 APK 内置本地市场，也支持用户主动同步远程只读 `index.json`：

1. 地址必须是 HTTPS 公网地址；
2. 索引必须为 `indexVersion: 1`；
3. 每个条目必须有插件 ID、版本、HTTPS Manifest 地址和 SHA-256；
4. 同步只缓存公开元数据，不自动安装；
5. 安装时重新获取 Manifest；
6. 校验 SHA-256、Manifest、ID 和版本一致性；
7. 用户确认后才保存插件；
8. 危险插件仍停用，必须再次授权才能启用。

当前默认地址为：

```text
https://raw.githubusercontent.com/xysy92ds/ElysiaFloat/main/marketplace/index.json
```

哈希校验只证明下载内容与索引内容一致，不代表代码安全。当前还没有独立签名根、撤销服务和远程审核服务，因此远程条目默认显示为未审核或来源标签，不能将其视为官方安全背书。

## 8. 市场审核的后续边界

后续若增加签名和审核，应保持以下分层：

- 索引层：公开元数据、版本、权限、来源、审核状态、哈希和撤销状态；
- 制品层：HTTPS 只读获取、签名验证、哈希校验和版本兼容性；
- 审核层：Schema、依赖、静态扫描、权限最小化、人工复核和撤销；
- 客户端层：安装、启用、危险权限、工具调用和文件逐次确认独立存在；
- 更新层：默认关闭、用户确认、版本锁定、回滚和卸载。

审核通过、签名有效或哈希匹配都不能替代用户对插件代码和权限的判断。
