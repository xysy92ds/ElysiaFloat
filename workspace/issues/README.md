# 未解决问题

当前问题总表统一维护在：

```text
workspace/issues/ISSUE-REGISTER.md
```

本目录中的专题问题文件保留复现、审计和方案细节；总表负责回答：

- 问题是否仍存在；
- 当前证据是什么；
- 优先级和阻塞关系；
- 对应哪个执行阶段；
- 下一步如何验收。

## 当前优先级入口

1. `ISSUE-REGISTER.md`：全部问题的状态和任务映射；
2. `2026-10-16-comprehensive-audit.md`：任务隔离、全屏、音乐、设置、普通体验的代码审计；
3. `2026-10-16-music-refactor.md`：音乐 Provider/Cache 问题和验收项。

问题不能只在总表中写成“已修复”。关闭前必须有对应 `workspace/work-logs/` 证据，包含修改文件、自动测试、构建、真机状态、APK 校验值（如有）和剩余风险。
