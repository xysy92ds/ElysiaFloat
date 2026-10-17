# 工作记录：记忆策略、公共存储文件和插件市场

日期：2026-10-06
状态：实现、构建和文档准备完成；尚未上传。

## 记忆系统修改

修改文件：`app/src/main/assets/index.html`

- 总结任务提示改为以 `save_memory` 新增为默认。
- 明确类别相同不构成合并条件。
- 增加正文相似度判断：完全相同、包含关系或高二元组相似度才进入合并路径。
- `save_memory` 在高度相似时保留原内容并追加新内容；相似度不足时创建新记忆。
- 相同标题但内容不同不再直接拒绝，允许创建新的记忆。
- `update_memory` 默认采用追加模式；不相似时拒绝并建议使用 `save_memory`；只有 `replace=true` 才执行覆盖式修订。
- 总结任务向模型提供已有记忆的正文摘要，而不是只提供标题。
- 增加记忆策略冒烟测试。

## 公共存储文件访问

修改文件：`PermissionBridge.kt`、`index.html`、相关文档。

新增：

- `external_file_list`
- `external_file_read`
- `external_file_write`
- `external_file_copy`
- `external_file_mkdir`
- `external_file_delete`

约束：

- 需要“允许管理所有文件”；
- 需要 Agent L3 和安全开关；
- 仅允许 Android 公共外部存储根目录下的路径；
- 写入、覆盖、复制、创建目录和删除前由 WebView 弹窗逐次确认；
- 确认只对本次操作有效；
- 仍不能访问其它应用的 Android 私有目录。

## 文档结构

新增顶层技术文档目录：

```text
docs/
├── README.md
├── release-notes/0.6.1-agent.md
├── user-guide/agent-and-files.md
├── security/permission-model.md
├── development/plugin-system.md
└── release/0.6.1-agent-checklist.md
```

新增发布候选包目录：

```text
release/0.6.1-agent/
├── ElysiaFloat-0.6.1-agent-debug.apk
├── SHA256SUMS
└── README.md
```

文档术语已改为技术表达，区分 Agent、目标应用、白名单、工作区和公共存储文件接口。插件文档增加了 AstrBot 类框架可借鉴的扩展协议、能力声明、生命周期、事件和错误模型设计，但未直接复制其实现。

新增 `marketplace/` 本地插件市场源目录：包含索引、Manifest Schema、开发手册和无外部权限示例插件。插件现在必须声明权限；安装、启用和调用分离，危险能力仍受用户授权、Android/Agent 原生策略和逐次修改确认限制。

## 构建与测试

构建：

```text
cd /workspace/EllyFloat && ./build.sh assembleDebug
```

结果：成功。

冒烟测试：

```text
cd /workspace/EllyFloat && node tools/smoke.js
```

结果：全部通过，包括记忆新增/相似追加合并测试。

APK SHA-256：

```text
6bd80688849287a5266b9d49a15d3cacc779c439dfd6b2f81fb595453201740a
```

## 上传状态

未上传。等待用户提供上传平台、凭据，并确认使用 Debug APK 还是重新生成 Release APK。
