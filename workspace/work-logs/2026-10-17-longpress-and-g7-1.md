# 工作记录：长按复制粘贴修复（二）+ G7-1 多格式文件解析

日期：2026-10-17
状态：长按问题已加兜底；G7-1 完成；构建与产物核对通过

## 1. 长按选中/粘贴（第二次修复）

### 上次为什么没好

上次只改了 CSS（`user-select`）。用户实测仍是"选中变蓝后 0.1 秒消失"，
说明真正的原因是**覆盖层窗口里的 ActionMode（选区菜单）被立刻 dismiss**，
CSS 只是必要条件，不是充分条件。

### 这次加的两层

**原生层**（`FloatService.setupWebView`）：

```kotlin
wv.isLongClickable = true
wv.isHapticFeedbackEnabled = true
wv.setOnTouchListener { v, e ->
    if (e.actionMasked == MotionEvent.ACTION_DOWN) v.requestFocus()
    false            // 不消费事件，WebView 照常处理
}
```

手指按下时主动把焦点交回 WebView —— 悬浮窗里焦点抖动会让选区菜单秒退，
这是最常见的原因。返回 `false` 保证不影响点击、滚动、输入。

**JS 层兜底**（`01-ui-dialog.js` 新增长按菜单）：

- 长按 550ms（期间移动即取消）弹出系统样式的小条，**只有长按才出现**，没有常驻按钮；
- 在正文上：`复制选中` / `复制这条` + `全选这段`；
- 在输入框/文本域上：`粘贴` / `全选`（有选中时多一个 `复制`）；
- 点击外部或选中内容消失时自动收起；
- 复制走 `copyToClipboard`（原生 `setClipboard` → `navigator.clipboard` → `execCommand` 三级回退）；
  粘贴走 `pasteIntoField`（插入到光标位置）。

上一版加在每条消息下面、输入区右侧的常驻按钮已全部删除。

## 2. G7-1：多格式文件正文提取

新增 `FileExtractor.kt`（零第三方依赖，只用 JDK + Android `XmlPullParser`）：

| 格式 | 做法 |
|---|---|
| txt/md/json/csv/log/html/xml/yaml/代码… | 直接解码；UTF-8 BOM 感知，坏字符多时退回 **GB18030** |
| **docx** | zip 取 `word/document.xml`，抽取 `<w:t>` 文本 |
| **xlsx** | 解析 `sharedStrings.xml` + 各 `sheetN.xml`，按行输出单元格 |
| **pptx** | 按 `slideN.xml` 排序，逐页抽取 `<a:t>` |
| **epub** | 读 `container.xml` → opf → 按 spine 顺序取 xhtml 正文 |
| **zip** | 只列条目清单，不解压内容（避免恶意包） |
| **pdf** | 扫描 `stream…endstream`，`/FlateDecode` 用 `Inflater` 解压，抽 `(…)Tj` / `[…]TJ` 文本 |

安全与边界：
- 条目数 ≤ 3000、解压总量 ≤ 80MB、单条目 ≤ 24MB、输出 ≤ 40 万字符；
- 加密 PDF → `pdf_encrypted`；扫描版（无文字层）→ `pdf_no_text`，都给出可读原因而不是报错；
- 内存不足单独兜底，统一返回 JSON，**不抛异常**。

接线：
- `PickImageActivity.readFile()` 改为调用 `FileExtractor.extract(...)`，不再只处理文本；
- 前端 `__filePicked` 按 `kind` 显示"Word 已解析 N 字 / 表格 / 幻灯片 / 电子书 / PDF / 压缩包"，
  并展示解析说明；
- 附件条显示解析提示；
- 导入工作区时，非纯文本的解析结果**改存 `.txt`**（原名 report.docx 存成 docx 会让后续读取误判）。

## 验证

```text
node tools/build-html.js --check   index.html 与 19 个模块一致
node tools/smoke.js                全部通过
./build.sh assembleDebug           成功，0 error
sha256sum -c                       包校验 OK
```

新增用例 `G7-1：多格式文件正文提取接线`：

- `FileExtractor` 六个格式分支齐全；
- 有 zip bomb 上限常量、编码兜底、加密/扫描版 PDF 的可读原因；
- `PickImageActivity` 确实调用 `FileExtractor.extract`；
- 前端区分 `docx: 'Word'` 并展示 `note`；
- 导入工作区时落 `.txt`。

产物级核对（解包 `classes3.dex` + `assets/index.html`）：
`FileExtractor` 命中 64 次，`GB18030` / `pdf_no_text` / `MAX_TOTAL_INFLATE` 均在；
`ctx-menu` / `bindCtxMenu` / 格式提示 / `baseName + '.txt'` 均在前端产物里。

## 测试包

```text
apk/phases/ElysiaFloat-g7-fileformats-debug.apk
apk/phases/ElysiaFloat-g7-fileformats-debug-SHA256SUMS
```

SHA-256：`dc451d2b78596f4ed02e824c2ff70fffcc5c18b5dd507caa2aaf2d26291ba8df`

## 真机待确认

1. 聊天里长按消息：即使系统选区菜单仍然秒退，550ms 后应弹出「复制这条 / 全选这段」；
2. 设置里长按提示词框或 URL 输入框：应弹出「粘贴 / 全选」；
3. 选一个 .docx / .pdf / .epub 发过来，应提示"已解析 N 字"并能正常回答；
4. 扫描版 PDF 应提示"没有可直接提取的文字"，而不是报错。

## G7 剩余

- G7-2：AI 输出多格式（md/txt/csv/json/html 落 `output/`）；
- G7-3：快速预览（文本/图片直读，其它给摘要 + 元信息）；
- G7-4：文件安全细化（符号链接、原子写入、Kotlin 单测）。
