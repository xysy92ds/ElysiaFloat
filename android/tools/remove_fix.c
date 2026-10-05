/*
 * libremovefix.so —— EllyFloat 构建用的 LD_PRELOAD 垫片
 *
 * 背景：本机内核启用了 seccomp 过滤，musl 的 unlink()/remove() 在“删除目录”时
 * 会错误地返回 ENOENT / EISDIR / EPERM，而不是正常的 EISDIR。
 *
 * 后果：JDK 的 UnixFileSystem.delete() 逻辑是
 *          unlink(path); if (errno == EISDIR) rmdir(path);
 *        errno 被污染成 ENOENT 之后，它就不会去试 rmdir，于是 Android Gradle
 *       Plugin 内置的 apkzlib 在关闭临时目录时报：
 *          java.io.IOException: Failed to delete '/tmp/tempdir_...'
 *
 * 修法：在 unlink()/remove() 失败时，把 errno 属于 {ENOENT, EISDIR, EPERM, EINVAL}
 * 的情况改走 rmdir()，让「删空目录」这一步能成功。
 *
 * 编译（Alpine / musl）：
 *     gcc -shared -fPIC -O2 -o /workspace/libremovefix.so remove_fix.c -ldl
 *
 * 用法：build.sh 里 export LD_PRELOAD=/workspace/libremovefix.so
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

static int (*real_remove)(const char *) = NULL;
static int (*real_unlink)(const char *) = NULL;
static int (*real_rmdir)(const char *) = NULL;

__attribute__((constructor))
static void init_fix(void) {
    real_remove = (int (*)(const char *)) dlsym(RTLD_NEXT, "remove");
    real_unlink = (int (*)(const char *)) dlsym(RTLD_NEXT, "unlink");
    real_rmdir  = (int (*)(const char *)) dlsym(RTLD_NEXT, "rmdir");
}

/* rmdir 不接受 "dir/" 这种带尾斜杠的形式，先去掉 */
static const char *trim_slash(const char *p, char *buf, size_t n) {
    size_t len = strlen(p);
    if (len <= 1 || len >= n) return p;   /* "" 或 "/" 原样返回 */
    if (p[len - 1] != '/') return p;
    memcpy(buf, p, len);
    buf[len - 1] = '\0';
    return buf;
}

static int try_rmdir(const char *path) {
    char buf[4096];
    const char *q = trim_slash(path, buf, sizeof(buf));
    if (real_rmdir) return real_rmdir(q);
    return rmdir(q);
}

/* 这些 errno 说明“目标其实是目录”，值得改用 rmdir 再试一次 */
static int looks_like_dir(int e) {
    return e == EISDIR || e == ENOENT || e == EPERM || e == EINVAL;
}

int remove(const char *path) {
    if (!real_remove) init_fix();
    if (!real_remove) { errno = ENOENT; return -1; }

    if (real_remove(path) == 0) return 0;
    int saved = errno;
    if (looks_like_dir(saved) && try_rmdir(path) == 0) return 0;
    errno = saved;
    return -1;
}

int unlink(const char *path) {
    if (!real_unlink) init_fix();
    if (!real_unlink) { errno = ENOENT; return -1; }

    if (real_unlink(path) == 0) return 0;
    int saved = errno;
    if (looks_like_dir(saved) && try_rmdir(path) == 0) return 0;
    errno = saved;
    return -1;
}

int unlinkat(int dirfd, const char *path, int flags) {
    static int (*real_unlinkat)(int, const char *, int) = NULL;
    if (!real_unlinkat) real_unlinkat = (int (*)(int, const char *, int)) dlsym(RTLD_NEXT, "unlinkat");
    if (!real_unlinkat) { errno = ENOENT; return -1; }

    if (real_unlinkat(dirfd, path, flags) == 0) return 0;
    int saved = errno;
    /* 只处理不带 AT_REMOVEDIR 的“看似是目录”的情况 */
    if (!(flags & AT_REMOVEDIR) && looks_like_dir(saved) &&
        real_unlinkat(dirfd, path, flags | AT_REMOVEDIR) == 0) return 0;
    errno = saved;
    return -1;
}
