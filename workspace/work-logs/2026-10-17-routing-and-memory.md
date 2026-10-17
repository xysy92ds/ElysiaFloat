# 工作记录：发送路由跳页、记忆自动整理

日期：2026-10-17
状态：两项已修复；smoke + 构建通过

## 1. 在任务里点发送会跳到聊天页、消息发不出去

### 根因

`send()` 用 `taskRouteText()` → `classifyTask()` 做**纯关键词**分类：

```js
if (/整理文件|工作区|批量|…/.test(s)) return 'workspace';
if (/打开|点击|输入|…/.test(s)) return 'device';
return 'chat';          // ← 绝大多数普通句子都落到这里
```

于是处于「工作任务」或「手机任务」时，只要发一句普通文字，就被判成 `chat` →
`routeTask('chat')` → `taskSetCurrent(chat)` → `showView('chat')`：
**页面跳走**，而且后续消息都进了聊天任务，工作区里当然"发不出去"。

### 修复

`send()` 里增加持久任务保护：

```js
const cur = currentTask();
let routeType = taskRouteText(t, att);
const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device') && cur.state === 'active';
if (inPersistent && routeType === 'chat') routeType = cur.type;   // 留在当前任务
```

- 处在工作/手机任务时，普通文字**留在当前任务**，不再跳页；
- 明确的屏幕快捷指令（翻译/总结/要点/解释）仍走 quick；
- 明确的任务关键词（"打开微信"、"整理文件"）仍会切到对应任务；
- 聊天任务里行为不变。

## 2. 长期记忆不增长

### 根因

`MEMCFG.autoSummary = true` 从很早就存在，但**从来没有任何代码触发它**：
既没有消息计数，也没有自动调用；手动入口 `#mem-sum` 只在「记忆库」页面里，
聊天界面的「更多」菜单里没有。

所以实际表现就是：聊很久记忆库也不增长。

### 修复

1. **自动整理**
   - 新增 `memAutoTick()`：每成功回复一条就 +1，到达阈值（默认 **50**）时返回 true 并清零；
   - 状态存 `via_ai_mem_auto_state`（`since / lastAt / running`），重启不丢；
   - `send()` 在完成回复后调用，命中则 600ms 后执行 `memSummarize({ auto: true })`；
   - `running` 标记防止并发重复整理。
2. **手动整理**
   - 聊天输入框上方「更多」菜单新增 **总结记忆**（`data-key="mem_sum"`），
     与「要点 / 解释 / 清空」并列；
   - `handleQuickAction('mem_sum')` 调到 `memSummarize()`（带确认）。
3. **`memSummarize` 支持 auto 模式**
   - `auto: true` 时跳过确认弹窗、允许在发送流程里后台执行；
   - 结束（无论成功失败）都会清掉 `running` 并记 `lastAt`；
   - 自动模式提示文案为「已自动整理记忆：现在共 N 条」，与手动区分。
4. **设置项**
   - 新增「自动整理长期记忆」开关（默认开）；
   - 新增「每多少条消息整理一次」（10~500，默认 50）；
   - 保存时写入 `MEMCFG.autoSummary / summaryEvery`，并清掉临时字段，不污染 CONFIG。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过（新增用例）
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增用例 `发送路由留在当前任务 + 记忆自动整理`：

- 工作区任务里 `chat` 路由被改写为 `workspace`；设备任务里改写为 `device`；
- 源码里确实存在该判定（防止只测了副本逻辑）；
- 阈值 10 时，10 次 tick 只触发 1 次；
- 关闭自动整理后不再触发；
- 「更多」菜单含 `data-key="mem_sum"`，且 `handleQuickAction` 有对应分支；
- `memSummarize` 支持 `{auto:true}`，`send()` 已接入。

## 测试包

```text
apk/phases/ElysiaFloat-routing-memory-debug.apk
apk/phases/ElysiaFloat-routing-memory-debug-SHA256SUMS
```

SHA-256：`c0f352a4b3106cf38ea4c86bfe1cbe0f689acc4c6033b188289a4e36e7bb6ca6`

## 真机待确认

- 工作区里发普通消息是否留在工作区、能正常回复；
- 聊天「更多 → 总结记忆」是否出现并可执行；
- 自动整理到 50 条是否触发（想快点验证可把阈值调到 10）。
