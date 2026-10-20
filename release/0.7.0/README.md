# ElysiaFloat v0.7.0

> 已由 [v0.7.1](../0.7.1/README.md) 取代：发布页上的 0.7.0 APK（versionCode 14）
> 仍含「主聊天发送按钮无响应」的 `const routedTask` 缺陷，请安装 0.7.1。

> 完整更新说明见 [`docs/history/0.7.0.md`](../../docs/history/0.7.0.md)；
> 上手教程见 [`docs/user-guide/tutorial.md`](../../docs/user-guide/tutorial.md)。

本目录是 0.7.0 的发布包与校验值。

- `ElysiaFloat-v0.7.0-debug.apk` —— Debug 测试包（versionCode 15 / versionName 0.7.0）
- `ElysiaFloat-v0.7.0-source.zip` —— 完整源码快照（含项目自有签名 keystore）
- `SHA256SUMS` —— APK 与源码包校验值

本版重点：

- G8 Termux 长跑运行时（run_id / 输出流 / 取消 / java + bash）+ Root 进程管理 + Shizuku 真实状态；
- 首个高权限官方插件：Minecraft 联机助手（服务器 + Mineflayer bot）；
- 横屏适配修复（BASE 恒定 + 窗口按比例夹持）；Kotlin wrapper 脚本转义修复；
- 修复主聊天页发送按钮（真实根因：`send()` 里 `routedTask` 声明成 `const` 又被 `taskEnsureChat()` 重新赋值，运行期抛异常；工作区/设备任务不走该分支所以一直正常）。现改为 `let`，并把聊天任务解析提前，使聊天 / 工作 / 设备三条路径统一落点；发送键同时加固为 `type="button"`、底端对齐、`z-index:80`（高于缩放热区 `.rz` 的 60），不再被 `.rz-se` 抢走点击；
- 公告改为按版本号记录，每个版本首次进入提示一次；
- **签名可复现**：debug 与 release 共用项目自有 keystore（`CN=ElysiaFloat`，SHA-256 `7851cb49…`）。
- versionCode 提升到 15，可直接覆盖任意此前的 0.7.0 构建。

安装后校验：

```bash
sha256sum -c SHA256SUMS
```

> ⚠️ 升级提示：历史版本（≤0.6.5）用的是随机 debug 签名，其私钥不可获得，
> 因此从旧版升级到本版需**卸载旧版后再安装**（一次性）。从本版起，以后各版本可直接覆盖安装。

> 这是本地测试用的 Debug 包，不用于正式分发。
