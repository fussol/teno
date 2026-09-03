#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// A9 防回歸驗證 — rateCard 作答時間無上限截斷 bug（對齊 Anki cap_answer_time_to_secs）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-a9-duration-cap.mjs
//
// Anki 官方行為（rslib main 原始碼查證，2026-08-15）:
//   deckconfig/mod.rs:65   cap_answer_time_to_secs: 60   ← 預設 60 秒（合法範圍 1~9999，:297-302）
//   answering/mod.rs:60-62 fn cap_answer_secs(&mut self, max_secs: u32) {
//                            self.milliseconds_taken = self.milliseconds_taken.min(max_secs * 1000);
//                          }
//   answering/mod.rs:324   answer.cap_answer_secs(updater.config.inner.cap_answer_time_to_secs);
//                          ← 於 revlog 寫入前套用（add_partial_revlog → RevlogEntry.taken_millis）
//   即：taken_millis = min(taken_millis, cap_secs * 1000)，單位毫秒、預設 cap 60_000ms。
//
// teno duration 單位結論: 毫秒（ms）。呼叫端 session-utils/mc/spell-utils rateCard 皆傳
//   `Math.max(0, Date.now() - shownAt)`（Date.now() 為 ms）；store 內變數名即 durationMs；
//   dashboard.js:234 以 sumMs 累加。故 cap = 60 * 1000 = 60000ms 與 Anki 完全同構。
//
// 測試設計（真實 store + FakeDatabase，沿用 verify-a5/c3 harness）:
//   T1 正常 duration 不變（mem + db 雙寫）
//   T2 cap 邊界恰等 60000 → 不截
//   T3 超 cap 截斷（60001、1 小時）
//   T4 小數四捨五入行為保留（Math.round 先於 cap）
//   T5 負值/非數字（undefined/'abc'/NaN）→ null（既有防護不破壞）
//   T6 三 mode（flip/mc/spell）同一行 cap 一致生效
//   T7 負控制（剝除 Math.min cap → 超 cap 不被截斷，bug 必須再現 = 測試對修法敏感）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { STATE_REVIEW } from '../src/core/fsrs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.a9-neg-control.js');   // 負控制暫存檔（結束即刪）

// easter-eggs 等模組在 node 沒有 localStorage；loadAll 尾端會寫 window.__maxExampleLines、
// startAutoBackup 註冊 beforeunload — 補最小 stub
globalThis.localStorage = {
  getItem: (k) => (k === 'teno_no_seed' ? '1' : null),   // 跳過 seed，DB 全由 resetState 控制
  setItem: () => {}, removeItem: () => {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

// ── FakeDatabase（plugin-sql Database 的替身：包 node:sqlite in-memory，單例）──
class FakeDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this._initSchema();
  }
  static load() {
    if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase();
    return FakeDatabase._singleton;
  }
  _initSchema() {
    this.db.exec(`CREATE TABLE cards (
      word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL,
      elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER,
      state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER,
      mc_data TEXT, spell_data TEXT)`);
    this.db.exec(`CREATE TABLE review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER,
      elapsed_days REAL, scheduled_days REAL, stability REAL, difficulty REAL,
      mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER, reviewed_at TEXT)`);
    this.db.exec(`CREATE TABLE words (
      id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT,
      example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT,
      related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)');
    this.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
    this.db.exec('CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT, added_at TEXT)');
    this.db.exec('CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER, question_type TEXT, examined_at TEXT)');
    this.db.exec('CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)');
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

// ── mock 必須在 import src 模組之前註冊 ──
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

let store = null;
let fakeDb = null;

const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

const mkCard = (id, extra = {}) => ({
  due: new Date(Date.now() - 60000).toISOString(), stability: 2.5, difficulty: 5,
  elapsedDays: 1, scheduledDays: 1, reps: 2, lapses: 0, state: STATE_REVIEW, step: 0,
  lastReview: new Date(Date.now() - 86400000).toISOString(), buried: false, suspended: false,
  interval: 1, wordId: id, ...extra,
});

async function resetState(st = store) {
  const s = st.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: 480, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki };
  s.ankiSettingsSpell = { ...anki };
  s.words = ['wA', 'wB', 'wC', 'wD', 'wE'].map((id, i) => mkWord(id, ['alpha', 'bravo', 'charlie', 'delta', 'echo'][i]));
  const ids = ['wA', 'wB', 'wC', 'wD', 'wE'];
  s.cards = new Map(ids.map(id => [id, mkCard(id)]));
  s.cardsMc = new Map(ids.map(id => [id, mkCard(id, { marker: 'mc' })]));
  s.cardsSpell = new Map(ids.map(id => [id, mkCard(id, { marker: 'spell' })]));
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0;
  s.newRatedTodayMc = 0;
  s.newRatedTodaySpell = 0;
  s.buried = new Set();
  s.suspended = new Set();
  s.buriedMc = new Set();
  s.suspendedMc = new Set();
  s.buriedSpell = new Set();
  s.suspendedSpell = new Set();
  s.buriedAt = {};
  s.buriedAtMc = {};
  s.buriedAtSpell = {};
  st._resetUnburyGuard?.();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}

// 評一張卡並回傳 { mem: 記憶體 log 的 duration, db: review_log 表 duration }
async function rateAndRead(wid, rating, duration, mode = 'flip', st = store) {
  await st.actions.rateCard(wid, rating, duration, mode);
  const mem = st.state.reviewLog.at(-1)?.duration;
  const row = fakeDb.db.prepare('SELECT duration FROM review_log WHERE word_id = ? ORDER BY id DESC LIMIT 1').get(wid);
  return { mem, db: row ? row.duration : undefined };
}

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  await resetState();
  const s = store.state;

  console.log('\n═══ A9 作答時間 cap 防回歸（Anki cap_answer_time_to_secs=60s 對齊）═══');

  // ── T1 正常 duration（< cap）不變：mem + db 雙寫 ──
  {
    await resetState();
    const r = await rateAndRead('wA', 3, 1234, 'flip');
    check('T1 正常 1234ms mem 不變', r.mem, 1234);
    check('T1 正常 1234ms db 不變', r.db, 1234);
    check('T1 log 恰 1 筆', s.reviewLog.length, 1);
  }

  // ── T2 cap 邊界恰等 60000 → 不截斷 ──
  {
    await resetState();
    const r = await rateAndRead('wA', 3, 60000, 'flip');
    check('T2 恰等 cap 60000ms 不截', r.mem, 60000);
    check('T2 恰等 cap db 60000', r.db, 60000);
  }

  // ── T3 超 cap 截斷（60001 與 1 小時 outlier）──
  {
    await resetState();
    const r1 = await rateAndRead('wA', 3, 60001, 'flip');
    check('T3 60001ms → 截斷 60000', r1.mem, 60000);
    check('T3 60001ms db → 60000', r1.db, 60000);
    await resetState();
    const r2 = await rateAndRead('wA', 3, 3600000, 'flip');   // 1 小時：放置卡片很久的 outlier
    check('T3 3600000ms(1h) → 截斷 60000', r2.mem, 60000);
    check('T3 3600000ms(1h) db → 60000', r2.db, 60000);
  }

  // ── T4 小數四捨五入保留（Math.round 先於 cap）──
  {
    await resetState();
    const r1 = await rateAndRead('wA', 3, 1234.6, 'flip');
    check('T4 1234.6ms → round 1235', r1.mem, 1235);
    const r2 = await rateAndRead('wA', 3, 59999.6, 'flip');   // round → 60000 → cap 邊界仍 60000
    check('T4 59999.6ms → round 60000 = cap', r2.mem, 60000);
  }

  // ── T5 負值/非數字 → null（既有防護不破壞）──
  {
    await resetState();
    const r1 = await rateAndRead('wA', 3, -5, 'flip');
    check('T5 負值 -5 → null', r1.mem, null);
    check('T5 負值 db → null', r1.db, null);
    await resetState();
    const r2 = await rateAndRead('wA', 3, undefined, 'flip');
    check('T5 undefined → null', r2.mem, null);
    await resetState();
    const r3 = await rateAndRead('wA', 3, 'abc', 'flip');
    check('T5 字串 abc → null', r3.mem, null);
    await resetState();
    const r4 = await rateAndRead('wA', 3, NaN, 'flip');
    check('T5 NaN → null', r4.mem, null);
  }

  // ── T6 三 mode 同一行 cap 一致生效（mc/spell 也截斷）──
  {
    await resetState();
    const r1 = await rateAndRead('wA', 3, 3600000, 'mc');
    check('T6 mc 1h → 截斷 60000', r1.mem, 60000);
    check('T6 mc db → 60000', r1.db, 60000);
    await resetState();
    const r2 = await rateAndRead('wA', 3, 3600000, 'spell');
    check('T6 spell 1h → 截斷 60000', r2.mem, 60000);
    check('T6 spell db → 60000', r2.db, 60000);
    await resetState();
    const r3 = await rateAndRead('wA', 3, 2500, 'mc');
    check('T6 mc 正常 2500ms 不變', r3.mem, 2500);
  }

  // ── T7 負控制：剝除 Math.min cap → 超 cap 不被截斷（bug 必須再現 = 測試對修法敏感）──
  {
    let negStore = null;
    try {
      const src = fs.readFileSync(STORE_SRC, 'utf8');
      const cappedExpr = 'Math.min(Math.round(duration), CAP_ANSWER_TIME_MS)';
      const uncappedExpr = 'Math.round(duration)';
      if (!src.includes(cappedExpr)) throw new Error(`[harness] 源碼中找不到 cap 表達式 — ${STORE_SRC}`);
      fs.writeFileSync(NEG_TMP, src.replace(cappedExpr, uncappedExpr));
      const { createStore: createNegStore } = await import('../src/lib/.a9-neg-control.js');
      negStore = createNegStore();
      await negStore.actions.init();
      await resetState(negStore);
      const r = await rateAndRead('wA', 3, 3600000, 'flip', negStore);
      check('T7 無 cap → 1h 不被截斷（bug 再現）', r.mem, 3600000);
      check('T7 無 cap db 同為 1h', r.db, 3600000);
    } finally {
      if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);   // 暫存檔不留 repo
    }
  }

  console.log(`\n結果：${failures === 0 ? 'ALL PASS' : failures + ' 失敗'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
