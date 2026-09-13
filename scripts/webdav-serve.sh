#!/usr/bin/env bash
# Teno 本地雲 WebDAV 一鍵啟動
# 用法：./scripts/webdav-serve.sh [port] [user] [pass]
# 預設：port=8080 user=teno pass 由 $TENOWEBDAV_PASS 或互動輸入
# 空間：~/teno-webdav（即本地雲網路空間，teno.db 上傳到這）
set -euo pipefail
PORT="${1:-8080}"
USER="${2:-teno}"
PASS="${3:-${TENOWEBDAV_PASS:-}}"
if [ -z "$PASS" ]; then
  read -rsp "WebDAV 密碼（手機 App 填同一組）: " PASS; echo
fi
mkdir -p ~/teno-webdav
exec python3 "$(dirname "$0")/webdav-server.py" --dir ~/teno-webdav --port "$PORT" --user "$USER" --password "$PASS"
