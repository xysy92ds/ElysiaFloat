# DEC-005：开放式插件运行时

日期：2026-10-28
状态：已确认（0.8 N5，0.10 / 0.11 实现依据）
关联：`plans/PLATFORM-0.8-0.15.md` 第 5 节 E3 / E4

## 问题

如果宿主只提供写死的扩展点（主题、会话、选项），插件就只能从固定清单里挑，
无法创造宿主没有的功能。这与「开放生态、人民群众发挥创造力」的目标冲突。

## 决定

宿主只提供五类**原语**，不预设插件类型：

```text
Surface   插件可注册的挂载面（page / entry / sessionType / command / event / job / settings / renderer / adapter）
Component 结构化组件树（layout / text / stat / button / input / select / list / table / image / progress / chart / tabs / modal / choice / form / divider / spacer）
Action    受控动作（navigate / plugin.call / config.set / state.set / session.create / session.delete / message.send / theme.apply / confirm / openUrl / clipboard.write / job.schedule / dependency.install / custom）
Event     统一事件总线（message / session / schedule / dependency / task / gateway）
Adapter   适配器注册（模型 / 网关 / 文件 / 媒体；0.15 开放实现）
```

规则：

1. **插件零宿主改动**：新增页面、入口、会话类型、命令、后台任务不需要发版。
2. **声明式优先**：0.10 / 0.11 的插件 UI 只能是组件树 + 样式令牌，
   不允许注入 HTML/CSS/JS 到宿主；0.15 才开放独立 WebView 沙箱 HTML。
3. **未知组件降级**：宿主不认识 `component.type` 时渲染占位，不阻塞整页。
4. **动作即权限**：每个 surface / action 绑定权限，由宿主校验后执行。
5. **会话隔离**：插件只操作自己的命名空间；会话创建/删除/清理由宿主负责。
6. **默认可回滚**：主题、专属会话、后台任务都能单独关闭、重置、卸载清理。

## 验收样例（不是能力上限）

1. 主题插件：任意背景图 + 配色/圆角/字号组合，可预览、可重置。
2. 恋爱游戏插件：创建可删除的专属会话，AI 每轮换背景、渲染 A/B/C + 自定义输入。
3. 陌生功能插件：番茄钟 + 专注统计页 + 聊天头部计时器 + 定时提醒，宿主零改动。

## 出口

0.10 出口：插件能注册宿主没写过的新页面/入口/会话/命令/后台任务，宿主代码不变。
0.11 出口：上述三个样例全部通过，单插件崩溃不影响聊天。
