# ElysiaFloat v0.7.1

本目录是 0.7.1 的发布包与校验值。

- `ElysiaFloat-v0.7.1-debug.apk` —— Debug 测试包（versionCode 16 / versionName 0.7.1）
- `ElysiaFloat-v0.7.1-source.zip` —— 源码快照（含项目自有签名 keystore）
- `SHA256SUMS` —— APK 与源码包校验值

本版只做纠错，功能与 0.7.0 一致：

- **修复主聊天页「发送」按钮点了没反应**。真实根因：`send()` 里 `routedTask` 声明为
  `const`，又在 `routeType === 'chat'` 分支用 `taskEnsureChat()` 重新赋值，运行期抛
  `Assignment to constant variable`；异常发生在清空输入 / 插入用户气泡之前，所以表现
  就是「点了没反应」。工作区 / 设备任务不走那次赋值，因此一直正常。现改为 `let`，
  并把聊天任务解析提前到与工作 / 设备同一段逻辑，三条路径统一落点。
- 发送失败不再静默：`sendSafe()` 兜住异常，复位按钮并在聊天里提示原因。
- 输入法还在组词、`textarea.value` 尚未提交时，先失焦提交再读取，避免「打了字发不出去」。
- 公告改为按 versionName 记录，0.7.1 首次进入会提示一次。

安装后校验：

```bash
sha256sum -c SHA256SUMS
```

签名与此前的 0.7.0 构建一致（`CN=ElysiaFloat`，SHA-256 `7851cb49…`），可直接覆盖安装，
不需要卸载。

> 注意：GitHub Release v0.7.0 上的 APK 是 versionCode 14 的旧构建，仍含发送按钮的
> `const` 缺陷；请以本目录的 0.7.1 为准。

> 这是本地测试用的 Debug 包，不用于正式分发。
