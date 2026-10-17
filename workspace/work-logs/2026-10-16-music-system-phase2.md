# 工作记录：音乐系统第二阶段实现

日期：2026-10-16
状态：音乐功能代码实现完成；自动验证通过；真实 Provider 和真机验收待进行

## 本轮目标

在第一阶段解析回归修复的基础上，继续完成音乐系统的基础产品闭环，并保证设置、主题和悬浮窗页面的一致性。

## 已实现

### 搜索和速度

- GD Studio/Meting 搜索接口支持页码参数；
- 支持继续加载更多结果；
- 保留多来源并行搜索、合并、去重和来源标识；
- 搜索来源单独失败不会阻塞其它来源；
- 搜索结果最多保留 120 条，避免 WebView 列表无限膨胀；
- 歌曲记录增加封面、来源和目录展示；
- 封面异步加载失败时降级为音符占位；
- 播放历史按配置上限保存，默认 100 条。

### 页面和基础功能

音乐页新增并接通：

- 搜索；
- 收藏；
- 播放历史；
- 播放队列；
- 缓存列表；
- 加入队列；
- 收藏/取消收藏；
- 单曲缓存/删除；
- 全部清理缓存；
- 加载更多结果。

播放后会记录历史；队列和历史使用独立 SharedPreferences 数据键，不写入聊天历史。

### 缓存下载

- JS 侧记录解析中、下载中、校验中、完成和失败状态；
- 原生 `JsBridge.cacheMusic()` 增加下载进度回调；
- 新增 `Android.deleteCachedMusic()` 单曲删除接口；
- 缓存记录保存歌曲元数据、进度、路径和错误；
- 自动缓存可在设置中开启；
- 缓存仍使用临时文件、最终音频校验和公共目录/私有目录回退策略。

### 设置和主题

音乐设置现在包括：

- 开启音乐；
- 音质；
- 音乐来源目录；
- Meting 实例；
- 自动缓存播放歌曲；
- 保存播放历史；
- 历史上限；
- 是否显示结果来源。

音乐页的背景、按钮、播放器进度条、封面占位、Tab、缓存按钮和队列按钮使用 `--c1`、`--c2`、`--bg`、`--card` 等主题变量，不再单独固定一套粉色默认值。修改设置页主主题色后，音乐页跟随主题变化。

## 修改文件

- `android/app/src/main/assets/src/scripts/02-config.js`
- `android/app/src/main/assets/src/scripts/10-music.js`
- `android/app/src/main/assets/src/scripts/14-update.js`
- `android/app/src/main/assets/src/scripts/15-views.js`
- `android/app/src/main/assets/src/scripts/16-permission-boot.js`
- `android/app/src/main/assets/src/template.html`
- `android/app/src/main/assets/src/styles/main.css`
- `android/app/src/main/java/com/elly/float/JsBridge.kt`
- `android/tools/smoke.js`

## 自动验证

```text
node tools/build-html.js       通过
node tools/smoke.js            全部通过
./build.sh assembleDebug       成功
git diff --check               通过
```

当前 APK：

```text
android/app/build/outputs/apk/debug/app-debug.apk
SHA-256: dd8aea33d35f087038cbf9e05562d351758e4dbf48601b4e69aabed25b483e92
```

## 未完成的验证，不宣称已完成

- 真实 GD Studio/Meting/CRMusic 服务搜索分页；
- 真实播放地址、302、403、429、签名过期；
- 真实缓存下载进度、文件头和单曲删除；
- 离线播放和息屏播放；
- 公共 `Music/ElysiaFloat/cache` 目录可见性；
- 收藏、历史、队列、歌词页面的真机触摸和返回；
- 小悬浮窗、长屏、横屏、低版本 WebView 和不同 ROM 的布局。

## 下一步

1. 在真机执行音乐验收矩阵；
2. 根据真实来源响应修正 Provider 兼容分支；
3. 处理发现的 UI/权限/缓存问题；
4. 通过真机出口后再关闭 G4，进入 G5 DeviceTask 可靠性阶段。
