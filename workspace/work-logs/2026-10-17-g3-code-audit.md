# 工作记录：G3 完成后代码级复查（第三轮加固）

日期：2026-10-17
状态：复查完成；修复 3 处真实隐患；新增 5 项回归；clean 构建 + 产物级校验通过

## 复查范围

不做功能新增，只找「改出来的新问题」和「留给未来的隐患」：

1. 模块加载顺序与作用域（构建产物是单 IIFE，函数不可全局访问 —— 这也解释了几次探测失败的误判）；
2. 构建产物语法、重复标识符；
3. 全部 `reqRequest` 调用点的参数正确性；
4. 取消路径、重试路径、超时路径；
5. 原生死循环 / 资源释放 / 线程安全；
6. 任务状态与 deadline 生命周期；
7. 用户可见的错误文案；
8. 插件 SSRF 与跨域策略是否仍在；
9. 产物级验证（解包 dex + assets 核对符号）。

## 发现并修复的 3 个真实缺陷

### 1. 取消被包装成可重试的网络错误（严重）

`cancelTaskRequests()` 原来 `reject(new Error('任务已取消'))`，
`reqRequest` 只认 `e.requestError` 标志，于是把它包成 `NETWORK_ERROR` —— **而 NETWORK_ERROR 是可重试的**。
结果：用户点停止 → 请求不会结束，反而重试 2 次，最后一次要等到 60s/200s 超时才回来。
实测（临时脚本）：取消后请求挂住直到进程被杀。

修复：

- 新增 `reqCancelledError()`（`code=CANCELLED`、`cancelled=true`）；
- `cancelTaskRequests` 与迟到回调（运行令牌过期）都改用它；
- `reqRequest` 的 catch 分支增加兜底：非 `requestError` 但带 `cancelled` 或消息含「取消/已停止/cancel」的，一律归类 CANCELLED。

验证：取消后 `code=CANCELLED`、`reqIsRetriable=false`、审计只有 1 条尝试记录。

附带收益：运行令牌过期的迟到回调原来被静默丢弃 → Promise 悬挂到超时（最长 200s），现在立刻以 CANCELLED 结束。

### 2. 长任务恢复后 deadline 仍是过去时间

`taskResume()` 只改 `state/error/progress`，没有重置 `deadline`。
用户暂停一个 20 分钟的任务、过一会儿恢复，`chatReqTools` 会算出剩余时间为负 → 立刻 `DEADLINE_EXCEEDED`，
表现就是「恢复后一发消息就报超时」。

修复：恢复时按任务类型重置预算（chat 30s，其它 `CONFIG.agentTaskTimeout`）。

### 3. 用户主动停止显示「错误：任务已取消」

停止是正常操作。原来 `send()` 的 catch 无条件 `addMsg('assistant','错误：'+errMsg(e))`。

修复：

- `send()`：CANCELLED → 显示「已停止本轮执行~」，任务状态 `cancelled`，不写成 failed；
- 快捷操作：CANCELLED → 结果卡片「已取消」，`quickOperationFinish(...,'cancelled')`。

## 顺手加固

- `errMsg()` 现在把统一错误码附在文案后（`HTTP 429〔RATE_LIMITED〕`），已有则不重复；字符串错误原样返回；
- `reqNormalize` 把 `timeoutMs` 夹紧到 1s~600s，避免 0/负数导致 `setTimeout` 立即触发或异常。

## 复查通过、未发现问题的项

| 检查 | 结果 |
|---|---|
| 构建产物语法（单 IIFE，333KB） | 通过 |
| 重复 `function` / 顶层变量声明 | 无 |
| 模块顺序（`00-compat` → `00b-request` → … → `16-permission-boot`） | 正确，`reqCancelledError` 同作用域提升可用 |
| `pendingReq` 泄漏 | 每分支都 delete，超时/取消/迟到均清除 |
| 原生 `activeRequests` | `ConcurrentHashMap`，redirect/异常/`finally` 三处都移除 |
| 原生重定向死循环 | `hops >= maxRedirect` 先判再跳，不会死循环 |
| 原生大小限制 | `readCapped` 超限即断，返回 `TOO_LARGE` |
| 插件 SSRF 校验 | 两条路径（工具执行 / `host.request`）都保留 `plugNetworkAllowed` + `plugUrlAllowed` |
| 裸网络调用 | 仅 `00b-request.js`（自身传输层）；`14-update.js` 的 `Android.requestInstallPermission` 是安装权限，非网络 |
| clean 构建 | 成功，0 error，36 warning 全部是既有 deprecated API，非本轮引入 |
| 产物级核对 | `classes3.dex` 含 `requestEx/readCapped/sameHost/REDIRECT_ERROR/TOO_LARGE/AUTH_ERROR/RATE_LIMITED` 与中文提示；`assets/index.html` 含 `reqCancelledError/musicStripVolatile/reqSameHostOnly/已停止本轮执行` |

## 端到端实测（harness 真实调用链）

```
✓ 音乐搜索        16 首
✓ 音乐歌词解析    正常
✓ 音乐播放地址    https://example.invalid/song.mp3
✓ 插件 HTTP       成功
✓ 更新检查        成功
✓ 微软翻译        成功
✓ 记忆向量        dim=8
✓ TTS 音色        成功
✓ 聊天 chatReq    返回正常（模型预算 200000ms，工具预算 200000ms）
✓ 任务状态机      非法迁移被拒绝
```

## 新增回归（smoke 常驻）

`G3 加固：取消语义、停止中性化、恢复重置预算、错误码可见`

1. 任务取消 → `CANCELLED`、不可重试、仅 1 次尝试；
2. token 取消 → `CANCELLED`；
3. 恢复任务 → `deadline > now`；
4. `errMsg` 显示错误码且不重复拼接；字符串错误不被改写；
5. 停止路径含 CANCELLED 分支、中性提示、任务标 cancelled。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致（d69145d9…）
node tools/smoke.js                全部通过
./build.sh clean && assembleDebug   成功，0 error
sha256sum -c                       包校验 OK
```

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g3-audited-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g3-audited-debug-SHA256SUMS
```

SHA-256：`11968829269dc2deb63abda86adaa8fc9f1d0aae3c7af7bb22a678d25c31897d`

## 仍然存在、但已知且不阻塞的项

- 每个请求一个 `Thread`（沿用旧模式）：并发很高时有创建开销，后续可换固定线程池；
- 未做流式输出：长回答要等完整响应；
- 重试会重建请求体字符串（内存瞬时翻倍），对 8MB 上限以内的 JSON 无实际影响；
- 真机未验：插件 L2 跨域、音乐真实源 302、缓存下载。
