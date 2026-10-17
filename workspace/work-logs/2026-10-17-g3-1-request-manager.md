# 工作记录：G3-1 统一 RequestManager（核心 + 模型请求）

日期：2026-10-17
状态：G3-1 完成；smoke 全绿 + Debug 构建通过；真机待验

## 用户确认的策略

| 项 | 决定 |
|---|---|
| 重试 | 次数不变（2 次），退避时间拉长：2s / 6s，429 退避 10s |
| 模型单次超时 | 200 秒 |
| 响应大小上限 | 文本/JSON 8MB；音频走独立通道；截图单独处理 |
| 重定向 | 允许任意域名跳转，最多 5 跳；放宽能力由 L2 开关控制（G3-2 接入） |
| 错误可见性 | 友好文案 + 小字错误码 |
| 审计 | 只记域名/状态码/耗时/错误码，绝不记 path、query、请求头、正文 |
| 范围 | 分 G3-1~G3-4 慢慢做 |
| 版本号 | 上架前都是本地测试，保持不动 |
| 音乐 G4 | 已确认完成，关闭 |

## 新增文件

`android/app/src/main/assets/src/scripts/00b-request.js`（约 290 行），已加入 `manifest.json`
（排在 `00-compat.js` 之后）。

包含：

- `REQ_CODE` 13 个统一错误码；
- `reqRequest(spec)` 唯一出网入口；
- `reqTransport()` 原生优先（`Android.requestEx` → `Android.request` → `fetch` 兜底）；
- 重试策略：`NETWORK_ERROR` / `TIMEOUT` / `5xx` / `429` 可重试，`401/403/400` 绝不重试；
- 任务预算继承：`deadlineAt` 剩余时间与单次超时取最小值；
- `expect: json | audio | text` —— JSON 解析失败转 `PARSE_ERROR`，音频校验 Content-Type；
- 取消令牌 `reqToken()`；
- 脱敏审计环形缓冲 200 条 + `reqErrText()` 友好文案。

## 原生升级（JsBridge.kt）

新增 `requestEx(id, method, url, headersJson, body, timeout, optsJson)`：

- 手动跟随重定向，`instanceFollowRedirects = false`，跳数上限可配；
- 协议校验（可选禁止明文 http）；
- 按字节上限读取（`readCapped`），超限直接 `TOO_LARGE`，不再把巨型响应塞进 WebView；
- `useCaches` 由 `cacheable` 控制（默认可关，避免短时签名 URL 被缓存）；
- 归一错误码：`AUTH_ERROR` / `RATE_LIMITED` / `HTTP_ERROR` / `REDIRECT_ERROR` / `TOO_LARGE` / `TIMEOUT` / `NETWORK_ERROR`；
- 回调 `__gmCb(id, ok, code, text, err, metaJson)`，meta 带 `errorCode / bytes / finalUrl / contentType`。

旧的 `request()` 保留不动，保证兼容。

## 迁移

- `nativeReq()` 不再自己发请求，改为 `reqRequest()` 的薄适配层，保留旧签名与 `{status,text}` 返回，
  9 个模块一次性获得统一策略，无需同时改动；
- `chatReq()`（09-ai-request）：`timeoutMs: 200000`、`expect: json`、`retries: 2`；
- `chatReqTools()`（11-plugin-engine）：单次预算 200s，有任务 deadline 时取剩余时间，`expect: json`。

核查结果：仓库内已无绕过 RequestManager 的裸 `Android.request(` 调用。

## 验证

```text
node tools/build-html.js --check   index.html 与 18 个模块一致
node tools/smoke.js                全部通过（新增 G3 用例）
./build.sh assembleDebug           构建成功
```

新增 smoke 用例 `G3：RequestManager 错误码、重试、上限与取消`，覆盖：

- 500 重试到 3 次尝试、401 不重试（1 次）、429 标记可重试；
- `TOO_LARGE`、`REDIRECT_ERROR`、`PARSE_ERROR`、`DEADLINE_EXCEEDED`、`TIMEOUT`、`CANCELLED`；
- 正常 JSON 请求解析；
- 审计脱敏（有域名、无 path/query、无凭据）。

harness 同步升级：新增 `requestEx` 假实现 + `__500/__429/__401/__big/__loop/__slow/notjson` 故障注入，
并把假响应体抽成 `fakeHttpBody()` 供两种入口共用。

## 测试抓到的真实缺陷

`reqHost()` 原本写成 `String(new URL(url)).host` —— 先转字符串再取 `.host`，永远得到空串，
导致审计把域名记成空。已改为 `new URL(url).host`。这是新增审计脱敏用例直接抓出来的。

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g3-requestmanager-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g3-requestmanager-debug-SHA256SUMS
```

SHA-256：`b6a18bcac49299fc2bd3d1d6e638a55ea46be4aba65f1b3976de19984146d12e`（`sha256sum -c` 通过）

## 下一步（G3-2）

- 插件 HTTP 迁入 RequestManager（保留插件自带超时声明）；
- 音乐 `musicRequest` 迁入，复用已有 `MUSIC_HEALTH`；
- 302 跳转 + 最终 URL 校验 + 音频 MIME 统一；
- 「任意域名跳转」的放宽开关挂到 Agent L2；
- 短时签名 URL 不入缓存索引在 RequestManager 层强制。
