# 文件工作区

工作区是 Agent 的受控写入范围，同时也是一个可浏览、可预览、可导出的任务目录。

## 1. 位置与结构

```text
Documents/ElysiaFloat/workspace/
├── input/       # 用户放入的原始材料
├── working/     # 中间处理结果
├── output/      # 最终交付物
├── logs/        # 任务运行日志
└── snapshots/   # 覆盖写入前的自动快照
```

- 工作区需要「允许管理所有文件」权限后才能创建；
- 设置页会显示工作区状态、项目数量与当前路径；
- 工作区内的相对路径不允许跳出根目录，路径会做规范化校验。

## 2. 内置工具

| 工具 | 作用 | 确认 |
|---|---|---|
| `workspace_status` | 查看权限与工作区状态 | 否 |
| `workspace_create` | 创建工作区 | 确认一次 |
| `workspace_list` | 列出目录 | 否 |
| `workspace_read` | 读取文本文件 | 否 |
| `workspace_write` | 创建或写入文本文件，覆盖前自动留快照 | 授权期内免逐次确认 |
| `workspace_mkdir` | 创建目录 | 授权期内免逐次确认 |
| `workspace_preview` | 预览文件 | 否 |
| `workspace_export` | 导出结果到 `output/` | 否 |

## 3. 写入与快照

- 覆盖已有文件前会在 `snapshots/` 生成快照；
- 快照按任务与时间命名，可在工作区面板中查看并回滚；
- 工作区内的写入在任务授权有效期内不需要逐次确认，但仍受路径校验与 Agent 等级限制。

## 4. 导出格式

`workspace_export` 支持：

- `md` / `markdown`
- `txt` / `text`
- `csv`
- `json`（导出前校验 JSON 格式）
- `html`（片段会自动补基础文档外壳）

不指定路径时按任务与时间自动命名，统一写入 `output/`。

## 5. 预览

工作区面板支持按类型预览：

- 图片：直接显示；
- `md` / `csv` / `json` / `html`：按对应视图渲染；
- 文本与常见代码/配置后缀：纯文本显示；
- 其它类型：显示文件信息。

## 6. 工作区外的公共存储

工作区外可以读取、写入、复制、创建目录和删除公共存储文件，但规则更严格：

| 操作 | 工具 | 确认 |
|---|---|---|
| 列目录 / 读文件 | `external_file_list`、`external_file_read` | 否 |
| 写入 / 复制 / 建目录 | `external_file_write`、`external_file_copy`、`external_file_mkdir` | 授权有效期内合并确认一次 |
| 删除 | `external_file_delete` | 每次确认 |

所有公共存储路径都会做规范化校验，拒绝目录穿越与公共存储根目录之外的路径。

## 7. 建议

- 把需要 Agent 处理的材料放进 `input/`，交付物统一放 `output/`，便于回溯；
- 不要把密钥、身份凭据或隐私文件放进工作区；
- 工作区位于公共存储，卸载应用不会被删除，需要时请手动清理。
