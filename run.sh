#!/usr/bin/env bash
# dm-family 一键运行（仅启动全家服务，不重装）
#
# 用法:
#   ./run.sh            # 启动全部托管服务 + DMcore 控制台 + 统一代理
#   ./run.sh DMmedia    # 仅启动指定服务
#   ./run.sh status     # 查看运行状态
#
# 安装只需在新机 clone 后做一次:  ./install.sh
#   · 自动建 venv 并装 Python 依赖（DMcore Flask）
#   · 自动装 PostgreSQL/PostGIS + 建库建扩展（已修复非超级用户建扩展的坑）
#   · 自动装各服务 npm 依赖 + 导入地图数据
# 装好之后日常只需 ./run.sh 一键启动，无需重装。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 尚未安装则提示先安装，不在"运行"里偷偷触发安装逻辑
if [ ! -f "$ROOT/.dm-install/dm.done" ]; then
  echo -e "\033[1;33m[warn]\033[0m 尚未安装 DM 核心，请先执行一次安装:"
  echo "       ./install.sh        # 一键全装"
  echo "       装完即可日常用 ./run.sh 一键启动，无需重装。"
  exit 1
fi

if [ "${1:-}" = "status" ]; then
  if [ -x ./install.sh ]; then exec ./install.sh status; fi
fi

if [ -x ./install.sh ]; then
  # 直接调 start 阶段：只起服务（dm.done 已存在，不会误触发安装）
  exec ./install.sh start "$@"
fi

echo -e "\033[1;31m[error]\033[0m 找不到 install.sh，无法启动。" >&2
exit 1
