#!/usr/bin/env bash
# DMcore 启动脚本
set -e
cd "$(dirname "$0")"

PORT="${DMCORE_PORT:-8088}"
HOST="${DMCORE_HOST:-0.0.0.0}"

# 注意: 这里【不】主动拉起 DMcore 独立 supervisord 实例。
# 仅当用户在界面真正点击 启动/停止/重启 时, 才由 projects.start/stop/restart
# 内部的 ensure_supervisor() 按需拉起, 以保留 “默认只运行 DMcore、服务按需启动” 的行为。

echo "▶ 启动 DMcore 控制台..."
echo "  访问地址: http://${HOST}:${PORT}  (本机请用 http://127.0.0.1:${PORT})"
echo "  停止: 按 Ctrl+C"
echo

# 优先使用仓库 venv（由 ./install.sh 自动创建），否则回退系统 python3。
# 必须 venv/bin/pip 也存在才算真正可用——避免 venv 创建失败时残留的"假 venv"软链误导。
PY="../venv/bin/python"
if [ -x "$PY" ] && [ -x "../venv/bin/pip" ]; then :; else PY="python3"; fi
DMCORE_PORT="$PORT" DMCORE_HOST="$HOST" "$PY" app.py
