#!/bin/sh
# 编译构建垫片 libremovefix.so（仅在 Termux/Alpine 这类 seccomp 受限环境需要）
#
# 背景见 remove_fix.c 顶部注释。
# 编译产物请放到 /workspace/libremovefix.so，build.sh 会 LD_PRELOAD 它。
set -e
cd "$(dirname "$0")"
gcc -shared -fPIC -O2 -o /workspace/libremovefix.so ./remove_fix.c -ldl
echo "已生成 /workspace/libremovefix.so"
