#!/usr/bin/env bash
# ============================================================
#  DM 全家服务 · 开机启动脚本（服务器版）
#  用法:
#    bash start.sh          # 非 root 会自动 sudo 提权（首次输入密码）
#    sudo bash start.sh     # 已是 root 直接运行
#  说明:
#    - 幂等：可重复运行。supervisord 不在则拉起，已在则跳过；
#      之后 start all 只会拉起"停掉/崩溃"的服务，已在跑的不打扰。
#    - 假设已执行过 ./install.sh 完成安装（建 venv / 装依赖 / postgis 等）。
#      本脚本只负责"启动"，不做安装。
#    - dm-postgis 需 root 权限起 PostgreSQL，故 supervisord 必须 root 运行。
#    - 换机器只需改下面的 PROJECT_DIR。
# ============================================================
set -e

# 非 root 自动提权（dm-postgis 起 PG 需要 root）
if [ "$EUID" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

# ---- 项目路径（sudo 下 ~ 会变成 /root，必须写死绝对路径）----
PROJECT_DIR="/home/duan/Desktop/dm-family-v3"
CONF="$PROJECT_DIR/DMcore/supervisor/supervisord.conf"
SOCK="$PROJECT_DIR/DMcore/supervisor/supervisor.sock"
LOGDIR="$PROJECT_DIR/DMcore/supervisor/logs"

cd "$PROJECT_DIR"

# ---- 1) 确保 supervisord(root) 在运行 ----
need_start=0
if [ ! -S "$SOCK" ]; then
  need_start=1
else
  # sock 在，但确认属主是 root（非 root 起的 supervisord 会让 dm-postgis 起不来）
  PID=$(pgrep -f "supervisord -c $CONF" | head -1 || true)
  if [ -n "$PID" ]; then
    OWNER=$(ps -o user= -p "$PID" 2>/dev/null | tr -d ' ')
    if [ "$OWNER" != "root" ]; then
      echo "[start] 发现非 root 的 supervisord(pid=$PID)，重启为 root ..."
      supervisorctl -c "$CONF" shutdown || true
      sleep 1
      need_start=1
    fi
  else
    need_start=1
  fi
fi

if [ "$need_start" -eq 1 ]; then
  mkdir -p "$LOGDIR"
  echo "[start] 以 root 拉起 supervisord ..."
  supervisord -c "$CONF"
  sleep 2
fi

# ---- 2) 拉起 / 确认所有 DM 服务 ----
echo "[start] 拉起所有 DM 服务 ..."
supervisorctl -c "$CONF" start all || true

# ---- 3) 状态汇报 ----
echo ""
echo "================ DM 服务状态 ================"
supervisorctl -c "$CONF" status
echo "=============================================="
echo "✅ 全家服务已就绪"
echo "   控制台:   http://127.0.0.1:8088"
echo "   代理入口: http://127.0.0.1:8080   (/media /geo /pageo /chat /show /files)"
