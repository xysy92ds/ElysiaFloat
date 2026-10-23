# 交接说明（Handover）

更新时间：2026-10-24
当前阶段：0.7.2 内测包已构建、自动验证通过、已推送并上传 Release；真机验证待做
最新测试包：`apk/ElysiaFloat-v0.7.2-debug.apk`（versionCode 17 / versionName 0.7.2）
SHA-256：`b74756e021a9e3066b7e2eda18e0c0d19b13a8435bac2ac239083dd08aca848d`

## 1. 一句话现状

ElysiaFloat 是一个 Android 悬浮窗 AI 助手（聊天 + 手机 Agent + 文件工作区 + 插件平台）。
0.7.2 已提交并推送到私有仓库 `xysy92ds/ElysiaFloat-v0.7`，Release 资产与源码快照同步；
前端已拆分为 `android/app/src/main/assets/src/`，
构建时由 `tools/build-html.js` 合并生成单文件 `index.html`。

## 2. 代码与文档的权威入口

| 用途 | 位置 |
|---|---|
| 唯一执行计划（阶段/依赖/出口） | `workspace/plans/MASTER-EXECUTION-PLAN.md` |
| 唯一问题总表（编号/证据/状态） | `workspace/issues/ISSUE-REGISTER.md` |
| 工作区导航与事实快照 | `workspace/STATUS.md` |
| 执行证据 | `workspace/work-logs/` |
| 用户确认/产品取舍 | `workspace/discussions/` |
| 长期规则 | `workspace/decisions/` |
| 测试版 APK | `apk/phases/`（同目录带 `-SHA256SUMS`） |
| 稳定技术文档 | `docs/` |

## 3. 已验证可用的能力

- 悬浮窗、小球、胶囊、迷你播放器；
- 多模型/多服务商对话，Function Calling 多轮工具；
- 长期记忆（概览 + 按需检索）；
- 插件：Manifest v1、权限声明、JS 沙箱、HTTP 插件、工具开关、本地/远程市场；
- Agent：L1/L2/L3、应用白名单、无障碍读屏、截屏、动作执行、重复动作熔断；
- 文件工作区：input/working/output/logs/snapshots、索引、写入前快照、回滚；
- 音乐：多源搜索 + 分页、播放、歌词、收藏、历史、队列、缓存面板、下载进度、单曲删除、主题跟随；
- 设置：单一保存按钮，保存链路 null 安全，异常可见。

## 4. G2 这轮实际做了什么

1. 运行上下文隔离：`ChatSession` / `QuickOperation` / `AgentTask` 各自携带显式任务；
   `chatReqTools`、`execTool`、`buildTools`、插件宿主调用都改用显式任务，不再隐式读 `currentTask()`。
2. 任务状态机：新增 `TASK_TRANSITIONS`，非法迁移记录 `INVALID_STATE_TRANSITION` 并保留原状态。
3. 取消边界：`ACTIVE_RUN_TASK_ID`、模型请求 taskId 绑定、运行令牌、插件沙箱挂起取消、截图等待取消。
4. 长任务预算：非聊天任务默认 1200 秒（20 分钟），设置上限 7200 秒；旧 90 秒配置自动迁移。
5. 工具轮数：`0 = 按任务时间`，不再退化成 5；设置 UI 增加对应选项。
6. 插件能力：新增 `read_screen_once`、`music.control`；插件面板 / Agent tools Schema / 提示词三处一致，单项开关互不误伤。
7. 设置页：移除重复的悬浮保存按钮；底部操作条 `sticky bottom:28px`（随时可点，避开 22px 窗口缩放热区）；
   修复 `#set-gd-api` 缺失导致的保存静默失败；27 处读取改为 null 安全。

## 5. 验证门（每次改代码都要跑）

```bash
cd android
node tools/build-html.js --check   # 源码模块与 index.html 一致
node tools/smoke.js                # 全部通过才算过
./build.sh assembleDebug           # 构建成功
```

当前三项全绿。smoke 里已包含：音乐解析/面板、插件权限与沙箱、G2 上下文与取消、
长任务预算、设置保存控件存在性、缩放遮挡回归、引导页与 WebView 分级等。

## 6. 未完成 / 待设备验证

**设备验证（不能靠本地测试替代）**

- 0.7.1 已验证通过（2026-10-20）：发送、横屏、公告、插件市场；
- 0.7.2 待验：工作任务内直接操作手机不再切任务/不再重建工作区；30 分钟授权复用与失效；
  密码/发送/支付/卸载/外部删除仍逐次确认；长按菜单与复制粘贴（I-048）；
- 真机插件面板看到音乐组并生效；带 `music.control` / `device.read` 的第三方插件授权允许与拒绝；
- 长任务暂停/恢复/停止、跨重启恢复；
- 音乐真实源（GD Studio / Meting）、302/403/429/签名过期、离线与息屏播放、公共目录可见性；
- 文件写入/快照/回滚在 Android 11+ 与厂商文件管理器的表现。

**代码待做（按计划顺序）**

- 复制粘贴与输入法焦点：0.7.2 已修「菜单项被 touchend 提前隐藏」，真机还需确认
  selection 与系统剪贴板在 Android 10+ 窗口焦点下的表现；
- G2-005 安全确认精简：0.7.2 已实现任务粘性 + 能力组授权（30 分钟/任务结束失效）+ 工作区复用；
  密码框/发送/支付/卸载/外部文件删除仍逐次确认；
- G4 尾：音乐真实源适配与真机收口；
- G5：DeviceTask 真机走通「打开应用 → 点按钮 → 输入 → 返回」；
- G7：文件能力真机收尾；
- G8：Termux token 校验 + run_id + 输出回传 + 取消；Root 审计与取消；Shizuku 真实接入；
- G9：插件签名根、撤销、审核流水线；外部 Agent 下载/哈希/启动/停止/回传；AstrBot 对齐；
- G10：Release 签名分离、CI、真机矩阵、更新索引指向实际发布 APK。

**已删除，不再排期**

- G6 FullscreenActivity（用户 2026-10-17 决定彻底删除，代码/Manifest/桥接口/样式均已清理）。

## 7. 明确的红线

1. 不把 Debug 包当正式发布包；发布必须有签名、SHA-256、真机记录。
2. 不扩高权限能力（Root/Shizuku/外部 Agent）在 G3 之前。
3. 插件拿不到原始 `Android.*` 桥、Root、Shizuku、任意 shell。
4. 屏幕/网页/文件内容是不可信数据，不得覆盖安全规则。
5. 未提交就别说"已推送"；没有证据就把状态写成"待验"，不写"已完成"。
6. 测试失败时先修代码或修断言，不允许为了让 smoke 变绿而放宽检查。

## 8. 接手第一天建议动作

1. 跑一遍第 5 节的三条验证命令，确认基线全绿。
2. 打开 `apk/ElysiaFloat-v0.7.2-debug.apk` 装机（可直接覆盖 0.7.x），先看公告标题是否为 0.7.2。
3. 按第 6 节设备清单走一遍发送、横屏、公告、插件市场。
4. 读 `workspace/issues/ISSUE-REGISTER.md`，把本轮新发现的问题补编号；下一步做覆盖窗口的复制粘贴。

## 9. 已知遗留问题（非阻塞）

- `node tools/build-html.js --verify-migration` 仍会失败：旧迁移基线已过期，`--check` 才是当前正确门；
- `release/latest.json` 已更新到 v0.7.2，但应用内更新检查读的是公开仓库的 v0.6.5 索引，
  私有仓库匿名不可读，内测期只能手动从 Release 下载（G10 处理）；
- `via_ai_history` legacy 写入仍存在于记忆/插件/导入等路径（G2-002 后续清理项）；
- GitHub Release `v0.7.0` 的资产仍是 versionCode 14 的旧包，已在发布说明顶部标注缺陷警告。
