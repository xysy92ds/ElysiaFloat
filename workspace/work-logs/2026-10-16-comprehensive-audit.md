# 工作记录：最新版问题综合审计

日期：2026-10-16
状态：审计和文档整理完成；本轮未修改功能代码、未构建新 APK、未提交 Git。

## 用户反馈

1. 音乐缓存失败，提示 302；缓存文件没有用户可见位置；希望参考 rcMusic 重构 API 和调用体系。
2. 全屏仍然只是放大悬浮窗，不是真正只显示本应用的全屏。
3. 任务切换、任务聊天上下文、清除上下文语义混乱。
4. 翻译被当作任务；任务没有长按删除。
5. “更多”打开后空白；清除上下文按钮不够明显。
6. 屏幕总结持续不可用。
7. 个性化与聊天人设在设置中的位置/显示异常。
8. 普通用户功能整体需要继续优化。

## 代码审计结论

- 音乐缓存代码位于 `JsBridge.kt`，当前只接受 200～299，写入 App 私有 `filesDir/music-cache`，没有最终媒体校验和公共索引；音乐 URL 来自 GD Studio/Meting/网易兜底，多来源没有统一下载层。
- 全屏当前运行在 `TYPE_APPLICATION_OVERLAY`，`FLAG_FULLSCREEN` 对 overlay 不等同于 Activity 全屏；需要 `FullscreenActivity` 才能满足用户“屏幕只有本应用”的要求。
- 任务上下文同时使用全局 `via_ai_history`、任务历史键和 `TASKS[].context.messages`；设置/插件/记忆等多个路径仍直接写全局历史。
- `doTranslateScreen()` 明确调用 `taskBegin('quick', ...)`，导致翻译进入持久任务舱；应改为临时 `QuickOperation`。
- 当前任务舱没有长按、删除和归档交互。
- `handleQuickAction()` 的总结/要点/解释要求 `hasA11y() && agentReadOn()`；`agentReadOn()` 要求 Agent 总开关，原生读屏还要求 L1 AgentPolicy，导致普通助手屏幕总结被 Agent 门禁阻断。
- `renderSettings()` 中外观和自定义聊天人设使用 `sub-title`，`organizeSettingsSections()` 只识别 `sec-title`，因此它们被归到前一个正式分区“屏幕翻译”中，折叠后看似消失。
- “更多”按钮代码存在，但菜单位于悬浮窗头部的绝对定位容器中，当前缺少真机 UI 回归和清晰的独立面板；用户看到空白需要 P0 重做而不是继续堆按钮。
- `clearAll()` 会调用 `localStorage.clear()`，会清除全部任务和任务历史；普通当前任务清除还存在若干旧的全局写入路径，需要统一语义。

## 文档产物

- 综合问题审计：`workspace/issues/2026-10-16-comprehensive-audit.md`
- Agent 统一任务看板：`workspace/plans/agent-task-board.md`
- 当前总规划需以本次审计的 P0～P6 顺序更新和执行。

## 下一步

先做 P0：

```text
任务/上下文隔离
→ QuickOperation
→ 普通助手一次性读屏
→ 更多菜单和清空入口
→ 个性化设置归位
→ 任务长按删除/归档
```

音乐和真正全屏分别进入 P2/P3，不在本次审计中假称已修复。
