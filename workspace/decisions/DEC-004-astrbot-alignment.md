# DEC-004：插件平台与 AstrBot 的对齐边界

日期：2026-10-28
状态：已确认（0.8 N5，只定稿原则，不写实现）
关联：`plans/PLATFORM-0.8-0.15.md` 第 5 节 E3

## 采用 AstrBot 的部分

| 能力 | 本项目的落地方式 |
|---|---|
| 插件清单 | Manifest v2（兼容 v1），声明 surfaces / permissions / dependencies / models |
| 插件专属配置页 | 由配置 Schema 自动生成表单（string/number/boolean/enum/secret/path/model-ref/json） |
| 生命周期 | install / enable / disable / uninstall / on_load / on_unload / on_event / on_job |
| 事件系统 | 统一事件总线，插件按 surface 订阅，不直接改宿主内部状态 |
| 私有存储 | 按插件命名空间隔离，带 Schema 版本与迁移 |
| 启用/停用隔离 | 单插件异常、卡死只影响自身，可单独停用并回滚 |
| 依赖声明 | 声明式依赖 + 检测/校验/安装/回滚（0.12） |

## 不采用的部分

1. **任意 Python / 任意 shell 执行**：插件只能调用宿主暴露的受控工具（`host.*`），
   拿不到 Android 桥、任意命令行、系统目录写权限。
2. **插件直接读写宿主密钥**：插件只能用独立配置、用户授权的配置档引用、
   或主 AI 调度的子模型，永远拿不到明文 Key（DEC 详见 0.9 的 E2-006）。
3. **插件类型白名单**：不预设「主题插件 / 会话插件 / 面板插件」这类固定类型；
   插件通过 surface 注册表创建宿主没写过的东西（见 DEC-005）。

## 结论

对齐的是**工程形态**（清单、配置页、生命周期、事件、私有存储、依赖），
不对齐的是**执行模型**（不开放原生代码执行）。
官方插件（MC、QQ）只是第一批验证样例，不是能力上限。
