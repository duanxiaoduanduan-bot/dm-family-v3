#!/usr/bin/env bash
# common/ports.sh — 端口管理
#   1. config.json(集中配置) > 2. 环境变量(PORT/FILE_PORT) > 3. 空闲端口探测
# 用法: resolve_port <config服务名> <config键名> <默认端口>
resolve_port() {
  local svc="${1:-}" key="${2:-port}" default="${3:-8080}"
  # 1) 环境变量已设 → 直接返回(最高优先)
  if [ "$key" = "port" ] && [ -n "${PORT:-}" ]; then echo "$PORT"; return; fi
  if [ "$key" = "files" ] && [ -n "${FILE_PORT:-}" ]; then echo "$FILE_PORT"; return; fi
  # 2) config.json 中查找
  local cf="$ROOT/config.json"
  if [ -f "$cf" ] && [ -n "$svc" ]; then
    local val=$(python3 -c "import json; d=json.load(open('$cf')); print(d.get('$svc',{}).get('$key',''))" 2>/dev/null || true)
    if [ -n "$val" ]; then echo "$val"; return; fi
  fi
  # 3) 空闲端口探测(从 default 开始)
  free_port "$default"
}

free_port() {
  local base="${1:-8080}" p="$1"
  while ss -tlnp 2>/dev/null | grep -qE "[:.]${p}([[:space:]]|$)"; do
    p=$((p + 1))
  done
  echo "$p"
}
