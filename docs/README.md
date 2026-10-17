# ElysiaFloat 当前技术文档

本文档描述仓库中当前实现的应用组件、策略、权限、能力、接口、约束、验证和生命周期。版本历史单独放在 `docs/history/`，不把历史更新混入当前使用说明。

## 应用组件

- **FloatService**：管理悬浮窗、状态胶囊、音乐迷你条、翻译覆盖层和 WebView；
- **JsBridge / PermissionBridge**：提供持久化、网络、权限、文件、Agent、截图和系统操作接口；
- **WebView 应用**：聊天、设置、记忆、翻译、音乐、插件和工作区界面；
- **AgentPolicy**：对 Agent 等级、安全开关、白名单和高风险行为进行原生门禁；
- **插件宿主**：解析清单、注册工具、校验权限、执行 HTTP/JS 工具并保存插件状态；
- **本地/远程市场索引**：本地索引随应用提供，远程索引仅用户主动同步，安装前校验清单和 SHA-256。

## 当前文档

- [上手教程](user-guide/tutorial.md)
- [Agent 与文件访问](user-guide/agent-and-files.md)
- [权限与策略模型](security/permission-model.md)
- [插件系统与市场](development/plugin-system.md)
- [本地市场目录与索引协议](../marketplace/README.md)
- [插件开发手册](../marketplace/PLUGIN_DEVELOPMENT.md)
- [Manifest v1 Schema](../marketplace/schema/manifest-v1.json)
- [0.6.5 更新说明](history/0.6.5.md)
- [0.6.2 发布验收清单](release/0.6.2-checklist.md)
- [0.6.1-agent 历史清单](release/0.6.1-agent-checklist.md)

## 验证状态

0.6.5 已通过本地 WebView 冒烟测试（覆盖请求层、任务状态机、文件导出与预览、权限分级、记忆整理、插件沙箱等）与 Debug 构建（0 错误）。

已确认可用：对话、工作区读写、多格式文件解析与导出、记忆整理、音乐播放与缓存、任务内发送与任务继续。

仍需真机补充：不同厂商 ROM 的长按选区、全屏模式、大量文件时的预览性能、Termux/Root/外部 Agent 的完整运行时。

> 详细验收项见 [`docs/history/0.6.5.md`](history/0.6.5.md) 第五节的验证状态。

## 发布与凭据

当前 0.6.5 为本地测试版本（Debug 签名），发布包与校验值见 [`release/0.6.5/`](../release/0.6.5/) 与 [`release/latest.json`](../release/latest.json)。正式分发仍需独立签名方案、真机验收和发布参数确认。GitHub Token、模型 API Key、Cookie、设备信息和用户数据不得写入仓库或构建产物。

版本历史：

- [0.6.5](history/0.6.5.md)
- [0.6.2](history/0.6.2.md)
- [0.6.1-agent](history/0.6.1-agent.md)
