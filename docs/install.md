# 安装与升级

## 1. 下载

在 [Releases](https://github.com/xysy92ds/ElysiaFloat/releases) 页面下载最新测试版：

```text
ElysiaFloat-v<版本>-debug.apk
SHA256SUMS
```

`SHA256SUMS` 同时包含 APK 与源码包的校验值。

## 2. 校验

```bash
sha256sum -c SHA256SUMS
```

或在手机上用任意文件校验工具比对 Release 说明中的 SHA-256。

## 3. 安装

1. 允许当前文件管理器/浏览器「安装未知应用」；
2. 点击 APK 安装；
3. 首次打开后按引导授予权限。

安装包使用项目统一测试签名（构建类型为 debug），用于内测与验证，不作为正式分发版本。

## 4. 升级

| 当前版本 | 升级方式 |
|---|---|
| 0.7.x | 直接覆盖安装，应用内数据保留 |
| 0.6.x 或更早 | 首次升级到 0.7.x 需先卸载旧版（旧版使用另一把调试签名）。卸载会清除应用内数据，请先导出需要保留的内容 |

后续版本只要签名不变，都可直接覆盖安装。可以查看「设置 → 关于」确认当前版本号与 `versionCode`。

## 5. 应用内更新

「检查更新」会读取本仓库的 `release/latest.json`，比较版本号后展示更新说明，并可从 GitHub Release 下载 APK。网络受限或 GitHub 不可达时，可回到 Release 页面手动下载。

## 6. 卸载与数据

卸载应用会同时删除应用私有数据（配置、聊天记录、长期记忆）。工作区位于公共存储：

```text
Documents/ElysiaFloat/workspace
```

卸载后工作区文件仍然保留，需要时可手动删除。
