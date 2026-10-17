# 工作记录：保存设置点不动的真正根因（通用性排查）

日期：2026-10-16
状态：根因已修复；自动验证 + Debug 构建通过

## 用户反馈

上一轮改成“不吸底”后仍然点不动，说明问题不在层级遮挡。同时用户说明：底部操作条本来就是应该在弹窗底部一直可按的，不是普通文档流。

## 通用性排查过程

1. 检查 `#settings` 上是否只有一处绑定 → 只有 `renderSettings()` 里一处事件委托，无被覆盖。
2. 检查 `#settings` 内按钮 id 与绑定 → `#set-save` 绑定存在。
3. 检查 `saveSettings()` 读取的每一个 `$('#set-xxx')` 是否真的渲染出来 → 发现关键问题。

## 真正根因

`saveSettings()` 第 610 行读取：

```js
gdStudioApi: $('#set-gd-api').value.trim() || DC.gdStudioApi,
```

而设置页模板里**从来没有渲染过 `#set-gd-api`**（GD Studio 接口在界面重构中被删掉，但保存函数仍在读它）。

结果：

```text
点击保存 → 进入 saveSettings() → 读到 null.value → TypeError
→ 立刻中断，后面的 sSet('via_ai_config') 和 toast('已保存~') 都没执行
→ 表现就是“点了完全没反应”
```

之前两次修复都没找到它，是因为本地 harness 的 `$()` 对任意选择器都会返回一个假元素，`.value` 为 `undefined` 而不是抛错，所以 `设置渲染 + 保存不炸` 一直是假通过。

## 修复

1. 补回缺失的控件：音乐分区新增 `GD Studio 接口` 输入框 `#set-gd-api`，可以正常填写保存。
2. `saveSettings()` 拆成外壳 + `doSaveSettings(val)`：

   ```js
   function saveSettings() {
     const val = (sel, d) => { const el = $(sel); return el && el.value != null ? String(el.value) : (d === undefined ? '' : d); };
     try { return doSaveSettings(val); }
     catch (e) { console.error('[saveSettings]', e); toast('保存失败：' + (e && e.message || e)); return false; }
   }
   ```

   - 27 处 `$('#set-xxx').value` 全部改为 null 安全的 `val('#set-xxx')`；
   - 缺控件只退化默认值，不再整次保存崩掉；
   - 万一还有异常，会 toast 出具体原因，不再静默。
3. 底部操作条恢复为“始终可按”：

   ```css
   .settings-bottom{position:sticky;bottom:44px;z-index:5;...}
   ```

   `bottom:44px` 让它停在窗口底部上方 44px：滚动到哪里都能点到，同时避开 14px / 22px 的 `.rz` 缩放热区。

## 新增通用回归（会真的抓到这个 bug）

新增两个 smoke 用例：

1. `设置保存按钮：始终可点且不被窗口缩放热区遮挡`
   - 必须是 sticky；
   - `bottom` 偏移必须 > 22px（否则落进缩放热区）；
   - 底部占位 ≥ sticky 偏移；不允许残留悬浮保存按钮。
2. `设置保存：保存函数读取的每个控件都真的存在`
   - 从 `renderSettings()` 模板里收集所有 `id="..."`，并补上 `swatchGroup('c1'|'c2')` 生成的 `#set-c1`/`#set-c2`；
   - 与 `doSaveSettings()` 里引用的所有 `#set-xxx` 做差集，任何不存在的控件直接报错。

反向验证（证明测试有效）：临时把 `#set-gd-api` 改名后运行 smoke →

```text
[1] 设置保存：保存函数读取的每个控件都真的存在:
    保存时会读到不存在的控件：set-gd-api
```

恢复后：`✓ 全部通过`。

## 验证

```text
node tools/build-html.js --check  index.html 与模块一致
node tools/smoke.js               全部通过
git diff --check                  通过
./build.sh assembleDebug          成功
```

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-savefix2-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-savefix2-debug-SHA256SUMS
```

SHA-256：`c629901a49ac4d0b9c59cc1d64834df133ff99706fba462d85e50f3b2222fec2`
