#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// A10 防回歸驗證 — due 錨定 Anki 日界線（next_day_at），非作答時刻
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-a10-due-anchor.mjs
//
// Bug（audit + 實錘）: store.js rateCard 舊公式 `due = Date.now() +
//   round(dueDays * 86400000)` 錨定「作答時刻」：
//   1. 23:50 作答 → due 23:50+interval；00:10 作答（同日界線）→ due 00:10+interval
//      — 同一天界線內作答，due 時間抖動近 24h（Anki 錨定日界線 08:00）
//   2. 日級小數 step（如 relearn 1.5d）：08:30 作答 due 日 = +1、23:50 作答 = +2
//      （「早一天到期」抖動）；scheduledDays = round(1.5) = 2 但 due 未捨入
//
// Anki 官方公式（rslib main 原始碼查證，2026-08-15）:
//   - Review 卡作答後: card.due = days_elapsed + scheduled_days（天數制）
//     rslib/src/scheduler/answering/review.rs:20
//     → 到期日 = 今天日界線起算 + interval 天，與作答時刻無關
//   - 日界線: SchedTimingToday.next_day_at（scheduler/timing.rs
//     sched_timing_today_v2_new）→ 到期時間戳 = next_day_at + (X-1)*86400 秒
//   - 學習卡 sub-day step: due = now + step 秒（intraday 時間戳,
//     answering/learning.rs fuzzed_next_learning_timestamp）；
//     ≥ 1 天 step: 轉 DayLearn 天數制 due = days_elapsed + days
//
// 修法: scheduler.js 新增 nextDayAtMs() + computeDueIso()；store.rateCard 與
//   tools/cli.mjs rate 統一改走 computeDueIso — Review/日級 step → 日界線錨定；
//   sub-day 學習 step → intraday now+step（既有 60s 下限保留）。
//
// 測試設計（真實 store + FakeDatabase + mock.timers Date 沙箱，沿用 a9/c3 harness）:
//   T1  23:50 vs 00:10 同日界線 → due 完全相同（無抖動）+ 到期日 = 今日+X + 時刻=08:00
//   T2  日級小數 step 1.5d：08:30 vs 23:50 → due 日一致（今日+2）；scheduledDays 一致
//   T3  fractional dueDays round 一致性（5.4→5、5.6→6）：due 日 == 今日+round
//   T4  sub-day 學習 step 不變（intraday now+10min）+ 60s 下限
//   T5  getDueCards 到期判斷不受影響（X=6/X=1 今天不到期；逾期 & intraday 到期）
//   T6  dayCutoff=0 退化：X=1 → due = 下一個午夜、到期日 = 明天
//   T7  跨日界線邊界：07:59（teno日=昨天）vs 08:00（teno日=今天）各 +X 正確
//   T8  e2e rateCard（mock.timers Date 沙箱）：23:50 vs 00:10 作答 → due 相同；
//       到期日 == getToday + scheduledDays；due 時刻 == 08:00 日界線
//   T9  負控制（剝除 computeDueIso 改回舊公式 → bug 必須再現 = 測試對修法敏感）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { STATE_REVIEW, STATE_LEARNING } from '../src/core/fsrs.js';
import { getToday, toLocalDateStr, computeDueIso, nextDayAtMs, getDueCards } from '../src/core/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.a10-neg-control.js');

// A10 測試設定：UTC+8、08:00 日界線
const TZ = 480;
const CUTOFF = 480;
const DAY = 86400000;
const base = Date.UTC(2026, 7, 12);                  // 2026-08-12（週三）
const nowA = base + (15 * 60 + 50) * 60000;          // 2026-08-12T23:50+08:00
const nowB = base + 16 * 3600000 + 10 * 60000;       // 2026-08-13T00:10+08:00（同日界線 → teno 日仍 08-12）

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

/** YYYY-MM-DD + n 天（UTC 曆法運算，與 teno date 字串慣例一致） */
function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 取 due ISO 的 tz 本地時刻 HH:MM（驗證日界線錨定時刻） */
function localHM(iso, tz) {
  const d = new Date(new Date(iso).getTime() + tz * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ── T1 23:50 vs 00:10 同日界線 → due 完全相同（無抖動）──
{
  const tdA = getToday(CUTOFF, TZ, nowA);
  const tdB = getToday(CUTOFF, TZ, nowB);
  check('T1 teno 日一致（23:50 == 00:10 同日界線）', [tdA, tdB], ['2026-08-12', '2026-08-12']);
  const dueA = computeDueIso(6, STATE_REVIEW, CUTOFF, TZ, nowA);
  const dueB = computeDueIso(6, STATE_REVIEW, CUTOFF, TZ, nowB);
  check('T1 23:50 vs 00:10 due 完全相同（日界線錨定，無抖動）', dueA, dueB);
  check('T1 due 到期日 == teno日+6', toLocalDateStr(new Date(dueA), TZ, CUTOFF), addDays(tdA, 6));
  check('T1 due 時刻 == 08:00 日界線', localHM(dueA, TZ), '08:00');
  check('T1 nextDayAtMs 一致性（-1天 = teno日當天起點）',
    toLocalDateStr(new Date(nextDayAtMs(CUTOFF, TZ, nowA) - DAY), TZ, CUTOFF), tdA);
}

// ── T2 日級小數 step 1.5d：作答時刻不同 → due 日仍一致 ──
{
  const t830 = base + (8 * 60 + 30) * 60000;   // 08:30（teno 日 08-12）
  const due1 = computeDueIso(1.5, STATE_LEARNING, CUTOFF, TZ, t830);
  const due2 = computeDueIso(1.5, STATE_LEARNING, CUTOFF, TZ, nowA);
  check('T2 1.5d step 08:30 vs 23:50 due 日一致（= teno日+round(1.5)=+2）',
    toLocalDateStr(new Date(due1), TZ, CUTOFF), toLocalDateStr(new Date(due2), TZ, CUTOFF));
  check('T2 due 日 == teno日+2', toLocalDateStr(new Date(due2), TZ, CUTOFF), '2026-08-14');
  check('T2 scheduledDays(round) 與 due 一致', toLocalDateStr(new Date(due2), TZ, CUTOFF), addDays('2026-08-12', Math.round(1.5)));
}

// ── T3 fractional dueDays round 一致性（5.4→5、5.6→6）──
{
  for (const [dueDays, x] of [[5.4, 5], [5.6, 6]]) {
    const due = computeDueIso(dueDays, STATE_REVIEW, CUTOFF, TZ, base + (8 * 60 + 30) * 60000);
    check(`T3 dueDays=${dueDays} → due 日 == teno日+round(${dueDays})=+${x}`,
      toLocalDateStr(new Date(due), TZ, CUTOFF), addDays('2026-08-12', x));
  }
}

// ── T4 sub-day 學習 step 不變（intraday now+step）+ 60s 下限 ──
{
  const t = base + (8 * 60 + 30) * 60000;
  const step10m = computeDueIso(10 / 1440, STATE_LEARNING, CUTOFF, TZ, t);
  check('T4 10min step → due = now+10min（±1s）',
    Math.abs(new Date(step10m).getTime() - (t + 600000)) < 1000, true);
  const step1m = computeDueIso(1 / 1440, STATE_LEARNING, CUTOFF, TZ, t);
  check('T4 1min step → 60s 下限保留（due-now == 60000）',
    new Date(step1m).getTime() - t, 60000);
}

// ── T5 getDueCards 到期判斷不受影響 ──
{
  const now = nowA;
  const words = ['w6', 'w1', 'wL', 'wO'].map(id => ({ id, word: id }));
  const mk = (state, due) => ({ due, stability: 2.5, difficulty: 5, elapsedDays: 1, scheduledDays: 1, reps: 2, lapses: 0, state, step: 0, lastReview: null, buried: false, suspended: false, interval: 1 });
  const cards = new Map([
    ['w6', mk(STATE_REVIEW, computeDueIso(6, STATE_REVIEW, CUTOFF, TZ, now))],  // X=6 → 今天不到期
    ['w1', mk(STATE_REVIEW, computeDueIso(1, STATE_REVIEW, CUTOFF, TZ, now))],  // X=1 → 今天不到期
    ['wL', mk(STATE_LEARNING, computeDueIso(10 / 1440, STATE_LEARNING, CUTOFF, TZ, now))], // intraday → 到期
    ['wO', mk(STATE_REVIEW, '2026-08-01T00:00:00.000Z')],                       // 逾期 → 到期
  ]);
  const { due } = getDueCards(words, cards, new Set(), new Set(), 0, CUTOFF, TZ, 0, new Date(now).toISOString());
  const ids = due.map(w => w.id).sort();
  check('T5 getDueCards：僅 intraday + 逾期到期', ids, ['wL', 'wO']);
}

// ── T6 dayCutoff=0 退化（午夜日界線）──
{
  const t = base + (23 * 60 + 50) * 60000;   // 23:50 UTC
  const due = computeDueIso(1, STATE_REVIEW, 0, 0, t);
  const dueDate = toLocalDateStr(new Date(due), 0, 0);
  check('T6 cutoff=0 X=1 → due = 下一個午夜', new Date(due).toISOString().slice(11, 19), '00:00:00');
  check('T6 cutoff=0 X=1 → 到期日 = 明天', dueDate, '2026-08-13');
  const due6 = computeDueIso(6, STATE_REVIEW, 0, 0, t);
  check('T6 cutoff=0 X=6 → 到期日 = 今天+6', toLocalDateStr(new Date(due6), 0, 0), '2026-08-18');
}

// ── T7 跨日界線邊界：07:59（teno日=昨天）vs 08:00（teno日=今天）──
{
  const t759 = base - 60000;                       // 2026-08-11T23:59Z = 08-12T07:59+08:00 → teno 日 08-11
  const t800 = base + 8 * 3600000;                 // 08:00+08:00 → teno 日 08-12
  check('T7 07:59 teno 日 = 前一天', getToday(CUTOFF, TZ, t759), '2026-08-11');
  check('T7 08:00 teno 日 = 當天', getToday(CUTOFF, TZ, t800), '2026-08-12');
  for (const X of [1, 6]) {
    const d1 = computeDueIso(X, STATE_REVIEW, CUTOFF, TZ, t759);
    const d2 = computeDueIso(X, STATE_REVIEW, CUTOFF, TZ, t800);
    check(`T7 07:59 X=${X} → due 日 = 昨天+X`, toLocalDateStr(new Date(d1), TZ, CUTOFF), addDays('2026-08-11', X));
    check(`T7 08:00 X=${X} → due 日 = 今天+X`, toLocalDateStr(new Date(d2), TZ, CUTOFF), addDays('2026-08-12', X));
  }
}

// ═══════════ e2e harness（真實 store + FakeDatabase）═══════════

globalThis.localStorage = {
  getItem: (k) => (k === 'teno_no_seed' ? '1' : null),
  setItem: () => {}, removeItem: () => {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

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

mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/main.js', { exports: { toast() {} } });

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
  s.dayCutoff = CUTOFF;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: TZ, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
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

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  await resetState();

  console.log('\n═══ A10 due 日界線錨定 防回歸（Anki next_day_at 對齊）═══');

  // ── T8 e2e rateCard（Date 沙箱）：23:50 vs 00:10 作答 → due 相同 ──
  mock.timers.enable({ apis: ['Date'], now: nowA });
  try {
    await resetState();
    await store.actions.rateCard('wA', 2, 1000, 'flip');   // GOOD on REVIEW card → 新 interval
    const c1 = store.state.cards.get('wA');
    const todayA = getToday(CUTOFF, TZ, nowA);
    check('T8 rate 後 state REVIEW', c1.state, STATE_REVIEW);
    check('T8 due 到期日 == getToday + scheduledDays',
      toLocalDateStr(new Date(c1.due), TZ, CUTOFF), addDays(todayA, c1.scheduledDays));
    check('T8 due 時刻 == 08:00 日界線', localHM(c1.due, TZ), '08:00');

    // 同日界線 00:10 再評同一張卡（fuzz 同 wordId → 同 interval）→ due 必須相同
    mock.timers.setTime(nowB);
    await resetState();
    await store.actions.rateCard('wA', 2, 1000, 'flip');
    const c2 = store.state.cards.get('wA');
    check('T8 e2e 23:50 vs 00:10 due 相同（無抖動）', c2.due, c1.due);
    check('T8 e2e scheduledDays 一致', c2.scheduledDays, c1.scheduledDays);

    // 日級小數 step e2e：learnSteps 2160min=1.5d，AGAIN 新卡 → LEARNING step 1.5d
    await resetState();
    store.state.words.push(mkWord('wF', 'foxtrot'));   // 無卡 → 新卡
    store.state.ankiSettings.learnSteps = '2160';       // 1.5 天 step
    store.state.ankiSettingsMc.learnSteps = '2160';
    store.state.ankiSettingsSpell.learnSteps = '2160';
    mock.timers.setTime(base + (8 * 60 + 30) * 60000);   // 08:30
    await store.actions.rateCard('wF', 0, 500, 'flip'); // AGAIN → LEARNING
    const l1 = store.state.cards.get('wF');
    await resetState();
    store.state.words.push(mkWord('wF', 'foxtrot'));
    store.state.ankiSettings.learnSteps = '2160';
    mock.timers.setTime(nowA);                           // 23:50（同日界線）
    await store.actions.rateCard('wF', 0, 500, 'flip');
    const l2 = store.state.cards.get('wF');
    check('T8 e2e 1.5d step 08:30 vs 23:50 due 日一致', 
      toLocalDateStr(new Date(l1.due), TZ, CUTOFF), toLocalDateStr(new Date(l2.due), TZ, CUTOFF));
    check('T8 e2e 1.5d step due 日 == teno日+2', toLocalDateStr(new Date(l2.due), TZ, CUTOFF), addDays('2026-08-12', 2));
  } finally {
    mock.timers.reset();
  }

  // ── T9 負控制：剝除 computeDueIso 改回舊公式 → bug 必須再現 ──
  {
    let negStore = null;
    mock.timers.enable({ apis: ['Date'], now: nowA });
    try {
      const src = fs.readFileSync(STORE_SRC, 'utf8');
      const anchoredExpr = 'due: computeDueIso(result.dueDays, result.state, state.dayCutoff, ankiCfg?.timezoneOffset, now),';
      const oldExpr = 'due: new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000))).toISOString(),';
      if (!src.includes(anchoredExpr)) throw new Error(`[harness] 源碼中找不到日界線錨定 due 表達式 — ${STORE_SRC}`);
      fs.writeFileSync(NEG_TMP, src.replace(anchoredExpr, oldExpr));
      const { createStore: createNegStore } = await import('../src/lib/.a10-neg-control.js');
      negStore = createNegStore();
      await negStore.actions.init();
      await resetState(negStore);
      await negStore.actions.rateCard('wA', 2, 1000, 'flip');
      const neg1 = negStore.state.cards.get('wA').due;
      mock.timers.setTime(nowB);
      await resetState(negStore);
      await negStore.actions.rateCard('wA', 2, 1000, 'flip');
      const neg2 = negStore.state.cards.get('wA').due;
      check('T9 負控制：舊公式 23:50 vs 00:10 due 不同（抖動再現）', neg1 !== neg2, true);
    } finally {
      mock.timers.reset();
      if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
    }
  }

  console.log(`\n結果：${failures === 0 ? 'ALL PASS' : failures + ' 失敗'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
