# 快照C：資料層全文＋store/lib.rs 節錄
## FILE: src/lib/api.js
''
import { invoke } from '@tauri-apps/api/core'

// ─── CLI ─────────────────────────────────────────────────────
export const runCli = (args) =>
  invoke('run_cli', { args })

export const getAppPaths = () =>
  invoke('get_app_paths')

// ─── LLM / Network ─────────────────────────────────────
export const fetchLLM = (url, model, prompt, apiFormat) =>
  invoke('fetch_llm', { url, model, prompt, apiFormat })

export const fetchGet = (url) =>
  invoke('fetch_get', { url })

// ─── Scraping ──────────────────────────────────────────
export const lookupCambridge = (word, lang) =>
  invoke('lookup_cambridge', { word, lang })

export const scrapeQuizlet = (url) =>
  invoke('scrape_quizlet', { url })

// ─── TTS ───────────────────────────────────────────────
export const speakText = (text, opts = {}) => {
  const { speed = 1, voice = 'en_US-ryan-high', pitch } = opts
  return invoke('speak_text', {
    text,
    voice,
    pitch: pitch ?? 50,
    lengthScale: Math.max(0.3, Math.min(3, 1.0 / Math.max(0.3, speed) * 0.9)),
    noiseScale: 0.667,
  })
}

export const speakAndroid = (text, opts = {}) => {
  const { speed = 1, voice = '' } = opts
  return invoke('speak_android', { text, voice, speed })
}

export const stopAndroid = () =>
  invoke('stop_android')

/** 切換 launcher icon（Android activity-alias；非 Android 為 no-op） */
export const setLauncherIcon = (name) =>
  invoke('set_launcher_icon', { name })

/** 查目前使用的 launcher icon key（Android；非 Android 回 original） */
export const getLauncherIcon = () =>
  invoke('get_launcher_icon')

/** 重置 app-log.db（操作日誌 DB 損壞時刪檔重建；teno.db 不受影響） */
export const resetAppLogDb = () =>
  invoke('reset_app_log')

export const listAndroidVoices = () =>
  invoke('list_voices_android')

export const listPiperVoices = () =>
  invoke('list_piper_voices')

export const importPiperModelDialog = () =>
  invoke('import_piper_model_dialog')

export const installPiperModel = (url) =>
  invoke('install_piper_model', { url })

export const deletePiperModel = (name) =>
  invoke('delete_piper_model', { name })

// ─── Backup ────────────────────────────────────────────
export const backupDb = () =>
  invoke('backup_db')

export const listBackups = () =>
  invoke('list_backups')

export const restoreBackup = (filename) =>
  invoke('restore_backup', { filename })

export const deleteBackup = (filename) =>
  invoke('delete_backup', { filename })

export const exportBackupDialog = (filename) =>
  invoke('export_backup_dialog', { filename })

export const pruneBackups = (maxCount) =>
  invoke('prune_backups', { maxCount })

export const getDbMtime = () =>
  invoke('get_db_mtime')

// ─── Database / Export ─────────────────────────────────
export const importDbDialog = () =>
  invoke('import_db_dialog')

export const writeDbBytes = (buf) =>
  invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) })

export const exportDbDialog = (includeLog = true) =>
  invoke('export_db_dialog', { includeLog })

export const exportCsvDialog = (csv, filename) =>
  invoke('export_csv_dialog', { csv, filename })

// ─── Android export (returns data for Blob download) ──
export const exportCsvData = (csv, filename) =>
  invoke('export_csv_data', { csv, filename })

export const exportDbData = (includeLog = true) =>
  invoke('export_db_data', { includeLog })

export const exportBackupData = (filename) =>
  invoke('export_backup_data', { filename })

// ─── Google Drive Sync ───────────────────────────────
export const driveSaveCreds = (clientId, clientSecret) =>
  invoke('drive_save_creds', { clientId, clientSecret })

export const driveOAuth = () =>
  invoke('drive_oauth')

export const driveUpload = () =>
  invoke('drive_upload')

export const driveDownload = () =>
  invoke('drive_download')

export const driveStatus = () =>
  invoke('drive_status')

export const driveLogout = () =>
  invoke('drive_logout')

export const optimizeFsrs = (reviews) =>
  invoke('optimize_fsrs', { reviews })

// ─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1, 對齊 Anki 26.08) ───
// mode: 'simulate' | 'workload' | 'optimal'
export const simulateFsrs = (req) =>
  invoke('simulate_fsrs', { req })
''
## FILE: src/lib/db.js
''
// ═══════════════════════════════════════════════════════════════
// DB — Stateless SQLite data access layer.
// Every call goes to SQLite. No caching (that's the store's job).
// ═══════════════════════════════════════════════════════════════

/** @type {import('@tauri-apps/plugin-sql').default | null} */
let db = null;

/** Initialize DB connection. Call once at startup. */
export async function initDB(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { default: Database } = await import('@tauri-apps/plugin-sql');
      db = await Database.load('sqlite:teno.db');
      console.log('[db] ✅ SQLite connected');
      await migrate(db);
      await stampDbVersion(db);   // VERSION-TRACE: 寫入 DB 版本指紋（PRAGMA user_version + settings）
      return db;
    } catch (e) {
      console.error(`[db] ❌ Failed to init DB (attempt ${i + 1}/${retries}):`, e);
      db = null;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
    }
  }
  return db;
}

/** Close DB connection. Use before import. */
export async function closeDB() {
  if (db) {
    try { await db.close(); } catch (e) { console.warn('[db] close error:', e); }
    db = null;
  }
}

// ─── VERSION-TRACE: DB 版本指紋 ───────────────────────────────
// 目的: 每份 DB 記下「哪個 app 版本寫的」，日後分析/除錯可確定版本邊界
// （修復分界不再靠 reviewed_at 的 Z/無Z 猜）。採 SQLite 原生 PRAGMA user_version
// （存於檔頭、單一值、不佔表）+ settings.db_from_version（字串人讀）。
let _pkgVer = null;
let _pkgBuildHash = null;
async function _loadPkg() {
  if (_pkgVer !== null) return { version: _pkgVer, buildHash: _pkgBuildHash };
  try {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    const p = pkg?.default || pkg || {};
    _pkgVer = p.version || '0.0.0';
    _pkgBuildHash = p.buildHash || null;
  } catch (_) { _pkgVer = '0.0.0'; _pkgBuildHash = null; }
  return { version: _pkgVer, buildHash: _pkgBuildHash };
}
async function loadAppVersion() { const p = await _loadPkg(); return p.version; }
/** 本次 build 對應 commit hash（package.json buildHash — 打包流程寫入；未寫入回 'unknown'）. */
async function getBuildCommit() { const p = await _loadPkg(); return p.buildHash || 'unknown'; }

function versionInt(versionStr) {
  const m = String(versionStr || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]);   // 5.1.18 → 5001018
}
export function getAppVersion() { return _pkgVer || '0.0.0'; }
export function getAppVersionInt() { return versionInt(getAppVersion()); }

/** 寫入 DB 版本指紋（已存在更高版本不覆寫 → 只升不降）。 commit hash 同時記錄. */
export async function stampDbVersion(d) {
  try {
    await _loadPkg();   // 確保 app 版本已載入（首次呼叫同步讀 package.json）
    const verInt = getAppVersionInt();
    const rows = await (d || requireDB()).select('PRAGMA user_version');
    const cur = rows?.[0]?.user_version ?? 0;
    const commitHash = await getBuildCommit();   // 本次 build 對應 commit（package.json buildHash 或執行環境）
    if (verInt > cur) {
      await (d || requireDB()).execute(`PRAGMA user_version = ${verInt}`);
      // 版本提升時一併記錄對應 commit hash
      try { await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_commit', ?)", [commitHash]); } catch (_) {}
    }
    // settings 字串版本（人讀）+ 首次寫入標記
    try {
      const exists = await (d || requireDB()).select("SELECT value FROM settings WHERE key='db_from_version'");
      if (!exists || !exists.length) {
        await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_version', ?)", [getAppVersion()]);
        await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_commit', ?)", [commitHash]);
      }
    } catch (_) { /* settings 可能無此表（極早期）→ 忽略 */ }
  } catch (e) { console.warn('[db] stampDbVersion:', e); }
}

/** 讀取 DB 版本指紋（分析/CLI 用）。回傳 { app, int, raw }。 */
export async function getDbVersion(d) {
  const conn = d || requireDB();
  const rows = await conn.select('PRAGMA user_version');
  const raw = rows?.[0]?.user_version ?? 0;
  const verRows = await conn.select("SELECT value FROM settings WHERE key='db_from_version'");
  return { app: verRows?.[0]?.value ?? null, int: raw, raw };
}

/** Run schema migrations. */
async function migrate(d) {
  const cols = ['synonym', 'antonym', 'derivative', 'examples', 'related', 'forms'];
  for (const col of cols) {
    try { await d.execute(`ALTER TABLE words ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  }
  // v5.2: review_log 記錄複習後的狀態 (fsrs-report 轉移分析不用 replay)
  try { await d.execute('ALTER TABLE review_log ADD COLUMN new_state INTEGER'); } catch (_) {}
  // v5.2: 審計日誌 (設定變更/匯入匯出/CLI 寫入)
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    )`);
    await d.execute('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)');
  } catch (_) {}
  // A12: 容器卡假 due 清理 — state=0（new）不該有 due；只清帶 mcData/spellData 的容器卡
  try {
    await d.execute(`UPDATE cards SET due='' WHERE state=0 AND due != '' AND (mc_data IS NOT NULL OR spell_data IS NOT NULL)`);
  } catch (_) {}
}

/** Checkpoint WAL so the main db file is fully up to date. */
export async function checkpoint() {
  if (db) {
    try { await db.execute("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn('[db] checkpoint failed:', e); }
  }
}

/** Check if DB is available. */
export function isReady() {
  return db !== null;
}

function requireDB() {
  if (!db) throw new Error('DB not connected. Check src-tauri/capabilities/default.json includes sql:default + sql:allow-execute, and initDB() was called.');
  return db;
}

// ─── Words ─────────────────────────────────────

export async function getAllWords() {
  const rows = await requireDB().select(
    'SELECT id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, created_at, related, forms, synonym, antonym, derivative, examples FROM words ORDER BY created_at'
  );
  return rows.map(r => ({
    id: r.id,
    word: r.word,
    definition: r.definition || '',
    pos: r.part_of_speech || '',
    pron: r.pronunciation || '',
    example: r.example || '',
    deck: r.deck || 'Default',
    tags: parseJSON(r.tags, []),
    image: r.image || '',
    description: r.description || '',
    related: parseJSON(r.related, []),
    forms: parseJSON(r.forms, []),
    synonym: r.synonym || '',
    antonym: r.antonym || '',
    derivative: r.derivative || '',
    examples: parseJSON(r.examples, []),
    createdAt: normalizeUtcTimestamp(r.created_at),   // E2: 統一正規化（dashboard/filterEngine 兩消費點）
  }));
}

export async function getWordCount() {
  const rows = await requireDB().select('SELECT COUNT(*) AS count FROM words');
  return rows[0]?.count ?? 0;
}

export async function saveWord(word) {
  await requireDB().execute(
    `INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT(id) DO UPDATE SET
      word=excluded.word, definition=excluded.definition,
      part_of_speech=excluded.part_of_speech, pronunciation=excluded.pronunciation,
      example=excluded.example, deck=excluded.deck,
      tags=excluded.tags, image=excluded.image, description=excluded.description,
      related=excluded.related, forms=excluded.forms,
      synonym=excluded.synonym, antonym=excluded.antonym,
      derivative=excluded.derivative, examples=excluded.examples`,
    [   // E2: ON CONFLICT 不加 created_at — 編輯/改標籤不重置建立時間
      word.id,
      word.word || '',
      word.definition || '',
      word.pos || '',
      word.pron || '',
      word.example || '',
      word.deck || 'Default',
      JSON.stringify(word.tags || []),
      word.image || '',
      word.description || '',
      JSON.stringify(word.related || []),
      JSON.stringify(word.forms || []),
      word.synonym || '',
      word.antonym || '',
      word.derivative || '',
      JSON.stringify(word.examples || []),
      word.createdAt ?? new Date().toISOString(),   // E2: created_at ISO 帶 Z
    ]
  );
}

// G18: 批次存多個 words 於單一事務（tag 改動/批次編輯用 — 避免萬級詞庫逐詞 round-trip）
export async function saveWordsInTx(words) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    for (const w of words) await saveWord(w);
    await d.execute('COMMIT');
  } catch (e) {
    try { await d.execute('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export async function deleteWord(id) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    // D14: 先取 word 文字（exam_history.word 存單字文字非 id，需其刪孤兒測驗紀錄）
    const wr = await d.select('SELECT word FROM words WHERE id = $1', [id]);
    const wordText = wr[0]?.word;
    await d.execute('DELETE FROM cards WHERE word_id = $1', [id]);
    await d.execute('DELETE FROM review_log WHERE word_id = $1', [id]);   // D14: 清孤兒複習紀錄
    if (wordText) await d.execute('DELETE FROM exam_history WHERE word = $1', [wordText]);  // D14: 清孤兒測驗紀錄(存文字)
    await d.execute('DELETE FROM words WHERE id = $1', [id]);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

export async function bulkSaveWords(words) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM words');
    for (const w of words) await saveWord(w);
    await d.execute('COMMIT');
    await addAudit('import-words', `匯入 ${words.length} 詞 (整表覆寫)`);
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Cards ─────────────────────────────────────

export async function getAllCards() {
  const rows = await requireDB().select(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards'
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.word_id, {
      due: r.due,
      stability: r.stability,
      difficulty: r.difficulty,
      elapsedDays: r.elapsed_days,
      scheduledDays: r.scheduled_days,
      reps: r.reps,
      lapses: r.lapses,
      state: r.state,
      step: r.step ?? 0,
      lastReview: r.last_review,
      buried: !!r.buried,
      suspended: !!r.suspended,
      interval: r.scheduled_days || 0,
      mcData: parseJSON(r.mc_data, null),
      spellData: parseJSON(r.spell_data, null),
    });
  }
  return map;
}

export async function getCard(wordId) {
  const rows = await requireDB().select(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards WHERE word_id = $1',
    [wordId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    elapsedDays: r.elapsed_days,
    scheduledDays: r.scheduled_days,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    step: r.step ?? 0,
    lastReview: r.last_review,
    buried: !!r.buried,
    suspended: !!r.suspended,
    interval: r.scheduled_days || 0,
    mcData: parseJSON(r.mc_data, null),
    spellData: parseJSON(r.spell_data, null),
  };
}

export async function saveCard(wordId, card) {
  await requireDB().execute(
    `INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT(word_id) DO UPDATE SET
       due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
       elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
       reps=excluded.reps, lapses=excluded.lapses, state=excluded.state,
       step=excluded.step, last_review=excluded.last_review,
       buried=excluded.buried, suspended=excluded.suspended,
       mc_data=excluded.mc_data, spell_data=excluded.spell_data`,
    [
      wordId,
      card.due ?? new Date().toISOString(),
      card.stability ?? 2.5,
      card.difficulty ?? 5,
      card.elapsedDays ?? 0,
      card.scheduledDays ?? 0,
      card.reps ?? 0,
      card.lapses ?? 0,
      card.state ?? 0,
      card.step ?? 0,
      card.lastReview ?? null,
      card.buried ? 1 : 0,
      card.suspended ? 1 : 0,
      card.mcData ? JSON.stringify(card.mcData) : null,
      card.spellData ? JSON.stringify(card.spellData) : null,
    ]
  );
}

export async function bulkSaveCards(cards) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    for (const [wordId, card] of cards) await saveCard(wordId, card);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Decks ─────────────────────────────────────

export async function getAllDecks() {
  const rows = await requireDB().select('SELECT id, name, color FROM decks ORDER BY name');
  return rows.map(r => ({ id: r.id, name: r.name, color: r.color }));
}

export async function saveDeck(deck) {
  await requireDB().execute(
    'INSERT INTO decks (id, name, color) VALUES ($1, $2, $3) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color',
    [deck.id, deck.name, deck.color || '#5e6ad2']
  );
}

export async function deleteDeck(id) {
  await requireDB().execute('DELETE FROM decks WHERE id = $1', [id]);
}

export async function deleteWordsByDeck(deckName) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM words WHERE deck = $1', [deckName]);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Folders ────────────────────────────────────

export async function getAllFolders() {
  const rows = await requireDB().select('SELECT name, decks FROM folders');
  const map = {};
  for (const r of rows) map[r.name] = parseJSON(r.decks, []);
  return map;
}

export async function saveFolders(folders) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM folders');
    for (const [name, deckIds] of Object.entries(folders)) {
      await d.execute(
        'INSERT INTO folders (name, decks) VALUES ($1, $2) ON CONFLICT(name) DO UPDATE SET decks=excluded.decks',
        [name, JSON.stringify(deckIds)]
      );
    }
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Additions ──────────────────────────────────

export async function getAllAdditions() {
  const rows = await requireDB().select('SELECT * FROM additions ORDER BY added_at');
  return rows.map(r => ({
    id: r.id,
    word: r.word,
    definition: r.definition || '',
    pos: r.part_of_speech || '',
    pron: r.pronunciation || '',
    examples: parseJSON(r.examples, []),
    deck: r.deck || 'Default',
  }));
}

export async function bulkSaveAdditions(additions) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM additions');
    for (const a of additions) {
      await d.execute(
        'INSERT INTO additions (word, definition, part_of_speech, pronunciation, examples, deck) VALUES ($1, $2, $3, $4, $5, $6)',
        [a.word, a.definition || '', a.pos || '', a.pron || '', JSON.stringify(a.examples || []), a.deck || 'Default']
      );
    }
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Settings (KV) ──────────────────────────────

export async function getSetting(key) {
  const rows = await requireDB().select('SELECT value FROM settings WHERE key = $1', [key]);
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
}

export async function setSetting(key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  await requireDB().execute(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, str]
  );
  // 審計: 設定變更軌跡 (CLI 與 GUI 統一)
  await addAudit('setting', `SET ${key}=${str.slice(0, 300)}`);
}

/** 審計日誌 — 記錄任何寫入動作 (GUI/CLI 共用, 存 teno.db) */
export async function addAudit(action, detail = '') {
  try {
    await requireDB().execute(
      'INSERT INTO audit_log (ts, action, detail) VALUES ($1, $2, $3)',
      [Date.now(), String(action).slice(0, 100), String(detail).slice(0, 1000)]
    );
  } catch (e) {
    console.warn('[db] addAudit error:', e);
  }
}

// ─── Tags ────────────────────────────────────────

export async function getAllTags() {
  const raw = await getSetting('tags');
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function setAllTags(tags) {
  await setSetting('tags', tags);
}

// ─── Review Log ─────────────────────────────────

export async function addReviewLog(entry) {
  await requireDB().execute(
    `INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [entry.wordId, entry.rating, entry.duration ?? null, entry.elapsedDays ?? null, entry.scheduledDays ?? null, entry.stability ?? null, entry.difficulty ?? null, entry.mode || 'flip', entry.state ?? null, entry.newState ?? null, entry.reviewedAt ?? new Date().toISOString()]   // E2: reviewed_at ISO 帶 Z（不再靠 DEFAULT naive）
  );
}

export async function getAllReviewLogs() {
  const rows = await requireDB().select('SELECT * FROM review_log ORDER BY reviewed_at, id');   // C1: id 次鍵消除同刻 timestamp tie 順序不確定性
  return rows.map(r => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    duration: r.duration,
    elapsedDays: r.elapsed_days,
    scheduledDays: r.scheduled_days,
    stability: r.stability,
    difficulty: r.difficulty,
    // SQLite datetime('now') stores UTC WITHOUT a timezone marker; JS would
    // parse it as local time and shift every timestamp by the UTC offset.
    // Normalize to an ISO string carrying the Z (UTC) marker so downstream
    // consumers (scheduler + dashboard charts) interpret it correctly.
    reviewed_at: normalizeUtcTimestamp(r.reviewed_at),
    state: r.card_state,
    newState: r.new_state,
    ivl: r.scheduled_days,
    mode: r.mode || 'flip',
  }));
}

/**
 * Normalize a SQLite UTC timestamp (e.g. "2026-07-22 22:00:00") into an
 * ISO string with explicit UTC marker. Strings already carrying a timezone
 * (Z or ±HH:MM) are returned unchanged.
 */
function normalizeUtcTimestamp(ts) {
  if (ts == null) return ts;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(ts)) {
    return ts.replace(' ', 'T') + 'Z';
  }
  return ts;
}

/** Count today's new-card reviews for a given mode from revlog.
 *  reviewed_at is stored in UTC; convert the local todayStart + cutoff into a UTC boundary. */
export async function getNewRatedToday(mode, todayStart, dayCutoff = 0, tzOffset = null) {
  const offset = tzOffset ?? -(new Date().getTimezoneOffset());
  const [y, m, d] = todayStart.split('-').map(Number);
  const boundaryUtc = new Date(Date.UTC(y, m - 1, d, 0, dayCutoff || 0) - offset * 60000)
    .toISOString();   // E2: 完整 24 字元含 Z — 舊的 slice(0,19)+空格 對校正後 ISO 值字串比較失準（'T' > ' ' → 灌水）
  const rows = await requireDB().select(
    'SELECT COUNT(*) AS count FROM review_log WHERE mode = $1 AND card_state = 0 AND reviewed_at >= $2',
    [mode, boundaryUtc]
  );
  return rows[0]?.count ?? 0;
}

export async function clearReviewLogs() {
  await requireDB().execute('DELETE FROM review_log');
}

export async function getMaxReviewLogId() {
  const rows = await requireDB().select('SELECT MAX(id) AS m FROM review_log');
  return rows[0]?.m ?? 0;
}

export async function deleteReviewLogsAfter(id, mode) {
  // C1: mode 過濾 — COALESCE(mode, 'flip') 內固定字面量（NULL 舊資料視為 flip，僅 flip undo 會刪）；
  //     右側 $2 為目標 mode（比較參數化）
  const m = mode || 'flip';   // 防 undefined 參數（呼叫端已窮舉，純保險）
  await requireDB().execute(
    "DELETE FROM review_log WHERE id > $1 AND COALESCE(mode, 'flip') = $2",
    [id, m]
  );
}

export async function deleteLastReviewLog() {
  await requireDB().execute('DELETE FROM review_log WHERE id = (SELECT MAX(id) FROM review_log)');
}

export async function deleteCard(wordId) {
  await requireDB().execute('DELETE FROM cards WHERE word_id = $1', [wordId]);
}

// ─── Exam History ───────────────────────────────

export async function addExamEntry(entry) {
  await requireDB().execute(
    'INSERT INTO exam_history (word, correct, question_type, examined_at) VALUES ($1, $2, $3, $4)',
    [entry.word, entry.correct ? 1 : 0, entry.questionType || null, entry.examinedAt ?? new Date().toISOString()]   // E2: examined_at ISO 帶 Z（不再靠 DEFAULT naive）
  );
}

export async function getAllExamHistory() {
  return await requireDB().select('SELECT * FROM exam_history ORDER BY examined_at');
}

// ─── Goal Streak ────────────────────────────────

export async function getGoalStreak() {
  const rows = await requireDB().select('SELECT daily_goal, current, best, dates FROM goal_streak WHERE id = 1');
  if (rows.length === 0) return { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  const r = rows[0];
  const raw = r.dates ? parseJSON(r.dates, {}) : {};
  if (Array.isArray(raw)) {
    return { dailyGoal: r.daily_goal, current: r.current, best: r.best, dates: { flip: [...raw], mc: [...raw], spell: [...raw] } };
  }
  return {
    dailyGoal: r.daily_goal,
    current: r.current,
    best: r.best,
    dates: { flip: Array.isArray(raw.flip) ? raw.flip : [], mc: Array.isArray(raw.mc) ? raw.mc : [], spell: Array.isArray(raw.spell) ? raw.spell : [] },
  };
}

export async function saveGoalStreak(data) {
  await requireDB().execute(
    `INSERT INTO goal_streak (id, daily_goal, current, best, dates)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT(id) DO UPDATE SET
       daily_goal=excluded.daily_goal, current=excluded.current,
       best=excluded.best, dates=excluded.dates`,
    [data.dailyGoal || 20, data.current || 0, data.best || 0, JSON.stringify(data.dates || [])]
  );
}

// ─── Filtered Decks ─────────────────────────────

export async function getAllFilteredDecks() {
  return await requireDB().select(
    'SELECT id, name, search_query, max_cards, order_by, color, created_at, last_used FROM filtered_decks ORDER BY name'
  );
}

export async function saveFilteredDeck(deck) {
  await requireDB().execute(
    `INSERT INTO filtered_decks (id, name, search_query, max_cards, order_by, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, search_query=excluded.search_query,
       max_cards=excluded.max_cards, order_by=excluded.order_by, color=excluded.color`,
    [deck.id, deck.name, deck.search_query, deck.max_cards || 100, deck.order_by || 'due', deck.color || '#f59e0b']
  );
}

export async function updateFilteredDeckLastUsed(id) {
  await requireDB().execute(
    'UPDATE filtered_decks SET last_used = $2 WHERE id = $1',
    [id, new Date().toISOString()]   // E2: ISO 帶 Z
  );
}

export async function deleteFilteredDeck(id) {
  await requireDB().execute('DELETE FROM filtered_decks WHERE id = $1', [id]);
}

// ─── Clear All Data ────────────────────────────

export async function executeSQL(sql, params = []) {
  await requireDB().execute(sql, params);
}

export async function clearAll() {
  const d = requireDB();
  try {
    await d.execute('BEGIN TRANSACTION');
    await d.execute('DELETE FROM words');
    await d.execute('DELETE FROM cards');
    await d.execute('DELETE FROM decks');
    await d.execute('DELETE FROM folders');
    await d.execute('DELETE FROM additions');
    await d.execute('DELETE FROM review_log');
    await d.execute('DELETE FROM exam_history');
    await d.execute('DELETE FROM goal_streak');
    await d.execute('DELETE FROM filtered_decks');
    try { await d.execute('DELETE FROM edits'); } catch (_) {}
    await d.execute('DELETE FROM settings');
    await d.execute('COMMIT');
    // 審計記錄保留 (不隨 clearAll 刪除), 讓「重設」這件事留痕
    try { await addAudit('reset-all', '所有資料已清除'); } catch (_) {}
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Helpers ────────────────────────────────────

function parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
''
## FILE: src-tauri/capabilities/default.json
''
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "sql:default",
    "sql:allow-execute",
    "log:default",
    "dialog:default",
    "dialog:allow-save",
    "dialog:allow-open",
    "opener:default",
    "opener:allow-open-url"
  ]
}
''
## FILE: src/lib/store.js (addWord 節錄)
''
    },

    /** Start a background task */
    startBackgroundTask(id, label, total) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      state.backgroundTasks.push({ id, label, done: 0, total, status: 'running' });
      notify();
    },
    /** Update background task progress */
    updateBackgroundTask(id, done, total) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.done = done; t.total = total; notify(); }
    },
    /** Complete a background task successfully */
    completeBackgroundTask(id, result) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'done'; t.done = t.total; t.result = result; notify(); }
    },
    /** Mark a background task as failed */
    failBackgroundTask(id, error) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'failed'; t.error = error; notify(); }
    },
    /** Remove a background task from the list */
    dismissBackgroundTask(id) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      notify();
    },

    /** Add a new word */
    async addWord(wordData) {
      const word = {
        id: nextWordId(),
        word: wordData.word.toLowerCase().trim(),
        definition: wordData.definition || '',
        pos: wordData.pos || '',
        pron: wordData.pron || '',
        example: wordData.example || '',
        deck: wordData.deck || 'Default',
        tags: wordData.tags || [],
        image: wordData.image || '',
        description: wordData.description || '',
        related: wordData.related || [],
        forms: wordData.forms || [],
        synonym: wordData.synonym || '',
        antonym: wordData.antonym || '',
        derivative: wordData.derivative || '',
        examples: wordData.examples || [],
        createdAt: new Date().toISOString(),
      };
      state.words.push(word);
      try { await db.saveWord(word); } catch (e) { console.warn('[store] addWord saveWord error:', e); }
      await refreshDerived();
      notify();
      return word;
    },

    /**
     * Bulk import word objects. Skips duplicates (by lowercased word),
     * auto-creates any missing decks, and only notifies once at the end.
     * @param {object[]} words - parsed word objects
     * @param {(p:{done:number,total:number,added:number,skipped:number})=>void} [onProgress]
     * @returns {Promise<{added:number,skipped:number,decksCreated:string[]}>}
     */
    async importWords(words, onProgress) {
      const palette = ['#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb7185', '#fb923c', '#f0ecf5'];
      const existing = new Set(state.words.map(w => w.word.toLowerCase()));
      const deckByName = new Map(state.decks.map(d => [d.name, d]));
      const decksCreated = [];
      let added = 0, skipped = 0;
      const total = words.length;
      const now = new Date().toISOString();

      const newWords = [];

      for (let i = 0; i < total; i++) {
        const src = words[i];
        const w = (src.word || '').toLowerCase().trim();
        if (!w) { skipped++; continue; }
        if (existing.has(w)) { skipped++; if (onProgress) onProgress({ done: i + 1, total, added, skipped }); continue; }

        // Ensure deck exists
        const deckName = src.deck || 'Default';
        if (!deckByName.has(deckName)) {
          const color = palette[state.decks.length % palette.length];
          const deck = await this.createDeck(deckName, color);
          deckByName.set(deck.name, deck);
          decksCreated.push(deck.name);
        }

        const word = {
          id: nextWordId(),
          word: w,
          definition: src.definition || '',
          pos: src.pos || '',
          pron: src.pron || '',
          example: src.example || '',
          deck: deckName,
          tags: src.tags || [],
          image: src.image || '',
          description: src.description || '',
          related: src.related || [],
          forms: src.forms || [],
          synonym: src.synonym || '',
          antonym: src.antonym || '',
          derivative: src.derivative || '',
          examples: src.examples || [],
          createdAt: now,
        };
        state.words.push(word);
        existing.add(w);
        newWords.push(word);
        added++;
        if (onProgress && (i % 3 === 0 || i === total - 1)) {
          onProgress({ done: i + 1, total, added, skipped });
        }
      }

      // ponytail: single transaction for bulk insert
      if (newWords.length) {
        try { await db.executeSQL('BEGIN TRANSACTION'); } catch (_) {}
        try {
          for (const w of newWords) await db.saveWord(w);
          await db.executeSQL('COMMIT');
        } catch (e) {
          await db.executeSQL('ROLLBACK');
          console.warn('[store] importWords bulk insert error:', e);
        }
      }

      await refreshDerived();
      notify();
      return { added, skipped, decksCreated };
    },

    /** Edit a word */
    async editWord(id, updates) {
      const idx = state.words.findIndex(w => w.id === id);
      if (idx === -1) return;
      state.words[idx] = { ...state.words[idx], ...updates };
      try { await db.saveWord(state.words[idx]); } catch (e) { console.warn('[store] editWord saveWord error:', e); }
''
## FILE: src-tauri/src/lib.rs (command 簽名節錄)
''

#[tauri::command]
fn walk_piper_dir(dir: &std::path::Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
--

#[tauri::command]
fn list_piper_voices(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    Ok(collect_piper_voices(&data_dir))
--
// 開啟 report.html 圖表報告 (獨立視窗, file:// 讀 config 目錄)
#[tauri::command]
fn open_report(app_handle: tauri::AppHandle) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let report_path = format!("{}/.config/com.teno.app/sim-logs/report.html", home);
--
/// App paths the frontend needs (config dir, sim-logs dir) — no hardcoded HOME paths.
#[tauri::command]
fn get_app_paths(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
--

#[tauri::command]
async fn run_cli(app_handle: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    log::info!("run_cli args={:?}", args);
    let cli_path = resolve_cli_path(&app_handle).ok_or_else(|| {
--

#[tauri::command]
fn scrape_quizlet(url: String) -> Result<String, String> {
    log::info!("scrape_quizlet url={}", url);
    if !url.starts_with("https://") { return Err("僅允許 HTTPS 連線".to_string()); }
--

#[tauri::command]
async fn fetch_llm(url: String, model: String, prompt: String, api_format: Option<String>) -> Result<String, String> {
    log::info!("fetch_llm url={} model={} prompt_len={} format={:?}", url, model, prompt.len(), api_format);
    let fmt = api_format.unwrap_or_default();
--

#[tauri::command]
async fn fetch_get(url: String) -> Result<String, String> {
    log::info!("fetch_get url={}", url);
    check_fetch_get_url(&url)?;
--

#[tauri::command]
async fn lookup_cambridge(word: String, lang: Option<String>) -> Result<String, String> {
    let is_zh = lang.as_deref() == Some("zh");
    let url = if is_zh {
--

#[tauri::command]
async fn speak_text(text: String, voice: Option<String>, length_scale: Option<f64>, noise_scale: Option<f64>, app_handle: tauri::AppHandle) -> Result<(), String> {
    if TTS_PLAYING.swap(true, Ordering::Acquire) {
        return Err("已有語音正在播放".to_string());
--

#[tauri::command]
async fn import_piper_model_dialog(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn delete_piper_model(name: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let data_dir = piper_models_dir(&app_handle)?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
--

#[tauri::command]
fn install_piper_model(url: String, app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("建立模型目錄失敗: {}", e))?;
--

#[tauri::command]
fn write_db_bytes(app_handle: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    log::info!("write_db_bytes app_dir={:?} data_len={}", app_dir, data.len());
--

#[tauri::command]
async fn import_db_dialog(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn optimize_fsrs(reviews: Vec<FsrsReviewEntry>) -> Result<Vec<f32>, String> {
    use std::collections::HashMap;
    use fsrs::{compute_parameters, ComputeParametersInput, FSRSItem, FSRSReview};
--

#[tauri::command]
fn simulate_fsrs(req: SimulateFsrsRequest) -> Result<SimulateFsrsResponse, String> {
    use fsrs::{extract_simulator_config, optimal_retention, simulate, Card, RevlogEntry};
    use std::sync::Arc;
--

#[tauri::command]
fn log_msg(msg: String) {
    use std::io::Write;
    log::info!("[js] {msg}");
--

#[tauri::command]
async fn export_db_dialog(app_handle: tauri::AppHandle, include_log: bool) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
async fn export_csv_dialog(app_handle: tauri::AppHandle, csv: String, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn backup_db(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
--

#[tauri::command]
fn prune_backups(app_handle: tauri::AppHandle, max_count: u32) -> Result<u32, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn get_db_mtime(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
--

#[tauri::command]
fn list_backups(app_handle: tauri::AppHandle) -> Result<Vec<BackupEntry>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn restore_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn delete_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
async fn export_csv_data(csv: String, _filename: String) -> Result<String, String> {
    let mut content = "\u{FEFF}".to_string();
    content.push_str(&csv);
--

#[tauri::command]
async fn export_db_data(app_handle: tauri::AppHandle, include_log: bool) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    pack_db_container(&app_dir, include_log)
--

#[tauri::command]
async fn export_backup_data(app_handle: tauri::AppHandle, filename: String) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
--

#[tauri::command]
async fn export_backup_dialog(app_handle: tauri::AppHandle, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
''
