#!/usr/bin/env bash
# 05-geodata.sh — 地图数据初始化（装完不黑屏的关键阶段）
#
# 在 apps 之后运行（需要 DMgeo 的 pg 依赖已装），把底图数据灌进 PostGIS
# 并生成前端边界文件 map-boundaries/ + geodata 缓存。
#
# 数据源（GEO_SOURCE 三选一）:
#   online  默认。阿里 DataV.GeoAtlas（行政区划）+ Natural Earth（世界国界），
#           脚本内置重试与离线回退；下载后自动缓存，下次离线可用。
#   local   本地导入。GEO_LOCAL_DIR=<目录>，支持两种布局：
#             a) 完整缓存布局: 含 china/{provinces,cities,districts} → 整体拷入 geodata/
#             b) 散装 geojson/json/gpx → 拷入 geodata/ 根（server 自动扫描展示）
#           目录里若带 map-boundaries/ 也一并拷入。
#   skip    跳过（也可 SKIP_GEODATA=1；兼容旧变量 SKIP_DATAV=1）
#
# 用法:
#   ./install.sh geodata                              # 在线下载 + 导入
#   ./install.sh geodata --local /path/to/data        # 本地导入
#   GEO_SOURCE=skip ./install.sh geodata              # 跳过
#   （导入本身幂等：清表重灌，重复执行安全）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

# ── 参数解析 ──
GEO_SOURCE="${GEO_SOURCE:-online}"
GEO_LOCAL_DIR="${GEO_LOCAL_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --local)  GEO_SOURCE=local; GEO_LOCAL_DIR="${2:?--local 需要目录参数}"; shift 2 ;;
    --online) GEO_SOURCE=online; shift ;;
    --skip)   GEO_SOURCE=skip; shift ;;
    *) warn "忽略未知参数: $1"; shift ;;
  esac
done
[ "${SKIP_GEODATA:-0}" = "1" ] && GEO_SOURCE=skip
[ "${SKIP_DATAV:-0}"   = "1" ] && GEO_SOURCE=skip   # 兼容旧变量

step "地图数据初始化（来源: $GEO_SOURCE）"

# ── 跳过（不写完成标记——没数据就是没完成，状态页必须诚实）──
if [ "$GEO_SOURCE" = "skip" ]; then
  warn "已跳过地图数据初始化。大屏/地图将无底图（黑屏），可随时补: ./install.sh geodata"
  exit 0
fi

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

# ── local 模式：先把本地数据拷入缓存 ──
# 安全约定：cp -n（no-clobber），已有缓存绝不覆盖，防止旧数据被导入源顶掉
if [ "$GEO_SOURCE" = "local" ]; then
  [ -n "$GEO_LOCAL_DIR" ] && [ -d "$GEO_LOCAL_DIR" ] || error "本地数据目录不存在: ${GEO_LOCAL_DIR:-（未指定，用 --local <目录>）}"
  info "从本地导入（不覆盖已有文件）: $GEO_LOCAL_DIR"
  mkdir -p "$GEO_DIR/geodata"
  # a) 完整缓存布局（china/provinces 等）
  if [ -d "$GEO_LOCAL_DIR/china" ]; then
    cp -rn "$GEO_LOCAL_DIR/china" "$GEO_DIR/geodata/" 2>/dev/null || cp -r "$GEO_LOCAL_DIR/china" "$GEO_DIR/geodata/"
    ok "  已拷入 china/ 缓存"
  fi
  # a2) 直接就是 provinces/cities/districts 布局
  for sub in provinces cities districts; do
    if [ -d "$GEO_LOCAL_DIR/$sub" ]; then
      mkdir -p "$GEO_DIR/geodata/china"
      cp -rn "$GEO_LOCAL_DIR/$sub" "$GEO_DIR/geodata/china/" 2>/dev/null || cp -r "$GEO_LOCAL_DIR/$sub" "$GEO_DIR/geodata/china/"
      ok "  已拷入 $sub/"
    fi
  done
  # b) 散装 geojson/json/gpx → geodata 根（server 会扫描进 geodata-list）
  shopt -s nullglob
  loose=("$GEO_LOCAL_DIR"/*.geojson "$GEO_LOCAL_DIR"/*.json "$GEO_LOCAL_DIR"/*.gpx)
  if [ "${#loose[@]}" -gt 0 ]; then
    cp -n "${loose[@]}" "$GEO_DIR/geodata/" 2>/dev/null || cp "${loose[@]}" "$GEO_DIR/geodata/"
    ok "  已拷入 ${#loose[@]} 个散装数据文件"
  fi
  shopt -u nullglob
  # c) 前端边界文件
  if [ -d "$GEO_LOCAL_DIR/map-boundaries" ]; then
    mkdir -p "$GEO_DIR/map-boundaries"
    cp -rn "$GEO_LOCAL_DIR/map-boundaries/." "$GEO_DIR/map-boundaries/" 2>/dev/null || cp -r "$GEO_LOCAL_DIR/map-boundaries/." "$GEO_DIR/map-boundaries/"
    ok "  已拷入 map-boundaries/"
  fi
fi

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

# 确认可连
if have psql; then
  PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d Basemap -c "SELECT 1" >/dev/null 2>&1 \
    || warn "连不上 Basemap 库（$PGUSER@localhost）。若 postgis 阶段未跑，导入会失败"
fi

# ── 中国行政区划（阿里 DataV，脚本内离线优先）──
info "[1/2] 行政区划 → Basemap（阿里 DataV.GeoAtlas）..."
(cd "$GEO_DIR" && node import-datav.js 2>&1 | tail -8) \
  || warn "行政区划导入失败（可稍后手动: cd DMgeo && node import-datav.js）"

# ── 世界国界（Natural Earth，脚本内离线优先）──
info "[2/2] 世界国界 → Basemap（Natural Earth）..."
if [ -f "$GEO_DIR/import-world.js" ]; then
  (cd "$GEO_DIR" && node import-world.js 2>&1 | tail -5) \
    || warn "世界国界导入失败（可稍后手动: cd DMgeo && node import-world.js）"
fi

# ── 校验输出：数据真的进去了才准标记完成，否则阶段失败（不假完成）──
CNT=""
if have psql; then
  CNT=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d Basemap -tA \
    -c "SELECT (SELECT count(*) FROM provinces)||' / '||(SELECT count(*) FROM cities)||' / '||(SELECT count(*) FROM districts)" 2>/dev/null || echo "")
  [ -n "$CNT" ] && ok "Basemap 省/市/区 = $CNT"
fi

PROV_COUNT="${CNT%% *}"   # "34 / 400 / 2800" → "34"
if [ -z "$CNT" ] || [ "${PROV_COUNT:-0}" = "0" ]; then
  error "数据校验失败：Basemap 里没有省数据（连接不上或导入被上面 warn 吞掉）。postgis 阶段必须先成功——先跑 ./install.sh postgis 看清报错"
fi

[ -f "$GEO_DIR/map-boundaries/china-provinces.geojson" ] \
  && ok "前端底图已生成: map-boundaries/china-provinces.geojson" \
  || error "前端底图缺失（china-provinces.geojson），大屏仍会黑屏，请检查上面 import 日志"

mark_done "geodata"
ok "地图数据阶段完成"
