# 0.7.2：安全确认精简（G2-005）与长按菜单修复（I-048）

日期：2026-10-24
版本：versionCode 17 / versionName 0.7.2（Debug）
APK：`apk/ElysiaFloat-v0.7.2-debug.apk`
SHA-256：`b74756e021a9e3066b7e2eda18e0c0d19b13a8435bac2ac239083dd08aca848d`
签名：`CN=ElysiaFloat`，证书 SHA-256 `7851cb49…`（与 0.7.0/0.7.1 相同，可覆盖安装）

## 1. 用户诉求

1. 在工作区任务里让 AI 操作手机，会弹出授权，然后要重新开一个工作区，任务链被打断（I-049）。
2. 不要每次都做安全验证：开完权限后，同一任务内应复用；但密码/支付/卸载/发送仍必须逐次确认。
3. 覆盖窗口里长按菜单点不动、聊天框粘贴不进去（I-048）。

用户通过选项确认的规则：

- 授权时效：**30 分钟 / 任务结束失效**；
- 必须逐次确认：**密码、支付、卸载、发送**。

## 2. 实现

### 2.1 任务粘性（I-049）

`03-state-tasks.js` 的 `routeTask('device')` 原先只复用同类型任务，跨类型一律 `taskAdd('device')`，
导致 workspace 任务被留在后台。现改为：

```js
if (old && (old.type === 'device' || old.type === 'workspace') && taskContinuable(old)) {
  if (!(await ensureDeviceConsent(old))) return null;
  return old;
}
```

`12-send-quick.js` 改为按路由后的实际任务类型收尾：

```js
if (routeType !== 'quick') taskBegin(routedTask.type, routedTask.title, t || routedTask.goal, ...);
```

不再按消息意图二次建任务，避免「发一句话就新建一个任务」。

### 2.2 能力级授权（consent）

新增块（仅内存，不落盘；应用重启即失效）：

```js
const CONSENT_TTL_MS = 30 * 60 * 1000;
consentGrant(taskId, cap)      // 记录 + 写 taskEvent('consent_granted')
consentGranted(taskId, cap)    // 到期即删除并返回 false
consentRevokeTask(taskId)      // 任务删除时撤销
ensureDeviceConsent(task)      // 进入 device/workspace 时确认一次
ensureExternalWriteConsent()   // 外部文件写入/复制/新建合并确认
```

接入点：

- `taskToolsAllowed(type, name, taskId)`：workspace 任务在已授权时可调用 device 工具；
- `10-music.js`：`screenshot` / `watch_screen` 用 `consentGranted(task.id, 'device')`；
- `external_file_write` / `external_file_copy` / `external_file_mkdir` 走 `ensureExternalWriteConsent`；
- `external_file_delete` 保持逐次 `uiConfirm`；
- `deleteTask()` 调用 `consentRevokeTask()`。

### 2.3 长按菜单（I-048）

菜单项原用 `onclick`，`touchend` 在 0ms 后 `hideCtxMenu()`，click 派发时目标已消失。
改为 `bindTap`，并让 `touchend` 命中 `#ctx-menu` 时直接 return：

```js
bindTap(b, () => { hideCtxMenu(); try { it.run(); } catch (err) { toast('操作失败'); } });
document.addEventListener('touchend', (e) => {
  cancel();
  if (e.target && e.target.closest && e.target.closest('#ctx-menu')) return;
  setTimeout(() => { if (!ctxSelectionText()) hideCtxMenu(); }, 0);
}, { passive: true });
```

`pasteIntoField` 空剪贴板时改为「读不到剪贴板：先点一下输入框，或用键盘上的“粘贴”键」。

## 3. 验证

```bash
cd android
node tools/build-html.js --check   # index.html 与模块一致（892df3b7623c…）
node tools/smoke.js                # 全部通过
./build.sh assembleDebug --offline # BUILD SUCCESSFUL
```

新增/更新的 smoke 用例：

- 「I-048：长按菜单项不会被 touchend 提前隐藏」——断言 `bindTap` 用法、禁止旧 `onclick` 写法、
  要求 `closest('#ctx-menu')` 分支；
- 「G2-005：任务粘性 + 能力授权（30 分钟，重启失效）」——断言 TTL、授权不落盘、routeTask 复用、
  `taskBegin(routedTask.type,`、截图复用授权、`ensureExternalWriteConsent` ≥3 处、
  外部删除仍 `uiConfirm`，并在沙箱里验证授权、任务隔离、撤销与重启失效。

## 4. 构建备注

构建机 `JAVA_HOME` 曾被指向 JDK 25，AGP 8.6 不支持，Gradle daemon 卡在解析依赖
（`ss` 可见 SYN-SENT 到远端 443）。`build.sh` 改为无条件优先 `/workspace/jdk17`；
本项目依赖已缓存，构建命令固定加 `--offline`，避免在受限网络里重复解析仓库。

## 5. 产物

- `apk/ElysiaFloat-v0.7.2-debug.apk` + `apk/ElysiaFloat-v0.7.2-SHA256SUMS`
- `release/0.7.2/`：APK、`ElysiaFloat-v0.7.2-source.zip`、`SHA256SUMS`、`README.md`
- `release/latest.json` 指向 v0.7.2
- `MANIFEST.txt` 重新生成

## 6. 待真机验证

1. 工作区任务里让 AI 操作手机：不新建任务、不要求重开工作区；
2. 30 分钟内第二次操作手机：不再弹确认；任务结束/删除/重启后再操作：重新确认；
3. 密码/发送/支付/卸载/外部文件删除：仍然每次确认；
4. 长按文本弹出菜单后可点「复制/粘贴/全选」；聊天框可从系统剪贴板粘贴。
