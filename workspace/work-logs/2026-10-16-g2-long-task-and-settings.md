# 工作记录：G2 长任务预算和设置保存修复

日期：2026-10-16
状态：代码、自动测试和 Debug 构建完成；真机验证待进行

## 长任务预算

用户指出非对话工作不能只有 90 秒。本轮已调整：

- 默认 `agentTaskTimeout`：`1,200,000 ms`，即 1200 秒 / 20 分钟；
- 普通聊天仍使用独立 30 秒预算；
- Agent 工具轮数“按任务时间”仍不设固定轮数上限；
- 设置页最长任务时间上限从 600 秒提升到 7200 秒；
- 默认设置显示为 1200 秒；
- 旧配置中仍为旧默认 90 秒的用户自动迁移到 1200 秒；
- 仍受用户停止、取消、任务状态和重复动作熔断保护。

## 设置保存按钮

修复设置页保存按钮：

- 恢复并显示设置页浮动保存按钮；
- 底部“保存设置”按钮显式声明 `type=button`；
- 保存按钮使用统一 `saveHandler`；
- 点击时阻止默认行为和冒泡，避免被设置页其它事件代理拦截；
- 保存逻辑仍统一执行配置写入、Agent 原生同步、主题刷新、工具刷新和提示词重建。

## G2 逻辑收尾补充

- 插件沙箱运行挂起时，任务取消会拒绝挂起的插件调用；
- 截图等待绑定活动任务，取消任务会结束截图 Promise；
- Workspace/Termux/Root/Device 工具执行路径继续使用显式运行任务；
- 插件可以在授权后调用音乐和一次性读屏内置工具。

## 验证

```text
node tools/build-html.js --check  通过
node tools/smoke.js               全部通过
./build.sh assembleDebug          成功
git diff --check                  通过
```

新增 smoke 检查：

- 1200 秒默认预算；
- 7200 秒最大设置值；
- 旧 90 秒配置迁移；
- 设置保存按钮可靠绑定；
- 任务上下文和插件取消结构。

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-long-task-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-long-task-debug-SHA256SUMS
```

SHA-256：

```text
22e549fafc3b5b0ee874c1e2c8bc9bbd3b1c8fe0561d2a3e428cd9bbd6330312
```

## 当前 G2 剩余边界

- Termux 子进程和 Root 操作的真实取消仍依赖后续运行时实现；
- 真实设备上验证长工作任务暂停、恢复、停止和跨重启；
- 独立行为测试入口仍需建立。
