# ElysiaFloat 插件市场目录

本目录是插件市场的公开源文件。它同时作为 APK 内置本地索引和远程只读索引的源目录。

## 目录结构

```text
marketplace/
├── README.md
├── index.json
├── schema/
│   ├── manifest-v1.json
│   └── index-v1.json
└── plugins/<plugin-id>/
    ├── manifest.json
    └── README.md
```

## 当前索引协议

`index.json` 使用 `indexVersion: 1`，每个插件条目提供：

- `id`、`name`、`version`、`author`；
- `manifest` 和 `docs` 路径；
- `permissions`；
- `trust` 和 `reviewStatus`；
- Manifest 文件的 SHA-256。

应用默认从 GitHub Raw 读取公开索引，但只在用户主动点击“同步”后读取；同步只缓存元数据，不自动安装或执行任何代码。安装时重新下载 Manifest，并校验 HTTPS 地址、Manifest Schema、插件 ID、版本和 SHA-256。

## 安全与信任

市场索引不是权限授予。安装、启用和调用是三个独立步骤：

- **安装**：解析和保存清单，危险插件默认停用；
- **启用**：展示权限风险，用户明确授权后启用；
- **调用**：再次检查插件状态、权限、Android 条件、Agent 策略、安全开关、白名单和逐次确认。

第三方插件可能包含代码错误、隐私泄露、数据损坏、恶意网络请求或其它风险。索引来源、信任标签、审核状态和 SHA-256 只提供来源与完整性信息，不构成安全保证或作者背书。不要向插件提供密码、API Key、Cookie、身份凭据或不必要的个人数据。

## 提交要求

市场插件必须：

1. 使用 Manifest v1 和兼容的 `apiVersion`；
2. 声明最小插件级和工具级权限；
3. 为每个工具说明输入、返回值、错误和隐私影响；
4. 提供 `manifest.json` 和 `README.md`；
5. 不保存 Token、Cookie、设备路径和用户数据；
6. 通过清单校验、工具名冲突检查、沙箱语法检查和 SHA-256 生成；
7. 在索引中记录来源、审核状态和内容摘要；
8. 不以“审核通过”或“哈希匹配”宣称插件绝对安全。

## 当前示例

`plugins/com.elly.market.text-tools/` 是无外部权限的文本统计示例。它不访问网络、文件、设备、记忆或剪贴板，用于验证安装、沙箱执行和工具返回流程。

## 后续市场能力

独立签名根、撤销服务、自动审核、人工审核责任、自动更新和版本回滚尚未作为服务部署。客户端已预留来源、信任、审核、哈希和隔离状态字段，但不会把这些字段当作安全授权。
