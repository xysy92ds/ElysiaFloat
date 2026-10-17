# G5 DeviceTask 可靠性 —— 定稿方案

日期：2026-10-17
状态：**已定稿，等待开工令**
前置：G3 已完成（统一 RequestManager）；G4 音乐已由用户确认关闭
范围：只做手机 Agent 的可靠性与可观测性；不碰 Termux/Root/Shizuku（G8）、全屏（G6）、文件格式（G7）

---

## 0. 用户决定（2026-10-17）与本方案的对应

| 决定原文 | 落地方式 |
|---|---|
| 「避免重复读可以」 | 读屏结果按页面 hash 缓存 3s，重复调用返回缓存并标注；不做"必须先读屏"的硬拦 |
| 「排队为主允许并行，一切以效率和稳定性为主」 | 设备动作**串行排队**（一批里多个动作按顺序逐个执行）；非设备工具保持并行；两者混在一批时，非设备并行跑完再串行执行设备动作 |
| 「采用密码框，不用文本词表，防止普通任务被中断」 | 风险门只看原生 `isPassword` 标记；**不建关键词表**，绝不因为按钮文字叫"发送"就打断 |
| 「单次动作预算可以调的，默认可以给高点」 | `deviceMaxActions` 可配置，默认 **120**，范围 20~2000 |
| 「整理文件长任务工作给到 20 分钟」 | 工作区/设备任务默认 deadline 1200s（已是现状），文件整理类任务同样适用 |
| 「预算用完的时候是暂停，不中断」 | 预算耗尽 → 任务 `paused` + 提示，**不判失败**；点继续再给一批预算 |
| 「允许切换」 | 允许任务内切应用；每次 `launch_app` 重新过白名单；切到非白名单应用立即停 |
| 「读屏空白应用接受建议」 | 任务级截图授权：一次确认，本任务内后续截图不再逐张确认 |
| 「未来可能接入 suz、root 一类权限，这方面可以给宽点」 | 设备能力抽象成 `DeviceCapability` 提供者，动作走接口而不是写死 a11y；未来加 root/shizuku 提供者不改上层 |
| 「坐标问题按你说的定」 | 统一返回屏幕 W/H，模型用**比例坐标**，执行时换算成像素 |
| 「紧急停止不用加，浪费空间」 | 不做悬浮球急停 |
| 「读屏改成自适应软结构，不会因为读屏过长就中断」 | 分级摘要（tier0/1/2），超限只提示"还有 N 项未列出"，**永不因长度中断或失败** |

---

## 1. 目标与出口

### 目标

1. 设备任务有明确状态机，非法路径不静默通过；
2. 每个动作后**真实**验证页面变化，验证结果参与决策；
3. 密码框输入必须确认，其它不打扰；
4. 预算可调，耗尽暂停可继续；
5. 每个动作可回溯（不含用户输入的敏感内容）；
6. 读屏无论多长都能用，不会撑爆上下文；
7. 为将来的 root / shizuku 能力留出接口，不返工。

### 出口（全部满足才算 G5 完成）

- 自动测试：状态机迁移、动作排队顺序、密码框确认、预算暂停与继续、读屏分级、坐标换算、缓存命中；
- 行为测试：连续 2 次验证失败 → 暂停并说明原因；同动作同页面重复 → 熔断；
- Debug 构建 0 error，smoke 全绿；
- 真机：在白名单应用里完成一次"打开应用 → 点按钮 → 输入文字 → 返回"的完整链路，日志可查。

---

## 2. 状态机

```
                 ┌───────────── pause/预算耗尽 ─────────────┐
                 ↓                                          │
NEW → ORIENTING → PLANNING → ACTING → VERIFYING ─ PASS ─→ (下一动作 / DONE)
                    ↑                    │
                    └── REPLAN ←── FAIL ─┘
                                       └─ 连续失败 ≥3 → PAUSED(需用户)
```

| 状态 | 进入条件 | 允许的动作 |
|---|---|---|
| `ORIENTING` | 设备任务开始 | 读屏、找应用、截图；不允许动作 |
| `PLANNING` | 已有首屏信息 | 仅内部，不暴露为工具 |
| `ACTING` | 模型请求动作 | 一次一个动作（队列） |
| `VERIFYING` | 动作返回 | 只允许读屏/截图 |
| `DONE / FAILED / PAUSED / CANCELLED` | 终止或暂停 | — |

约束：

- `ACTING` 期间收到新的动作工具调用 → **入队**，不并行执行；
- `VERIFYING` 未完成前不允许下一个动作出队；
- `PAUSED` 可由 `taskResume` 恢复，恢复时重置 deadline 并补一批动作预算。

---

## 3. 动作队列与并行

```
一批 tool_calls = [read_screen, tap_screen, tap_screen, get_weather]
                    ↓
非设备类（get_weather）  → Promise.all 并行，立即返回
设备类（read/tap/tap）   → 按原顺序串行出队，逐个 await
```

判定依据沿用现有 `canParallelTool()`：设备动作类一律 `false`（串行），其余保持现状。

**不做**"一次只允许一个动作否则报错"——排队即可，避免打断模型正常节奏。

---

## 4. 读屏：自适应软结构

### 4.1 原生侧（`EllyAccessibilityService`）

`dumpScreenNodes()` 增强为返回对象：

```json
{
  "screen": { "w": 1080, "h": 2400 },
  "count": 137,
  "nodes": [
    { "t": "发送", "x": 920, "y": 2210, "w": 120, "h": 90,
      "clk": true, "edt": false, "pwd": false, "scr": false, "cls": "Button" }
  ]
}
```

- 新增字段：`clk`（可点击）、`edt`（可编辑）、`pwd`（**仅布尔**，绝不返回内容）、`scr`（可滚动）、`cls`（类名末段）；
- 保持 `MAX_NODES` 上限（现有值），但**超限不是失败**，用 `count` 与 `nodes` 长度差表达；
- 现有 `dumpScreenText()` 保留不动，供翻译等功能继续使用。

### 4.2 JS 侧分级摘要（`screenDigest`）

| 层 | 内容 | 上限 | 触发 |
|---|---|---|---|
| `tier0` | 可点击/可编辑/密码/可滚动节点，附比例坐标 | 40 项 | 默认返回 |
| `tier1` | 纯文本行 | 120 行 / 4000 字 | `read_screen {detail:"more"}` |
| `tier2` | 全量节点 | 不截断，但按 20 项/批分页 | `read_screen {detail:"full", page:n}` |

规则：

- 任何层级**都不会因为过长而失败**；超出上限只追加一行 `note: "还有 N 项未列出"`；
- tier0 里每个节点都带 `rx, ry`（相对屏幕的比例坐标，0~1，保留 3 位小数）；
- 同时给出 `screenHash`（对 tier1 文本 + 包名做短哈希），用于验证与缓存。

### 4.3 读屏缓存

- key = 前台包名 + `screenHash`；
- TTL 3s；
- 命中时返回同一份摘要 + `cached: true, ageMs`；
- 目的：模型同一轮重复读屏不重复计费、不重复等待。

---

## 5. 验证：自适应轮询

```
ACT 完成 → 记录 t0 与 beforeHash
→ 每 150ms 读一次 hash
   ├ 变化 → 立刻成功（记录 waitedMs）
   └ 到 2500ms 仍未变 → 判 NO_CHANGE
```

验证输出（结构化，进入 tool 结果）：

```json
{ "changed": true, "waitedMs": 420,
  "package": "com.tencent.mm", "packageChanged": false,
  "empty": false, "hash": "a1b2c3",
  "digest": { "tier0": [ ... ] } }
```

判定：

| 情况 | 处理 |
|---|---|
| `changed && !empty` | PASS |
| `changed && empty` | 继续观察一次（再等 600ms）；仍空 → `VERIFY_EMPTY` |
| `!changed` | `NO_CHANGE`，给模型警告；同动作连续 2 次 → `REPEATED_NO_CHANGE` 熔断（已有） |
| `packageChanged` 且新包不在白名单 | 立即 `WHITELIST_DENIED` 停止 |
| 连续失败 ≥ 3 | 任务 `paused`，提示"需要你确认下一步" |

---

## 6. 风险门（只要密码框）

- 动作前检查目标节点是否 `pwd: true`：
  - 是 → `uiConfirm`「要在这个密码框里输入吗？内容不会记录」；
- `input_text` 未指定目标时，检查当前焦点节点是否密码框（原生提供 `focusedPwd`）；
- **不做**任何基于按钮文字的判断；
- 现有 `launch_app` 白名单、L3、安全开关全部保留不动。

---

## 7. 预算

新增配置：

| key | 默认 | 范围 | 说明 |
|---|---|---|---|
| `deviceMaxActions` | 120 | 20~2000 | 单个设备任务动作上限 |
| `deviceActionResumeChunk` | 120 | 20~2000 | 预算耗尽后点继续，追加的数量 |
| `agentTaskTimeout` | 1200000 | 15000~7200000 | 已存在，文件/设备任务共用 20 分钟 |

行为：

- 每执行一个设备动作 `actionsUsed++`；
- `actionsUsed >= deviceMaxActions` → 任务 `paused`、`progress: '动作预算已用完（120/120）'`、**不判失败**；
- 用户点继续 → `actionsUsed` 回退一个 chunk，deadline 重置，`state: active`；
- 任务舱显示 `已用 N/M`。

---

## 8. 能力抽象（为将来的 root / shizuku 留口）

```js
const DEVICE_PROVIDERS = {
  a11y:      { read, digest, tap, clickText, swipe, input, key, launch, available },
  // root:   { ... }  未来
  // shizuku:{ ... }  未来
};
function deviceProvider() { /* 今天固定返回 a11y */ }
```

上层（`execTool`）只调 `deviceProvider()` 的方法，不直接碰 `Perm.agentTap`。
原生侧对应保留 `AgentPolicy.check(ctx, level, pkg)` 作为**唯一最终门禁**，
未来 root 提供者插入后仍走同一道门。

---

## 9. 审计

每个设备动作写一条 `taskEvent`：

```json
{ "type": "device_action", "at": 1697…,
  "data": { "action": "tap_screen", "target": "发送", "rx": 0.85, "ry": 0.92,
            "changed": true, "waitedMs": 420, "budget": "12/120",
            "result": "ok" } }
```

- `target` 只记录控件文本**前 12 字**；
- `input_text` 的**内容永不记录**，只记长度；
- 任务舱可展开查看最近 20 条。

---

## 10. 坐标约定

- 读屏摘要返回 `screen.w/h` 与每项 `rx/ry`（相对坐标）；
- 提示词要求模型用 `rx/ry`（0~1）而不是像素；
- 执行端：`x = round(rx * screenW)`，并夹紧到屏幕内；
- 仍然兼容模型直接给像素（若它给 > 1 的数，按像素处理并校验边界）。

---

## 11. 任务拆分与出口

### G5-1 状态机 + 队列

- 新增 `DeviceTask` 状态字段与迁移表（复用 `TASK_TRANSITIONS`，增加 `orienting/acting/verifying` 之外的语义映射，不破坏现有任务）；
- 动作串行队列；非设备工具并行不变；
- 出口：队列顺序测试、非法迁移测试、混合批次测试。

### G5-2 读屏摘要 + 缓存

- 原生 `dumpScreenNodes` 加字段与 `screen` 尺寸；
- JS `screenDigest(tier)` + 缓存 + `read_screen {detail}` 参数；
- 出口：三级摘要测试、超限不失败测试、缓存命中测试、比例坐标测试。

### G5-3 验证轮询

- 替换固定 350ms；结构化验证结果；
- 失败分级与暂停策略；
- 出口：变化/不变/空页/换包 四种用例。

### G5-4 风险门 + 预算

- 密码框确认；预算配置与暂停/继续；
- 出口：密码框必确认、非密码不打扰、预算耗尽暂停可继续。

### G5-5 审计 + 真机

- 动作事件与任务舱展示；
- 真机跑通"打开应用 → 点按钮 → 输入 → 返回"；
- 出口：真机日志 + 截图。

---

## 12. 涉及文件（预估）

```
android/app/src/main/java/com/elly/float/EllyAccessibilityService.kt   +字段、+screen尺寸
android/app/src/main/java/com/elly/float/PermissionBridge.kt           +focusedPwd
android/app/src/main/assets/src/scripts/03-state-tasks.js              +设备状态、+预算
android/app/src/main/assets/src/scripts/07-media-tts.js                +screenDigest、+轮询验证
android/app/src/main/assets/src/scripts/10-music.js                    +动作执行走 provider
android/app/src/main/assets/src/scripts/11-plugin-engine.js            +队列
android/app/src/main/assets/src/scripts/02-config.js                   +配置项、+提示词
android/app/src/main/assets/src/scripts/13-settings.js                 +预算设置 UI
android/tools/smoke.js                                                 +G5 用例
```

---

## 13. 不做

- 不做悬浮球急停；
- 不建高风险词表；
- 不做"必须先读屏否则拒绝"；
- 不改 Termux/Root/Shizuku 现状；
- 不动全屏与文件格式。
