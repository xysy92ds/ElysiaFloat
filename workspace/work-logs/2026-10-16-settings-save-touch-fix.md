# 工作记录：设置保存按钮真实点击链路修复

日期：2026-10-16
状态：已修复并完成自动验证和 Debug 构建

## 用户反馈

用户实际使用中仍然无法按下“保存设置”。此前只验证了 DOM 存在和 smoke 中的函数绑定，没有验证 Android WebView 触摸事件链路，因此之前的“已修复”判断不充分。

## 复核结论

按钮本身存在，之前绑定了 `onclick` 和 `addEventListener('touchend')`，但在部分 Android WebView/悬浮窗触摸环境中，单靠事件监听器不够可靠，可能被触摸事件链、父级滚动或 WebView 点击合成行为吞掉。

## 本轮修复

文件：`android/app/src/main/assets/src/scripts/14-update.js`

“保存设置”现在同时使用：

- `onclick`；
- `ontouchend`；
- `onpointerup`；
- `type="button"`；
- `pointerEvents: auto`；
- `touchAction: manipulation`；
- 统一 `saveHandler` 返回 `false`，阻止默认行为和冒泡。

仍然只保留一个保存按钮：

```text
#settings-save-inline
```

没有恢复悬浮保存按钮。

## 验证

```text
node tools/build-html.js --check  通过
node tools/smoke.js               全部通过
./build.sh assembleDebug          成功
git diff --check                  通过
```

最新测试包：

```text
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-settings-save-final-debug.apk
/workspace/gh-ElysiaFloat/apk/phases/ElysiaFloat-g2-settings-save-final-debug-SHA256SUMS
```

SHA-256：

```text
bcba20ca2f8c7596514363b02278e53123531e196c7c7c7594272322eb52278c
```

## 说明

本地 harness 可以验证绑定结构，但不能模拟真实 Android WebView 手指事件。因此这次修复后需要在新 APK 上实际点击一次保存设置；如果仍无反应，下一步会改为完全不依赖按钮事件绑定的“设置页容器事件委托 + data-action 保存”路径，并记录真实设备事件。
