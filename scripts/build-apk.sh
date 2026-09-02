#!/usr/bin/env bash
# Teno APK build — Android 不包 piper（用原生 TTS），其他發行版照常包 piper。
# 流程：暫時移除 tauri.conf.json 的 piper resources → build → 自動還原 conf
#      → strip debug symbols → zip -9 → zipalign → apksigner(debug) → split 9MB 段
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME=/home/jupiter/jdk21
export ANDROID_HOME=/home/jupiter/android-sdk
export ANDROID_SDK_ROOT=/home/jupiter/android-sdk
export ANDROID_NDK_HOME=/home/jupiter/android-sdk/ndk/27.0.12077973
NDK_BIN=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
RUSTUP_BIN=$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin
export PATH="$RUSTUP_BIN:$NDK_BIN:$JAVA_HOME/bin:$PATH"
BT="$ANDROID_HOME/build-tools/35.0.0"

CONF=src-tauri/tauri.conf.json
BAK=/tmp/tauri.conf.json.bak.$$
cp "$CONF" "$BAK"
restore() { cp "$BAK" "$CONF"; rm -f "$BAK"; }
trap restore EXIT

echo "== 1/6 暫時移除 piper resources（Android 用原生 TTS）"
python3 - "$CONF" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['bundle']['resources'] = []
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
EOF

echo "== 2/6 清除 gen/android 殘留 piper assets"
rm -rf src-tauri/gen/android/app/src/main/assets/resources/piper

echo "== 3/6 frontend build"
npm run build >/dev/null 2>&1

echo "== 4/6 tauri android build (debug, aarch64)"
npx tauri android build --debug --target aarch64 --apk

APK=src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
OUT=dist
mkdir -p "$OUT"

echo "== 5/6 strip + 重壓 + 簽名"
WORK=$(mktemp -d)
unzip -q "$APK" -d "$WORK/extracted"
"$NDK_BIN/llvm-strip" "$WORK/extracted/lib/arm64-v8a/libteno_lib.so"
(cd "$WORK/extracted" && zip -q -r -9 ../teno-9.apk .)
"$BT/zipalign" -f 4 "$WORK/teno-9.apk" "$WORK/teno-aligned.apk"
"$BT/apksigner" sign \
  --ks "$HOME/.android/debug.keystore" --ks-pass pass:android \
  --key-pass pass:android --ks-key-alias androiddebugkey \
  --out "$WORK/teno-final.apk" "$WORK/teno-aligned.apk" 2>/dev/null

echo "== 6/6 split 9MB 段 → $OUT/"
cp "$WORK/teno-final.apk" "$OUT/teno-$(date +%Y%m%d-%H%M).apk"
rm -f "$OUT"/teno.part*
split -b 9m -d -a 1 "$WORK/teno-final.apk" "$OUT/teno.part"
ls -la "$OUT"/teno.part*

echo
echo "✅ 完成！合併：cat teno.part0 teno.part1 > teno.apk"
echo "   原始 APK: $OUT/teno-$(date +%Y%m%d-%H%M).apk"
rm -rf "$WORK"
