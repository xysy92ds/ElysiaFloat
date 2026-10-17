# ElysiaFloat 工作区状态与导航

更新时间：2026-10-17
状态：0.7.0 迭代中；全屏功能已移除、横屏窗口夹持已加固、发布产物已更新并推送

> 本文件是工作区导航，不替代技术文档。项目当前真正的执行入口是：
> - `plans/MASTER-EXECUTION-PLAN.md`：唯一任务链和阶段出口；
> - `issues/ISSUE-REGISTER.md`：唯一问题总表；
> - `plans/current.md`：原有详细方案和历史上下文；
> - `work-logs/`：已实际执行的工作证据。

## 当前结论

- 项目定位：悬浮窗 Android AI 助手 + 手机 Agent + 工作区 + 插件平台。
- 基线：`0.7.0` / versionCode `14`，Debug 构建。
- Git：`main` 已与 `origin/main` 同步（最新提交 `496d5c7`）。
- 当前源码：前端已拆为 `android/app/src/main/assets/src/`，构建时重新生成单一 `index.html`。
- 最新测试包：`apk/ElysiaFloat-v0.7.0-debug.apk`（同时归档于 `release/0.7.0/`）。
- 最新测试包 SHA-256：`df9572da419317c2b1b0525dcf76e61571c61afd73bb3cb52d2e1e071c882634`。
- 当前质量门：HTML 检查和 smoke 当前全通过；本轮最新改动尚未完成真机覆盖。
- 签名：debug/release 共用项目自有 keystore（`CN=ElysiaFloat`，SHA-256 `7851cb49…`）。

## 目录边界

```text
ElysiaFloat/
├── android/                 # 当前唯一 Android 源码、资源和构建工具
├── docs/                    # 对外稳定技术文档、权限模型、插件和发布说明
├── marketplace/             # 插件市场索引、Schema、示例插件
├── release/                 # 已归档的发布候选包及说明
├── apk/                     # 阶段构建产物和历史 APK；每个产物必须有校验记录
├── userscript/              # 早期浏览器用户脚本，不属于 Android 主线
├── workspace/               # AI 工作区：计划、问题、讨论、决策、工作证据
├── README.md                # 面向用户的项目总览
└── PLUGINS.md               # 插件开发入口
```

## 工作区子目录职责

| 目录 | 允许内容 | 不允许内容 |
|---|---|---|
| `plans/` | 当前计划、任务链、阶段出口、依赖和验收条件 | 把愿望列表写成完成结果 |
| `issues/` | 可复现问题、证据、影响、修复和验证状态 | 没有证据的泛泛猜测 |
| `discussions/` | 用户确认、产品取舍、待确认事项 | 把“计划”写成“已修复” |
| `decisions/` | 已确认的长期规则和安全边界 | 临时实现细节 |
| `work-logs/` | 实际检查、修改、构建、测试、真机结果 | 只写计划、不写执行证据 |

## 产物规则

1. 新的测试 APK 统一复制到项目内 `/workspace/gh-ElysiaFloat/apk/phases/`，这是用户下载测试版的默认目录；每个 APK 同目录放对应 `-SHA256SUMS` 文件。
2. 其它阶段归档 APK 也只放 `apk/phases/` 或 `release/<version>/`，不放项目根目录。
3. 每个 APK 必须同步记录：来源提交/工作区状态、构建命令、测试结果、SHA-256、真机状态。
4. 报告和临时分析放 `workspace/`；稳定结论再同步到 `docs/`。
5. 不把 API Key、Token、Cookie、设备信息、用户数据或完整敏感文件写入仓库。
6. 当前阶段不新增 Git 提交、不推送；阶段出口全部通过后再统一整理提交。

## 推荐阅读顺序

1. `HANDOVER.md`
2. `plans/MASTER-EXECUTION-PLAN.md`
3. `issues/ISSUE-REGISTER.md`
4. `plans/current.md`
5. `issues/2026-10-16-comprehensive-audit.md`
6. `work-logs/` 中与当前阶段对应的记录
7. `docs/` 稳定技术文档
