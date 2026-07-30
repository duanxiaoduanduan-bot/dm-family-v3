#!/usr/bin/env bash
# DMChat 启动：实时对话 | 端口来源: config.json > env > 空闲探测
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

source "$ROOT/common/ports.sh"
export PORT=$(resolve_port DMChat port 8083)

echo "[DMChat] 端口: $PORT"

node -e "
const fs=require('fs'),path=require('path');
const f=path.join('$ROOT','ports.json');
let d={}; try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
d['DMChat']={port:Number(process.env.PORT)};
fs.writeFileSync(f,JSON.stringify(d,null,2));
" 2>/dev/null || true

# 确保自签 HTTPS 证书存在（屏幕共享/通话需要安全上下文；新机 clone 后也能自动补）
CERT_DIR="$SCRIPT_DIR/certs"
CERT_KEY="$CERT_DIR/dmchat.key"
CERT_CRT="$CERT_DIR/dmchat.crt"
if [ ! -f "$CERT_KEY" ] || [ ! -f "$CERT_CRT" ]; then
  mkdir -p "$CERT_DIR"
  CIP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$CIP" ] && CIP=$(ip addr show 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}' | cut -d/ -f1)
  [ -z "$CIP" ] && CIP="127.0.0.1"
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_KEY" -out "$CERT_CRT" -days 3650 \
      -subj "/CN=dmchat" -addext "subjectAltName=IP:$CIP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 \
      && echo "[DMChat] 已生成自签 HTTPS 证书 ($CIP)" \
      || echo "[DMChat] 警告: 证书生成失败，屏幕共享/通话将不可用"
  else
    echo "[DMChat] 警告: 未找到 openssl，屏幕共享/通话需 HTTPS"
  fi
fi

"$NODE_BIN" server.js
