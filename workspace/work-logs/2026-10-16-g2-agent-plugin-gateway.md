# 工作记录：G2 Agent 状态机门禁与插件能力网关收口

日期：2026-10-16
状态：G2 第二轮自动验证和 Debug 构建完成；仍需真机验证

## 任务状态机

文件：`android/app/src/main/assets/src/scripts/03-state-tasks.js`

新增 `TASK_TRANSITIONS` 状态迁移表，对任务状态更新进行原生前的前端调度门禁：

- `new → active / cancelled / failed / archived`；
- `active → waiting_user / paused / completed / failed / cancelled`；
- `waiting_user → active / paused / completed / failed / cancelled`；
- `paused → active / cancelled / failed / archived`；
- `completed → archived`；
- `failed/cancelled → active / archived`；
- `archived` 不允许继续迁移。

非法迁移不会静默覆盖状态，会记录 `invalid_transition` 事件和 `INVALID_STATE_TRANSITION` 错误。

## Agent / 插件能力网关

文件：

- `android/app/src/main/assets/src/scripts/04-plugins-core.js`
- `android/app/src/main/assets/src/scripts/10-music.js`
- `android/app/src/main/assets/src/scripts/11-plugin-engine.js`
- `marketplace/schema/manifest-v1.json`
- `PLUGINS.md`
- `docs/development/plugin-system.md`
- `marketplace/PLUGIN_DEVELOPMENT.md`

完成：

- 插件 `host.callTool` 增加一次性读屏 `read_screen_once` 能力映射；
- 增加 `music.control` 权限，使插件可以在权限授权后调用搜索、播放、暂停、切歌、收藏和音乐缓存工具；
- 插件能力映射继续覆盖设备、文件、记忆、系统、音乐等内置工具；
- 插件 JS 沙箱调用内置工具时传递当前运行任务，权限和任务类型不会退回全局 `currentTask()`；
- 插件 HTTP 和 JS 工具的请求任务 ID 绑定到当前 Agent 任务；
- `buildTools()` 根据显式运行任务暴露工作区相关运行时工具；
- DeviceTask 重复动作检测使用显式活动任务，不再误写当前聊天任务。

权限边界仍然保持：

```text
插件声明
→ 用户授权
→ toolLive / plugin permission
→ 当前任务类型
→ Agent 等级 / 安全开关
→ 白名单 / 文件路径 / 逐次确认
→ 内置工具执行
```

## 自动验证

```text
node tools/build-html.js --check  通过
node tools/smoke.js               全部通过
./build.sh assembleDebug          成功
git diff --check                  通过
```

新增 smoke 检查：

- `TASK_TRANSITIONS` 和非法迁移错误码；
- 插件音乐权限映射；
- 插件一次性读屏映射；
- 显式任务和运行时插件调用结构。

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-agent-plugin-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-agent-plugin-debug-SHA256SUMS
```

SHA-256：

```text
08ada9f13009de773373e5c52d03179b25f68c1569541afb62c5f1e7a024555c
```

## 仍需完成

- Termux 子进程和 Root 操作的真实取消；
- 所有 `execTool` 路径彻底移除隐式 `currentTask()`；
- 真机验证插件调用音乐、读屏、文件和设备能力；
- 完整行为测试入口和状态迁移运行时测试。
