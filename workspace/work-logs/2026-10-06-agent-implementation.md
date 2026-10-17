# 工作记录：Agent、工作区和限时观察第一轮实现

日期：2026-10-06
状态：代码实现和构建验证完成；真机验证尚未进行。

## 修改范围

当前只修改实验副本：`/workspace/EllyFloat`。没有修改 `/workspace/gh-ElysiaFloat`，没有提交或推送 Git 主仓库。

## 已实际实现

### 应用解析与白名单

- `PermissionBridge` 改为从 `ACTION_MAIN + CATEGORY_LAUNCHER` 查询真正可启动的应用。
- 应用列表返回用户可识别的应用标签和真实包名，只保留可启动应用。
- 新增 `findAgentApps()`，支持按应用名或包名查询。
- `agentLaunch()` 支持应用名、包名和旧 `package` 参数；多匹配时拒绝盲选；解析后再执行原生白名单校验。
- 设置页增加应用名/包名搜索。
- L1 读屏、浏览器地址、节点树和 L2 截屏入口补上原生 AgentPolicy 检查；截图拒绝时会结束 JS 等待，不会一直挂起。
- 操作完成后增加短暂等待，并把前台包名和可读文字摘要作为工具结果的一部分返回。

### 文件权限与工作区

- Manifest 增加 `MANAGE_EXTERNAL_STORAGE`，同时保留旧系统的存储权限声明。
- 增加“允许管理所有文件”状态检查和系统设置跳转。
- 工作区固定为：`Documents/ElysiaFloat/workspace`。
- 增加创建工作区、状态、列目录、读文本、写文本、建目录能力。
- 原生使用 canonical path，拒绝绝对路径、路径穿越和工作区外路径。
- Agent 文件读写还要求 Agent L3 和安全开关；工作区权限不会单独绕过手机 Agent 安全策略。
- 设置页和权限引导都增加工作区/所有文件权限入口。

### 工具调用与观察

- `agentToolRounds` 新增设置项：0 表示无限，另有 5/10/20/50 轮选项。
- 删除固定 `MAX = 5`；有限轮数来自设置。
- 发送按钮在任务运行时变为“停止”，用户可主动停止无限任务。
- 状态显示当前轮次和累计工具次数。
- 普通 Agent 开始工作不再自动变胶囊。
- 只有 `screenshot` 和 `watch_screen` 进入文字状态胶囊；截图/观察时主浮窗隐藏，完成后保留胶囊状态。
- 新增 `watch_screen`，限制 1 到 10 秒、每秒 1 到 2 帧，最多保留少量画面，不做后台无限监控。

### 输入法兜底

- 新增 `EllyInputMethodService` 和输入法 XML/Manifest 声明。
- 输入先尝试无障碍 `ACTION_SET_TEXT`，检测失败后尝试当前输入法连接。
- 设置页增加“配置输入法兜底”入口，提醒用户手动启用和切换；没有实现无提示自动切换默认输入法。

### 配置同步和版本

- 配置导入后立即调用 `syncAgentFlagsToNative()`。
- 普通备份不会导出或覆盖原生白名单。
- 数据清除逻辑没有修改。
- 实验版本更新为 `0.6.1-agent`、versionCode `11`。

## 实际验证

### 构建

命令：

```text
cd /workspace/EllyFloat && ./build.sh assembleDebug
```

结果：成功。

APK：

```text
/workspace/EllyFloat/app/build/outputs/apk/debug/app-debug.apk
```

已通过 APK 元数据核对：

- 包名 `com.elly.assistant`
- versionCode `11`
- versionName `0.6.1-agent`
- Manifest 包含 `MANAGE_EXTERNAL_STORAGE`
- Manifest 包含 `EllyInputMethodService` 和 `BIND_INPUT_METHOD`

### WebView 冒烟测试

命令：

```text
cd /workspace/EllyFloat && node tools/smoke.js
```

结果：全部通过，包含原有音乐、插件、记忆、设置、引导和 WebView 兼容测试。

### 后续补充检查

- 增加 Android 11+ `<queries>`，明确允许查询有桌面启动入口的应用，避免包可见性导致 QQ 查询为空。
- 将读屏、浏览器地址、截图工具的前端可用性与 Agent 开关对齐，原生侧仍保留最终拒绝检查。
- 工作区原生入口补充“工作区必须已经创建”的最终检查。
- 截图胶囊与快捷操作共存时增加完成状态清理，避免残留胶囊状态。
- 胶囊增加纯文字后的动态点（·、··、···）和完成提示点，不使用 Emoji。
- 扩展 `tools/smoke.js`，增加 Agent/工作区插件、应用查询、限时观察和无限轮数结构检查。
- 再次执行构建和冒烟测试，仍然成功、全部通过。

## 当前限制

- 没有连接真实 Android 设备，不能声称已经验证 QQ、白名单、特殊文件权限、输入法切换或无障碍操作。
- Android 11+ 的“允许管理所有文件”是系统特殊授权，必须由用户在系统设置中确认。
- Shizuku / Root 未实现，按用户要求暂缓。
