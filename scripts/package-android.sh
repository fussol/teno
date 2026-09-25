#!/usr/bin/env bash
# Teno Android 包裝腳本 — apk / aab，各別可包（canonical release flow）
# 用法：scripts/package-android.sh [apk|aab|all] [--split-per-abi]
# 例：scripts/package-android.sh apk       → aarch64 APK（預設，最常用）
#     scripts/package-android.sh aab       → AAB（丟 Play 商店用）
#     scripts/package-android.sh all       → APK + AAB 各一顆
# 流程：暫時清空 bundle.resources 的 piper（Android 用原生 TTS，打完自動還原）
#       → npx tauri android build --target aarch64（release，直接用 release keystore 簽）
#       → aapt / apksigner / dex 驗收 → sha256 → 收進 ~/teno-dist（canonical）
#       → 另複製一顆到 ~/teno-webdav（手機交付鏡像；伺服器防 symlink 故只能實體複製）
# 不跑 strip / zip -9 / debug 重簽名（舊 build-apk.sh 路線，已退役，會破壞對齊＋簽名衝突）。
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-apk}"
SPLIT=""
if [ "${2:-}" = "--split-per-abi" ]; then SPLIT="--split-per-abi"; fi
case "$TARGET" in
  apk|aab|all) ;;
  -h|--help|help)
    echo "用法：$0 [apk|aab|all] [--split-per-abi]（預設 apk）"
    exit 0 ;;
  *)
    echo "未知目標：$TARGET（可選 apk|aab|all）" >&2
    exit 1 ;;
esac

export JAVA_HOME=/home/jupiter/jdk21
export ANDROID_HOME=/home/jupiter/android-sdk
export ANDROID_SDK_ROOT=/home/jupiter/android-sdk
export ANDROID_NDK_HOME=/home/jupiter/android-sdk/ndk/27.0.12077973
NDK_BIN=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
RUSTUP_BIN=$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin
export PATH="$RUSTUP_BIN:$NDK_BIN:$JAVA_HOME/bin:$PATH"
BT="$ANDROID_HOME/build-tools/35.0.0"

echo "== 版本門 =="
node tools/verify-version-sync.mjs

CONF=src-tauri/tauri.conf.json
BAK=/tmp/tauri.conf.json.bak.$$
cp "$CONF" "$BAK"
restore() { cp "$BAK" "$CONF"; rm -f "$BAK"; }
trap restore EXIT

echo "== 暫時移除 piper resources（Android 用原生 TTS，打完自動還原）"
python3 - "$CONF" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['bundle']['resources'] = []
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
EOF
rm -rf src-tauri/gen/android/app/src/main/assets/resources/piper

FLAGS="--target aarch64"
if [ "$TARGET" = "apk" ]; then FLAGS="$FLAGS --apk";
elif [ "$TARGET" = "aab" ]; then FLAGS="$FLAGS --aab";
else FLAGS="$FLAGS --apk --aab"; fi
if [ -n "$SPLIT" ]; then FLAGS="$FLAGS --split-per-abi"; fi

echo "== tauri android build $FLAGS =="
# shellcheck disable=SC2086
npx tauri android build $FLAGS

OUTDIR=src-tauri/gen/android/app/build/outputs
VER="$(node -p "require('./package.json').version")"
echo "== 驗收 =="
DIST="$HOME/teno-dist"; mkdir -p "$DIST"
if [ "$TARGET" = "apk" ] || [ "$TARGET" = "all" ]; then
  APK="$OUTDIR/apk/universal/release/app-universal-release.apk"
  ls -la "$APK"
  "$BT/aapt" dump badging "$APK" | grep -E "^package" | head -2
  "$BT/apksigner" verify --print-certs "$APK" 2>/dev/null | grep -E "DN:|CN=" | head -3
  unzip -o "$APK" "classes*.dex" -d /tmp/dexx >/dev/null
  echo -n "getPluginManager: "; strings /tmp/dexx/classes*.dex | grep -c getPluginManager
  # 統一產物夾：只留最新版（清掉 dist 內其他版本）
  find "$DIST" -maxdepth 1 \( -name 'teno-v*.apk' -o -name 'teno-v*.apk.sha256' \) ! -name "*${VER}*" -delete 2>/dev/null || true
  cp "$APK" "$DIST/teno-v${VER}.apk"
  (cd "$DIST" && sha256sum "teno-v${VER}.apk" | tee "teno-v${VER}.apk.sha256")
  ls -la "$DIST/teno-v${VER}.apk" "$DIST/teno-v${VER}.apk.sha256"
  # 手機交付：WebDAV 空間。伺服器根目錄硬編碼 ~/teno-webdav，且 resolve_fs_path
  # 明文防 symlink 逃逸（webdav_serve.rs:299）→ 不能用連結，只能實體複製這一顆。
  # canonical 仍以 ~/teno-dist 為準，這裡只是給手機讀的鏡像。
  if [ -d "$HOME/teno-webdav" ]; then
    cp -f "$APK" "$HOME/teno-webdav/teno-v${VER}.apk"
    (cd "$HOME/teno-webdav" && sha256sum "teno-v${VER}.apk" > "teno-v${VER}.apk.sha256")
    find "$HOME/teno-webdav" -maxdepth 1 \( -name 'teno-v*.apk' -o -name 'teno-v*.apk.sha256' \) \
      ! -name "*${VER}*" -delete 2>/dev/null || true
    echo "交付鏡像：~/teno-webdav/teno-v${VER}.apk（手機讀這顆）"
  fi
fi
if [ "$TARGET" = "aab" ] || [ "$TARGET" = "all" ]; then
  find "$OUTDIR" -name "*.aab" | head -5
fi
echo "✅ Android 包裝完成（$TARGET）"
