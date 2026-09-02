#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C1 驗證: undo 快照模式隔離（多槽 _undoSnapshots[mode]）
// 層 1: 真實 store.js 驅動 — mock @tauri-apps/plugin-sql 注入 FakeDatabase
//       （node:sqlite in-memory），rateCard/undoLastRating 全真實路徑
// 層 2: in-memory SQLite 實測 §3.3a 定案 SQL 語意（NULL mode / id 邊界）
// 用法: node --experimental-test-module-mocks tools/verify-c1-undo-modes.mjs
// ═══════════════════════════════════════════════════════════════
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW } from '../src/core/fsrs.js';

// ── FakeDatabase（plugin-sql Database 的替身：包 node:sqlite in-memory）──
// 單例：db.js:14 的 Database.load('sqlite:teno.db') 每次呼叫都會拿到「同一個」實例 —
// 否則工具自己建的 fakeDb 與 db.js 內部用的 DB 是兩顆不同 in-memory DB，
// resetState 清表/斷言查詢全部打錯 DB（T2 跨 test DB 泄漏、T11d DB row 消失皆源於此）。
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
    // decks/folders（init 的 loadAll 會查）
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
  }
  // db.js 呼叫端傳位置陣列 → node:sqlite 不支援 $N 位置綁定 → 轉 named-object
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) {
    // C2: failNextSave 一次性旗標 — 模擬 saveCard 失敗（v3 補充防線的真實觸發條件）。
    // 僅攔 saveCard 的 INSERT INTO cards（db.js:200，src/ 內唯一）；cli.mjs 直寫不經此路徑。
    if (this.failNextSave && sql.trim().startsWith('INSERT INTO cards')) {
      this.failNextSave = false;
      throw new Error('simulated saveCard failure');
    }
    this.db.prepare(sql).run(this._bind(sql, params));
  }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

// ── mock 必須在 import db.js/store.js 之前註冊 ──
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });

let store = null;
let dbMod = null;
let fakeDb = null;

const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

const mkReviewCard = (over = {}) => ({
  due: new Date(Date.now() + 86400000).toISOString(), stability: 5, difficulty: 5,
  elapsedDays: 21, scheduledDays: 5, reps: 10, lapses: 0, state: STATE_REVIEW,
  step: 0, lastReview: new Date(Date.now() - 21 * 86400000).toISOString(),
  buried: false, suspended: false, interval: 5, ...over,
});

before(async () => {
  dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();   // 與 db.js initDB 內 load 共用同一單例（同 DB）
  await dbMod.initDB();   // migrate 對假 DB 執行（ALTER 失敗被既有 try/catch 吞）
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();   // 載入 scheduler/simulator/filterEngine；loadAll 可能中途 throw 被吞 — 之後覆寫 state
  await resetState();
});

async function resetState() {
  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: null, cardsPerDay: 80 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki };
  s.ankiSettingsSpell = { ...anki };
  s.words = [mkWord('wA', 'alpha'), mkWord('wB', 'bravo')];
  s.cards = new Map();
  s.cardsMc = new Map();
  s.cardsSpell = new Map();
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0;
  s.newRatedTodayMc = 0;
  s.newRatedTodaySpell = 0;
  fakeDb.db.exec('DELETE FROM cards');
  fakeDb.db.exec('DELETE FROM review_log');
  fakeDb.db.exec('DELETE FROM words');
  fakeDb.db.exec('DELETE FROM settings');
  fakeDb.db.exec('DELETE FROM goal_streak');
  fakeDb.db.exec('DELETE FROM audit_log');
  fakeDb.db.exec('DELETE FROM decks');
  fakeDb.db.exec('DELETE FROM folders');
  // C2 測試衛生：清 failNextSave（用後即清只保證消耗後清除 — 測試中途失敗提前退出會殘留）
  fakeDb.failNextSave = undefined;
}

const logModes = () => store.state.reviewLog.map(l => l.mode || 'flip').join(',');

// ═══════════ 層 1：真實 store 路徑 ═══════════

test('T1 交叉 undo 多槽選槽：flip 評 A → mc 評 B → 各自 undo 互不干擾', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  assert.ok(s.cards.has('wA'), 'flip 評分後 cards 有 A');
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');
  assert.ok(s.cardsMc.has('wB'), 'mc 評分後 cardsMc 有 B');

  // flip undo → 只還原 A（mc 槽保留）
  await store.actions.undoLastRating('flip');
  assert.ok(!s.cards.has('wA'), 'flip undo 後 A 卡回到評分前（new 卡無卡）');
  assert.ok(s.cardsMc.has('wB'), 'flip undo 不觸動 mc 槽 — B 保留');
  assert.ok(!!s._undoSnapshots.mc, 'mc 槽仍存在');

  // flip 再 undo → no-op（槽已刪）
  await store.actions.undoLastRating('flip');
  assert.ok(!s._undoSnapshots.flip, 'flip 槽已刪除');
  assert.ok(s.cardsMc.has('wB'), 'no-op 後 B 仍保留');

  // mc undo → 還原 B
  await store.actions.undoLastRating('mc');
  assert.ok(!s.cardsMc.has('wB'), 'mc undo 後 B 回到評分前');
  assert.ok(!s._undoSnapshots.mc, 'mc 槽已刪除');
});

test('T1b 同 mode 連續評分覆蓋自己的槽：undo 只回最後一步', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f1
  const afterF1 = s.cards.get('wA');
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f2（覆蓋 flip 槽）
  const afterF2 = s.cards.get('wA');
  assert.notEqual(afterF2.state, afterF1.state === undefined ? undefined : afterF1.state, '兩次評分狀態不同（learning 推進）');
  await store.actions.undoLastRating('flip');
  assert.deepEqual(s.cards.get('wA'), afterF1, 'undo 回 f1 後的狀態（只撤銷 f2）');
});

test('T2 計數器隔離：flip undo 只還原 newRatedToday，不動 newRatedTodayMc', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // new 卡 → flip log card_state=0
  const rtAfterFlip = s.newRatedToday;
  assert.ok(rtAfterFlip >= 1, `flip 評分後 newRatedToday=${rtAfterFlip} ≥ 1`);
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');     // new 卡 → mc log
  const mcAfterMc = s.newRatedTodayMc;
  assert.ok(mcAfterMc >= 1, `mc 評分後 newRatedTodayMc=${mcAfterMc} ≥ 1`);
  await store.actions.undoLastRating('flip');
  assert.equal(s.newRatedToday, 0, 'flip undo 後 newRatedToday 回 0（flip log 已刪）');
  assert.equal(s.newRatedTodayMc, mcAfterMc, 'mc 計數器不動');
});

test('T3 goalStreak 隔離：flip undo 只還原 dates.flip，dates.mc 保留', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  await store.actions.incrementGoal('flip');
  const flipDates = s.goalStreak.dates.flip;
  assert.ok(flipDates.length >= 1, 'flip 評分後 dates.flip 有今天');
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');
  await store.actions.incrementGoal('mc');
  const mcDates = [...s.goalStreak.dates.mc];
  assert.ok(mcDates.length >= 1, 'mc 評分後 dates.mc 有今天');

  await store.actions.undoLastRating('flip');
  assert.deepEqual(s.goalStreak.dates.flip, [], 'flip undo 後 dates.flip 回快照時（空）');
  assert.deepEqual(s.goalStreak.dates.mc, mcDates, 'dates.mc 全部保留');
  // current 為 per-mode 語意（§3.1h：current = computeStreak(dates[m])）— flip undo 只還原 flip dates（空）
  assert.equal(s.goalStreak.current, 0, 'current 依 flip dates（空）重算（per-mode，不動 mc）');
});

test('T4 reviewLog memory 過濾（場景 B：中段 splice）', async () => {
  await resetState();
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f1
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');     // m1
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f2（覆蓋 flip 槽）
  assert.equal(logModes(), 'flip,mc,flip');
  await store.actions.undoLastRating('flip');               // 移除 f2（baseline=1）
  assert.equal(logModes(), 'flip,mc', 'f2 被移除、m1 保留');
  await store.actions.undoLastRating('mc');                 // 移除 m1
  assert.equal(logModes(), 'flip');
});

test('T4b reviewLog memory 過濾（場景 A：交錯四筆）', async () => {
  await resetState();
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f1
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');     // m1
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');   // f2
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');     // m2
  assert.equal(logModes(), 'flip,mc,flip,mc');
  await store.actions.undoLastRating('flip');               // 移除 f2
  assert.equal(logModes(), 'flip,mc,mc');
  await store.actions.undoLastRating('mc');                 // 移除 m2
  assert.equal(logModes(), 'flip,mc');
});

test('T6 leech tag 精準還原：AGAIN 觸發 leech-flip → undo 移除（僅自己的 tag）', async () => {
  await resetState();
  const s = store.state;
  s.cards.set('wA', mkReviewCard({ lapses: 7 }));   // 再 AGAIN 一次 → lapses=8 ≥ threshold 8
  const wordA = () => s.words.find(w => w.id === 'wA');
  await store.actions.rateCard('wA', AGAIN, 5000, 'flip');
  assert.ok(wordA().tags.includes('leech-flip'), 'AGAIN 觸發 leech-flip push');
  await store.actions.undoLastRating('flip');
  assert.ok(!wordA().tags.includes('leech-flip'), 'undo 移除 leech-flip（leechTagBefore=false）');
  assert.deepEqual(wordA().tags, [], '無其他 tag 殘留');
});

test('T6b leech 精準還原：他 mode tag 不動', async () => {
  await resetState();
  const s = store.state;
  s.words[0].tags = ['leech-mc', 'custom'];
  s.cards.set('wA', mkReviewCard({ lapses: 7 }));
  await store.actions.rateCard('wA', AGAIN, 5000, 'flip');   // push leech-flip
  const w = s.words.find(x => x.id === 'wA');
  assert.deepEqual([...w.tags].sort(), ['custom', 'leech-flip', 'leech-mc'].sort());
  await store.actions.undoLastRating('flip');
  const w2 = s.words.find(x => x.id === 'wA');
  assert.deepEqual([...w2.tags].sort(), ['custom', 'leech-mc'].sort(), '只移除 leech-flip，他 mode/exam tag 不動');
});

test('T7 無快照防呆：未評分直接 undo → no-op 不拋異常', async () => {
  await resetState();
  await store.actions.undoLastRating('flip');
  await store.actions.undoLastRating('mc');
  await store.actions.undoLastRating('spell');
  assert.ok(true, '無快照 undo 全部 no-op');
});

test('T11 同卡跨 mode：(a) 核心隔離 (b) 合併保護 memory+DB 一致', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  const flipCardAfter = s.cards.get('wA');
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');
  const mcCardAfter = s.cardsMc.get('wA');
  assert.ok(s.cards.get('wA').mcData, 'mc 評分後 baseCard.mcData 已寫入（同引用）');

  await store.actions.undoLastRating('flip');
  // (a) 核心隔離：cardsMc 不被觸動、cards 回 flip 快照值（含保留的 mcData）
  assert.deepEqual(s.cardsMc.get('wA'), mcCardAfter, 'cardsMc 不被 flip undo 觸動');
  assert.deepEqual(s.cards.get('wA').mcData, mcCardAfter, '合併保護：flip undo 後 memory cards.mcData 保留 mc 值');
  // !hadCard 情境（flip 首評建立卡）：undo 以 restore 容器卡承接（§3.1c 勘誤 3 / §5-11(d)），state=0
  assert.equal(s.cards.get('wA').state, 0, '!hadCard：restore 容器卡 state=0（快照時無 flip 卡，非回 flip 評分後值）');
  // (b) DB 一致：reload 後 mcData 不遺失
  const row = fakeDb.db.prepare('SELECT mc_data FROM cards WHERE word_id = ?').get('wA');
  assert.ok(row && row.mc_data, 'DB cards.mc_data 保留');
  assert.deepEqual(JSON.parse(row.mc_data), mcCardAfter, 'DB mcData === mc 評分寫入值');
});

test('T11d 同卡跨 mode：!hadCard 情境（flip 首次建立 → mc 評 → flip undo 不刪卡）', async () => {
  await resetState();
  const s = store.state;
  // wB 無任何卡：首次由 flip 評分建立
  await store.actions.rateCard('wB', GOOD, 5000, 'flip');
  assert.ok(s.cards.has('wB'), 'flip 首次評分建立 cards 卡');
  await store.actions.rateCard('wB', GOOD, 5000, 'mc');
  const mcCardAfter = s.cardsMc.get('wB');

  await store.actions.undoLastRating('flip');   // hadCard=false（快照時無 flip 卡）+ live 有 mcData → restore 承接
  const row = fakeDb.db.prepare('SELECT mc_data, state, due FROM cards WHERE word_id = ?').get('wB');
  assert.ok(row, 'DB cards 行仍存在（未 deleteCard）');
  assert.deepEqual(JSON.parse(row.mc_data), mcCardAfter, 'restore 卡保留 mc 評分寫入值');
  assert.equal(row.state, 0, 'restore 卡 state=0（容器卡語意）');
  assert.equal(row.due, '', 'restore 卡無 due（A12 容器卡語意）');
  assert.deepEqual(s.cards.get('wB').mcData, mcCardAfter, 'memory 同步');
  assert.deepEqual(s.cardsMc.get('wB'), mcCardAfter, 'cardsMc 不被觸動');
});

// ═══════════ C2: flip undo mcData 保護（T12 系列 — 快照捕獲＋restore guard 放寬＋DB 檢查防線）═══════════

test('T12a flip 快照捕獲：flip 槽也有 prevBaseCardMcData/SpellData', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');
  const mcAfter = s.cardsMc.get('wA');
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  const flipSnap = s._undoSnapshots.flip;
  assert.ok(flipSnap.prevBaseCardMcData, 'flip 槽捕獲 prevBaseCardMcData（修法 3.1a：去 mode 排除）');
  assert.deepEqual(flipSnap.prevBaseCardMcData, mcAfter, '捕獲值 === cardsMc.get(A)（deepEqual）');
});

test("T12b flip undo 快照依據：!hadCard 情境不誤刪 DB mcData", async () => {
  await resetState();
  const s = store.state;
  // A 無既有 flip 卡（僅 mc 評過 — hadCard=false，走 C2 !hadCard 分支）
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');
  const mcCardAfter = s.cardsMc.get('wA');
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  assert.equal(s._undoSnapshots.flip.hadCard, false, 'flip 快照 hadCard=false');
  await store.actions.undoLastRating('flip');
  const row = fakeDb.db.prepare('SELECT mc_data, state, due FROM cards WHERE word_id = ?').get('wA');
  assert.ok(row, 'DB cards 行仍存在（未 deleteCard）');
  assert.deepEqual(JSON.parse(row.mc_data), mcCardAfter, 'DB mc_data 保留（=== mc 評分值）');
  assert.equal(row.state, 0, 'restore 容器卡 state=0（A12 語意）');
  assert.equal(row.due, '', "restore 容器卡 due=''");
  assert.deepEqual(s.cards.get('wA').mcData, mcCardAfter, 'memory state.cards 同步');
  assert.deepEqual(s.cardsMc.get('wA'), mcCardAfter, 'cardsMc 不被觸動');
});

test("T12b' merged 分支變體：hadCard=true 走 merged（state 非 0、mcData 保留）", async () => {
  await resetState();
  const s = store.state;
  // fixture 置 flip 卡（T6/T6b 同款既有寫法）→ 再 flip 評分（該次快照 hadCard=true）
  s.cards.set('wA', mkReviewCard());
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  const prevCard = s._undoSnapshots.flip.prevCard;
  assert.ok(prevCard, 'flip 快照 prevCard = fixture 卡');
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');
  const mcCardAfter = s.cardsMc.get('wA');
  await store.actions.undoLastRating('flip');
  // C1 merged 分支（:753-761）：state 回 prevCard.state（非 0）、mcData 保留
  const merged = s.cards.get('wA');
  assert.equal(merged.state, prevCard.state, 'merged 保留 prevCard.state');
  assert.notEqual(merged.state, 0, '非容器卡（state 非 0）— C2 未破壞 merged 路徑');
  assert.deepEqual(merged.mcData, mcCardAfter, 'mcData 保留（live 優先合併）');
});

test('T12c live 優先：undo 前他 mode 再評分 → 不回滾（快照值不作主源）', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');   // v1
  await store.actions.rateCard('wA', GOOD, 5000, 'flip'); // flip 快照捕獲 v1
  await store.actions.rateCard('wA', GOOD, 5000, 'mc');   // v2（:659 in-place 更新 live 卡 mcData）
  const v2 = s.cardsMc.get('wA');
  assert.deepEqual(s.cards.get('wA').mcData, v2, '前置：live 卡 mcData 已更新為 v2');
  await store.actions.undoLastRating('flip');
  assert.deepEqual(s.cards.get('wA').mcData, v2, 'restore 卡 mcData === v2（live 優先，不回滾他 mode 後續評分）');
});

test('T12d DB 分歧防線：flip 評分 saveCard 失敗 → undo delete 前 getCard 攔截', async () => {
  await resetState();
  const s = store.state;
  // DB 行帶 mc_data（模擬評分前 DB 已有他 mode 資料 — saveCard 失敗則 DB 保留舊行）
  const v1 = { word: 'wA', state: STATE_REVIEW, stability: 3, difficulty: 5, reps: 5, lapses: 0, scheduledDays: 10, due: new Date().toISOString() };
  fakeDb.db.prepare('INSERT INTO cards (word_id, due, state, mc_data) VALUES (?, ?, 0, ?)').run('wA', '', JSON.stringify(v1));
  // flip 評分 saveCard 失敗 → memory 有卡（:645/:667）、DB 保留舊行
  fakeDb.failNextSave = true;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  fakeDb.failNextSave = false;
  assert.ok(s.cards.has('wA'), 'flip 評分後 memory 有卡');
  const rowBefore = fakeDb.db.prepare('SELECT mc_data FROM cards WHERE word_id = ?').get('wA');
  assert.ok(rowBefore && rowBefore.mc_data, 'saveCard 失敗後 DB 保留 mc_data');
  // flip undo → delete 分支 → getCard 攔截 → restore 承接（不 deleteCard）
  await store.actions.undoLastRating('flip');
  const row = fakeDb.db.prepare('SELECT mc_data, state, due FROM cards WHERE word_id = ?').get('wA');
  assert.ok(row, 'DB 行仍存在（未 deleteCard）');
  assert.deepEqual(JSON.parse(row.mc_data), v1, 'DB mc_data 保留（getCard 攔截）');
  assert.equal(row.state, 0, 'restore 容器卡 state=0');
  assert.equal(row.due, '', "restore 容器卡 due=''");
  assert.deepEqual(s.cards.get('wA').mcData, v1, 'memory state.cards 同步');
  // reload 一致性：getAllCards 直接驗證（loadAll :218-221 同形 mapping — DB mc_data → cardsMc 重建）
  const cardsMap = await dbMod.getAllCards();
  const reloaded = cardsMap.get('wA');
  assert.ok(reloaded, 'getAllCards 有 A');
  assert.deepEqual(reloaded.mcData, v1, 'DB 真相源 reload 重建 mcData 一致');
});

test('T12e spell 對稱：spellData 路徑同形（捕獲＋undo 不誤刪）', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'spell');
  const spellAfter = s.cardsSpell.get('wA');
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  const flipSnap = s._undoSnapshots.flip;
  assert.deepEqual(flipSnap.prevBaseCardSpellData, spellAfter, 'flip 槽捕獲 prevBaseCardSpellData');
  await store.actions.undoLastRating('flip');
  const row = fakeDb.db.prepare('SELECT spell_data, state, due FROM cards WHERE word_id = ?').get('wA');
  assert.ok(row, 'DB 行仍存在');
  assert.deepEqual(JSON.parse(row.spell_data), spellAfter, 'DB spell_data 保留');
  assert.equal(row.state, 0, 'restore 容器卡 state=0');
  assert.deepEqual(s.cards.get('wA').spellData, spellAfter, 'memory 同步');
  assert.deepEqual(s.cardsSpell.get('wA'), spellAfter, 'cardsSpell 不被觸動');
});

test('T12f 純 flip 卡正常刪除：無他 mode 資料 → deleteCard 不誤傷', async () => {
  await resetState();
  const s = store.state;
  await store.actions.rateCard('wA', GOOD, 5000, 'flip');
  assert.ok(s.cards.has('wA'), 'flip 評分建立卡');
  await store.actions.undoLastRating('flip');
  const row = fakeDb.db.prepare('SELECT word_id FROM cards WHERE word_id = ?').get('wA');
  assert.ok(!row, 'DB 行已刪除（getCard 查到行但無他 mode 資料 → deleteCard）');
  assert.ok(!s.cards.has('wA'), 'memory 無卡');
});

// ═══════════ 層 2：定案 SQL 語意（node:sqlite 實跑 §3.3a）═══════════

const SQL = "DELETE FROM review_log WHERE id > $1 AND COALESCE(mode, 'flip') = $2";

function mkLogDb(modes) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT DEFAULT 'flip')");   // 層 2 需插 NULL mode 舊資料 → 不能 NOT NULL
  const ins = db.prepare('INSERT INTO review_log (mode) VALUES (?)');
  for (const m of modes) ins.run(m);
  return db;
}
const remaining = db => db.prepare('SELECT id, mode FROM review_log ORDER BY id').all().map(r => r.mode ?? 'NULL');

test('T5a SQL：NULL mode 舊資料只被 flip undo 刪（HIGH-1 回歸斷言）', () => {
  // mc undo → NULL 保留
  let db = mkLogDb(['flip', 'mc', 'spell', null]);
  db.prepare(SQL).run({ $1: 0, $2: 'mc' });
  assert.deepEqual(remaining(db), ['flip', 'spell', 'NULL'], 'mc undo 後 NULL 保留');
  db.close();
  // spell undo → NULL 保留
  db = mkLogDb(['flip', 'mc', 'spell', null]);
  db.prepare(SQL).run({ $1: 0, $2: 'spell' });
  assert.deepEqual(remaining(db), ['flip', 'mc', 'NULL'], 'spell undo 後 NULL 保留');
  db.close();
  // flip undo → NULL 視 flip 被刪
  db = mkLogDb(['flip', 'mc', 'spell', null]);
  db.prepare(SQL).run({ $1: 0, $2: 'flip' });
  assert.deepEqual(remaining(db), ['mc', 'spell'], 'flip undo 刪 flip+NULL');
  db.close();
});

test('T5b SQL：id > logId 邊界 + 他 mode 保留', () => {
  const db = mkLogDb(['flip', 'mc', 'spell']);
  db.prepare(SQL).run({ $1: 1, $2: 'flip' });   // logId=1 → 只刪 id>1 的 flip
  assert.deepEqual(remaining(db), ['flip', 'mc', 'spell'], 'logId=1 時無 flip 在 id>1 → 不刪');
  db.close();
  const db2 = mkLogDb(['flip', 'mc', 'flip']);
  db2.prepare(SQL).run({ $1: 1, $2: 'flip' });  // logId=1 → 刪 id=3 的 flip
  assert.deepEqual(remaining(db2), ['flip', 'mc'], '只刪 id>logId 且 mode=flip 的 entry');
  db2.close();
});

test('T5c 舊寫法對照：COALESCE(mode,$2)=$2 會誤刪 NULL（證明定案必要性）', () => {
  const db = mkLogDb(['flip', 'mc', 'spell', null]);
  db.prepare("DELETE FROM review_log WHERE id > $1 AND COALESCE(mode, $2) = $2").run({ $1: 0, $2: 'mc' });
  assert.deepEqual(remaining(db), ['flip', 'spell'], '舊寫法 NULL 被誤刪（實錘 HIGH-1）');
  db.close();
});

after(async () => {
  if (fakeDb) await fakeDb.close();
});
