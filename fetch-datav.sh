#!/usr/bin/env bash
# dm-family — 阿里行政区划数据「一键刷新」独立入口
#
# 适用场景：已装好全家（./install.sh 跑过一次）后，切换网络（避开 Cloudflare 对阿里
# DataV 的拦截）单独拉取 + 入库最新行政区划，无需重装全家。
#
# 用法:
#   ./fetch-datav.sh            # 联网拉取阿里 DataV 最新行政区划 + upsert 入库
#   ./install.sh status         # 查看依赖是否就绪（postgis / apps 应已完成）
#
# 依赖（06-fetch-datav.sh 会自动检查并补装/临时拉起）:
#   · node + DMgeo 的 pg 包（缺了自动 npm install）
#   · PostgreSQL 已在跑（没跑会临时拉起，跑完停掉）
#   · Basemap 库已建（即 postgis 阶段已跑过）
#
# 若阿里不可达，脚本会明确报错 exit(2) 并提示切网络重试 —— 这正是它和 geodata 阶段的区别。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ ! -x ./install.sh ]; then
  echo -e "\033[1;31m[error]\033[0m 找不到 install.sh，无法运行 fetch-datav。" >&2
  exit 1
fi

# 尚未安装完整核心时给提示，但仍尝试运行（06 脚本会做实际依赖校验）
if [ ! -f "$ROOT/.dm-install/dm.done" ]; then
  echo -e "\033[1;33m[warn]\033[0m 未检测到 DM 安装标记（.dm-install/dm.done）。"
  echo "       若已单独装好 PostgreSQL + DMgeo，可继续；否则请先: ./install.sh"
  echo "       下面交给 install.sh fetch-datav 做依赖自检 ..."
fi

echo -e "\033[1;36m[fetch-datav]\033[0m 开始联网刷新阿里行政区划 ..."
exec ./install.sh fetch-datav "$@"
