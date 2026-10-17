# 工作记录：彻底移除全屏功能 + 横屏窗口夹持加固

日期：2026-10-17
状态：代码修改完成；smoke 全绿；Android 构建成功；产物与校验值已更新；已提交并推送

## 1. 彻底移除全屏功能

用户确认全屏（FullscreenActivity）一直未真正落地，要求从工程中彻底删除。

改动点：

| 位置 | 处理 |
|---|---|
| `java/com/elly/float/FullscreenActivity.kt` | 删除文件 |
| `AndroidManifest.xml` | 删除 `<activity android:name=".FullscreenActivity" .../>` 注册 |
| `java/com/elly/float/PermissionBridge.kt` | 删除 `setFullscreen` / `isFullscreen` / `getScreenMetrics` 桥接口 |
| `assets/src/scripts/15-views.js` | 删除 `FULLSCREEN_MODE` / `FULLSCREEN_PREV` / `readScreenMetrics` / `updateFullscreenButton` / `toggleFullscreenMode` 及 `#btn-fullscreen` 绑定 |
| `assets/src/template.html` | 删除 `<button id="btn-fullscreen">` 与公告里的「真全屏」条目 |
| `assets/src/styles/main.css` | 删除 `#btn-fullscreen` / `#btn-fullscreen.unsupported` 规则 |
| `tools/smoke.js` | 删除原 G6 全屏断言，替换为「全屏功能已彻底移除」断言 |

验证：重新生成 `index.html` 后，在 `assets/` 与 `java/` 全量检索 `fullscreen|Fullscreen|FULLSCREEN|全屏`，除发布说明外无残留。

## 2. 横屏打开浮窗卡左上角、无法缩放的根因与修复

### 根因

- `baseSize()` 原先按 `dm.widthPixels / dm.heightPixels` 计算。旋转后宽高互换，导致 BASE 比例在横竖屏之间变化；
- `clampRect()` 又对宽、高**各自独立**夹持，使窗口比例与内容基准比例脱节。

两者叠加后，内容（`#app` 以 `transform-origin: top left` 缩放）与窗口不再等比：视觉上内容缩在窗口左上角，缩放角标（`.rz`）也被推到窗口可点区域之外——表现为「卡在左上角、拉不动大小」。

### 修复

- [FloatService.kt](../../android/app/src/main/java/com/elly/float/FloatService.kt) `baseSize()`：改用**短边/长边**计算并加 `baseCache` 缓存，保证同一设备横竖屏算出的 BASE 完全一致；
- `clampRect()`：以宽度为准、按 `BASE` 恒定宽高比推高度，高度放不下时两者按同一比例回收，绝不破坏比例；用 `onConfigurationChanged` 在旋转时以新屏幕尺寸重新夹持窗口与迷你条。

## 3. 本轮构建与验证

```text
node tools/build-html.js          index.html 重建，18 个脚本模块，SHA-256 24c33f8c3e35…
node tools/smoke.js               全部通过（含新增全屏移除 / 横屏夹持断言）
gradle assembleDebug              BUILD SUCCESSFUL（34 tasks）
apksigner verify --print-certs    CN=ElysiaFloat，SHA-256 7851cb49…
sha256sum -c                      包校验 OK
```

环境说明：`build.sh` 内写死的 `JAVA_HOME=/workspace/alpine-jdk/...` 在本沙箱不存在，本轮改用 `/workspace/jdk17` 直接调用 Gradle（`GRADLE_USER_HOME=/workspace/gradle-home`，`LD_PRELOAD=/workspace/libremovefix.so`）。后续如在同类环境重建，需按实际 JDK 路径覆盖。

## 4. 发布产物

```text
apk/ElysiaFloat-v0.7.0-debug.apk
release/0.7.0/ElysiaFloat-v0.7.0-debug.apk
release/0.7.0/ElysiaFloat-v0.7.0-source.zip
release/0.7.0/SHA256SUMS
```

- APK SHA-256：`df9572da419317c2b1b0525dcf76e61571c61afd73bb3cb52d2e1e071c882634`
- source.zip SHA-256：`c150fc424e6bfad0e4894c29844eb8c8f4c8e700292d308c3249337ab1aec003`
- `release/latest.json` 的 body 内 SHA-256 同步更新。

## 5. 签名问题说明（用户反馈「又提示签名不匹配」）

- 本项目 debug/release 共用项目自有 keystore（`CN=ElysiaFloat`），本轮产物签名与上一版 0.7.0 完全一致，**0.7.0 → 0.7.0 可直接覆盖安装**；
- 签名不匹配只会出现在从 **≤0.6.5** 升级时：那些版本使用随机生成的 debug.keystore，私钥不可获得，需卸载旧版后一次性重装。

## 6. 提交与推送

```text
commit 496d5c7  fix(0.7.0): 彻底移除全屏功能并加固横屏窗口夹持
push  88f4d72..496d5c7  main -> main
```

沙箱内原本无 GitHub 凭据（`gh` 未登录、无 credential helper / `.git-credentials` / `.netrc`）。本轮由用户提供一次性 PAT，仅在单条 `git push` 的 URL 中使用；推送后核对：remote 仍为明文 URL、credential helper 为空、`.git` 内无 token 残留。

## 7. 真机待确认

1. 横屏（游戏内）打开浮窗：窗口比例正确、不缩在左上角；
2. 横屏下拖动边缘缩放：角标可点、比例保持、窗口不跑出屏幕；
3. 旋转后窗口自动重新夹持，迷你条仍在可视范围内；
4. 全屏按钮已消失，界面无空位或残留绑定报错；
5. 从上一版 0.7.0 覆盖安装，不再提示签名不匹配。
