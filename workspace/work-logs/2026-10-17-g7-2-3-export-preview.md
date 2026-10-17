# 工作记录：G7-2 导出多格式 + G7-3 快速预览

日期：2026-10-17
状态：G7-2、G7-3 完成；smoke 全绿；构建与产物核对通过

## G7-2：AI 导出多格式到 output/

新增工具 `workspace_export`（工作区任务内可用，不需要用户确认）：

```json
{ "format": "md|txt|csv|json|html", "content": "...", "path": "可选", "title": "可选", "overwrite": false }
```

规则（都在执行端强制，不只写在提示词里）：

| 约束 | 实现 |
|---|---|
| 只能写 `output/` | 路径不以 `output/` 开头时自动补前缀；`..`、`:`、绝对路径 → `INVALID_PATH` |
| 扩展名与格式一致 | 无后缀自动补；后缀不符则改写（`report.doc` + html → `report.html`） |
| 格式可省略 | 从 `path` 后缀推断；都没有 → `BAD_FORMAT` |
| JSON 先校验 | `JSON.parse` 失败 → `BAD_JSON`，**不落盘** |
| HTML 自动补壳 | 内容不含 `<html` 时补 doctype/meta/viewport/基础样式，`note` 里说明 |
| 大小上限 | 内容 > 480KB → `TOO_LARGE`（原生单文件上限 500KB） |
| 默认文件名 | 用 `title` 生成安全 slug，否则 `export-<时间戳>` |
| 可回溯 | 写入前留快照；成功后记 `workspace_export` 事件、追加 `task.artifacts` |

## G7-3：快速预览

### 给模型的 `workspace_preview`

```json
{ "path": "output/周报.md", "max_chars": 1500 }
→ { ok, path, kind, bytes, chars, lines, preview, truncated,
    rows/columns（csv）, jsonType/keys（json）, note }
```

- 只返回开头一段（默认 1500，最大 8000），避免把整份文件塞进上下文；
- CSV 额外给行数列数，JSON 额外给类型与顶层 key；
- 读不出来（二进制等）→ `READ_FAILED`，模型据此改用别的办法。

### 给用户的预览

- 导出成功后，聊天里插入一张**小卡片**（`导出 output/周报.md [预览]`），不占正文；
- 点「预览」打开弹层：标题 + 元信息（路径 · 类型 · 行数 · 字数 · 是否截断）+ 可滚动的等宽正文；
- 图片类走原生新增的 `Perm.workspaceFileUrl()`（canonical 路径校验后返回 `file://`）直接显示；
- 正文可选中（承接上一轮的 `user-select` 修复）。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增用例 `G7-2/3：导出多格式与快速预览`（8 项）：

1. md 导出落到 `output/` 且扩展名正确；
2. 非法 JSON → `BAD_JSON` 且**没有发生写入**；
3. html 片段自动补外壳（写入长度 > 100）；
4. `../../a.md` → `INVALID_PATH`；
5. 无格式无后缀 → `BAD_FORMAT`；
6. csv 预览行列数正确、超长时 `truncated` 且长度精确等于上限、JSON 给类型与 key；
7. 导出后聊天里出现 `.export-card`；
8. 打开预览弹层后正文可见。

产物核对：`assets/index.html` 含 `workspace_export / workspace_preview / preview-modal / export-card / openPreview / BAD_JSON / INVALID_PATH`；
`classes3.dex` 含 `workspaceFileUrl`（图片预览用）。

## 测试包

```text
apk/phases/ElysiaFloat-g7-export-preview-debug.apk
apk/phases/ElysiaFloat-g7-export-preview-debug-SHA256SUMS
```

SHA-256：`c08dfb667ca7098a2c5ff44a2c72b7f222da89a10a5456f526c3ae017d875e12`

## 真机待确认

1. 让 AI「整理成一份 markdown 报告」→ 应在 `output/` 下生成文件，聊天里出现预览卡片；
2. 点卡片能打开预览，长文本可滚动、可选中；
3. 让 AI 导出 csv / json，预览里行数、结构摘要是否正确；
4. 故意让它导出非法 JSON，应提示格式错误而不是写坏文件。

## G7 剩余（下一段）

- **G7-4**：文件安全细化 —— 符号链接拒绝、原子写入（先写临时文件再 rename）、Kotlin 单测、递归删除边界。
