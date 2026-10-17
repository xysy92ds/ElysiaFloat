# 工作记录：模型超时放宽 + G7-4 文件安全与权限统一

日期：2026-10-17
状态：两项完成；smoke 全绿；构建与产物核对通过

## 1. 模型请求超时放宽（生图/识图）

### 之前的问题

`chatReq` / `chatReqTools` / 识图都写死 `200000ms`（200 秒），而且 `retries: 2`。
生图和长推理经常超过 200 秒 → 直接超时；即使重试，用户还要再等一轮。

### 现在

- 新增 `CONFIG.modelTimeoutMs`，默认 **600000ms（10 分钟）**，可调范围 60s~1800s；
- 新增 `modelTimeout()`：读配置并夹紧到 60s~30min；
- `chatReq`、`chatReqTools` 的模型预算、识图请求全部改用 `modelTimeout()`；
- 聊天任务的工具循环预算也从写死的 30s 改为跟随 `modelTimeout()`；
- **模型/识图请求 `retries` 从 2 降为 0**：600 秒超时再重试只会让用户多等一倍，
  失败时直接把错误码摊开更诚实（用户可手动重发）；
- 设置页「AI 与模型」新增「模型单次超时（秒）」，默认 600，上限 1800。

> 说明：任务级 `agentTaskTimeout`（默认 1200 秒）仍然生效，单次模型调用不会超过它。

## 2. G7-4：文件权限统一到 L1 / L2 / L3 + 安全开关

### 之前

文件工具全部挂在 `agentActionsOn()` 上（= L3 + 安全），
所以「在工作区里写个文件」也要先开 L3，和用户的心智不符。
另外 `workspace_export` / `workspace_preview` 这两个新工具**没进任何检查列表**，
等于绕过了门禁（自己审查时发现的）。

### 现在

三个清单 + 分级：

```js
FILE_READ_TOOLS      = status/create/list/read/preview + external list/read   → L1
FILE_WRITE_SCOPED    = write/mkdir/export                                     → L2（工作区内）
FILE_WRITE_EXTERNAL  = external write/copy/mkdir/delete                       → L3 + 安全开关
```

新增 `agentLevelAtLeast(level)`：

```js
L1 = agentEnabled && agentL1 !== false
L2 = agentEnabled && agentL2 !== false
L3 = agentEnabled && agentL3 === true && agentSafety === true
```

- `toolLive()` 用这套等级判定，**不再额外叠一层"动作开关"**；
- `buildTools()` 的暴露条件同步（否则面板显示和实际可用会不一致）；
- `hasAllFilesAccess()`（Android 的"所有文件访问"系统权限）仍然是前提，它属于系统授权，不归 L1/L2/L3 管。

结果：工作区读写不再需要 L3；工作区外的写入/删除依旧要求 L3 + 安全 + 逐次确认。

## 3. G7-4：原生文件安全

新增 `FileSafety.kt`：

| 组件 | 作用 |
|---|---|
| `AtomicWrite` | 先写 `.tmp-<nano>`，`fsync` 后再 rename 覆盖；rename 失败则复制兜底；任何情况下清理临时文件 |
| `SymlinkGuard` | 目标自身或**任一层父目录**是符号链接就拒绝（canonical 比较会漏掉"链接指向内部"的情况） |
| `SafeDelete` | 递归删除不跟随符号链接（只删链接本身）、限制节点数 20000、深度 32 |

接入点（`PermissionBridge`）：

- `agentWorkspaceWrite` / `agentExternalWrite` → 先 `SymlinkGuard.hasSymlink`，再 `AtomicWrite.write`；
- `agentExternalDelete` 的递归分支 → `SafeDelete.deleteTree`。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致（c3bb939f…）
node tools/smoke.js                全部通过
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增两组用例：

1. `G7-4：文件权限统一到 L1/L2/L3 + 安全开关`
   - L1 开、L2/L3 关：读可用、写不可用；
   - L1 关：读不可用；
   - L2 开、L3 关：工作区写入/导出可用，外部写入不可用；
   - L3 开但安全关：外部写入仍不可用；两者都开才可用；
   - Agent 总开关关闭：全部不可用。
2. `模型超时放宽 + 原生文件安全`
   - 默认 600000ms、可调到 1800000、低于下限夹到 60000；
   - 模型请求必须是 `modelTimeout()` + `retries: 0`；
   - 设置页有 `set-model-timeout`；
   - `FileSafety.kt` 三个组件 + 上限常量存在，`PermissionBridge` 真的调用了原子写/安全删除/符号链接检查。

产物核对：`assets/index.html` 含 `set-model-timeout / modelTimeout / agentLevelAtLeast / FILE_*`；
`classes3.dex` 含 `AtomicWrite / SymlinkGuard / SafeDelete / deleteTree`。

## 顺带修掉的一个门禁漏洞

`workspace_export` 和 `workspace_preview` 之前**不在任何 toolLive 分支里**，
会落到函数末尾的 `return true`，等于绕过 Agent 等级检查。
这次纳入 `FILE_READ_TOOLS` / `FILE_WRITE_SCOPED`，已被上面的用例覆盖
（测试里第一次失败就是因为它被新门禁挡住了，说明门禁真的生效）。

## 测试包

```text
apk/phases/ElysiaFloat-g7-4-filesafety-debug.apk
apk/phases/ElysiaFloat-g7-4-filesafety-debug-SHA256SUMS
```

SHA-256：`c8e332dc25e55ee87d32385dcd55000f03ed12711a3db6288fcc1b99efe1fd94`

## 真机待确认

1. 只开 L1 时：能读工作区、不能写；
2. 开 L2（不开 L3）：能在工作区写文件/导出，外部写入仍被拒绝；
3. 开 L3 + 安全：外部写入会弹确认；
4. 生图类请求不再 200 秒就断（可到 10 分钟），执行中仍能点停止；
5. 工作区里连续导出多个文件，内容完整（原子写生效，不会出现半截文件）。

## G7 状态

G7-1 / G7-2 / G7-3 / G7-4 全部完成。下一步按计划是 **G6 真正的 FullscreenActivity**。
