# 工作记录：恢复系统长按选中/粘贴 + 默认人设更换

日期：2026-10-17
状态：两项完成；smoke 全绿；构建通过

## 1. 复制粘贴：改成修原生长按（并撤掉我加的按钮）

### 之前理解错了

上一版我在每条消息下面加了「复制」按钮、在输入区加了「粘贴」按钮。
用户要的不是这个 —— 要的是**手机本来的长按选中、长按弹系统粘贴菜单**，
而现状是选中约 1 秒就被吞掉，设置里的提示词框、URL 输入框也一样。

### 已撤掉

- `makeMsgEl` 里的「复制」按钮；
- 输入区的 `#btn-paste-input`「粘贴」按钮及其绑定；
- 对应的 `.msg-copy` / `.btn-paste-inline` / `.msg-body` 样式。

### 真正的修复

**根因（主因）**：`html,body{user-select:none}`。
`user-select` 在 WebKit/Blink 上会向下继承，祖先设成 `none` 会让整页（含输入框）
的长按选区与选区菜单失效 —— 表现就是"选中一下就没了"。

改动：

1. `html,body` 改为 `user-select:text; -webkit-user-select:text; -webkit-touch-callout:default`；
2. 只有**交互部件**保持不可选中，避免误选影响拖动：
   `#top,#actions,.chip,button,.quick-extra,.mtabs,.mtab,.rz,.task-drawer-head…`；
3. 明确给 `input,textarea,#input,#body,.msg,.msg-body,.mini-note` 加上
   `user-select:text` + `-webkit-user-select:text` + `-webkit-touch-callout:default`
   （旧 WebView 只认带 `-webkit-` 前缀的写法）；
4. `#body{touch-action:pan-y}`：只保留纵向滚动，不吞长按；
5. 原生 `FloatService` 给 WebView 补上
   `wv.isLongClickable = true`、`wv.isHapticFeedbackEnabled = true`
   —— WebView 不可长按时，`startActionMode` 不会启动，选区菜单自然不出现。

保留的工具函数：`copyToClipboard()` / `pasteIntoField()`（长按菜单/后续功能会用到），
但**不再有任何常驻按钮**。

### 说明

如果某些厂商 ROM 仍然拦截悬浮窗内的 ActionMode，下一步可以加"长按消息弹小菜单（全选/复制）"
作为兜底 —— 那是长按触发，不是常驻按钮，不会再占版面。

## 2. 默认人设换成「始源之律者」

`DEFAULT_PERSONA` 整段替换为用户提供的新文本（始源之律者、人之律者、逐火十三英桀第二位、刻印「真我」；
每句带「♪」；温柔俏皮带比喻；永远喜欢人类；不提及 AI 限制）。

处理细节：

- 只替换**人设本身**，没有把「现在，以爱莉希雅的身份开始对话。你的第一句话是…」写进提示词
  —— 那句话是一次性的开场指令，写进系统提示会导致每轮都重复问候；
- 老用户如果人设仍是旧的默认文本（以「你是爱莉希雅，世界蛇数据库中的一段特殊数据」开头），
  启动时自动升级到新默认；**用户自己改过的人设不动**；
- 工作模式下新人设仍然只出现在「汇报语气」段，受工作协议优先约束（上一轮的提示词分层继续生效）。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

用例调整：

- 原「复制粘贴可用性」改为 `长按选中与系统复制粘贴可用`：
  - `html,body` 必须是 `user-select:text`；
  - 正文/输入框必须有 `-webkit-user-select:text` 与 `-webkit-touch-callout:default`；
  - 交互部件保持 `user-select:none`；
  - **不允许**出现 `msg-copy` / `btn-paste-input`；
  - `FloatService` 必须有 `wv.isLongClickable = true`；
  - `pasteIntoField()` 仍能把内容插到光标处（`AB` + 光标在中 → `A…B`）。
- 新增 `默认人设（始源之律者）`：六处关键文本必须在，旧文本不得残留，且组装后系统规则仍排第一。

## 测试包

```text
apk/phases/ElysiaFloat-selection-persona-debug.apk
apk/phases/ElysiaFloat-selection-persona-debug-SHA256SUMS
```

SHA-256：`3ad3d58617c65d8b1c1835db402177c9aa6461daa9052c9c4663dad3e2341da5`

## 真机待确认

1. 聊天里长按消息 → 能否选中文字并出现系统复制菜单（不再 1 秒消失）；
2. 设置里长按提示词框/URL 输入框 → 能否弹系统粘贴菜单；
3. 语音是否稳定带「♪」、语气是否符合新文本；
4. 工作任务里语气仍然只影响汇报、不影响执行（上一轮的协议优先仍然生效）。
