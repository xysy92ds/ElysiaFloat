# ElysiaFloat 工作区状态与导航

更新时间：2026-10-28
状态：0.7.2 Beta 已发布到公开仓库 `xysy92ds/ElysiaFloat`（tag `v0.7.2` / Release 422140702 / commit `cb10e91`）；G2-005 安全确认精简、I-048 长按菜单/粘贴修复已落地；0.8.0 进行中（N2/N3/N4/N5 已完成；0.7.2 真机反馈的 I-055~I-059 已修复并通过自动门，待出包真机复测）；**0.9.0 代码完成（E1 体验 + E2 模型中心，提交 `ddf1e16`）；0.10.0 代码完成（E3 开放式插件运行时）；0.11.0 代码完成（E4 插件 UI 运行时）；0.12.0 代码完成（E5 依赖 + E6 持久会话 + G8-001 Termux）；0.12.1 补丁完成（清空对话 bug、联网阅读 fetch_url/web_search、模型全用途绑定），下一步 0.13.0 MC 插件**

> 本文件是工作区导航，不替代技术文档。项目当前真正的执行入口是：
> - `plans/MASTER-EXECUTION-PLAN.md`：唯一任务链和阶段出口；
> - `plans/0.13.0-runtime-and-mc.md`：0.13 插件长任务运行时 + MC 插件（E7）实施计划；
> - `issues/ISSUE-REGISTER.md`：唯一问题总表；
> - `plans/current.md`：原有详细方案和历史上下文；
> - `work-logs/`：已实际执行的工作证据。

## 当前结论

- 项目定位：悬浮窗 Android AI 助手 + 手机 Agent + 工作区 + 插件平台。
- 基线：`0.7.2` / versionCode `17`，Debug 测试构建。
- 私有 Git：`main` 最新 `d979df1`（0.12.0 E5 依赖 + E6 持久会话完成提交；推送待 token 恢复）。
- 公开 Git：`xysy92ds/ElysiaFloat` `main` = `1b2e09a`（发布提交 `cb10e91`），tag `v0.7.2`。
- 当前源码：前端已拆为 `android/app/src/main/assets/src/`，构建时重新生成单一 `index.html`。
- 最新测试包：`apk/ElysiaFloat-v0.7.2-0.12.5dev-debug.apk`（0.12.5 体验/模型配置候选，versionCode 17 / versionName 0.7.2，可覆盖已装 0.7.x）
- 上一个测试包：`apk/ElysiaFloat-v0.7.2-0.12.4dev-debug.apk`（0.12.4 输入框挤压修正）；更早为 0.12.3 / 0.12.2 / 0.12.1 / 0.12 / 0.11 / 0.10 / 0.9 开发候选；真机复测均暂缓。
- 已发布包：`apk/ElysiaFloat-v0.7.2-debug.apk`（同时归档于 `release/0.7.2/`，与公开 Release 资产同一构建）。
- 已发布包 SHA-256：`6cf5ff194090e1827ee053db340665a3a43a4e3bcca914f159b7845fd3356b03`。
- N1 修复候选包 SHA-256：`b6e5c1d8ef02f74850be6e4877d6fd438216b810731d742e97a3574e5324a14e`。
- 0.9 开发候选包 SHA-256：`8a7dc745cb235443de254609fb890a5e9f556a5443f050baf82ddbc1f22455bc`（2,648,457 字节）；私有归档 `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.9-2026-10-28`。
- 0.10 开发候选包 SHA-256：`634b1af3169ad19c827b1f04fe174c8bb5ac98aed3b1905f2199c464de766e73`（2,666,026 字节）；私有归档 `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.10-2026-10-28`。
- 0.11 开发候选包 SHA-256：`2d1fbac349e4ebacf9d033e6c89d753cc9cb9e6b3bcfc560468f8b0931429c08`（2,673,141 字节）；私有归档 `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.11-2026-10-28`。
- 0.12 开发候选包 SHA-256：`c5662e24575d7df56e9a07c277bf7c072c8296fc6ee69cc03d00ac9af48c386d`（2,689,084 字节）；已归档私有 Release `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.12-2026-10-28`。
- 0.12.1 补丁候选包 SHA-256：`4770e2f8412ba948c02953374b3426f76c0dcfa720498a5dfd4943b2a5c85729`（2,694,210 字节）；已归档私有 Release `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.12.1-2026-10-28`。
- 0.12.2 体验补丁候选包 SHA-256：`17848a11f34ed220e9591d5c6c86d83363c12d83741cb4a208fc1bd4a48f5091`（2,693,448 字节）；设置页恢复单页分区、模型提供商独立页、保存条遮挡修复。
- 0.12.3 体验补丁候选包 SHA-256：`e6c310ba24e3061aa85f0306b48799f8a1ec2c0460dd479529539d6375264135`（2,695,081 字节）；恢复设置折叠（箭头 + 记住状态）、原生 select 改 chips、运行秒数移到输入框下方。
- 0.12.4 体验补丁候选包 SHA-256：`2fac488ef664a4cca2279b51b16b8c156cc94d26e6a92860c94207fbe5982d4b`（2,695,168 字节）；修复空插件 composer 插槽占满整行导致聊天输入框被挤成一条缝（I-071）。
- 0.12.5 体验/模型配置候选包 SHA-256：`5c8ce93046bac6975e2a34a242ed8180e3bff8157e9799c54e19471a849c7faa`（2,699,067 字节）；用途绑定点击反馈、顶栏整块可拖、输入区/设置底部条留白收紧、Provider 表单一键检测模型 + 能力标注、识图/向量 Provider 快捷选择、快捷服务商扩到 21 个、删除 EveryAPI、剪贴板读取增加 WebView 兜底（I-072/I-073）。
- 下一步执行计划：`plans/0.13.0-runtime-and-mc.md`；0.13 拆为 0.13.0 插件长任务运行时（R-001~R-007）+ 0.13.1 MC 插件（M-001~M-010）。用户已确认：MC 先只做离线登录；设备 Termux 已装、Node 未装，先补“一键准备环境”。
- 0.13 路线决策（2026-10-29，用户选定 B「桥接」）：不自研 MC 决策循环，Termux 里跑现成引擎（Mindcraft-CE / MCP server），我们只做配置页 + 启停 + 状态/日志桥。因此 R-004 不再新造 token RPC，插件走已有的 `network.local` 本机 HTTP；0.13.1 的 M-004~M-011 相应改为“引擎适配层”。
- 0.13.0 进度（2026-10-29）：R-001 `runtime.termux` 权限 + 五个 Termux 工具能力映射（`root_operation` 不开放给插件）、R-002 清单 v2 `runtime` 块（kind/entry/source/args/autostart/restart/healthcheckMs/logMaxBytes/configFile，入口必须相对且不许 `..`）、R-003 宿主托管隐藏工作任务 `plug-<id>.runtime`（start/stop/status，仍走逐次确认）、R-005 一键准备环境（复用 E5，Termux 未装/Node 未装都有手动命令兜底）、R-006 心跳/退避/双层日志轮转/停止清理（失败只报告，不静默拉起）、R-007 node-hello 回归夹具。`smoke.js` 新增三条回归，`build-html --check` / `smoke` / `behavior.test` / `scan-secrets` 全通过。
- 0.13.1 进度（2026-10-29，路线 B）：`marketplace/plugins/com.elly.market.minecraft` 整体重写为 Manifest v2 + `runtime`（entry `bot.js`、`configFile`、`restart:on-failure`、`logMaxBytes:2MB`）。配置页 `mc-config`（host/port/username/version/allowActions/autoReconnect/allowedHosts，支持粘贴「Local game hosted on port xxxxx」自动解析）与说明页 `mc-guide`；依赖 Node + mineflayer/pathfinder/minecraft-data/vec3 走 R-005；新 `bot.js` 离线登录、断线退避重连、`status.json`/`chat.log`、只监听 `127.0.0.1:39271` 的 `/cmd` `/status`、17 个动作、安全模式与玩家保护；AI 侧三个本机工具 `minecraft_bot` / `minecraft_bot_status` / `minecraft_chat_read`。清单由 `tools/build-mc-manifest.js` 从 `bot.js` 生成并同步 `marketplace/index.json`（v0.3.1，SHA-256 `3de5f7dd…`）。
- 0.13.1 补完（2026-10-29）：M-009 动作审计 `audit.log`（256KB 截半）+ 每分钟 30 个动作限频；M-007 只读聊天桥 `GET /chat?since=&limit=` + `minecraft_chat_read`（游戏内聊天不回令，仍是路线 B）；修掉「未进世界时 `bot.inventory` 未初始化导致取快照崩溃」的真 bug，smoke 已加回归。
- 0.13.1 本地离线验证：用 stub 的 mineflayer/pathfinder/minecraft-data/vec3 跑真 `bot.js`，验证 `/status`、`/chat` 的 since 过滤、第 31 条指令起限频、`audit.log` 32 行、SIGTERM 收尾。真机联调（Termux 装 Node、开房间端口、实际进世界）尚未做。
- 0.13 候选包 SHA-256：`c1902d72d5fcca68c8a8c2797612edb9027be036025c90b42324cf701f3795fe`（2,707,413 字节），`apk/ElysiaFloat-v0.7.2-0.13dev-debug.apk`；内置 `index.html` 已含 R-005/R-006。
- 0.13.1 候选包 SHA-256：`9252214966179cbbabd346fedabcd8f515a78a45ac71f699857cb5da89b2bfd3`（2,722,494 字节），`apk/ElysiaFloat-v0.7.2-0.13.1dev-debug.apk`（内置 `index.html` = `6cec6892…`）。APK 内置市场新增 Minecraft 条目（由 `tools/build-mc-manifest.js` 从清单生成 `src/scripts/04a-mc-market.js`），远程索引未推送也能在「插件市场」直接安装；`plugMarketEntries` 改为「远程版本更高时才覆盖内置条目」，避免内置版本挡住后续更新。
- 公开 Release：`https://github.com/xysy92ds/ElysiaFloat/releases/tag/v0.7.2`（已标记 Latest，标题保留 Beta；资产 APK / source.zip / SHA256SUMS）。
- 当前质量门：`build-html.js --check`、`smoke.js`（含 MC-001/MC-002）、`behavior.test.js`、`check-release.js`、`scan-secrets.js`、`plugin-validate.js`、`assembleDebug` 全通过（2026-10-29 复跑，含 0.13.1 内置市场条目）；I-055~I-073 仍待真机复测。
- 签名：debug/release 共用项目自有 keystore（`CN=ElysiaFloat`，SHA-256 `7851cb49…`），可直接覆盖 0.7.0/0.7.1；Beta 期不分离，见 `decisions/DEC-003-signing-and-release.md`。
- 更新链路：应用内更新检查读取公开仓库 `release/latest.json`，当前已指向 v0.7.2（私有归档副本已同步为公开 URL）。
- 平台化路线：全部 0.x Beta 小步走——0.9 核心体验+模型中心 → 0.10 开放式插件运行时 →
  0.11 插件 UI 运行时 → 0.12 依赖+持久会话 → 0.13 MC 插件 → 0.14 QQ 插件 → 0.15 沙箱 HTML+适配器生态+工作能力+治理；
  详见 `plans/PLATFORM-0.8-0.15.md`（决策 1A / 2C / 3C / 4ABC 已确认）。
- 执行状态：0.8.0 的 N2/N3/N4/N5 已完成，只剩 N1 真机回归与最终发布；0.9.0 已代码完成（E1-001~004/006 + E2-001~005/008）；0.10.0 已代码完成（E3 开放式插件运行时）；0.11.0 已代码完成（E4 插件 UI 运行时：挂载点/样式白名单/主题包/会话引擎/设置扩展/卸载清理/开发者工具包 + 三个验收插件）；0.12.0 已代码完成（E5 依赖管理：HTTPS+SHA-256 下载校验/沙箱安装/lockfile/依赖面板/APK 系统安装器；E6 持久会话：心跳/检查点/唤醒锁/看门狗/调度器/预算熔断/日志轮转；G8-001 Termux run_id/超时/取消/审计/固定模板）；0.12.1 已代码完成（真机反馈的三项：清空对话未定义函数、联网阅读 fetch_url/web_search、模型中心 8 用途绑定）；0.12.2 已代码完成（设置页恢复单页分区、模型提供商独立页、底部保存条遮挡与输入区最小高度）；六者均待真机验证，下一步 0.13.0（E7 MC 插件）；
  每版按 10 步流程执行（新增「生成工作转移包」），变更记录见该文档第 13 节。
- 工作转移：`tools/handoff.sh` 生成 `handoff/ElysiaFloat-handoff-v<版本>-<时间戳>.zip`
  （源码 + docs + APK + git bundle + status/diff + SHA256SUMS + 恢复说明），每版发布后必做；`handoff/` 已 gitignore；
  另有副本作为 Release 资产存放在私有仓库：
  `https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/handoff-2026-10-28`。
- 0.10.0 工作转移包：`handoff/ElysiaFloat-handoff-v0.10.0-20261028-202751.zip`（58 MB，SHA-256 `8ec259f9f2d9c4869d01c766774f8ead3cf143a4fef6a5ccacdb9d039fa0229f`），已作为资产上传 `dev-0.10-2026-10-28`。
- 0.11.0 工作转移包：`handoff/ElysiaFloat-handoff-v0.11.0-20261028-205609.zip`（58 MB，SHA-256 `8fbe0a440a9e1e8ed6d672c9047fd37f43b38cf67b1a10d26fa98570a2d3fd41`），已作为资产上传 `dev-0.11-2026-10-28`。

## 目录边界

```text
ElysiaFloat/
├── android/                 # 当前唯一 Android 源码、资源和构建工具
├── docs/                    # 对外稳定技术文档、权限模型、插件和发布说明
├── marketplace/             # 插件市场索引、Schema、示例插件
├── release/                 # 已归档的发布候选包及说明
├── apk/                     # 阶段构建产物和历史 APK；每个产物必须有校验记录
├── userscript/              # 早期浏览器用户脚本，仅私有存档，不进入公开仓库
├── workspace/               # AI 工作区：计划、问题、讨论、决策、工作证据
├── tools/                   # 仓库级脚本（handoff.sh 工作转移包）
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

1. 新的测试 APK 统一放到项目内 `apk/`，每个 APK 同目录放对应 `-SHA256SUMS` 文件；正式归档再复制到 `release/<version>/`。
2. 其它阶段归档 APK 也只放 `apk/` 或 `release/<version>/`，不放项目根目录。
3. 每个 APK 必须同步记录：来源提交/工作区状态、构建命令、测试结果、SHA-256、真机状态。
4. 报告和临时分析放 `workspace/`；稳定结论再同步到 `docs/`。
5. 不把 API Key、Token、Cookie、设备信息、用户数据或完整敏感文件写入仓库。
6. 内测期允许提交与推送，但每次版本必须同步：版本号、Release 资产、SHA-256 校验值、工作记录。

## 推荐阅读顺序

1. `HANDOVER.md`（全局任务总览与验证门）
2. `plans/PLATFORM-0.8-0.15.md`（当前主线 0.8→0.15）
3. `plans/MASTER-EXECUTION-PLAN.md`（历史阶段 G0~G10）
4. `issues/ISSUE-REGISTER.md`
5. `plans/current.md`
6. `issues/2026-10-16-comprehensive-audit.md`
7. `work-logs/` 中与当前阶段对应的记录
8. `docs/` 稳定技术文档
