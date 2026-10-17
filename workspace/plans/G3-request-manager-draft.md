# G3 统一 RequestManager —— 规划草案（待讨论确认）

日期：2026-10-16
状态：草案，等待与用户讨论后定稿再执行
前置：G2 已完成（自动验证 + 构建通过）

## 1. 为什么要做

当前网络请求分散在 9 个前端模块、23 处调用点，规则互相矛盾：

| 模块 | 超时 | 重试 | 错误处理 | 大小限制 | 任务绑定 |
|---|---|---|---|---|---|
| `chatReq`（09-ai-request） | 60s 固定 | 无 | 抛原始 message | 无 | 靠外层 |
| `chatReqTools`（11-plugin-engine） | 任务 deadline 推算 | 无 | 同上 | 无 | 有 |
| `musicRequest`（10-music） | 12s | 无 | MUSIC_HEALTH 记健康 | 无 | 隐式 |
| 插件 HTTP（11-plugin-engine） | 插件声明 | 无 | 抛错 | 无 | 有 |
| 更新检查（14-update） | 默认 20s | 无 | 静默 | 无 | 无 |
| 翻译（08-translate） | 默认 20s | 无 | 抛错 | 无 | 无 |
| 记忆（05-memory） | 默认 20s | 无 | 抛错 | 无 | 无 |
| TTS（07-media-tts） | 默认 20s | 无 | 抛错 | 无 | 无 |
| 兼容层 `nativeReq`（00-compat） | 传入+800ms | 无 | 字符串错误 | 无 | 有 |

原生 `JsBridge.request` 的问题：

- `HttpURLConnection` 默认跟随重定向，但**不区分 GET/POST 语义**，无法限制次数和目标协议；
- 无响应体大小上限，整段读进内存再塞给 WebView；
- 无 MIME 校验；
- 无重试/退避；
- 错误只有字符串，没有可判定的错误码；
- `useCaches = true`，对短时签名 URL 不友好。

## 2. 目标（出口标准）

一个 `RequestManager`，所有出网请求都经过它：

```
RequestManager.request(spec)
  ├ id            唯一请求 ID
  ├ taskId        绑定任务（取消/统计）
  ├ url / method / headers / body
  ├ timeoutMs     单次预算
  ├ deadlineAt    任务级预算（可继承任务 deadline）
  ├ retry         可重试错误 + 次数 + 退避
  ├ redirect      最大跳数 + 协议/域限制
  ├ maxBytes      响应上限
  ├ expect        期望类型（json / text / audio / image）
  ├ cancelToken
  └ → Promise<{ ok, status, code, headers, text/json/bytes, source, elapsedMs }>
      或 throw RequestError{ code, status, retriable, source, elapsedMs }
```

统一错误码：

```
NETWORK_ERROR        连接失败/DNS/TLS
TIMEOUT              单次超时
DEADLINE_EXCEEDED    任务预算耗尽
HTTP_ERROR           4xx/5xx（带 status）
AUTH_ERROR           401/403
RATE_LIMITED         429
REDIRECT_ERROR       跳数超限 / 协议不允许 / 跨域拒绝
TOO_LARGE            超过 maxBytes
BAD_CONTENT_TYPE     MIME 不符合 expect
PARSE_ERROR           JSON 解析失败
NO_MEDIA / NO_TEXT   音乐/正文缺失
CANCELLED            用户停止 / 任务取消
INVALID_ARGUMENT     参数本身非法
```

## 3. 分期（避免一次改 23 处把系统改崩）

### G3-1 核心 + 模型请求（必须先做）

- 新增 `src/scripts/17-request.js`（或并入 00-compat 之前，按构建顺序定）；
- 实现 `RequestManager`、`RequestError`、错误码映射；
- 原生 `JsBridge.request` 升级：跳数上限、协议限制、大小上限、错误码、可选 `useCaches=false`；
- `chatReq` / `chatReqTools` 迁移到 RequestManager；
- 保留旧 `nativeReq` 作为兼容层转发（不改 9 个模块也能先跑通）。

出口：对话、工具调用、停止、超时、429、401 全部行为不变且错误码正确。

### G3-2 插件 + 音乐

- 插件 HTTP 迁入（保留插件自己的超时声明）；
- `musicRequest` 迁入，复用/扩展已有的 `MUSIC_HEALTH`；
- 音乐 302 跟随策略 + 最终 URL 校验 + 音频 MIME/文件头检查统一到一处；
- 短时签名 URL 不写入缓存索引的规则在 RequestManager 层强制。

### G3-3 其余模块

- 更新检查、翻译、记忆、TTS 全部迁入；
- 删除各处重复的 header/超时/错误拼接；
- `nativeReq` 改为薄封装或移除。

### G3-4 清理与回归

- 全仓搜索确认没有绕过 RequestManager 的裸请求；
- smoke 增加：错误码映射、重试次数、跳数上限、大小上限、取消、任务预算继承。

## 4. 需要用户决定的问题

1. **重试默认策略**：哪些错误自动重试、几次、退避多久？
2. **模型单次超时**：60s 是否偏短（推理模型）？是否引入流式输出？
3. **响应大小上限**：默认多少？截图 base64 是否走同一通道？
4. **重定向**：最大跳数？是否禁止 http 明文、禁止跨注册域？
5. **错误可见性**：聊天里显示错误码还是只显示友好文案？
6. **审计日志**：记什么、留多久、能否关闭？
7. **范围**：一次做完 G3-1~G3-4，还是先做 G3-1 验证后再继续？

## 5. 不建议现在做的

- 不引入第三方库（项目坚持零依赖 + 原生 HttpURLConnection）；
- 不做证书固定（会破坏用户自建反代）；
- 不在 G3 顺带改音乐业务逻辑（G4 处理真机适配）。
