#!/usr/bin/env bash
# Teno Android 包裝腳本 — apk / aab，各別可包（canonical release flow）
# 用法：scripts/package-android.sh [apk|aab|all|test] [--split-per-abi]
# 例：scripts/package-android.sh apk       → aarch64 APK（預設，最常用）
#     scripts/package-android.sh test      → 測試包（debug、com.teno.app.test、名稱「Teno 測試」
#                                             與主力包並存、系統不視為更新、資料沙箱分開）
#     scripts/package-android.sh aab       → AAB（丟 Play 商店用）
#     scripts/package-android.sh all       → APK + AAB 各一顆
# 流程：暫時清空 bundle.resources 的 piper（Android 用原生 TTS，打完自動還原）
#       → npx tauri android build --target aarch64（release，直接用 release keystore 簽）
#       → aapt / apksigner / dex 驗收 → sha256 → 收進 ~/teno-dist（canonical，唯一交付點）
# 交付：只放 ~/teno-dist（2026-09-26 定案）；不再複製到 ~/teno-webdav。
# 不跑 strip / zip -9 / debug 重簽名（舊 build-apk.sh 路線，已退役，會破壞對齊＋簽名衝突）。
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-apk}"
SPLIT=""
if [ "${2:-}" = "--split-per-abi" ]; then SPLIT="--split-per-abi"; fi
case "$TARGET" in
  apk|aab|all|test) ;;
  -h|--help|help)
    echo "用法：$0 [apk|aab|all|test] [--split-per-abi]（預設 apk）"
    exit 0 ;;
  *)
    echo "未知目標：$TARGET（可選 apk|aab|all|test）" >&2
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

# LLD-DGC1：cdylib 連結時 --gc-sections 把 97% 程式碼（含 generate_context! 內嵌的 40MB 前端資產）
# 當死碼丟掉 → .so 只剩 2.1MB 空殼、無 index.html、開機黑畫面。
# -Clink-dead-code=on ＝ --no-gc-sections，實測 .so 2.1MB→69MB、index.html 12 條。
# 必須連 tauri CLI 設的 3 個 link-arg 一起帶（RUSTFLAGS 一設就蓋掉 target.*.rustflags）。
export RUSTFLAGS="-Clink-dead-code=on -Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES"

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
elif [ "$TARGET" = "test" ]; then FLAGS="$FLAGS --apk --debug";
else FLAGS="$FLAGS --apk --aab"; fi
if [ -n "$SPLIT" ]; then FLAGS="$FLAGS --split-per-abi"; fi

echo "== tauri android build $FLAGS =="
OUTDIR=src-tauri/gen/android/app/build/outputs
# 清掉舊輸出：打包器可能不截斷直接覆寫 → 舊 zip 殘留把檔案撑大一倍（2026-09-30 實測 556MB）
rm -rf "$OUTDIR/apk"
# shellcheck disable=SC2086
npx tauri android build $FLAGS

VER="$(node -p "require('./package.json').version")"
echo "== 驗收 =="
DIST="$HOME/teno-dist"; mkdir -p "$DIST"
if [ "$TARGET" = "apk" ] || [ "$TARGET" = "all" ] || [ "$TARGET" = "test" ]; then
  if [ "$TARGET" = "test" ]; then
    APK="$OUTDIR/apk/universal/debug/app-universal-debug.apk"
  else
    APK="$OUTDIR/apk/universal/release/app-universal-release.apk"
  fi
  ls -la "$APK"
  # badging 只抓一次：grep -q 提早關管線會讓 aapt 吃 SIGPIPE，pipefail 下誤判失敗
  BADGING="$("$BT/aapt" dump badging "$APK")"
  echo "$BADGING" | grep -E "^package|application-label" | head -4
  # 殘留門：檔案大小必須≈zip 內容總和，多出來＝舊 zip 沒截斷的殘留（aapt/apksigner 都讀最後目錄，抓不到）
  python3 - "$APK" <<'EOF'
import sys, zipfile, os
p = sys.argv[1]; z = zipfile.ZipFile(p)
used = sum(i.compress_size for i in z.infolist())
disk = os.path.getsize(p)
over = disk - used - len(z.infolist()) * 200
if over > 1024 * 1024:
    print(f"❌ APK 含 {over} bytes 殘留（stale zip），拒絕交付", file=sys.stderr); sys.exit(1)
EOF
  if [ "$TARGET" = "test" ]; then
    # 安全門：測試包必須是獨立 app id（否則會覆蓋主力包＝這次需求的紅線）
    echo "$BADGING" | grep -q "name='com.teno.app.test'" \
      || { echo "❌ 測試包 package 不是 com.teno.app.test — 拒絕交付" >&2; exit 1; }
    echo "✅ 測試包 app id 門：com.teno.app.test（與主力 com.teno.app 並存）"
  fi
  "$BT/apksigner" verify --print-certs "$APK" 2>/dev/null | grep -E "DN:|CN=" | head -3
  unzip -o "$APK" "classes*.dex" -d /tmp/dexx >/dev/null
  echo -n "getPluginManager: "; strings /tmp/dexx/classes*.dex | grep -c getPluginManager
  # 統一產物夾：只留最新版（清掉 dist 內其他版本；測試包與主力包互不清）
  find "$DIST" -maxdepth 1 \( -name 'teno-v*.apk' -o -name 'teno-v*.apk.sha256' \) ! -name "*${VER}*" ! -name '*-test.apk*' -delete 2>/dev/null || true
  if [ "$TARGET" = "test" ]; then OUT="teno-v${VER}-test.apk"; else OUT="teno-v${VER}.apk"; fi
  cp "$APK" "$DIST/$OUT"
  (cd "$DIST" && sha256sum "$OUT" | tee "$OUT.sha256")
  ls -la "$DIST/$OUT" "$DIST/$OUT.sha256"
  # 交付：一律只放 ~/teno-dist（使用者 2026-09-26 定案）。
  # 舊的 WebDAV 鏡像（~/teno-webdav）已停用 —— 手機直接讀 ~/teno-dist 這顆。
fi
if [ "$TARGET" = "aab" ] || [ "$TARGET" = "all" ]; then
  find "$OUTDIR" -name "*.aab" | head -5
fi
echo "✅ Android 包裝完成（$TARGET）"
