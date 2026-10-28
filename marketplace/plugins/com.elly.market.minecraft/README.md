# Minecraft 联机助手（Java 版）

让 AI 和你在同一个 Java 版 Minecraft 世界里联机。bot 是 Termux 里的一个常驻 Node 进程（Mineflayer），App 只负责配置、启停、状态和日志；AI 通过三个受控工具给它下指令。

## 架构

```
同一台手机
├── Minecraft Java 版（PojavLauncher 等，你玩）
│   └── 单人游戏 → 对局域网开放 → 聊天栏给出「Local game hosted on port xxxxx」
├── ElysiaFloat（配置 / 启停 / 状态 / 日志）
│   └── 插件工具 minecraft_bot → http://127.0.0.1:39271/cmd
└── Termux
    └── node bot.js（本插件常驻进程）
        ├── 连 127.0.0.1:端口（离线登录）
        ├── 写 status.json / chat.log / audit.log
        └── 只在本机监听控制接口
```

宿主启动前会把插件配置写成工作目录里的 `runtime-config.json`，bot 从里面读取服务器地址、用户名、版本和行为边界。

## 前置条件

1. Termux（已装 `termux-am` 并开启 `allow-external-apps`）
2. 在插件运行面板点「一键准备环境」，装好 `nodejs` 与 4 个 npm 包；也可以在 Termux 里手动执行面板给出的命令
3. 手机内存建议 8GB 起，联调时降低渲染距离、关闭光影

## 使用步骤

1. 插件设置 → 「连接与行为」：服务器地址填 `127.0.0.1`（或把「Local game hosted on port xxxxx」整段粘进去）、端口、离线用户名
2. 插件设置 → 「运行面板」→ 启动，首次会弹一次 Termux 派发确认
3. 进入世界后，运行面板会显示坐标、血量、饥饿和同服玩家
4. 直接对 AI 说「让 bot 跟着我」「挖掉脚下三格」，它调用 `minecraft_bot`；想知道局势就调 `minecraft_bot_status`

## 行为边界

- **完整模式**：移动、挖掘、放置、攻击敌对生物、逃避、寻路、跟随、装备、丢弃、聊天
- **安全模式**：只允许移动、跳跃、看向、寻路、跟随、逃避、聊天和查看；挖掘/放置/攻击/丢弃一律拒绝
- 寻路不会挖方块、不会自动垫柱子，避免破坏你的建筑
- 目标坐标超过 128 格直接拒绝；`attackNearest` 只打敌对生物，永远不攻击玩家
- 只支持 Java 版离线登录；不绕过反作弊、不自动交易、不群发

## AI 工具

| 工具 | 说明 |
|---|---|
| `minecraft_bot` | 单个动作：`action` + 参数（`say/move/jump/look/lookAt/dig/digAt/place/placeAt/attack/attackNearest/flee/pathfind/follow/equip/toss/stop/status`） |
| `minecraft_bot_status` | 状态快照：连接、坐标、血量、饥饿、背包、同服玩家、上次结果 |
| `minecraft_chat_read` | 读游戏内聊天（只读）：`since` 毫秒时间戳 + `limit`，用返回的 `lastTs` 作为下次 `since` |

三个工具都只访问 `127.0.0.1:39271`，需要插件获得 `network.local` 授权，并且宿主的安全开关打开；bot 未启动时返回明确错误。

## 动作参数

| action | 参数 | 说明 |
|---|---|---|
| `say` | text | 聊天，最长 240 字 |
| `move` | direction, ticks | 方向：forward/back/left/right/jump/sprint/sneak；1–200 tick |
| `jump` | - | 跳一下 |
| `look` | yaw, pitch | 弧度 |
| `lookAt` | x, y, z | 看向坐标 |
| `dig` | - | 挖视线 4 格内的方块 |
| `digAt` | x, y, z | 挖指定方块 |
| `place` | item | 在视线方块上方放置 |
| `placeAt` | x, y, z, item | 在指定空气格放置，自动找依附面 |
| `attack` | - | 打 4 格内的生物 |
| `attackNearest` | filter=mob | 打 16 格内最近的敌对生物 |
| `flee` | - | 远离 16 格内的敌对生物 3 秒 |
| `pathfind` | x, y, z, timeoutMs | 寻路到坐标，默认 25 秒超时 |
| `follow` | player, distance | 持续跟随到 `stop`，默认距离 2 |
| `equip` | item, hand | 拿在手上 |
| `toss` | item, count | 丢弃 |
| `stop` | - | 停寻路、清移动、停止挖掘 |
| `status` | - | 返回快照 |

## 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `nodejs` | termux-pkg | 运行桥接进程 |
| `mineflayer` | npm | Java 版协议客户端 |
| `mineflayer-pathfinder` | npm | 寻路、跟随、躲避 |
| `minecraft-data` | npm | 方块与实体数据 |
| `vec3` | npm | 坐标向量 |

npm 包装在 Termux 的全局目录；bot 启动时会把 `$PREFIX/lib/node_modules` 加进 `NODE_PATH`，不需要你在工作目录里再 `npm install`。

## 文件与限频

- `status.json`：2 秒一次的状态快照（`connected`、`position`、`health`、`food`、`players`、`lastResult`）
- `chat.log`：聊天尾部，超过 64KB 自动截半
- `audit.log`：每个动作一行 JSON（时间、动作、成功/失败、耗时、关键参数），超过 256KB 自动截半
- 控制接口 `GET /status`、`GET /chat`、`POST /cmd` 按顺序执行指令，队列最多 8 条；日志由宿主按 `runtime.logMaxBytes` 再轮转
- 动作限频每分钟 30 个（`status` 不计），超了直接返回拒绝原因，避免把服务器刷到踢人
- 断线在进程内自动重连，退避 3→6→12→24→48→60 秒；异常退出宿主只报告不静默拉起

## 版本

- 0.3.1：新增动作审计 `audit.log`、每分钟 30 个动作的限频，以及只读的聊天桥 `minecraft_chat_read` / `GET /chat`
- 0.3.0：重写为 Manifest v2 + 长驻运行时；配置页、一键环境、本机控制接口、17 个动作与状态快照
- 0.2.0：旧的基岩版工具集（已废弃）
