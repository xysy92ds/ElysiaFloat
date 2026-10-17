# 工作记录：G2 完整复核与插件/Agent 工具面板收尾

日期：2026-10-16
状态：本地代码、自动验证和 Debug 构建通过；真机运行时验证仍需用户设备确认

## 复核发现

用户反馈插件和音乐工具没有在配置面板中落实。本轮重新从源码、生成的 `index.html`、工具 Schema、提示词组装、插件面板渲染和权限映射逐层核对，确认并修正以下问题：

- 内置音乐组虽然存在，但 Agent tools Schema 没有用同一组开关条件包住音乐工具；单项关闭时提示词/Schema 可能不一致；
- 音乐插件权限 `music.control` 已加入，但之前没有用自动测试验证面板、Schema、提示词三者一致；
- 插件面板的内置音乐组现在显示工具数量和明确的音乐总开关状态提示；
- Agent 构建工具、插件配置面板和 `buildToolsPrompt()` 现在都受同一组 `plugOn('music')`、`CONFIG.musicEnabled`、`CONFIG.toolOff` 条件控制；
- 设置页已经只保留 `保存设置`，不存在悬浮保存按钮；
- 保存按钮使用 `type=button` 和可靠点击处理；
- 插件自定义工具继续显示在面板，启用、停用、工具开关、危险权限授权和删除都保留原有保护。

## G2 收尾验证

覆盖的逻辑：

- ChatSession / QuickOperation / AgentTask 显式运行上下文；
- 长任务默认 1200 秒，最大设置 7200 秒；
- 工具轮数 0 表示按任务时间；
- 任务状态合法迁移；
- 活动任务取消模型请求；
- 插件网络/JS 沙箱按 taskId 绑定；
- 插件沙箱取消；
- 截图等待取消；
- 内置音乐、读屏、文件、设备和记忆工具的权限分层；
- `music.control` 权限和音乐工具面板；
- Agent 工具 Schema、提示词和开关一致；
- 设置保存按钮结构；
- 运行令牌拒绝迟到回调。

## 自动验证

```text
node tools/build-html.js --check  通过
node tools/smoke.js               全部通过
git diff --check                  通过
./build.sh assembleDebug          成功
```

本轮 smoke 新增/修正验证：

- 音乐工具组在配置面板可见；
- `music.control` 映射存在；
- 音乐工具进入 Agent tools Schema；
- 音乐工具进入 Agent 提示词；
- 单项关闭不会误伤同组其它工具；
- 关闭单项后提示词同步消失；
- 设置保存按钮结构可用。

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-final-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-final-debug-SHA256SUMS
```

SHA-256：

```text
83f5468c28c5d6a8343a45958719f74759151ddebf666331fd27a6b75c2e8506
```

## G2 的边界说明

自动验证已经闭环，但以下仍然不能仅靠静态/smoke 声称完成：

- 真机实际打开插件配置面板并看到音乐组；
- 真机点击保存设置并重启后确认配置持久化；
- 真机启用/关闭音乐组和单项工具后进行真实模型请求；
- 真机长任务暂停、恢复、停止；
- Termux 子进程和 Root 操作的真实取消；
- 真机安装一个带 `music.control` 或 `device.read` 的第三方插件并验证授权拒绝/允许路径。

这些属于设备验收，不再隐藏在“代码完成”状态中。
