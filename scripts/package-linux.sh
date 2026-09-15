#!/usr/bin/env bash
# Teno Linux 桌面包裝腳本 — deb / rpm / appimage，各別可包
# 用法：scripts/package-linux.sh [deb|rpm|appimage|all]
# 例：scripts/package-linux.sh deb     → 只包 .deb
#     scripts/package-linux.sh all     → deb + rpm + appimage 全包
# 底層：npm run tauri build -- --bundles <target>（release，piper 照常包）
# 注意：rpm 需要 rpmbuild（Arch/CachyOS：sudo pacman -S rpm-tools）；
#       缺工具時腳本會直接擋下，不會靜默出半成品。
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-all}"
case "$TARGET" in
  deb|rpm|appimage|all) ;;
  -h|--help|help)
    echo "用法：$0 [deb|rpm|appimage|all]（預設 all）"
    exit 0 ;;
  *)
    echo "未知目標：$TARGET（可選 deb|rpm|appimage|all）" >&2
    exit 1 ;;
esac

if [ "$TARGET" = "rpm" ] || [ "$TARGET" = "all" ]; then
  if ! command -v rpmbuild >/dev/null 2>&1; then
    echo "缺 rpmbuild：Arch/CachyOS 請先跑 sudo pacman -S rpm-tools" >&2
    exit 1
  fi
fi

echo "== 版本門 =="
node tools/verify-version-sync.mjs

echo "== tauri build --bundles $TARGET =="
if [ "$TARGET" = "all" ]; then
  npm run tauri build -- --bundles deb,rpm,appimage
else
  npm run tauri build -- --bundles "$TARGET"
fi

echo "== 產物 =="
ls -la src-tauri/target/release/bundle/ | head -20
VER="$(node -p "require('./package.json').version")"
# 統一產物夾：只留最新版（清掉 dist 內其他版本同型檔）
DIST="$HOME/teno-dist"; mkdir -p "$DIST"
find "$DIST" -maxdepth 1 \( -name 'Teno_*_amd64.deb' -o -name 'Teno_*_amd64.AppImage' -o -name '*.rpm' \) ! -name "*${VER}*" -delete 2>/dev/null || true
case "$TARGET" in
  deb)      cp -f src-tauri/target/release/bundle/deb/Teno_"$VER"_amd64.deb "$DIST/" 2>/dev/null || true ;;
  rpm)      cp -f src-tauri/target/release/bundle/rpm/*.rpm "$DIST/" 2>/dev/null || true ;;
  appimage) cp -f src-tauri/target/release/bundle/appimage/Teno_"$VER"_amd64.AppImage "$DIST/" 2>/dev/null || true ;;
  all)
    cp -f src-tauri/target/release/bundle/deb/Teno_"$VER"_amd64.deb "$DIST/" 2>/dev/null || true
    cp -f src-tauri/target/release/bundle/rpm/*.rpm "$DIST/" 2>/dev/null || true
    cp -f src-tauri/target/release/bundle/appimage/Teno_"$VER"_amd64.AppImage "$DIST/" 2>/dev/null || true
    ;;
esac
case "$TARGET" in
  deb)   ls -la "$DIST"/Teno_"$VER"_amd64.deb 2>/dev/null || ls -la src-tauri/target/release/bundle/deb/ | tail -5 ;;
  rpm)   ls -la "$DIST"/*.rpm 2>/dev/null | tail -5 || echo "（rpm 目錄未產出，請看上方 build log）" ;;
  appimage) ls -la "$DIST"/Teno_"$VER"_amd64.AppImage 2>/dev/null | tail -5 ;;
  all)
    ls -la "$DIST"/Teno_"$VER"_amd64.deb "$DIST"/*.rpm "$DIST"/Teno_"$VER"_amd64.AppImage 2>/dev/null | tail -10
    ;;
esac
echo "✅ Linux 包裝完成（$TARGET）→ $DIST"
