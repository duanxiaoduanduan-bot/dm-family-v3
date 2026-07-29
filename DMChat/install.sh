#!/bin/bash

echo "========================================"
echo "  DMChat 一键安装"
echo "  局域网多人聊天系统"
echo "========================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# === 检测环境 ===
IS_TERMUX=false
if [ -d /data/data/com.termux/files ]; then
  IS_TERMUX=true
  TMPDIR="$PREFIX/tmp"
  echo "[*] 检测到 Termux 环境"
else
  TMPDIR="/tmp"
  echo "[*] 检测到 Linux 环境"
fi

# === 1. Node.js ===
NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    echo "[OK] Node.js $(node -v)"
    NODE_BIN=$(which node)
  else
    NEED_NODE=true
  fi
else
  NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
  if $IS_TERMUX; then
    echo "[*] Termux 安装 Node.js..."
    pkg install nodejs -y
    NODE_BIN=$(which node)
  else
    # 离线包优先从脚本同级目录找
    NODE_PKG="$SCRIPT_DIR/node-v22.13.1-linux-x64.tar.xz"
    if [ -f "$NODE_PKG" ]; then
      echo "[*] 从离线包安装..."
      mkdir -p "$HOME/.local"
      tar -xf "$NODE_PKG" -C "$HOME/.local/"
      NODE_DIR="$HOME/.local/node-v22.13.1-linux-x64"
      NODE_BIN="$NODE_DIR/bin/node"
    else
      echo "[*] 在线安装..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
      NODE_BIN=$(which node)
    fi
  fi
  echo "[OK] Node.js $($NODE_BIN -v)"
fi

# === 2. 安装 ws 模块 ===
echo "[*] 安装依赖..."
cd "$SCRIPT_DIR"
if [ -f package.json ]; then
  npm install 2>/dev/null
else
  npm init -y 2>/dev/null
  npm install ws 2>/dev/null
fi
echo "[OK] 依赖安装完成"

# === 3. 启动服务 ===
echo "[*] 停止旧服务..."
pkill -f "node server.js.*8083" 2>/dev/null || true
sleep 1

echo "[*] 启动服务..."
cd "$SCRIPT_DIR"
nohup $NODE_BIN server.js > "$TMPDIR/dm-chat.log" 2>&1 &
sleep 2

# === 4. 开机自启 ===
if $IS_TERMUX; then
  if ! grep -q "DMChat" ~/.bashrc 2>/dev/null; then
    cat >> ~/.bashrc <<AUTOSTART

# === DMChat 开机自启 ===
DMCHAT_DIR="$SCRIPT_DIR"
if [ -d "\$DMCHAT_DIR" ]; then
  pkill -f "node server.js.*8083" 2>/dev/null
  cd "\$DMCHAT_DIR"
  nohup node server.js > \$PREFIX/tmp/dm-chat.log 2>&1 &
fi
AUTOSTART
    echo "[OK] 已设置开机自启（打开 Termux 自动启动）"
  fi
else
  cat > /etc/systemd/system/dm-chat.service <<SVC
[Unit]
Description=DMChat Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

  systemctl daemon-reload
  systemctl enable dm-chat
  echo "[OK] 已注册 systemd 开机自启"
fi

# === 5. 完成 ===
IP=""
if command -v hostname &>/dev/null; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$IP" ]; then
  IP=$(ip addr show 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}' | cut -d/ -f1)
fi
[ -z "$IP" ] && IP="你的IP"

echo ""
echo "========================================"
echo "  ✅ 安装完成！"
echo ""
echo "  💬 DMChat:  http://$IP:8083"
echo ""
if $IS_TERMUX; then
  echo "  下次打开 Termux 自动启动"
  echo "  手动重启: cd $SCRIPT_DIR && bash install.sh"
else
  echo "  常用命令:"
  echo "    systemctl status dm-chat"
  echo "    systemctl restart dm-chat"
fi
echo "========================================"
