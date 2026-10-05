# ElysiaFloat · 爱莉希雅浮窗助手 🌸

> 一个粉色系 AI 助手，有**两套完全独立的形态**：跑在浏览器里的用户脚本，和跑在安卓手机上的悬浮窗 App。
>
> 说话风格是「爱莉希雅」，能力核心是「接你自己的 OpenAI 兼容 API」。

---

## 📂 先搞清楚：哪个是哪个

| 目录 / 文件 | 这是什么 | 装在哪里 | 形态 |
|---|---|---|---|
| **`userscript/`**<br>`.user.js` 文件 | 🧩 **浏览器用户脚本** | Tampermonkey / Violentmonkey / ScriptCat 等**用户脚本管理器** | 网页里的浮动面板 |
| **`android/`** | 📱 **Android 应用的完整项目源码**（项目架构、Kotlin 代码、资源、内置网页） | 用 Gradle + Android SDK **编译** | 源码 |
| **`apk/`** | 📦 **编译好的安卓安装包** | **安卓手机**直接安装 | 可执行产物 |

> 🆕 **v0.4 新增**：一整套**长期记忆系统**（独立的记忆库 + 让 AI 自己按需查的工具 + 可视化编辑器 + 导入导出），详见下面「🧠 长期记忆系统」一节。

> ⚠️ **最容易搞混的一点**
>
> `userscript/` 里的 `.user.js` 是给**浏览器**吃的脚本，**不能**当手机 App 装。
> `android/` 里的 `app/src/main/assets/index.html` 才是安卓 App 的界面——它是**把网页助手「搬进」安卓壳子**后的版本，两者界面相似，但运行环境、权限、调用方式都不一样。
>
> 简单说：**浏览器脚本 = 网页版**，**APK = 安卓原生壳 + 网页界面**。

---

## ✨ 它能做什么

### 共同能力（网页版 / App 版都有）

- 💬 **AI 对话**：接入任意 OpenAI 兼容接口（EveryAPI / OpenAI / DeepSeek / 智谱 / Kimi / 硅基流动…），也可以自己填地址
- 🎭 **角色扮演**：内置「爱莉希雅」人设，句尾带 ~ 和 ♪，称你「你呀」「小家伙」
- 🔊 **语音朗读（TTS）**：浏览器语音或 OpenAI 兼容 TTS 接口
- 🎵 **音乐播放**：搜索、播放、收藏，支持 Meting 多实例
- 🖼️ **自定义头像**：外链图片 / 本地上传裁剪
- 🧠 **记忆**：网页版是「把总结抄进对话」，App 版 v0.4 起换成**独立记忆库**（见下节）
- 🎨 **主题色自定义**、快捷指令（翻译 / 总结 / 要点 / 解释）

### 安卓 App 独有

- 🪟 **悬浮窗**：球形悬浮球，可拖动、可最小化、可等比缩放
- 📖 **无障碍读屏**：直接读其它 App（浏览器、聊天软件）屏幕上的文字
- 📸 **两种截屏**：无障碍截屏（Android 11+，**不需要录屏授权**）+ MediaProjection 兜底
- 🔗 **拿当前网页地址**、打开链接、读写系统剪贴板
- 🛠️ **工具调用（Function Calling）**：模型可以自己决定「看屏幕 / 截图 / 打开网页 / 找歌」
- 📎 **上传图片或文件**：点 `＋` 把图片或文本文件递给她看；对话模型不吃图片时，自动用「识图模型」看懂再转成文字
- 🔐 **权限引导页**：悬浮窗 / 通知 / 无障碍 / 电池优化，一页点完
- 🧠 **长期记忆系统（v0.4）**：独立记忆库、分类与标签、按需检索、可视化编辑、JSON / Markdown 导入导出

---

## 🧠 长期记忆系统（v0.4，App 版）

### 为什么要重做

老版本只有一条「【长期记忆总结】」塞在对话历史里：越聊越长、每轮都烧 token、还会有上限，**记多了就卡**。

v0.4 把记忆挪出对话，变成一份**独立档案**：

```
每轮只喂给模型的一小块（体积恒定，和你存了多少条无关）
┌─────────────────────────────────────┐
│ 分类概览：关于你×8、项目×5、约定×3 …          │
│ ★ 重要：[m1xx] 用户叫星野夜源                 │
│ ☆ 最近：[m2yy] 在做 EllyFloat               │
└─────────────────────────────────────┘
              ↓  需要细节时
        模型自己调工具去查
   list_memories → read_memory
```

### 三层结构

| 层 | 作用 |
|---|---|
| **常驻索引** | 分类概览 +「重要」+「最近」，约 300 token，**条数再多也不涨** |
| `list_memories` | 按关键词 / 分类检索，只返回标题和摘要 |
| `read_memory` | 按编号读完整正文 |

### 记忆长什么样

```js
{ id, cat, tags[], title, content,
  pinned, hits, src, createdAt, updatedAt, emb? }
```

- **一个主分类 + 自由标签**：预置 8 类（关于你 / 人际关系 / 项目 / 约定 / 事件 / 知识 / 情绪 / 其他），AI 也可以自己新建
- **「重要」常驻**：最多 8 条置顶 + 5 条最近，手动或让 AI 标 `pinned`

### 给 AI 的工具

| 工具 | 干什么 |
|---|---|
| `list_memories` | 检索记忆库（关键词 / 分类） |
| `read_memory` | 按 id 读全文，可一次读多条 |
| `list_memory_categories` | 看现有分类和条数 |
| `save_memory` | 新记住一件事 |
| `update_memory` | 补充 / 修改旧记忆（过时了就用它，别重复建） |
| `pin_memory` | 设为 / 取消「重要」 |
| `delete_memory` | **删记忆——必须用户本人在弹窗里点同意，拒绝就作废** |

### 界面（顶栏「记忆」按钮）

- 按分类筛选、关键词搜索、展开看正文
- 手动新建 / 编辑 / 设为重要 / 删除
- **「总结对话」**：让 AI 自己判断该存什么、该更新哪条，而不是无脑把整段聊天塞进去
- **导出 JSON / 导出 Markdown / 一键复制 / 导入（合并或覆盖）**
  - Markdown 是给人看的，即使以后不用这个 App 了，记忆也还在
  - 导入会自动跳过重复条目，换手机直接粘回来就能恢复

### 语义检索（可选，默认关）

默认走**关键词加权打分**（标题 6 分 / 标签 4 分 / 分类 2 分 / 正文 1 分，再叠重要度和常用度），**不依赖任何外部服务**。

如果你有自己的 embedding 接口，可以在「设置 → 长期记忆」里填 API 地址 / Key / 模型打开它：向量会以 **int8 量化 + base64** 存在本地（避免把 SharedPreferences 撑爆）。接口挂了、报错、超时都**不影响**记忆功能本身，只是退回关键词模式。

### 老数据怎么办

升级后第一次启动，旧的那条「【长期记忆总结】」会**自动迁移**成记忆库里的一条记录（分类「事件」、置为重要、来源标记 `migrate`），原 system 消息从历史里摘掉。

---

## 🧩 一、浏览器用户脚本（`userscript/`）

| 文件 | 版本 | 说明 |
|---|---|---|
| `elysia-web-assistant-v4.2.user.js` | **v4.2** | **推荐用这个**，功能最全 |
| `elysia-web-assistant-v0.3.user.js` | v0.3 | 最初版本，保留作纪念 |

**怎么装：**

1. 浏览器装一个用户脚本管理器：Tampermonkey（油猴）、Violentmonkey、ScriptCat 任一
2. 打开管理器 → 「新建脚本」→ 把 `.user.js` 内容整个粘进去 → 保存
3. 刷新任意网页，右下角就会出现粉色悬浮球

**权限说明**（脚本头部 `@grant` / `@connect`）：需要 `GM_setValue` / `GM_getValue` 存配置，`GM_xmlhttpRequest` 跨域请求 AI 接口和音乐接口。

---

## 📱 二、安卓 App

### 安装（普通用户）

下载 `apk/` 里的 APK，用手机安装即可。

- 包名：`com.elly.assistant`
- 最低系统：Android 7.0（API 24）
- 目标系统：Android 14（API 34）
- 版本：0.4（versionCode 4）

### 关于「全架构」

这个 App **没有一行 C/C++ 原生代码**，所有 `.kt` 都是 Kotlin，依赖只有 Android Framework 本身（`build.gradle` 里 dependencies 是空的）。

所以 APK 里**不含任何 `.so` 原生库**，**一个包就是全架构通用的**——arm64-v8a、armeabi-v7a、x86、x86_64 都能装，不需要按 ABI 分包，也不需要额外下载架构补充包。

### 自己编译（开发者）

```bash
cd android
# 需要 JDK 17 + Android SDK（compileSdk 34）
./build.sh assembleDebug --offline
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

如果 `build.sh` 里的环境路径跟你的机器不一样，直接改用标准 Gradle 也行：

```bash
./gradlew assembleDebug
```

`local.properties` 里的 `sdk.dir` 是本地路径，已从仓库排除，请按自己的 SDK 位置新建。

### 权限用途

| 权限 | 干什么用的 |
|---|---|
| `SYSTEM_ALERT_WINDOW` | 显示悬浮球和悬浮窗 |
| `FOREGROUND_SERVICE` | 保持浮窗常驻 |
| `POST_NOTIFICATIONS` | 前台服务通知 |
| `INTERNET` | 请求 AI / 音乐接口 |
| 无障碍服务（需手动开） | 读屏、截屏、拿网页地址 |
| `VIBRATE` | 操作反馈 |

---

## 🗂 项目结构

```
ElysiaFloat/
├── userscript/                  🧩 浏览器用户脚本
│   ├── elysia-web-assistant-v4.2.user.js
│   └── elysia-web-assistant-v0.3.user.js
│
├── android/                     📱 安卓项目源码（架构）
│   ├── settings.gradle
│   ├── build.gradle
│   ├── gradle.properties
│   ├── build.sh
│   ├── BUILD_NOTES.md
│   ├── tools/                    # 构建辅助：seccomp 环境的删除垫片（不进 APK）
│   │   ├── remove_fix.c
│   │   ├── build-removefix.sh
│   │   └── README.md
│   └── app/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/elly/float/
│           │   ├── MainActivity.kt
│           │   ├── FloatService.kt              # 悬浮窗服务、头像圆形裁剪
│           │   ├── JsBridge.kt                  # 网页 ↔ 原生 桥
│           │   ├── PermissionBridge.kt          # 权限检测与申请
│           │   ├── EllyAccessibilityService.kt  # 读屏 / 截屏
│           │   ├── ScreenCaptureActivity.kt     # MediaProjection 兜底截屏
│           │   ├── ScreenShotUtil.kt
│           │   └── PickImageActivity.kt         # 选图 / 选文件
│           ├── res/                             # 图标、主题、无障碍配置
│           └── assets/
│               └── index.html                   # App 的整个界面（单文件）
│
└── apk/                         📦 编译好的安装包
    ├── ElysiaFloat-v0.4-debug.apk      # 最新：带长期记忆系统
    └── ElysiaFloat-v7-debug.apk        # 旧版（v1.2，无记忆库）
```

---

## 🔧 技术栈

| 部分 | 技术 |
|---|---|
| 浏览器脚本 | 纯原生 JavaScript（无框架），GM API |
| 安卓壳 | Kotlin + Android Framework（零第三方依赖） |
| App 界面 | 单文件 `index.html` + 原生 JS + CSS（不用任何前端框架） |
| 通信 | `addJavascriptInterface` 双向桥 |
| 构建 | Gradle + Android Gradle Plugin，JDK 17 |

---

## 📄 说明

- 这是**自用向**项目，API Key 由使用者自己填写，保存在本机（SharedPreferences / GM 存储），不会上传到任何服务器。
- 记忆库同样只存在本机，**没有任何云端同步**；不想要了在「数据管理 → 清除全部数据」里一并清掉。
- 浮窗 App 的语音、识图、向量检索都是可选项，不配也能正常聊天。
- 遇到「模型不支持图片」时不会硬报错，会退化成「先用识图模型描述，再交给对话模型」。

---

_爱莉希雅 · 世界蛇数据库中的一段特殊数据，更是「爱人之人」。_
