#!/bin/bash

echo "========================================"
echo "  DMChat 更新"
echo "========================================"

TARGET="$(cd "$(dirname "$0")" && pwd)"

if [ -n "$1" ]; then
  TARGET="$(cd "$1" 2>/dev/null && pwd || echo "$1")"
fi

if [ ! -f "$TARGET/server.js" ]; then
  echo ""
  echo "  ❌ 在 $TARGET 找不到 server.js"
  echo ""
  echo "  用法：把 update.sh 放到 DMChat 目录里，然后："
  echo "    cd ~/DMChat"
  echo "    bash update.sh"
  echo ""
  exit 1
fi

echo "[*] 目标: $TARGET"

# 备份
BACKUP="$TARGET/.backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP"
for f in "$TARGET"/*.js "$TARGET"/*.html; do
  [ -f "$f" ] && cp "$f" "$BACKUP/"
done
echo "[OK] 已备份到 $BACKUP"

# 更新
SRC="$(cd "$(dirname "$0")" && pwd)"
COPIED=0
for f in "$SRC"/*.js "$SRC"/*.html; do
  name=$(basename "$f")
  if [ "$name" = "update.sh" ] || [ "$name" = "install.sh" ]; then continue; fi
  if [ -f "$SRC/$name" ]; then
    cp "$SRC/$name" "$TARGET/$name"
    echo "  ✓ $name"
    COPIED=$((COPIED + 1))
  fi
done
echo ""
echo "[OK] 已更新 $COPIED 个文件"

# 重启
if command -v systemctl &>/dev/null && systemctl list-unit-files dm-chat.service &>/dev/null 2>&1; then
  echo "[*] systemd 重启..."
  systemctl restart dm-chat
  echo "[OK] 已重启"
else
  echo ""
  echo "  手动重启："
  echo "    cd $TARGET"
  echo "    pkill -f 'node server.js.*8083'"
  echo "    node server.js &"
fi

echo ""
echo "========================================"
echo "  更新完成！"
echo "========================================"
