#!/usr/bin/env bash
# install/common.sh — 各安装阶段共用
# shellcheck disable=SC2034

set -euo pipefail

# 由 install.sh 注入；单独 source 时自动推断
if [ -z "${ROOT:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export ROOT
INSTALL_DIR="${INSTALL_DIR:-$ROOT/install}"
SUP_DIR="${SUP_DIR:-$ROOT/DMcore/supervisor}"
SUP_CONF="${SUP_CONF:-$SUP_DIR/supervisord.conf}"
MARKER_DIR="${MARKER_DIR:-$ROOT/.dm-install}"

PGUSER="${PGUSER:-dmuser}"
PGPASS="${PGPASS:-dmpageo123}"

# ── 日志 ──
info()  { echo -e "\033[1;36m[install]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[  ok  ]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[ warn ]\033[0m $*" >&2; }
error() { echo -e "\033[1;31m[error ]\033[0m $*" >&2; exit 1; }
step()  { echo ""; echo -e "\033[1;35m▶ $*\033[0m"; echo "----------------------------------------"; }

have() { command -v "$1" &>/dev/null; }

need_root_apt() {
  if [ "$(id -u)" -ne 0 ] && ! have sudo; then
    warn "非 root 且无 sudo，跳过 apt 安装（请手动装好依赖）"
    return 1
  fi
  return 0
}

run_apt() {
  if [ "$(id -u)" -eq 0 ]; then
    apt-get "$@"
  else
    sudo apt-get "$@"
  fi
}

mark_done() {
  mkdir -p "$MARKER_DIR"
  date -Iseconds > "$MARKER_DIR/$1.done" 2>/dev/null || date > "$MARKER_DIR/$1.done"
}

is_done() {
  [ -f "$MARKER_DIR/$1.done" ]
}

# 自动检测 PostgreSQL 主版本号
detect_pgver() {
  local v=""
  if have pg_config; then
    v=$(pg_config --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  fi
  if [ -z "$v" ] && have apt-cache; then
    v=$(apt-cache search '^postgresql-[0-9]+$' 2>/dev/null | grep -oE 'postgresql-[0-9]+' | grep -oE '[0-9]+' | sort -nr | head -1 || true)
  fi
  echo "${v:-16}"
}

ensure_supervisord_conf() {
  mkdir -p "$SUP_DIR/programs" "$SUP_DIR/logs"
  if [ ! -f "$SUP_CONF" ]; then
    cat > "$SUP_CONF" << SUPCONF
[unix_http_server]
file=${SUP_DIR}/supervisor.sock

[supervisord]
logfile=${SUP_DIR}/supervisord.log
pidfile=${SUP_DIR}/supervisord.pid
nodaemon=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://${SUP_DIR}/supervisor.sock

[include]
files = ${SUP_DIR}/programs/*.conf
SUPCONF
    ok "已生成 $SUP_CONF"
  fi
}

# 按当前 ROOT 动态生成各服务的 supervisor program 配置
# （仓库里的 conf 不提交，避免写死绝对路径；换机器 clone 后由本函数重建）
write_supervisor_programs() {
  mkdir -p "$SUP_DIR/programs" "$SUP_DIR/logs"
  local node_bin
  node_bin="$(command -v node 2>/dev/null || echo /usr/bin/node)"

  # 服务名|目录|额外环境变量
  local specs=(
    "DMmedia|DMmedia|DM_PORT=\"8081\""
    "DMgeo|DMgeo|PGHOST=\"localhost\""
    "DMpageo|DMpageo|"
    "DMChat|DMChat|"
    "DMshow|DMshow|"
    "dm-postgis|dm-postgis|DM_PORT=\"5432\""
  )
  local entry name dir extra
  for entry in "${specs[@]}"; do
    IFS='|' read -r name dir extra <<< "$entry"
    [ -d "$ROOT/$dir" ] || continue
    cat > "$SUP_DIR/programs/dm-${name}.conf" <<PROGCONF
[program:dm-${name}]
command=bash dmcore-start.sh
directory=${ROOT}/${dir}
autostart=false
autorestart=true
startsecs=2
startretries=3
stopsignal=INT
stopwaitsecs=10
stopasgroup=true
killasgroup=true
stdout_logfile=${SUP_DIR}/logs/dm-${name}.log
stderr_logfile=${SUP_DIR}/logs/dm-${name}.log
redirect_stderr=true
environment=PATH="/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",NODE_BIN="${node_bin}",DMCORE_HOST="0.0.0.0"${extra:+,${extra}}
PROGCONF
  done
  ok "supervisor programs 已按当前路径生成: $SUP_DIR/programs/"
}

ensure_config_json() {
  if [ ! -f "$ROOT/config.json" ]; then
    cat > "$ROOT/config.json" << 'CFGJSON'
{
  "_comment": "dm-family 端口集中配置。改这里一处，各服务启动时自动应用。",
  "DMmedia": { "media": 8081, "files": 8087 },
  "DMgeo":   { "port": 8084 },
  "DMpageo": { "port": 8085 },
  "DMChat":  { "port": 8083 },
  "DMshow":  { "port": 8086 }
}
CFGJSON
    ok "已生成 config.json"
  fi
}

# 确保 DMcore 进程在跑（控制台 + 代理）
start_dmcore_processes() {
  local host="${DMCORE_HOST:-0.0.0.0}"
  local port="${DMCORE_PORT:-8088}"
  local proxy_port
  proxy_port=$(python3 -c "import json;print(json.load(open('$ROOT/DMcore/routes.json')).get('port',8080))" 2>/dev/null || echo 8080)

  mkdir -p /tmp
  # 控制台
  if ! pgrep -f "python3.*DMcore/app.py|python3 app.py" >/dev/null 2>&1; then
    # 更精确：在 DMcore 目录用环境变量启动
    if ! ss -tlnp 2>/dev/null | grep -qE "[:.]${port}([[:space:]]|$)"; then
      info "启动 DMcore 控制台 :${port} ..."
      (
        cd "$ROOT/DMcore"
        export DMCORE_PORT="$port" DMCORE_HOST="$host"
        nohup python3 app.py > /tmp/dmcore.log 2>&1 &
      )
      sleep 1
    fi
  fi

  # 统一入口代理
  if have node; then
    if ! ss -tlnp 2>/dev/null | grep -qE "[:.]${proxy_port}([[:space:]]|$)"; then
      info "启动统一入口代理 :${proxy_port} ..."
      (
        cd "$ROOT/DMcore"
        nohup node proxy.js > /tmp/dmcore-proxy.log 2>&1 &
      )
      sleep 1
    fi
  else
    warn "未找到 node，跳过 proxy.js（统一入口 :${proxy_port} 不可用）"
  fi
}

print_dm_banner() {
  local port="${DMCORE_PORT:-8088}"
  local proxy_port
  proxy_port=$(python3 -c "import json;print(json.load(open('$ROOT/DMcore/routes.json')).get('port',8080))" 2>/dev/null || echo 8080)
  echo ""
  echo "================================================"
  echo "  ✅ DM 核心已就绪"
  echo "================================================"
  echo "  🖥️  DMcore 控制台: http://127.0.0.1:${port}"
  echo "  🌐 统一入口代理:   http://127.0.0.1:${proxy_port}"
  echo "     /media /geo /pageo /chat /show /files"
  echo "================================================"
}
