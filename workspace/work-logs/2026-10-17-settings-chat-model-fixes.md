# 工作记录：设置按钮下移、主聊天唯一化、模型可用性检测

日期：2026-10-17
状态：三项已修复；smoke + 构建通过

## 1. 保存设置按钮再下移

- `.settings-bottom` 从 `sticky bottom:28px` 改为 **`sticky bottom:0`**，改用 `padding-bottom:24px`
  把按钮抬出 `.rz` 缩放热区（底边 14px、两角 22px，`z-index:60`）；
- 有效点击偏移 = `bottom(0) + padding-bottom(24)` = **24px > 22px**，是"贴底且仍可点"的极限位置；
- 底部占位块 40px → 26px，视觉上不再悬空；
- 阴影方向改为向上（`0 -4px`），贴底更自然；
- smoke 断言同步升级：从"只看 bottom"改为"bottom + padding-bottom 必须 > 22px"，
  以后谁把按钮改回贴死热区都会被拦。

## 2. 主聊天框越点越多且删不掉

### 根因

`12-send-quick.js` 在路由到聊天时调用 `taskBegin('chat', ...)`，
而 `taskBegin` 的逻辑是「当前任务类型不同就新建一个」——
于是每次从工作任务/手机任务切回聊天，都会**新增**一个聊天任务。

`deleteTask` 里又有 `if (t.type === 'chat') return toast('主聊天不能删除')`，
所以这些多出来的聊天框永远删不掉。用户机器上已经积了 3 个。

### 修复

- 新增 `chatTasks()` 与 **`taskEnsureChat()`**：
  - 永远只保留一个主聊天；
  - 若已存在多个，按创建顺序合并消息（去掉重复 system 消息，补一条当前 system prompt），
    保留当前正在用的那个，其余删除并清理其历史键；
- `taskBegin('chat')` 直接复用，不再新建、不重置预算；
- `#btn-chat-mode` 与 `routeTask('chat')` 都走 `taskEnsureChat()`；
- **启动自愈**：加载任务时若发现多个聊天任务，静默合并（用户的 3 个会自动变回 1 个，
  消息不丢）；
- `deleteTask`：聊天任务在**多于一个时允许删除**，只剩一个时提示"只能清空上下文"。

### 附带修掉的一个隐患

`TASKS = TASKS.filter(...)` 会把数组换成新对象，任何持有旧引用的地方（UI 闭包、测试）
都会看到陈旧数据 —— 合并后测试里仍显示 2 个聊天任务，就是这个原因。
已改为 **原地 `splice`**（合并聊天、删除任务两处），保持数组引用稳定。

## 3. 换模型看不到可用模型

### 新增：设置页「检测」按钮

- 位置：设置 → AI 与模型 → 模型 一行右侧；
- 点击后走统一 RequestManager 请求 `GET {apiBase}/models`（只读，不产生调用费用）；
- 地址兼容：`apiBase` 已含 `/v1` 直接拼 `/models`；否则依次尝试 `/models` 与 `/v1/models`；
- 成功：把模型列成可点的 chip，**当前模型高亮**，底部提示"共 N 个可用模型"；
- 点击 chip 填入模型输入框，再点保存；
- 失败：显示"检测失败：<友好文案>〔错误码〕"，例如 `HTTP 401〔AUTH_ERROR〕`。

### 实现细节

- 请求带 `source: 'system:models'`，纳入统一重试/超时/审计；
- 模型 chip 用 `createElement + textContent + dataset.idx` 构建，
  不用 `innerHTML` 拼字符串 —— 模型 id 含特殊字符也不会破坏 DOM；
- 高亮用 `classList.add('active')` 而不是拼 `className`，避免与真实 `classList` 不同步。

## 4. 计划顺序调整（用户要求）

```
G5 设备任务可靠性（G5-1~4 已完成，剩真机）
→ G7 文件格式与文件能力（前置）
→ G6 FullscreenActivity（与 G7 同批）
→ G8 Termux/Root/Shizuku → G9 插件市场/外部 Agent → G10 Release
```

`MASTER-EXECUTION-PLAN.md` 的依赖图、阶段编号、执行顺序段已同步。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过（新增主聊天唯一化 + 模型检测用例）
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增用例 `主聊天唯一化 + 模型检测入口`：

- 造出重复聊天任务 → `taskEnsureChat()` 后只剩 1 个，且原消息被合并保留；
- `taskBegin('chat')` 不再改变任务数量；
- 假 `/models` 返回 3 个模型 → 渲染 3 个 chip、当前模型高亮、提示文案正确；
- 检测请求包含 `source: 'system:models'`。

## 测试包

```text
apk/phases/ElysiaFloat-settings-model-chat-debug.apk
apk/phases/ElysiaFloat-settings-model-chat-debug-SHA256SUMS
```

SHA-256：`f698e65e2b9a388dbb2340aa2266ffd36a2fb46ed2529f4f7f99d330087e7b84`

## 真机待确认

- 保存按钮位置是否已经满意（已到贴底极限，再低会被缩放热区吃掉）；
- 打开 App 后聊天任务是否已自动合并成 1 个、旧消息是否还在；
- 「检测」按钮在真实服务商上能否列出模型（不同厂商可能不实现 `/models`，
  失败会显示错误码，可直接判断是 Key 还是地址问题）。
