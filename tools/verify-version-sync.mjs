#!/usr/bin/env node
/**
 * verify-version-sync.mjs — 版本指紋一致性閘（法典・版本制定規範 機械實作）
 *
 * 檢查鏈（所有版本指紋點，2026-08-28 穷举）：
 *   [源] package.json.version ≡ src-tauri/tauri.conf.json.version ≡ Cargo.toml version
 *   [派生-建置] gen/android build.gradle.kts versionName ← tauri build 自動注入（不手改，不靜態查）
 *   [派生-UI] 設定→關於 pkg.version ← import package.json（vite build 打包，隨源自動）
 *   [派生-DB] PRAGMA user_version + settings.db_from_version/db_from_commit ← app 開機 stampDbVersion()
 *   本腳本查：源三檔全等（紅）＋ live DB 對拍（滯後=黃，倒退=紅）＋ buildHash 形態。
 *
 * 用法: node tools/verify-version-sync.mjs [--no-db] [--db <path>]
 * exit 0 = 綠/黃（黃僅提示）; exit 1 = 紅。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const red = [], yellow = [], green = [];

function readVer(p, re) {
  const m = readFileSync(path.join(root, p), 'utf8').match(re);
  return m ? m[1] : null;
}

// ── 1. 源三檔全等 ──
const pkgVer   = readVer('package.json',               /"version":\s*"([^"]+)"/);
const tauriVer = readVer('src-tauri/tauri.conf.json',  /"version":\s*"([^"]+)"/);
const cargoVer = readVer('src-tauri/Cargo.toml',       /^version\s*=\s*"([^"]+)"/m);
const trio = { 'package.json': pkgVer, 'tauri.conf.json': tauriVer, 'Cargo.toml': cargoVer };
const vals = Object.values(trio);
if (vals.every(v => v && v === pkgVer)) {
  green.push(`源三檔一致: ${pkgVer}`);
} else {
  red.push(`版本漂移: ${Object.entries(trio).map(([k, v]) => `${k}=${v ?? '<無>'}`).join('  ')}`);
}

// ── 2. 形態 ──
const m = String(pkgVer || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) red.push(`package.json version 非 X.Y.Z 格式: ${pkgVer}`);
const verInt = m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;

let pkg;
try { pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { pkg = {}; }
// 空字串＝出廠佔位（db.js 以 `|| null` 視同未寫），僅非空時驗形態
if (pkg.buildHash && !/^[0-9a-f]{7,40}$/.test(String(pkg.buildHash))) {
  red.push(`package.json buildHash 非 commit hash 形態: ${pkg.buildHash}`);
}

// ── 3. live DB 對拍（只讀；跳過=--no-db） ──
const argv = process.argv.slice(2);
if (!argv.includes('--no-db')) {
  const di = argv.indexOf('--db');
  const dbPath = di >= 0 ? argv[di + 1]
    : path.join(process.env.HOME || '/home/jupiter', '.config/com.teno.app/teno.db');
  if (existsSync(dbPath)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const cur = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
      if (cur === verInt) green.push(`DB user_version=${cur}（= ${pkgVer}）`);
      else if (cur < verInt) yellow.push(`DB user_version=${cur} < 期望 ${verInt} — 下次開 app 自動補章（剛升版屬正常）`);
      else red.push(`DB 版本倒退: user_version=${cur} > 代碼 ${verInt} — 代碼比 DB 舊，違「只升不降」`);
      try {
        const r = db.prepare("SELECT value FROM settings WHERE key='db_from_version'").get();
        if (r && cur === verInt && r.value !== pkgVer) yellow.push(`db_from_version=${r.value} ≠ ${pkgVer}（同值指紋應同期，開 app 刷新）`);
        else if (r) green.push(`db_from_version=${r.value}`);
      } catch { /* settings 表舊檔無此鍵 — 開 app 補 */ }
      db.close();
    } catch (e) {
      yellow.push(`DB 讀取失敗略過: ${e.message}`);
    }
  } else {
    yellow.push(`DB 不存在（${dbPath}），跳過 DB 對拍`);
  }
}

// ── 報告 ──
for (const g of green)  console.log(`  ✅ ${g}`);
for (const w of yellow) console.log(`  🟡 ${w}`);
for (const r of red)    console.log(`  ❌ ${r}`);
if (red.length) { console.log(`VERIFY-VERSION-SYNC: FAIL (${red.length} red)`); process.exit(1); }
console.log(`VERIFY-VERSION-SYNC: PASS (${green.length} green, ${yellow.length} yellow)`);
