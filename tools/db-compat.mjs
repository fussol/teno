#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// db-compat.mjs — Teno DB 向下／向上相容工具
//
// 背景：舊庫（5.9.x，migrations 只到 v10）的 words 表早被舊版 JS 逐欄補過
// synonym/antonym，新版 migrator v13 原樣重放即 `duplicate column` 熔斷，
// 表現為「匯入舊備份失敗／舊庫升級卡死」。實錘：~/下載/teno-backup (15).db
// （TENOC v1，4934 詞）重放 v11→v14，v13 必炸。
//
// 反向問題：sqlx migrator 會校驗已套用版本（VersionMissing），新庫
// （登記到 v14）直接拿給只認 v1..v10 的舊版開，會拒絕啟動。所以降級必須
// 同時剝 schema＋修剪 _sqlx_migrations。
//
// 用法：
//   node tools/db-compat.mjs inspect <檔案>
//     TENOC 或裸 sqlite：magic、integrity、表、筆數、欄位、已登記 migrations、
//     user_version、db_from_version、相對現行 lib.rs 的待跑版本。
//   node tools/db-compat.mjs fingerprint <檔案> [--json]
//     指紋→路由：ok（直通）／repair-v14（本版修復工具）／manual（人工）。
//   node tools/db-compat.mjs prepare-import <來源> --out <輸出>
//     指紋→路由→修復→可匯入檔（一條龍；ok 直通，repair-v14 自動修，manual 拒絕）。
//   node tools/db-compat.mjs repair <來源> --out <輸出>
//     舊→新：冪等重放 v1..v14（duplicate column / already exists 視為已套用），
//     逐版登記（含 SHA-384 checksum，與 sqlx Migration::new 同算法），
//     integrity＋筆數守門後以 TENOC v1 重包（log 段原樣透傳）。
//   node tools/db-compat.mjs downgrade <來源> --target <10..13> --out <輸出>
//     新→舊：逆序剝掉高於 target 的 schema 效果＋刪除對應登記列，VACUUM＋
//     integrity＋筆數守門後重包。--out 必填且不得與來源同檔（防原地炸檔）。
//     資料遺失警告：v13 五欄內容、word_images 全表、decks.new_weight 會丟失。
//
// 原則：
//   - SQL 一律從 src-tauri/src/lib.rs 現場抽取（V13_SQL/V13_DESC const＋各版
//     migration 字面量），拒絕手抄道德式測試；checksum＝SHA-384(SQL 原文)。
//   - repair/downgrade 一律寫新檔；overwrite 來源必須顯式 --in-place（repair 專用）。
//   - 任何 integrity_check != ok 直接中止，不寫輸出。
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB_RS = join(ROOT, 'src-tauri/src/lib.rs');
const CURRENT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const MIN_DOWNGRADE_TARGET = 10;

// ─── lib.rs 抽 SQL ───
function loadMigrations() {
  const rs = readFileSync(LIB_RS, 'utf8');
  const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const v13sql = rs.match(/const V13_SQL: &str = "(.*?)";/s)?.[1];
  const v13desc = rs.match(/const V13_DESC: &str =\s*"(.*?)";/s)?.[1];
  if (!v13sql || !v13desc) throw new Error('抽不出 V13_SQL/V13_DESC（lib.rs 結構變了，先修工具再跑）');
  const v1sql = rs.match(/const V1_SQL: &str = "(.*?)";/s)?.[1];
  const v1desc = rs.match(/const V1_DESC: &str =\s*"(.*?)";/s)?.[1];
  const get = (ver) => {
    const m = rs.match(new RegExp(`version: ${ver},[\\s\\S]*?sql: ([\\s\\S]*?),\\s*kind: MigrationKind::Up`));
    if (!m) throw new Error(`抽不出 migration v${ver}`);
    let expr = m[1].trim();
    if (expr === 'V13_SQL') return { sql: unesc(v13sql), desc: v13desc };
    if (expr === 'V1_SQL') {
      if (!v1sql || !v1desc) throw new Error('抽不出 V1_SQL/V1_DESC，先修工具');
      return { sql: unesc(v1sql), desc: v1desc };
    }
    const lit = expr.match(/^"(.*)"$/s)?.[1];
    if (lit == null) throw new Error(`migration v${ver} 的 sql 不是字面量（改用變數了，先修工具）`);
    const dm = m[0].match(/description: "(.*?)"/s);
    return { sql: unesc(lit), desc: dm?.[1] ?? '' };
  };
  const out = {};
  for (const v of CURRENT_VERSIONS) out[v] = get(v);
  // 衛生檢查：SQL 不該含反斜槓轉義（有＝抽取語意可能漂移）
  for (const v of CURRENT_VERSIONS) {
    if (/\\[nrt"\\]/.test(out[v].sql)) throw new Error(`migration v${v} 含轉義序列，抽取可能失真，先人工確認`);
  }
  return out;
}
const sha384 = (s) => createHash('sha384').update(s, 'utf8').digest();

// 按語句切分（識別 '' 跳脫單引號）
function splitStmts(sql) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") { q = !q; cur += ch; continue; }
    if (ch === ';' && !q) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const isBenignErr = (e) => /duplicate column|already exists/i.test(String(e?.message || e));

// v1 語意基線（核對用，非 SQL 全文——v1 全文含 `//` 行內註解，SQLite 重放必炸，
// 故 v1 只做「驗證＋補 index＋重蓋 checksum」，絕不重放）。
// 來源：src-tauri/src/lib.rs migration v1（表名＋index 名，穩定識別符）。
const V1_TABLES = ['words', 'cards', 'decks', 'folders', 'additions', 'edits', 'review_log', 'exam_history', 'settings', 'goal_streak'];
const V1_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due)',
  'CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state)',
  'CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck)',
  'CREATE INDEX IF NOT EXISTS idx_review_log_word ON review_log(word_id)',
  'CREATE INDEX IF NOT EXISTS idx_review_log_time ON review_log(reviewed_at)',
];

// ─── TENOC 容器（與 Rust／cli.mjs 同格式）───
function unpackFile(buf) {
  if (buf.length >= 6 && buf.subarray(0, 5).toString('latin1') === 'TENOC') {
    if (buf[5] !== 1) throw new Error(`容器版本不支援: v${buf[5]}（僅支援 v1）`);
    let pos = 6;
    const l1 = buf.readUInt32LE(pos); pos += 4;
    if (buf.length < pos + l1) throw new Error('容器損壞: teno.db 段截斷');
    const teno = buf.subarray(pos, pos + l1); pos += l1;
    if (buf.length < pos + 4) throw new Error('容器損壞: 缺少 app-log 長度欄位');
    const l2 = buf.readUInt32LE(pos); pos += 4;
    if (buf.length < pos + l2) throw new Error('容器損壞: app-log.db 段截斷');
    const log = buf.subarray(pos, pos + l2); pos += l2;
    if (pos !== buf.length) throw new Error(`容器損壞: 尾部有多餘資料（${buf.length - pos} bytes）`);
    return { kind: 'tenoc', teno, log: l2 ? log : null };
  }
  return { kind: 'raw', teno: buf, log: null };
}
function packTenoc(teno, log) {
  const head = Buffer.concat([Buffer.from('TENOC'), Buffer.from([1])]);
  const l1 = Buffer.alloc(4); l1.writeUInt32LE(teno.length);
  const l2 = Buffer.alloc(4); l2.writeUInt32LE(log?.length ?? 0);
  return Buffer.concat([head, l1, teno, l2, log ?? Buffer.alloc(0)]);
}
const isSqlite = (b) => Buffer.isBuffer(b) && b.length >= 100 && b.subarray(0, 16).toString('latin1') === 'SQLite format 3\0';

// ─── checksum 對帳（模擬 sqlx Migrator::run 的 gate）───
// 回傳 { ok, mismatched: [{version, stored, current}], pending: [...] }。
// sqlx 行為：已登記版本 checksum 不符 → VersionMismatch 即死；未登記 → 依序跑。
function auditChecksums(db, MIGS) {
  let rows;
  try { rows = db.prepare('SELECT version, checksum FROM _sqlx_migrations').all(); }
  catch { return { ok: false, reason: 'no-table', mismatched: [], pending: [...CURRENT_VERSIONS] }; }
  const recorded = new Map(rows.map(r => [r.version, Buffer.from(r.checksum)]));
  const mismatched = [];
  for (const [v, sum] of recorded) {
    if (!MIGS[v]) continue; // 未知版本（比現行新）：downgrade 會處理，這裡只記錄
    if (!sum.equals(sha384(MIGS[v].sql))) mismatched.push(v);
  }
  const pending = CURRENT_VERSIONS.filter(v => !recorded.has(v));
  return { ok: mismatched.length === 0, mismatched, pending, recorded };
}

// v1 指紋重蓋：語意驗證（十表齊＋index 補齊）後 UPDATE checksum。
// 前提：v1 全文不可重放（含 `//` 註解，SQLite 必炸），故只驗證不重放。
function restampV1(db, MIGS) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const missing = V1_TABLES.filter(t => !tables.has(t));
  if (missing.length) throw new Error(`v1 語意不齊（缺表 ${missing.join(',')}），拒絕重蓋指紋（需人工處理）`);
  for (const st of V1_INDEXES) db.exec(st);
  db.prepare('UPDATE _sqlx_migrations SET checksum = ?, success = 1 WHERE version = 1')
    .run(sha384(MIGS[1].sql));
}

// ─── 修復工具註冊表（版本→修復函式）：目前只有這一版（v1..v14 / app 5.16.11）。
// 改版時加新條目（例如 v15），routeFor() 按指紋分派；舊條目保留不刪。
// 修復函式簽名：(src, dst) => { log: string[], after: snapshot }（失敗拋錯）。
const REPAIR_TOOLS = {
  'v14': { app: '5.16.11', versions: [...CURRENT_VERSIONS], fn: (...a) => repairToFile(...a) },
};

// ─── 指紋：讀檔→拆容器→快照→對帳，一包結構化結果（拋錯＝讀不動）───
function fingerprintFile(file) {
  if (!existsSync(file)) throw new Error(`找不到檔案: ${file}`);
  const MIGS = loadMigrations();
  const raw = readFileSync(file);
  const u = unpackFile(raw);
  if (!isSqlite(u.teno)) throw new Error('teno 段不是 SQLite（magic 不符）');
  return withTempDb(u.teno, (db) => {
    const s = snapshot(db);
    if (s.integrity !== 'ok') {
      return { file, kind: u.kind, ...s, route: 'manual', reason: 'integrity 非 ok（本工具不救壞檔）' };
    }
    if (!s.migs) {
      return { file, kind: u.kind, ...s, route: 'manual', reason: '無 _sqlx_migrations 表（需人工確認血統）' };
    }
    const audit = auditChecksums(db, MIGS);
    const failed = db.prepare('SELECT version FROM _sqlx_migrations WHERE success = 0').all().map(r => r.version);
    const extra = s.migs.filter(v => !CURRENT_VERSIONS.includes(v));
    const bad = audit.mismatched.filter(v => s.migs.includes(v));
    const v13cols = ['etymology', 'syllables', 'phrases', 'synonym', 'antonym'];
    const v13has = v13cols.filter(c => s.wordsCols.includes(c));
    const v13gap = !s.migs.includes(13) && v13has.length > 0;
    let route = 'ok', reason = '已到頂且指紋全對，新版 migrator no-op';
    if (failed.length) { route = 'manual'; reason = `success=0 殘留（v${failed.join(',v')}），上次遷移死一半`; }
    else if (extra.length) { route = 'manual'; reason = `登記了比現行新的版本 [${extra}]（需對應新版修復工具）`; }
    else if (bad.length && !bad.every(v => v === 1)) { route = 'manual'; reason = `v${bad.join(',v')} 指紋不符且非 v1（不敢自動重蓋）`; }
    else if (bad.length || audit.pending.length || v13gap) { route = 'repair-v14'; reason = '舊血統（v1 指紋／待跑／v13 欄缺口），本版修復工具可修'; }
    return {
      file, kind: u.kind, integrity: s.integrity, words: s.words, cards: s.cards, decks: s.decks,
      wordsCols: s.wordsCols, decksCols: s.decksCols, migs: s.migs,
      mismatched: bad, pending: audit.pending, extra, v13gap,
      userVersion: s.userVersion, dbFromVersion: s.dbFromVersion,
      route, reason, repairApp: route === 'repair-v14' ? REPAIR_TOOLS['v14'].app : null,
    };
  });
}

// ─── prepare-import：指紋→路由→修復→可匯入檔（一條龍，給匯入鏈用）───
function prepareImportFile(src, dst) {
  const fp = fingerprintFile(src);
  if (fp.route === 'ok') {
    const raw = readFileSync(src);
    const u = unpackFile(raw); // 已驗過，這裡只為透傳 log 段
    writeFileSync(dst, packTenoc(Buffer.from(u.teno), u.log));
    return { fp, repaired: false, dst, log: ['指紋全對，直通無需修復'] };
  }
  if (fp.route === 'repair-v14') {
    const r = repairToFile(src, dst);
    return { fp, repaired: true, dst, log: r.log };
  }
  throw new Error(`無法自動修復（${fp.reason}）→ 先跑 inspect 看指紋，人工處理`);
}

function cmdFingerprint(file, asJson) {
  try {
    const fp = fingerprintFile(file);
    if (asJson) { console.log(JSON.stringify(fp, null, 2)); return; }
    console.log(`檔案: ${fp.file}（${fp.kind === 'tenoc' ? 'TENOC v1 容器' : '裸 sqlite'}）`);
    console.log(`integrity: ${fp.integrity} words=${fp.words} cards=${fp.cards} decks=${fp.decks}`);
    console.log(`登記 migrations: ${fp.migs.join(',')}`);
    if (fp.mismatched.length) console.log(`❌ 指紋不符: ${fp.mismatched.join(',')}`);
    if (fp.pending.length) console.log(`待跑: ${fp.pending.join(',')}`);
    if (fp.v13gap) console.log('⚠️  v13 未登記但欄已存在（migrator 會 duplicate column 熔斷）');
    console.log(`user_version=${fp.userVersion} db_from_version=${fp.dbFromVersion ?? '（無）'}`);
    console.log(fp.route === 'ok' ? '✅ 可直接匯入' : fp.route === 'repair-v14'
      ? `🔧 路由→修復工具 v14（app ${fp.repairApp}）：${fp.reason}`
      : `⛔ 需人工：${fp.reason}`);
    if (fp.route !== 'ok') process.exitCode = 1;
  } catch (e) {
    console.error(`❌ 指紋失敗: ${e.message}`);
    process.exitCode = 1;
  }
}

function cmdPrepareImport(src, out) {
  if (!src || !out) { console.error('用法: prepare-import <來源> --out <輸出>'); process.exitCode = 1; return; }
  if (resolve(src) === resolve(out)) { console.error('拒絕：--out 與來源同檔'); process.exitCode = 1; return; }
  try {
    const r = prepareImportFile(src, out);
    console.log(`${r.repaired ? '🔧 已修復' : '✅ 直通'}: ${src} → ${out}`);
    for (const l of r.log) console.log(`   ${l}`);
  } catch (e) {
    console.error(`❌ prepare-import 中止: ${e.message}（未寫出，未動來源）`);
    process.exitCode = 1;
  }
}

// ─── 檢查 ───
function snapshot(db) {
  const t = (sql, p) => { try { return db.prepare(sql).get(); } catch (e) { return { __err: String(e.message || e).slice(0, 80) }; } };
  const wordsCols = db.prepare('PRAGMA table_info(words)').all().map(r => r.name);
  const decksCols = (() => { try { return db.prepare('PRAGMA table_info(decks)').all().map(r => r.name); } catch { return []; } })();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  let migs = null;
  try { migs = db.prepare('SELECT version FROM _sqlx_migrations ORDER BY version').all().map(r => r.version); }
  catch { migs = null; }
  return {
    integrity: t('PRAGMA integrity_check').integrity_check,
    words: t('SELECT COUNT(*) n FROM words').n,
    cards: t('SELECT COUNT(*) n FROM cards').n,
    decks: t('SELECT COUNT(*) n FROM decks').n,
    wordsCols, decksCols, tables, migs,
    userVersion: t('PRAGMA user_version').user_version,
    dbFromVersion: (() => { try { return db.prepare("SELECT value FROM settings WHERE key='db_from_version'").get()?.value ?? null; } catch { return null; } })(),
  };
}
function withTempDb(tenoBuf, fn) {
  const p = join(tmpdir(), `dbcompat-${process.pid}-${Date.now()}.db`);
  writeFileSync(p, tenoBuf);
  const db = new DatabaseSync(p);
  try { return fn(db); }
  finally { try { db.close(); } catch {} try { unlinkSync(p); } catch {} }
}

function cmdInspect(file) {
  if (!existsSync(file)) { console.error(`找不到檔案: ${file}`); process.exitCode = 1; return; }
  const MIGS = loadMigrations();
  const raw = readFileSync(file);
  const u = unpackFile(raw);
  console.log(`檔案: ${file}（${u.kind === 'tenoc' ? 'TENOC v1 容器' : '裸 sqlite'}，${(raw.length / 1048576).toFixed(2)} MB）`);
  if (!isSqlite(u.teno)) { console.error('❌ teno 段不是 SQLite（magic 不符）'); process.exitCode = 1; return; }
  if (u.log?.length && !isSqlite(u.log)) console.log('⚠️  log 段不是 SQLite（repair/downgrade 會原樣透傳，不驗證內容）');
  else if (u.log?.length) console.log(`log 段: SQLite ${(u.log.length / 1048576).toFixed(2)} MB（透傳，不動）`);
  else console.log('log 段: 無');
  withTempDb(u.teno, (db) => {
    const s = snapshot(db);
    console.log(`integrity: ${s.integrity}`);
    console.log(`words=${s.words} cards=${s.cards} decks=${s.decks}`);
    console.log(`words 欄: ${s.wordsCols.join(',')}`);
    console.log(`decks 欄: ${s.decksCols.join(',')}`);
    console.log(`登記 migrations: ${s.migs ? s.migs.join(',') : '（無 _sqlx_migrations 表）'}`);
    console.log(`user_version=${s.userVersion} db_from_version=${s.dbFromVersion ?? '（無）'}`);
    if (s.integrity !== 'ok') { process.exitCode = 1; return; }
    if (s.migs) {
      const missing = CURRENT_VERSIONS.filter(v => !s.migs.includes(v));
      const extra = s.migs.filter(v => !CURRENT_VERSIONS.includes(v));
      console.log(missing.length ? `新版待跑: ${missing.join(',')}` : '新版待跑: 無（已到頂 v14）');
      if (extra.length) console.log(`⚠️  未知版本登記: ${extra.join(',')}（舊版開此檔會 VersionMissing）`);
      // checksum 對帳（sqlx gate 級）：逐版比，不只看有無登記
      const audit = auditChecksums(db, MIGS);
      const bad = audit.mismatched.filter(v => s.migs.includes(v));
      console.log(bad.length ? `❌ checksum 不符: ${bad.join(',')}（新版 migrator 會 VersionMismatch 即死 → 跑 repair）` : 'checksum: 已登記版本全對得上現行 lib.rs');
      const v13cols = ['etymology', 'syllables', 'phrases', 'synonym', 'antonym'];
      const has = v13cols.filter(c => s.wordsCols.includes(c));
      if (!s.migs.includes(13) && has.length) console.log(`⚠️  v13 未登記但欄已存在: ${has.join(',')}（新版 migrator 會 duplicate column 熔斷 → 跑 repair）`);
    }
  });
}

// ─── repair：舊→新（本版修復工具 v14；改版加新條目進 REPAIR_TOOLS）───
// repairToFile 拋錯不上 exitCode（給 prepare-import／CLI 複用）；cmdRepair 包列印。
function repairToFile(src, dst) {
  if (!existsSync(src)) throw new Error(`找不到檔案: ${src}`);
  const MIGS = loadMigrations();
  const raw = readFileSync(src);
  const u = unpackFile(raw);
  if (!isSqlite(u.teno)) throw new Error('teno 段不是 SQLite，拒絕修復');
  const work = join(tmpdir(), `dbcompat-repair-${process.pid}-${Date.now()}.db`);
  writeFileSync(work, u.teno);
  const db = new DatabaseSync(work);
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('來源 integrity 非 ok，先處理損壞再修（本工具不救壞檔）');
    const before = snapshot(db);
    const wordsN = before.words, decksN = before.decks;
    // 登記表不存在＝史前庫：建 sqlx 同構表（後續逐版重放＋登記）
    db.exec(`CREATE TABLE IF NOT EXISTS _sqlx_migrations (
      version BIGINT PRIMARY KEY, description TEXT NOT NULL,
      installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`);
    const recorded = new Set(db.prepare('SELECT version FROM _sqlx_migrations').all().map(r => r.version));
    const log = [];
    // 0) success=0 殘留＝上次遷移死一半：拒絕自動修（需人工看是哪一版）
    const failed = db.prepare('SELECT version FROM _sqlx_migrations WHERE success = 0').all().map(r => r.version);
    if (failed.length) throw new Error(`有 success=0 的登記（v${failed.join(',v')}），上次遷移死一半，需人工處理`);
    // 1) checksum 對帳：已登記但指紋不符，sqlx 會 VersionMismatch 即死
    for (const v of [...recorded].sort((a, b) => a - b)) {
      if (!MIGS[v]) continue; // 比現行新的版本：repair 不動（downgrade 的事）
      const stored = Buffer.from(db.prepare('SELECT checksum FROM _sqlx_migrations WHERE version = ?').get(v).checksum);
      if (stored.equals(sha384(MIGS[v].sql))) continue;
      if (v === 1) { restampV1(db, MIGS); log.push('v1: 語意齊（十表＋index），指紋重蓋為現行'); }
      else throw new Error(`v${v} 指紋不符且非 v1（不敢自動重蓋，需人工確認語意等價）`);
    }
    for (const v of CURRENT_VERSIONS) {
      if (recorded.has(v)) { log.push(`v${v}: 已登記，跳過`); continue; }
      for (const st of splitStmts(MIGS[v].sql)) {
        try { db.exec(st); }
        catch (e) {
          if (isBenignErr(e)) { log.push(`v${v}: 部分已存在（${String(e.message || e).slice(0, 60)}），視為已套用續跑`); continue; }
          throw new Error(`v${v} 重放失敗: ${String(e.message || e).slice(0, 120)}（已存在欄請確認是否為 benign；否則此庫需人工處理）`);
        }
      }
      // 執行期成功不代表語意成功：v13 要求五欄齊備才登記（防半套）
      if (v === 13) {
        const cols = db.prepare('PRAGMA table_info(words)').all().map(r => r.name);
        if (!['etymology', 'syllables', 'phrases', 'synonym', 'antonym'].every(c => cols.includes(c))) {
          throw new Error('v13 五欄補不齊，拒絕偽登記');
        }
      }
      db.prepare('INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, ?, -1)')
        .run(v, MIGS[v].desc, sha384(MIGS[v].sql));
      log.push(`v${v}: 已套用＋登記`);
    }
    const after = snapshot(db);
    if (after.integrity !== 'ok') throw new Error('修後 integrity 非 ok');
    if (after.words !== wordsN) throw new Error(`修後 words 筆數漂移 ${wordsN} → ${after.words}`);
    if (after.decks !== decksN) throw new Error(`修後 decks 筆數漂移 ${decksN} → ${after.decks}`);
    db.exec('VACUUM');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('VACUUM 後 integrity 非 ok');
    db.close();
    const fixed = readFileSync(work);
    writeFileSync(dst, packTenoc(fixed, u.log));
    try { unlinkSync(work); } catch {}
    return { log, after };
  } catch (e) {
    try { db.close(); } catch {}
    try { unlinkSync(work); } catch {}
    throw e;
  }
}

function cmdRepair(src, out, inPlace) {
  if (!out && !inPlace) { console.error('repair 必須給 --out <輸出檔>（或顯式 --in-place 原地覆寫）'); process.exitCode = 1; return; }
  const dst = out || src;
  if (!inPlace && resolve(dst) === resolve(src)) { console.error('拒絕：--out 與來源同檔（用 --in-place 才允許原地覆寫）'); process.exitCode = 1; return; }
  try {
    const { log, after } = repairToFile(src, dst);
    console.log(`✅ repair 完成: ${src} → ${dst}`);
    for (const l of log) console.log(`   ${l}`);
    console.log(`   words=${after.words} decks=${after.decks} migrations=${after.migs.join(',')} integrity=${after.integrity}`);
  } catch (e) {
    console.error(`❌ repair 中止: ${e.message}（未寫出，未動來源）`);
    process.exitCode = 1;
  }
}

// ─── downgrade：新→舊 ───
function cmdDowngrade(src, target, out) {
  if (!existsSync(src)) { console.error(`找不到檔案: ${src}`); process.exitCode = 1; return; }
  if (!Number.isInteger(target) || target < MIN_DOWNGRADE_TARGET || target > 13) {
    console.error(`--target 必須是 ${MIN_DOWNGRADE_TARGET}..13 的整數（10＝5.9.x 時代；14 不可降級目標，只能 repair）`);
    process.exitCode = 1; return;
  }
  if (!out) { console.error('downgrade 必須給 --out <輸出檔>（絕不原地寫）'); process.exitCode = 1; return; }
  if (resolve(out) === resolve(src)) { console.error('拒絕：--out 與來源同檔'); process.exitCode = 1; return; }
  const MIGS = loadMigrations();
  const raw = readFileSync(src);
  const u = unpackFile(raw);
  if (!isSqlite(u.teno)) { console.error('❌ teno 段不是 SQLite，拒絕降級'); process.exitCode = 1; return; }
  const work = join(tmpdir(), `dbcompat-down-${process.pid}-${Date.now()}.db`);
  writeFileSync(work, u.teno);
  const db = new DatabaseSync(work);
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('來源 integrity 非 ok');
    const before = snapshot(db);
    if (!before.migs) throw new Error('無 _sqlx_migrations 表，無法判斷版本（先跑 repair 再降）');
    // v1 指紋先對齊現行（5.9.x 時代文字與現行一字不差；不對齊舊版一樣 VersionMismatch）
    {
      const stored = Buffer.from(db.prepare('SELECT checksum FROM _sqlx_migrations WHERE version = 1').get().checksum);
      if (!stored.equals(sha384(MIGS[1].sql))) { restampV1(db, MIGS); console.log('   v1: 指紋重蓋為現行'); }
    }
    const above = before.migs.filter(v => v > target);
    if (!above.length) { console.log(`無需降級：登記版本最高 ${Math.max(...before.migs)} ≤ target ${target}`); db.close(); unlinkSync(work); return; }
    // 剝離規則（按 target；原則：舊版 JS 讀得到的欄一律保留）：
    //  - synonym/antonym 是 JS 時代老欄（5.9.x 查詢點名要），任何 target 都保留；
    //    只剝舊版從沒見過的東西（etymology/syllables/phrases、new_weight、word_images）。
    //  - target 13：只刪 v14 登記（v14 無自有 schema，backfill 列留著無害，重升冪等）。
    //  - target 12：剝 etymology/syllables/phrases；留 synonym/antonym＋new_weight＋word_images。
    //  - target 11：再剝 word_images 表；留 new_weight。
    //  - target 10：再剝 new_weight。
    // 重升回新版時 v13 需走 repair／App 內 preensure（synonym/antonym 保留故重放必撞）。
    const dropCols = target < 13 ? ['etymology', 'syllables', 'phrases'] : [];
    console.log(`⚠️  將丟失：${dropCols.length ? 'words.' + dropCols.join('/') + ' 全欄內容；' : ''}${target < 12 ? 'word_images 全表；' : ''}${target < 11 ? 'decks.new_weight；' : ''}${above.includes(14) ? 'v14 登記（backfill 列保留，重升冪等）；' : ''}synonym/antonym 保留（舊版要讀）。`);
    const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
    const dropCol = (t, c) => { if (hasCol(t, c)) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`); };
    for (const c of dropCols) dropCol('words', c);
    if (target < 12) db.exec('DROP TABLE IF EXISTS word_images');
    if (target < 11) dropCol('decks', 'new_weight');
    db.prepare('DELETE FROM _sqlx_migrations WHERE version > ?').run(target);
    const after = snapshot(db);
    if (after.integrity !== 'ok') throw new Error('降級後 integrity 非 ok');
    if (after.words !== before.words) throw new Error(`降級後 words 筆數漂移 ${before.words} → ${after.words}`);
    db.exec('VACUUM');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('VACUUM 後 integrity 非 ok');
    // 舊版視角模擬：v1..target 全登記（migrator 應為 no-op）
    const rec = db.prepare('SELECT version FROM _sqlx_migrations ORDER BY version').all().map(r => r.version);
    const expect = CURRENT_VERSIONS.filter(v => v <= target);
    if (JSON.stringify(rec) !== JSON.stringify(expect)) throw new Error(`登記列不如預期: got [${rec}] want [${expect}]`);
    db.close();
    const down = readFileSync(work);
    writeFileSync(out, packTenoc(down, u.log));
    console.log(`✅ downgrade 完成: ${src} → ${out}（target v${target}）`);
    console.log(`   words=${after.words} decks=${after.decks} migrations=${rec.join(',')} integrity=${after.integrity}`);
    console.log(`   提醒：user_version 保留 ${after.userVersion}（舊版只升不降，會自動重 stamp，不擋開啟）`);
  } catch (e) {
    try { db.close(); } catch {}
    try { unlinkSync(work); } catch {}
    console.error(`❌ downgrade 中止: ${e.message}（未寫出，未動來源）`);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`用法：
  node tools/db-compat.mjs inspect <檔案>
  node tools/db-compat.mjs fingerprint <檔案> [--json]
  node tools/db-compat.mjs repair <來源> --out <輸出> [--in-place]
  node tools/db-compat.mjs prepare-import <來源> --out <輸出>
  node tools/db-compat.mjs downgrade <來源> --target 10 --out <輸出>`);
}
// 直接執行才跑 CLI；被 import（harness／cli 複用抽取逻辑）時只出函式。
// 注意：verify-db-compat.mjs 結尾也是 db-compat.mjs，故用 basename 全等判定。
const RUN_AS_CLI = basename(process.argv[1] || '') === 'db-compat.mjs';
if (RUN_AS_CLI) {
const [cmd, a, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(k); return i === -1 ? null : rest[i + 1]; };
if (cmd === 'inspect') cmdInspect(a);
else if (cmd === 'fingerprint') cmdFingerprint(a, rest.includes('--json'));
else if (cmd === 'repair') cmdRepair(a, opt('--out'), rest.includes('--in-place'));
else if (cmd === 'prepare-import') cmdPrepareImport(a, opt('--out'));
else if (cmd === 'downgrade') cmdDowngrade(a, parseInt(opt('--target'), 10), opt('--out'));
else { usage(); process.exitCode = 1; }
}
export { loadMigrations, sha384, splitStmts, unpackFile, packTenoc, isSqlite, auditChecksums, fingerprintFile, prepareImportFile, repairToFile, REPAIR_TOOLS, CURRENT_VERSIONS };
