#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# build-container.sh — Build Teno + piper tools inside Podman
# ═══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/dist"
PKGVER=5.1.0

echo "=== Teno: Building container image ==="
podman build -t teno-builder "$SCRIPT_DIR"

echo "=== Teno: Extracting package ==="
mkdir -p "$OUT_DIR/teno-$PKGVER"
CID=$(podman create teno-builder)
podman cp "$CID":/teno "$OUT_DIR/teno-$PKGVER/"
podman cp "$CID":/piper "$OUT_DIR/teno-$PKGVER/"
podman cp "$CID":/Teno.desktop "$OUT_DIR/teno-$PKGVER/"
for s in 32x32 128x128 128x128@2x; do
  podman cp "$CID":/${s}.png "$OUT_DIR/teno-$PKGVER/"
done
podman rm "$CID" > /dev/null

chmod +x "$OUT_DIR/teno-$PKGVER"/piper/{piper,piper_phonemize,espeak-ng}

echo "=== Teno: Creating tarball ==="
cd "$OUT_DIR"
tar czf "teno-$PKGVER.tar.gz" "teno-$PKGVER"/
rm -rf "teno-$PKGVER"

echo "=== Done: $OUT_DIR/teno-$PKGVER.tar.gz ==="
ls -lh "$OUT_DIR/teno-$PKGVER.tar.gz"
