#!/usr/bin/env bash
# 04-start.sh — 启动 supervisord 托管的业务服务 + 确保 DM 在跑
# 用法:
#   ./install.sh start           # 启动全部 program
#   ./install.sh start DMmedia   # 只启动指定（匹配 program 名）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

step "启动服务"

ensure_config_json
ensure_supervisord_conf
# 目录可能搬迁过，启动前重建 program 配置（幂等）
write_supervisor_programs

# 始终先保证 DM 核心在跑
if [ ! -f "$MARKER_DIR/dm.done" ]; then
  warn "尚未执行 DM 核心安装，先跑 01-dm ..."
  bash "$INSTALL_DIR/01-dm.sh"
else
  start_dmcore_processes
fi

if ! have supervisord; then
  warn "无 supervisord：仅保证 DMcore 已启动，业务服务请手动 node/python 启动"
  mark_done "start"
  exit 0
fi

# 确保 supervisord 实例
if [ ! -S "$SUP_DIR/supervisor.sock" ]; then
  info "拉起 supervisord ..."
  supervisorctl -c "$SUP_CONF" shutdown 2>/dev/null || true
  rm -f "$SUP_DIR/supervisor.sock" "$SUP_DIR/supervisord.pid"
  supervisord -c "$SUP_CONF"
  sleep 2
fi

# reread programs
supervisorctl -c "$SUP_CONF" reread 2>/dev/null || true
supervisorctl -c "$SUP_CONF" update 2>/dev/null || true

if [ "$#" -eq 0 ]; then
  info "启动全部托管程序 ..."
  supervisorctl -c "$SUP_CONF" start all 2>&1 || true
else
  for t in "$@"; do
    # 允许短名
    case "$t" in
      postgis|dm-postgis) t=dm-dm-postgis ;;
      media|DMmedia)      t=dm-DMmedia ;;
      geo|DMgeo)          t=dm-DMgeo ;;
      pageo|DMpageo)      t=dm-DMpageo ;;
      chat|DMChat)        t=dm-DMChat ;;
      show|DMshow)        t=dm-DMshow ;;
    esac
    info "启动 $t ..."
    supervisorctl -c "$SUP_CONF" start "$t" 2>&1 || \
      supervisorctl -c "$SUP_CONF" start "${t}:" 2>&1 || \
      warn "启动失败: $t（检查 $SUP_DIR/programs/）"
  done
fi

sleep 2
echo ""
info "当前状态:"
supervisorctl -c "$SUP_CONF" status 2>&1 || true

# 二次检查：刚 start 看不出的崩溃循环（uptime 永远几秒 = 反复重启）
sleep 5
BAD=$(supervisorctl -c "$SUP_CONF" status 2>/dev/null | grep -E "FATAL|BACKOFF|EXITED|STOPPED" || true)
if [ -n "$BAD" ]; then
  warn "以下程序未能稳定运行（反复重启的看日志找原因）:"
  echo "$BAD" | sed 's/^/    /'
  echo "    日志: supervisorctl -c $SUP_CONF tail -f <程序名>"
  echo "    或:   tail -30 $SUP_DIR/logs/<程序名>.log"
fi

print_dm_banner
if [ -f "$ROOT/ports.json" ]; then
  echo "📋 端口:"
  cat "$ROOT/ports.json" 2>/dev/null | sed 's/^/   /' || true
fi
echo "🛠️  运维:"
echo "   状态: supervisorctl -c $SUP_CONF status"
echo "   日志: supervisorctl -c $SUP_CONF tail -f <程序名>"
echo ""

mark_done "start"
ok "启动阶段完成"
