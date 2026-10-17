# Minecraft 联机助手

让 AI 和你在同一个 Minecraft 世界里联机。AI 通过 Mineflayer bot 控制角色，你通过悬浮窗给 AI 发指令。

## 架构

```
你的手机
├── Minecraft PE（你玩）─── 连接到本地服务器
├── ElysiaFloat 悬浮窗（你给 AI 发指令）
└── Termux
    ├── Minecraft Bedrock Server（19132）
    └── Mineflayer Bot（AI 控制）
        ├── cmd.json    ← AI 写指令
        ├── status.json ← bot 写状态（位置、血量、背包、附近玩家）
        └── chat.log    ← bot 记录聊天
```

## 前置条件

1. 安装 [Termux](https://f-droid.org/packages/com.termux/)
2. 在 ElysiaFloat 中开启「高级运行时」权限
3. 手机至少 6GB RAM

## 使用步骤

1. **环境搭建**：`minecraft_setup` — 装 Java 17 + Node.js
2. **装依赖**：`minecraft_install_deps` — 装 mineflayer 等 npm 包
3. **部署 bot**：`minecraft_deploy_bot` — 写 bot.js + bot.env
4. **下服务器**：`minecraft_download_server` — 下载 Bedrock Server
5. **开服务器**：`minecraft_start_server` — 记下 runId
6. **开 bot**：`minecraft_start_bot` — 记下 runId
7. **打开 MC PE**：连接 `127.0.0.1:19132`
8. **开始联机**：用 `minecraft_bot_command` 指挥 AI，用 `minecraft_bot_status` 看状态

## Bot 支持的动作

| action | 说明 | 参数 |
|---|---|---|
| `say` | 发聊天消息 | text |
| `move` | 移动 N tick | direction, ticks |
| `look` | 转头 | yaw, pitch |
| `lookAt` | 看向坐标 | x, y, z |
| `dig` | 挖眼前方块 | - |
| `digAt` | 挖指定坐标 | x, y, z |
| `place` | 放置方块 | - |
| `attack` | 攻击最近实体 | - |
| `attackNearest` | 攻击指定类型 | filter |
| `activate` | 使用手中物品 | - |
| `equip` | 装备物品 | item |
| `toss` | 丢物品 | item, count |
| `pathfind` | 寻路到坐标 | x, y, z |
| `pathfindToPlayer` | 跟随玩家 | player |
| `stop` | 停止所有动作 | - |
| `jump` | 跳跃 | - |

## 工具列表

| 工具 | 说明 |
|---|---|
| `minecraft_setup` | 安装 Java + Node.js |
| `minecraft_install_deps` | 安装 mineflayer 依赖 |
| `minecraft_deploy_bot` | 部署 bot.js + 配置 |
| `minecraft_download_server` | 下载 MC 服务器 |
| `minecraft_start_server` | 启动服务器 |
| `minecraft_server_status` | 查服务器状态/日志 |
| `minecraft_stop_server` | 停服务器 |
| `minecraft_start_bot` | 启动 bot |
| `minecraft_bot_command` | 给 bot 发指令 |
| `minecraft_bot_status` | 读 bot 状态 |
| `minecraft_bot_chat` | 读最近聊天 |
| `minecraft_bot_stop` | 停 bot |

## 注意

- 服务器和 bot 都在 Termux 后台运行，关闭 ElysiaFloat 不影响
- 用 `minecraft_stop_server` 和 `minecraft_bot_stop` 停止
- bot 断线会自动重连（5 秒后）
- 状态文件每 500ms 更新一次

## 版本

- 0.2.0：完整 bot 控制层（JSON 指令 + 状态回传 + 寻路 + 16 种动作）
- 0.1.0：初版骨架
