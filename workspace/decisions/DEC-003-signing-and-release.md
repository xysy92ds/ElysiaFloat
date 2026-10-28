# DEC-003：Beta 期发布与签名策略

日期：2026-10-28
状态：已确认（0.8 N3-001 的结论）
关联：`android/app/build.gradle`、`android/tools/check-release.js`、`android/tools/scan-secrets.js`

## 背景

0.7.x 的 debug 与 release 构建共用项目自有 keystore（`CN=ElysiaFloat`，SHA-256 `7851cb49…`），
目的是让本机、沙箱、CI 构建出的 APK 签名一致，用户可以在 0.7.x 之间直接覆盖安装。
计划里的 N3-001 原本写着「debug/release 签名分离」，但这会改变签名，导致已安装用户无法覆盖升级。

## 决定

1. **Beta 期（0.8～0.15）不分离 debug/release 签名**，继续共用项目自有 keystore。
   - 理由：升级一致性优先；目前没有第三方分发渠道，环境隔离收益低。
   - 代价：debug 构建同样具备正式签名，因此 debug 包只能作为测试包流转。
2. **正式对外分发前**再引入独立 release key。届时必须同时提供迁移路径：
   同包名同签名覆盖，或明确告知用户卸载重装并说明数据备份方式。
3. **签名材料只存在私有仓库**：`android/keystore/elysia.jks` 与 `android/keystore.properties`
   不进入公开仓库、公开 Release 或公开文档；工作转移包属于内部产物，可以包含它们。
4. **发布门固定为以下顺序**，任一步失败不得发布：

   ```text
   node tools/build-html.js --check
   node tools/smoke.js
   node tools/behavior.test.js
   node tools/check-release.js
   node tools/scan-secrets.js
   android/build.sh assembleDebug
   sha256sum APK → apk/*-SHA256SUMS 与 release/<版本>/SHA256SUMS
   tag + Release（Beta 标题，prerelease=false 表示 Latest）
   公开仓库匿名下载与校验
   ```

5. **版本号只发 Beta**：不设 1.0 稳定节点；每个 0.x 版本发布后生成工作转移包。

## 后果

- N3-001 以「策略定稿、暂不分离」关闭，不再修改 `build.gradle` 的签名配置。
- `check-release.js` 防止 `latest.json` 回退到私有仓库 URL（公开仓库才是更新源）。
- `scan-secrets.js` 每次发布前跑，`keystore.properties` 是唯一白名单。
