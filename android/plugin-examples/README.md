# 插件示例与开发者工具包（E4-009）

这里的清单都只用宿主原语（surface / 组件树 / 动作 / 事件 / job）组合，**不需要改宿主代码**。

| 文件 | 演示内容 |
| --- | --- |
| `template.json` | 最小骨架：一个页面 + 一个聊天头部入口 + 一份配置 Schema |
| `theme-aurora.json` | 两个主题包、预览页、设置分区；应用/重置主题 |
| `dating-game.json` | 专属会话、每轮换模板、状态保存、结束条件、会话内挂载 |
| `pomodoro.json` | 聊天头部计时器、专注会话、统计页、定时任务 |

## 校验

```bash
node tools/plugin-validate.js plugin-examples
node tools/plugin-validate.js plugin-examples/pomodoro.json
```

校验清单结构、surface 是否被接受、组件/动作类型、主题对比度；退出码非 0 表示有错误。

## 本地加载调试

1. 打开「设置 → 插件与工具 → 自定义插件」；
2. 把清单 JSON 整段粘贴进去安装；
3. 插件页/入口/会话会立刻出现，可随时停用或删除；
4. 删除时会一并清理它的会话、主题、配置和定时任务。

## 可用原语速查

- surface：`page`、`entry`、`sessionType`、`command`、`event`、`job`、`settings`、`renderer`、`adapter`、`theme`
- 挂载点：`plugins`、`chat.header`、`chat.footer`、`chat.composer.before`、`chat.message.after`、`panel.home`、`panel.tabs`、`settings.section`、`session.create`、`task.detail`、`notification`
- 组件：`layout`、`text`、`stat`、`button`、`input`、`select`、`list`、`table`、`image`、`progress`、`chart`、`tabs`、`modal`、`choice`、`form`、`divider`、`spacer`
- 动作：`navigate`、`plugin.call`、`config.set`、`state.set`、`session.create`、`session.delete`、`message.send`、`theme.apply`、`theme.reset`、`confirm`、`openUrl`、`clipboard.write`、`job.schedule`、`dependency.install`、`custom`
- 绑定：`{{state.*}}`、`{{config.*}}`、`{{session.*}}`
- 样式：只接受颜色、背景/渐变、圆角、边距、字号、字重、透明度、阴影和 HTTPS/data 背景图；任意 CSS 与 `url()` 注入会被丢弃。

权限（`permissions`）必须显式声明，危险能力安装后仍需用户逐项授权。
