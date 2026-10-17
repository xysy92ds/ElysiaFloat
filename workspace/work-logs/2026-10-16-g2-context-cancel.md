# 工作记录：G2 运行上下文和 QuickOperation 取消边界

日期：2026-10-16
状态：G2-002 / G2-004 第一轮实现完成；自动验证和 Debug 构建通过

## 本轮目标

在音乐阶段之后继续推进任务链，先处理普通聊天、QuickOperation 和持久 AgentTask 之间的运行上下文耦合。

## 实现

涉及文件：

- `android/app/src/main/assets/src/scripts/00-compat.js`
- `android/app/src/main/assets/src/scripts/04-plugins-core.js`
- `android/app/src/main/assets/src/scripts/10-music.js`
- `android/app/src/main/assets/src/scripts/11-plugin-engine.js`
- `android/app/src/main/assets/src/scripts/12-send-quick.js`
- `android/tools/smoke.js`

### 运行任务上下文

- 增加 `ACTIVE_RUN_TASK_ID`；
- 普通发送绑定当前 `routedTask.id`；
- QuickOperation 绑定临时任务 ID；
- `chatReqTools()` 优先使用 `hooks.task`，不再无条件读取全局 `currentTask()`；
- 普通任务和 QuickOperation 的 live hooks 都携带对应任务对象；
- 工具执行收到显式运行任务，任务类型检查优先使用显式任务。

### 请求取消边界

- `nativeReq()` 增加可选 `taskIdOverride`；
- 模型请求记录实际运行任务 ID；
- 停止按钮优先取消 `ACTIVE_RUN_TASK_ID` 对应的请求；
- QuickOperation 的取消不再错误地只取消持久聊天任务的请求；
- 屏幕翻译 QuickOperation 也绑定自己的活动任务 ID。

## 自动验证

```text
node tools/build-html.js       通过
node tools/smoke.js            全部通过
./build.sh assembleDebug       成功
git diff --check                通过
```

新增 smoke 检查：

- `hooks.task` 注入；
- `execTool(..., activeRunTask)`；
- request taskId override；
- ACTIVE_RUN_TASK_ID 停止边界；
- 普通任务和 QuickOperation live context。

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-context-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-context-debug-SHA256SUMS
```

SHA-256：

```text
5ce7963f08b5fc593ce3202d2be6609be9ca6dc55b4ea93fb7bf666393a0d746
```

## 尚未完成

- `execTool` 内部所有设备/工作区路径仍需继续完全消除隐式 `currentTask()`；
- 截图等待、插件执行、Termux 子进程尚未统一取消；
- 任务状态机仍未完成非法迁移拒绝；
- 尚未建立独立 `behavior.test.js`；
- 需要真机验证停止快捷任务、切换任务和迟到回调。

## 下一步

继续完成 G2 状态机与统一取消，再进入 G3 RequestManager，统一请求 ID、超时预算、错误码、重试和响应校验。
