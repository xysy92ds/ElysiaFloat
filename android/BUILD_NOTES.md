# EllyFloat 构建说明

## 一键构建

```sh
cd /workspace/gh-ElysiaFloat/android
./build.sh assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

## 为什么需要 build.sh

本机内核启用了 seccomp 过滤，musl 的 `remove()` / `unlink()` 在删除目录时
会错误地返回 `ENOENT` / `EISDIR`，导致 Android Gradle Plugin 内置的 apkzlib
在关闭临时目录时报：

```
java.io.IOException: Failed to delete '/tmp/tempdir_...'
```

`/workspace/libremovefix.so` 是一个极小的 `LD_PRELOAD` 垫片，把「删除目录」
的操作改走 `rmdir()`，`build.sh` 会在启动 Gradle 前自动注入它，所以请始终
使用 `./build.sh` 而不是直接调用 `gradle`。

`libremovefix.so` 的源码等价于：

```c
int remove(const char *p) {
    int r = real_remove(p);
    if (r && (errno == EISDIR || errno == EPERM ||
              errno == EINVAL || errno == ENOENT)) {
        int saved = errno;
        if (rmdir(p) == 0) return 0;
        errno = saved;
    }
    return r;
}
/* unlink 同理 */
```

## 依赖情况

本项目 `app/build.gradle` 的 `dependencies {}` 为空，只使用 Android framework
与原生 WebView，不引入任何 AAR / 第三方库，因此不会因为 Maven 仓库或
第三方 SDK 变更而构建失败。App 运行时的外部服务（AI 接口、翻译、音乐）
都是可配置 / 可降级的功能，不影响启动。
