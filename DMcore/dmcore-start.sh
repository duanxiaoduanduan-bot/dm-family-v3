#!/usr/bin/env bash
# DMcore 启动：运维控制台(8088) + 统一入口代理(8080, 由 app.py 内部拉起)
# 由 supervisor 的 dm-DMcore program 调用（command=bash dmcore-start.sh）
set -e
cd "$(dirname "$0")"
ROOT="$(cd "$PWD/.." && pwd)"

# 优先使用 install 阶段自动创建的 venv python；不存在则回退系统 python3。
# 必须 venv/bin/pip 也存在才算真正可用——避免 venv 创建失败时残留的"假 venv"软链误导。
PY="$ROOT/venv/bin/python"
if [ ! -x "$PY" ] || [ ! -x "$ROOT/venv/bin/pip" ]; then PY="python3"; fi

export DMCORE_PORT="${DMCORE_PORT:-8088}"
export DMCORE_HOST="${DMCORE_HOST:-0.0.0.0}"

echo "[DMcore] 控制台端口: $DMCORE_PORT  host: $DMCORE_HOST"
exec "$PY" app.py
