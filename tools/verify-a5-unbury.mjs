#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// A5 防回歸驗證 — bury 永不自動解除（平行日期字串 + autoUnburyIfNewDay + migration）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-a5-unbury.mjs
//
// 真實度設計（沿用 verify-c3-rating-lock.mjs 模式，只 mock 3 樣環境相依）:
//   mock @tauri-apps/plugin-sql → FakeDatabase（node:sqlite in-memory，單例）
//   mock @tauri-apps/api/core   → no-op invoke
//   mock ../src/main.js         → toast stub
//   真實: store.actions.bury/unbury/suspend + autoUnburyIfNewDay + migrateBuriedAt
//         + getToday（T4b 用固定絕對時刻模擬跨日 + 各 mode 不同 tz 的比較）
//
// 8 大項（計畫書 §4.8）:
//   T1 埋卡 → buried Set + buriedAt 當日字串 + DB 同步
//   T2 同日檢查 → 不解除（guard + 日期比較）
//   T3 模擬跨天（buriedAt 設昨天）→ 自動解除（Set 不含、DB 清、base.buried=false）
//   T4 三 mode 各自獨立（flip 解除不影響 mc/spell）+ 各自 tz
//   T4b 比較用各 mode 自己的 today（同一個絕對時刻，tz 不同 → 跨日判斷不同）
//   T5 老資料 migration（無 buriedAt）→ 補 today → 明日解除；dayCutoff 邊界（00:00 不誤判）
//   T6 suspend 不受影響（不解除）；suspend 清 bury 交互
//   T7 session Set 引用不破（原地 delete）
//   T8 mc/spell saveCard 承接 mcData 不抹（container 存在 + container-only 合成兩路）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { STATE_REVIEW } from '../src/core/fsrs.js';
import { getToday } from '../src/core/scheduler.js';

// easter-eggs 等模組在 node 沒有 localStorage；loadAll 尾端（migration/autoUnbury）
// 之前會寫 window.__maxExampleLines、startAutoBackup 註冊 beforeunload — 補最小 stub
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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
    // loadAll 完整路徑所需（c3 schema 缺這幾張 → init 提前 bail，loadAll 尾端的
    // migrateBuriedAt/autoUnburyIfNewDay 沒跑到；補齊讓整條 init 路徑可測）
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
mock.module('../src/main.js', { exports: { toast() {} } });

let store = null;
let fakeDb = null;

const TZ_FLIP = 480, TZ_MC = 120, TZ_SPELL = 480;

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

async function resetState() {
  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: TZ_FLIP, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki, timezoneOffset: TZ_MC };
  s.ankiSettingsSpell = { ...anki, timezoneOffset: TZ_SPELL };
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
  store._resetUnburyGuard();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}

const getSettingVal = (key) => {
  const r = fakeDb.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
};
const getCardRow = (wid) => fakeDb.db.prepare('SELECT * FROM cards WHERE word_id = ?').get(wid);

function nextDayStr(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function prevDayStr(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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

  console.log('\n═══ A5 跨日自動 unbury 防回歸 ═══');

  // ── T1 埋卡 → buried Set 含 id + buriedAt 有當日字串 + DB 同步 ──
  {
    await resetState();
    const today = getToday(0, TZ_FLIP);
    await store.actions.bury('wA', 'flip');
    check('T1 flip buried Set 含 wA', s.buried.has('wA'), true);
    check('T1 buriedAt[wA] = 當日字串', s.buriedAt.wA, today);
    check('T1 DB settings buried', getSettingVal('buried'), ['wA']);
    check('T1 DB settings buriedAt', getSettingVal('buriedAt'), { wA: today });
    check('T1 card.buried=true', s.cards.get('wA').buried, true);
    check('T1 DB card row buried=1', getCardRow('wA')?.buried, 1);
  }

  // ── T2 同日檢查 → 不解除（guard + 日期比較）──
  {
    await resetState();
    const today = getToday(0, TZ_FLIP);
    await store.actions.bury('wA', 'flip');
    await store._autoUnburyIfNewDay();
    check('T2 同日檢查 不解除 Set', s.buried.has('wA'), true);
    check('T2 同日檢查 不解除 buriedAt', s.buriedAt.wA, today);
    await store._autoUnburyIfNewDay();   // guard 擋重複
    check('T2 guard 重複呼叫仍不解除', s.buried.has('wA'), true);
  }

  // ── T3 模擬跨天（buriedAt 設昨天字串）→ 自動解除 ──
  {
    await resetState();
    await store.actions.bury('wA', 'flip');
    s.buriedAt.wA = prevDayStr(getToday(0, TZ_FLIP));   // 模擬跨天
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();
    check('T3 跨日自動解除 Set 不含', s.buried.has('wA'), false);
    check('T3 跨日自動解除 buriedAt 清', s.buriedAt.wA, undefined);
    check('T3 DB settings buried 清空', getSettingVal('buried'), []);
    check('T3 DB settings buriedAt 清空', getSettingVal('buriedAt'), {});
    check('T3 base.buried=false', s.cards.get('wA').buried, false);
    check('T3 DB card row buried=0', getCardRow('wA')?.buried, 0);
  }

  // ── T4 三 mode 各自獨立 + 各自 tz ──
  {
    await resetState();
    await store.actions.bury('wA', 'flip');
    await store.actions.bury('wA', 'mc');
    await store.actions.bury('wA', 'spell');
    check('T4 flip buriedAt 用 flip tz', s.buriedAt.wA, getToday(0, TZ_FLIP));
    check('T4 mc buriedAt 用 mc tz', s.buriedAtMc.wA, getToday(0, TZ_MC));
    check('T4 spell buriedAt 用 spell tz', s.buriedAtSpell.wA, getToday(0, TZ_SPELL));
    // 只有 flip 跨日 → 只有 flip 解除
    s.buriedAt.wA = prevDayStr(getToday(0, TZ_FLIP));
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();
    check('T4 flip 跨日解除', s.buried.has('wA'), false);
    check('T4 mc 不受影響', s.buriedMc.has('wA'), true);
    check('T4 spell 不受影響', s.buriedSpell.has('wA'), true);
  }

  // ── T4b 比較用各 mode 自己的 today（同一絕對時刻、tz 不同 → 跨日判斷不同）──
  {
    await resetState();
    s.ankiSettings.timezoneOffset = TZ_FLIP;
    s.ankiSettingsMc.timezoneOffset = TZ_MC;
    s.buried = new Set(['wA']);
    s.buriedMc = new Set(['wA']);
    s.buriedAt = { wA: '2026-08-15' };
    s.buriedAtMc = { wA: '2026-08-15' };
    store._resetUnburyGuard();
    // 2026-08-15T20:30Z：flip(+8) → 08-16（已跨日）；mc(+2) → 08-15（未跨日）
    await store._autoUnburyIfNewDay(new Date(Date.UTC(2026, 7, 15, 20, 30)));
    check('T4b flip(+8) 20:30Z 已跨日 → 解除', s.buried.has('wA'), false);
    check('T4b mc(+2) 20:30Z 未跨日 → 保留', s.buriedMc.has('wA'), true);
  }

  // ── T5 老資料 migration（無 buriedAt）→ 補 today → 明日解除；dayCutoff 邊界 ──
  {
    await resetState();
    const tFlip = getToday(0, TZ_FLIP);
    const tMc = getToday(0, TZ_MC);
    // 老資料：buried Set 有、buriedAt 無記錄
    s.buried = new Set(['wA']);
    s.buriedMc = new Set(['wA']);
    s.buriedAt = {};
    s.buriedAtMc = {};
    s.buriedAtSpell = {};
    await store._migrateBuriedAt();
    check('T5 老卡補 today(flip)', s.buriedAt.wA, tFlip);
    check('T5 老卡補 today(mc)', s.buriedAtMc.wA, tMc);
    check('T5 DB buriedAt 落庫', getSettingVal('buriedAt'), { wA: tFlip });
    // 補 today 後「明日」解除（今天保留）
    s.buriedAt.wA = prevDayStr(tFlip);
    s.buriedAtMc.wA = prevDayStr(tMc);
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();
    check('T5 補 today 後明日解除(flip)', s.buried.has('wA'), false);
    check('T5 補 today 後明日解除(mc)', s.buriedMc.has('wA'), false);
    // dayCutoff 邊界：00:00 不誤判（絕對時刻 → 系統 tz 無關）
    check('T5 cutoff480 23:00Z(+8)=前日', getToday(480, TZ_FLIP, new Date(Date.UTC(2026, 7, 15, 23, 0))), '2026-08-15');
    check('T5 cutoff480 23:59Z(+8)=前日', getToday(480, TZ_FLIP, new Date(Date.UTC(2026, 7, 15, 23, 59))), '2026-08-15');
    check('T5 cutoff480 00:00Z(+8)=同日(邊界不誤判)', getToday(480, TZ_FLIP, new Date(Date.UTC(2026, 7, 16, 0, 0))), '2026-08-16');
    check('T5 cutoff480 00:30Z(+8)=同日', getToday(480, TZ_FLIP, new Date(Date.UTC(2026, 7, 16, 0, 30))), '2026-08-16');
    check('T5 cutoff0 00:30Z(+8) 不誤判', getToday(0, TZ_FLIP, new Date(Date.UTC(2026, 7, 16, 0, 30))), '2026-08-16');
  }

  // ── T6 suspend 不受影響（不解除）；suspend 清 bury 交互 ──
  {
    await resetState();
    await store.actions.bury('wA', 'flip');
    await store.actions.suspend('wA', 'flip');
    check('T6 suspend 清 bury Set', s.buried.has('wA'), false);
    check('T6 suspend 清 buriedAt', s.buriedAt.wA, undefined);
    check('T6 suspended Set 含 wA', s.suspended.has('wA'), true);
    check('T6 DB buried 清空', getSettingVal('buried'), []);
    check('T6 DB buriedAt 清空', getSettingVal('buriedAt'), {});
    check('T6 DB suspended', getSettingVal('suspended'), ['wA']);
    check('T6 card suspended=true buried=false', [s.cards.get('wA').suspended, s.cards.get('wA').buried], [true, false]);
    check('T6 DB row suspended=1 buried=0', [getCardRow('wA')?.suspended, getCardRow('wA')?.buried], [1, 0]);
    // 純 suspend（無 bury）不受跨日解除影響
    await store.actions.suspend('wB', 'flip');
    s.buriedAt.wA = prevDayStr(getToday(0, TZ_FLIP));   // 若 bury 殘留也該被清
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();
    check('T6 跨日不解除 suspend', s.suspended.has('wB'), true);
    check('T6 跨日 suspend 未誤入解除流程', s.suspended.has('wB'), true);
  }

  // ── T7 session Set 引用不破（原地 delete）──
  {
    await resetState();
    await store.actions.bury('wA', 'flip');
    const ref = s.buried;
    const { Session } = await import('../src/engine/session-v4.js');
    const sess = new Session({ words: s.words, cards: s.cards, buried: ref, suspended: s.suspended, dayCutoff: 0, timezoneOffset: TZ_FLIP });
    check('T7 session 拿到同一個 Set 引用', sess.buried === ref, true);
    s.buriedAt.wA = prevDayStr(getToday(0, TZ_FLIP));
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();
    check('T7 原地 delete Set 引用不破', s.buried === ref, true);
    check('T7 state Set 同步看到解除', ref.has('wA'), false);
    check('T7 session Set 同步看到解除', sess.buried.has('wA'), false);
  }

  // ── T8 mc/spell saveCard 承接 mcData 不抹（container 存在 + container-only 合成兩路）──
  {
    await resetState();
    // wC：container 卡含 mcData+spellData（flip 也有卡 → 承接路徑）
    const mcWc = mkCard('wC', { reps: 5, marker: 'keep-mc', buried: false });
    const spWc = mkCard('wC', { marker: 'keep-spell', buried: false });
    s.cards.set('wC', mkCard('wC', { mcData: { ...mcWc }, spellData: { ...spWc } }));
    s.cardsMc.set('wC', { ...mcWc });
    fakeDb.db.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('wC', mcWc.due, 2.5, 5, 1, 1, 3, 0, STATE_REVIEW, 0, mcWc.lastReview, 0, 0, JSON.stringify(mcWc), JSON.stringify(spWc));
    // wD：mc-only（container 卡不存在 → container-only 過濾後的常見情況 → 合成路徑）
    const mcWd = mkCard('wD', { marker: 'keep-mc-d', buried: false });
    s.cardsMc.set('wD', { ...mcWd });
    fakeDb.db.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('wD', mcWd.due, 2.5, 5, 1, 1, 1, 0, STATE_REVIEW, 0, mcWd.lastReview, 0, 0, JSON.stringify(mcWd), null);
    // wE：spell-only（合成路徑）
    const spWe = mkCard('wE', { marker: 'keep-spell-e', buried: false });
    s.cardsSpell.set('wE', { ...spWe });
    fakeDb.db.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('wE', spWe.due, 2.5, 5, 1, 1, 1, 0, STATE_REVIEW, 0, spWe.lastReview, 0, 0, null, JSON.stringify(spWe));

    await store.actions.bury('wC', 'mc');
    await store.actions.bury('wD', 'mc');
    await store.actions.bury('wE', 'spell');
    // 三 mode 全部跨日（埋卡日一律設成固定過去日期 → 真實 now 必定大於它）
    s.buriedAtMc.wC = '2026-01-01';
    s.buriedAtMc.wD = '2026-01-01';
    s.buriedAtSpell.wE = '2026-01-01';
    store._resetUnburyGuard();
    await store._autoUnburyIfNewDay();

    const rowC = getCardRow('wC');
    const mcC = JSON.parse(rowC.mc_data);
    const spC = JSON.parse(rowC.spell_data);
    check('T8 mc 承接 mcData marker 不抹', mcC.marker, 'keep-mc');
    check('T8 mc 解除後 buried=false', mcC.buried, false);
    check('T8 mc 承接 spellData 不抹', spC.marker, 'keep-spell');
    const rowD = getCardRow('wD');
    const mcD = JSON.parse(rowD.mc_data);
    check('T8 mc-only 合成 container 承接 marker', mcD.marker, 'keep-mc-d');
    check('T8 mc-only 解除後 buried=false', mcD.buried, false);
    const rowE = getCardRow('wE');
    const spE = JSON.parse(rowE.spell_data);
    check('T8 spell-only 合成 container 承接 marker', spE.marker, 'keep-spell-e');
    check('T8 spell-only 解除後 buried=false', spE.buried, false);
    check('T8 wC spell_data 原樣未抹', rowC.spell_data != null, true);
  }

  // ── T9 啟動路徑整合：loadAll 尾端 migration + autoUnbury（老資料進 DB → 新 store init）──
  {
    await resetState();
    // 老資料：buried=['wA'] 但無 buriedAt key（v1.0 前的既有資料）
    fakeDb.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('buried', JSON.stringify(['wA']));
    fakeDb.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ankiSettings', JSON.stringify({ timezoneOffset: TZ_FLIP }));
    fakeDb.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ankiSettingsMc', JSON.stringify({ timezoneOffset: TZ_MC }));
    fakeDb.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ankiSettingsSpell', JSON.stringify({ timezoneOffset: TZ_SPELL }));
    fakeDb.db.prepare(`INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, created_at, related, forms, synonym, antonym, derivative, examples)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('wA', 'alpha', 'def', 'n', '', '', 'Default', '[]', '', '', new Date().toISOString(), '[]', '[]', '', '', '', '[]');
    fakeDb.db.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('wA', new Date(Date.now() - 60000).toISOString(), 2.5, 5, 1, 1, 2, 0, STATE_REVIEW, 0, new Date(Date.now() - 86400000).toISOString(), 0, 0, null, null);
    const { createStore: createStore2 } = await import('../src/lib/store.js');
    const store2 = createStore2();
    await store2.actions.init();
    const s2 = store2.state;
    const tFlip = getToday(0, TZ_FLIP);
    check('T9 loadAll migration 補 today', s2.buriedAt.wA, tFlip);
    check('T9 loadAll migration DB 落庫', getSettingVal('buriedAt'), { wA: tFlip });
    check('T9 啟動同日不解除', s2.buried.has('wA'), true);
    check('T9 loadAll 完整跑完 ready=true', s2.ready, true);
  }

  console.log(failures === 0 ? '\n=== A5 跨日自動 unbury ALL PASS ===' : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
