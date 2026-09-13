#!/usr/bin/env bash
# Teno Arch 包裝腳本 — pkg.tar.zst（經 deb 轉包）
# 用法：scripts/package-arch.sh
# 流程：package-linux.sh deb → 取最新 .deb → 對齊 ~/teno-arch/PKGBUILD 的 pkgver
#       → 拷 deb 進 teno-arch → makepkg -f → 印出安裝指令（sudo pacman -U 那步你自己跑）
# 注意：PKGBUILD 在 repo 外（~/teno-arch），不進版本庫。
set -euo pipefail
cd "$(dirname "$0")/.."

VER="$(node -p "require('./package.json').version")"
ARCHDIR="$HOME/teno-arch"

echo "== 1/4 確保 .deb 新鮮（跟 package.json $VER 對齊）"
DEB="$(ls -t src-tauri/target/release/bundle/deb/Teno_"$VER"_amd64.deb 2>/dev/null | head -1 || true)"
if [ -z "$DEB" ]; then
  echo "無 $VER 的 deb，先包一個…"
  ./scripts/package-linux.sh deb
  DEB="$(ls -t src-tauri/target/release/bundle/deb/Teno_"$VER"_amd64.deb 2>/dev/null | head -1 || true)"
fi
if [ -z "$DEB" ]; then echo "deb 仍未產出，請看上方 log" >&2; exit 1; fi
ls -la "$DEB"

echo "== 2/4 對齊 PKGBUILD pkgver=$VER"
sed -i "s/^pkgver=.*/pkgver=$VER/" "$ARCHDIR/PKGBUILD"
grep -n "^pkgver=" "$ARCHDIR/PKGBUILD"

echo "== 3/4 拷 deb → teno-arch → makepkg"
cp "$DEB" "$ARCHDIR/Teno_${VER}_amd64.deb"
(cd "$ARCHDIR" && rm -rf pkg src && makepkg -f)

echo "== 4/4 產物 =="
ls -la "$ARCHDIR"/teno-*.pkg.tar.zst | tail -3
echo "✅ Arch 包裝完成"
echo "安裝（你自己跑 sudo）：sudo pacman -U $ARCHDIR/teno-${VER}-1-x86_64.pkg.tar.zst"
