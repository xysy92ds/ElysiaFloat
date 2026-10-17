# ElysiaFloat 借鉴调研与下一阶段方案

更新时间：2026-10-07
状态：调研完成，方案待评审；P1/P2 收尾已随本轮实现
参考项目：`Zhou-Shilin/Aether`（扶摇）、DSH/Tdsh、Pi 扩展体系
适用对象：ElysiaFloat Android 端（`com.elly.assistant`）

> 本文回答三件事：
> 1. 同类项目里哪些做法值得直接借鉴，哪些不能照搬；
> 2. 怎么让 Agent 更少出错（可靠性、取消、超时、幂等、可追溯）；
> 3. 三个明确需求的落地方案：Termux 解除限制（含 Root/Shizuku）、更多上传文件格式、TDsh 式自动开启无障碍。

---

## 1. 调研对象与结论摘要

### 1.1 Aether（扶摇）的结构

Aether 是 Compose Multiplatform（Android/iOS/macOS）+ Pi Harness 内核的通用 Agent。与本项目直接相关的部分：

| 模块 | 文件 | 价值 |
|---|---|---|
| 运行时抽象 | `runtime/LocalRuntime.kt`、`runtime/RuntimeRouter.kt` | 统一多后端（Termux/Alpine），工具按 `environment` 路由 |
| Shell 工具 | `termux/TermuxBashTool.kt`、`runtime/RuntimeShellTool.kt` | run_id 管理、后台运行、日志轮询、kill、超时 |
| 文件工具 | `runtime/RuntimeFilesystemTool.kt`、`termux/TermuxFilesystemTool.kt` | read/write/edit/grep/find/ls 统一入口 |
| 手机操作 | `phoneuse/PhoneUseAccessibilityService.kt`、`data/AgentModeController.kt` | 无障碍 + Shizuku/Root 虚拟屏，权限状态机 |
| 特权进程 | `agentmode/AgentModeServiceStarter.kt`、`AgentModeServiceLauncher.kt` | 通过 `app_process` 起特权进程，token + 广播回传 Binder |
| Root 检测 | `data/RootSetupController.kt` | su 路径探测与状态枚举 |
| Agent 执行 | `data/pi/PiAgentRunner.kt` | 流式事件、工具并行/串行队列、取消传播、迟到任务清理 |
| 策略校验 | `data/PhoneUsePolicy.kt` | 权限请求节流、策略冲突校验、显式布尔参数校验 |

### 1.2 可借鉴且建议采纳

1. **运行时路由**：一个统一 `LocalRuntime` 接口 + `RuntimeRouter`，工具参数里带 `environment`，把 Termux/Alpine/Root 差异收敛到后端。
2. **run_id 生命周期**：长命令返回 `run_id`，支持 `fetch`（增量日志）与 `kill`，而不是一次阻塞等待。
3. **取消传播**：协程取消时用 `NonCancellable` 收尾并 kill 子进程，避免“前端停了、进程还在跑”。
4. **迟到回调清理**：任务结束时统一 `cancelAndJoin` 所有子任务、清空 pending 表。
5. **权限状态机**：`AgentModeAuthorizationIssue` 这类枚举把“未安装/未运行/未授权/拒绝/就绪”明确区分，UI 不靠猜。
6. **特权进程隔离**：用 `app_process` 起独立进程，通过 Binder + 一次性 token 回传，而不是把特权逻辑塞进主进程。
7. **策略参数校验**：`require(...)` 对模型传入的布尔/枚举参数做严格校验，非法直接拒绝，避免“静默降级”。
8. **事件驱动 UI**：`tool_call_start/delta/end`、`assistant_retry` 等事件流，让前端能显示真实进度。
9. **文件操作原子性**：写入走 `path.aether-tmp-<nanos>` 临时文件再改名，避免半截文件。
10. **扩展能力声明**：扩展带 Manifest 与权限，导入即校验（与本项目插件系统方向一致）。

### 1.3 不建议照搬

- Compose Multiplatform 与 Pi Harness 整体替换：改造成本过大，且本项目的 WebView + Kotlin 架构已可用。
- `Alpine + proot` 本地虚拟机：体积大、启动重，当前阶段用 Termux 更合适。
- 完全放开的高权限默认值：Aether 的虚拟屏/特权进程仍是显式授权，不能默认打开。
- 把 Agent 内核放到独立进程：本项目先保持同进程 + 严格取消，后续再评估。

---

## 2. Agent 可靠性方案（“确保不出错”）

把 Aether/Pi 的做法整理成可执行规则，逐条落到 ElysiaFloat。

### 2.1 执行模型

```text
UNDERSTAND → CHECK(权限/能力) → PLAN(2~4 步) → EXECUTE(单动作)
   → VERIFY(真实状态) → CONFIRM/REPLAN/COMPLETE/FAILED
```

- 单动作：一次只做一件会改变设备或文件状态的事；
- 动作后必验证：读屏/读文件确认结果；
- 有限重规划：同一目标最多重规划 1 次；
- 权限拒绝、白名单拒绝、空结果 → 不重试，直接结束并说明。

### 2.2 取消与超时（本轮已实现基础）

- 运行令牌 `RUN_TOKEN`：每次发送提升，旧令牌的回调与工具结果直接丢弃；
- 任务级 deadline：模型请求超时取“任务剩余预算”；
- `cancelTaskRequests(taskId)`：停止/暂停时断开进行中的 HTTP；
- 待补：截图等待、Termux 子进程、插件调用的统一取消。

### 2.3 幂等与去重

- 相同工具 + 相同参数 + 页面 hash 未变 → 第一次警告、第二次熔断（已实现）；
- 文件写入前快照（本轮 P1 已实现），失败可回滚；
- 设备动作优先级：文字/contentDescription → 控件 ID → 节点边界 → 坐标 → 截图视觉。

### 2.4 可追溯

- `logs/events.jsonl` 记录工具名、阶段、状态、错误码，不记录密钥与正文；
- 任务 `task.json` 保存状态、权限快照、产物列表；
- 新增：`snapshots/index.json` 记录快照来源、时间、hash。

### 2.5 结构化错误码

统一为：`PERMISSION_DENIED`、`WHITELIST_DENIED`、`NOT_FOUND`、`NO_CHANGE`、`REPEATED_NO_CHANGE`、`TIMEOUT`、`USER_CANCELLED`、`NETWORK_ERROR`、`HTTP_ERROR`、`RUNTIME_ERROR`、`INVALID_ARGUMENT`。

---

## 3. Termux：减少限制 + “解除全部限制”选项

### 3.1 现状

当前只允许固定执行器白名单（`python/node/git/rg/ffmpeg`）、固定参数、任务目录内外校验。安全但不够用。

### 3.2 灰度能力模型（建议采纳）

在“设置 → Agent 与工作台 → 高级运行时 → Termux”提供三级：

| 级别 | 名称 | 行为 |
|---|---|---|
| L0 | 关闭 | 不提供 Termux 工具 |
| L1 | 受控（默认） | 固定执行器白名单 + 参数校验 + 任务目录 |
| L2 | 完整 Shell | 允许 `bash -lc` 任意命令，但必须逐次确认并显示完整命令 |
| L3 | 解除全部限制 | 允许任意命令 + 任意工作目录 + 直接调用 Root/Shizuku，不再逐次确认（仅显示一次全局风险确认） |

实现要点：

- 级别存储于原生 `SharedPreferences`，默认 `L1`；
- 切换 `L2` 需一次确认；切换 `L3` 需输入确认词（如“我了解风险”）；
- `L2/L3` 仍写审计日志（命令、工作目录、退出码、耗时），但不阻塞；
- `L3` 下 Root/Shizuku 能力与 Termux 合并为一个“完全访问”开关，UI 上明确标红；
- 任何级别都不允许把用户文本直接拼进 `sh -c` 后不记录；记录命令原文便于事后核查；
- 插件默认最高只能拿到 `L1`；只有用户单独为某插件授权才可到 `L2`，`L3` 永不授予插件。

### 3.3 与 Root/Shizuku 的关系

```text
Termux L3（解除限制）
  ├── Termux: bash -lc 任意命令
  ├── Root: su -c（受审计，不阻塞）
  └── Shizuku: 通过 app_process 特权进程执行（复用 Aether 方案）
```

Root/Shizuku 在 L1/L2 下仍需逐次确认；只有 L3 才“解除全部限制”。

---

## 4. 更多上传文件格式适配

### 4.1 目标

当前仅支持：图片、纯文本类文件。需要扩展到常见文档与结构化数据。

### 4.2 支持矩阵（按解析方式分层）

| 层 | 格式 | 解析方式 | 依赖 |
|---|---|---|---|
| 直接文本 | `.txt .md .json .csv .tsv .log .xml .yaml .yml .ini .toml .html .css .js .ts .py .kt .java .c .cpp .h .sh .sql .srt .vtt` | 直接读取 | 无 |
| Office 压缩包 | `.docx .xlsx .pptx .odt .ods .odp` | 解压 `word/document.xml`、`xl/sharedStrings.xml`、`ppt/slides/*.xml` 提取文本 | 无（zip + XML 正则/解析） |
| PDF | `.pdf` | 文本层提取；无文本层则提示转图或需 OCR | 无（基础）/ 可选 OCR |
| 电子书 | `.epub` | zip + XHTML 提取 | 无 |
| 压缩包 | `.zip` | 列出文件清单，不自动解压全部 | 无 |
| 图片 | `.png .jpg .jpeg .webp .gif .bmp` | 走识图模型 | 现有 |
| 音视频元数据 | `.mp3 .mp4 .m4a .wav` | 只读元数据/时长，不做转写 | 无 |
| 二进制/未知 | 其它 | 只显示元数据，不进上下文 | 无 |

### 4.3 实现方式

1. 原生新增 `FileExtractor.kt`：
   - `detectMime(name, headerBytes)`；
   - `extractText(file, mime, maxBytes)` 返回 `{ ok, text, kind, truncated }`；
   - 单文件上限 5MB 文本、超出截断并标记；
   - 不执行宏、不执行嵌入脚本、不联网解析。
2. 上传流程：先按 MIME 分派，成功则进入 `att.kind='text'`，失败降级为 `att.kind='file'`（只带元数据）。
3. 工作任务：可解析文件直接导入任务 `input/`；不可解析文件只登记索引。
4. 安全：解析在本地进行；不把原始二进制发给模型；`zip` 只读清单，避免 zip bomb（限制条目数与解压总量）。

---

## 5. TDsh 式自动开启无障碍（需 Shizuku/root）

### 5.1 现状

用户必须手动进入系统设置开启无障碍。TDsh 通过 Shizuku 写入系统设置自动完成。

### 5.2 方案

```text
UI: 设置 → 权限与安全 → “一键开启无障碍（需 Shizuku/Root）”
  → 检查 Shizuku/Root 可用性
  → 读取 Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
  → 追加 com.elly.assistant/com.elly.float.EllyAccessibilityService
  → 写入 ENABLED_ACCESSIBILITY_SERVICES 与 ACCESSIBILITY_ENABLED=1
  → 回读校验并刷新本地状态
```

实现路径（与 Aether 特权进程一致）：

1. 新增 `AccessibilityAutoEnabler.kt`；
2. 通过 Shizuku `newProcess(["sh","-c","settings put secure ..."])` 或 Root `su -c`；
3. 组合已有配置：不能覆盖其它已启用的无障碍服务，必须“读取-合并-写回”；
4. 写回后校验，失败给出明确错误码（`SHIZUKU_NOT_READY`、`ROOT_DENIED`、`WRITE_REJECTED`、`VERIFY_FAILED`）；
5. 关闭同理，从列表移除本服务；
6. 该开关属于“解除全部限制（L3）”的显式能力之一，默认不展示给普通用户；
7. 必须在规划中预留：不静默开启，只在用户点击时执行，并显示将要写入的设置项。

### 5.3 前置条件

- Shizuku 已安装、已运行、已授权本应用；
- 或 Root 可用；
- Android 版本差异：部分 ROM 禁止第三方应用写 Secure 设置，需回退到“跳转系统设置页手动开启”。

---

## 6. 分阶段实施计划

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| N1 | Runtime 路由统一（`environment` 参数） | 现有 `CapabilityRuntime` | Termux/Root 工具走同一入口 |
| N2 | Termux run_id + fetch/kill + 增量日志 | N1 | 长命令可后台、可停止、可看日志 |
| N3 | Termux L2 完整 Shell（逐次确认） | N2 | 任意命令可执行且有审计 |
| N4 | 文件格式解析（文本/Office/PDF/epub/zip） | 无 | 每种格式有解析测试 |
| N5 | 上传流程接文件解析 + 任务导入 | N4 | 上传 docx/pdf 可读正文 |
| N6 | Shizuku 接入（状态、授权、特权进程） | N1 | 状态机枚举正确、可执行特权命令 |
| N7 | Root Worker 扩展（受审计命令） | N6 | su 可用时有日志、可取消 |
| N8 | 自动开启无障碍 | N6/N7 | 一键开启/关闭并校验 |
| N9 | Termux L3 解除全部限制 | N2/N3/N7 | 单项开关，审计不阻塞 |
| N10 | 插件执行隔离按级别收口 | N3/N9 | 插件默认 L1，不可自升 |

---

## 7. 本轮已完成的 P1/P2 收尾

### P1 收尾（工作区任务生命周期）

- `TaskWorkspace.index()`：任务文件索引（相对路径、大小、时间、hash）；
- `TaskWorkspace.snapshot()`：写入/覆盖前快照，落 `snapshots/` 并写 `snapshots/index.json`；
- `TaskWorkspace.listSnapshots()` / `restore()`：列出与回滚，回滚前自动再备份当前内容；
- 原生桥：`taskWorkspaceIndex`、`snapshotTaskFile`、`listTaskSnapshots`、`restoreTaskFile`；
- UI：任务抽屉显示当前工作区文件列表与最近快照，支持“回滚 / 刷新工作区”；
- `workspace_write` 在工作任务中写入前自动快照，结果附带快照名。

### P2 收尾（调度器可靠性）

- `RUN_TOKEN` 运行令牌：每次发送提升，旧轮次的模型/工具回调直接丢弃；
- `__gmCb` 校验令牌，迟到回调不再解析；
- 工具批次执行后再次检查令牌与停止标志，停止后不再进入下一轮；
- 失败/完成状态只在令牌未过期时写入，避免已取消任务被覆盖为完成。

### 仍未完成

- 截图等待、Termux 子进程、插件调用的统一取消；
- 模型流式输出；
- 完整状态机与失败重规划；
- N1～N10 全部未开始（本文为方案，尚未实现）。

---

## 8. 风险与边界

- **L3 解除限制是高风险能力**：仅本地设备、仅用户显式开启、必须留审计；不随插件传播；默认关闭。
- **自动开启无障碍**：不同 ROM 行为不一致，必须有手动回退，且不静默执行。
- **文件解析**：不执行宏/脚本、不联网、限制解压总量，防止 zip bomb 与恶意文档。
- **借鉴不等于照搬**：Aether 的 Compose/Pi 内核、Alpine 虚拟机、默认高权限均不采纳。

---

## 9. 变更记录

- 2026-10-07：新增本方案；完成 P1/P2 收尾（任务文件索引、快照、回滚、任务详情、运行令牌拒绝迟到回调）。
