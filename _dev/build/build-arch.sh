#!/bin/bash
set -e
TENO=/home/jupiter/下載/teno方案/2026.07.07/teno
BACKUP=/home/jupiter/下載/teno方案/2026.07.07/teno-edited

cp -a "$BACKUP" "$TENO/src"
cd "$TENO"
npx tauri build 2>&1 | tail -3
mkdir -p /tmp/teno-tar/teno-5.1.0
cp src-tauri/target/release/teno /tmp/teno-tar/teno-5.1.0/
cp src-tauri/target/release/bundle/appimage/Teno.AppDir/usr/share/applications/Teno.desktop /tmp/teno-tar/teno-5.1.0/
cp src-tauri/icons/*.png /tmp/teno-tar/teno-5.1.0/
cd /tmp/teno-tar && tar czf "$TENO/teno-5.1.0.tar.gz" teno-5.1.0/
rm -rf /tmp/teno-tar
cd "$TENO"
rm -rf src pkg
makepkg -f --nodeps 2>&1 | tail -3
cp -a "$BACKUP" "$TENO/src"
echo "Done: $(ls -lh teno-5.1.0-4-x86_64.pkg.tar.zst | awk '{print $5, $NF}')"
