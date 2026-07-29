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

# 临时后台起库做初始化，完成后停掉交给 supervisord 前台托管
pg_ctlcluster "$PGVER" main stop 2>/dev/null || true
pg_ctlcluster "$PGVER" main start
sleep 2

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
pg_ctlcluster "$PGVER" main stop 2>/dev/null || true

mark_done "postgis"
ok "PostGIS 阶段完成"
