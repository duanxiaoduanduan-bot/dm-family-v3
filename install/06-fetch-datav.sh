#!/usr/bin/env bash
# 06-fetch-datav.sh — 联网刷新阿里行政区划：拉取最新（fetch-datav.js）+ upsert 入库（import-datav.js）
#
# 与 geodata 阶段的区别：联网拉取是【必需】的（fetch 失败即报错退出，明确提示切换网络），
# 不像 install.sh geodata 里 fetch 失败可回落缓存。这是"切换网络后可以纯拉数据"的独立入口。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

GEO_DIR="$ROOT/DMgeo"
[ -d "$GEO_DIR" ] || error "缺少 DMgeo 目录"
have node || error "需要 node（先跑 ./install.sh dm）"

# ── 依赖：pg 包必须就位（本阶段排在 apps 后；缺失时自动补装）──
if [ ! -d "$GEO_DIR/node_modules/pg" ]; then
  warn "DMgeo 缺少 node 依赖，自动补装 ..."
  have npm || error "需要 npm 安装 DMgeo 依赖（或先跑: ./install.sh apps DMgeo）"
  (cd "$GEO_DIR" && npm install --no-audit --no-fund 2>&1 | tail -2) || error "DMgeo 依赖安装失败"
fi
ok "DMgeo 依赖就绪"

# ── 数据库：在跑就直接用；没跑临时拉起，跑完停掉 ──
PG_STARTED_BY_US=0
PGVER="$(detect_pgver)"
if have pg_ctlcluster; then
  if ! pg_lsclusters 2>/dev/null | grep -qE 'online'; then
    info "PostgreSQL 未在运行，临时拉起做导入 ..."
    pg_ctlcluster "$PGVER" main start 2>/dev/null || sudo pg_ctlcluster "$PGVER" main start 2>/dev/null || true
    sleep 2
    PG_STARTED_BY_US=1
  fi
fi
stop_pg_if_ours() {
  if [ "$PG_STARTED_BY_US" = "1" ]; then
    info "导入完成，恢复停库（交由 supervisord 托管时再启）"
    pg_ctlcluster "$PGVER" main stop 2>/dev/null || sudo pg_ctlcluster "$PGVER" main stop 2>/dev/null || true
  fi
}
trap stop_pg_if_ours EXIT

if have psql; then
  PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d Basemap -c "SELECT 1" >/dev/null 2>&1 \
    || warn "连不上 Basemap 库（$PGUSER@localhost）。若 postgis 阶段未跑，导入会失败"
fi

step "联网拉取阿里行政区划（fetch-datav.js）"
(cd "$GEO_DIR" && node fetch-datav.js) \
  || error "fetch-datav.js 失败：阿里 DataV 不可达（很可能被 Cloudflare / 代理拦截）。请切换网络后重试: ./install.sh fetch-datav"

step "upsert 入库（import-datav.js）"
(cd "$GEO_DIR" && node import-datav.js 2>&1 | tail -8) \
  || error "import-datav.js 失败（见上方日志）"

# ── 校验输出 ──
CNT=""
if have psql; then
  CNT=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d Basemap -tA \
    -c "SELECT (SELECT count(*) FROM provinces)||' / '||(SELECT count(*) FROM cities)||' / '||(SELECT count(*) FROM districts)" 2>/dev/null || echo "")
  [ -n "$CNT" ] && ok "Basemap 省/市/区 = $CNT"
fi
PROV_COUNT="${CNT%% *}"
if [ -z "$CNT" ] || [ "${PROV_COUNT:-0}" = "0" ]; then
  error "数据校验失败：Basemap 里没有省数据（连接不上或导入失败）"
fi
[ -f "$GEO_DIR/map-boundaries/china-provinces.geojson" ] \
  && ok "前端底图已更新: map-boundaries/china-provinces.geojson" \
  || warn "前端底图缺失（china-provinces.geojson）"
ok "阿里行政区划刷新完成"
