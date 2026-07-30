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

if ! have supervisord; then
  # 无 supervisord：仅保证 DMcore 已启动(或先装核心)，业务服务请手动 node/python 启动
  if [ ! -f "$MARKER_DIR/dm.done" ]; then
    warn "尚未执行 DM 核心安装，先跑 01-dm ..."
    bash "$INSTALL_DIR/01-dm.sh"
  else
    start_dmcore_processes
  fi
  mark_done "start"
  exit 0
fi

# 确保 supervisord 实例。dm-postgis 需要 root 才能 su postgres / pg_ctlcluster 起 PG，
# 因此 supervisord 必须以 root 运行；若它已在跑但属主非 root（例如之前非 sudo 启动的残留），
# 这里重启为 root，否则 dm-postgis 程序无法提权（user=root 在非 root 上下文无效）。
ensure_supervisord_root() {
  if [ "$(id -u)" -ne 0 ]; then
    warn "当前非 root，dm-postgis 可能需要 root。建议: sudo ./install.sh start"
    [ -S "$SUP_DIR/supervisor.sock" ] || { supervisord -c "$SUP_CONF" && sleep 2; }
    return 0
  fi
  if [ ! -S "$SUP_DIR/supervisor.sock" ]; then
    info "拉起 supervisord (root) ..."
    supervisord -c "$SUP_CONF"
    sleep 2
    return 0
  fi
  # sock 存在：检查属主是否非 root，是则重启为 root
  local sock_uid
  sock_uid=$(stat -c '%u' "$SUP_DIR/supervisor.sock" 2>/dev/null || echo 0)
  if [ "$sock_uid" -ne 0 ]; then
    info "supervisord 当前非 root，重启为 root（dm-postgis 需要）..."
    supervisorctl -c "$SUP_CONF" shutdown 2>/dev/null || true
    sleep 1
    rm -f "$SUP_DIR/supervisor.sock" "$SUP_DIR/supervisord.pid"
    supervisord -c "$SUP_CONF"
    sleep 2
  fi
}
ensure_supervisord_root

# DMcore 现已由 supervisord 托管(dm-DMcore, autostart=true)。
# 若它因故未随 supervisord 启动(端口空)，这里用 supervisorctl 兜底拉起。
if ! ss -tlnp 2>/dev/null | grep -qE "[:.]8088([[:space:]]|$)"; then
  info "兜底拉起 DMcore 控制台 ..."
  supervisorctl -c "$SUP_CONF" start dm-DMcore 2>&1 || true
fi

# reread programs（含新增/变更的 program 配置）
supervisorctl -c "$SUP_CONF" reread 2>/dev/null || true
supervisorctl -c "$SUP_CONF" update 2>/dev/null || true

if [ "$#" -eq 0 ]; then
  info "启动全部托管程序 ..."
  supervisorctl -c "$SUP_CONF" start all 2>&1 || true
else
  for t in "$@"; do
    # 允许短名
    case "$t" in
      core|DMcore)        t=dm-DMcore ;;
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
