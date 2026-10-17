# 综合问题审计与修复方案

日期：2026-10-16
状态：已完成代码和文档审计；本轮只整理问题和任务，不进行功能修改、不提交 Git。

## 一、审计范围

检查对象：

- `android/app/src/main/assets/src/scripts/`
- `android/app/src/main/assets/src/styles/main.css`
- `android/app/src/main/assets/src/template.html`
- `android/app/src/main/java/com/elly/float/FloatService.kt`
- `android/app/src/main/java/com/elly/float/JsBridge.kt`
- `android/app/src/main/java/com/elly/float/AudioEngine.kt`
- `android/app/src/main/assets/src/scripts/02-config.js`
- `android/app/src/main/assets/src/scripts/03-state-tasks.js`
- `android/app/src/main/assets/src/scripts/10-music.js`
- `android/app/src/main/assets/src/scripts/12-send-quick.js`
- `android/app/src/main/assets/src/scripts/14-update.js`
- `android/app/src/main/assets/src/scripts/15-views.js`
- `android/app/src/main/assets/src/scripts/16-permission-boot.js`

本轮结论区分为：

- **代码已直接确认**：可以从当前源码明确定位；
- **真机待复现**：代码已有相关路径，但还需要设备日志或录屏确认；
- **架构问题**：不是单点 Bug，需要重构接口或任务生命周期。

---

## 二、问题总表

| 编号 | 分类 | 问题 | 当前判断 | 优先级 |
|---|---|---|---|---|
| P-01 | 音乐 | 缓存失败并显示 HTTP 302 | 已定位为下载链路没有可靠解析最终音频资源 | P0 |
| P-02 | 音乐 | 缓存文件用户不可见 | 已确认当前写入 App 私有 `filesDir/music-cache` | P0 |
| P-03 | 音乐 | API/来源不稳定 | 已确认当前 GD Studio、Meting、多公共实例和网易兜底混用 | P0 |
| P-04 | 窗口 | 全屏不是系统级真正全屏 | 已确认应用是 `TYPE_APPLICATION_OVERLAY` 悬浮窗，不是 Activity | P0 |
| P-05 | 任务 | 切换任务后聊天上下文混用 | 已有按任务存储，但旧全局 `history`、部分保存路径仍并存 | P0 |
| P-06 | 任务 | 清除上下文语义不清 | 当前同时存在当前任务清除、全局 legacy history、清除全部数据三条路径 | P0 |
| P-07 | 任务 | 翻译屏幕被创建为持久任务 | `doTranslateScreen()` 明确调用 `taskBegin('quick', ...)` | P0 |
| P-08 | 任务 | 没有长按删除/归档任务 | 当前只有暂停、继续、停止，没有删除和归档交互 | P1 |
| P-09 | 快捷功能 | “更多”打开后文字不可见/空白 | 代码已注册按钮，问题集中在菜单布局、层级、颜色和真机渲染，需复现确认 | P0 |
| P-10 | 屏幕 | 屏幕总结/要点/解释不可用 | 普通快捷功能依赖 `Agent 总开关 + L1 + 原生 L1 门禁`，与普通助手定位冲突 | P0 |
| P-11 | 设置 | 个性化/聊天人设看似消失 | 人设实际被放在后面的“屏幕翻译”分区中，折叠后用户看不到 | P0 |
| P-12 | 设置 | 个性化内容分组错误 | `sub-title` 不会创建独立设置分区，外观和人设被归入前一个 `sec-title` | P0 |
| P-13 | 普通体验 | 设置、音乐、文件、权限、更新等缺乏统一错误和状态反馈 | 多个模块各自实现，API、超时、错误码和降级规则不统一 | P1 |
| P-14 | API | 对话、视觉、翻译、音乐、插件分别使用不同请求路径 | 尚无统一 Provider/Request 层、重试策略和响应标准 | P1 |
| P-15 | Agent | 普通聊天、快捷任务、手机任务、工作任务仍共用部分全局状态 | 任务骨架存在，但执行器和上下文隔离还未完成 | P0 |
| P-16 | 发布 | 当前修复需要新增版本和真机验收 | 本轮不发布，先完成本地修复和测试 | P1 |

---

## 三、重点问题分析

### P-01～P-03：音乐系统

#### 当前实现事实

音乐搜索和播放当前分散在：

```text
GD Studio
Meting 多个公共实例
music.163.com 外链兜底
WebView URL 获取
Android MediaPlayer 原生播放
Android 私有文件缓存
```

当前 `mGetUrl()` 返回的是来源接口给出的 URL，`cacheMusic()` 随后直接用 `HttpURLConnection` 下载：

```text
mGetUrl()
→ URL
→ HttpURLConnection
→ 只接受 200～299
→ 写入 .mp3
```

问题：

1. 302 可能来自来源接口的再次跳转、签名地址或网易外链；
2. 当前缓存流程没有人工解析 `Location`，也没有确认最终响应是否为音频；
3. 没有校验 `Content-Type`、文件头和最小文件大小；
4. 可能把 JSON 错误响应或 HTML 页面保存成 `.mp3`；
5. 公共音乐 API 的 URL 可能短时签名过期；
6. 搜索、URL 解析、歌词和缓存没有统一来源选择策略；
7. `filesDir/music-cache` 是 App 私有目录，用户在文件管理器中看不到；
8. 没有缓存索引、歌曲名称、作者、大小、时间和失败原因展示。

#### 目标重构

参考 rcMusic 的“统一来源适配器”思路，但不直接复制实现：

```text
MusicService
├── SearchProvider
├── ResolveProvider
├── LyricProvider
├── DownloadResolver
├── CacheStore
├── PlaybackAdapter
└── SourceHealthMonitor
```

每个来源统一返回：

```json
{
  "source": "gd|meting|other",
  "id": "歌曲唯一标识",
  "name": "歌曲名",
  "artist": "作者",
  "durationMs": 0,
  "playUrl": "最终播放地址",
  "expiresAt": 0,
  "contentType": "audio/mpeg"
}
```

下载前必须：

1. 解析并跟随所有允许的 HTTP/HTTPS 重定向；
2. 限制最大重定向次数；
3. 检查最终 URL 协议和域名；
4. 检查响应状态；
5. 检查 `Content-Type`；
6. 检查 MP3/音频文件头；
7. 失败时不保留 `.part` 文件；
8. 给出来源、HTTP 状态和失败原因；
9. 对短时签名 URL 不保存 URL，只保存本地音频。

#### 缓存目录目标

建议用户可见目录：

```text
Music/ElysiaFloat/
├── cache/
├── index.json
└── failed.log
```

App 私有目录只保存下载临时文件和索引备份；最终缓存使用 Android 公共媒体/文件存储方式。设置中显示：

- 缓存歌曲数量；
- 总大小；
- 当前目录；
- 清理全部；
- 删除单曲；
- 下载进度；
- 离线可播放状态。

### P-04：真正全屏

#### 当前原因

当前主界面由：

```kotlin
WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
```

创建，是悬浮窗服务窗口。即使增加：

```text
FLAG_FULLSCREEN
FLAG_LAYOUT_IN_SCREEN
FLAG_LAYOUT_NO_LIMITS
SYSTEM_UI_FLAG_IMMERSIVE_STICKY
```

它仍然不是 Activity 的全屏窗口。悬浮窗受 Android 系统和厂商 ROM 的 overlay 限制，不能可靠地保证“屏幕上只有本应用”。

#### 正确方案

新增真正的 `FullscreenActivity`：

```text
点击全屏
→ 暂存悬浮窗状态
→ 启动 FullscreenActivity
→ 使用 edge-to-edge / immersive sticky
→ 使用屏幕真实宽高和窗口 Insets
→ 显示同一套 WebView/聊天状态
→ 返回时关闭 Activity 并恢复悬浮窗
```

全屏 Activity 要负责：

- 隐藏状态栏和导航栏；
- 使用真实窗口尺寸；
- 根据横竖屏和 Insets 重新布局；
- 宽屏、长屏、正方形屏幕自适应；
- 不复制第二份聊天历史；
- 返回键退出全屏而不是关闭任务；
- 退出时恢复原悬浮窗位置和尺寸。

注意：全屏 Activity 与悬浮窗不是同一窗口，必须使用共享的 `TaskStore`/状态层，不能复制一份全局 `history`。

### P-05～P-08：任务和上下文

#### 当前问题

现在同时存在：

```text
via_ai_history
via_ai_history_task_<id>
TASKS[].context.messages
```

部分路径写入任务历史，部分路径仍写入全局历史：

- `saveHistory()` 对聊天任务有任务更新，但仍写 `via_ai_history`；
- 设置、插件、记忆总结等模块仍直接写 `via_ai_history`；
- `clearAll()` 使用 `localStorage.clear()`，会清除全部任务、全部任务历史和全部设置；
- 翻译屏幕主动 `taskBegin('quick', ...)`，因此一次翻译会留下任务；
- 任务没有真正的删除、归档和长按操作。

#### 目标语义

必须区分：

1. **清除当前任务对话**：只清当前任务的文本上下文，不删任务，不删文件，不删记忆；
2. **清除当前任务**：停止任务、删除或归档任务，是否删除文件必须单独确认；
3. **清除所有聊天上下文**：明确列出任务数量，逐个清理所有任务历史，但保留配置和文件；
4. **清除全部数据**：保留现有高级危险入口，清除配置、聊天、任务、记忆、收藏；必须明确警告，不由普通“清空聊天”触发；
5. **快捷翻译/总结/要点/解释**：使用临时 `QuickOperation`，默认不进入持久任务舱；只有用户选择“保存为任务”才创建任务。

#### 任务删除交互

建议：

- 长按任务 600～800ms 弹出操作菜单；
- 菜单提供：重命名、暂停/继续、归档、删除上下文、删除任务；
- 删除工作任务时分开确认：
  - 只删除任务记录；
  - 同时删除任务工作区；
- 左滑或更多按钮作为无长按设备的备用操作；
- 已归档任务不进入默认列表，但可恢复。

### P-09：更多菜单空白

#### 当前代码事实

`renderActions()` 确实插入：

```text
要点
解释
清空
```

`quick-extra` 也有 `display:flex` 和按钮结构。

#### 当前风险点

- 菜单嵌套在悬浮窗第二行，且绝对定位；
- 需要检查是否被父窗口、WebView 视口或层级裁剪；
- 需要检查按钮文字颜色和背景对比度；
- 需要检查真机 WebView 是否支持当前 `closest()` 和模板结构；
- 更多菜单打开后没有明确的全屏浮层和点击外部关闭；
- 目前没有自动化 UI 截图测试。

#### 修复目标

将“更多”改为独立操作面板：

```text
点击更多
→ 在第二行下方展开固定高度菜单
→ 使用不透明背景和明确文字颜色
→ 根据窗口宽度自动换行
→ 点击外部关闭
→ 菜单中的清空操作单独确认
```

### P-10：屏幕总结不可用

#### 已确认的代码原因

快捷操作 `handleQuickAction()` 要求：

```javascript
hasA11y() && agentReadOn()
```

而 `agentReadOn()` 又要求：

```javascript
CONFIG.agentEnabled === true
```

原生 `PermissionBridge.getScreenText()` 还使用：

```kotlin
AgentPolicy.check(ctx, "L1")
```

因此用户即使只想使用普通的“一次性总结屏幕”，也必须打开 Agent 总开关。这个实现与产品设计的“普通助手能力”和“手机控制 Agent”分离相冲突。

另一个限制是：快捷总结只读无障碍文本：

```javascript
readScreenText()
```

它不自动使用：

- 节点树摘要；
- 截图；
- 视觉模型；
- 无障碍不可读页面的降级提示。

#### 目标修复

建立独立的 `screen_read_once` 能力：

```text
普通助手授权：一次性读屏
Agent 授权：持续/多步手机控制
```

普通屏幕总结只需要：

- 无障碍权限；
- 用户主动点击按钮；
- 只读一次；
- 不进入长期 Agent；
- 不需要 L3、安全开关或白名单操作权限。

如果无障碍文本为空：

1. 明确提示当前页面没有可读节点；
2. 若用户开启 L2，则询问是否截屏识别；
3. 若没有视觉模型，提示配置识图模型；
4. 不把剪贴板当作屏幕内容。

### P-11～P-12：个性化设置错位

#### 当前代码原因

`renderSettings()` 中：

- 姓名、头像、取景、聊天轮数位于“个性化与聊天风格”；
- 主题色和自定义聊天人设位于后面的 `sub-title`；
- `organizeSettingsSections()` 只把 `.sec-title` 当作新分区；
- `sub-title` 不会创建新分区。

因此“外观”和“自定义聊天人设”实际上会被归入前一个正式分区“屏幕翻译”中。用户折叠屏幕翻译后，就会误以为人设和外观丢失。

#### 目标结构

把以下内容连续放进同一个正式分区：

```text
个性化与聊天风格
├── 助手名
├── 头像
├── 头像取景
├── 聊天上下文轮数
├── 主题色 1
├── 主题色 2
└── 自定义聊天人设
```

不要使用跨越多个 `sec-title` 的隐式归属。每个设置分区必须由明确的 DOM 容器生成，避免依赖相邻标题推断。

### P-13～P-14：普通功能和 API 体系

当前普通功能存在共同问题：

- API 请求逻辑分散在聊天、视觉、翻译、插件、音乐和更新模块；
- 每个模块超时、错误解析、重试和状态提示不一致；
- 音乐有多个公共源，翻译使用微软免费接口，视觉和聊天又使用模型接口；
- 没有统一的请求 ID、取消、重试、错误码、响应大小限制和来源健康状态；
- 普通用户看到的是“失败”，但看不到是网络、权限、来源、模型还是格式错误。

#### 目标 API 层

```text
RequestManager
├── requestId
├── timeout budget
├── cancel
├── retry policy
├── redirect policy
├── response validation
├── size limit
├── error normalization
├── source health
└── audit (no secrets)

ProviderRegistry
├── ChatProvider
├── VisionProvider
├── TranslationProvider
├── MusicProvider
├── PluginProvider
└── UpdateProvider
```

统一错误结构：

```json
{
  "ok": false,
  "code": "HTTP_REDIRECT|TIMEOUT|AUTH|NO_MEDIA|NO_TEXT|PERMISSION|PARSE",
  "message": "用户可读说明",
  "source": "gd|meting|everyapi|microsoft",
  "retryable": true,
  "debug": {
    "status": 302,
    "requestId": "..."
  }
}
```

不得把 API Key、Cookie、完整 URL 查询参数或文件正文写入日志。

### P-15：Agent 任务统一

当前任务分类已经存在，但需要统一为三种运行实体：

```text
ChatSession
QuickOperation
AgentTask
```

其中 `AgentTask` 再分：

```text
DeviceTask
WorkspaceTask
ExternalTask
```

屏幕翻译、总结、要点、解释、放歌不默认进入 `AgentTask`，而是 `QuickOperation`。只有用户主动“保存为任务”才进入任务舱。

所有任务必须统一拥有：

- id；
- type；
- state；
- contextRef；
- deadline；
- cancelToken；
- permissions；
- events；
- artifacts；
- error。

---

## 四、统一 Agent 任务板

### A-001：任务/上下文隔离

状态：`进行中，存在全局历史残留`

范围：

- 清理 `via_ai_history` 对非聊天任务的依赖；
- 所有 `saveHistory()`、记忆总结、插件切换和配置导入路径使用任务上下文；
- 明确当前任务清除、全部上下文清除、全部数据清除的边界；
- 增加任务级迁移测试。

验收：切换 A/B/C 任务后，历史、清空和重启均不串线。

### A-002：QuickOperation 分离

状态：`未完成`

范围：

- 翻译、总结、要点、解释、放歌改为临时操作；
- 不进入持久任务舱；
- 有独立 requestId 和 timeout；
- 完成后只保存结果，不创建任务记录；
- 用户可选择“保存为任务”。

验收：点击翻译屏幕不会在任务舱新增长期任务。

### A-003：设备一次性读屏

状态：`未完成`

范围：

- 从 L1 Agent 中抽离 `screen_read_once`；
- 普通助手点击总结屏幕时可调用；
- 不需要 L3、安全开关或白名单操作权限；
- 空节点时提供截屏/视觉降级；
- 不读取剪贴板冒充屏幕。

验收：不开 Agent 总开关但开启无障碍时，用户主动点击总结屏幕可以工作。

### A-004：手机 DeviceTask

状态：`基础骨架`

范围：

- find_app、launch_app、click、input、swipe 的单动作状态机；
- 白名单和前台应用检查；
- 动作后状态验证；
- 高风险确认；
- 重复动作熔断；
- 任务暂停和取消。

### A-005：WorkspaceTask

状态：`基础工作区已完成，生命周期未完成`

范围：

- 任务目录、文件索引、快照；
- 上传归属；
- input/working/output/logs；
- 修改清单；
- 回滚；
- 暂停、恢复和归档。

### A-006：统一 RequestManager

状态：`未完成`

范围：

- 所有 API 入口统一；
- requestId；
- 取消；
- 分阶段 timeout；
- 302/3xx 处理；
- 重试策略；
- 响应大小和 MIME 校验；
- 错误码和来源状态。

### A-007：音乐 Provider/Cache 重构

状态：`问题已定位，未重构`

依赖：A-006。

范围：

- 参考 rcMusic 设计来源适配器；
- 搜索、解析、歌词、下载分离；
- 自动解析最终音频 URL；
- 302/403/429/签名过期处理；
- 音频 MIME/文件头校验；
- 公共可见缓存目录；
- 缓存索引和删除单曲；
- 下载进度、重试和离线播放。

### A-008：真正全屏 Activity

状态：`当前 overlay 实现不满足要求`

范围：

- FullscreenActivity；
- 全屏系统栏控制；
- edge-to-edge 和 Insets；
- 屏幕形状自适应；
- 与悬浮窗共享 TaskStore；
- 返回键恢复悬浮窗；
- 真机验证。

### A-009：主界面更多菜单和快捷功能

状态：`代码存在，真机表现异常`

范围：

- 重做更多菜单为独立面板；
- 修复文字为空白；
- 增加外部点击关闭；
- 增加清空当前上下文入口；
- 根据模式动态显示快捷操作；
- UI 截图回归测试。

### A-010：设置页面分区修正

状态：`结构问题已定位`

范围：

- 个性化、外观、上下文轮数、聊天人设放入同一明确 section；
- 不使用跨 section 的 `sub-title` 隐式归属；
- AI、聊天助手、Agent、插件、权限分区清晰；
- 长页面滚动和返回一致；
- 保存和取消语义清晰。

### A-011：任务删除和归档

状态：`未完成`

范围：

- 长按 600～800ms；
- 重命名；
- 归档；
- 删除上下文；
- 删除任务记录；
- 删除工作区二次确认；
- 左滑/更多按钮备用入口。

### A-012：普通功能体验收尾

状态：`未完成`

范围：

- 音乐搜索和播放错误反馈；
- 屏幕总结/翻译；
- 文件上传格式；
- 权限引导按功能触发；
- 更新检查；
- 插件和记忆入口；
- 统一加载、空状态、错误和重试界面。

### A-013：Termux/Root/Shizuku

状态：`协议或骨架存在，真实能力未完成`

范围：

- Termux 结果回传和进程控制；
- Root 受控 Worker；
- Shizuku 授权和 Binder；
- 任务级取消和审计；
- 不允许插件直接获取原始权限句柄。

### A-014：外部 Agent

状态：`通用注册骨架，具体适配暂缓`

范围：

- 外部 Agent 下载、校验、隔离、启动、停止、卸载；
- 工作区绑定；
- DSH 具体适配等用户后续指令。

---

## 五、实施顺序

```text
P0 修复任务/上下文语义、QuickOperation、一次性读屏、更多菜单
↓
P1 修复设置分区、任务删除/归档、普通功能体验
↓
P2 重构 RequestManager 和音乐 Provider/Cache
↓
P3 实现真正 FullscreenActivity
↓
P4 完善 DeviceTask / WorkspaceTask / Agent 状态机
↓
P5 Termux/Root/Shizuku 真实执行和取消
↓
P6 外部 Agent（DSH 继续等待用户指令）
```

每个阶段必须：

1. 更新任务板状态；
2. 运行 HTML 构建检查；
3. 运行冒烟测试；
4. 运行 Android 构建；
5. 记录 APK 和 SHA-256；
6. 标记真机待验项；
7. 不把骨架写成完整功能。

---

## 六、当前结论

当前最核心的问题不是单个按钮，而是三个边界仍未彻底统一：

```text
普通助手能力 ≠ 手机 Agent
QuickOperation ≠ 持久任务
悬浮窗 Overlay ≠ 真正全屏 Activity
```

在这三个边界明确前：

- 屏幕总结会被错误地依赖 Agent L1；
- 翻译会被错误地写入任务舱；
- 清除上下文会出现全局/任务级混淆；
- 全屏会继续停留在放大悬浮窗；
- 音乐下载会继续受不稳定公共 URL 和 302 影响。

下一轮应从 P0 开始，不先增加更多高权限能力。
