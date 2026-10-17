# 工作记录：音乐 Provider/Cache 第一轮重构与 Agent 状态文案调整

日期：2026-10-16
状态：第一轮代码重构、测试和 Debug 构建完成；真机验证待进行；未提交 Git。

## 调研

公开检索到多个 CRMusic 项目，名称并不唯一。参考了 LGCR837/crmusic 的轻量响应式播放器/歌词状态设计，以及 criveros93/CRMusic 的搜索—异步下载—任务状态—文件输出思路；没有复制第三方代码或把其服务作为默认依赖。

## 音乐改动

- 增加 `musicRequest()` 统一请求和来源健康记录；
- GD Studio 支持可配置音乐目录，默认 `netease,tencent,kugou,kuwo`；
- Meting 也按目录和实例并行尝试；
- 搜索不再只取第一个成功来源，改为合并、去重、最多 60 条；
- 歌曲记录 provider、catalog、endpoint，解析播放地址时优先使用原来源；
- 播放地址失败不再无条件回退网易外链；
- 缓存下载手动跟随最多 6 次 HTTP/HTTPS 重定向；
- 校验最终 HTTP 状态、Content-Type 和音频文件头；
- `.part` 文件只有在完整校验后才改名为缓存文件；
- 缓存优先写入用户可见目录 `Music/ElysiaFloat/cache`，无权限时回退 App 私有目录；
- 音乐页增加缓存数量、大小和路径状态；
- 设置页增加音乐目录配置；
- 音乐缓存清理和已缓存状态保留。

## Agent 状态显示

删除 AI 工作状态中的：

```text
（上限 50）
```

保留内部轮数限制，但界面只显示当前轮数，避免把内部实现限制暴露为别扭的状态文案。

## 验证

```text
cd android && node tools/build-html.js
cd android && node tools/smoke.js
cd android && ./build.sh assembleDebug
```

结果：HTML 构建成功、冒烟测试全部通过、Android Debug 构建成功。

阶段 APK：

```text
apk/phases/ElysiaFloat-music-refactor-foundation-debug.apk
```

SHA-256：

```text
27261ab3e295d178a42beff8689e071d09a6d6a41c8c40fd2061cdf297643e06
```

## 未完成

- 真机验证 302/跨域/签名地址/音频文件头；
- 真实公共缓存目录和离线播放；
- 下载进度、单曲删除和缓存索引；
- MusicProvider 独立 Kotlin/JS 模块化；
- RequestManager 统一重试、取消和错误码；
- 更稳定或自建音乐后端需要后续确定来源、部署和版权边界。
