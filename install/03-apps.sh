#!/usr/bin/env bash
# 03-apps.sh — 各业务服务的 Node 依赖（不启动）
# 可单独装某一个: ./install.sh apps DMmedia
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

step "安装业务应用依赖"

have node || error "需要 Node.js，请先执行: ./install.sh dm"
have npm || warn "未找到 npm，部分依赖可能装不上"

ALL_APPS=(DMmedia DMgeo DMpageo DMChat DMshow)
if [ "$#" -eq 0 ]; then
  APPS=("${ALL_APPS[@]}")
else
  APPS=("$@")
fi

for d in "${APPS[@]}"; do
  # 允许传 DMmedia 或 media
  case "$d" in
    media|DMmedia) d=DMmedia ;;
    geo|DMgeo)     d=DMgeo ;;
    pageo|DMpageo) d=DMpageo ;;
    chat|DMChat)   d=DMChat ;;
    show|DMshow)   d=DMshow ;;
  esac
  dir="$ROOT/$d"
  if [ ! -d "$dir" ]; then
    warn "跳过不存在的目录: $d"
    continue
  fi
  if [ -f "$dir/package.json" ]; then
    info "npm install → $d"
    (cd "$dir" && npm install --no-audit --no-fund 2>&1 | tail -3) || warn "$d 依赖安装有警告"
    ok "$d 依赖就绪"
  else
    info "$d 无 package.json，跳过 npm"
  fi
  # 各服务自带 install.sh 时可选执行（仅装依赖场景默认不跑完整 install）
done

# 素材库目录等
if [ -d "$ROOT/DMshow" ]; then
  mkdir -p "$ROOT/DMshow/library"/{works,albums,videos,gallery}
fi

mark_done "apps"
ok "业务依赖阶段完成: ${APPS[*]}"
