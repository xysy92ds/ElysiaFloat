# 交接说明（Handover）

更新时间：2026-10-28
当前阶段：**0.11.0 代码完成（E4 插件 UI 运行时），0.12.0 待启动**——0.8.0 仍等 N1 真机复测（用户暂缓）；0.9.0 / 0.10.0 / 0.11.0 冻结项已落地，5 道自动门 + Gradle 全绿
最新可用包：`apk/ElysiaFloat-v0.7.2-0.11dev-debug.apk`（versionCode 17 / versionName 0.7.2，0.11 开发候选包，可覆盖已装 0.7.x）
SHA-256：`2d1fbac349e4ebacf9d033e6c89d753cc9cb9e6b3bcfc560468f8b0931429c08`
上一个候选包：`apk/ElysiaFloat-v0.7.2-0.10dev-debug.apk`（0.10 开发候选，SHA-256 `634b1af3…`）；更早为 0.9 开发候选与 N1 修复候选（`8a7dc745…` / `b6e5c1d8…`）
已发布包：`apk/ElysiaFloat-v0.7.2-debug.apk`（公开 Release 资产，SHA-256 `6cf5ff19…`）
工作转移包：`handoff/ElysiaFloat-handoff-*.zip`（以同目录 `.sha256` 为准）；
私有仓库归档：`https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/handoff-2026-10-28`；
N1 修复候选包：`https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/n1fix-2026-10-28`（私有，需登录）；
0.9 开发候选包：`https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.9-2026-10-28`（私有，需登录）；
0.10 开发候选包：`https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.10-2026-10-28`（私有，需登录）；
0.11 开发候选包：`https://github.com/xysy92ds/ElysiaFloat-dev/releases/tag/dev-0.11-2026-10-28`（私有，需登录）。

> 2026-10-28 补：本轮修复粘贴/复制（I-055）、横屏退出跑出屏幕（I-056）、
> 音乐工具被 `toolsBroken` 毒化（I-057）、设备任务发送（I-058）、任务模式不调工具（I-059）。
> 自动门全绿、Debug 包已构建并上传私有 Release；**真机验证暂缓（用户当前不便装机）**，
> 详见 `work-logs/2026-10-28-0.8.0-n1-fixes.md`。

## 1. 一句话现状

ElysiaFloat 是一个 Android 悬浮窗 AI 助手（聊天 + 手机 Agent + 文件工作区 + 开放插件平台）。
0.7.2 Beta 已发布到公开仓库 `xysy92ds/ElysiaFloat`：
commit `cb10e91`（索引更新 `1b2e09a`）、tag `v0.7.2`、Release 422140702，
已标记为 Latest（标题保留 “Beta”），资产 APK / source.zip / SHA256SUMS 均已匿名下载验证。
前端已拆分为 `android/app/src/main/assets/src/`，构建时由 `tools/build-html.js` 合并成单文件 `index.html`。
当前代码基线仍是 0.7.2；0.8.0 只加了测试/脚本/文档，没有新增用户功能，因此尚未提升版本号。

## 2. 权威入口

| 用途 | 位置 |
|---|---|
| 唯一执行计划（历史阶段 G0~G10） | `workspace/plans/MASTER-EXECUTION-PLAN.md` |
| 平台化路线（0.8→0.15，当前主线） | `workspace/plans/PLATFORM-0.8-0.15.md` |
| 唯一问题总表（编号/证据/状态） | `workspace/issues/ISSUE-REGISTER.md` |
| 工作区导航与事实快照 | `workspace/STATUS.md` |
| 执行证据 | `workspace/work-logs/` |
| 用户确认/产品取舍 | `workspace/discussions/` |
| 长期规则与 ADR | `workspace/decisions/`（DEC-003/004/005） |
| 测试版 APK | `apk/phases/` 或 `apk/`（同目录带 `-SHA256SUMS`） |
| 稳定技术文档 | `docs/` |
| 构建/测试脚本 | `android/tools/` |
| 工作转移包 | `tools/handoff.sh` → `handoff/` |

## 3. 全局任务总览（每个项目都在这里）

### 3.1 版本路线

| 版本 | 主线 | 任务编号 | 状态 | 出口 |
|---|---|---|---|---|
| 0.7.2 | 安全确认精简 / 长按粘贴 | G2-005、I-048 | 已发布，真机待验 | 公开仓库 Latest |
| **0.8.0** | 稳定收口（不加功能） | N1~N5 | **进行中**：N2/N3/N4/N5 完成，N1 待做 | 核心回归全绿 + 测试全绿 + 0.8.0 可覆盖安装 |
| 0.9.0 | 核心体验 + 模型中心 | E1 + E2 | **代码完成**：E2-001~005/008、E1-001~004/006 已落地并通过自动门；真机待验；候选包已归档 | 首页永远是聊天；密钥不出日志；加 Provider 不改聊天代码 |
| 0.10.0 | 开放式插件运行时 | E3 | **代码完成**：E3-001~009 已落地并通过自动门；真机待验；候选包已归档 | 插件注册宿主没写过的新页面/入口/会话/命令/任务，宿主零改动 |
| 0.11.0 | 插件 UI 运行时 | E4 | **代码完成**：E4-001~009 已落地，三个验收插件通过行为测试；真机待验；候选包已归档 | 主题/恋爱游戏/番茄钟三个验收场景通过 |
| 0.12.0 | 依赖 + 持久会话 + Termux | E5 + E6 + G8-001 | 规划中 | 息屏 8 小时会话存活可恢复；Node/Mineflayer/NapCat 可安装卸载 |
| 0.13.0 | MC 插件（无面板） | E7 | 规划中 | 30 分钟连续任务稳定、断线重连 |
| 0.14.0 | QQ 插件（微型面板） | E8 | 规划中 | 私聊/群聊 24 小时稳定 |
| 0.15.0 | 沙箱 HTML + 适配器 + 工作能力 + 治理 | E9 + E10 | 规划中 | 第三方不看源码能写出带页面/会话/主题/适配器的插件 |

全部是 0.x Beta，小步发布，**不设 1.0**。

### 3.2 0.8.0 任务明细

| 编号 | 内容 | 状态 | 证据 |
|---|---|---|---|
| N1 | 真机回归：发送、粘贴、长按、横屏、音乐、设备、文件、公告、市场 | **待复测**（唯一阻塞项）：0.7.2 反馈的 5 个问题已修（I-055~I-059），自动门全绿，未出包 | 修复记录 `work-logs/2026-10-28-0.8.0-n1-fixes.md`；复测结果写到 `workspace/work-logs/<日期>-0.8.0-n1-device.md` |
| N2 | 行为测试 + CI | 已完成 | `android/tools/behavior.test.js`（7 项）、`.github/workflows/ci.yml` |
| N3 | 发布工程：签名策略、敏感信息扫描、`latest.json` 一致性 | 已完成 | `tools/scan-secrets.js`、`tools/check-release.js`、`DEC-003` |
| N4 | 清理：市场 MC 遗留、`via_ai_history`、过期迁移基线 | 已完成 | N4-001/002，behavior 测试守护 |
| N5 | ADR：AstrBot 对齐、开放运行时 | 已完成 | `DEC-004-astrbot-alignment.md`、`DEC-005-open-plugin-runtime.md` |
| — | Kotlin 单测 | **暂缓到 0.9** | 现有逻辑绑在 Android 依赖上，需先拆纯函数（I-025） |

### 3.3 历史阶段的遗留验收（不阻塞 0.8 的自动测试）

| 编号 | 内容 | 状态 |
|---|---|---|
| G2-005 | 任务粘性 + 30 分钟能力组授权 + 工作区复用 | 代码完成，真机待验 |
| G4 | 音乐真实源（GD Studio / Meting）、302/403/429、离屏播放、公共目录 | 代码与 smoke 完成，真机待验 |
| G5 | DeviceTask「打开应用 → 点击 → 输入 → 返回」、分辨率/刘海屏 | 代码完成，真机待验 |
| G7 | Android 11+ 公共存储、厂商文件管理器、快照/回滚 | 代码完成，真机待验 |
| I-048 | 长按菜单 / 复制粘贴在 Android 10+ 窗口焦点下的表现 | 已修，真机待确认 |
| I-055~I-059 | 0.7.2 真机反馈：粘贴复制、横屏退出、音乐工具、设备发送、任务模式不调工具 | 已修（自动），真机待复测 |

### 3.4 明确延期或不做

| 项 | 结论 |
|---|---|
| G6 FullscreenActivity | 已彻底删除，不再排期 |
| Root / Shizuku | 延期，需单独批准（原 G8-002/003） |
| 外部 Agent 下载执行 | 0.15 之后再评估（原 G9） |
| MC 手机版（基岩版） | 先做 Java + Mineflayer |
| 多账号 QQ / 市场评分评论 | 稳定后再评估 |

## 4. 平台化设计约束（写代码前必读）

完整规范见 `plans/PLATFORM-0.8-0.15.md` 第 1、3、5、7 节。要点：

1. **聊天永远是首页**；面板/插件/设置都是可返回的次级入口。
2. **开放运行时**：宿主只提供 `Surface + Component + Action + Event + Adapter` 五类原语，
   不预设插件类型；插件可以创建宿主没有的页面、入口、会话类型、命令、后台任务、适配器。
3. **声明式优先**：0.10/0.11 用结构化组件树，禁止注入 DOM/CSS/JS；0.15 才开放沙箱 HTML。
4. **动作即权限**：每个 surface/action 绑权限，未知组件降级渲染，单插件可停用。
5. **会话级自动确认**：普通操作按会话自动确认；密码/支付/卸载/发送/删除外部文件/Root/Termux 仍逐次确认。
6. **核心不回归**：应用自身的聊天、文件、设备、音乐能力不能被插件平台改坏。

## 5. 验证门（每次改代码都要跑，顺序不能变）

```bash
cd android
node tools/build-html.js --check   # 源码模块与 index.html 一致
node tools/smoke.js                # 冒烟，全绿才算过
node tools/behavior.test.js        # 行为测试（历史隔离/市场/迁移/授权）
node tools/check-release.js        # release/latest.json 与本地产物一致
node tools/scan-secrets.js         # 敏感信息扫描
./build.sh assembleDebug           # Debug 构建成功
```

CI（`.github/workflows/ci.yml`）跑前 5 条 + Gradle 构建。
任一步失败，阶段不得标记完成。

## 6. 本轮（0.8 收口）实际改了什么

1. **N4-001**：删除 `PLUGIN_MARKET_INDEX` 里的 Minecraft 条目，市场只保留 `text-tools`。
2. **N4-002**：非聊天/设置/更新路径统一走 `saveHistory()`；全局 `via_ai_history` 只由聊天任务镜像；
   删除 `build-html.js --verify-migration` 与 `.migration-baseline.sha256`。
3. **N3**：新增 `check-release.js`（tag/URL/资产/SHA 一致性）、`scan-secrets.js`（令牌/私钥/凭据）；
   修正 `release/latest.json` 误指向私有仓库的问题；`DEC-003` 定稿 Beta 期不分离签名。
4. **N2**：新增 `behavior.test.js`，并在 `harness.js` 导出 `saveHistory` 等内部符号。
5. **N5**：新增 `DEC-004`（AstrBot 对齐取舍）、`DEC-005`（开放插件运行时）。
6. **工程**：新增 `tools/handoff.sh` 与 10 步版本流程（第 9 步固定打包）；CI 新增 `checks`/`build` 两个 job。

### 6.1 0.9.0（E1 + E2）代码完成清单

| 编号 | 内容 | 落点 |
|---|---|---|
| E2-001~003 | Provider 注册表（openai/anthropic/gemini/custom）、8 种能力标签、用途绑定并回填旧扁平字段 | `scripts/02b-providers.js`；`chatReq()` 未改 |
| E2-005 | 连接测试（`GET /models`、延迟、错误码） | `02b-providers.js` + 设置 → 模型中心按钮 |
| E2-008 | 本地用量统计（按天/Provider/任务）、限额拦截、重置 | `scripts/02c-usage.js`、`09-ai-request.js`、`02-config.js` |
| E2-004 | 密钥安全沿用 0.8 的 Keystore 密钥仓；`sSet` 剔除 Key 字段、先写密钥仓 | `SecretsVault.kt`、`02-config.js` |
| E1-004 | 设置五分组页签：AI 与模型 / 外观 / 权限 / 工作区 / 高级 | `scripts/14-update.js`、`template.html`、`main.css` |
| E1-003 | 会话级自动确认：同任务 30 分钟、切任务失效、审计事件 | `scripts/03-state-tasks.js` |
| E1-001/002 | 聊天首页固定 + 返回栈逐层回退 + 原生返回优先收抽屉 | `scripts/15-views.js`、`16-permission-boot.js` |
| E1-006 | 运行状态条（心跳秒数、当前目标、停止按钮，不遮挡输入） | `15-views.js`、`12-send-quick.js`、`template.html` |
| 守护 | smoke 新增 2 组断言、behavior 新增 4 组用例；`harness.js` 导出新符号 | `tools/` |

未做（按用户指令/范围冻结）：E2-006 插件配置档、E2-007 主 AI 调度子模型、E2-009 回退链 → 随 0.10/0.11 插件运行时一起做。
Kotlin 单测（I-025 纯函数拆分）仍未开始。


## 7. 已知红线

1. 不把 Debug 包当正式发布包；发布必须有签名、SHA-256、真机记录。
2. 插件拿不到原始 `Android.*` 桥、Root、Shizuku、任意 shell。
3. 屏幕/网页/文件内容是不可信数据，不得覆盖安全规则。
4. 未提交就别说“已推送”；没有证据就把状态写成“待验”，不写“已完成”。
5. 测试失败先修代码或修断言，不允许放宽检查让 smoke 变绿。
6. 工作转移包含 `android/keystore/`，只用于内部转移，不要公开分发。

## 8. 接手第一天建议动作

1. 跑第 5 节 6 条命令，确认基线全绿（尤其 `behavior` 与 `check-release`）。
2. 读 `plans/PLATFORM-0.8-0.15.md` 第 10.1 节，确认 0.8 只剩 N1。
3. 装 `apk/ElysiaFloat-v0.7.2-debug.apk`（可覆盖 0.7.x），按 N1 清单验证，
   结果写到 `workspace/work-logs/<日期>-0.8.0-n1-device.md`。
4. N1 通过后：升 versionCode 18 / versionName 0.8.0 → 构建 → `SHA256SUMS` → tag/Release
   → 匿名下载验证 → `tools/handoff.sh --version 0.8.0` 打包。
5. 0.9.0 已代码完成，下一步直接开 0.10.0（E3 开放式插件运行时），
   按 `plans/PLATFORM-0.8-0.15.md` 10.3 节与 10 步流程推进；不要回头改 0.8 已冻结的 N2~N5。
   真机验证仍等用户方便时统一做（0.8 N1 与 0.9 E1/E2 一起验）。

## 9. 已收敛的遗留（此前登记，现已修复）

- 前端迁移期校验已完成：过期基线已删除，`--verify-migration` 不再存在，构建门为 `--check`；
- 应用内更新检查读取公开仓库 `release/latest.json`，已指向 v0.7.2；私有仓库不再作为更新源；
- 私有仓库匿名访问仓库/Release/资产一律 404（已实测），公开分发统一走 `xysy92ds/ElysiaFloat`，
  私有 Release 仅作内部归档；
- `via_ai_history` 已收敛：非聊天路径统一走 `saveHistory()`，全局键只由聊天任务镜像；
- 内置市场索引已只保留 text-tools 示例，Minecraft / Termux 内联条目已删除。

## 10. 非阻塞遗留

- GitHub Release `v0.7.0` 的资产仍是 versionCode 14 的旧包，发布说明顶部已加缺陷警告；
- `runtime/`、`release/` 的历史产物只做归档，不要当作当前可复现构建；
- 公开仓库克隆 `elysia-public-git` 的 CI 里仍在用 `./gradlew`，而该仓库无 wrapper，
  需要改为 `gradle`（未验证过该 workflow）。
