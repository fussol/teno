#!/bin/sh
set -e

BIN="/home/jupiter/下載/teno方案/2026.07.06/teno01.02.21/src-tauri/target/release/teno"
ICON="/home/jupiter/下載/teno方案/2026.07.06/teno01.02.21/src-tauri/icons/128x128.png"
DESKTOP="/home/jupiter/下載/teno方案/2026.07.06/teno01.02.21/Teno.desktop"

sudo install -Dm755 "$BIN" /usr/local/bin/teno
sudo install -Dm644 "$ICON" /usr/local/share/icons/hicolor/128x128/apps/teno.png
sudo install -Dm644 "$DESKTOP" /usr/local/share/applications/Teno.desktop

# update icon cache
sudo gtk-update-icon-cache -f /usr/local/share/icons/hicolor/ 2>/dev/null || true
sudo update-desktop-database /usr/local/share/applications/ 2>/dev/null || true

echo "Teno 已安裝至 /usr/local/bin/teno"
echo "可在應用程式選單中找到 Teno"
