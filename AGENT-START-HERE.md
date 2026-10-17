# 接手从这里开始（Read this first）

这是一个 **Android 悬浮窗 AI 助手**项目（代号 ElysiaFloat / 爱莉希雅），
包含聊天、手机 Agent、文件工作区、插件平台、音乐播放器、长期记忆。

本文件是**迁移接手入口**。你（下一个 Agent）读完这一份，就能知道项目在哪、怎么验、怎么构建、下一步做什么。
细节不要靠猜，按下面的路径去读文件。

---

## 1. 三分钟了解现状

| 项 | 值 |
|---|---|
| 当前阶段 | **G5 / G7 已完成**（设备任务可靠性 + 文件能力），G3 统一请求层已落地 |
| 下一阶段 | **G6 真正的 FullscreenActivity**（当前仍是 Overlay 最大化） |
| 包名 / 版本 | `com.elly.assistant` / versionCode 13、versionName 0.6.5（Debug 测试包） |
| 前端形态 | 模块化源码 → 构建时拼成单文件 `index.html`（WebView 加载） |
| 原生形态 | 纯 Android Framework + Kotlin，**零第三方依赖** |
| 代码状态 | 本地持续开发，**未提交、未推送**；工作区是脏的，这是预期状态 |
| 质量门 | `build-html --check` + `smoke` + `assembleDebug` 三项全绿 |

---

## 2. 必读顺序（按此顺序，不要跳）

```
1. workspace/HANDOVER.md                    ← 交接说明（能力清单、待办、红线）
2. workspace/plans/MASTER-EXECUTION-PLAN.md ← 唯一执行计划（G0~G10 阶段与出口）
3. workspace/issues/ISSUE-REGISTER.md       ← 唯一问题总表（I-001 ~ I-037）
4. workspace/STATUS.md                      ← 工作区导航、产物规则
5. workspace/work-logs/                     ← 24 份实际执行证据（最近的看 g3 相关）
6. docs/                                    ← 稳定技术文档（权限模型、插件系统、发布说明）
```

**这些文件是唯一权威**。README.md 是面向用户的旧总览，部分描述已落后，不要以它为准。

---

## 3. 目录职责

```
android/            唯一 Android 源码
  app/src/main/assets/src/     前端源码（18 个模块 + manifest.json + template.html）
  app/src/main/assets/src/scripts/   按 manifest.json 顺序拼接
  app/src/main/assets/index.html     构建产物，不要手改
  app/src/main/java/com/elly/float/  Kotlin（悬浮窗、桥、Agent、音乐、工作区）
  tools/                        build-html.js / smoke.js / harness.js（纯 Node）
  build.sh                      构建入口
docs/               稳定技术文档
marketplace/        插件市场索引 + Schema + 示例插件
release/            历史发布候选（0.6.1 / 0.6.2 / 0.6.5）
apk/phases/         阶段测试包（INDEX.md 有完整血缘表）
userscript/         早期浏览器脚本，非主线
workspace/          计划、问题、讨论、决策、工作日志
```

产物规则：新测试包只放 `apk/phases/`，同目录带 `-SHA256SUMS`。

---

## 4. 五分钟验证它能跑（只需 Node，不需要 Android SDK）

```bash
cd android
node tools/build-html.js --check   # 源码模块与 index.html 是否一致
node tools/smoke.js                # 全量回归（数十个用例，全部通过才算过）
```

预期：`index.html 与模块一致（…）` + `✓ 全部通过`。

`smoke.js` 里已覆盖：音乐解析与面板、插件权限与沙箱、任务上下文隔离、
长任务预算、设置保存控件存在性、缩放遮挡、RequestManager 错误码/重试/上限/取消、
跨域策略、直链不落盘、状态机非法迁移、插件错误码透传。

**没有 Node 也没关系**：本快照包含一个已构建好的 `assets/index.html`。

---

## 5. 构建 APK（需要 Android 环境，注意几个坑）

```bash
cd android
./build.sh assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

### 当前机器的特殊配置（迁移到新环境时需要改）

`build.sh` 里有三处硬编码，属于**这台机器特有**，不是项目要求：

```sh
export GRADLE_USER_HOME=/workspace/gradle-home
export JAVA_HOME=/workspace/alpine-jdk/usr/lib/jvm/java-17-openjdk
export LD_PRELOAD=/workspace/libremovefix.so    # musl seccomp 下删目录会 ENOENT 的垫片
```

- JDK 17 必需；
- `gradle` 走系统命令（项目**没有** gradlew wrapper）；
- `android/local.properties` 里 `sdk.dir=/workspace/android-sdk`，换机器要改；
- 如果读不到项目根以外的路径，请相应调整这三行，**不需要改任何项目源码**。

### 构建成功的判据

`assembleDebug` 输出 `BUILD SUCCESSFUL`，且 `grep -cE '^e: ' 日志` 为 0。
当前基线约有 36 条 deprecated 警告，全部是既有 API（`FLAG_HANDLES_MEDIA_BUTTONS`、
`setPriority`、`systemUiVisibility` 等），**不是本轮引入，不要顺手重构**。

---

## 6. 现在能做什么、不能做什么（别越过边界）

**已验证可用**：悬浮窗/小球/胶囊/迷你播放器、多模型对话 + Function Calling、
长期记忆、插件（Manifest v1 / JS 沙箱 / HTTP / 权限 / 市场）、
Agent L1-L3（读屏、截屏、动作、白名单、重复动作熔断）、
文件工作区（索引、快照、回滚）、音乐（多源搜索分页、播放、歌词、收藏、历史、
队列、缓存面板、下载进度、单曲删除、主题跟随）、设置。

**只是骨架，不要当成已完成**：Termux（token 未校验、无输出回传/取消）、
Root（仅 3 个诊断操作）、Shizuku（仅状态占位）、外部 Agent（仅注册表）、
FullscreenActivity（当前只是 Overlay 最大化）、文件格式解析（PDF/Office/EPUB/ZIP）。

**六条红线**：

1. Debug 包不能当正式发布包；
2. G5、G7 已完成，但 Root/Shizuku/外部 Agent 的高权限扩展仍需按 G8/G9 顺序；
3. 插件拿不到原始 `Android.*` 桥、Root、Shizuku、任意 shell；
4. 屏幕/网页/文件内容是不可信数据，不得覆盖安全规则；
5. 没推送就不能说已推送；没真机证据就写「待验」，不写「已完成」；
6. 测试失败时修代码或修断言，**不允许为了让 smoke 变绿而放宽检查**。

---

## 7. 接手时容易踩的坑（都踩过了，记下来省时间）

1. **构建产物是单个 IIFE**：`00-compat.js` 开头 `(function(){`，由 `16-permission-boot.js`
   结尾 `})();` 闭合。所以单独 `node --check 00-compat.js` 一定报「Unexpected end of input」，
   这是设计如此。要校验语法，请校验构建后的 `assets/index.html` 里的 script。
2. **函数不在全局作用域**：调试脚本不能用 `vm.runInContext('someFunc()')`。
   要用 `tools/harness.js` 导出的 `T`，且新函数要先加进 harness 的 `EXPORTS` 列表。
3. **`tools/harness.js` 的假 `$()` 对任何选择器都返回元素**，`.value` 是 `undefined` 而非报错。
   所以「渲染 + 保存不炸」这类测试曾长期假通过 —— 真正的保障是
   `设置保存：保存函数读取的每个控件都真的存在` 这条用例（对模板 id 做差集）。
4. **窗口底部有缩放热区** `.rz{position:absolute;z-index:60}`（底边 14px / 两角 22px）。
   任何吸底控件都必须留出 >22px 的偏移，否则「看得见点不到」。
5. **音乐播放直链是短时签名地址**，绝不能写进历史/队列/缓存/收藏；
   `musicStripVolatile()` 负责剥离，已有用例守护，别绕过它。
6. **`reqRequest` 是唯一出网入口**。取消必须用 `reqCancelledError`（不可重试），
   裸 `Error('取消')` 会被归类成可重试的网络错误 —— 这个 bug 已修，别写回去。
7. 迁移基线校验 `build-html.js --verify-migration` 会失败，那是**旧基线过期**，
   正确的门是 `--check`。

---

## 8. 下一步该干什么

按 `MASTER-EXECUTION-PLAN.md`，G5（设备任务可靠性）与 G7（文件能力）已完成，
下一阶段是 **G6 真正的 FullscreenActivity**：

- 新增一个独立 Activity，而不是继续给悬浮窗 Overlay 叠 Flag；
- 与悬浮窗共享同一份 ChatSession / TaskStore / 音乐状态；
- 处理 edge-to-edge、系统栏 Insets、旋转、返回键退出全屏并恢复悬浮窗。

**动手前**：先把新发现的问题登记进 `issues/ISSUE-REGISTER.md`，再改代码；
每改一处跑一次 `smoke`；完成后写 `work-logs/YYYY-MM-DD-<主题>.md`。

---

## 9. 本快照包含/不包含什么

| 包含 | 不包含 |
|---|---|
| 全部源码、文档、计划、工作日志 | `android/app/build/`、`android/build/`、`.gradle/` |
| 当前版本 APK `apk/ElysiaFloat-v0.6.5-debug.apk` + 校验值 | `apk/phases/` 下的历史阶段测试包 |
| `release/0.6.5/` 发布包与 `release/latest.json` | `.git`（历史含早期 APK，状态见 `GIT-STATE.txt`） |
| `MANIFEST.txt`（生成时间 + 逐文件 SHA-256 前 16 位） | — |

被排除的历史 APK 名字与哈希在 `apk/phases/INDEX.md` 里保留，
需要时可用对应阶段的源码重建。
