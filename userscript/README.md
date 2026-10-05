# 浏览器用户脚本 · 爱莉希雅网页助手

> 🧩 **这里是给浏览器用的，不是安卓 App。**

## 文件和版本

| 文件 | 版本 | 说明 |
|---|---|---|
| `elysia-web-assistant-v4.2.user.js` | **v4.2** | **推荐**，功能最完整 |
| `elysia-web-assistant-v0.3.user.js` | v0.3 | 最初版本，保留作纪念 |

## 安装

1. 浏览器安装用户脚本管理器（任选其一）
   - Tampermonkey（油猴）
   - Violentmonkey
   - ScriptCat
2. 打开管理器 → **新建脚本**
3. 把 `.user.js` 的内容**整个复制粘贴**进去
4. `Ctrl/Cmd + S` 保存
5. 刷新任意网页，右下角出现粉色悬浮球即成功

手机上也能用：Kiwi Browser / Firefox 移动版 + Tampermonkey。

## 需要授予的权限

| 指令 | 用途 |
|---|---|
| `GM_setValue` / `GM_getValue` | 保存 API Key、模型、头像等配置 |
| `GM_xmlhttpRequest` | 跨域请求 AI 接口、翻译接口、音乐接口 |

`@connect` 里列出的域名是脚本会主动访问的接口，包括：
- `edge.microsoft.com` — 翻译
- `app.everyapi.ai` — 默认 AI 接口
- `music-api.gdstudio.xyz` 等 — 音乐搜索
- `music.163.com` — 网易云

如果你换了别的 AI 服务商，记得在脚本头部 `@connect` 里补上它的域名，否则会被管理器拦截。

## 和 App 版的关系

网页助手是这个项目的**起点**。后来把它「搬进」了安卓悬浮窗，就成了 `../android/` 里的 App。

两者界面长得像，但完全是两套代码：

- 网页脚本用的是浏览器 API（`document`、`fetch`、GM 存储）
- App 用的是 WebView + 原生桥（`Android.xxx`、`Perm.xxx`、SharedPreferences）

**所以 `.user.js` 不能当 APK 装，反过来 APK 里的 `index.html` 也不能直接当用户脚本用。**
