#!/usr/bin/env bash
# 02-postgis.sh — PostgreSQL + PostGIS + 库表 +（可选）行政区划导入
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

step "安装 PostGIS / 空间库"

PGVER="$(detect_pgver)"
info "PostgreSQL 目标版本: $PGVER"

if need_root_apt; then
  if ! have pg_ctlcluster; then
    info "安装 PostgreSQL + PostGIS ..."
    run_apt update -qq
    run_apt install -y -qq postgresql "postgresql-${PGVER}-postgis-3" postgresql-contrib 2>/dev/null \
      || run_apt install -y -qq postgresql postgis postgresql-contrib \
      || error "PostgreSQL/PostGIS 安装失败"
  else
    ok "PostgreSQL 已安装"
  fi
else
  have pg_ctlcluster || have psql || error "未找到 PostgreSQL，请先安装"
fi

info "初始化集群(如需要) ..."
pg_createcluster "$PGVER" main 2>/dev/null || true

# 临时后台起库做初始化，完成后停掉交给 supervisord 前台托管。
# 注意幂等：apt 装完 PG 后集群常已自动运行，直接 start 会报 "already running"
# 触发 set -e 退出（Ubuntu 实测踩过）；且非 root 需要 sudo fallback。
pg_ctlcluster "$PGVER" main stop 2>/dev/null || sudo pg_ctlcluster "$PGVER" main stop 2>/dev/null || true
if ! pg_isready -q 2>/dev/null; then
  pg_ctlcluster "$PGVER" main start 2>/dev/null \
    || sudo pg_ctlcluster "$PGVER" main start 2>/dev/null \
    || true
  sleep 2
fi
pg_isready -q 2>/dev/null || pg_isready -h localhost -q 2>/dev/null \
  || error "PostgreSQL 未能就绪（pg_lsclusters 查看集群状态；可能端口被既有实例占用）"
ok "PostgreSQL 已就绪"

info "创建角色: $PGUSER ..."
su postgres -c "psql -c \"DO \\\$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PGUSER') THEN CREATE ROLE $PGUSER LOGIN PASSWORD '$PGPASS' CREATEDB; END IF; END \\\$\$;\"" 2>/dev/null \
  || sudo -u postgres psql -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PGUSER') THEN CREATE ROLE $PGUSER LOGIN PASSWORD '$PGPASS' CREATEDB; END IF; END \$\$;" 2>/dev/null \
  || warn "创建角色失败（可能已存在或无权限）"

for db in trip Basemap; do
  info "确保库: $db"
  su postgres -c "psql -c \"CREATE DATABASE \\\"$db\\\" OWNER $PGUSER\"" 2>/dev/null \
    || sudo -u postgres psql -c "CREATE DATABASE \"$db\" OWNER $PGUSER" 2>/dev/null \
    || true
  info "  postgis 扩展 → $db"
  PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d "$db" -c "CREATE EXTENSION IF NOT EXISTS postgis;" 2>/dev/null || true
done

info "创建 features 表 ..."
for db in trip Basemap; do
  PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d "$db" -v ON_ERROR_STOP=0 -c "
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      name TEXT,
      type TEXT DEFAULT 'point',
      geom geometry(Geometry,4326),
      properties JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING GIST (geom);
  " 2>/dev/null || true
done

# 注意：底图数据（行政区划/世界国界）导入已移至独立阶段 geodata（05-geodata.sh）。
# 原因：import 脚本依赖 DMgeo 的 pg 包，必须在 apps 阶段之后运行。
# 一键安装会自动接续执行；手动补数据: ./install.sh geodata

# 停集群，交给 dm-postgis / supervisord 前台
pg_ctlcluster "$PGVER" main stop 2>/dev/null || sudo pg_ctlcluster "$PGVER" main stop 2>/dev/null || true

# ── 结果校验：库必须真实存在且可连，否则失败（不假完成）──
pg_ctlcluster "$PGVER" main start 2>/dev/null || sudo pg_ctlcluster "$PGVER" main start 2>/dev/null || true
sleep 1
VERIFY=$(PGPASSWORD="$PGPASS" psql -h localhost -U "$PGUSER" -d Basemap -tA \
  -c "SELECT count(*) FROM pg_extension WHERE extname='postgis'" 2>/dev/null || echo "CONN_FAIL")
pg_ctlcluster "$PGVER" main stop 2>/dev/null || sudo pg_ctlcluster "$PGVER" main stop 2>/dev/null || true
if [ "$VERIFY" != "1" ]; then
  error "校验失败：Basemap 库连不上或 postgis 扩展缺失（上面步骤的失败被容错吞掉了）。请以 root/sudo 重跑: sudo ./install.sh postgis"
fi

mark_done "postgis"
ok "PostGIS 阶段完成（Basemap + postgis 扩展已验证）"
