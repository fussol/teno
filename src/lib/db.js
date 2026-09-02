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
    await d.execute('DELETE FROM exam_history WHERE word = $1', [String(id)]);  // D20-SR1: B4 後之 word_id 世代
    if (wordText) await d.execute('DELETE FROM exam_history WHERE word = $1', [wordText]);  // D14: B4 前 legacy 文字世代(存文字)
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
    // D20-SR1: exam_history.word 雙世代（B4 後 word_id／B4 前 legacy 文字）兩族皆刪（對齊 CLI cmdDeleteDeck）
    await d.execute('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = $1)', [deckName]);   // B4 後 id 世代
    await d.execute('DELETE FROM exam_history WHERE word IN (SELECT word FROM words WHERE deck = $1)', [deckName]);  // B4 前 legacy 文字世代
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

/**
 * G7: single round-trip replacement for three getNewRatedToday() calls.
 * Returns { flip, mc, spell } new-rated-today counts. NULL-mode orphan rows
 * form their own group and are dropped — identical to three per-mode
 * `mode = $1` equality queries (db.js:536 semantics preserved).
 */
export async function getNewRatedTodayAll(todayStart, dayCutoff = 0, tzOffset = null) {
  const offset = tzOffset ?? -(new Date().getTimezoneOffset());
  const [y, m, d] = todayStart.split('-').map(Number);
  const boundaryUtc = new Date(Date.UTC(y, m - 1, d, 0, dayCutoff || 0) - offset * 60000)
    .toISOString();   // E2: full 24-char ISO with Z — same boundary math as getNewRatedToday
  const rows = await requireDB().select(
    'SELECT mode, COUNT(*) AS count FROM review_log WHERE card_state = 0 AND reviewed_at >= $1 GROUP BY mode',
    [boundaryUtc]
  );
  const out = { flip: 0, mc: 0, spell: 0 };
  for (const r of rows) if (out[r.mode] !== undefined) out[r.mode] = r.count;
  return out;
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
