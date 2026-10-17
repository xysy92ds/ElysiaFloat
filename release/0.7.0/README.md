# ElysiaFloat v0.7.0

> 完整更新说明见 [`docs/history/0.7.0.md`](../../docs/history/0.7.0.md)；
> 上手教程见 [`docs/user-guide/tutorial.md`](../../docs/user-guide/tutorial.md)。

本目录是 0.7.0 的发布包与校验值。

- `ElysiaFloat-v0.7.0-debug.apk` —— Debug 测试包（versionCode 14 / versionName 0.7.0）
- `SHA256SUMS` —— APK 校验值

本版重点：

- G6 真正的 `FullscreenActivity`（WebView 迁移，状态不丢）；
- G8 Termux 长跑运行时（run_id / 输出流 / 取消 / java + bash）+ Root 进程管理 + Shizuku 真实状态；
- 首个高权限官方插件：Minecraft 联机助手（服务器 + Mineflayer bot）；
- 横屏适配修复；Kotlin wrapper 脚本转义修复。

安装后校验：

```bash
sha256sum -c SHA256SUMS
```

> 这是本地测试用的 Debug 包，不用于正式分发。
