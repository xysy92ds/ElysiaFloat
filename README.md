# 爱莉希雅 · 浮窗助手（ElysiaFloat）

> 一个常驻在安卓屏幕上的粉色悬浮窗 AI 助手。
> 不占前台、不挡视线，随时能问、能看、能读屏、能翻译、能记事、能放歌。

- **安卓 App**（主项目）：`android/` — 纯 Kotlin 原生外壳 + WebView 粉红 UI，当前版本 **0.5.1**（versionCode 6）
- **浏览器用户脚本**（早期版本，功能较少）：`userscript/` — 见 [下文的区别说明](#浏览器用户脚本和-app-是什么关系)
- **成品安装包**：`apk/` 与 [Releases](https://github.com/xysy92ds/ElysiaFloat/releases)

---

## 目录

- [它是什么](#它是什么)
- [整体架构](#整体架构)
- [各模块是怎么实现的](#各模块是怎么实现的)
- [功能一览](#功能一览)
- [怎么用](#怎么用)
- [怎么构建](#怎么构建)
- [浏览器用户脚本和-App-是什么关系](#浏览器用户脚本和-app-是什么关系)
- [仓库结构](#仓库结构)
- [已知限制](#已知限制)

---

## 它是什么

ElysiaFloat 是一个**悬浮在任意应用上面**的 AI 助手窗口。它不是一个独立的聊天 App —— 你在刷视频、看文档、翻设置页的时候，点一下屏幕上那颗粉色小球，助手窗口就会展开，能直接：

- **看到你屏幕上的内容**（无障碍节点树 / 截屏 / 画面识图）
- **看懂并翻译整屏**，把译文直接贴回屏幕上原来的位置
- **长期记住你的事**（不是塞进对话历史，而是一个可以被检索的记忆库）
- 陪你聊天、放歌、朗读

角色设定是《崩坏 3》的爱莉希雅（Elysia）：粉白色调、句尾带 ♪、称呼你为「你呀」「小家伙」。系统提示词可以在设置里完整改掉，你也可以把它变成一个完全中性的 Assistant。

技术上它刻意保持**极简**：

| 项目 | 值 |
|---|---|
| 语言 | 100% Kotlin（原生）+ 单文件 HTML/CSS/JS（界面） |
| 第三方依赖 | **零**（`dependencies {}` 是空的，只用 Android Framework） |
| 包名 | `com.elly.assistant` |
| minSdk / targetSdk | 24（Android 7.0）/ 34（Android 14） |
| 有无 native `.so` | **无**，因此不挑 CPU 架构，armeabi 到 x86 一个包通吃 |
| APK 体积 | 约 2 MB |

> 没有 Gradle 依赖、没有 Jetpack Compose、没有 Room、没有 Retrofit、没有 OkHttp。
> 网络请求、存储、渲染全部手写，就是为了让这个常驻悬浮窗足够小、足够快、不被厂商省电策略盯上。

---

## 整体架构

这个项目本质上是**一个原生壳子，套了一个自己写的网页 App，中间用两层 JS 桥连起来**。

```
┌──────────────────────────────────────────────────────────────┐
│  安卓系统                                                      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  FloatService  （前台服务，整个 App 的"宿主"）            │  │
│  │  ─ foregroundServiceType = specialUse|mediaProjection  │  │
│  │                                                        │  │
│  │   WindowManager 上的 4 类悬浮窗（都靠 WindowManager     │  │
│  │   直接 addView，不走 Activity）：                        │  │
│  │                                                        │  │
│  │   ① WebView 主窗    ← 聊天 / 设置 / 记忆 / 音乐 / 屏译    │  │
│  │   ② 悬浮小球         ← 收起来的时候显示                    │  │
│  │   ③ 小胶囊           ← 读屏任务进行中/完成提醒             │  │
│  │   ④ 音乐迷你条       ← 放歌时独立出现，不影响主窗          │  │
│  │   ⑤ 译文叠加层       ← 「贴到屏幕上」形态                  │  │
│  └────────────────────────────────────────────────────────┘  │
│              ▲                          ▲                     │
│              │ 原生调用                   │ 无障碍/截屏           │
│  ┌───────────┴───────────┐   ┌──────────┴──────────────────┐  │
│  │ JsBridge  →  Android.* │   │ EllyAccessibilityService     │  │
│  │ PermissionBridge       │   │   ├─ dumpScreenNodes()       │  │
│  │        →  Perm.*       │   │   └─ 屏幕尺寸 / 包名 / 文本    │  │
│  └───────────┬───────────┘   │ ScreenCaptureActivity        │  │
│              │               │ ScreenShotUtil (MediaProjection)│
│              │               └──────────────────────────────┘  │
│              ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  WebView 里的 index.html（整个 UI 都在里面）              │   │
│  │                                                        │   │
│  │   · 单页多视图路由 showView('chat'|'settings'|...)      │   │
│  │   · CONFIG / 设置持久化   →  Android.getValue/setValue  │   │
│  │   · 对话 + Function Calling 循环                        │   │
│  │   · 长期记忆库            → 记忆工具 + 常驻摘要块          │   │
│  │   · 屏幕翻译引擎（免费微软 / AI）                        │   │
│  │   · 音乐播放器（GD Studio / Meting 双源）               │   │
│  │   · TTS 朗读（系统 TTS / OpenAI 兼容接口）              │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 为什么这么分层

| 需求 | 选择 | 原因 |
|---|---|---|
| 悬浮在所有 App 之上 | `WindowManager.addView` + 前台服务 | 不用 Activity，不会打断你正在做的事，也不需要 `SYSTEM_ALERT_WINDOW` 之外的任何特殊机制 |
| 界面 | 一个 WebView 加载本地 `assets/index.html` | 改界面不用重编译 Kotlin；粉色渐变、气泡、动画用 CSS 几行就够；迭代快 |
| 和系统交互 | 两个 `@JavascriptInterface` 桥 | WebView 只负责画，能力全部由原生提供，权限边界清晰 |
| 读屏幕 | 无障碍服务 | 不需要 root / Shizuku，节点树带真实坐标，是最稳的方案 |

### 两层 JS 桥

原生暴露给网页的一切，只有两个对象：

**`Android.*` — 干活用的桥**（[`JsBridge.kt`](android/app/src/main/java/com/elly/float/JsBridge.kt)）

```js
Android.getValue(key, def)     // SharedPreferences 读
Android.setValue(key, json)    // SharedPreferences 写
Android.request(id, m, u, h, b) // 代发 HTTP（绕开 WebView 的跨域限制）
Android.toast(msg)
Android.openUrl(url)
Android.vibrate()
Android.screenshot()           // 触发截屏流程
Android.showMiniPlayer(n, a, p) // 拉起音乐迷你条
Android.minimizeToBubble()      // 收成小球
Android.restoreFloat()          // 展开回主窗
Android.toCapsule(text)         // 收成小胶囊（读屏任务专用）
Android.capsuleState(t, s)      // 更新胶囊进度 / 红点
Android.capsuleDone(t)          // 任务完成，点红点
Android.showTranslateOverlay(json) // 把译文贴到屏幕上
Android.pickFile(mode)          // 拉起选图 / 选文件
```

**`Perm.*` — 权限和系统状态查询**（[`PermissionBridge.kt`](android/app/src/main/java/com/elly/float/PermissionBridge.kt)）

```js
Perm.canFloat()             // 悬浮窗权限
Perm.canScreenshot()        // 截屏权限（MediaProjection 是否还活着）
Perm.hasAccessibility()     // 无障碍服务是否开启
Perm.getScreenNodes()       // ← 读屏主力：整棵节点树 + 屏幕坐标
Perm.getScreenSize()
Perm.getCurrentPage()
```

网页那边所有系统能力都走这两个对象，没有任何"直接调系统"的旁路。这样权限提示、失败兜底、非原生环境降级（在没有 `Android` 对象的浏览器里跑同一份 HTML）都能集中处理。

---

## 各模块是怎么实现的

### 1. 悬浮窗与前台服务 —— `FloatService.kt`（约 1375 行，项目最大文件）

这是 App 的心脏。它是一个 **foreground service**，在 `onCreate` 里建通知、拿 `WindowManager`，然后把所有悬浮窗都作为 `WindowManager.LayoutParams` 直接 `addView` 上去。

三种窗口形态可以互相切换：

| 形态 | 什么时候出现 | 实现 |
|---|---|---|
| **主窗** | 正常使用 | WebView 全尺寸铺满窗口 |
| **小球** | 点顶栏 `－` 收起来 | 圆形头像 `ImageView`，可拖到屏幕任意边 |
| **小胶囊** | 读屏任务运行中 / 完成提醒 | 粉白横条 + 转圈 + 完成时右上角红点 |

关键设计：**收起来的时候不是把 WebView 销毁，而是 `alpha=0` + 移出屏幕 + 加 `FLAG_NOT_TOUCHABLE`**（`hideWebView()` / `showWebView()`）。这样展开是瞬间的，聊天状态、滚动位置、音乐播放全都不丢。

「小胶囊」和「音乐迷你条」是**两个完全独立、互不影响的东西**：

- **小胶囊**只服务于「读屏类快捷指令」。原因很实际：翻译/总结屏幕时，助手窗口本身会挡住要读的内容，所以先把它挪成一条细条。任务跑完显示红点，点一下才回来看结果。
- **音乐迷你条**是播放控制条，任何时候都可能出现，**绝不会**让聊天界面消失、也绝不会切换页面。

窗口位置、拖拽、贴边、尺寸都用一套通用的 `attachDrag(view, params, onClick)` 处理，支持触摸和鼠标事件。

另外所有悬浮窗在**截屏前会被临时藏起来**（`hideOverlaysForShot()` 把 alpha 置 0 并移出屏幕，180ms 后还原），否则助手的窗口自己会被拍进截图里 —— 这同时也修好了 AI 自己的 `screenshot` 工具。

### 2. 无障碍读屏 —— `EllyAccessibilityService.kt`（173 行）

把整个屏幕的无障碍节点树摊平成 JSON：

```json
[{"t":"设置","x":40,"y":100,"w":300,"h":44}, ...]
```

- 坐标用 `getBoundsInScreen()`，是**真实屏幕像素**，可以直接拿去画叠加层
- 剔除自己 App 的节点（`com.elly.assistant`），避免读到助手自己的窗口
- 深度限制 40 层、最多 400 个节点，防止在复杂列表（比如无限滚动的信息流）里卡死
- 拿不到节点树时（很多游戏、Flutter/RN 自绘界面、部分系统弹窗），自动降级到**方案 B：整屏截图 + 视觉模型**

这套「A 无障碍节点树优先，B 视觉模型兜底」的组合是整个屏幕理解功能的地基，翻译、总结、要点、解释四个快捷指令都建立在它上面。

### 3. 截屏 —— `ScreenCaptureActivity.kt` + `ScreenShotUtil.kt`

标准 `MediaProjection` 流程：一个透明 Activity 拉起系统授权弹窗 → 拿到 `MediaProjection` → `ImageReader` 取一帧 → 压缩成 JPEG → 交给网页。

授权结果缓存在服务里，`Perm.canScreenshot()` 用来判断还能不能用；失效了会重新弹授权。同样走 `hideOverlaysForShot()`，不会把自己拍进去。

### 4. 对话与工具调用（Function Calling）

`index.html` 里手写了一个完整的 OpenAI 兼容 function-calling 循环：

```
用户消息 → POST /chat/completions (带 tools)
         → 模型返回 tool_calls
         → 本地执行工具，把结果作为 role:"tool" 塞回消息
         → 再问一次
         → 直到模型给出普通文本回答
```

支持的**模型服务商预设**：EveryAPI（默认）、OpenAI、DeepSeek、智谱 GLM、Kimi，也可以手填任意 `baseURL` + `model`。

工具体系分两块：

**系统工具**（和安卓交互）

| 工具 | 作用 |
|---|---|
| `read_screen` | 读当前屏幕的文字内容 |
| `get_current_page` | 当前前台应用 / 页面 |
| `screenshot` | 截屏 |
| `open_url` | 打开链接 |
| `set_clipboard` | 写剪贴板 |
| `search_and_play_music` / `music_control` | 找歌播放 / 暂停切歌收藏 |

**记忆工具**（见下）

视觉模型是可选的独立配置项：主模型如果不支持读图，可以**另外指定一个识图模型**，用到图片时自动走它。用户上传图片不进对话历史（dataURL 太大），只存一个文字占位。

### 5. 长期记忆库

这是这个项目里最"有想法"的一块。设计目标很明确：**记忆要能无限增长，但不能让 App 变卡、也不能把 token 撑爆。**

它不是把历史对话一股脑塞回 prompt，而是一个**独立的、可被 AI 主动查询的记忆库（文件式按需检索）**：

- 每条记忆有 **分类**（关于你 / 人际关系 / 项目 / 约定 / 事件 / 知识 / 情绪 / 其他）、**重要度**、**置顶**、**时间戳**
- 搜索是**关键词 + 向量**混合。向量是本地 int8 量化后 base64 存的（`q8:` 前缀），可以选配一个 embedding 接口；不配就退化成关键词加权
- prompt 里只放一个**常驻块**：几条置顶 + 几条最近，**大小恒定**（约 300 token），跟你记忆库里有一百条还是一万条没关系
- AI 觉得该记了，自己调用 `save_memory`；需要细节时用 `list_memories` / `read_memory` 主动去查
- 有完整的 UI：按分类浏览、搜索、新建、编辑、删除（删除需要你确认授权）
- 导出 / 导入支持 **JSON 和 Markdown 两种**，走剪贴板

7 个记忆工具：`list_memories`、`read_memory`、`list_memory_categories`、`save_memory`、`update_memory`、`pin_memory`、`delete_memory`。

### 6. 屏幕翻译

两个引擎：

- **免费引擎**：微软 Edge 的公开翻译接口，逐条批量翻，带并发上限和缓存
- **AI 引擎**：把整屏文本打包成 JSON 数组一次性发给模型翻，质量更高、能结合上下文，也更适合「双语」

两种显示形态：

- **形态一 · 悬浮面板**：翻译结果以列表卡片显示在助手窗口里（原文 + 译文对照）
- **形态二 · 贴到屏幕上**：`showTranslateOverlay()` 把每条译文按原坐标画回屏幕上原来文字的位置，视觉上像"原页面被翻译了"

形态二的叠加层是整体 `FLAG_NOT_TOUCHABLE` 的（所以你还是能正常操作下面的 App），旁边单独挂一个可点的小条「还原屏幕」用来关掉它。双语模式下译文用粉色 `#d6336c`，和用户脚本的配色一致。

细节处理：中文本身的条目默认跳过不翻；父子节点重复文本会去重；太小的元素（宽高 ≤ 6px）忽略；纯数字/符号跳过。

### 7. 音乐

双数据源自动择优（谁先返回有效结果用谁）：**GD Studio API** 和 **Meting**（支持填多个实例做容灾）。搜索 → 取播放地址 → `<audio>` 播放，带歌词解析（LRC）和歌词滚动。

播放控制条是**原生悬浮窗**，所以即使你收成小球、切到别的 App，音乐迷你条依然在，能暂停、切歌，点一下展开完整音乐页。

### 8. 语音朗读

两种引擎：浏览器/系统自带 TTS，或任意 OpenAI 兼容的 `/audio/speech` 接口（可调语速、音色）。

### 9. 外观

主题色、头像（支持上传本地照片 + 拖动缩放裁剪成圆形）、气泡样式、助手名字都在设置里改，持久化在 SharedPreferences。整个 UI 是纯 CSS 手写的，没有用任何 UI 框架。

---

## 功能一览

| 分类 | 能力 |
|---|---|
| **窗口** | 悬浮主窗 / 悬浮小球 / 小胶囊 / 音乐迷你条 / 屏幕译文叠加层；任意拖动、贴边 |
| **对话** | 流式/非流式聊天、多轮上下文（轮数可调）、完整 function calling、多服务商预设 |
| **看屏幕** | 无障碍节点树读屏、截屏、前台页面识别、可选独立识图模型 |
| **快捷指令** | 翻译屏幕、总结屏幕、要点、解释（读屏时自动收成胶囊，完成弹红点） |
| **屏幕翻译** | 免费 / AI 双引擎，仅译文 / 双语，悬浮面板 / 贴屏叠加两种形态 |
| **长期记忆** | 分类记忆库、关键词+向量检索、常驻摘要块、AI 主动读写、可视化增删改查、JSON/Markdown 导入导出 |
| **音乐** | GD Studio + Meting 双源搜索、播放、歌词、收藏、原生迷你控制条 |
| **语音** | 朗读助手回复，系统 TTS / OpenAI 兼容接口 |
| **上传** | 发图片（走识图模型）、发文件（读文本内容，≤200KB） |
| **其它** | 剪贴板读写、打开链接、头像裁剪、主题色自定义、导出导入全部配置 |

---

## 怎么用

### 1. 安装

去 [Releases](https://github.com/xysy92ds/ElysiaFloat/releases) 下载最新的 `.apk`，在手机上点开安装（需要允许「安装未知来源应用」）。

> APK 是 debug 签名的（自用项目），部分手机管家会提示风险，忽略即可。

### 2. 开权限（缺一不可）

| 权限 | 在哪里开 | 不开会怎样 |
|---|---|---|
| **悬浮窗** | 设置 → 应用 → 显示在其他应用上层 | 助手窗口根本出不来 |
| **无障碍** | 设置 → 无障碍 → 已安装的服务 → 爱莉希雅浮窗助手 | 读屏、翻译屏幕、总结屏幕全部不可用 |
| **截屏** | App 内首次点截屏时弹系统授权 | 识图兜底方案不可用 |
| **通知** | Android 13+ 首次启动会请求 | 前台服务容易被系统杀掉 |
| **电池优化** | 建议把本 App 设为「不受限制」 | 息屏一会儿悬浮窗就没了 |

App 内 设置 → 🔐 权限 里有直达各设置页的按钮。

### 3. 配 API

打开助手 → 设置 → 填 **API 地址 / API Key / 模型**（默认预设是 EveryAPI）。

想用识图、AI 翻译、AI 朗读，在对应分区勾选「独立配置」再填各自的接口。全部配置都存在本地 SharedPreferences，**不会上传到任何地方**。

### 4. 日常使用

- 点悬浮球 → 展开助手窗口
- 顶栏 `－` → 收成悬浮小球（**注意：这个按钮只是把窗口收起来，不是小胶囊**）
- 顶栏 `×` → 关闭悬浮窗
- 底部 `＋` → 发图片或文件
- 底部 🎵 / ⚙️ / 🧠 → 音乐 / 设置 / 记忆库
- 快捷指令条上的「翻译屏幕 / 总结屏幕 / 要点 / 解释」→ 会自动读屏，并把窗口收成小胶囊；跑完胶囊上出现红点，点它就能看结果
- 悬浮球长按可拖动换位置

---

## 怎么构建

需要 JDK 17 + Android SDK（`compileSdk 34`）。

```bash
cd android
./build.sh assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

`build.sh` 只是给 `gradle` 包了一层环境变量（`JAVA_HOME`、`GRADLE_USER_HOME`、`ANDROID_HOME`），方便在 Termux / Linux 上跑。也可以直接用 Android Studio 打开 `android/` 目录构建。

**没有第三方依赖**，所以 `--offline` 也能构建成功。

关于 `android/tools/`：里面是一个叫 `remove_fix.c` 的小 LD_PRELOAD 垫片，只用来解决**在 Termux/proot 这类受限环境里**打包时 `apkzlib` 删临时目录失败的问题。正常在 PC 上构建**完全不需要它**，详情见 [`android/BUILD_NOTES.md`](android/BUILD_NOTES.md)。

---

## 浏览器用户脚本和 App 是什么关系

`userscript/` 里是**这个项目最早的样子**，也是它功能和定位上的"轻量版"。

| | 🌐 浏览器用户脚本 | 📱 安卓 App（主项目） |
|---|---|---|
| 运行环境 | 浏览器 + 油猴类管理器 | 安卓系统，悬浮在所有 App 之上 |
| 存储 | `GM_setValue` | SharedPreferences |
| 网络 | `GM_xmlhttpRequest` | 原生 `HttpURLConnection` 代理 |
| 界面 | 脚本动态注入 DOM | 本地 `assets/index.html` |
| **读屏幕** | 只能读**当前网页**的正文（`document.body.innerText`） | **无障碍节点树**，能读任意 App 的界面和坐标 |
| **屏幕翻译** | 只能翻当前网页的文字 | 能翻任意 App，且能把译文**按原坐标贴回屏幕上** |
| **截屏 / 识图** | ❌ 做不到 | ✅ 系统截屏 + 视觉模型 |
| **悬浮窗** | 网页内的一个 div，切标签页就没了 | 真正的系统级悬浮窗，切 App 也还在 |
| **长期记忆库** | ❌ 没有 | ✅ 完整记忆系统（分类 / 向量检索 / 可视化编辑 / 导入导出） |
| **音乐后台播放** | 关掉页面就停 | 原生迷你条，后台持续播放 |
| **文件上传** | ❌ | ✅ |
| **常驻能力** | 无 | 前台服务 |

**一句话**：用户脚本是"在网页里加了个 AI 助手"，App 是"在整台手机上装了个 AI 助手"。

用户脚本保留下来的意义是：**它不需要装 App、不需要任何权限，在电脑浏览器上打开就能用**，适合快速试一下这个助手长什么样、说话什么风格。但如果你想要读屏、屏幕翻译、识图、记忆、后台放歌 —— 那些**只有 App 版才有**。

想用用户脚本：见 [`userscript/README.md`](userscript/README.md)。

---

## 仓库结构

```
ElysiaFloat/
├── README.md                  ← 你正在看的这份
├── android/                   ← 📱 安卓 App 源码（主项目）
│   ├── build.sh               ← 构建入口（Gradle 环境封装）
│   ├── BUILD_NOTES.md         ← 构建笔记 / Termux 环境下的坑
│   ├── tools/                 ← 只给 Termux 用的 apkzlib 垫片
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       ├── assets/
│       │   ├── index.html     ← ★ 整个 UI + 全部业务逻辑都在这一个文件里
│       │   ├── avatar.jpg
│       │   └── cover.jpg
│       ├── java/com/elly/float/
│       │   ├── MainActivity.kt             → 启动、引导开权限、拉起悬浮窗
│       │   ├── FloatService.kt             → ★ 前台服务 + 全部悬浮窗（最大文件）
│       │   ├── JsBridge.kt                 → Android.* 桥（干活）
│       │   ├── PermissionBridge.kt         → Perm.* 桥（权限与系统状态）
│       │   ├── EllyAccessibilityService.kt → 读屏（节点树 + 真实坐标）
│       │   ├── ScreenCaptureActivity.kt    → 截屏授权
│       │   ├── ScreenShotUtil.kt           → MediaProjection 截帧
│       │   └── PickImageActivity.kt        → 选图 / 选文件
│       └── res/                            → 图标、主题、字符串、无障碍配置
├── apk/                       ← 📦 已编译好的安装包
└── userscript/                ← 🌐 浏览器用户脚本（早期轻量版）
    ├── elysia-web-assistant-v4.2.user.js
    └── elysia-web-assistant-v0.3.user.js
```

历史版本安装包在 [Releases](https://github.com/xysy92ds/ElysiaFloat/releases) 里。

### 想改哪里？

| 想做的事 | 改哪个文件 |
|---|---|
| 换配色、改布局、加按钮 | `android/app/src/main/assets/index.html` 的 `<style>` / `<body>` |
| 改角色人设、加系统提示词 | `index.html` 里的 `systemPrompt`（或直接在 App 设置里改，不用重编译） |
| 加一个新工具给 AI 用 | `index.html` 的 `buildTools()` + `execTool()` |
| 加一个新的系统能力（原生） | `JsBridge.kt` 加 `@JavascriptInterface` 方法 → `index.html` 里调用 |
| 改悬浮窗行为 | `FloatService.kt` |
| 改读屏逻辑 | `EllyAccessibilityService.kt` |

因为业务逻辑几乎都在一个 HTML 文件里，**改界面/加功能通常只需要动 `index.html` 然后重新打包**，不用碰 Kotlin。

---

## 已知限制

- **读屏不是万能的**：游戏、Flutter/RN 自绘界面、部分系统弹窗拿不到无障碍节点，会退化成「截图 + 视觉模型」，识别质量取决于你配的识图模型。**没有做端侧 OCR**。
- **截屏译文叠加层是"贴"上去的，不是真的替换了页面文字**：它按原坐标把译文画出来，字体、行距不会完全贴合原排版。对于长文本段落会有溢出或错位。
- **免费翻译引擎是公共接口**：不保证稳定，请求密集时可能被限流。要稳定就切 AI 引擎。
- **APK 是 debug 签名**：仅供自用/测试，不适合直接分发到应用商店。
- **没有 Shizuku / root 相关功能**：全部能力都建立在无障碍 + MediaProjection + 悬浮窗这三个公开 API 上。
- **对话历史存在本地**：清空数据会一起没掉；重要的东西建议用记忆库或导出功能留一份。
- Android 14+ 对前台服务`specialUse` 类型的审核较严，某些定制 ROM 可能需要手动允许后台运行。

---

## 许可

个人项目，随意取用。角色「爱莉希雅」相关设定版权归米哈游所有。
