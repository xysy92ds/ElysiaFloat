# 工作记录：主聊天发送键逻辑统一 + 点击热区加固

日期：2026-10-17
状态：代码修改完成；build-html --check 与 smoke 全绿；Android 构建成功；产物与校验值已更新；待推送与真机验证

## 1. 现象与复现

用户反馈（本轮）：主聊天界面点「发送」，现在会唤起键盘但消息发不出去；而工作区里的发送同样是这个按钮却能发，质疑两条路径的逻辑不统一。

复现方式（本地，不依赖真机）：用 `tools/harness.js` 的假 DOM/假桥接真跑 `index.html`，取 `#send` 元素直接调用它的 `onclick` 处理器，即可离线复现整条发送链路。

- 修复前：`#send` 点击 → `send()` 在 `const routedTask` 处抛 `Assignment to constant variable`（抛在清空输入 / `addMsg` 之前）→ 输入框不清空、无气泡，表现为「点了没反应」。
- 关键差异：工作区 / 设备任务走 `if (inPersistent ...) routeType = cur.type`，`routeType` 不是 `chat`，**不会**执行 `if (routeType === 'chat') routedTask = taskEnsureChat();`，因此从来没踩到这行赋值 → 「工作区能发、聊天不能发」。

## 2. 根因

`send()` 里把 `routedTask` 声明成 `const`，随后又在 chat 分支用 `taskEnsureChat()` 重新赋值。这是运行期才炸的写法，语法检查查不出，且只影响聊天路径——完全对应「聊天点发送没反应、工作区正常」。

## 3. 修改

| 文件 | 处理 |
|---|---|
| `assets/src/scripts/12-send-quick.js` | 把聊天任务解析**提前**到与工作 / 设备任务同一段逻辑里：`let routedTask = await routeTask(...)` → `if (routeType === 'chat') routedTask = taskEnsureChat();` → 之后工作区校验、附件导入、`taskBegin` 共用同一条落点。三条路径统一，`const` 赋值分歧彻底消除。 |
| `assets/src/template.html` | 发送键显式声明 `type="button"`。 |
| `assets/src/styles/main.css` | `#send` 增加 `align-self:flex-end; min-height:38px; position:relative; z-index:80`——抬到窗口缩放热区 `.rz`（`z-index:60`）之上，任何机型安全区 / 布局差异下都不会被 `.rz-se` / `.rz-s` 抢走这一下点击。 |
| `android/app/build.gradle` | `versionCode 14 → 15`（versionName 仍 0.7.0），保证可直接覆盖任意此前的 0.7.0 构建。 |
| `tools/smoke.js` | 保留「routedTask 用 let、chat 分支覆盖存在」断言；新增「发送键 z-index > 60、align-self:flex-end、type=button」断言，钉死不变量。 |

## 4. 验证

```text
node tools/build-html.js        index.html 重建，18 个脚本模块，SHA-256 5f53a85eb498…
node tools/build-html.js --check 与模块一致
node tools/smoke.js             全部通过（含 const 回归 + 发送键热区两条新断言）
harness 运行期复现              点击 #send → input 清空、body 新增 2 个节点（用户气泡 + 回复）、无 unhandledRejection
gradle assembleDebug            BUILD SUCCESSFUL（versionCode 15 / versionName 0.7.0）
apksigner verify --print-certs  CN=ElysiaFloat，SHA-256 7851cb49…
```

## 5. 发布产物

```text
apk/ElysiaFloat-v0.7.0-debug.apk
release/0.7.0/ElysiaFloat-v0.7.0-debug.apk
release/0.7.0/ElysiaFloat-v0.7.0-source.zip
release/0.7.0/SHA256SUMS / apk/ElysiaFloat-v0.7.0-SHA256SUMS
```

- APK SHA-256：`9382334689e58af746fa19d29ed03452c9b4cc151412800b9f1351984257c93e`
- source.zip SHA-256：`f19ef4978bd5d31e8fd0ab483b848d85ae3421a24c86f10c97e574b057a181ef`
- APK 内 `assets/index.html` 已核对：`let routedTask` 1 处、无 `const routedTask`、`z-index:80` 1 处、`id="send" type="button"` 1 处。
- `release/latest.json` 的 body 与 SHA-256 同步更新。

环境说明：`build.sh` 内写死的 `JAVA_HOME=/workspace/alpine-jdk/...` 在本沙箱不存在，本轮直接用 `JAVA_HOME=/workspace/jdk17 GRADLE_USER_HOME=/workspace/gradle-home LD_PRELOAD=/workspace/libremovefix.so gradle assembleDebug` 构建。

## 6. 真机待确认

1. 主聊天输入文字点「发送」：输入框清空、出现用户气泡、AI 开始回复；
2. 点发送键不会只弹键盘（说明点击确实落在按钮上，而非穿透到输入框）；
3. 处于工作 / 设备任务时，同一个发送键行为一致（与聊天共用同一段逻辑）；
4. 从上一版 0.7.0（versionCode 14）直接覆盖安装到本包（versionCode 15）无签名冲突。

## 7. 剩余风险 / 下一步

- 若真机上仍表现为「只弹键盘不发送」，说明触点在设备上仍未落到 `#send`（如叠加窗口的触摸坐标偏移），需要真机日志进一步定位；
- 推送前做一次凭据扫描；本轮改动尚未提交。

## 8. 补充排查（2026-10-20）：为什么修完还是“仍然不可以”

用户反馈「仍然不可以」后做了交付链路核对，结论：**代码修复本身有效，但修复从未到达用户手机**。

证据：

- GitHub Release `v0.7.0` 的 APK 资产：2631039 字节，SHA-256 `557e4c9abeeb…`（versionCode 14）；
- 该 APK 对应的 `origin/main@88f4d72` 源码里仍然是 `const routedTask = await routeTask(...)`；
- 本轮修好的包是 versionCode 15 / SHA-256 `9382…`，只存在于本地，未提交、未上传；
- `git status` 显示关键改动（12-send-quick.js、versionCode、APK、latest.json）全部是未提交状态；
- 应用内「检查更新」取的是公开仓库 `xysy92ds/ElysiaFloat` 的 `release/latest.json`，内容仍是 v0.6.5（旧签名），与私有仓库 `-v0.7` 不是同一个源；
- 因此用户从发布页或更新入口拿到的永远是旧包，看到的当然还是同一个 `const` 异常。

处理：

1. 版本前移：`versionCode 16 / versionName 0.7.1`，让用户和更新检查都能区分新旧包；
2. `sendSafe()`：兜住 `send()` 前半段异常，复位按钮并把失败原因显示在聊天里，不再静默；
3. 输入法组词未提交时先 `blur()` 提交再读 `value`，覆盖「打了字却读到空串」的情况；
4. 公告标题改为 0.7.1，用户进应用即可确认自己装的是不是新包；
5. 重新构建、重算校验值、提交并推送，同时把 0.7.1 的 APK / 源码上传到私有仓库 Release。

0.7.1 产物：

- APK：`apk/ElysiaFloat-v0.7.1-debug.apk`，versionCode 16 / versionName 0.7.1，
  SHA-256 `4b9b9cbbda98f923012439932972c1d0f3002d05b870d0a20827d261d802ee4c`；
- source.zip：`release/0.7.1/ElysiaFloat-v0.7.1-source.zip`，
  SHA-256 `d72fab848f99d81e9dcdfd472a324178a84952caacd98d7aa8c214fa1b84d0e3`；
- 签名：`CN=ElysiaFloat`，SHA-256 `7851cb49…`，与 0.7.0 一致，可直接覆盖安装。

