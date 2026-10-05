#!/bin/sh
# EllyFloat 构建脚本
#
# 说明：本机内核启用了 seccomp 过滤，musl 的 remove() 在删除目录时会返回
# ENOENT，导致 AGP 的 apkzlib 在关闭临时目录时报 “Failed to delete ...”。
# libremovefix.so 是一个 LD_PRELOAD 垫片，把删除目录的操作改走 rmdir()。
# 因此必须在启动 Gradle 时带上 LD_PRELOAD。
set -e
cd "$(dirname "$0")"
export GRADLE_USER_HOME=/workspace/gradle-home
export JAVA_HOME=/workspace/alpine-jdk/usr/lib/jvm/java-17-openjdk
export LD_PRELOAD=/workspace/libremovefix.so
exec gradle "$@"
