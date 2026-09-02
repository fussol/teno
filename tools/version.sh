#!/usr/bin/env bash
# Bump version: ./tools/version.sh [patch|minor|major|X.Y.Z]
# 唯一升版路徑（法典・版本制定規範）：一次寫入 package.json + tauri.conf.json + Cargo.toml。
# v2：以 package.json 為讀取源（舊版讀 Cargo.toml，三檔漂移時 tauri.conf sed 靜默跳過 → 指紋分裂病根）；
#     收尾自我驗證三檔一致＋跑 verify-version-sync.mjs，未過不落盤。
set -e
cd "$(dirname "$0")/.."

OLD=$(grep -m1 '"version"' package.json | sed 's/.*"version": "\([^"]*\)".*/\1/')
if [ -z "$1" ]; then
  echo "Current: $OLD"
  echo "Usage: ./tools/version.sh patch|minor|major|X.Y.Z"
  exit 0
fi

if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$1"
else
  IFS='.' read -r major minor patch <<< "$OLD"
  case "$1" in
    major) ((major++)); minor=0; patch=0 ;;
    minor) ((minor++)); patch=0 ;;
    patch) ((patch++)) ;;
    *) echo "Invalid: $1"; exit 1 ;;
  esac
  NEW="$major.$minor.$patch"
fi

echo "Bump: $OLD → $NEW"

# 三檔各自 first-match 置換（錨定 version 鍵，不依賴舊值 → 已漂移也能一刀歸一）
sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$NEW\"/" package.json
sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"$NEW\"/" src-tauri/tauri.conf.json
sed -i "0,/^version = \"[^\"]*\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml

# 落盤後自我驗證：三檔必須全等 NEW
for f in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml; do
  if [ "$f" = "src-tauri/Cargo.toml" ]; then
    v=$(grep -m1 '^version = ' "$f" | sed 's/.*"\(.*\)".*/\1/')
  else
    v=$(grep -m1 '"version"' "$f" | sed 's/.*"version": "\([^"]*\)".*/\1/')
  fi
  if [ "$v" != "$NEW" ]; then
    echo "❌ $f 未同步（got: ${v:-<none>}，expect: $NEW）— bump 中止"
    exit 1
  fi
done

node tools/verify-version-sync.mjs --no-db
echo "Done. 提交：git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml <code files> && git commit -m '...' && git tag v$NEW"
