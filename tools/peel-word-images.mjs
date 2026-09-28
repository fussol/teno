#!/usr/bin/env node
// peel-word-images.mjs — 把 word_images 裡沒 peel 過的 inline base64 blob
// 搬進 content-addressed media/ 目錄（sha1 優先寫入約定，與 addWordImage 生產路徑同狀態）。
//
// 安全設計（使用者要求：不搞壞、不迷路）：
//   1. --apply 拒在 App 執行中跑（無併發寫者）；預設 dry-run 只讀看計畫
//   2. 寫前整份備份 teno.db.bak-prepeel-<ts>（先 wal_checkpoint(TRUNCATE)）
//   3. 檔案先行：decode → sha1 → tmp 寫入 → 讀回位元組比對＋sha1 比對 → rename
//   4. DB 單一 transaction；UPDATE 帶原 data 比對（樂觀鎖），任一步失敗 rollback＋刪新檔
//   5. 提交後逐列複驗（sha1 對檔、位元組==原始 decode）＋ integrity_check；
//      複驗失敗 → 從備份整份還原 DB＋刪新檔（全復原）
//   6. 超 10MB 拒 peel 留 inline（media_get 同樣拒讀，inline 才顯示得出）
//   7. 讀路徑本身雙保險：sha1 缺檔回退 data（既有 MEDIAPEEL1 設計）
//
// 跑法：node tools/peel-word-images.mjs          # dry-run（只讀）
//       node tools/peel-word-images.mjs --apply  # 執行（App 要先關）
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const CFG = process.env.TENO_CFG || join(homedir(), '.config', 'com.teno.app');
const DB_PATH = join(CFG, 'teno.db');
const MEDIA = join(CFG, 'media');
const MAX = 10 * 1024 * 1024; // 與 media_store.rs 同守門

const die = (m) => { console.error('❌ ' + m); process.exit(1); };
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// ext_for_mime 同式（media_store.rs）
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

function parseDataUrl(s) {
  if (!s.startsWith('data:')) return null;
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = s.slice(0, comma), b64 = s.slice(comma + 1);
  if (!head.includes(';base64')) return null;
  const mime = head.slice(5).split(';')[0].toLowerCase();
  if (!mime.startsWith('image/')) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) return null;
  // 嚴格解碼驗證：重編碼必須與原串逐字相同（不可原樣 roundtrip = 拒）
  if (bytes.toString('base64') !== b64) return { bad: 'base64 無法原樣 roundtrip' };
  return { mime, bytes, b64 };
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const running = () => { try { execFileSync('pgrep', ['-x', 'teno'], { stdio: 'ignore' }); return true; } catch { return false; } };

if (APPLY && running()) die('Teno 正在執行——先關掉 App 再 --apply（防止併發寫+WAL 撕裂）');
if (!existsSync(DB_PATH)) die('找不到 ' + DB_PATH);

const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });
const rows = db.prepare(
  "SELECT id, word_id, filename, sha1, data FROM word_images WHERE data LIKE 'data:%' AND sha1 = '' ORDER BY id"
).all();

// ── 計畫（dry/apply 共用）──
const plan = [], skip = [];
for (const r of rows) {
  const p = parseDataUrl(r.data);
  if (!p) { skip.push([r.id, '非 data URL/解碼失敗']); continue; }
  if (p.bad) { skip.push([r.id, p.bad]); continue; }
  if (p.bytes.length > MAX) { skip.push([r.id, `超 10MB（${mb(p.bytes.length)}）留 inline`]); continue; }
  const ext = EXT[p.mime] || 'bin';
  plan.push({ id: r.id, word: r.word_id, fn: r.filename || '', mime: p.mime, ext,
    bytes: p.bytes, sha: sha1(p.bytes), size: p.bytes.length });
}
const totalBytes = plan.reduce((s, p) => s + p.size, 0);

console.log(`== peel 計畫（${APPLY ? 'APPLY' : 'DRY-RUN，加 --apply 執行'}）==`);
console.log(`候選 blob：${rows.length} 列 → peel ${plan.length}、跳過 ${skip.length}（${mb(totalBytes)} inline 將出庫）`);
for (const p of plan) console.log(`  #${p.id} ${p.ext.padEnd(4)} ${mb(p.size).padStart(7)}  ${p.fn}  → media/${p.sha}.${p.ext}`);
for (const [id, why] of skip) console.log(`  SKIP #${id}：${why}`);
if (!plan.length) { console.log('無可 peel 的列'); process.exit(0); }
if (!APPLY) { console.log('\n(dry-run 結束，未寫任何東西)'); process.exit(0); }

// ── APPLY ──
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const bak = `${DB_PATH}.bak-prepeel-${new Date().toISOString().replace(/[:.]/g, '-')}`;
db.close();
copyFileSync(DB_PATH, bak);
console.log(`\n備份 → ${bak}`);

const con = new DatabaseSync(DB_PATH);
const created = [];
let failed = null;
try {
  // 1) 檔案先行（content-addressed；已存在必驗等價）
  for (const p of plan) {
    const fp = join(MEDIA, `${p.sha}.${p.ext}`);
    if (existsSync(fp)) {
      if (!readFileSync(fp).equals(p.bytes)) throw new Error(`sha1 同名但內容不同（碰撞/損壞）：${fp}`);
      continue;
    }
    const tmp = fp + '.peel-tmp';
    writeFileSync(tmp, p.bytes);
    const back = readFileSync(tmp);
    if (!back.equals(p.bytes) || sha1(back) !== p.sha) { rmSync(tmp, { force: true }); throw new Error(`tmp 讀回比對失敗：${fp}`); }
    // 同批可能已有同 sha 的 tmp（重複內容）
    if (existsSync(fp)) { rmSync(tmp, { force: true }); continue; }
    renameSync(tmp, fp);
    created.push(fp);
  }
  // 2) DB 單一 transaction（樂觀鎖：原 data 必須逐字未動）
  con.exec('BEGIN IMMEDIATE');
  const upd = con.prepare("UPDATE word_images SET sha1 = ?, data = '' WHERE id = ? AND sha1 = '' AND data = ?");
  for (const p of plan) {
    const orig = rows.find(r => r.id === p.id).data;
    const res = upd.run(p.sha, p.id, orig);
    if (res.changes !== 1) throw new Error(`#${p.id} 列在計畫後被改動（changes=${res.changes}），中止`);
  }
  con.exec('COMMIT');
  // 3) 提交後逐列複驗（新鮮讀）
  for (const p of plan) {
    const r = con.prepare('SELECT sha1, data FROM word_images WHERE id = ?').get(p.id);
    if (r.sha1 !== p.sha) throw new Error(`#${p.id} sha1 未寫入`);
    if (r.data !== '') throw new Error(`#${p.id} data 未清空`);
    const fp = join(MEDIA, `${p.sha}.${p.ext}`);
    if (!existsSync(fp) || !readFileSync(fp).equals(p.bytes)) throw new Error(`#${p.id} media 檔缺失或位元組不符：${fp}`);
  }
  const ic = con.prepare('PRAGMA integrity_check').get();
  if ((ic.integrity_check || Object.values(ic)[0]) !== 'ok') throw new Error('integrity_check 不過：' + JSON.stringify(ic));
  const before = statSync(DB_PATH).size;
  con.exec('VACUUM');
  const after = statSync(DB_PATH).size;
  console.log(`✅ peel 完成：${plan.length} 列 → media/（新建 ${created.length} 檔）`);
  console.log(`   DB ${mb(before)} → ${mb(after)}（inline 出庫 ${mb(totalBytes)}）`);
  console.log(`   複驗：逐列 sha1/位元組/integrity_check 全過`);
  console.log(`   還原點：${bak}（確認圖都正常後可自行刪除）`);
} catch (e) {
  failed = e;
  try { con.exec('ROLLBACK'); } catch { /* 未在 txn */ }
  con.close();
  // 全復原：DB 從備份蓋回（App 關著，無其他寫者）＋刪本批新檔
  try { copyFileSync(bak, DB_PATH); rmSync(DB_PATH + '-wal', { force: true }); rmSync(DB_PATH + '-shm', { force: true }); } catch {}
  for (const f of created) rmSync(f, { force: true });
  console.error(`❌ ${e.message}`);
  console.error(`已全復原：DB 從備份蓋回、刪除新建 ${created.length} 檔——資料一字未動`);
  process.exit(1);
}
con.close();
