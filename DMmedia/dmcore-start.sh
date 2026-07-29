#!/usr/bin/env bash
# DMmedia 启动：媒体主服务 + 网盘 | 端口来源: config.json > env > 空闲探测
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

source "$ROOT/common/ports.sh"
export PORT=$(resolve_port DMmedia media 8081)
export FILE_PORT=$(resolve_port DMmedia files 8087)

echo "[DMmedia] 媒体: $PORT  网盘: $FILE_PORT"

node -e "
const fs=require('fs'),path=require('path');
const f=path.join('$ROOT','ports.json');
let d={}; try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
d['DMmedia']={media:Number(process.env.PORT),files:Number(process.env.FILE_PORT)};
fs.writeFileSync(f,JSON.stringify(d,null,2));
" 2>/dev/null || true

"$NODE_BIN" server.js &
"$NODE_BIN" file-manager.js &
trap 'kill 0' EXIT INT TERM
wait
