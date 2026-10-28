#!/usr/bin/env bash
# 工作转移包：源码 + 文档 + APK + git bundle + 状态/差异 + 校验值 + 恢复说明
#
# 用法：
#   tools/handoff.sh                       # 版本号从 android/app/build.gradle 读取
#   tools/handoff.sh --version 0.8.0
#   tools/handoff.sh --note "0.8.0 发布后"
#
# 产物：handoff/ElysiaFloat-handoff-v<版本>-<时间戳>.zip（同名 .sha256）
# 说明：包内含私有仓库的签名材料（android/keystore/*），只用于内部转移，不要公开。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION=""
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --note) NOTE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION="$(grep -oE 'versionName[[:space:]]+"[^"]+"' android/app/build.gradle | head -1 | grep -oE '"[^"]+"' | tr -d '"')"
fi
[ -n "$VERSION" ] || { echo "无法读取版本号，请用 --version 指定" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="ElysiaFloat-handoff-v${VERSION}-${STAMP}"
OUT="$ROOT/handoff/$NAME"
mkdir -p "$OUT"
echo "输出：handoff/$NAME"

echo "[1/7] 源码（当前工作区，含未提交改动）"
rsync -a \
  --exclude '.git' --exclude 'handoff' --exclude 'node_modules' \
  --exclude '.gradle' --exclude 'android/app/build' --exclude 'android/build' \
  --exclude 'apk/phases' --exclude '*.zip' --exclude '.uploads' \
  --exclude 'android/local.properties' --exclude 'workspace' \
  ./ "$OUT/01-source/"

echo "[2/7] 文档（workspace/）"
mkdir -p "$OUT/02-docs"
[ -d workspace ] && rsync -a workspace/ "$OUT/02-docs/workspace/"

echo "[3/7] APK"
mkdir -p "$OUT/03-apk"
LATEST_APK="$(ls -1t apk/*.apk 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_APK" ]; then
  cp "$LATEST_APK" "$OUT/03-apk/"
  sha256sum "$LATEST_APK" | sed "s#  .*/#  #" > "$OUT/03-apk/SHA256SUMS"
fi

echo "[4/7] Git（完整历史 bundle + 状态/差异）"
mkdir -p "$OUT/04-git"
git bundle create "$OUT/04-git/elysia.bundle" --all >/dev/null 2>&1
git rev-parse HEAD > "$OUT/04-git/HEAD.txt"
git status --porcelain=v1 > "$OUT/04-git/status.txt"
git diff > "$OUT/04-git/unstaged.diff"
git diff --cached > "$OUT/04-git/staged.diff"
git log -n 30 --oneline > "$OUT/04-git/log.txt"
{
  echo "date: $(date -Iseconds)"
  echo "git_head: $(git rev-parse HEAD)"
  echo "node: $(node -v 2>/dev/null || echo 'n/a')"
  echo "java: $(java -version 2>&1 | head -1 || echo 'n/a')"
  echo "gradle: $(gradle -v 2>/dev/null | grep -m1 Gradle || echo 'n/a')"
} > "$OUT/04-git/env.txt"

echo "[5/7] 恢复说明"
cat > "$OUT/00-START-HERE.md" <<EOF
# ElysiaFloat 工作转移包 v${VERSION}

- 生成时间：$(date -Iseconds)
- 备注：${NOTE:-（无）}
- 生成机器：$(hostname 2>/dev/null || echo unknown) / $(uname -srm)

## 包里有什么

| 目录 | 内容 |
|---|---|
| \`01-source/\` | 当前工作区源码快照（含未提交改动；不含 .git / build / node_modules） |
| \`02-docs/\` | \`workspace/\` 全部文档（计划、问题、决策、工作日志） |
| \`03-apk/\` | 最近一次构建的测试 APK 及其 SHA-256 |
| \`04-git/\` | \`elysia.bundle\`（完整提交历史）、HEAD、status、未提交 diff、最近日志、环境版本 |
| \`SHA256SUMS\` | 包内全部文件的校验值 |

## 恢复步骤

1. 校验完整性（在解压后的包目录内）：

   \`\`\`sh
   sha256sum -c SHA256SUMS
   \`\`\`

2. 取回提交历史：

   \`\`\`sh
   git clone 04-git/elysia.bundle elysia
   cd elysia
   git checkout main
   \`\`\`

3. 用源码快照覆盖成「离开时的现场」（包含尚未提交的改动）：

   \`\`\`sh
   rsync -a --exclude '.git' 01-source/ ./
   rsync -a 02-docs/workspace/ ./workspace/
   \`\`\`

   > 源码快照与文档快照是权威现场；bundle 只包含已提交历史。冲突时以快照为准。

4. 恢复本机构建环境：

   - \`android/local.properties\` 不随包分发，需要写 \`sdk.dir=<Android SDK 路径>\`；
   - 需要 JDK 17；本机构建脚本是 \`android/build.sh assembleDebug\`。

5. 签名：包内包含私有仓库的 \`android/keystore/elysia.jks\` 与 \`android/keystore.properties\`，
   保持同一签名才能覆盖安装旧版本。**该包不要公开或提交到公开仓库。**

6. 继续工作前先读：\`02-docs/workspace/STATUS.md\` → \`plans/MASTER-EXECUTION-PLAN.md\` →
   \`plans/PLATFORM-0.8-0.15.md\` → \`issues/ISSUE-REGISTER.md\`。

## 已知边界

- \`apk/phases/\` 历史阶段包、\`node_modules/\`、Gradle 缓存不在包内；
- 更新源以公开仓库 \`xysy92ds/ElysiaFloat\` 的 \`release/latest.json\` 为准。
EOF

echo "[6/7] 校验值"
( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

echo "[7/7] 压缩"
( cd "$ROOT/handoff" && zip -qr "$NAME.zip" "$NAME" )
sha256sum "$ROOT/handoff/$NAME.zip" > "$ROOT/handoff/$NAME.zip.sha256"
unzip -t "$ROOT/handoff/$NAME.zip" >/dev/null
rm -rf "$OUT"

echo
echo "完成：handoff/$NAME.zip"
echo "校验：$(cut -d' ' -f1 "$ROOT/handoff/$NAME.zip.sha256")"
