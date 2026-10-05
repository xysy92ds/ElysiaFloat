# tools/ — 构建辅助

## remove_fix.c / build-removefix.sh

**这不是 App 的代码，只是让编译能在「seccomp 受限环境」跑通的垫片。**

在这类环境（如 Termux / Alpine 里跑 Android 构建）中，内核的 seccomp 过滤会让
`unlink()` 删除目录时返回 `ENOENT` 而不是正确的 `EISDIR`，导致 JDK 的
`File.delete()` 跳过 `rmdir()` 兜底，最终 AGP 的 apkzlib 报：

```
java.io.IOException: Failed to delete '/tmp/tempdir_...'
```

垫片通过 `LD_PRELOAD` 劫持 `unlink` / `remove` / `unlinkat`，在「看着像目录」的
错误码下改走 `rmdir()`。

### 用法

```sh
# 1. 编译出垫片（产物固定放 /workspace/libremovefix.so）
./build-removefix.sh

# 2. 用 build.sh 构建，它会自动 LD_PRELOAD
cd .. && ./build.sh assembleDebug --offline
```

**在普通的 Windows / Linux / macOS 上编译不需要这个文件，加不加都不影响。**
它不会被打进 APK，也不影响 App 在手机上的运行。
