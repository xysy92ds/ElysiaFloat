# 2026-10-24 公开仓库 0.7.2 Beta 发布

## 1. 目标

按标准 GitHub 发布形式，把 0.7.2 作为测试版（prerelease）发布到公开仓库
`xysy92ds/ElysiaFloat`，重写全部对外文档，移除浏览器用户脚本等未完善内容，
并在发布后规划下一阶段。

## 2. 实际执行

### 2.1 文档重写

| 文件 | 内容 |
|---|---|
| `README.md` | 居中标题、3 个徽章、Beta 说明、功能四分区、系统要求、下载与校验、升级、快速开始、文档索引、项目结构、源码构建、版本与发布、隐私与安全 |
| `CHANGELOG.md` | 0.7.2 / 0.7.1 / 0.7.0 / 0.6.5 及更早；移除 Termux、Minecraft 条目 |
| `docs/README.md` | 使用 / 安全 / 开发三张索引表 |
| `docs/install.md` | 安装、覆盖升级、签名说明（测试签名，不作为正式分发） |
| `docs/permissions.md` | 权限分级、能力组授权、逐次确认清单 |
| `docs/agent.md` | 任务类型、设备阶段、取消与超时 |
| `docs/workspace.md` | 目录结构、快照、回滚、边界 |
| `docs/plugins.md` | 清单、权限、Host API、错误码、市场索引 |
| `docs/build.md` | 环境、构建、签名回退、测试命令、常见问题 |
| `docs/faq.md` | 安装 / 模型 / Agent / 文件 / 插件 / 悬浮窗 / 隐私 |

### 2.2 清理

- 删除 `marketplace/plugins/com.elly.market.minecraft/`（manifest / README / bot.js）；
- `marketplace/index.json` 只保留 `com.elly.market.text-tools`；
- 公开仓库不包含 `userscript/`；
- `template.html` 公告移除 Termux / Minecraft 条目（私有与公开两处同步）；
- `android/tools/README.md` 去掉沙箱专用绝对路径，改为通用说明；
- 新增 `.gitignore`（构建目录、local.properties、keystore、IDE、Node）；
- 新增 `.github/workflows/android.yml`（JDK 17 + Node 20，HTML 检查 → smoke → assembleDebug → artifact）。

### 2.3 验证与构建

```text
node tools/build-html.js --check   通过（18 个模块，index.html 541163 字节）
node tools/smoke.js                全部通过
./gradlew assembleDebug            BUILD SUCCESSFUL
```

产物：

- `ElysiaFloat-v0.7.2-debug.apk`：2,653,759 字节，
  SHA-256 `6cf5ff194090e1827ee053db340665a3a43a4e3bcca914f159b7845fd3356b03`；
- 证书 `CN=ElysiaFloat`，SHA-256 `7851cb492002b990e67d477c420a59909f59eab13de8220884dd56d075bdbccd`；
- `ElysiaFloat-v0.7.2-source.zip`：1,678,640 字节，
  SHA-256 `119ce54d…`（`git archive --prefix=ElysiaFloat-v0.7.2/`）；
- `SHA256SUMS`：191 字节。

### 2.4 GitHub 发布

- 仓库：`xysy92ds/ElysiaFloat`（public）；
- 推送：clone → 清空工作区 → rsync → commit `cb10e91` → push `main` → tag `v0.7.2`；
- Release：ID `422140702`，`draft=false`；初始按 `prerelease=true` 发布，
  用户反馈 GitHub 上 Latest 仍指向 v0.6.5，随后改为 `prerelease=false` + `make_latest=true`，
  标题继续保留 “Beta”，并在 `1b2e09a` 同步 `release/latest.json`；
- 资产：APK、source.zip、SHA256SUMS；
- 仓库信息：description、homepage、topics（android, ai-assistant, floating-agent,
  beta, floating-window, kotlin, openai, plugin-system, webview）；
- `release/latest.json` 更新为 v0.7.2，应用内更新检查已指向该文件。

### 2.5 匿名回归

```text
仓库页 / Release 页 / 资产下载        200
raw release/latest.json              200
sha256sum -c SHA256SUMS              OK（三项）
source.zip 内容                      137 文件，无 userscript / workspace / keystore / apk
APK 签名                             CN=ElysiaFloat
```

## 3. 私有归档同步

- `apk/ElysiaFloat-v0.7.2-debug.apk` 与 `release/0.7.2/` 已替换为公开 Release 同一构建；
- `apk/ElysiaFloat-v0.7.2-SHA256SUMS` 与 `release/0.7.2/SHA256SUMS` 已重算；
- MANIFEST 重新生成，记录公开 Release 与下一阶段入口。

## 4. 未完成 / 下一步

- 0.7.2 真机回归（发送、长按、粘贴、横屏、公告、市场）；
- 任务粘性 / 30 分钟授权真机验证；
- 0.8 N1~N5 按 `plans/MASTER-EXECUTION-PLAN.md` 第 15 节执行；
- 内置市场 Minecraft 示例清理（I-051 / N4-001），随下一版本移除；
- Debug/Release 签名分离（N3-001）。
