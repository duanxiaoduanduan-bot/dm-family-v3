#!/usr/bin/env bash
# DMpageo 启动：合并门户 | 端口来源: config.json > env > 空闲探测
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

source "$ROOT/common/ports.sh"
export PORT=$(resolve_port DMpageo port 8085)

echo "[DMpageo] 门户端口: $PORT"

node -e "
const fs=require('fs'),path=require('path');
const f=path.join('$ROOT','ports.json');
let d={}; try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
d['DMpageo']={port:Number(process.env.PORT)};
fs.writeFileSync(f,JSON.stringify(d,null,2));
" 2>/dev/null || true

"$NODE_BIN" portal.js
