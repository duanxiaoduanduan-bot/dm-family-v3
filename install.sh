#!/usr/bin/env bash
# dm-family 分阶段安装入口
#
# 一键全装（默认）：先装 DM 核心，再 PostGIS → 业务依赖 → 地图数据 → 启动
#   ./install.sh
#   ./install.sh all
#
# 只装某一阶段：
#   ./install.sh dm          # 只装 DMcore 控制台 + 统一代理（最先）
#   ./install.sh postgis     # PostgreSQL / PostGIS / 库表
#   ./install.sh apps        # 各服务 npm 依赖
#   ./install.sh apps DMmedia DMChat
#   ./install.sh geodata     # 地图底图数据（在线下载，装完不黑屏）
#   ./install.sh geodata --local /path/to/data   # 或从本地目录导入
#   ./install.sh start       # 启动 supervisord 托管服务
#   ./install.sh start DMmedia
#
# 查看阶段：
#   ./install.sh list
#   ./install.sh status
#
# 卸载：
#   ./install.sh uninstall          # 停服务+清标记（数据保留）
#   ./uninstall.sh --all            # 彻底卸载（含数据库）
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
export ROOT
INSTALL_DIR="$ROOT/install"
export INSTALL_DIR

# shellcheck source=install/common.sh
source "$INSTALL_DIR/common.sh"

usage() {
  cat <<'EOF'
dm-family 分阶段安装

用法:
  ./install.sh [命令] [参数...]

命令:
  all          一键全装（默认）—— 顺序: dm → postgis → apps → geodata → start
  dm           只装 DM 核心（DMcore 控制台 + 代理 + supervisord 骨架）
  postgis      只装 PostgreSQL / PostGIS / 库表
  apps [名..]  只装业务 Node 依赖（可指定 DMmedia DMgeo ...）
  geodata      地图底图数据：行政区划(阿里DataV) + 世界国界(Natural Earth)
               选项: --local <目录> 本地导入 | --skip 跳过
  start [名..] 启动服务（可指定 DMmedia / postgis ...）
  uninstall    一键卸载（停服务+清标记；选项见 ./uninstall.sh help）
  list         列出安装阶段
  status       查看已完成阶段 + 服务状态
  help         显示本说明

环境变量:
  DMCORE_PORT=8088   DMcore 端口
  DMCORE_HOST=0.0.0.0
  GEO_SOURCE         online(默认) / local / skip
  GEO_LOCAL_DIR      local 模式的数据目录（也可 --local 传）
  SKIP_GEODATA=1     跳过地图数据（兼容旧变量 SKIP_DATAV=1）
  PGUSER / PGPASS    数据库账号（默认 dmuser / dmpageo123）

示例:
  ./install.sh                 # 全装（含地图数据，装完不黑屏）
  ./install.sh dm              # 先只起控制台
  ./install.sh postgis && ./install.sh apps && ./install.sh geodata && ./install.sh start
  ./install.sh geodata --local /mnt/usb/geodata   # 用 U 盘/旧机数据导入
EOF
}

list_stages() {
  cat <<EOF
安装阶段（按依赖顺序）:

  1. dm       $INSTALL_DIR/01-dm.sh
              → python/flask、node、supervisor
              → config.json、supervisord 骨架（按本机路径生成）
              → 启动 DMcore(:8088) + 统一代理(:8080)

  2. postgis  $INSTALL_DIR/02-postgis.sh
              → PostgreSQL + PostGIS
              → 库 trip / Basemap + features 表

  3. apps     $INSTALL_DIR/03-apps.sh
              → DMmedia / DMgeo / DMpageo / DMChat / DMshow 的 npm 依赖

  4. geodata  $INSTALL_DIR/05-geodata.sh
              → 行政区划(阿里 DataV) + 世界国界(Natural Earth) → Basemap
              → 生成前端底图 map-boundaries/（缺了会黑屏）
              → 支持 --local <目录> 本地导入 / --skip 跳过

  5. start    $INSTALL_DIR/04-start.sh
              → 确保 DM 在跑
              → supervisorctl start 业务程序

标记目录: $MARKER_DIR
EOF
}

show_status() {
  step "安装进度"
  for s in dm postgis apps geodata start; do
    if is_done "$s"; then
      ok "$s  · 已完成 ($(cat "$MARKER_DIR/$s.done" 2>/dev/null || echo '?'))"
    else
      echo -e "\033[1;33m[  --  ]\033[0m $s  · 未完成"
    fi
  done
  echo ""
  if [ -S "$SUP_DIR/supervisor.sock" ] && have supervisorctl; then
    info "supervisord 状态:"
    supervisorctl -c "$SUP_CONF" status 2>&1 || true
  else
    warn "supervisord 未运行或无 socket"
  fi
  echo ""
  local port="${DMCORE_PORT:-8088}"
  if have ss; then
    info "端口监听(DM 相关):"
    ss -tlnp 2>/dev/null | grep -E ':(8080|8081|8083|8084|8085|8086|8087|8088)\b' || true
  fi
  if have curl; then
    if curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 \
      || curl -sf "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      ok "DMcore 可访问 http://127.0.0.1:${port}"
    else
      warn "DMcore :${port} 无响应"
    fi
  fi
}

run_stage() {
  local name="$1"
  shift || true
  local script=""
  case "$name" in
    dm)      script="$INSTALL_DIR/01-dm.sh" ;;
    postgis) script="$INSTALL_DIR/02-postgis.sh" ;;
    apps)    script="$INSTALL_DIR/03-apps.sh" ;;
    geodata) script="$INSTALL_DIR/05-geodata.sh" ;;
    start)   script="$INSTALL_DIR/04-start.sh" ;;
    *) error "未知阶段: $name（用 ./install.sh list 查看）" ;;
  esac
  [ -f "$script" ] || error "缺少脚本: $script"
  chmod +x "$script" 2>/dev/null || true
  info "执行阶段: $name"
  # apps / start 可带额外参数
  bash "$script" "$@"
}

run_all() {
  echo ""
  echo "================================================"
  echo "  dm-family 一键安装"
  echo "  顺序: DM 核心 → PostGIS → 业务依赖 → 地图数据 → 启动"
  echo "================================================"
  echo ""

  # 1. 永远先装 DM
  run_stage dm

  # 2. 空间库（失败可继续，部分服务不依赖）
  if ! run_stage postgis; then
    warn "postgis 阶段失败，继续后续（仅影响地图/空间相关）"
  fi

  # 3. 业务依赖
  run_stage apps

  # 4. 地图底图数据（失败可继续，但大屏会黑屏；可稍后 ./install.sh geodata 补）
  if ! run_stage geodata; then
    warn "geodata 阶段失败（大屏/地图暂无底图）。稍后补: ./install.sh geodata"
  fi

  # 5. 启动
  run_stage start

  echo ""
  echo "================================================"
  echo "  ✅ dm-family 一键部署完成"
  echo "================================================"
  show_status
  print_dm_banner
  echo "🛠️  运维:"
  echo "   状态: ./install.sh status"
  echo "   只启某服务: ./install.sh start DMmedia"
  echo "   supervisor: supervisorctl -c $SUP_CONF status"
  echo ""
}

# ── main ──
CMD="${1:-all}"
if [ $# -gt 0 ]; then shift; fi

case "$CMD" in
  all|full|"")
    run_all
    ;;
  dm|core|dmcore)
    run_stage dm
    ;;
  postgis|pg|db)
    # 依赖：建议先有 dm（不强制）
    if ! is_done dm; then
      warn "尚未安装 DM 核心，建议先: ./install.sh dm"
    fi
    run_stage postgis
    ;;
  apps|deps)
    if ! is_done dm; then
      warn "尚未安装 DM 核心，先执行 dm ..."
      run_stage dm
    fi
    run_stage apps "$@"
    ;;
  geodata|data|map|maps)
    if ! is_done apps; then
      warn "业务依赖未装（geodata 需要 DMgeo 的 pg 包），先执行 apps ..."
      run_stage apps DMgeo
    fi
    run_stage geodata "$@"
    ;;
  start|up)
    run_stage start "$@"
    ;;
  uninstall|remove)
    exec bash "$ROOT/uninstall.sh" "$@"
    ;;
  list|stages)
    list_stages
    ;;
  status|st)
    show_status
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage
    error "未知命令: $CMD"
    ;;
esac
