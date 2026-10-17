# 工作记录：任务完成后继续说话仍留在原任务

日期：2026-10-17
状态：已修复；smoke 49 项全绿；构建通过

## 现象

新建工作区后，第一句话能正常发出去；任务完成（成功或失败）之后再发下一句，
又跳回聊天页，消息进不到工作区。

## 根因（两个，缺一不可）

上一版我只修了一半：判定条件里带了 `state === 'active'`。

1. `send()` 里的路由保护：

```js
const inPersistent = cur && (cur.type === 'workspace' || cur.type === 'device') && cur.state === 'active';
```

第一句结束后 `taskFinish()` 把状态改成 `completed`/`failed`，
`inPersistent` 立刻变 false → 普通句子被判成 `chat` → `showView('chat')` 跳页。

2. `routeTask()` / `taskBegin()` 只复用 `active` 的任务：

```js
if (old.type === type && old.state === 'active') return old;   // routeTask
const t = old && old.type === type && old.state === 'active' ? old : taskAdd(...);  // taskBegin
```

即便路由保住了 workspace，也会**新建一个工作任务**（新任务 = 新工作区目录，文件全丢）。

3. 状态机也不放行：`completed: ['archived']`，已经完成的任务无法回到 active，
   所以"继续说话"会被 `taskUpdate` 拒绝。

## 修复

1. **新增 `taskContinuable(t)`**：`active / waiting_user / paused / completed / failed` 都算"可继续"；
   `cancelled / archived` 不复用（取消是用户明确停止，重新开始更干净）。
2. **`send()` 路由**：改用 `taskContinuable` 判断，不再要求 active。
3. **`routeTask()`**：同类型且可继续 → 直接返回原任务；
   工作区**已就绪就不再重复创建/确认**（`old.workspaceReady === true` 时跳过），
   避免每次说话都弹"进入工作任务"。
4. **`taskBegin()`**：同类型可继续则复用；设备任务复用时先 `deviceReset()` 复位相位；
   统一重置 deadline（继续 = 新预算）。
5. **状态机**：`completed` 增加 `→ active`，允许在同一任务里接着说下一句。
6. **顶栏模式标签可点**：
   - 在任务里点它 → 回到聊天（`taskEnsureChat` + toast「已回到聊天」）；
   - 已在聊天时点它 → 打开任务舱。
   因为现在消息会留在任务里，必须给一个随时回聊天的入口。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过（49 项）
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增常驻用例 `任务完成后继续说话仍留在原任务（不跳聊天）`：

- active 时路由 = workspace；
- `taskFinish(completed)` 后路由仍 = workspace（不跳 chat）；
- 第二句 `routeTask` 复用同一任务、**任务数不变**；
- `taskBegin` 重新激活、deadline 重置、任务数不变；
- 失败后同样复用；
- `cancelled` 明确不复用；
- 设备任务完成后同样留在 device。

顺手修的一处测试脆弱点：G3 取消用例的"只尝试 1 次"断言改为**只统计本用例 source**，
避免其它用例残留定时器污染计数（这是测试问题，不是产品问题）。

## 测试包

```text
apk/phases/ElysiaFloat-task-continue-debug.apk
apk/phases/ElysiaFloat-task-continue-debug-SHA256SUMS
```

SHA-256：`59b3c433c6c2c26b9715c8e05c0dea902899b7f5808dea533d66e96318073bfd`

## 真机待确认

1. 新建工作区 → 第一句完成后 → 第二句仍留在工作区、能正常回复、不弹确认；
2. 失败/停止后再说一句，也留在原任务；
3. 想回聊天时点顶栏那个模式标签（现在可点）。
