# ElysiaFloat v0.7.2

本目录是 0.7.2 的发布包与校验值。

- `ElysiaFloat-v0.7.2-debug.apk` —— Debug 测试包（versionCode 17 / versionName 0.7.2）
- `ElysiaFloat-v0.7.2-source.zip` —— 源码快照（含项目自有签名 keystore）
- `SHA256SUMS` —— APK 与源码包校验值

本版重点是「安全确认精简」和「复制粘贴修复」，功能与 0.7.1 一致：

- **工作任务内操作手机不再被切任务**。此前 `routeTask('device')` 只复用同类型任务，
  在工作区任务里让 AI 操作手机时会新建一个 `device` 任务、并要求重新进入工作区。
  现在当前任务只要是 `device` 或 `workspace` 且可继续，就直接复用，不再另起任务。
  发送链路也改为按路由后的实际任务类型 `taskBegin`，不再按消息意图二次建任务。
- **能力级授权（consent）**：进入工作区/手机任务时授权一次，30 分钟内有效，
  任务结束/删除/应用重启即失效。授权只存内存，不落盘。
- **仍逐次确认的操作**：密码、支付、卸载、发送消息、外部文件删除保持每次询问；
  工作区内写入免逐次确认，外部文件修改/复制/新建在授权有效期内合并确认一次。
- **修复长按菜单点不动**（I-048）：菜单项原先用 `onclick`，而 `touchend` 会在 0ms 后
  隐藏菜单，click 派发前目标已消失；改为 `bindTap` 并在命中 `#ctx-menu` 时不隐藏。
  剪贴板读取失败时给出明确指引，而不是静默失败。
- 公告按 versionName 记录，0.7.2 首次进入会提示一次。

安装后校验：

```bash
sha256sum -c SHA256SUMS
```

签名与 0.7.0 / 0.7.1 一致（`CN=ElysiaFloat`，SHA-256 `7851cb49…`），可直接覆盖安装。

公开测试版发布：

- 仓库：`https://github.com/xysy92ds/ElysiaFloat`
- Release：`https://github.com/xysy92ds/ElysiaFloat/releases/tag/v0.7.2`（已标记 Latest）
- tag：`v0.7.2`，commit `cb10e91`（索引 `1b2e09a`），Release ID `422140702`
- 说明：Release 标题保留 “Beta”，GitHub 上按 Latest 展示，便于访客直接下载
- 资产：`ElysiaFloat-v0.7.2-debug.apk`、`ElysiaFloat-v0.7.2-source.zip`、`SHA256SUMS`
- APK SHA-256：`6cf5ff194090e1827ee053db340665a3a43a4e3bcca914f159b7845fd3356b03`

> 这是测试用的 Debug 包，不用于正式分发。
>
> 本目录 APK 与公开 Release 资产为同一构建；私有仓库的 Release 仅作内部归档，
> 匿名访问会得到 404，公开下载请使用上面的公开 Release 链接。
> `/workspace` 内测下发仍使用 `apk/ElysiaFloat-v0.7.2-debug.apk`。
