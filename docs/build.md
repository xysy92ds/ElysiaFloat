# 从源码构建

## 1. 环境要求

| 项目 | 版本 |
|---|---|
| JDK | 17 |
| Android SDK | 34（`compileSdk 34`） |
| Build-Tools | 34.0.0 |
| Gradle | 由仓库内 `gradlew` 提供（8.9） |
| Android Gradle Plugin | 8.6.1 |
| Kotlin | 1.9.20 |
| Node.js | 仅前端构建与静态检查需要 |

项目没有第三方 AAR 依赖，只使用 Android Framework 与系统 WebView。

## 2. 配置 SDK

任选一种：

```bash
export ANDROID_HOME=/path/to/android-sdk
```

或在 `android/local.properties` 写入：

```properties
sdk.dir=/path/to/android-sdk
```

`local.properties` 包含本机路径，已被 `.gitignore` 忽略，不要提交。

## 3. 构建 APK

```bash
cd android
./gradlew assembleDebug
```

产物：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

发布构建：

```bash
./gradlew assembleRelease
```

## 4. 签名

仓库**不包含**签名私钥。签名配置读取 `android/keystore.properties`：

```properties
storeFile=keystore/elysia.jks
storePassword=******
keyAlias=elysia
keyPassword=******
```

- 文件存在时，`debug` 与 `release` 都使用项目签名；
- 文件不存在时，回退到系统 Debug 签名，保证任何环境都能直接构建；
- 使用系统 Debug 签名构建的 APK **不能覆盖安装**官方包；
- `keystore/` 与 `keystore.properties` 均不应提交到仓库。

## 5. 前端资源

前端源码位于：

```text
android/app/src/main/assets/src/
├── scripts/      # 按编号拆分的 JS 模块
├── styles/
├── template.html
└── manifest.json
```

构建前可重新生成单文件页面：

```bash
cd android
node tools/build-html.js
```

检查生成结果是否与源码一致：

```bash
node tools/build-html.js --check
```

仓库已包含生成后的 `assets/index.html`，普通构建不需要额外执行。

## 6. 静态检查

```bash
cd android
node tools/smoke.js
```

`smoke.js` 使用 Node 的 `vm` 模块加载页面脚本，桩掉 Android 桥与部分 DOM，验证工具开关、插件清单、版本比较、任务路由、设置保存等关键逻辑。全部通过会输出 `✓ 全部通过`；失败会列出用例并以非零状态退出。

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| `SDK location not found` | 设置 `ANDROID_HOME` 或 `local.properties` |
| `Unsupported class file major version` | 使用 JDK 17，不要使用 JDK 21/25 |
| 依赖下载失败 | 检查能否访问 `google()` 与 `mavenCentral()`，或配置代理 |
| `aapt2` 执行失败 | 确认 Build-Tools 34.0.0 已安装且架构匹配 |
| `Failed to delete '/tmp/tempdir_...'` | 少数受限内核（seccomp）环境会遇到；`tools/` 下有说明与 `LD_PRELOAD` 垫片，普通 Windows/Linux/macOS 不需要 |

## 8. 可复现性

- 版本号固定在 `android/app/build.gradle` 的 `versionCode` 与 `versionName`；
- Release 资产包含 `SHA256SUMS`，可对照校验；
- 由于缺少私钥，自行构建的 APK 与官方包签名不同，这是预期行为。
