<div align="center">

# ElysiaFloat

**运行在 Android 上的悬浮窗 AI 助手**

聊天 · 手机 Agent · 文件工作区 · 插件平台

[![Version](https://img.shields.io/badge/version-0.13.2--dev-E8879B?style=flat-square)](CHANGELOG.md)
[![Android](https://img.shields.io/badge/Android-7.0%2B-3DDC84?style=flat-square&logo=android&logoColor=white)](docs/install.md)
[![Status](https://img.shields.io/badge/status-dev-F2B5C4?style=flat-square)](CHANGELOG.md)

[下载测试版](https://github.com/xysy92ds/ElysiaFloat/releases) ·
[文档](docs/README.md) ·
[更新日志](CHANGELOG.md) ·
[问题反馈](https://github.com/xysy92ds/ElysiaFloat/issues)

</div>

---

> **开发版说明**
>
> 当前版本为 **0.13.2 dev**，用于内测与验证。功能、界面与数据结构仍可能调整，请勿用于关键业务场景；升级前建议先备份需要保留的数据。

## 简介

ElysiaFloat 是一个以悬浮窗形态运行的 Android AI 助手。它不要求你离开正在使用的应用：在任意界面唤起悬浮球，即可聊天、让 Agent 读取并操作手机、处理文件，或调用插件提供的工具。

AI 服务使用 OpenAI 兼容接口，可接入常见云服务，也可以填写自建地址。

## 功能

### 悬浮窗与聊天

- 悬浮球、胶囊、迷你播放器三种形态，可拖动、缩放，并保持在屏幕内；
- 多轮对话与流式输出，长任务可随时停止；
- Function Calling 工具调用，支持连续多步执行；
- 长期记忆：自动整理对话要点，需要时按需检索；
- 屏幕文字翻译与页面内容总结；
- 语音朗读，支持系统语音引擎或 OpenAI 兼容 TTS 接口。

### 手机 Agent

- **L1**：读取无障碍节点文字、查询已安装应用、读取浏览器地址；
- **L2**：截屏、识屏、限时观察屏幕变化；
- **L3**：点击、按文字点击、滑动、输入、系统按键、启动应用；
- 应用白名单：只有明确加入的应用才允许启动与操作；
- 每次调用都由原生策略重新校验，模型、提示词与插件无法绕过；
- 密码、支付、卸载、发送消息与删除文件始终逐次确认。

### 文件工作区

- 固定目录 `Documents/ElysiaFloat/workspace`，分为 `input / working / output / logs / snapshots`；
- 支持列目录、读取、写入、建目录、预览与导出；
- 覆盖写入前自动生成快照，可回滚；
- 路径经过规范化校验，拒绝目录穿越；
- 工作区内写入在任务授权期内免逐次确认，公共存储修改合并确认一次，删除始终逐次确认。

### 插件平台

- Manifest v1 / v2 插件格式，支持声明式 `http` 工具与沙箱内 `js` 工具；
- v2 插件可声明 **Termux 运行时**：宿主在 Termux 里拉起常驻 Node 进程，通过本地 HTTP 与插件通信，适合需要持续运行或重型依赖的能力；
- 权限声明、用户授权、调用时校验三段式模型；
- JS 插件运行在独立 sandbox iframe 中，无法访问 `Android` 桥、宿主 DOM 或用户文件；
- 支持本地文件导入、URL 导入与插件市场。

#### Minecraft 联机助手（内置示例插件）

- 在 Termux 里常驻 Mineflayer bot，陪你玩 Java 版 Minecraft；
- 支持离线登录、移动、挖掘、放置、攻击、跟随、聊天、状态快照与动作审计；
- 依赖通过插件面板一键安装（nodejs、mineflayer、mineflayer-pathfinder、minecraft-data、vec3）。

## 系统要求

| 项目 | 要求 |
|---|---|
| Android | 7.0（API 24）及以上 |
| 架构 | 任意 ABI（纯 Java/Kotlin + 系统 WebView，无原生库） |
| 必需权限 | 悬浮窗、通知 |
| Agent 权限 | 无障碍服务；截屏时另需系统截屏授权 |
| 文件权限 | 「允许管理所有文件」（仅在使用文件功能时需要） |
| Termux | 仅使用 Termux 运行时插件（如 Minecraft 联机助手）时需要 |
| 网络 | 需能访问所配置的 AI 服务商；插件与音乐源按各自配置 |

## 下载与安装

1. 打开 [Releases](https://github.com/xysy92ds/ElysiaFloat/releases)，在最新测试版下下载：
   - `ElysiaFloat-v0.7.2-0.13.2dev-debug.apk`
   - `ElysiaFloat-v0.7.2-0.13.2dev-SHA256SUMS`
2. 校验文件完整性：

   ```bash
   sha256sum -c ElysiaFloat-v0.7.2-0.13.2dev-SHA256SUMS
   ```

3. 允许文件管理器或浏览器「安装未知应用」，然后安装 APK；
4. 首次打开后按引导授予权限。

### 升级

| 当前版本 | 升级方式 |
|---|---|
| 0.13.x | 直接覆盖安装，应用内数据保留 |
| 0.7.x 或更早 | 首次升级到 0.13.x 需先卸载旧版（签名不同），卸载会清除应用内数据 |

安装包使用项目统一测试签名，0.13.x 各版本之间可直接覆盖。详见 [安装与升级](docs/install.md)。

## 快速开始

1. 打开 **设置 → AI 与模型**，选择预设或填写 `API 地址`、`API Key` 与模型名；
2. 返回聊天页输入消息，或点击悬浮球打开面板；
3. 需要 Agent 时，依次开启 **Agent 总开关 → L1/L2/L3 → 安全开关**，并授予无障碍权限；
4. 需要文件能力时，开启「允许管理所有文件」并创建工作区；
5. 需要插件时，在插件页从市场安装，或导入 JSON 清单；
6. 使用 Minecraft 联机助手：先安装 Termux，在插件面板一键准备环境，配置服务器地址与端口后启动。

## 文档

| 文档 | 内容 |
|---|---|
| [文档索引](docs/README.md) | 全部文档入口 |
| [安装与升级](docs/install.md) | 下载、校验、覆盖安装、卸载与数据 |
| [权限与安全边界](docs/permissions.md) | 能力等级、白名单、任务授权、文件与插件边界 |
| [手机 Agent](docs/agent.md) | 开启步骤、白名单配置、工具说明与常见失败原因 |
| [文件工作区](docs/workspace.md) | 目录结构、工具、快照、导出与预览 |
| [插件开发](docs/plugins.md) | Manifest v1/v2、权限、沙箱、Termux 运行时与 Host API |
| [从源码构建](docs/build.md) | 环境要求、构建命令与签名说明 |
| [常见问题](docs/faq.md) | 安装、模型、Agent、文件与插件问题 |

## 项目结构

```text
.
├── android/                 # Android 工程
│   ├── app/src/main/
│   │   ├── assets/          # 前端页面与打包后的 index.html
│   │   ├── java/            # Kotlin 原生层
│   │   └── res/
│   ├── tools/               # 构建与静态检查脚本
│   └── gradlew
├── marketplace/             # 插件市场索引与示例插件
├── release/latest.json      # 应用内更新检查读取的版本信息
├── docs/                    # 使用与开发文档
├── CHANGELOG.md
└── README.md
```

## 从源码构建

```bash
git clone https://github.com/xysy92ds/ElysiaFloat.git
cd ElysiaFloat/android
export ANDROID_HOME=/path/to/android-sdk     # 需要 SDK 34 与 Build-Tools 34.0.0
./gradlew assembleDebug
```

产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

- 仓库不包含发布签名私钥；缺少 `keystore.properties` 时会回退到系统 Debug 签名，因此自行构建的 APK 不能覆盖安装官方包；
- 前端源码位于 `android/app/src/main/assets/src/`，可用 `node tools/build-html.js` 重新生成 `index.html`；
- 静态检查：`node tools/build-html.js --check && node tools/smoke.js`。

完整说明见 [从源码构建](docs/build.md)。

## 版本与发布

- 版本号采用 `主.次.修订`，`versionCode` 单调递增；
- 每个版本对应一个 `vX.Y.Z` Git 标签和一个 GitHub Release；
- 开发阶段以 Pre-release 形式发布，Release 说明中给出变更内容与 APK 的 SHA-256；
- 应用内「检查更新」读取本仓库的 `release/latest.json`，并从 GitHub Release 下载 APK。

历史变更见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私与安全

- API Key、聊天记录、长期记忆、任务记录保存在设备本地；
- 除你配置的 AI 服务商、插件与音乐源外，应用不会主动上传内容；
- 无障碍与截屏权限只在你发起 Agent 任务时使用；
- 插件权限不能绕过 Agent 白名单、安全开关与文件确认；
- 屏幕内容、网页内容和文件内容视为不可信数据，不会作为指令执行。

完整边界见 [权限与安全边界](docs/permissions.md)。发现安全问题请通过 Issue 私下说明复现步骤，不要在公开 Issue 中粘贴密钥或个人信息。

## 反馈

- 问题与建议：[提交 Issue](https://github.com/xysy92ds/ElysiaFloat/issues)
- 提交时请附上：应用版本、Android 版本与厂商、复现步骤、相关日志（请隐去密钥与个人信息）。

## 版权

本项目由 [xysy92ds](https://github.com/xysy92ds) 维护。当前**未采用开源许可证**，保留所有权利；公开源码用于审阅与自行构建，未经许可不得再分发衍生产品或用于商业用途。
