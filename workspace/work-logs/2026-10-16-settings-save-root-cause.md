# 工作记录：设置保存按钮点不动的真正原因（与早期版本对比）

日期：2026-10-16
状态：根因已确认并修复；自动验证 + Debug 构建通过

## 用户反馈

“用手点那个按钮，它没反应，就像点不到一样，也没什么实际效果。”

之前两次修复只改了事件绑定，属于误判。本轮改为与早期可用版本对比。

## 早期版本对比（git 42781ad:android/app/src/main/assets/index.html）

```css
/* 早期，可用 */
.settings-bottom{display:block;margin-top:18px;padding:12px;...}
/* 普通文档流，不吸底 */
```

```html
<button id="set-save" class="btn-p">保存配置</button>
```

```js
$('#set-save').onclick = saveSettings;
```

## 当前版本（出问题）

```css
.settings-bottom{display:flex;...position:sticky;bottom:0;z-index:4;...}
```

而窗口缩放热区是：

```css
.rz{position:absolute;z-index:60;touch-action:none}
.rz-s {bottom:0;height:14px}
.rz-sw{bottom:0;width:22px;height:22px}
.rz-se{bottom:0;width:22px;height:22px}
```

## 根因

保存块被改成 `position:sticky; bottom:0`，正好贴在悬浮窗最底边；
缩放热区 `z-index:60` 高于保存块 `z-index:4`，触摸被 `.rz-s` / `.rz-sw` / `.rz-se` 吃掉。
所以按钮“看着在、点不着、无任何反应”，与 JS 绑定无关。

## 修复

```css
/* 不吸底，回到普通文档流；理由写进注释防止再次回退 */
.settings-bottom{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:18px;padding:12px;...}
```

- 删除遗留的 `.settings-save-float` 样式（只用 `#set-save` 一个按钮）；
- 删除 `15-views.js` 里对悬浮保存按钮的动态清理代码；
- 底部占位从 30px 提升到 56px，让按钮完全离开 14px / 22px 的缩放热区；
- 保存按钮保留 `onclick` + `ontouchend` + `onpointerup` + `touch-action: manipulation`；
- `#settings` 上仍有 `[data-action="save-settings"]` 事件委托作为兜底。

## 新增回归测试

smoke 新增 `设置保存按钮：不能被窗口缩放热区遮挡`：

- `.settings-bottom` 不允许出现 `position:sticky` 或 `bottom:0`；
- `.rz` 仍是 `z-index:60`（层级变化就要重新确认遮挡）；
- 底部占位必须存在且 ≥ 30px；
- 不允许再出现 `settings-save-float`。

同时修正了我自己写错的两处断言（`height:(\d+)` 漏了 `px`、`type` 与 `id` 顺序假设错误）——之前 smoke 报错是断言写错，不是产品代码错。

## 验证

```text
node tools/build-html.js --check  通过
node tools/smoke.js               全部通过（含新增遮挡回归检查）
git diff --check                  通过
./build.sh assembleDebug          成功
```

## 测试包

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-savefix-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-savefix-debug-SHA256SUMS
```

SHA-256：`60a3a9a6de142a92d9beffa1a1d2c8c25739d8b4aae28d4dceb7a23f8abf6ee9`
大小：2,417,384 字节
