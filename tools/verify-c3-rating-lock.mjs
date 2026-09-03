#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C3 防回歸驗證 — mc/spell rateCard 連按雙寫 review_log（_ratingLock）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-c3-rating-lock.mjs
//       → 修法後（期望連按只寫 1 筆 review_log）ALL PASS
//   node --experimental-test-module-mocks tools/verify-c3-rating-lock.mjs --expect-logs 2
//       → 未修負控制（期望連按寫 2 筆 — bug 實錘）ALL PASS
//
// 真實度設計（只 mock 3 樣環境相依、其餘全真實）:
//   mock @tauri-apps/plugin-sql → FakeDatabase（node:sqlite in-memory，沿用 verify-c1 模式）
//   mock @tauri-apps/api/core   → no-op invoke
//   mock ../src/main.js         → toast stub（session-mc/spell/flip-utils 與 easter-eggs
//                                 唯一用到 main.js 的 export 就是 toast — 整檔 mock 掉，
//                                 連帶避開 main.js 的 DOM/tauri 啟動副作用）
//   真實: session-mc-utils / session-spell-utils / session-utils（flip）+ Session + FSRS
//         + store.actions.rateCard（真寫 state.reviewLog 與 in-memory DB review_log 表）
//   session 建立: ensureSession(store.state) + ensureQueue() — 真實 Session 真實排程
//   連按模擬: 同 tick 連發（p1 已進 await、p2 同步 prologue 緊接 — 最嚴苛時序）
//             + mid-flight +10ms 第二擊（模擬真實雙擊的第二個 click event）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGAIN, GOOD, STATE_NEW } from '../src/core/fsrs.js';

// easter-eggs（flip rateCard 會呼叫 checkAchievement）在 node 沒有 localStorage
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const EXPECT_LOGS = (() => {
  const i = process.argv.indexOf('--expect-logs');
  if (i >= 0) {
    const n = parseInt(process.argv[i + 1], 10);
    if (n === 1 || n === 2) return n;
    console.error('--expect-logs 只接受 1 或 2');
    process.exit(2);
  }
  return 1;
})();

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${got} expect=${expect}`);
}

// ── FakeDatabase（plugin-sql Database 的替身：包 node:sqlite in-memory）──
// 單例：db.js:14 的 Database.load('sqlite:teno.db') 每次呼叫都會拿到「同一個」實例 —
// 否則工具自己建的 fakeDb 與 db.js 內部用的 DB 是兩顆不同 in-memory DB。
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
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) {
    this.db.prepare(sql).run(this._bind(sql, params));
  }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

// ── mock 必須在 import src 模組之前註冊 ──
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

// ── 共用 setup：真實 store + FakeDatabase ──
let store = null;
let fakeDb = null;

const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

const mkNewCard = (id) => ({
  due: new Date(Date.now() - 60000).toISOString(), stability: 0, difficulty: 5,
  elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: STATE_NEW, step: 0,
  lastReview: null, buried: false, suspended: false, interval: 0, wordId: id,
});

async function resetState() {
  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: null, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki };
  s.ankiSettingsSpell = { ...anki };
  s.words = ['wA', 'wB', 'wC'].map((id, i) => mkWord(id, ['alpha', 'bravo', 'charlie'][i]));
  s.cards = new Map();
  s.cardsMc = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.cardsSpell = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0;
  s.newRatedTodayMc = 0;
  s.newRatedTodaySpell = 0;
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}

// 每個 mode 的「作答」前置（真實 UI 流程：QUESTION → ANSWER 才可評分）
function arm(utils, mode) {
  if (mode === 'mc') utils.pickAnswer(0);
  else if (mode === 'spell') utils.submitAnswer('zzz');
  else utils.flipCard(() => {});
}

const logCount = (mode, wid) => ({
  mem: store.state.reviewLog.filter(l => l.mode === mode && l.wordId === wid).length,
  db: fakeDb.db.prepare('SELECT COUNT(*) c FROM review_log WHERE word_id = ? AND mode = ?').get(wid, mode).c,
});

// 連按模擬：第一擊先發（進 await），第二擊緊接（同 tick 或 mid-flight +ms）
// wid 在 fire 前抓（被評的卡）；log 用 delta 計（同卡可能已有先前波次的 log）
async function doubleFire(utils, store, mode, { midFlightMs = 0, ratings = [GOOD, GOOD] } = {}) {
  if (!utils.session?.current) throw new Error(`[doubleFire] ${mode} 無 current 卡`);
  const wid = utils.session.current.word.id;
  const before = logCount(mode, wid);
  const renders = [];
  const render = () => renders.push(1);
  arm(utils, mode);
  const p1 = utils.rateCard(store, ratings[0], render);
  if (midFlightMs > 0) await new Promise(r => setTimeout(r, midFlightMs));
  const p2 = utils.rateCard(store, ratings[1], render);
  await Promise.allSettled([p1, p2]);
  const after = logCount(mode, wid);
  const wave = store.state.reviewLog.filter(l => l.mode === mode && l.wordId === wid).slice(before.mem);
  return {
    renders, wid,
    deltaMem: after.mem - before.mem, deltaDb: after.db - before.db,
    waveRatings: wave.map(l => l.rating),
  };
}

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  await resetState();

  console.log(`\n═══ C3 連按模擬（EXPECT_LOGS=${EXPECT_LOGS} — ${EXPECT_LOGS === 1 ? '修法後期望' : '未修負控制'}）═══`);

  // ── 1-3. mc：同 tick / mid-flight / 不同 rating 連按（同一 session 依序）──
  {
    const mc = await import('../src/engine/session-mc-utils.js');
    mc.ensureSession(store.state);
    check('mc ensureQueue', mc.ensureQueue(undefined, store.state), true);

    // 1. 同 tick 連按
    const s1 = await doubleFire(mc, store, 'mc');
    check('mc 同tick連按 本波新增 review_log(mem)', s1.deltaMem, EXPECT_LOGS);
    check('mc 同tick連按 本波新增 review_log(db)', s1.deltaDb, EXPECT_LOGS);
    check('mc 同tick連按 renderFn 次數', s1.renders.length, EXPECT_LOGS);

    // 2. mid-flight 連按（+10ms 第二擊 — 真實雙擊的第二個 click event）
    const orig = store.actions.rateCard;
    store.actions.rateCard = async (...a) => { await new Promise(r => setTimeout(r, 40)); return orig(...a); };
    const s2 = await doubleFire(mc, store, 'mc', { midFlightMs: 10 });
    store.actions.rateCard = orig;
    check('mc mid-flight連按 本波新增 review_log(mem)', s2.deltaMem, EXPECT_LOGS);
    check('mc mid-flight連按 本波新增 review_log(db)', s2.deltaDb, EXPECT_LOGS);
    check('mc mid-flight連按 renderFn 次數', s2.renders.length, EXPECT_LOGS);

    // 3. 不同 rating 連按（AGAIN→GOOD：4 個按鈕各自可點的情境）
    const s3 = await doubleFire(mc, store, 'mc', { ratings: [AGAIN, GOOD] });
    const expectRatings = EXPECT_LOGS === 1 ? [AGAIN] : [AGAIN, GOOD];
    check(`mc 不同rating連按 本波 log ratings=[${s3.waveRatings}]`, JSON.stringify(s3.waveRatings), JSON.stringify(expectRatings));
    check('mc 不同rating連按 renderFn 次數', s3.renders.length, EXPECT_LOGS);
  }

  // ── 4. mc 鎖釋放 → 可正常連續評分（核心補充驗證點；全新實例＋seed 新卡確保佇列非空）──
  //    若鎖未釋放（卡死 true），第二次 rateCard 會被擋 → log 只 +1、render 只 1 次 → FAIL
  {
    store.state.words.push(mkWord('wD', 'delta'));
    store.state.cardsMc.set('wD', mkNewCard('wD'));
    const mc2 = await import('../src/engine/session-mc-utils.js?r=release');
    mc2.ensureSession(store.state);
    check('mc 釋放測試 ensureQueue', mc2.ensureQueue(undefined, store.state), true);
    const totalMc = () => store.state.reviewLog.filter(l => l.mode === 'mc').length;
    const before = totalMc();
    const renders = [];
    arm(mc2, 'mc');
    await mc2.rateCard(store, GOOD, () => renders.push(1));   // 第 1 次正常評
    arm(mc2, 'mc');
    await mc2.rateCard(store, GOOD, () => renders.push(1));   // 第 2 次（同卡 learning 循環或下一張）
    check('mc 鎖釋放後連續 2 次評分 log+2', totalMc() - before, 2);
    check('mc 鎖釋放後 renderFn 2 次', renders.length, 2);
  }

  // ── 5. mc catch 解鎖（store 拋錯 → toast → 鎖釋放 → 下次評分正常）──
  {
    store.state.words.push(mkWord('wE', 'echo'));
    store.state.cardsMc.set('wE', mkNewCard('wE'));
    const mc3 = await import('../src/engine/session-mc-utils.js?r=catch');
    mc3.ensureSession(store.state);
    check('mc catch測試 ensureQueue', mc3.ensureQueue(undefined, store.state), true);
    const orig = store.actions.rateCard;
    let failNext = false;
    store.actions.rateCard = async (...a) => {
      if (failNext) { failNext = false; throw new Error('simulated db failure'); }
      return orig(...a);
    };
    const wid = mc3.session.current.word.id;
    const before = logCount('mc', wid);
    arm(mc3, 'mc');
    failNext = true;
    const renders1 = [];
    await mc3.rateCard(store, GOOD, () => renders1.push(1));   // → catch 分支
    check('mc catch 分支 renderFn 0 次（未評分）', renders1.length, 0);
    check('mc catch 分支 review_log 不新增', logCount('mc', wid).mem - before.mem, 0);
    check('mc catch 分支 current 卡不變', mc3.session.current.word.id, wid);
    // 鎖已釋放 → 再評一次正常
    arm(mc3, 'mc');
    const renders2 = [];
    await mc3.rateCard(store, GOOD, () => renders2.push(1));
    check('mc catch 解鎖後正常評分 renderFn 1 次', renders2.length, 1);
    check('mc catch 解鎖後 review_log +1', logCount('mc', wid).mem - before.mem, 1);
    store.actions.rateCard = orig;
  }

  // ── 6. spell 同 tick 連按 ──
  {
    const sp = await import('../src/engine/session-spell-utils.js');
    sp.ensureSession(store.state);
    check('spell ensureQueue', sp.ensureQueue(undefined, store.state), true);
    const s1 = await doubleFire(sp, store, 'spell');
    check('spell 同tick連按 本波新增 review_log(mem)', s1.deltaMem, EXPECT_LOGS);
    check('spell 同tick連按 本波新增 review_log(db)', s1.deltaDb, EXPECT_LOGS);
    check('spell 同tick連按 renderFn 次數', s1.renders.length, EXPECT_LOGS);
  }

  // ── 7. flip 回歸：連按仍只 1 筆（flip 原本就有鎖 — harness 參考基準）──
  {
    const fl = await import('../src/engine/session-utils.js');
    fl.ensureSession(store.state);
    check('flip ensureQueue', fl.ensureQueue(undefined, store.state), true);
    const s1 = await doubleFire(fl, store, 'flip');
    check('flip 連按 本波新增 review_log(mem)（恆 1）', s1.deltaMem, 1);
    check('flip 連按 本波新增 review_log(db)（恆 1）', s1.deltaDb, 1);
    check('flip 連按 renderFn 次數（恆 1）', s1.renders.length, 1);
  }

  console.log(failures === 0 ? '\n=== C3 連按模擬 ALL PASS ===' : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
