#!/usr/bin/env bash
# uninstall.sh — dm-family 一键卸载
#
# 默认（安全模式）：只停服务、解除 supervisor 托管、清安装标记。
#   不删代码、不删用户数据（媒体/素材库/地图数据/数据库全部保留）。
#
# 选项（可组合，危险项需显式指定）:
#   --purge           额外清理构建产物：node_modules / ports.json /
#                     supervisor 运行时(sock,pid,log,生成的conf) / __pycache__
#   --drop-db         删除 PostgreSQL 里的 trip / Basemap 两个库（不动数据库软件）
#   --with-postgres   卸载 PostgreSQL / PostGIS 软件包（apt remove --purge）
#   --all             = --purge --drop-db --with-postgres（最彻底）
#   -y, --yes         跳过确认
#
# 示例:
#   ./uninstall.sh                    # 只停服务+清标记（随时可 ./install.sh 复原）
#   ./uninstall.sh --purge            # 连构建产物一起清，回到"刚 clone"状态
#   ./uninstall.sh --all -y           # 完全卸载（含数据库）
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
export ROOT
INSTALL_DIR="$ROOT/install"
export INSTALL_DIR
# shellcheck source=install/common.sh
source "$INSTALL_DIR/common.sh"

DO_PURGE=0
DO_DROP_DB=0
DO_WITH_PG=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --purge)        DO_PURGE=1 ;;
    --drop-db)      DO_DROP_DB=1 ;;
    --with-postgres) DO_WITH_PG=1 ;;
    --all)          DO_PURGE=1; DO_DROP_DB=1; DO_WITH_PG=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    help|-h|--help)
      sed -n '2,28p' "$0"; exit 0 ;;
    *) warn "忽略未知参数: $arg" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  echo ""
  echo "将要执行:"
  echo "  [总是] 停止全部 dm-family 服务、解除 supervisor 托管、清除安装标记"
  [ "$DO_PURGE" -eq 1 ]    && echo "  [purge] 删除 node_modules / ports.json / supervisor 运行时 / __pycache__"
  [ "$DO_DROP_DB" -eq 1 ]  && echo "  [drop-db] 删除数据库 trip、Basemap（不可恢复!）"
  [ "$DO_WITH_PG" -eq 1 ]  && echo "  [with-postgres] apt 卸载 PostgreSQL/PostGIS"
  echo ""
  echo "永远不会动: 项目代码、DMmedia 媒体文件、DMshow/library 素材、DMgeo/geodata 地图数据"
  echo ""
  read -r -p "确认继续? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) echo "已取消。"; exit 0 ;;
  esac
}

step "dm-family 卸载"
confirm

# ── 1. 停止 supervisord 托管的全部程序 ──
step "1/4 · 停止托管服务"
if [ -S "$SUP_DIR/supervisor.sock" ] && have supervisorctl; then
  supervisorctl -c "$SUP_CONF" stop all 2>/dev/null || true
  supervisorctl -c "$SUP_CONF" shutdown 2>/dev/null || true
  ok "supervisord 已停止"
else
  info "supervisord 未在运行，跳过"
fi
# 残留进程兜底
pkill -f "DMcore/supervisor" 2>/dev/null || true

# ── 2. 停止 DMcore 控制台与代理 ──
step "2/4 · 停止 DMcore 控制台 + 代理"
pkill -f "python3 app.py"        2>/dev/null || true
pkill -f "DMcore/app.py"         2>/dev/null || true
pkill -f "DMcore/proxy.js"       2>/dev/null || true
pkill -f "node proxy.js"         2>/dev/null || true
# 兜底：若 8088/8080 仍被占，提示用户
for p in 8088 8080; do
  if have ss && ss -tlnp 2>/dev/null | grep -qE "[:.]${p}([[:space:]]|$)"; then
    warn "端口 $p 仍被占用，请检查: ss -tlnp | grep $p"
  fi
done
ok "DMcore 进程已清理"

# ── 3. 清除安装标记 ──
step "3/4 · 清除安装标记"
if [ -d "$MARKER_DIR" ]; then
  rm -rf "$MARKER_DIR"
  ok "已删除 $MARKER_DIR"
else
  info "无标记目录，跳过"
fi

# ── 4. 可选清理 ──
step "4/4 · 可选清理"

if [ "$DO_PURGE" -eq 1 ]; then
  info "清理构建产物 ..."
  for d in DMmedia DMgeo DMpageo DMChat DMshow; do
    [ -d "$ROOT/$d/node_modules" ] && rm -rf "$ROOT/$d/node_modules" && info "  - $d/node_modules"
  done
  rm -f  "$ROOT/ports.json"
  rm -f  "$SUP_DIR/supervisor.sock" "$SUP_DIR/supervisord.pid"
  rm -rf "$SUP_DIR/logs"
  rm -f  "$SUP_DIR"/programs/dm-*.conf 2>/dev/null || true
  find "$ROOT" -maxdepth 3 -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  ok "构建产物已清理（源码与数据保留）"
fi

if [ "$DO_DROP_DB" -eq 1 ]; then
  PGVER="$(detect_pgver)"
  # 临时起库以便 drop
  pg_ctlcluster "$PGVER" main start 2>/dev/null || true
  sleep 2
  for db in trip Basemap; do
    info "删除数据库: $db"
    su postgres -c "psql -c \"DROP DATABASE IF EXISTS \\\"$db\\\"\"" 2>/dev/null \
      || sudo -u postgres psql -c "DROP DATABASE IF EXISTS \"$db\"" 2>/dev/null \
      || warn "  删除 $db 失败（可手动: sudo -u postgres dropdb $db）"
  done
  ok "数据库已删除（角色 $PGUSER 保留；PG 软件保留）"
fi

if [ "$DO_WITH_PG" -eq 1 ]; then
  if need_root_apt; then
    info "卸载 PostgreSQL / PostGIS ..."
    pg_ctlcluster "$(detect_pgver)" main stop 2>/dev/null || true
    run_apt remove -y --purge 'postgresql*' 2>/dev/null || warn "apt remove 有残留"
    run_apt autoremove -y 2>/dev/null || true
    ok "PostgreSQL 已卸载（/var/lib/postgresql 数据目录由系统保留，需手动删）"
  else
    warn "无 root/sudo，跳过 PostgreSQL 卸载"
  fi
fi

echo ""
echo "================================================"
echo "  ✅ dm-family 卸载完成"
echo "================================================"
echo "  已停: supervisord 托管 + DMcore(:8088) + 代理(:8080)"
echo "  已清: 安装标记 $MARKER_DIR"
[ "$DO_PURGE" -eq 1 ]    && echo "  已清: node_modules / 运行时产物"
[ "$DO_DROP_DB" -eq 1 ]  && echo "  已删: 数据库 trip / Basemap"
[ "$DO_WITH_PG" -eq 1 ]  && echo "  已卸: PostgreSQL/PostGIS 软件包"
echo ""
echo "  保留: 项目代码 + 全部用户数据（媒体/素材/地图数据）"
echo "  重装: ./install.sh        （随时可复原）"
echo "  彻底删代码: 手动 rm -rf $ROOT"
echo "================================================"
