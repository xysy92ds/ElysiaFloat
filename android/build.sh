#!/bin/sh
# EllyFloat 构建脚本
#
# 说明：本机内核启用了 seccomp 过滤，musl 的 remove() 在删除目录时会返回
# ENOENT，导致 AGP 的 apkzlib 在关闭临时目录时报 “Failed to delete ...”。
# libremovefix.so 是一个 LD_PRELOAD 垫片，把删除目录的操作改走 rmdir()。
# 因此必须在启动 Gradle 时带上 LD_PRELOAD。
set -e
cd "$(dirname "$0")"
# 前端源在 assets/src/，构建产物 assets/index.html 由脚本拼接生成；
# 不先跑这一步，打包进去的就是旧产物。
if command -v node >/dev/null 2>&1; then
  node tools/build-html.js
fi
export GRADLE_USER_HOME=/workspace/gradle-home
# AGP 8.6 只验证过 JDK 17；即使环境里已有 JAVA_HOME（可能是 JDK 25），也优先用项目自带的 17
for d in /workspace/jdk17 /workspace/alpine-jdk/usr/lib/jvm/java-17-openjdk; do
  if [ -x "$d/bin/java" ]; then export JAVA_HOME="$d"; break; fi
done
if [ -z "$JAVA_HOME" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "找不到可用的 JDK 17，请设置 JAVA_HOME" >&2
  exit 1
fi
export LD_PRELOAD=/workspace/libremovefix.so
exec gradle "$@"
