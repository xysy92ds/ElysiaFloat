# ElysiaFloat 0.6.1-agent 发布候选包

## 文件

- `ElysiaFloat-0.6.1-agent-debug.apk`：Debug 构建，仅用于测试
- `SHA256SUMS`：SHA-256 校验值
- 项目源码中的 `marketplace/`：本地插件市场索引、清单 Schema、开发手册和示例插件

## APK 信息

- 包名：`com.elly.assistant`
- versionCode：`11`
- versionName：`0.6.1-agent`
- 签名：Debug 签名

## 文档

完整文档位于项目根目录的 `docs/`：

- `docs/release-notes/0.6.1-agent.md`
- `docs/user-guide/agent-and-files.md`
- `docs/security/permission-model.md`
- `docs/development/plugin-system.md`
- `docs/release/0.6.1-agent-checklist.md`

## 插件市场状态

APK 内置本地市场入口和一个无外部权限的文本处理示例。完整市场源文件位于项目 `marketplace/`，当前未配置远程索引，也未上传。

## 上传状态

当前仅完成本地构建和校验，尚未上传。上传前必须确认：

1. 是否使用 Debug APK 还是重新生成 Release APK；
2. 上传平台；
3. 上传凭据；
4. 发布标题、正文和可见范围。
