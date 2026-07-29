#!/usr/bin/env bash
# 01-dm.sh — 只装 DM 核心（DMcore 控制台 + 统一代理 + 托管骨架）
# 一键安装时永远最先执行。装完即可打开控制台，其它服务可后装。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

step "1/1 · 安装 DM 核心 (DMcore)"

# —— 系统基础：supervisor / python3 / node（代理需要）——
if need_root_apt; then
  if ! have supervisord && ! have supervisorctl; then
    info "安装 supervisor ..."
    run_apt update -qq
    run_apt install -y -qq supervisor || warn "supervisor 安装失败，后续可按需托管"
  else
    ok "supervisor 已存在"
  fi

  if ! have python3; then
    info "安装 python3 ..."
    run_apt install -y -qq python3 python3-pip python3-venv || error "需要 python3"
  else
    ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
  fi

  if ! have node; then
    info "安装 nodejs（统一入口 proxy 依赖）..."
    run_apt install -y -qq nodejs npm 2>/dev/null \
      || run_apt install -y -qq nodejs 2>/dev/null \
      || warn "nodejs 安装失败：请手动安装后重跑 ./install.sh dm"
  else
    ok "node $(node -v 2>/dev/null || echo '?')"
  fi
else
  have python3 || error "未找到 python3"
  have node || warn "未找到 node，proxy 将不可用"
fi

# —— Python 依赖 ——
# Ubuntu 23.04+ 有 PEP 668 限制（externally-managed-environment），pip 直装会被拒。
# 策略：优先 apt 装 python3-flask（官方源，干净）；不行再 pip --break-system-packages 兜底。
info "安装 DMcore Python 依赖 ..."
if ! python3 -c "import flask" 2>/dev/null; then
  if need_root_apt; then
    run_apt install -y -qq python3-flask 2>/dev/null && ok "Flask 已由 apt 安装" || true
  fi
fi
if ! python3 -c "import flask" 2>/dev/null; then
  info "apt 路线不可用，尝试 pip（含 PEP 668 兼容）..."
  pip3 install -q --break-system-packages -r "$ROOT/DMcore/requirements.txt" 2>/dev/null \
    || python3 -m pip install -q --break-system-packages Flask 2>/dev/null \
    || pip3 install -q --user Flask 2>/dev/null \
    || pip3 install -q Flask 2>/dev/null \
    || warn "pip 安装失败，请确认 flask 可用: python3 -c 'import flask'"
fi
python3 -c "import flask" 2>/dev/null && ok "Flask 可用" || warn "Flask 未就绪（DMcore 控制台将起不来）"

# —— 配置与目录 ——
ensure_config_json
ensure_supervisord_conf
# 按当前机器实际路径生成各服务托管配置（修复换机/换目录后路径失效）
write_supervisor_programs

# 可执行权限
chmod +x "$ROOT/DMcore/run.sh" 2>/dev/null || true
find "$ROOT" -maxdepth 2 -name 'dmcore-start.sh' -exec chmod +x {} \; 2>/dev/null || true
chmod +x "$ROOT/install.sh" "$ROOT/install/"*.sh 2>/dev/null || true

# —— 可选：拉起 supervisord 空实例（不强制 start all）——
if have supervisord; then
  if [ ! -S "$SUP_DIR/supervisor.sock" ]; then
    info "启动 DMcore 独立 supervisord（空托管，按需 start 子服务）..."
    supervisord -c "$SUP_CONF" 2>/dev/null || true
    sleep 1
  else
    ok "supervisord 已在运行"
  fi
fi

# —— 启动 DM 控制台 + 代理 ——
start_dmcore_processes
sleep 1

# 健康检查（DMcore 是全家族入口，起不来必须立刻失败，不能假完成）
PORT="${DMCORE_PORT:-8088}"
sleep 2
if have curl; then
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 \
    || curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    ok "DMcore 响应正常 :${PORT}"
  else
    echo "—— /tmp/dmcore.log 尾部 ——"
    tail -15 /tmp/dmcore.log 2>/dev/null || echo "(无日志)"
    echo "———————————————"
    error "DMcore 未响应 :${PORT}（常见原因: Flask 未装上——Ubuntu 23.04+ 的 pip 有 PEP 668 限制，重跑 ./install.sh dm 会走 apt 路线）"
  fi
fi

mark_done "dm"
print_dm_banner
info "下一步可装:  postgis | apps | start | all"
info "  例: ./install.sh postgis   或  ./install.sh all"
