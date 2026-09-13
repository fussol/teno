#!/usr/bin/env bash
# Teno 全發行版一鍵包裝 — 本機跑得出來的全部（deb + rpm + appimage + APK）
# 用法：scripts/package-all-local.sh [--skip-android|--skip-linux]
# Windows (msi/nsis) / macOS (dmg/app) 本機跑不出來，走 CI（.github/workflows，push v* tag 自動包）。
# AAB 不在預設內（Play 商店上架才要）：scripts/package-android.sh aab
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_ANDROID=0
SKIP_LINUX=0
for a in "$@"; do
  case "$a" in
    --skip-android) SKIP_ANDROID=1 ;;
    --skip-linux) SKIP_LINUX=1 ;;
    -h|--help|help) echo "用法：$0 [--skip-android|--skip-linux]"; exit 0 ;;
    *) echo "未知參數：$a" >&2; exit 1 ;;
  esac
done

if [ "$SKIP_LINUX" = "0" ]; then
  echo "########## Linux: deb + rpm + appimage ##########"
  ./scripts/package-linux.sh all
else
  echo "（跳過 Linux）"
fi

if [ "$SKIP_ANDROID" = "0" ]; then
  echo "########## Android: APK ##########"
  ./scripts/package-android.sh apk
else
  echo "（跳過 Android）"
fi

echo
echo "✅ 全部完成"
echo "  Linux: src-tauri/target/release/bundle/{deb,rpm,appimage}/"
VER="$(node -p "require('./package.json').version")"
echo "  APK:   \$HOME/teno-v${VER}.apk (+ .sha256)"
echo "  Arch:  scripts/package-arch.sh（另跑，需 sudo 安裝那步你自己來）"
