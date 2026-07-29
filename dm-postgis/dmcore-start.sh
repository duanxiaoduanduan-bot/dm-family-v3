#!/usr/bin/env bash
# dm-postgis 原生启动脚本（由 DMcore/supervisord 托管）
#
# 与原 Docker 版不同：这里直接在原生 Ubuntu 上运行 PostgreSQL + PostGIS，
# 不再依赖 docker compose 拉起容器。脚本以「前台方式」运行 postgres，
# 交由 supervisord 托管（崩溃自动重启、沙箱恢复后自动拉起）。
#
# 权限说明：操作集群与 su postgres 需要 root。supervisord 以普通用户
# 运行时，下面命令自动套 sudo（需要 NOPASSWD sudo，否则请在 root 下
# 运行 install.sh / supervisord）。
set -e

# root 直跑；非 root 走 sudo -n（免密检测，失败会打印明确原因）
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
  else
    echo "[dm-postgis] 需要 root 权限（sudo 免密不可用）。请用 root 运行 supervisord，" >&2
    echo "             或配置 NOPASSWD sudo 后重启本服务。" >&2
    exit 1
  fi
fi

# 自动检测本机已安装的 PostgreSQL 版本
if [ -z "${PGVER:-}" ]; then
  PGVER=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1 | grep -oP '\d+' | head -1)
  PGVER="${PGVER:-16}"
fi
CLUSTER=main
PGDATA="/var/lib/postgresql/${PGVER}/${CLUSTER}"
CONF="/etc/postgresql/${PGVER}/${CLUSTER}/postgresql.conf"
PGBIN="/usr/lib/postgresql/${PGVER}/bin"

# 1) 若集群尚未初始化（首次部署），创建它
if [ ! -d "$PGDATA" ]; then
    $SUDO pg_createcluster "${PGVER}" "${CLUSTER}" || true
fi

# 2) 停掉可能以「后台服务」方式已存在的实例，避免与下方前台 exec 抢 5432 端口
$SUDO pg_ctlcluster "${PGVER}" "${CLUSTER}" stop 2>/dev/null || true
sleep 1

# 3) 以前台方式运行 postgres，仅监听本地回环（DMgeo 通过 PGHOST=localhost 连接）
#    由 supervisord 持有该进程，退出/崩溃时自动拉起。
exec $SUDO su postgres -c "${PGBIN}/postgres \
    -D ${PGDATA} \
    -c config_file=${CONF} \
    -c listen_addresses=localhost \
    -c port=5432"
