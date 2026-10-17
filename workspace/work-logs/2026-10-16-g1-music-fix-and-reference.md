# 工作记录：G1 第一阶段修复与 CRMusic 参考原型检查

日期：2026-10-16
状态：G1-001 自动验证通过；G1-002 代码修复完成；行为测试、真实 Provider 和真机待验

## 用户需求

音乐系统需要优先保证：

- 来源广泛和搜索可用；
- 搜索、播放、收藏、缓存下载等基础功能完整；
- UI 保持 ElysiaFloat 粉白风格并适配悬浮窗、小屏、长屏、横屏和低版本 WebView；
- 尽量并行请求、快速首屏、后台下载和下一首预取。

## 参考 APK 检查

本次会话上传的 `base.apk` 已实际检查，确认是 CRMusic legacy 原型：

```text
Termux 会话上传路径：uploads/base_31-110870164.apk
大小：262 KB
SHA-256：cde6ef2de613e8cd3d19f624b59f4a06c16fba3a935d93728ccb5a417be7e685
```

通过 APK 文件清单、DEX 字符串和资源结构确认其具备：

- 搜索、播放器、收藏、下载、历史、歌单详情、设置和文件/导入页面；
- `MusicPlayerService`、Android `MediaPlayer`、通知播放控制；
- `CRDownloadManager`、下载列表/卡片；
- `FavoriteStore`、`PlaylistStore`、SQLite 播放历史；
- 歌词、封面、歌单搜索/详情和播放地址接口；
- 循环、随机、进度、后台播放、下载路径、自动下载和主题设置。

只借鉴其功能分层、缓存/下载状态和页面适配思路，不复制代码、资源、签名或固定音源。

## 本轮代码修复

### 音乐

文件：`android/app/src/main/assets/src/scripts/10-music.js`

- 补回统一 `musicJson(text, source)`；
- 支持空响应、无效 JSON、二次 JSON 字符串和业务错误；
- 播放地址解析增加 `play_urls`、`urls`、`audio`、`music_url`、`download_url` 等结构；
- 歌曲规范化时保留数组型播放地址，交给统一解析器处理。

### Agent 轮数

文件：

- `android/app/src/main/assets/src/scripts/11-plugin-engine.js`
- `android/app/src/main/assets/src/scripts/14-update.js`

- `0` 现在表示按任务时间运行，不设工具轮数上限；
- 仍受 deadline、停止、取消和重复动作熔断限制；
- 设置 UI 增加“按任务时间”选项；
- 保存配置时不再把 0 转换成 5；
- 无限轮数的最终错误文案不再输出 `Infinity`。

## 自动验证

执行：

```bash
cd /workspace/gh-ElysiaFloat/android
node tools/build-html.js
node tools/smoke.js
./build.sh assembleDebug
```

结果：

- HTML 重新生成成功，17 个脚本模块；
- 冒烟测试增加了 `0 = 按任务时间` 的结构回归断言；
- Android Debug 构建成功；
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`；
- SHA-256：`0ea240cf94d28c5b3bcca5493464b4f86936da6cb5acb8c4baf6040e44639fc1`。

## 尚未完成

- `behavior.test.js` 尚未建立；
- 没有真实 GD Studio/Meting/CRMusic 网络验证；
- 302/403/429/签名过期和音频实际文件头仍待真机；
- 收藏持久化、下载索引、历史、歌单/队列和下载进度仍需按参考原型继续补齐；
- 音乐页面在不同悬浮窗尺寸、横屏、低版本 WebView 和厂商 ROM 上仍待验证。

## 下一步

1. 建立音乐 Provider/缓存行为测试；
2. 真机验证搜索、播放、收藏、歌词、缓存下载、离线播放和清理；
3. 按 CRMusic 的功能分层补充历史、队列/歌单、下载状态和页面适配；
4. 通过 G1 全部出口后再进入任务上下文和 RequestManager 收敛。
