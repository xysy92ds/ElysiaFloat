# ElysiaFloat v0.7.0

> 完整更新说明见 [`docs/history/0.7.0.md`](../../docs/history/0.7.0.md)；
> 上手教程见 [`docs/user-guide/tutorial.md`](../../docs/user-guide/tutorial.md)。

本目录是 0.7.0 的发布包与校验值。

- `ElysiaFloat-v0.7.0-debug.apk` —— Debug 测试包（versionCode 14 / versionName 0.7.0）
- `ElysiaFloat-v0.7.0-source.zip` —— 完整源码快照（含项目自有签名 keystore）
- `SHA256SUMS` —— APK 与源码包校验值

本版重点：

- G8 Termux 长跑运行时（run_id / 输出流 / 取消 / java + bash）+ Root 进程管理 + Shizuku 真实状态；
- 首个高权限官方插件：Minecraft 联机助手（服务器 + Mineflayer bot）；
- 横屏适配修复（BASE 恒定 + 窗口按比例夹持）；Kotlin wrapper 脚本转义修复；
- 修复主聊天页发送按钮点击无响应；公告改为按版本号记录，每个版本首次进入提示一次；
- **签名可复现**：debug 与 release 共用项目自有 keystore（`CN=ElysiaFloat`，SHA-256 `7851cb49…`）。

安装后校验：

```bash
sha256sum -c SHA256SUMS
```

> ⚠️ 升级提示：历史版本（≤0.6.5）用的是随机 debug 签名，其私钥不可获得，
> 因此从旧版升级到本版需**卸载旧版后再安装**（一次性）。从本版起，以后各版本可直接覆盖安装。

> 这是本地测试用的 Debug 包，不用于正式分发。
