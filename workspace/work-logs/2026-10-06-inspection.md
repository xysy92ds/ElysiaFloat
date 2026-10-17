# 工作记录：当前项目和 Tdsh 结构检查

日期：2026-10-06
状态：检查完成，本轮未修改 Kotlin、Manifest 或 HTML 功能代码。

## 检查对象

- 当前实验副本：`/workspace/EllyFloat`
- Git 稳定基线：`/workspace/gh-ElysiaFloat`
- 用户提供 APK：`/workspace/uploads/Tdsh-0.3.3_48-872590766.apk`

## 实际观察

### 当前爱莉希雅

- `AgentPolicy.kt` 使用独立的 `elly_agent` SharedPreferences。
- `PermissionBridge.agentLaunch()` 只接受字符串并直接按包名检查和启动。
- `PermissionBridge.listAgentApps()` 枚举已安装应用，但只服务于设置页；当前 AI 工具没有设备应用查询工具。
- 白名单默认集合为空，只有加入后的真实包名才允许操作。
- `PickImageActivity` 只能通过系统文件选择器读取用户主动选择的文件，当前没有工作区、目录枚举、文件写入或 Agent 文件工具。
- Manifest 当前没有 `MANAGE_EXTERNAL_STORAGE`，也没有文件工作区能力。
- 普通 AI 工具循环在 `index.html` 中固定为 `MAX = 5` 轮。
- 普通 Agent 工具调用没有使用已有的翻译胶囊；只有翻译/总结等快捷功能会主动收起。
- `agentOnDemand` 当前只是设置值，没有完整的持续观察实现。

### Tdsh

APK 中确认存在：

- `DshImeService`
- `ImeInjector`
- `DshAccessibilityService`
- `phone_open` 支持应用名或包名
- `phone_text` 支持无障碍失败后的输入法回退
- `phone_ime` 支持输入法状态、激活和恢复
- `phone_watch` 采用限时、限帧、按画面差异保留关键帧的观察思路

Tdsh 还包含 `WRITE_SECURE_SETTINGS`、Shizuku 相关能力；这部分按用户要求暂不搬入爱莉希雅。

## 构建验证

当前实验副本执行：

```text
./build.sh assembleDebug
```

结果：成功。

当前源码替换到现有冒烟测试后，测试结果：

```text
全部通过
```

本轮没有修改功能代码，因此没有新的 APK 功能版本。
