# 工作记录：最新版问题修复（任务切换、全屏、上下文、音乐缓存）

日期：2026-10-16
状态：本地实现和构建完成；未提交 Git、未推送。

## 用户反馈

- 全屏按钮不是实际的全屏模式；
- 切换任务舱后仍显示之前的聊天内容；
- 清除聊天记录入口消失；
- 默认聊天上下文轮数过少；
- 个性化与聊天人设页面看起来消失；
- 音乐不能下载和缓存；
- 普通用户功能仍需继续优化。

## 已完成修改

### 全屏

- `FloatService` 增加 `setFullscreen()`；
- 全屏时把悬浮窗扩展到显示区域，设置 `FLAG_FULLSCREEN`、`FLAG_LAYOUT_IN_SCREEN`、`FLAG_LAYOUT_NO_LIMITS` 和沉浸式系统 UI 标志；
- 保存原始矩形、窗口 flags 和 systemUiVisibility，退出时恢复；
- JS 改为调用 `Perm.setFullscreen()`，不再只调用 `resizeWindow()`；
- 使用 `CountDownLatch` 等待主线程窗口更新，避免 JS 立即收到假失败结果。

说明：不同厂商对悬浮窗隐藏系统栏的限制不同，仍需真机确认是否能达到完整沉浸式效果。

### 任务上下文隔离

- 为每个任务增加独立的 `via_ai_history_task_<id>` 存储键；
- `taskSaveContext()` / `taskLoadContext()` 改为按任务保存和恢复；
- 非聊天任务首次升级时清空旧版本可能共享的历史上下文；
- 切换任务时先保存原任务，再加载目标任务并重新渲染聊天；
- 任务切换不会继续显示上一任务的聊天历史。

### 清除聊天记录

- “清空”加入主界面第二行的“更多”菜单；
- 清空操作只清除当前任务对话；
- 长期记忆不删除；
- 有确认弹窗。

### 上下文轮数

- 默认 `maxContextTurns` 从 10 调整为 35；
- 旧配置检测到旧默认值 10 时自动迁移到 35；
- 设置页保存时的回退值改为 35。

### 个性化与聊天人设

- 原有字段仍在设置渲染中：助手名称、头像、头像裁剪、主题色、自定义聊天人设；
- 设置折叠分区中默认展开：AI 与模型、个性化与聊天风格、聊天与助手；
- 原问题是分区默认全部收起，导致用户误以为个性化设置消失；
- 当前没有删除原有个性化数据。

### 音乐下载和缓存

新增 Android 私有缓存目录：

```text
<app files>/music-cache/
```

新增 JS/原生接口：

- `Android.getCachedMusic()`；
- `Android.cacheMusic()`；
- `Android.clearMusicCache()`；
- `window.__musicCacheCb()`。

音乐列表现在增加：

- “缓存”按钮；
- 已缓存状态；
- 音乐页“清理缓存”按钮；
- 播放时优先使用本地缓存文件；
- 下载采用临时文件完成后改名，避免产生半截文件；
- 单曲缓存上限 150MB；
- 缓存文件使用歌曲来源和 ID 的 SHA-256 派生文件名。

## 验证

- `node tools/build-html.js --check`：通过；
- `node tools/smoke.js`：全部通过；
- `./build.sh assembleDebug`：成功；
- APK：

```text
apk/phases/ElysiaFloat-latest-ui-fixes-debug.apk
```

SHA-256：

```text
212cc552a946fb4fdd4f7c2d1e534d5abb5da327b5ea0f5189acf6f2e539100f
```

## 尚未完成

- 真机确认系统栏是否被完整隐藏；
- 真机确认任务切换时各类上下文完全隔离；
- 真机确认音乐缓存下载、离线播放和缓存清理；
- 普通功能的整体 UX 优化仍需单独建立清单：音乐搜索失败降级、文件格式、权限引导、更新、设置导航和错误提示。
