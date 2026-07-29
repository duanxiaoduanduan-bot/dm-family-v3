#!/usr/bin/env bash
# sync-github.sh — 把 dm-family 同步到 GitHub
#
# 用法:
#   ./sync-github.sh init <仓库地址>     # 首次: git init + 关联远程 + 首次推送
#     例: ./sync-github.sh init git@github.com:duan-duan/dm-family.git
#   ./sync-github.sh "提交说明"          # 日常: add + commit + push
#   ./sync-github.sh                     # 日常(交互输入提交说明)
#   ./sync-github.sh --dry-run           # 只预览将提交的内容, 不实际提交
#
# 数据目录(媒体/地图/geodata/node_modules)已被 .gitignore 排除, 不会上传。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

info()  { echo -e "\033[1;36m[sync]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[  ok  ]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[ warn ]\033[0m $*" >&2; }
die()   { echo -e "\033[1;31m[error ]\033[0m $*" >&2; exit 1; }

have() { command -v "$1" &>/dev/null; }
have git || die "未找到 git，请先安装: sudo apt install git"

# ── init 模式 ──
if [ "${1:-}" = "init" ]; then
  REMOTE="${2:-}"
  [ -n "$REMOTE" ] || die "用法: ./sync-github.sh init <仓库地址>"
  if [ ! -d .git ]; then
    git init
    info "git init 完成"
  fi
  # git 提交身份(仅本仓库生效, 不污染全局)
  git config user.name  >/dev/null 2>&1 || git config user.name  "dm-family"
  git config user.email >/dev/null 2>&1 || git config user.email "dm-family@local"
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE"
    info "已更新 origin → $REMOTE"
  else
    git remote add origin "$REMOTE"
    info "已关联 origin → $REMOTE"
  fi
  git add -A
  git commit -m "dm-family: 初始提交（代码+文档，数据目录已忽略）" || warn "无改动可提交"
  BRANCH="$(git branch --show-current 2>/dev/null || echo main)"
  [ -z "$BRANCH" ] && BRANCH=main
  git push -u origin "$BRANCH" || die "push 失败：检查仓库地址/权限(SSH key 或 token)"
  ok "首次同步完成 → $REMOTE"
  exit 0
fi

[ -d .git ] || die "还不是 git 仓库。先执行: ./sync-github.sh init <仓库地址>"

# ── 预览/安全检查 ──
git add -A
CHANGED="$(git diff --cached --name-only || true)"
if [ -z "$CHANGED" ]; then
  ok "没有改动，无需同步"
  exit 0
fi

COUNT="$(echo "$CHANGED" | wc -l)"
SIZE="$(git diff --cached --numstat | awk '{a+=$1; d+=$2} END {printf "+%s/-%s 行", a, d}')"
info "将提交 $COUNT 个文件 ($SIZE):"
echo "$CHANGED" | sed 's/^/    /' | head -40
[ "$COUNT" -gt 40 ] && echo "    ... 共 $COUNT 个"

# 大文件护栏: 暂存区里 >5MB 的文件直接拦截(防止误传数据)
BIG=""
while IFS= read -r f; do
  [ -f "$f" ] || continue
  sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)
  if [ "$sz" -gt 5242880 ]; then
    BIG="$BIG\n    $f ($(numfmt --to=iec "$sz" 2>/dev/null || echo "${sz}B"))"
  fi
done <<< "$CHANGED"
if [ -n "$BIG" ]; then
  git reset >/dev/null 2>&1 || true
  die "检测到 >5MB 文件，已取消暂存。请将其加入 .gitignore 后再同步:$BIG"
fi

if [ "${1:-}" = "--dry-run" ]; then
  git reset >/dev/null 2>&1 || true
  info "dry-run 结束（未提交）"
  exit 0
fi

# ── 提交 ──
MSG="${1:-}"
if [ -z "$MSG" ]; then
  read -r -p "提交说明: " MSG
  MSG="${MSG:-更新}"
fi
git commit -m "$MSG"
info "已提交: $MSG"

# ── 推送 ──
BRANCH="$(git branch --show-current 2>/dev/null || echo main)"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin "$BRANCH" || die "push 失败：先 git pull 合并远程改动，或检查权限"
  ok "已推送 → origin/$BRANCH"
else
  warn "未关联远程仓库，只完成本地提交"
  warn "关联: ./sync-github.sh init <仓库地址>"
fi
