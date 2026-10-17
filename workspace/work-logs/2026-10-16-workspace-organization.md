# 工作记录：项目规划、问题总表和工作区整理

日期：2026-10-16
状态：文档整理完成；未修改功能代码；未提交 Git；未推送

## 检查范围

- 读取根 README、docs、release、marketplace、userscript 文档；
- 读取 workspace 的计划、问题、讨论、决策和历史工作记录；
- 检查当前 Git 分支、HEAD、origin、工作区改动和未跟踪文件；
- 检查当前前端模块、构建脚本、Agent/工作区/Termux/Root/外部 Agent 源码；
- 执行 HTML 一致性检查、迁移基线检查、冒烟测试和 Android Debug 构建。

## 实际验证结果

```text
node tools/build-html.js --check       通过
node tools/build-html.js --verify-migration 失败：当前源码已偏离旧迁移基线
node tools/smoke.js                    报告 4 项音乐相关失败
./build.sh assembleDebug               通过
```

当前本地 Debug APK：

```text
android/app/build/outputs/apk/debug/app-debug.apk
SHA-256: 82422d61b2c9a434bdfdc24ea7a4e964bbc2230d355a3f06bab80db0f4b2dd6f
```

## 确认的问题

- `10-music.js` 调用未定义的 `musicJson()`；
- 播放地址解析不覆盖 `play_urls`；
- Agent 工具轮数配置为 0 时执行器和保存逻辑退化到 5；
- QuickOperation 和全局任务上下文仍有耦合；
- 全局 `via_ai_history` 仍有残留写入；
- 当前全屏仍是 Overlay 最大化，不是 FullscreenActivity；
- RequestManager、DeviceTask 完整状态机、Termux/Root/Shizuku 真实运行时、外部 Agent 执行层和正式发布流程未完成；
- 最新改动没有完整真机证据。

## 本次文档产物

- `workspace/STATUS.md`
- `workspace/plans/MASTER-EXECUTION-PLAN.md`
- `workspace/issues/ISSUE-REGISTER.md`
- 更新 `workspace/README.md`
- 更新 `workspace/plans/current.md` 的状态入口
- 更新 `workspace/plans/agent-task-board.md` 的历史专题定位
- 更新 `workspace/issues/README.md`
- 新增本次讨论记录

## 下一步

按照主执行计划 G0 → G1 → G2 → G3 → G4/G5/G6/G7 → G8 → G9 → G10 执行，第一代码任务为 G1-001 音乐解析回归修复；在 smoke 全绿前不扩展高权限能力、不发布 APK。
