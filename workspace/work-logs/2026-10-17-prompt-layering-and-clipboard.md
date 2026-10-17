# 工作记录：提示词分层、工具调用泄漏过滤、工作区免确认、复制粘贴

日期：2026-10-17
状态：四项完成；smoke 51 项全绿；构建通过

## 1. 提示词重新分层

### 结构（`02-config.js` 新增常量）

| 段 | 内容 | 注入条件 |
|---|---|---|
| `PROMPT_CORE` | 系统规则 + 输出纪律（不写 JSON/不复述参数/不编造/安全优先） | **永远第一段**，不含人设 |
| `PROMPT_WORK` | 标准 Agent 工作协议：目标 → 计划 → 执行 → 验证 → 交付 + 硬性要求 | 工作/设备/外部任务 |
| `PROMPT_WORK_TONE` | 汇报语气：只影响措辞，不影响判断与完整性；冲突时以工作协议为准 | 工作模式，排在协议之后 |
| `PROMPT_CHAT_OUTPUT` | 对话风格 | 聊天模式 |

### 组装顺序（`composeSystemPrompt`）

```
聊天：PROMPT_CORE → 人设原文 → PROMPT_CHAT_OUTPUT → [Agent 段] → 工具段 → 上下文
工作：PROMPT_CORE → PROMPT_WORK → 工作偏好 → PROMPT_WORK_TONE + 人设参考 → [Agent 段] → 工具段 → 上下文
```

要点：
- 人设在**工作模式里只作为"人设参考"**出现在汇报语气段，且明确"冲突时以工作协议为准"；
- 工作协议强调**完整性优先**（宁可多验证一步，不留半成品）、**最小改动**（不顺手重构）、
  **不编造**（没读到的不描述、没跑成的不报成功）、**受阻就停**；
- 顺手去掉了工作偏好被注入两次的重复。

## 2. 工具调用泄漏 / 乱码不再进聊天

新增 `cleanAssistantText()`（`00-compat.js`）+ `stripToolJsonSpans()`：

- 删除 `<tool_calls>` / `<function_call>` / `<|tool_call|>` 整块；
- 删除内容像工具调用的围栏代码块（`{"name":...,"arguments":...}`）；
- 用**括号配对扫描**摘掉正文里夹带的 JSON 工具调用（避免正则误伤普通括号文字）；
- 删除 `<|...|>` 特殊 token、`<tool>`/`<result>` 之类伪标记；
- 清除 U+FFFD、控制字符、零宽字符。

渲染侧：
- `makeMsgEl` 对 assistant 正文统一清洗；
- `addMsg` 清洗后为空 → **不生成气泡**（"正在执行 xx"的状态小字已经在说明进展）；
- `live.onText` 同样过滤，避免流式输出把伪代码打上屏。

提示词侧也加了约束（`PROMPT_CORE` 第 1 条）：工具只通过 function call 提交，正文不写 JSON、不复述参数。

## 3. 工作区内写入免确认（回顾 + 收尾）

- `workspace_write` / `workspace_mkdir` 不再弹确认；写入后写 `workspace_write` / `workspace_mkdir` 任务事件便于回溯；
- `workspace_create` 在已是工作任务时不再二次确认（进入任务模式时已确认过）；
- **工作区外**的 `external_file_write / copy / mkdir / delete` 仍然逐次确认；
- 安全性没变：原生侧 `workspaceFile()` 用 canonical 路径 + `..` 拒绝，写入锁死在任务工作区内；
- 提示词、工具描述、设置页说明三处文案同步更新。

## 4. 复制 / 粘贴

之前 WebView 里长按选中不稳定、`navigator.clipboard` 常被禁用，导致复制 AI 文本和粘贴都很困难。

- **每条消息加「复制」按钮**：走原生 `Android.setClipboard`，失败时回退 `navigator.clipboard` 再到 `execCommand`；
  复制成功按钮短暂变「已复制」；
- **消息正文允许选中**：`.msg .msg-body{user-select:text;-webkit-touch-callout:default}`，
  按钮绝对定位不挡文字；
- **输入区加「粘贴」按钮**：`pasteIntoField()` 把剪贴板内容插入**光标位置**（不是简单追加）；
- 粘贴里对 `Event` 构造做了兜底（部分 WebView/沙箱没有），避免整个粘贴因一行报错而失败。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                51 项全部通过
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增用例：

1. `提示词分层 + 工具调用泄漏过滤 + 工作区免确认`
   - 聊天模式：首段是系统规则、含人设、无工作协议；
   - 工作模式：首段系统规则、协议在语气段之前、人设只出现在"人设参考"、含不编造与 function call 纪律；
   - 5 组清洗用例（纯文字原样、tool_calls 块、围栏 JSON、混合文本、乱码）；
   - 只剩工具调用时不插入气泡；
   - 工作区写入不弹确认、外部写入必须弹确认。
2. `复制粘贴可用性`
   - 气泡上有复制按钮且写入内容正确；
   - `.msg-body` 允许选中；
   - 输入区粘贴按钮存在，且插入到光标处（`AB` + 光标在中 → `A粘贴…B`）。

## 测试包

```text
apk/phases/ElysiaFloat-prompt-clipboard-debug.apk
apk/phases/ElysiaFloat-prompt-clipboard-debug.SHA256SUMS
```

SHA-256：`c6b8e7d84c4269b6479ebb02b3858fed694bfeb6de57d5b5df4c6140a2545259`

## 真机待确认

- 工作模式下：是否先给计划再动手、结束时是否给出"完成情况/产物路径/关键变更/未完成项"；
- 是否还会在正文里出现 JSON 或"准备调用工具"的伪代码；
- 每条消息的「复制」按钮、输入区「粘贴」按钮是否好用；
- 工作区里连续写文件是否真的不再弹确认，而工作区外仍会弹。
