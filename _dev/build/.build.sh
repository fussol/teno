#!/bin/bash
# Build script: restores JS source, applies edits, builds binary + Arch pkg
set -e

TENO=/home/jupiter/下載/teno方案/2026.07.07/teno
BACKUP=/home/jupiter/下載/teno方案/2026.07.07/teno01.02.38

# Restore original source
rm -rf "$TENO/src"
cp -a "$BACKUP/src" "$TENO/src"

# Apply edits

# 1. Loop fix — strict due check
sed -i 's/if (nextDue <= now + this.learnAheadSecs \* 1000)/if (nextDue <= now)/' "$TENO/src/engine/session-v4.js"

# 2. Easter egg import in session-utils
sed -i "s/import { toast } from '\.\.\/main\.js';/import { toast } from '..\/main.js';\nimport { checkStudyMessages, checkMilestone, checkAchievement } from '..\/lib\/easter-eggs.js';/" "$TENO/src/engine/session-utils.js"

# 3. Easter egg hooks in rateCard
sed -i "/session.next();/a\  checkStudyMessages(session.results.length);\n  checkMilestone(session.results.length);\n  checkAchievement('first_review', 1, 'First Blood');\n  checkAchievement('speed_demon', 50, 'Speed Demon');\n  checkAchievement('persistent', 200, 'Persistent');" "$TENO/src/engine/session-utils.js"

# 4. Konami init in main.js
sed -i "s/renderAppShell();/import('.\/lib\/easter-eggs.js').then(m => m.initKonami());\n  renderAppShell();/" "$TENO/src/main.js"

# 5. easter-eggs.js (copy from save)
cp "$TENO/src/lib/easter-eggs.js" "$TENO/src/lib/easter-eggs.js.bak" 2>/dev/null || true

# 6. settings.js — theme chip inline style removed
sed -i 's/class="theme-chip ${s.state.themeAccent === item.id ? '\''selected'\'' : '\'''\''}" data-accent="${item.id}" style="display:flex;align-items:center;gap:var(--s1);padding:4px 10px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg-surface);cursor:pointer;font-size:12px;transition:all var(--t-fast)"/class="theme-chip ${s.state.themeAccent === item.id ? '\''selected'\'' : '\'''\''}" data-accent="${item.id}"/' "$TENO/src/pages/settings.js"

# 7. settings.js — accent range class
sed -i 's/id="accentIntensityRange" min=/id="accentIntensityRange" class="accent-range" min=/' "$TENO/src/pages/settings.js"

# 8. Build binary
cd "$TENO" && npx tauri build 2>&1 | tail -3

# 9. Create tarball with subdirectory
PKGVER=5.1.0
mkdir -p /tmp/teno-tar/teno-$PKGVER
cp "$TENO/src-tauri/target/release/teno" /tmp/teno-tar/teno-$PKGVER/
cp "$TENO/src-tauri/target/release/bundle/appimage/Teno.AppDir/usr/share/applications/Teno.desktop" /tmp/teno-tar/teno-$PKGVER/
cp "$TENO/src-tauri/icons/"*.png /tmp/teno-tar/teno-$PKGVER/
cd /tmp/teno-tar
tar czf "$TENO/teno-5.1.0.tar.gz" "teno-$PKGVER"/
rm -rf /tmp/teno-tar

# 10. Arch package
cd "$TENO"
rm -rf src pkg
makepkg -f --nodeps 2>&1 | tail -3
ls -lh teno-5.1.0-4-x86_64.pkg.tar.zst

# 11. Restore source again
rm -rf src
cp -a "$BACKUP/src" "$TENO/src"
echo "Done — source restored"
