#!/usr/bin/env node
// Teno full-control CLI — read/analyze/fix/write the real DB without touching the UI.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, copyFileSync, existsSync, appendFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { Session } from '../src/engine/session-v4.js';
import { FSRS, generateFuzzFactor, parseStepsStr } from '../src/core/fsrs.js';
import { getToday, toLocalDateStr, computeDueIso, computeFutureDueCounts } from '../src/core/scheduler.js';
import { buildCSV, parseCSVTable, resolveField } from '../src/core/import.js';   // D8: CSV 合同單一真值源
import { clampLearnAhead } from '../src/lib/store.js';

const HOME = process.env.HOME || '';
const DB = process.env.TENO_DB || `${HOME}/.config/com.teno.app/teno.db`;
const LOGFILE = process.env.TENO_LOG || '/tmp/teno-cli.log';
const args = process.argv.slice(2);
const cmd = args.shift();

// ─── 統一 log 監測: 每個動作都記錄 ───
function log(evt, detail) {
  const line = `[${new Date().toISOString()}] [CLI] ${evt}${detail ? ' | ' + detail : ''}\n`;
  try { appendFileSync(LOGFILE, line); } catch {}
  // --json 模式: stdout 只留純 JSON, log 只寫檔
  if (!args.includes('--json')) console.log(line.trim());
}

const db = new DatabaseSync(DB, { readOnly: true });
// E3: dayCutoff 是 settings 頂層 key（fallback 0 = app 預設）；timezoneOffset 在 ankiSettings blob（fallback 系統本地，勿用 0=UTC）
const DAY_CUTOFF = (db.prepare("SELECT value FROM settings WHERE key='dayCutoff'").get()?.value) | 0;
const TZ_OFFSET = (() => {
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key='ankiSettings'").get()?.value;
    if (v) { const tz = JSON.parse(v).timezoneOffset; if (tz != null) return tz; }
  } catch {}
  return -new Date().getTimezoneOffset();
})();

const ANKI = {
  dayCutoff: DAY_CUTOFF, timezoneOffset: TZ_OFFSET, newPerDay: 100,
  learnSteps: '1,10', relearnSteps: '10', maxReviewsPerDay: 1000,
  reviewMix: 2, mode: 'flip', learnAheadLimit: 20,
};
// E5 R2: 頂層 LEARN_STEPS/RELEARN_STEPS 已死碼（rate/sim 退役後 grep 全檔零引用，
// cmdSimulate :2356 為本地遮蔽宣告）→ 刪除
// E3: lazy today — 每次呼叫重算（避免跨日/沙箱時間 stale）
const today = () => getToday(DAY_CUTOFF, TZ_OFFSET);

const dbw = () => {
  const d = new DatabaseSync(DB);
  // ponytail: 等鎖釋放 (app 也在用同一 DB), 避免 database is locked
  d.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;');
  return d;
};

// ─── 審計: CLI 寫入動作記錄到 audit_log (與 GUI 共用同一軌跡) ───
function ensureSchema() {
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
    if (!exists) {
      const d = dbw();
      d.exec(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      )`);
      d.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)');
      d.close();
    }
  } catch (e) { log('ERROR', `ensureAuditLog: ${e.message}`); }
  // review_log.new_state (v5.2) — app 端 migrate 會加, CLI 直連時自行補
  try {
    const cols = db.prepare("PRAGMA table_info(review_log)").all();
    if (!cols.some(c => c.name === 'new_state')) {
      const d = dbw();
      d.exec('ALTER TABLE review_log ADD COLUMN new_state INTEGER');
      d.close();
    }
  } catch (e) { log('ERROR', `ensureReviewLogNewState: ${e.message}`); }
}

function audit(action, detail = '') {
  try {
    ensureSchema();
    const d = dbw();
    d.prepare('INSERT INTO audit_log (ts, action, detail) VALUES (?,?,?)')
      .run(Date.now(), String(action).slice(0, 100), String(detail).slice(0, 1000));
    d.close();
    log('AUDIT', `${action} ${detail}`);
  } catch (e) {
    log('ERROR', `audit 失敗: ${e.message}`);
  }
}

let _idCounter = 0;
function nextWordId() {
  return 'w_' + Date.now().toString(36) + '_' + (++_idCounter).toString(36) + Math.random().toString(36).slice(2, 4);
}

// ─── load state (mirror store.getAllCards + words) ───
function loadState() {
  // E15: 17 欄全集對齊 app 真值源 db.js getAllWords（曾缺 pronunciation/example/
  // image/description/created_at＝偽契約，讀者靜默 undefined 零回聲）。
  // 契約面=SELECT 投影欄集合（釘見 verify-e15）；非 store camelCase 形態契約。
  const words = db.prepare('SELECT id, word, definition, part_of_speech, pronunciation, example, image, description, deck, tags, created_at, synonym, antonym, derivative, related, forms, examples FROM words').all();
  const rows = db.prepare(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards'
  ).all();
  const cards = new Map();
  for (const r of rows) cards.set(r.word_id, {
    due: r.due, stability: r.stability, difficulty: r.difficulty,
    elapsedDays: r.elapsed_days, scheduledDays: r.scheduled_days,
    reps: r.reps, lapses: r.lapses, state: r.state, step: r.step ?? 0,
    lastReview: r.last_review, buried: !!r.buried, suspended: !!r.suspended,
    interval: r.scheduled_days || 0,
    mcData: r.mc_data ? JSON.parse(r.mc_data) : null,
    spellData: r.spell_data ? JSON.parse(r.spell_data) : null,
  });
  return {
    words, cards,
    buried: new Set(rows.filter(r => r.buried).map(r => r.word_id)),
    suspended: new Set(rows.filter(r => r.suspended).map(r => r.word_id)),
  };
}

/** 依 mode 取對應 card map (mc/spell 從 mcData/spellData 拆出來) */
function modeCardMap(s, mode) {
  if (mode === 'flip' || !mode) return s.cards;
  const map = new Map();
  for (const [wid, c] of s.cards) {
    const data = mode === 'mc' ? c.mcData : c.spellData;
    if (data) map.set(wid, data);
  }
  return map;
}

function makeSession(s) {
  // SR-C4: 統一 concurrency —— makeSession 也走 fsrsCtx(mode)（原 new FSRS() 預設權重
  // 與 app/rate 讀 ankiSettings 漂移）；learnSteps 用 parseStepsStr 版（置於 ANKI 後覆蓋字串）
  const _ctx = fsrsCtx(s.mode || 'flip');
  return new Session({ ...s, fsrs: _ctx.fsrs, ...ANKI, learnSteps: _ctx.learnSteps, relearnSteps: _ctx.relearnSteps });
}
// E5: 與 store.rateCard:648-655/711-712 同構的 FSRS 構造器 — 權重/retention/maxIvl/steps
// 從 ankiSettings（mode 化 key，比照 cmdWhatif）讀取。rate/sim 寫入路徑必須與 app 同權重，
// 否則 cards 值與 cmdAudit replay（讀 fsrsWeights）必然漂移 → audit 假 mismatch。
function fsrsCtx(mode = 'flip') {
  const key = mode === 'mc' ? 'ankiSettingsMc' : mode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
  let cfg = {};
  try {
    const v = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
    if (v) cfg = JSON.parse(v);
  } catch { cfg = {}; }
  const weights = cfg.fsrsWeights ? (() => {
    try { const ws = String(cfg.fsrsWeights).replace(/^\[|\]$/g, '').trim(); return ws ? JSON.parse('[' + ws + ']') : null; } catch { return null; }
  })() : null;
  return {
    fsrs: new FSRS(weights, Math.max(0.7, Math.min(0.99, cfg.desiredRetention ?? 0.9)), true, Math.max(1, cfg.maxIvl ?? 365)),
    learnSteps: parseStepsStr(cfg.learnSteps, '1,10'),
    relearnSteps: parseStepsStr(cfg.relearnSteps, '10'),
  };
}
// E2: 正規化時間戳 — 無 Z（naive/空格）補 Z，帶 Z/±HH:MM 原樣
const normTs = x => x == null ? x : (/Z$|[+-]\d{2}:\d{2}$/.test(String(x)) ? String(x) : String(x).replace(' ', 'T') + 'Z');
// E4: 日字串差（YYYY-MM-DD），與 store.js:535 同構 — cmdRate elapsed 計算用
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}
function localDue(due) {
  if (!due) return '';
  return toLocalDateStr(new Date(normTs(due)), ANKI.timezoneOffset, ANKI.dayCutoff);
}
function findWord(id) {
  return db.prepare('SELECT * FROM words WHERE id=?').get(id)
    || db.prepare('SELECT * FROM words WHERE lower(word)=lower(?)').get(id);
}
function backupDb() {
  // ponytail: 測試/模擬時跳過 (TENO_NO_BACKUP=1), 避免每天數百個備份檔
  if (process.env.TENO_NO_BACKUP === '1') return null;
  const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);
  const dst = `${DB}.bak-${stamp}`;
  copyFileSync(DB, dst);
  log('WRITE', `backup → ${dst}`);
  console.log(`已備份 → ${dst}`);
  return dst;
}
// D7: 覆寫 DB 主檔前清掉舊 WAL/SHM，避免 SQLite 讀到舊狀態
const rmWal = (p) => { for (const s of ['-wal', '-shm']) { try { rmSync(p + s, { force: true }); } catch {} } };

// ═══════════════ 診斷 ═══════════════

function cmdStats() {
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'flip';
  if (mode !== 'flip' && mode !== 'mc' && mode !== 'spell') return console.log('--mode 需為 flip | mc | spell');
  const s = loadState();
  const cards = modeCardMap(s, mode);
  const w = db.prepare('SELECT count(*) n FROM words').get().n;
  const c = cards.size;
  const stateDist = {};
  for (const [, card] of cards) stateDist[card.state ?? 0] = (stateDist[card.state ?? 0] || 0) + 1;
  const dueToday = {};
  for (const [, card] of cards) {
    if (card.due && localDue(card.due) <= today()) dueToday[card.state ?? 0] = (dueToday[card.state ?? 0] || 0) + 1;
  }
  const decks = db.prepare('SELECT deck, count(*) n FROM words GROUP BY deck ORDER BY n DESC').all();
  const logCount = db.prepare('SELECT count(*) n FROM review_log').get().n;
  const lastLog = db.prepare('SELECT max(reviewed_at) m FROM review_log').get().m;
  console.log(`words=${w} cards=${c} (mode=${mode}) review_log=${logCount} 最後複習=${lastLog}`);
  const names = { 0: '新卡', 1: '學習中', 2: '複習', 3: '複學' };
  console.log(`\n卡狀態分佈:`);
  for (const [st, n] of Object.entries(stateDist)) console.log(`  state ${st} (${names[st] || '?'}): ${n}`);
  console.log(`\n到期 (含逾期, date(due)<=today):`);
  for (const [st, n] of Object.entries(dueToday)) console.log(`  state ${st} (${names[st] || '?'}): ${n}`);
  console.log(`\nDeck 分佈 (top 20):`);
  for (const r of decks.slice(0, 20)) console.log(`  ${r.deck}: ${r.n}`);
  log('READ', `stats: words=${w} cards=${c} mode=${mode} review_log=${logCount} decks=${decks.length}`);
}

// ─── 儀表板 — 對應儀表板頁所有數字 ───
function cmdDash() {
  const { computeRetention, computeStreak, countTodayReviews, getToday } = (() => {
    // 直接複製 scheduler 的純函數邏輯, 避免 import 依賴
    return requireScheduler();
  })();
  const words = db.prepare('SELECT id, word, deck, definition FROM words').all();
  const cards = db.prepare('SELECT word_id, state, due, scheduled_days, stability, difficulty FROM cards').all();
  const log2 = db.prepare('SELECT rating, reviewed_at, mode, card_state FROM review_log ORDER BY reviewed_at').all();
  const goal = db.prepare('SELECT * FROM goal_streak WHERE id=1').get();
  const tzOff = TZ_OFFSET;
  const dayCutoff = DAY_CUTOFF;

  // 卡統計
  const cardMap = new Map();
  for (const c of cards) cardMap.set(c.word_id, c);
  let learned = 0, newCount = 0, due = 0, mature = 0, diffSum = 0, diffCount = 0;
  for (const w of words) {
    const c = cardMap.get(w.id);
    if (c && c.state > 0) learned++; else newCount++;
    if (c && c.state === 2 && (c.scheduled_days ?? 0) >= 21) mature++;
    if (c && c.due) {
      const dl = localDue(c.due);
      if (dl !== 'Invalid Date' && dl <= today2(dayCutoff, tzOff)) due++;
    }
    if (c && c.difficulty != null) { diffSum += c.difficulty; diffCount++; }
  }
  const retention = computeRetention(log2);
  const todayCount = countTodayReviews(log2, dayCutoff, tzOff);
  const dates = db.prepare(`SELECT value FROM settings WHERE key='examSessions'`).get();
  const streakDates = goal && JSON.parse(goal.dates || '{}')['flip'] || [];
  const streak = computeStreak(streakDates, dayCutoff, tzOff);
  const dailyGoal = goal?.daily_goal ?? 20;
  const goalPct = dailyGoal > 0 ? Math.min(100, Math.round((todayCount / dailyGoal) * 100)) : 0;

  // 按鈕分布 / 時段分布
  const buttons = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const hours = new Array(24).fill(0);
  for (const e of log2) {
    buttons[e.rating ?? 2]++;
    const h = e.reviewed_at ? new Date(normTs(e.reviewed_at)).getHours() : 0;   // E2: normTs 防 naive 偏移
    hours[h]++;
  }

  // 每日複習量 (最近 14 天)
  const buckets = new Map();
  for (const e of log2) {
    const d = (e.reviewed_at || '').slice(0, 10);
    if (d) buckets.set(d, (buckets.get(d) || 0) + 1);
  }
  const last14 = [...buckets.entries()].slice(-14);

  console.log(`\n╔═ 儀表板 ═════════════════════════════════════`);
  console.log(`║ 今日已複習 ${todayCount} 詞 · 連續 ${streak} 天 · 目標 ${dailyGoal} (${goalPct}%)`);
  console.log(`║ 保留率 ${retention.total ? Math.round(retention.rate * 100) : 0}% (${log2.length} 次複習)`);
  console.log(`║`);
  console.log(`║ 總詞數 ${words.length} | 已學習 ${learned} | 新詞 ${newCount} | 待複習 ${due} | MATURE ${mature}`);
  console.log(`║ 平均難度 ${diffCount ? (diffSum / diffCount).toFixed(1) : '-'} | 最佳連續 ${goal?.best ?? 0} 天`);
  console.log(`║`);
  console.log(`║ 字本:`);
  const deckStats = new Map();
  for (const w of words) {
    const d = deckStats.get(w.deck) || { total: 0, learned: 0, due: 0, fresh: 0 };
    d.total++;
    const c = cardMap.get(w.id);
    if (c && c.state > 0) d.learned++; else d.fresh++;
    if (c && c.due) { const dl = localDue(c.due); if (dl !== 'Invalid Date' && dl <= today2(dayCutoff, tzOff)) d.due++; }
    deckStats.set(w.deck, d);
  }
  for (const [name, d] of [...deckStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`║   ${name.padEnd(14)} ${String(d.total).padStart(4)} 詞 | 已學 ${d.learned} | 待複習 ${d.due} | 新 ${d.fresh}`);
  }
  console.log(`║`);
  console.log(`║ 按鈕分布 (${log2.length} 次): Again ${buttons[0]} / Hard ${buttons[1]} / Good ${buttons[2]} / Easy ${buttons[3]}`);
  const peak = hours.indexOf(Math.max(...hours));
  console.log(`║ 時段分布: 尖峰 ${peak}:00 (${hours[peak]} 次)`);
  console.log(`║ 最近 14 天每日複習:`);
  for (const [d, n] of last14) console.log(`║   ${d}: ${String(n).padStart(4)}`);
  console.log(`╚═══════════════════════════════════════════`);
  log('READ', `dash: today=${todayCount} streak=${streak} retention=${Math.round(retention.rate * 100)}% learned=${learned}/${words.length} due=${due}`);

  function today2(cut, tz) {
    const now = new Date();
    const local = new Date(now.getTime() + (tz ?? 480) * 60000);
    const h = local.getUTCHours();
    const rollback = h < cut / 60 ? 1 : 0;
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - rollback));
    return d.toISOString().slice(0, 10);
  }
  function requireScheduler() {
    return {
      computeRetention: (log, lookback = 30) => {
        const cutoff = Date.now() - lookback * 86400000;
        let correct = 0, total = 0;
        for (const e of log) {
          if (!e.reviewed_at) continue;
          const t = new Date(normTs(e.reviewed_at)).getTime();   // E2: normTs 防 naive 偏移
          if (t < cutoff) continue;
          total++;
          if ((e.rating ?? 0) >= 2) correct++;
        }
        return { total, rate: total ? correct / total : 0 };
      },
      computeStreak: (dates, cut, tz) => {
        if (!dates || !dates.length) return 0;
        const set = new Set(dates);
        let streak = 0;
        const now = new Date();
        const local = new Date(now.getTime() + (tz ?? 480) * 60000);
        let d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
        if (!set.has(d.toISOString().slice(0, 10))) {
          d = new Date(d.getTime() - 86400000);
          if (!set.has(d.toISOString().slice(0, 10))) return 0;
        }
        while (set.has(d.toISOString().slice(0, 10))) { streak++; d = new Date(d.getTime() - 86400000); }
        return streak;
      },
      countTodayReviews: (log, cut, tz) => {
        const t = today2(cut, tz);
        return log.filter(e => (e.reviewed_at || '').slice(0, 10) === t).length;
      },
    };
  }
}

function cmdDue() {
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'flip';
  if (mode !== 'flip' && mode !== 'mc' && mode !== 'spell') return console.log('--mode 需為 flip | mc | spell');
  const s = loadState();
  const cards = modeCardMap(s, mode);
  const learn = [], review = [], fresh = [];
  for (const w of s.words) {
    const card = cards.get(w.id);
    if (s.buried.has(w.id) || s.suspended.has(w.id)) continue;
    if (!card || card.state === 0) { fresh.push(w); continue; }
    if (!card.due) continue;
    if (localDue(card.due) !== today()) continue;
    if (card.state === 1 || card.state === 3) learn.push({ ...w, card });
    else review.push({ ...w, card });
  }
  console.log(`今天到期 (mode=${mode}): 學習/複學=${learn.length} 複習=${review.length} 新卡=${fresh.length}`);
  if (learn.length) {
    console.log(`\n學習卡 (state 1/3):`);
    for (const x of learn.slice(0, 40)) console.log(`  ${x.id} ${x.word} state=${x.card.state} step=${x.card.step} due=${x.card.due}`);
  }
  if (review.length) {
    console.log(`\n複習卡 (state 2, 前 20):`);
    for (const x of review.slice(0, 20)) console.log(`  ${x.id} ${x.word} due=${x.card.due}`);
  }
  log('READ', `due: 學習=${learn.length} 複習=${review.length} 新卡=${fresh.length} (today=${today()})`);
}

function cmdCard() {
  const id = args[0];
  if (!id) return console.log('需指定單字 (id 或英文)');
  const w = findWord(id);
  if (!w) return console.log('找不到此單字');
  const r = db.prepare('SELECT * FROM cards WHERE word_id = ?').get(w.id);
  console.log(`字: ${w.word} | deck: ${w.deck}`);
  if (w.definition) console.log(`定義: ${String(w.definition).slice(0, 100)}`);
  if (w.pos) console.log(`詞性: ${w.pos}`);
  if (r) {
    console.log(`state=${r.state} step=${r.step} reps=${r.reps} lapses=${r.lapses}`);
    console.log(`due=${r.due} (本機日=${localDue(r.due)})  last_review=${r.last_review}`);
    console.log(`scheduled_days=${r.scheduled_days} stability=${r.stability} difficulty=${r.difficulty}`);
    console.log(`buried=${r.buried} suspended=${r.suspended}`);
  } else {
    console.log('(無卡片記錄 — 新卡)');
  }
  const rlog = db.prepare('SELECT rating, reviewed_at, mode, card_state FROM review_log WHERE word_id=? ORDER BY id DESC LIMIT 15').all(w.id);
  if (rlog.length) {
    console.log(`\n最近複習:`);
    for (const l of rlog) console.log(`  rating=${l.rating} card_state=${l.card_state} mode=${l.mode} ${l.reviewed_at}`);
  }
  log('READ', `card ${w.id} ${w.word}: state=${r?.state ?? '新'} reps=${r?.reps ?? 0} history=${rlog.length}`);
}

function cmdHistory() {
  const id = args[0];
  if (!id) return console.log('需單字 id');
  const rows = db.prepare('SELECT rating, card_state, mode, duration, reviewed_at FROM review_log WHERE word_id=? ORDER BY id').all(id);
  console.log(`${id} 複習歷史: ${rows.length} 筆`);
  for (const r of rows) console.log(`  rating=${r.rating} card_state=${r.card_state} mode=${r.mode} dur=${r.duration} ${r.reviewed_at}`);
  log('READ', `history ${id}: ${rows.length} 筆`);
}

function cmdSql() {
  const q = args.join(' ');
  if (!q) return console.log('需 SQL 查詢 (唯讀)');
  if (!/^(select|pragma|with)\b/i.test(q.trim())) return console.log('僅允許唯讀: SELECT/PRAGMA/WITH');
  try {
    const stmt = db.prepare(q);
    const rows = stmt.all ? stmt.all() : [stmt.get()];
    console.log(rows.length ? JSON.stringify(rows.slice(0, 50), null, 1) : '(空)');
    log('READ', `sql "${q.slice(0, 60)}": ${rows.length} 筆`);
  } catch (e) { console.log('SQL 錯誤:', e.message); log('ERROR', `sql 失敗: ${e.message}`); }
}

// ═══════════════ 單字 CRUD ═══════════════

function cmdAdd() {
  const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
  const wordText = flag('word') || flag('w');
  if (!wordText) return console.log('需 --word "english" [--def 定義] [--deck Deck名] [--pos 詞性] [--pron 音標] [--ex 例句] [--tags a,b] [--related a,b] [--forms a,b] [--synonym s] [--antonym a] [--derivative d] [--desc 描述]');
  const listOf = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);
  const word = {
    id: nextWordId(),
    word: wordText.toLowerCase().trim(),
    definition: flag('def') || '',
    pos: flag('pos') || '',
    pron: flag('pron') || '',
    example: flag('ex') || '',
    deck: flag('deck') || 'Default',
    tags: listOf(flag('tags')),
    image: '', description: flag('desc') || '',
    related: listOf(flag('related')), forms: listOf(flag('forms')),
    synonym: flag('synonym') || '', antonym: flag('antonym') || '',
    derivative: flag('derivative') || '',
    examples: listOf(flag('examples')) || (flag('ex') ? [flag('ex')] : []),
  };
  backupDb();
  const w = dbw();
  w.prepare(`INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    word.id, word.word, word.definition, word.pos, word.pron, word.example, word.deck,
    JSON.stringify(word.tags), word.image, word.description,
    JSON.stringify(word.related), JSON.stringify(word.forms),
    word.synonym, word.antonym, word.derivative, JSON.stringify(word.examples),
    new Date().toISOString());   // E2: created_at ISO 帶 Z（不再靠 DEFAULT naive）
  w.close();
  log('WRITE', `add word=${word.word} id=${word.id} deck=${word.deck} def=${word.definition.slice(0, 40)} pos=${word.pos || '-'}`);
  audit('add-word', `新增 ${word.word} (${word.id}) deck=${word.deck}`);
  console.log(`已新增 ${word.word} → ${word.id} (deck=${word.deck})`);
}

function cmdEdit() {
  const id = args[0];
  if (!id) return console.log('需單字 id');
  const existing = findWord(id);
  if (!existing) return console.log('找不到');
  const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
  const listOf = (s) => JSON.stringify((s || '').split(',').map(x => x.trim()).filter(Boolean));
  const updates = {};
  const strFields = { word: 'word', def: 'definition', pos: 'part_of_speech', pron: 'pronunciation', ex: 'example', deck: 'deck', synonym: 'synonym', antonym: 'antonym', derivative: 'derivative', desc: 'description' };
  for (const [k, col] of Object.entries(strFields)) {
    const v = flag(k);
    if (v !== undefined) updates[col] = v;
  }
  const jsonFields = { tags: 'tags', related: 'related', forms: 'forms', examples: 'examples' };
  for (const [k, col] of Object.entries(jsonFields)) {
    const v = flag(k);
    if (v !== undefined) updates[col] = listOf(v);
  }
  if (Object.keys(updates).length === 0) return console.log('無欄位更新');
  backupDb();
  const w = dbw();
  const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
  w.prepare(`UPDATE words SET ${sets} WHERE id=?`).run(...Object.values(updates), existing.id);
  w.close();
  log('WRITE', `edit ${existing.word} (${existing.id}): ${Object.keys(updates).join(', ')}`);
  audit('edit-word', `編輯 ${existing.word} (${existing.id})`);
  console.log(`已更新 ${existing.word}: ${Object.keys(updates).join(', ')}`);
}

function cmdDelete() {
  const id = args[0];
  if (!id) return console.log('需單字 id');
  const existing = findWord(id);
  if (!existing) return console.log('找不到');
  if (!args.includes('--yes')) return console.log(`確定刪除 ${existing.word}? 加 --yes`);
  backupDb();
  const w = dbw();
  w.prepare('DELETE FROM cards WHERE word_id=?').run(existing.id);
  w.prepare('DELETE FROM review_log WHERE word_id=?').run(existing.id);
  w.prepare('DELETE FROM words WHERE id=?').run(existing.id);
  w.close();
  log('WRITE', `delete ${existing.word} (${existing.id}) deck=${existing.deck}`);
  audit('delete-word', `刪除 ${existing.word} (${existing.id})`);
  console.log(`已刪除 ${existing.word}`);
}

function cmdSearch() {
  // 排除 flag 與 flag 的值 (e.g. --limit 5 的 "5" 不能進關鍵字)
  const q = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--')).join(' ');
  if (!q) return console.log('需搜尋字 (搜尋全部欄位: word/definition/pos/pron/example/deck/tags/synonym/related/forms/description)');
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 40;
  const rows = db.prepare(
    `SELECT id, word, definition, part_of_speech, pronunciation, example, deck, tags, synonym, related, forms, description
     FROM words
     WHERE word LIKE ? OR definition LIKE ? OR part_of_speech LIKE ? OR pronunciation LIKE ?
        OR example LIKE ? OR deck LIKE ? OR tags LIKE ? OR synonym LIKE ? OR related LIKE ?
        OR forms LIKE ? OR description LIKE ?
     ORDER BY word LIMIT ?`
  ).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit);
  console.log(`${rows.length} 筆 (前 ${limit}):`);
  const full = args.includes('--full');
  for (const r of rows) {
    if (full) {
      console.log(`  ${r.word} [${r.deck}]`);
      console.log(`    id: ${r.id}`);
      if (r.part_of_speech) console.log(`    詞性: ${r.part_of_speech}`);
      if (r.pronunciation) console.log(`    發音: ${r.pronunciation}`);
      if (r.definition) console.log(`    定義: ${r.definition}`);
      if (r.example) console.log(`    例句: ${r.example}`);
      if (r.synonym) console.log(`    同義: ${r.synonym}`);
      if (r.related) console.log(`    相關: ${r.related}`);
      if (r.forms) console.log(`    詞形: ${r.forms}`);
      if (r.tags) console.log(`    標籤: ${r.tags}`);
      if (r.description) console.log(`    描述: ${r.description}`);
    } else {
      console.log(`  ${r.id} ${r.word} [${r.deck}] ${String(r.definition).slice(0, 40)}`);
    }
  }
  log('READ', `search "${q}": ${rows.length} 筆`);
}

function cmdList() {
  const deck = args.includes('--deck') ? args[args.indexOf('--deck') + 1] : null;
  const state = args.includes('--state') ? parseInt(args[args.indexOf('--state') + 1]) : null;
  const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
  const pos = args.includes('--pos') ? args[args.indexOf('--pos') + 1] : null;
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 50;
  const full = args.includes('--full');
  const sortDesc = args.includes('--desc');
  const qs = [];
  const params = [];
  if (deck) { qs.push('w.deck=?'); params.push(deck); }
  if (state !== null) { qs.push('c.state=?'); params.push(state); }
  if (tag) { qs.push('w.tags LIKE ?'); params.push(`%"${tag}"%`); }
  if (pos) { qs.push('w.part_of_speech=?'); params.push(pos); }
  const where = qs.length ? 'WHERE ' + qs.join(' AND ') : '';
  const order = sortDesc ? 'ORDER BY w.word DESC' : 'ORDER BY w.word';
  const rows = db.prepare(`SELECT w.id, w.word, w.deck, w.part_of_speech, w.definition, c.state, c.step, c.due FROM words w LEFT JOIN cards c ON w.id=c.word_id ${where} ${order} LIMIT ?`).all(...params, limit);
  console.log(`${rows.length} 筆 (前 ${limit}):`);
  for (const r of rows) {
    if (full) {
      console.log(`  ${r.word} [${r.deck}]${r.part_of_speech ? ' (' + r.part_of_speech + ')' : ''} state=${r.state ?? '-'}`);
      if (r.definition) console.log(`    定義: ${r.definition}`);
      if (r.due) console.log(`    due: ${localDue(r.due)}`);
    } else {
      console.log(`  ${r.id} ${r.word} [${r.deck}] ${r.part_of_speech ?? ''} state=${r.state ?? '-'}`);
    }
  }
  log('READ', `list: ${rows.length} 筆 deck=${deck ?? '全部'} state=${state ?? '全部'} tag=${tag ?? '-'} pos=${pos ?? '-'} sort=${sortDesc ? 'Z-A' : 'A-Z'}`);
}

// ═══════════════ deck / tag ═══════════════

function cmdDecks() {
  const rows = db.prepare('SELECT deck, count(*) n FROM words GROUP BY deck ORDER BY n DESC').all();
  const order = db.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
  console.log(`Deck 分佈 (${rows.length} 個):`);
  for (const r of rows) console.log(`  ${r.deck}: ${r.n}`);
  if (order) {
    console.log(`\ndeckOrder (UI 順序):`);
    JSON.parse(order.value).forEach((id, i) => console.log(`  ${i+1}. ${id}`));
  }
  log('READ', `decks: ${rows.length} 個`);
}

function cmdCreateDeck() {
  const name = args[0];
  const color = args.includes('--color') ? args[args.indexOf('--color') + 1] : '#5e6ad2';
  if (!name) return console.log('需 deck 名: create-deck <名> [--color #hex]');
  backupDb();
  const w = dbw();
  const id = 'deck_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Math.random().toString(36).slice(2, 6);
  w.prepare('INSERT INTO decks (id, name, color) VALUES (?,?,?)').run(id, name, color);
  const order = db.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
  const list = order ? JSON.parse(order.value) : [];
  list.push(id);
  w.prepare(`INSERT INTO settings (key,value) VALUES ('deckOrder',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(list));
  w.close();
  log('WRITE', `create-deck ${name} (${id}) color=${color}`);
  audit('create-deck', `建立牌組 ${name} (${id}) color=${color}`);
  console.log(`已建立 deck "${name}" → ${id}`);
}

function cmdUpdateDeck() {
  const name = args[0];
  const color = args.includes('--color') ? args[args.indexOf('--color') + 1] : null;
  const rename = args.includes('--rename') ? args[args.indexOf('--rename') + 1] : null;
  if (!name) return console.log('需 deck 名: update-deck <名> [--color #hex] [--rename 新名]');
  const rec = db.prepare('SELECT id FROM decks WHERE name=?').get(name);
  if (!rec) return console.log(`deck "${name}" 不在 decks 表 (僅存在於 words.deck)`);
  backupDb();
  const w = dbw();
  if (color) w.prepare('UPDATE decks SET color=? WHERE id=?').run(color, rec.id);
  if (rename) {
    w.prepare('UPDATE decks SET name=? WHERE id=?').run(rename, rec.id);
    w.prepare('UPDATE words SET deck=? WHERE deck=?').run(rename, name);
  }
  w.close();
  log('WRITE', `update-deck ${name} color=${color ?? '-'} rename=${rename ?? '-'}`);
  audit('update-deck', `更新牌組 ${name} color=${color ?? '-'} rename=${rename ?? '-'}`);
  console.log(`已更新 deck "${name}"`);
}

function cmdMergeDeck() {
  const [src, tgt] = args;
  if (!src || !tgt) return console.log('需: merge-deck <來源名> <目標名>');
  const srcRec = db.prepare('SELECT id FROM decks WHERE name=?').get(src);
  const tgtRec = db.prepare('SELECT id FROM decks WHERE name=?').get(tgt);
  if (!srcRec || !tgtRec) return console.log('來源或目標不在 decks 表');
  backupDb();
  const w = dbw();
  w.prepare('UPDATE words SET deck=? WHERE deck=?').run(tgt, src);
  w.prepare('DELETE FROM decks WHERE id=?').run(srcRec.id);
  const order = db.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
  if (order) {
    const list = JSON.parse(order.value).filter(id => id !== srcRec.id);
    w.prepare(`INSERT INTO settings (key,value) VALUES ('deckOrder',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(list));
  }
  w.close();
  log('WRITE', `merge-deck ${src} → ${tgt}`);
  audit('merge-deck', `${src} → ${tgt}`);
  console.log(`已合併 deck "${src}" → "${tgt}"`);
}

function cmdDeckOrder() {
  const sub = args[0];
  const order = db.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
  const list = order ? JSON.parse(order.value) : [];
  if (sub === 'move') {
    const name = args[1];
    const dir = args[2] === 'up' ? -1 : args[2] === 'down' ? 1 : null;
    if (!name || !dir) return console.log('需: deck-order move <名> up|down');
    const id = db.prepare('SELECT id FROM decks WHERE name=?').get(name)?.id;
    const idx = list.indexOf(id);
    if (idx === -1) return console.log('deck 不在順序中');
    const swap = idx + dir;
    if (swap < 0 || swap >= list.length) return console.log('已在邊緣');
    [list[idx], list[swap]] = [list[swap], list[idx]];
    backupDb();
    writeSetting('deckOrder', JSON.stringify(list));
    log('WRITE', `deck-order move ${name} ${dir === -1 ? 'up' : 'down'}`);
  }
  console.log(`deckOrder (${list.length} 個):`);
  list.forEach((id, i) => console.log(`  ${i+1}. ${id}`));
}

// ═══════════════ 自動填入順序 — 對應單字表單「自動填入順序」 ═══════════════

function cmdAutofill() {
  const sub = args[0];
  const getChain = () => {
    const r = db.prepare(`SELECT value FROM settings WHERE key='autoFillOrder'`).get();
    return r ? r.value.split('|') : ['cambridge', 'dict-api', 'tatoeba', 'llm'];
  };
  if (sub === 'set') {
    const seq = args.slice(1).join(',');
    if (!seq) return console.log('需: autofill set cambridge,dict-api,tatoeba,llm');
    const valid = ['cambridge', 'dict-api', 'tatoeba', 'llm'];
    const list = seq.split(',').map(s => s.trim()).filter(Boolean);
    if (!list.every(x => valid.includes(x))) return console.log(`有效值: ${valid.join(', ')}`);
    backupDb();
    writeSetting('autoFillOrder', list.join('|'));
    log('WRITE', `autofill set ${list.join('|')}`);
    console.log(`已設自動填入順序: ${list.join(' → ')}`);
  } else if (sub === 'move') {
    const name = args[1];
    const dir = args[2] === 'up' ? -1 : args[2] === 'down' ? 1 : null;
    if (!name || !dir) return console.log('需: autofill move <來源> up|down');
    const list = getChain();
    const idx = list.indexOf(name);
    if (idx === -1) return console.log(`無此來源: ${name}`);
    const swap = idx + dir;
    if (swap < 0 || swap >= list.length) return console.log('已在邊緣');
    [list[idx], list[swap]] = [list[swap], list[idx]];
    backupDb();
    writeSetting('autoFillOrder', list.join('|'));
    log('WRITE', `autofill move ${name} ${dir === -1 ? 'up' : 'down'}`);
    console.log(`已移動: ${list.join(' → ')}`);
  } else {
    console.log(`目前順序: ${getChain().join(' → ')}`);
    console.log('autofill 子命令: set <來源,...> | move <來源> up|down | 檢視(無參數)');
    console.log('來源: cambridge | dict-api | tatoeba | llm');
    log('READ', `autofill order: ${getChain().join('|')}`);
  }
}

function cmdCreateTag() {
  const name = args[0];
  const color = args.includes('--color') ? args[args.indexOf('--color') + 1] : '#5e6ad2';
  if (!name) return console.log('需 tag 名: create-tag <名> [--color #hex]');
  backupDb();
  const w = dbw();
  const rows = w.prepare(`SELECT value FROM settings WHERE key='tags'`).get();
  const tags = rows ? JSON.parse(rows.value) : [];
  if (tags.some(t => t.name === name)) { w.close(); return console.log('tag 已存在'); }
  tags.push({ name, color });
  w.prepare(`INSERT INTO settings (key,value) VALUES ('tags',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(tags));
  w.close();
  log('WRITE', `create-tag ${name} color=${color}`);
  audit('create-tag', `建立標籤 ${name} color=${color}`);
  console.log(`已建立 tag "${name}"`);
}

function cmdDeleteTag() {
  const name = args[0];
  if (!name) return console.log('需 tag 名');
  backupDb();
  const w = dbw();
  const rows = w.prepare(`SELECT value FROM settings WHERE key='tags'`).get();
  const tags = rows ? JSON.parse(rows.value).filter(t => t.name !== name) : [];
  w.prepare(`INSERT INTO settings (key,value) VALUES ('tags',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(tags));
  w.close();
  log('WRITE', `delete-tag ${name}`);
  console.log(`已刪除 tag "${name}"`);
}

function cmdTagWords() {
  const name = args[0];
  if (!name) return console.log('需 tag 名');
  const rows = db.prepare(`SELECT id, word, deck FROM words WHERE tags LIKE ?`).all(`%"${name}"%`);
  console.log(`含 tag "${name}" 的單字 (${rows.length}):`);
  for (const r of rows.slice(0, 30)) console.log(`  ${r.id} ${r.word} [${r.deck}]`);
  log('READ', `tag-words "${name}": ${rows.length} 筆`);
}

function cmdRenameDeck() {
  const [from, to] = args;
  if (!from || !to) return console.log('需: rename-deck <舊名> <新名>');
  backupDb();
  const w = dbw();
  // D20: words＋decks.name 同步（decks 表＝GUI 牌組清單唯一真值源 db.js getAllDecks，
  // 原只改 words → GUI 仍列旧名＋單字掛到無對應列的幽靈牌組）；目標名已被佔用
  // → decks.name UNIQUE 衝突整個回滾（改名不默認合併，merge-deck 才是該路徑）
  w.exec('BEGIN');
  try {
    w.prepare('UPDATE words SET deck=? WHERE deck=?').run(to, from);
    w.prepare('UPDATE decks SET name=? WHERE name=?').run(to, from);
    w.exec('COMMIT');
  } catch (e) {
    try { w.exec('ROLLBACK'); } catch {}
    w.close();
    log('ERROR', `rename-deck: ${e.message}`);
    process.exitCode = 1; return console.log(`❌ 改名失敗(已回滾): ${e.message}`);
  }
  w.close();
  log('WRITE', `rename-deck "${from}" → "${to}"`);
  audit('rename-deck', `${from} → ${to}`);
  console.log(`已將 deck "${from}" 改名 "${to}"`);
}

function cmdDeleteDeck() {
  const deck = args[0];
  if (!deck) return console.log('需 deck 名');
  if (!args.includes('--yes')) return console.log(`確定刪除 deck "${deck}" 及其中所有單字? 加 --yes`);
  backupDb();
  const w = dbw();
  // D20: 事務＋註冊面/歷史面穷举清理（鏡像 GUI deleteDeck+deleteWordsByDeck 語意，
  // 原只刪 cards/words → decks 幽靈列永留 GUI 清單；exam_history/review_log 孤兒）
  w.exec('BEGIN');
  try {
    const rec = w.prepare('SELECT id FROM decks WHERE name=?').get(deck);
    // exam_history.word 雙世代語意（B4 e53a3ce 後=word_id／B4 前 legacy=單字文字）兩族皆刪；
    // 必須在 DELETE words 之前（子查詢依賴 words 在場）
    w.prepare('DELETE FROM exam_history WHERE word IN (SELECT word FROM words WHERE deck=?) OR word IN (SELECT id FROM words WHERE deck=?)').run(deck, deck);
    // 顯式刪（schema 無關：CASCADE 只在新建 DB 存在，舊世代無 FK 約束則孤兒直入）
    w.prepare('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck=?)').run(deck);
    w.prepare('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck=?)').run(deck);
    w.prepare('DELETE FROM words WHERE deck=?').run(deck);
    if (rec) {
      w.prepare('DELETE FROM decks WHERE id=?').run(rec.id);
      const order = w.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
      if (order) {
        try {
          const list = JSON.parse(order.value).filter(id => id !== rec.id);
          w.prepare(`INSERT INTO settings (key,value) VALUES ('deckOrder',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(list));
        } catch {} // 髒值跳過清理不擋刪除主路徑
      }
    }
    w.exec('COMMIT');
  } catch (e) {
    try { w.exec('ROLLBACK'); } catch {}
    w.close();
    log('ERROR', `delete-deck: ${e.message}`);
    process.exitCode = 1; return console.log(`❌ 刪除失敗(已回滾): ${e.message}`);
  }
  w.close();
  log('WRITE', `delete-deck "${deck}"`);
  audit('delete-deck', `刪除牌組 ${deck}`);
  console.log(`已刪除 deck "${deck}"`);
}

function cmdTags() {
  const rows = db.prepare(`SELECT value FROM settings WHERE key='tags'`).get();
  const tags = rows ? JSON.parse(rows.value) : [];
  for (const t of tags) console.log(`  ${t.name || t} ${t.color || ''}`);
  log('READ', `tags: ${tags.length} 個`);
}

// ═══════════════ 主題 / 外觀 (對應 UI: 主題、強調色、強度、調色盤) ═══════════════

const ACCENTS = ['lemonChiffon','skyBlue','peach','mintGreen','lavender','coralPink','springGreen','sunshineYellow','babyBlue','apricot','turquoise','candyPink','limePunch','periwinkle','creamyOrange','aquamarine','orchid','buttercup','seafoam','skyMagenta','oceanTeal','sage','sand','mist','clay','slate','peachFuzz','olive','cloud','dustyRose','midnight','forestMoss','parchment','stormySky','terracotta','lavenderMist','warmTaupe','eveningGlow','steelBlue','winterPine'];

function cmdTheme() {
  const sub = args[0];
  if (sub === 'mode') {
    const v = args[1];
    if (v && !['dark', 'light'].includes(v)) return console.log('mode 需 dark|light');
    if (v) { writeSetting('themeMode', v); log('WRITE', `theme mode=${v}`); }
    const cur = readSettingRaw('themeMode');
    console.log(`themeMode = ${cur ?? '未設定'}`);
    log('READ', `theme mode = ${cur ?? '未設定'}`);
  } else if (sub === 'accent') {
    const v = args[1];
    if (v && !ACCENTS.includes(v)) return console.log(`無此強調色: ${v}. 可用: ${ACCENTS.join(', ')}`);
    if (v) { writeSetting('themeAccent', v); log('WRITE', `theme accent=${v}`); }
    const cur = readSettingRaw('themeAccent');
    console.log(`themeAccent = ${cur ?? '未設定'}`);
    log('READ', `theme accent = ${cur ?? '未設定'}`);
  } else if (sub === 'intensity') {
    const v = args[1];
    if (v !== undefined) {
      const n = Math.max(0, Math.min(1, parseFloat(v)));
      if (isNaN(n)) return console.log('intensity 需 0~1 數字');
      writeSetting('themeAccentIntensity', String(n)); log('WRITE', `theme intensity=${n}`);
    }
    const cur = readSettingRaw('themeAccentIntensity');
    console.log(`themeAccentIntensity = ${cur ?? '未設定'}`);
    log('READ', `theme intensity = ${cur ?? '未設定'}`);
  } else if (sub === 'palette' || sub === 'colors') {
    if (args[1]) {
      const colors = args.slice(1).join(',').split(',').map(s => s.trim()).filter(Boolean);
      writeSetting('colorPalette', JSON.stringify(colors));
      log('WRITE', `colorPalette = ${JSON.stringify(colors)}`);
    }
    const cur = readSettingRaw('colorPalette');
    console.log(`colorPalette = ${cur ?? '未設定'}`);
    log('READ', `colorPalette = ${cur ?? '未設定'}`);
  } else {
    console.log('theme 子命令: mode <dark|light> | accent <名> | intensity <0~1> | palette <#色,...>');
    console.log(`可用強調色: ${ACCENTS.join(', ')}`);
    log('READ', 'theme 用法 (help)');
  }
}

// ═══════════════ TTS / 發音 (對應 UI: 語速/語音/音高/引擎) ═══════════════

function cmdTts() {
  const sub = args[0];
  const v = args[1];
  if (sub === 'speed') {
    if (v !== undefined) {
      const n = Math.max(0.3, Math.min(3.0, parseFloat(v)));
      if (isNaN(n)) return console.log('speed 需數字');
      writeSetting('ttsSpeed', String(n)); log('WRITE', `tts speed=${n}`);
    }
    const cur = readSettingRaw('ttsSpeed');
    console.log(`ttsSpeed = ${cur ?? '未設定'}`);
    log('READ', `tts speed = ${cur ?? '未設定'}`);
  } else if (sub === 'voice') {
    if (v) { writeSetting('ttsVoice', v); log('WRITE', `tts voice=${v}`); }
    const cur = readSettingRaw('ttsVoice');
    console.log(`ttsVoice = ${cur ?? '未設定'}`);
    log('READ', `tts voice = ${cur ?? '未設定'}`);
  } else if (sub === 'pitch') {
    if (v !== undefined) {
      const n = Math.max(0, Math.min(99, parseInt(v)));
      if (isNaN(n)) return console.log('pitch 需 0~99 數字');
      writeSetting('ttsPitch', String(n)); log('WRITE', `tts pitch=${n}`);
    }
    const cur = readSettingRaw('ttsPitch');
    console.log(`ttsPitch = ${cur ?? '未設定'}`);
    log('READ', `tts pitch = ${cur ?? '未設定'}`);
  } else if (sub === 'engine') {
    if (v) { writeSetting('ttsEngine', v); log('WRITE', `tts engine=${v}`); }
    const cur = readSettingRaw('ttsEngine');
    console.log(`ttsEngine = ${cur ?? '未設定'}`);
    log('READ', `tts engine = ${cur ?? '未設定'}`);
  } else {
    console.log('tts 子命令: speed <0.3~3> | voice <名> | pitch <0~99> | engine <名>');
  }
}

// ─── 發音播放 — 對應單字列「發音」按鈕 (用系統 espeak-ng 播放) ───
function cmdTtsPlay() {
  const id = args[0];
  if (!id) return console.log('需: tts-play <單字id或英文> [--text "自訂文字"]');
  let text = args.includes('--text') ? args[args.indexOf('--text') + 1] : null;
  const w = findWord(id);
  if (!w && !text) return console.log('找不到單字');
  if (!text) text = w.word;
  const speed = db.prepare(`SELECT value FROM settings WHERE key='ttsSpeed'`).get();
  const pitch = db.prepare(`SELECT value FROM settings WHERE key='ttsPitch'`).get();
  const spd = speed ? parseFloat(speed.value) : 0.9;
  const pch = pitch ? parseInt(pitch.value) : 50;
  const rate = Math.max(80, Math.min(450, Math.round(175 * spd)));
  log('RUN', `tts-play "${text}" (rate=${rate} pitch=${pch})`);
  const r = spawnSync('espeak-ng', ['-s', String(rate), '-p', String(pch), text], { stdio: 'inherit' });
  if (r.status !== 0) console.log(`espeak-ng 播放失敗 (exit ${r.status})`);
  log('READ', `tts-play "${text}" exit=${r.status}`);
}

// ═══════════════ 每日設定 / 目標 (對應 UI: dayCutoff、每日目標) ═══════════════

function cmdDay() {
  const v = args[0];
  if (v !== undefined) {
    const n = Math.max(0, Math.min(1439, parseInt(v)));
    if (isNaN(n)) return console.log('需 0~1439 分鐘');
    writeSetting('dayCutoff', String(n)); log('WRITE', `dayCutoff=${n} (${Math.floor(n/60)}:${String(n%60).padStart(2,'0')})`);
    audit('setting', `SET dayCutoff=${n}`);
  }
  const cur = readSettingRaw('dayCutoff');
  if (cur === null) {
    // E14: 未寫過≠0——誠實標未設定，0:00 註記出處=app 端降級守門（store.js dayCutoff
    // 初始 0＋typeof 非 number 降 0），非 CLI 自創預設（免第二真值源漂移）。
    console.log('dayCutoff = 未設定（app 預設 0 → 0:00 為日界線）');
    log('READ', 'dayCutoff = 未設定');
  } else {
    console.log(`dayCutoff = ${cur} 分鐘 (${Math.floor(cur/60)}:${String(cur%60).padStart(2,'0')} 為日界線)`);
    log('READ', `dayCutoff = ${cur} 分鐘`);
  }
}

function cmdGoal() {
  const v = args[0];
  if (v !== undefined) {
    const n = parseInt(v);
    if (isNaN(n) || n < 0) return console.log('需 >= 0 數字');
    backupDb();
    const w = dbw();
    w.prepare('UPDATE goal_streak SET daily_goal=? WHERE id=1').run(n);
    w.close();
    log('WRITE', `goal daily_goal=${n}`);
    audit('setting', `SET dailyGoal=${n}`);
  }
  const g = db.prepare('SELECT * FROM goal_streak WHERE id=1').get();
  console.log(`每日目標: ${g?.daily_goal} | 今日進度: ${g?.current} | 最佳連續: ${g?.best}`);
  log('READ', `goal: daily=${g?.daily_goal} current=${g?.current} best=${g?.best}`);
}

function cmdStreak() {
  const g = db.prepare('SELECT * FROM goal_streak WHERE id=1').get();
  if (!g) return console.log('無 goal_streak');
  const dates = JSON.parse(g.dates || '{}');
  for (const [mode, list] of Object.entries(dates)) {
    console.log(`  ${mode}: ${list.length} 天 [${list.slice(-10).join(', ')}]`);
  }
  console.log(`best=${g.best}`);
  log('READ', `streak: best=${g.best} modes=${Object.keys(dates).length}`);
}

// ═══════════════ Anki / FSRS 參數 (對應 UI 設定頁) ═══════════════

function cmdAnkiGet(mode) {
  const key = mode === 'mc' ? 'ankiSettingsMc' : mode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
  const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
  if (!r) return console.log(`無 ${key}`);
  console.log(`${key} = ${r.value}`);
  log('READ', `anki ${mode}: ${r.value.slice(0, 100)}`);
}

function cmdAnkiSet() {
  // args = ['set', 欄位, 值, ...]
  const key = args[1];
  const value = args[2];
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'flip';
  const skey = mode === 'mc' ? 'ankiSettingsMc' : mode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
  if (!key || value === undefined) {
    return cmdAnkiGet(mode);
  }
  const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(skey);
  const s = r ? JSON.parse(r.value) : {};
  const valid = ['maxIvl','cardsPerDay','lapseMult','leechThreshold','desiredRetention','learnSteps','relearnSteps','reviewMix','timezoneOffset','learnAheadLimit'];
  if (!valid.includes(key)) return console.log(`欄位須為: ${valid.join(', ')}`);
  let nv = value;
  if (['maxIvl','cardsPerDay','leechThreshold','reviewMix','timezoneOffset','learnAheadLimit'].includes(key)) {
    if (key === 'learnAheadLimit') {
      const p = parseInt(value);
      if (Number.isNaN(p)) {
        console.warn(`learnAheadLimit 非數值「${value}」，已自動設為 20`);   // L1: ⑦定案 CLI warn
        nv = 20;
      } else {
        nv = clampLearnAhead(p);   // L1: 0 保留、-5→0、999→20
      }
    } else {
      nv = parseInt(value);
    }
  }
  else if (['lapseMult','desiredRetention'].includes(key)) nv = parseFloat(value);
  if (isNaN(nv) && typeof nv !== 'string') return console.log('數值無效');
  s[key] = nv;
  backupDb();
  writeSetting(skey, JSON.stringify(s));
  log('WRITE', `anki ${mode} ${key}=${nv}`);
  console.log(`${skey} 已更新: ${JSON.stringify(s, null, 1)}`);
}

function cmdAnki() {
  const sub = args[0];
  if (sub === 'set') { cmdAnkiSet(); return; }
  const mode = args[0];
  if (mode && ['flip', 'mc', 'spell'].includes(mode)) { cmdAnkiGet(mode); return; }
  cmdAnkiGet('flip'); cmdAnkiGet('mc'); cmdAnkiGet('spell');
  console.log('\n用法: anki [flip|mc|spell] | anki set <欄位> <值> [--mode flip|mc|spell]');
  console.log('欄位: maxIvl cardsPerDay lapseMult leechThreshold desiredRetention learnSteps relearnSteps reviewMix timezoneOffset learnAheadLimit');
}

// ═══════════════ Sim 參數 ═══════════════

function cmdSimParams() {
  const sub = args[0];
  const r = db.prepare(`SELECT value FROM settings WHERE key='simParams'`).get();
  const s = r ? JSON.parse(r.value) : {};
  if (sub === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) return console.log('需: sim set <欄位> <值>');
    const valid = ['maxReviewsPerDay','maxCostPerDay','learningStepCount','relearningStepCount','humanSkipRate','humanJitter','humanWeekendMod','humanAccRange','humanFatigueProb'];
    if (!valid.includes(key)) return console.log(`欄位須為: ${valid.join(', ')}`);
    // E13: 寫入守門——parseFloat NaN 經 JSON.stringify 序列化 null 落盤污染
    // （store.js:363 {...DEFAULT_SIM, ...simParams} null 覆蓋預設值，無錯誤回聲）；
    // '5abc' 部分截斷同堵——Number 全字串語意（'5abc'→NaN），'' →0 陷阱另堵 trim 空。
    const num = Number(value.trim());
    if (value.trim() === '' || !Number.isFinite(num)) { process.exitCode = 1; return console.log(`❌ 值須為有限數字（收到 "${value}"）`); }
    s[key] = num;
    backupDb();
    writeSetting('simParams', JSON.stringify(s));
    log('WRITE', `simParams ${key}=${value}`);
  }
  console.log(JSON.stringify(s, null, 1));
}

// ═══════════════ 過濾 Deck / 其他 (對應 UI) ═══════════════

function cmdFilteredDecks() {
  const rows = db.prepare('SELECT * FROM filtered_decks ORDER BY created_at').all();
  console.log(`過濾 Deck (${rows.length} 個):`);
  for (const r of rows) console.log(`  ${r.id} ${r.name} query="${r.search_query}" max=${r.max_cards}`);
  log('READ', `filtered: ${rows.length} 個`);
}

function cmdFilteredDeckAdd() {
  const name = args[0];
  const query = args.includes('--query') ? args[args.indexOf('--query') + 1] : null;
  if (!name || !query) return console.log('需: filtered-add <名> --query "搜尋語法" [--max N] [--color #hex]');
  const max = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : 100;
  const color = args.includes('--color') ? args[args.indexOf('--color') + 1] : '#f59e0b';
  backupDb();
  const w = dbw();
  const id = 'fd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  w.prepare('INSERT INTO filtered_decks (id, name, search_query, max_cards, order_by, color) VALUES (?,?,?,?,?,?)').run(id, name, query, max, 'due', color);
  w.close();
  log('WRITE', `filtered-add ${name} query="${query}" max=${max}`);
  console.log(`已建立過濾 deck "${name}" → ${id}`);
}

function cmdFilteredDeckDelete() {
  const name = args[0];
  if (!name) return console.log('需過濾 deck 名');
  backupDb();
  const w = dbw();
  w.prepare('DELETE FROM filtered_decks WHERE name=? OR id=?').run(name, name);
  w.close();
  log('WRITE', `filtered-delete ${name}`);
  console.log(`已刪除過濾 deck "${name}"`);
}

// ═══════════════ 匯入 / 還原 / 重置 (對應 UI 資料區) ═══════════════

function cmdResetAll() {
  if (!args.includes('--yes')) return console.log('⚠ 將清空所有資料! 加 --yes 確認');
  backupDb();
  const w = dbw();
  for (const t of ['cards', 'review_log', 'words', 'edits', 'exam_history', 'decks', 'additions', 'filtered_decks']) {
    w.prepare(`DELETE FROM ${t}`).run();
  }
  w.prepare('DELETE FROM settings WHERE key IN ("deckOrder","examSessions")').run();
  w.prepare('UPDATE goal_streak SET daily_goal=20, current=0, best=0, dates="{}" WHERE id=1').run();
  w.close();
  log('WRITE', 'reset-all 清空全部資料');
  audit('reset-all', 'CLI 重設所有資料');
  console.log('已清空全部資料');
}

// ═══════════════ exam 測驗紀錄 (對應 UI) ═══════════════

function cmdExam() {
  const sub = args[0];
  if (sub === 'list') {
    // B4: word 欄位語意統一為 word_id → LEFT JOIN words 顯示現名（M4：改名不再孤立）；?? r.word 降級 B4 前舊文字資料
    const rows = db.prepare(
      'SELECT h.*, w.word AS word_text FROM exam_history h LEFT JOIN words w ON w.id = h.word ORDER BY h.id DESC LIMIT 30'
    ).all();
    console.log(`測驗紀錄 (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.id} ${r.word_text ?? r.word} ${r.correct ? '✓' : '✗'} ${r.question_type} ${r.examinated_at ?? r.examined_at}`);
    log('READ', `exam list: ${rows.length} 筆`);
  } else if (sub === 'clear') {
    if (!args.includes('--yes')) return console.log('將清除全部測驗紀錄, 加 --yes');
    backupDb();
    const w = dbw();
    w.prepare('DELETE FROM exam_history').run();
    w.close();
    log('WRITE', 'exam clear');
    audit('exam-clear', '清除測驗紀錄');
    console.log('已清除測驗紀錄');
  } else {
    console.log('exam 子命令: list | clear --yes');
  }
}

// ─── 測驗執行 — 對應測驗頁「開始測驗」(翻卡/多選/拼字共通流程) ───
function cmdExamRun() {
  const mode = args[0] || 'flip';
  if (!['flip', 'mc', 'spell'].includes(mode)) return console.log('模式: flip | mc | spell');
  const deck = args.includes('--deck') ? args[args.indexOf('--deck') + 1] : null;
  const count = args.includes('--count') ? parseInt(args[args.indexOf('--count') + 1]) : 0;
  const tagCorrect = args.includes('--tag-correct') ? args[args.indexOf('--tag-correct') + 1] : 'correct';
  const tagWrong = args.includes('--tag-wrong') ? args[args.indexOf('--tag-wrong') + 1] : 'wrong';
  const autoNext = !args.includes('--no-autonext');

  const words = db.prepare('SELECT id, word, definition, deck, tags FROM words').all();
  const pool = deck ? words.filter(w => w.deck === deck) : words;
  if (!pool.length) return console.log('無詞池 (deck 篩選無結果)');
  const list = count > 0 ? pool.slice(0, Math.min(count, pool.length)) : pool;

  console.log(`${mode} 測驗: 詞池 ${pool.length}, 本次 ${list.length} 題${deck ? ` (deck=${deck})` : ''}${count ? '' : ' (全部)'}`);
  console.log(`答對標籤: ${tagCorrect} | 答錯標籤: ${tagWrong}${autoNext ? '' : ' (手動下一題)'}`);
  console.log('');

  backupDb();
  const w = dbw();
  let correct = 0, wrong = 0;
  const results = [];

  // 批次收集所有評判結果 (mock: 依設定比例, 或用 --correct <答案順序>)
  const answerSeq = args.includes('--answers')
    ? args[args.indexOf('--answers') + 1].split(',').map(x => x.trim())
    : null;
  const correctPct = args.includes('--correct-pct') ? parseInt(args[args.indexOf('--correct-pct') + 1]) : 80;

  const applyTag = (wordId, tag, opposite) => {
    const row = db.prepare('SELECT tags FROM words WHERE id=?').get(wordId);
    let tags = row ? JSON.parse(row.tags || '[]') : [];
    const changed = !tags.includes(tag) || tags.includes(opposite);
    if (changed) {
      tags = tags.filter(t => t !== opposite);
      if (!tags.includes(tag)) tags.push(tag);
      w.prepare('UPDATE words SET tags=? WHERE id=?').run(JSON.stringify(tags), wordId);
    }
  };

  for (let i = 0; i < list.length; i++) {
    const wd = list[i];
    let isCorrect;
    if (answerSeq) {
      isCorrect = (answerSeq[i % answerSeq.length] || '1') === '1';
    } else {
      isCorrect = Math.random() * 100 < correctPct;
    }
    if (isCorrect) { correct++; applyTag(wd.id, tagCorrect, tagWrong); }
    else { wrong++; applyTag(wd.id, tagWrong, tagCorrect); }
    w.prepare('INSERT INTO exam_history (word, correct, question_type, examined_at) VALUES (?,?,?,?)').run(wd.id, isCorrect ? 1 : 0, mode, new Date().toISOString());   // B4: wd.word→wd.id（word 欄位語意統一為 word_id；E2 ISO 保留）
    results.push({ word: wd.word, correct: isCorrect });
  }
  w.close();

  console.log(`完成: ${list.length} 題 | 答對 ${correct} | 答錯 ${wrong}`);
  console.log(`結果: ${results.map(r => (r.correct ? '✓' : '✗') + r.word).join(' ')}`);
  log('WRITE', `exam-run ${mode}: ${list.length} 題 對${correct}/錯${wrong} deck=${deck ?? '全部'} tags=${tagCorrect}/${tagWrong}`);
}

function writeSetting(key, value) {
  const w = dbw();
  w.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  w.close();
}
// E14: settings 讀回顯統一——get() 無列回 undefined，直接串 .value 崩 TypeError
// 被頂層 catch 吞成「命令 X 失敗」exit 0；?..value 又會輸出『X = undefined』垃圾行
// （cmdDay 還吞進運算變 NaN:NaN）。回 null 讓顯示層分支誠實標『未設定』。
const readSettingRaw = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;

// ═══════════════ 設定 ═══════════════

function cmdSettings() {
  const key = args[0];
  if (key) {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    console.log(r ? `${key} = ${r.value}` : `無此設定: ${key}`);
    return;
  }
  const rows = db.prepare('SELECT key, substr(value,1,80) v FROM settings ORDER BY key').all();
  for (const r of rows) console.log(`  ${r.key} = ${r.v}`);
  log('READ', `settings: ${rows.length} 個 key`);
}

function cmdSet() {
  const key = args[0];
  const value = args[1];
  if (!key || value === undefined) return console.log('需: set <key> <value> (JSON 或字串)');
  backupDb();
  const w = dbw();
  w.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  w.close();
  log('WRITE', `set ${key} = ${String(value).slice(0, 80)}`);
  console.log(`已設定 ${key} = ${value}`);
}

// ═══════════════ CSV 匯入匯出 ═══════════════

// D8: CSV 合同對齊 —— export/import 一律經 src/core/import.js 單一真值源
// （buildCSV/parseCSVTable/resolveField），消滅 CLI 平行實作：舊 7 欄 header、
// split-tags 雙序列化、逐行 parse 斷行、大小寫丟失四病灶一次清除。

function cmdExportCsv() {
  const out = args[0] || `${HOME}/影片/teno-export-${new Date().toISOString().slice(0,10)}.csv`;
  const rows = db.prepare('SELECT word, definition, part_of_speech, pronunciation, example, deck, image, description, tags, related, forms, synonym, antonym, derivative, examples FROM words ORDER BY word').all();
  // JSON 陣列欄一律 parse 成陣本體（非 canonical 測資經 buildCSV rebuild 正規化——
  // 字節合同＝buildCSV(canonical 映射)，不 parse 直傳原字串即違約）
  const parseArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : String(s ?? ''); } catch { return String(s ?? ''); } };
  const mapped = rows.map(r => ({
    word: r.word, definition: r.definition ?? '', pos: r.part_of_speech ?? '', pron: r.pronunciation ?? '',
    example: r.example ?? '', deck: r.deck ?? '', image: r.image ?? '', description: r.description ?? '',
    tags: parseArr(r.tags), related: parseArr(r.related), forms: parseArr(r.forms),
    synonym: r.synonym ?? '', antonym: r.antonym ?? '', derivative: r.derivative ?? '',
    examples: parseArr(r.examples),
  }));
  writeFileSync(out, buildCSV(mapped));
  log('READ', `export-csv ${rows.length} 筆 → ${out}`);
  console.log(`已匯出 ${rows.length} 筆 → ${out}`);
}

function cmdImportCsv() {
  const file = args[0];
  if (!file) return console.log('需 CSV 路徑 (header 經 resolveField 合同正規化，app 匯出與舊 7 欄檔、中文頭全認識)');
  if (!existsSync(file)) return console.log('檔案不存在');
  const text = readFileSync(file, 'utf8');
  const { headers, rows } = parseCSVTable(text);   // 多行 quoted 安全＋BOM 容忍
  const fields = headers.map(h => resolveField(h));
  backupDb();
  const w = dbw();
  let added = 0, skipped = 0;
  const existing = new Set(db.prepare('SELECT lower(word) w FROM words').all().map(x => x.w));
  // 裸文字陣列欄 fallback 三規格（鏡像 mapWords import.js:191/193/196-199），入庫 canonical stringify
  const fTags = (v) => { let p; try { p = JSON.parse(v); } catch { p = v.split(',').map(s => s.trim()).filter(Boolean); } return JSON.stringify(p); };
  const fExamples = (v) => { let p; try { p = JSON.parse(v); } catch { p = v.split(';').map(e => ({ en: e.trim(), zh: '' })); } return JSON.stringify(p); };
  const fArray = (v) => { let p = null; try { p = JSON.parse(v); } catch {} return JSON.stringify(Array.isArray(p) ? p : v.split(',').map(s => s.trim()).filter(Boolean)); };
  const stmt = w.prepare(`INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const cols of rows) {
    const obj = {};
    cols.forEach((v, j) => { const k = fields[j]; if (k) obj[k] = String(v ?? '').trim(); });
    const wordRaw = obj.word || '';
    const wd = wordRaw.toLowerCase();   // 去重 lower 比對（既存語意）；入庫保留原文大小寫
    if (!wd || existing.has(wd)) { skipped++; continue; }
    existing.add(wd);
    const id = nextWordId();
    stmt.run(id, wordRaw, obj.definition || '', obj.pos || '', obj.pron || '',
      obj.example || '', obj.deck || 'Default',
      obj.tags ? fTags(obj.tags) : '[]', obj.image || '', obj.description || '',
      obj.related ? fArray(obj.related) : '[]', obj.forms ? fArray(obj.forms) : '[]',
      obj.synonym || '', obj.antonym || '', obj.derivative || '',
      obj.examples ? fExamples(obj.examples) : '[]',
      new Date().toISOString());   // E2: created_at ISO 帶 Z
    added++;
  }
  w.close();
  log('WRITE', `import-csv ${file}: 新增 ${added}, 跳過 ${skipped}`);
  audit('import-csv', `匯入 CSV ${args[0] || ''}`);
  console.log(`匯入完成: 新增 ${added}, 跳過重複 ${skipped}`);
}

// ═══════════════ 評分 / 模擬 ═══════════════

function cmdRate() {
  const id = args[0];
  const rating = parseInt(args[1]);
  if (!id || isNaN(rating) || rating < 0 || rating > 3) return console.log('需: rate <id> <0|1|2|3> (Again/Hard/Good/Easy) [--date YYYY-MM-DD]');
  const w = findWord(id);
  if (!w) return console.log('找不到');
  // --date: 模擬在指定日期作答 (時間沙箱注入)
  const rateDate = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  // E9: --date 強驗證（usage 契約 YYYY-MM-DD）。無效字串 rateNow=NaN →
  // toISOString RangeError 難懂堆疊；2026-02-30 級 out-of-range V8 靜默
  // rollover（實測 2/30→3/2）＝無聲資料污染，round-trip 守門同堵兩類＋缺值。
  if (args.includes('--date')) {
    const dd = rateDate != null ? new Date(rateDate + 'T08:00:00Z') : null;
    const dateOk = dd != null && /^\d{4}-\d{2}-\d{2}$/.test(rateDate)
      && Number.isFinite(dd.getTime()) && dd.toISOString().slice(0, 10) === rateDate;
    if (!dateOk) { process.exitCode = 1; return console.log(`❌ --date 需有效日期 YYYY-MM-DD（收到 "${rateDate ?? ''}"）`); }
  }
  const rateNow = rateDate ? new Date(rateDate + 'T08:00:00Z').getTime() : Date.now();
  // 時間沙箱: 把整個 rate 流程困在指定時間
  if (rateDate) {
    const realNow = Date.now.bind(Date);
    Date.now = () => rateNow;
    // 結束時還原
    setTimeout(() => { Date.now = realNow; }, 0);
  }
  const s = loadState();
  // E5: FSRS 構造讀 ankiSettings（原 makeSession→new FSRS() 預設權重 → 與 app/replay 漂移）
  const { fsrs, learnSteps, relearnSteps } = fsrsCtx('flip');
  let card = s.cards.get(w.id);
  const isNew = !card;
  if (!card) {
    // E5: 新卡 FSRS 起始 state 對齊 store.rateCard:697-704 else 分支（stability=0，非 1）
    card = { due: new Date(rateNow).toISOString(), stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0, step: 0, lastReview: null, buried: false, suspended: false, interval: 0 };
  }
  // E4: elapsed 與 store.rateCard:683-687 同法（dayCutoff/tz-aware，normTs 防 legacy naive）
  // — 修前 cmdRate 完全不算 elapsed，stale card.elapsedDays 直接進 FSRS（delta_t 漂移）
  const lastTs = card.lastReview ? new Date(normTs(card.lastReview)).getTime() : null;
  const rateTodayStr = getToday(DAY_CUTOFF, TZ_OFFSET, rateNow);
  const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), TZ_OFFSET, DAY_CUTOFF) : null;
  // 審查 MED-1: --date 亂序回填可產生負日差 — fsrs-rs elapsed_days 為 u32（serde 反序列化
  // 負值整批失敗）、py-fsrs delta_t 同爆 → 持久化前夾 0（fsrs.js:300 內部同款 max(0,·)）
  const elapsed = lastDay != null ? Math.max(0, daysBetween(lastDay, rateTodayStr)) : 0;
  // E5: 確定性 fuzz（wordId+'_'+mode+reps，與 store.rateCard:709 同 seed 式）＋
  // REVIEW/RELEARNING 套 greaterThanLast load-balancing（futureCounts，store:714-716
  // 同條件、複習前 cardMap 快照）— 修前 Math.random() 不可重現、無 load-balancing
  const fuzz = generateFuzzFactor(w.id + '_flip', card.reps ?? 0);
  const futureCounts = (!isNew && (card.state === 2 || card.state === 3))
    ? computeFutureDueCounts(s.cards, 90, DAY_CUTOFF, TZ_OFFSET) : null;
  const res = fsrs.review({ ...card, elapsedDays: elapsed }, rating, fuzz, learnSteps, relearnSteps, futureCounts);
  // A10: due 錨定 Anki 日界線（與 store.rateCard 同一 computeDueIso）— 非作答時刻
  const dueIso = computeDueIso(res.dueDays, res.state, DAY_CUTOFF, TZ_OFFSET, new Date(rateNow).toISOString());
  const sched = res.state === 2 ? Math.round(res.dueDays) : res.dueDays;
  const nowIso = new Date(rateNow).toISOString();
  backupDb();
  const wdb = dbw();
  if (isNew) {
    wdb.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0)`).run(
      w.id, dueIso, res.stability, res.difficulty, elapsed, sched,
      res.reps, res.lapses, res.state, res.step ?? 0, nowIso);
  } else {
    // E4: UPDATE 補 elapsed_days — 修前永不寫回 → 下次 rate delta_t 用陳舊值
    wdb.prepare(`UPDATE cards SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?, reps=?, lapses=?, state=?, step=?, last_review=? WHERE word_id=?`).run(
      dueIso, res.stability, res.difficulty, elapsed, sched,
      res.reps, res.lapses, res.state, res.step ?? 0, nowIso, w.id);
  }
  ensureSchema();
  // card_state = 複習前狀態, new_state = 複習後狀態 (與 app 一致)
  // E4: 補齊 duration/elapsed_days/scheduled_days/stability/difficulty — 欄位語意對齊
  // store.js rateCard:792-803 + db.js addReviewLog（duration 缺→null、elapsed=複習前、
  // scheduled=Math.round(dueDays)、stability/difficulty=複習後）。官方優化器由時間戳
  // 重算 delta_t（params.rs days_elapsed），本補齊確保 cards 排程 delta_t 新鮮＋log
  // 與 app/Anki schema 一致（匯出/第三方工具 ground truth）。
  wdb.prepare(`INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    w.id, rating, null, elapsed, Math.round(res.dueDays), res.stability, res.difficulty,
    'flip', isNew ? 0 : (card.state ?? 0), res.state, nowIso);
  wdb.close();
  console.log(`${w.word} rating=${rating} → state=${res.state} step=${res.step ?? 0} due=${dueIso} (本機日=${localDue(dueIso)})`);
  log('WRITE', `rate ${w.word} (${w.id}) rating=${rating} → state=${res.state} step=${res.step ?? 0} due=${dueIso}`);
}

function cmdSim() {
  // E5 R2: --now <ISO> 時鐘沙箱（比照 cmdRate --date 模式，但完整替換 Date —
  // cmdSim 的 due 走 new Date(Date.now()+·)、新卡走 new Date()，只覆 Date.now 抓不住
  // new Date()）。修前 wall-clock 敏感 → 同 DB 兩次 sim 輸出 flaky（審查 #3 實測 ~24%）
  const simNowArg = args.includes('--now') ? args[args.indexOf('--now') + 1] : null;
  if (simNowArg) {
    const nowMs = new Date(simNowArg).getTime();
    if (!Number.isFinite(nowMs)) return console.log(`無效的 --now 時間: ${simNowArg}`);
    const RealDate = Date;
    class SandboxDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
      static now() { return nowMs; }
    }
    globalThis.Date = SandboxDate;
    setTimeout(() => { globalThis.Date = RealDate; }, 0);
  }
  const s = loadState();
  const session = makeSession(s);
  // E5: 寫入路徑同權重原則不適用 sim（記憶體 queue 壓力測試、不落庫），但 fuzz 仍須
  // 確定性可重現（debug stray）＋REVIEW/RELEARNING 套 load-balancing 貼近 app 行為
  const { fsrs, learnSteps, relearnSteps } = fsrsCtx('flip');
  const ratings = args.includes('--ratings')
    ? args[args.indexOf('--ratings') + 1].split(',').map(Number)
    : null;
  session.start(null);
  const start = { intraday: session.intradayLearning.length, main: session.mainQueue.length };
  const seen = new Set();
  let i = 0, repeat = false;
  while (session.running && i < 50000) {
    const c = session._next();
    if (!c) break;
    const wid = c.word.id;
    if (seen.has(wid)) repeat = true;
    seen.add(wid);
    const rating = ratings ? ratings[i % ratings.length] : [0,1,2,2,3][Math.floor(Math.random()*5)];
    let card = session.cards.get(wid);
    if (!card) {
      // E5: 新卡起始 state 對齊 app（stability=0）
      card = { due: new Date().toISOString(), stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0, step: 0, lastReview: null, buried: false, suspended: false, interval: 0 };
      session.cards.set(wid, card);
    }
    // E5: seeded fuzz（與 app 同 seed 式）＋ REVIEW/RELEARNING futureCounts 即時快照
    const fuzz = generateFuzzFactor(wid + '_flip', card.reps ?? 0);
    const futureCounts = (card.state === 2 || card.state === 3)
      ? computeFutureDueCounts(session.cards, 90, DAY_CUTOFF, TZ_OFFSET) : null;
    const res = fsrs.review(card, rating, fuzz, learnSteps, relearnSteps, futureCounts);
    card.state = res.state; card.due = new Date(Date.now() + Math.max(60000, Math.round(res.dueDays * 86400000))).toISOString();
    card.step = res.step ?? 0;
    card.interval = res.dueDays ?? 0;
    // E5 R2: reps 推進貼齊 app（store rateCard 每複習 reps+1）— 修前 card.reps 恆 0 →
    // fuzz seed 同卡恆定，與 app 每複習 seed 變異分歧；亦影響 queue cmpByRepsThenDue 排序
    card.reps = res.reps ?? (card.reps ?? 0) + 1;
    session.rate(rating);
    session.requeueIntraday(wid, card);
    session.next();
    i++;
  }
  const stray = [];
  for (const w of s.words) {
    const card = session.cards.get(w.id);
    if (!card || (card.state !== 1 && card.state !== 3)) continue;
    if (!card.due) continue;
    if (localDue(card.due) !== today()) continue;
    const inQ = session.intradayLearning.some(x => x.word?.id === w.id);
    if (!inQ && session.current?.word?.id !== w.id) stray.push({ id: w.id, state: card.state, step: card.step, due: card.due });
  }
  console.log(`\n=== 模擬結果 ===`);
  console.log(`開始: intraday=${start.intraday} main=${start.main}`);
  console.log(`顯示: ${i} 張 | 唯一: ${seen.size} | 重複: ${repeat ? '⚠ 有' : '無'}`);
  console.log(`結束: running=${session.running} intraday=${session.intradayLearning.length} main=${session.mainQueue.length}`);
  if (stray.length) {
    console.log(`\n⚠ 遺漏卡: ${stray.length}`);
    for (const x of stray.slice(0, 30)) console.log(`  ${x.id} state=${x.state} step=${x.step} due=${x.due}`);
  } else console.log(`✅ 無遺漏卡`);
  // E5 R2: 最終卡狀態摘要（確定性驗證錨點 — fuzz 任何非確定性都會翻 digest）
  const digest = createHash('sha256').update(JSON.stringify(
    [...session.cards.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([k, c]) => [k, c.state, c.step, c.reps, Math.round((c.interval ?? 0) * 1e6), c.due]))).digest('hex').slice(0, 16);
  console.log(`digest=${digest}`);
  log('READ', `sim: 顯示=${i} 唯一=${seen.size} 重複=${repeat} stray=${stray.length} digest=${digest}`);
}

function cmdStray() {
  const s = loadState();
  const session = makeSession(s);
  session.buildQueue(null);
  const queueAll = new Set([
    ...session.intradayLearning.map(x => x.word?.id),
    ...session.mainQueue.map(x => x.word?.id),
    session.current?.word?.id,
  ]);
  const stray = [];
  for (const w of s.words) {
    const card = s.cards.get(w.id);
    if (!card || (card.state !== 1 && card.state !== 3)) continue;
    if (!card.due) continue;
    if (localDue(card.due) !== today()) continue;
    if (!queueAll.has(w.id)) stray.push({ id: w.id, word: w.word, state: card.state, step: card.step, due: card.due });
  }
  console.log(`今天到期學習卡不在佇列的: ${stray.length}`);
  for (const x of stray.slice(0, 50)) console.log(`  ${x.id} ${x.word} state=${x.state} step=${x.step} due=${x.due}`);
  if (!stray.length) console.log('✅ 無遺漏');
  log('READ', `stray: ${stray.length} 張遺漏卡`);
}

function cmdDoublefire() {
  const path = args[0] || `${HOME}/.local/share/com.teno.app/logs/teno-monitor.log`;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return console.log(`無此 log: ${path}`); }
  const rates = [];
  for (const l of text.split('\n')) {
    const m = l.match(/\[rate\] (w_\w+) rating= (\d)/);
    if (m) rates.push(m[1]);
  }
  const dup = [];
  for (let i = 1; i < rates.length; i++) if (rates[i] === rates[i-1]) dup.push(rates[i]);
  const cnt = {};
  for (const d of dup) cnt[d] = (cnt[d] || 0) + 1;
  console.log(`rate 總數: ${rates.length} | 相鄰同卡(疑似 double-fire): ${dup.length}`);
  for (const [k, v] of Object.entries(cnt).sort((a,b) => b[1]-a[1]).slice(0, 20)) console.log(`  ${k}: ${v} 次`);
  log('READ', `doublefire: rates=${rates.length} 可疑=${dup.length} from ${path}`);
}

// ═══════════════ fix ═══════════════

function cmdFix() {
  const sub = args[0];
  const id = args[1];
  if (!sub) return console.log('fix 子命令: reset-card <id> | graduate <id> | reset-stray | rewind <id>');
  const backup = backupDb();
  const w = dbw();
  try {
    if (sub === 'reset-card' && id) {
      w.prepare(`UPDATE cards SET state=0, step=0, scheduled_days=0, reps=0, lapses=0, stability=2.5, difficulty=0, due=?, last_review=NULL WHERE word_id=?`).run(new Date().toISOString(), id);   // E2: ISO 帶 Z
      log('WRITE', `fix reset-card ${id}`);
      console.log(`已重設 ${id} → 新卡`);
    } else if (sub === 'graduate' && id) {
      w.prepare(`UPDATE cards SET state=2, step=0, scheduled_days=1, due=? WHERE word_id=?`).run(new Date(Date.now() + 86400000).toISOString(), id);   // E2: ISO 帶 Z（固定 24h = SQLite '+1 day'）
      log('WRITE', `fix graduate ${id}`);
      console.log(`已畢業 ${id} → state=2 due 明天`);
    } else if (sub === 'rewind' && id) {
      w.prepare(`UPDATE cards SET due=? WHERE word_id=?`).run(new Date().toISOString(), id);   // E2: ISO 帶 Z
      log('WRITE', `fix rewind ${id}`);
      console.log(`已將 ${id} due 改成現在 (重新進佇列)`);
    } else if (sub === 'reset-stray') {
      const s = loadState();
      const session = makeSession(s);
      session.buildQueue(null);
      const queueAll = new Set([
        ...session.intradayLearning.map(x => x.word?.id),
        ...session.mainQueue.map(x => x.word?.id),
        session.current?.word?.id,
      ]);
      let n = 0;
      for (const wrd of s.words) {
        const card = s.cards.get(wrd.id);
        if (!card || (card.state !== 1 && card.state !== 3)) continue;
        if (localDue(card.due) !== today() || queueAll.has(wrd.id)) continue;
        w.prepare(`UPDATE cards SET due=? WHERE word_id=?`).run(new Date().toISOString(), wrd.id);   // E2: ISO 帶 Z
        console.log(`  修正 ${wrd.id} ${wrd.word} due → 現在`);
        n++;
      }
      console.log(`共修正 ${n} 張遺漏卡`);
      log('WRITE', `fix reset-stray 修正 ${n} 張`);
      audit('fix-reset-stray', `修正 ${n} 張`);
    } else { console.log('未知子命令'); log('WRITE', `fix 未知子命令: ${sub}`); }
    w.close();
  } catch (e) { console.log('錯誤:', e.message); }
}

// ═══════════════ backup/restore ═══════════════

function cmdBackup() {
  const dst = backupDb();
  console.log('備份完成');
}

function cmdRestore() {
  const file = args[0];
  if (!file) return console.log('需備份檔路徑');
  if (!existsSync(file)) return console.log('檔案不存在');
  backupDb();
  rmWal(DB);
  copyFileSync(file, DB);
  log('WRITE', `restore ${file} → ${DB}`);
  console.log(`已還原 ${file} → ${DB}`);
}

// ═══════════════ 工具頁: FSRS 最佳化 / 健康檢查 / 長期模擬 / 測驗紀錄 ═══════════════

async function cmdOptimize() {
  const s = loadState();
  const raw = db.prepare('SELECT * FROM review_log ORDER BY id').all();
  const log2 = raw.map(r => ({ ...r, wordId: r.word_id, elapsedDays: r.elapsed_days }));
  if (log2.length < 10) return console.log(`複習記錄不足: ${log2.length} 筆 (需 ≥ 10)`);
  if (!args.includes('--yes')) return console.log('將覆寫 FSRS 權重 (各模式獨立優化), 加 --yes 確認');
  const start = Date.now();
  // 官方 fsrs-rs 6.6.1 (fsrs_rs_python binding) — 各模式獨立優化、獨立寫入
  const script = new URL('./fsrs-optimize.py', import.meta.url).pathname;
  const venvPy = new URL('./.venv-fsrs/bin/python', import.meta.url).pathname;
  const py = existsSync(venvPy) ? venvPy : 'python3';
  const modes = ['flip', 'mc', 'spell'];
  const results = [];
  let applied = 0;
  for (const mode of modes) {
    const modeLog = log2.filter(e => (e.mode || 'flip') === mode);
    if (modeLog.length < 10) {
      results.push({ mode, skipped: `僅 ${modeLog.length} 筆 (<10)` });
      continue;
    }
    log('RUN', `optimize ${mode} 開始 (${modeLog.length} 筆複習記錄)`);
    const proc = spawnSync(py, [script, '--db', DB, '--mode', mode, '--json'], { encoding: 'utf8', timeout: 600000 });
    if (proc.error) { results.push({ mode, skipped: proc.error.message }); continue; }
    if (proc.status !== 0) { results.push({ mode, skipped: (proc.stderr || proc.stdout || '').trim() }); continue; }
    let out;
    try { out = JSON.parse(proc.stdout.trim().split('\n').pop()); } catch { results.push({ mode, skipped: '輸出無法解析' }); continue; }
    if (out.error) { results.push({ mode, skipped: out.error }); continue; }
    const weightsStr = out.weights.map(w => w.toFixed(4)).join(', ');
    if (applied === 0) backupDb();  // 第一次成功寫入前備份一次
    const key = mode === 'mc' ? 'ankiSettingsMc' : mode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
    const w = dbw();
    const r = w.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
    const obj = r ? JSON.parse(r.value) : {};
    obj.fsrsWeights = weightsStr;
    w.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(obj));
    w.close();
    applied++;
    const lossStr = out.loss != null ? ` loss=${out.loss.toFixed(4)}` : '';
    results.push({ mode, weightsStr, lossStr, reviewCount: out.reviewCount, items: out.items });
    log('WRITE', `optimize ${mode} 完成 (官方 fsrs-rs)${lossStr} 耗時=${((Date.now()-start)/1000).toFixed(1)}s`);
  }
  const totalStr = `耗時=${((Date.now()-start)/1000).toFixed(1)}s`;
  for (const r of results) {
    if (r.skipped) console.log(`  ${r.mode}: 跳過 — ${r.skipped}`);
    else console.log(`  ${r.mode}: ${r.weightsStr}${r.lossStr} (${r.reviewCount} 筆)`);
  }
  if (applied === 0) return console.log(`最佳化完成但無任何模式套用 (官方 fsrs-rs, ${totalStr})`);
  log('WRITE', `optimize 完成 (官方 fsrs-rs, 套用 ${applied} 模式) ${totalStr}`);
  console.log(`最佳化完成 (官方 fsrs-rs 6.6.1, ${totalStr}) — 套用 ${applied}/3 模式`);
}

async function cmdHealth() {
  const s = loadState();
  const as = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
  const anki = as ? JSON.parse(as.value) : {};
  const log2 = db.prepare('SELECT * FROM review_log ORDER BY id').all();
  const { healthCheck } = await import('../src/core/fsrs-optimizer.js');
  const report = healthCheck(s.cards, log2, anki, s.words);
  console.log(JSON.stringify(report, null, 1));
  log('READ', `health: cards=${report.totalCards} retention=${report.retention?.toFixed(3)} leeches=${report.leeches}`);
}

// ─── FSRS 行為監測報告 — 從 review_log 重建 FSRS 決策並分析 ───
async function cmdFsrsReport() {
  const s = loadState();
  const log2 = db.prepare('SELECT * FROM review_log ORDER BY id').all();
  const as = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
  const anki = as ? JSON.parse(as.value) : {};

  const mod = await import('../src/core/fsrs.js');
  const { FSRS: F, STATE_NEW: SN, generateFuzzFactor } = mod;
  const fsrs = new F(anki.fsrsWeights ? (() => { try { return JSON.parse('[' + anki.fsrsWeights + ']'); } catch { return null; } })() : null);
  const learnSteps = (anki.learnSteps || '1,10').split(',').map(x => parseFloat(x.trim()) / 1440);
  const relearnSteps = (anki.relearnSteps || '10').split(',').map(x => parseFloat(x.trim()) / 1440);

    // 重建每張卡在每個 review 時刻的狀態, 重算 FSRS 決策 (只用於狀態轉移)
    const byWord = {};
    for (const e of log2) {
      (byWord[e.word_id] = byWord[e.word_id] || []).push(e);
    }
    let totalReviews = 0;
    const ratingDist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const stateTransitions = {};
    const ivlBuckets = { '<1d': 0, '1-3d': 0, '4-7d': 0, '1-2w': 0, '2-4w': 0, '1-3m': 0, '3m+' : 0 };

    for (const [wid, entries] of Object.entries(byWord)) {
      const base = { stability: 2.5, difficulty: 0, state: SN, reps: 0, lapses: 0, elapsedDays: 0, scheduledDays: 0, step: 0 };
      for (const e of entries.sort((a, b) => (normTs(a.reviewed_at) || '').localeCompare(normTs(b.reviewed_at) || ''))) {   // E2: normTs sort key
        const state = base.state;
        const rating = e.rating ?? 2;
        // deterministic fuzz, 與 app 一致 (wordId + mode + reps)
        const fuzz = generateFuzzFactor(e.word_id + '_' + (e.mode || 'flip'), base.reps);
        const result = fsrs.review(base, rating, fuzz, learnSteps, relearnSteps, null);
        totalReviews++;
        ratingDist[rating] = (ratingDist[rating] || 0) + 1;
        // 有 new_state 直接讀真相 (v5.2+), 舊 log 才用 replay 結果
        const newState = e.new_state ?? result.state;
        const key = `${state}->${newState}`;
        stateTransitions[key] = (stateTransitions[key] || 0) + 1;
        // 間隔分布以 log 實際排程為準 (ground truth), 不是 replay 重建
        const ivl = e.scheduled_days ?? result.dueDays;
        if (ivl < 1) ivlBuckets['<1d']++;
        else if (ivl <= 3) ivlBuckets['1-3d']++;
        else if (ivl <= 7) ivlBuckets['4-7d']++;
        else if (ivl <= 14) ivlBuckets['1-2w']++;
        else if (ivl <= 28) ivlBuckets['2-4w']++;
        else if (ivl <= 90) ivlBuckets['1-3m']++;
        else ivlBuckets['3m+']++;
        base.stability = result.stability;
        base.difficulty = result.difficulty;
        base.state = newState;
        base.reps = result.reps;
        base.lapses = result.lapses;
        base.step = result.step ?? 0;
        base.scheduledDays = result.dueDays;
      }
    }

    // 穩定性/Lapses/水蛭 以 cards 表實際狀態為準 (ground truth)
    const cardsAll = db.prepare('SELECT word_id, stability, lapses FROM cards').all();
    let stabilityMin = [Infinity, null], stabilityMax = [-Infinity, null];
    let lapsesTotal = 0, lapseCards = 0;
    for (const c of cardsAll) {
      if (c.stability > 0 && c.stability < stabilityMin[0]) { stabilityMin = [c.stability, c.word_id]; }
      if (c.stability > stabilityMax[0]) { stabilityMax = [c.stability, c.word_id]; }
      if (c.lapses > 0) { lapsesTotal += c.lapses; lapseCards++; }
    }
    const leechCandidates = db.prepare('SELECT word_id, lapses FROM cards WHERE lapses >= ?')
      .all(anki.leechThreshold ?? 8)
      .map(r => ({ wid: r.word_id, lapses: r.lapses, word: s.words.find(w => w.id === r.word_id)?.word }));

    const correct = ratingDist[2] + ratingDist[3];
    console.log(`\n╔═ FSRS 行為監測報告 ═════════════════════════════`);
    console.log(`║ 總評分次數: ${totalReviews}`);
    console.log(`║`);
    console.log(`║ 評分分布:`);
    console.log(`║   Again: ${ratingDist[0]} (${totalReviews ? (ratingDist[0] / totalReviews * 100).toFixed(1) : 0}%)`);
    console.log(`║   Hard:  ${ratingDist[1]} (${totalReviews ? (ratingDist[1] / totalReviews * 100).toFixed(1) : 0}%)`);
    console.log(`║   Good:  ${ratingDist[2]} (${totalReviews ? (ratingDist[2] / totalReviews * 100).toFixed(1) : 0}%)`);
    console.log(`║   Easy:  ${ratingDist[3]} (${totalReviews ? (ratingDist[3] / totalReviews * 100).toFixed(1) : 0}%)`);
    console.log(`║   保留率(GOOD+): ${totalReviews ? (correct / totalReviews * 100).toFixed(1) : 0}%`);
    console.log(`║`);
    console.log(`║ 狀態轉移 (新->舊):`);
    for (const [k, v] of Object.entries(stateTransitions).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`║   ${k}: ${v}`);
    console.log(`║`);
    console.log(`║ 間隔分布:`);
    for (const [k, v] of Object.entries(ivlBuckets)) console.log(`║   ${k}: ${v}`);
    console.log(`║`);
    console.log(`║ 穩定性範圍: ${stabilityMin[0].toFixed(2)} (${stabilityMin[1]}) ~ ${stabilityMax[0].toFixed(2)} (${stabilityMax[1]})`);
    console.log(`║ Lapses 總計: ${lapsesTotal} (${lapseCards} 張卡)`);
    console.log(`║`);
    if (leechCandidates.length) {
      console.log(`║ ⚠ 水蛭卡 (lapses >= ${anki.leechThreshold ?? 8}):`);
      for (const l of leechCandidates) console.log(`║   ${l.wid} ${l.word ?? ''} lapses=${l.lapses}`);
    } else {
      console.log(`║ 無水蛭卡 (threshold ${anki.leechThreshold ?? 8})`);
    }
    console.log(`╚════════════════════════════════════════════`);
    log('READ', `fsrs-report: reviews=${totalReviews} retention=${totalReviews ? (correct / totalReviews * 100).toFixed(1) : 0}% leeches=${leechCandidates.length} lapses=${lapsesTotal}`);
}

// ─── 審計記錄查看: audit-log [--limit N] ───
function cmdAuditLog() {
  ensureSchema();
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 50;
  const rows = db.prepare('SELECT id, ts, action, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  console.log(`審計記錄 (最新 ${rows.length} 筆):`);
  for (const r of rows.reverse()) {
    const t = new Date(r.ts).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`  ${t} [${r.action}] ${r.detail}`);
  }
  log('READ', `audit-log: ${rows.length} 筆`);
}

// ─── 一致性稽核: review_log 重算 vs cards 表實際值 ───
async function cmdAudit() {
  const s = loadState();
  const mod = await import('../src/core/fsrs.js');
  const sched = await import('../src/core/scheduler.js');
  // E5 R2: FSRS: F 與 anki 已隨 fsrsCtx 統一而零引用 → 移除（SN/generateFuzzFactor replay 仍用）
  const { STATE_NEW: SN, generateFuzzFactor } = mod;
  const { getToday, toLocalDateStr } = sched;
  const tz = TZ_OFFSET;
  const cutoff = DAY_CUTOFF;
  // E5: 改用共享 fsrsCtx — 與 rate/app rateCard 同構造器（weights 剝 bracket 兩格式兼容、
  // retention/maxIvl/steps 同源）。修前自有構造：bracketed fsrsWeights 經 '['+w+']' 變嵌套
  // 陣列 → replay 崩壞；steps 走 split-map 無 A4 防線
  const { fsrs, learnSteps, relearnSteps } = fsrsCtx('flip');
  const daysBetween = (a, b) => {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
  };

  // 只重算 flip mode（mc/spell 各自存在 baseCard.mcData/spellData，混算會假 mismatch）
  const log2 = db.prepare(`SELECT * FROM review_log WHERE mode IS NULL OR mode = 'flip' ORDER BY id`).all();
  const byWord = {};
  for (const e of log2) (byWord[e.word_id] = byWord[e.word_id] || []).push(e);

  const issues = [];
  let checked = 0, matched = 0;
  for (const [wid, entries] of Object.entries(byWord)) {
    const card = s.cards.get(wid);
    if (!card) { issues.push(`${wid} ${s.words.find(w => w.id === wid)?.word ?? ''}: cards 表無此卡但有 ${entries.length} 筆複習記錄`); continue; }
    // E5: replay 起始 state 對齊 store.rateCard 新卡 else 分支（stability=0，非 cards 欄預設 2.5）
    const base = { stability: 0, difficulty: 5, state: SN, reps: 0, lapses: 0, elapsedDays: 0, scheduledDays: 0, step: 0 };
    let prevDay = null;
    for (const e of entries.sort((a, b) => (normTs(a.reviewed_at) || '').localeCompare(normTs(b.reviewed_at) || ''))) {   // E2: normTs sort key（防 naive/ISO 混合錯序）
      const fuzz = generateFuzzFactor(e.word_id + '_' + (e.mode || 'flip'), base.reps);
      // elapsedDays：距上次 review 的天數（dayCutoff aware），與 store.rateCard 一致
      const thisDay = e.reviewed_at ? toLocalDateStr(new Date(normTs(e.reviewed_at)), tz, cutoff) : null;   // E2: normTs
      base.elapsedDays = prevDay && thisDay && thisDay !== prevDay ? daysBetween(prevDay, thisDay) : 0;
      prevDay = thisDay || prevDay;
      const result = fsrs.review(base, e.rating ?? 2, fuzz, learnSteps, relearnSteps, null);
      base.stability = result.stability;
      base.difficulty = result.difficulty;
      base.state = e.new_state ?? result.state;
      base.reps = result.reps;
      base.lapses = result.lapses;
      base.step = result.step ?? 0;
      base.scheduledDays = result.dueDays;
    }
    checked++;
    const diffs = [];
    if (Math.abs(base.stability - (card.stability || 0)) > 0.05) diffs.push(`stability ${(card.stability ?? 0).toFixed(2)} vs 重算 ${base.stability.toFixed(2)}`);
    if (Math.abs(base.difficulty - (card.difficulty || 0)) > 0.05) diffs.push(`difficulty ${(card.difficulty ?? 0).toFixed(2)} vs 重算 ${base.difficulty.toFixed(2)}`);
    if ((base.state ?? SN) !== (card.state ?? SN)) diffs.push(`state ${card.state} vs 重算 ${base.state}`);
    if (base.reps !== (card.reps || 0)) diffs.push(`reps ${card.reps} vs 重算 ${base.reps}`);
    if (base.lapses !== (card.lapses || 0)) diffs.push(`lapses ${card.lapses} vs 重算 ${base.lapses}`);
    if (diffs.length) issues.push(`${wid} ${s.words.find(w => w.id === wid)?.word ?? ''}: ${diffs.join(', ')}`);
    else matched++;
  }
  console.log(`一致性稽核: ${checked} 張卡有 flip 複習記錄, ${matched} 一致, ${issues.length} 有差異`);
  if (issues.length) {
    console.log('注意: 若曾變更 fsrsWeights, 舊複習的重算值會與現值正常漂移');
    for (const i of issues.slice(0, 30)) console.log(`  ⚠ ${i}`);
    if (issues.length > 30) console.log(`  … 還有 ${issues.length - 30} 筆`);
  }
  log('READ', `audit: checked=${checked} matched=${matched} issues=${issues.length}`);
}

// ─── DB 差異比對: diff <db1> [db2] ───
function cmdDiff() {
  const db1 = args[0] || DB;
  const db2 = args[1] || `${HOME}/.config/com.teno.app/teno-backup.db`;
  if (!existsSync(db1)) return console.log(`來源不存在: ${db1}`);
  if (!existsSync(db2)) return console.log(`目標不存在: ${db2}`);
  const tables = ['words', 'cards', 'review_log', 'decks', 'settings', 'exam_history', 'goal_streak', 'folders', 'additions', 'filtered_decks', 'audit_log'];
  const open = (p) => new DatabaseSync(p, { readOnly: true });
  const d1 = open(db1), d2 = open(db2);
  console.log(`比對:\n  A: ${db1}\n  B: ${db2}`);
  for (const t of tables) {
    let c1, c2, r1 = null, r2 = null;
    try { c1 = d1.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { c1 = null; }
    try { c2 = d2.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { c2 = null; }
    if (c1 === null && c2 === null) continue;
    try { r1 = d1.prepare(`SELECT MIN(reviewed_at) mn, MAX(reviewed_at) mx FROM ${t}`).get(); } catch {}
    try { r2 = d2.prepare(`SELECT MIN(reviewed_at) mn, MAX(reviewed_at) mx FROM ${t}`).get(); } catch {}
    const range = (r) => (r && r.mn ? ` [${String(r.mn).slice(0, 16)} ~ ${String(r.mx).slice(0, 16)}]` : '');
    console.log(`  ${t.padEnd(14)} A=${c1}${range(r1)}  B=${c2}${range(r2)}  ${c1 === c2 ? '✅' : '⚠'}`);
  }
  d1.close(); d2.close();
  log('READ', `diff: ${db1} vs ${db2}`);
}

// ─── 評分序列預測: whatif <cardId> <ratings e.g. 2,2,0,2> [--mode flip|mc|spell] ───
async function cmdWhatif() {
  const id = args[0];
  const ratings = (args[1] || '').split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x) && x >= 0 && x <= 3);
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'flip';
  if (!id || !ratings.length) return console.log('用法: whatif <cardId> <ratings> [--mode flip|mc|spell]  e.g. whatif w_xxx 2,2,0,2');
  const s = loadState();
  const as = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
  const baseCfg = as ? JSON.parse(as.value) : {};
  let ankiCfg = baseCfg;
  if (mode === 'mc' || mode === 'spell') {
    try { ankiCfg = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='ankiSettings${mode === 'mc' ? 'Mc' : 'Spell'}'`).get()?.value || '{}'); } catch { ankiCfg = baseCfg; }
  }
  const mod = await import('../src/core/fsrs.js');
  const { FSRS: F, STATE_NEW: SN, generateFuzzFactor } = mod;
  const fsrs = new F(ankiCfg.fsrsWeights ? (() => { try { return JSON.parse('[' + ankiCfg.fsrsWeights + ']'); } catch { return null; } })() : null, ankiCfg.desiredRetention ?? 0.9, true, ankiCfg.maxIvl ?? 365);
  const learnSteps = (ankiCfg.learnSteps || '1,10').split(',').map(x => parseFloat(x.trim()) / 1440);
  const relearnSteps = (ankiCfg.relearnSteps || '10').split(',').map(x => parseFloat(x.trim()) / 1440);

  const baseCard = s.cards.get(id);
  const modeData = mode === 'mc' ? baseCard?.mcData : mode === 'spell' ? baseCard?.spellData : null;
  const card = modeData || baseCard;
  const cur = card ? {
    stability: card.stability ?? 0, difficulty: card.difficulty ?? 5,
    state: card.state ?? SN, reps: card.reps ?? 0, lapses: card.lapses ?? 0,
    step: card.step ?? 0, elapsedDays: card.elapsedDays ?? 0, scheduledDays: card.scheduledDays ?? 0,
  } : { stability: 0, difficulty: 5, state: SN, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };
  const word = s.words.find(w => w.id === id);
  console.log(`whatif ${word?.word ?? id} (mode=${mode})`);
  console.log(`  起始: state=${cur.state} ivl=${cur.scheduledDays}d S=${cur.stability.toFixed(2)} D=${cur.difficulty.toFixed(2)} lapses=${cur.lapses}`);
  const names = ['AGAIN', 'HARD', 'GOOD', 'EASY'];
  for (let i = 0; i < ratings.length; i++) {
    const fuzz = generateFuzzFactor(id + '_' + mode, cur.reps);
    const r = fsrs.review(cur, ratings[i], fuzz, learnSteps, relearnSteps, null);
    cur.stability = r.stability; cur.difficulty = r.difficulty; cur.state = r.state;
    cur.reps = r.reps; cur.lapses = r.lapses; cur.step = r.step ?? 0;
    cur.scheduledDays = r.dueDays; cur.elapsedDays = r.dueDays;
    console.log(`  ${i + 1}. ${names[ratings[i]]}: state=${r.state} ivl=${r.dueDays}d S=${r.stability.toFixed(2)} D=${r.difficulty.toFixed(2)} lapses=${r.lapses}`);
  }
  log('READ', `whatif: ${id} mode=${mode} ratings=${ratings.join(',')}`);
}

// 模擬結束 → 寫一筆歷史到隔離 DB (app-log.db 的 sim_runs), 下次模擬不會刪除
function writeSimRun(entry) {
  if (args.includes('--no-simrun')) return;
  try {
    const appLogDb = DB.replace(/teno\.db$/, 'app-log.db');
    const d = new DatabaseSync(appLogDb);
    d.exec(`CREATE TABLE IF NOT EXISTS sim_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, days INTEGER, target_pct REAL,
      seed INTEGER, from_zero INTEGER DEFAULT 0, total_reviews INTEGER,
      mature_cards INTEGER, mature_pct REAL, summary TEXT)`);
    // 模擬可簡單再生, 只保留最新一筆 (刪除舊的)
    d.exec('DELETE FROM sim_runs');
    d.prepare('INSERT INTO sim_runs (ts, kind, days, target_pct, seed, from_zero, total_reviews, mature_cards, mature_pct, summary) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Date.now(), entry.kind || 'simulate', entry.days ?? null, entry.targetPct ?? null,
        entry.seed ?? null, entry.fromZero ? 1 : 0, entry.totalReviews ?? null,
        entry.matureCards ?? null, entry.maturePct ?? null, entry.summary ?? null);
    d.close();
    log('WRITE', `sim_runs 已寫入 ${appLogDb}`);
  } catch (e) {
    log('WARN', `sim_runs 寫入失敗: ${e.message}`);
  }
}

const appLogDbPath = () => DB.replace(/teno\.db$/, 'app-log.db');
const fmtLogTs = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

function cmdLogs() {
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 50;
  const level = args.includes('--level') ? args[args.indexOf('--level') + 1] : null;
  const search = args.includes('--search') ? args[args.indexOf('--search') + 1] : null;
  if (!existsSync(appLogDbPath())) return console.log('app-log.db 不存在');
  const d = new DatabaseSync(appLogDbPath(), { readOnly: true });
  let sql = 'SELECT id, ts, level, message FROM app_log';
  const where = [], params = [];
  if (level) { where.push('level=?'); params.push(level); }
  if (search) { where.push('message LIKE ?'); params.push('%' + search + '%'); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  const rows = d.prepare(sql).all(...params);
  d.close();
  for (const r of rows) console.log(`#${r.id} ${fmtLogTs(r.ts)} [${r.level}] ${String(r.message).slice(0, 150)}`);
  log('READ', `logs ${rows.length} 筆${search ? ' search=' + search : ''}`);
}

function cmdSims() {
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 20;
  if (!existsSync(appLogDbPath())) return console.log('app-log.db 不存在');
  const d = new DatabaseSync(appLogDbPath(), { readOnly: true });
  const rows = d.prepare('SELECT id, ts, kind, days, target_pct, seed, from_zero, total_reviews, mature_cards, mature_pct FROM sim_runs ORDER BY id DESC LIMIT ?').all(limit);
  d.close();
  for (const r of rows) {
    console.log(`#${r.id} ${fmtLogTs(r.ts)} ${r.kind} days=${r.days} mature=${r.mature_cards}(${r.mature_pct}%) reviews=${r.total_reviews}${r.from_zero ? ' from-zero' : ''}${r.target_pct != null ? ' target=' + r.target_pct + '%' : ''}`);
  }
  log('READ', `sims ${rows.length} 筆`);
}

// 行為模型分析 — 顯示模擬引擎從主 DB 分析出的所有行為參數
function cmdBehavior() {
  console.log('════ 行為模型分析 (來源: app 主 DB review_log) ════\n');
  // 1. 轉移矩陣 (同卡上次評分 → 下次評分)
  const trans = db.prepare(`WITH seq AS (
      SELECT word_id, rating, lag(rating) OVER (PARTITION BY word_id ORDER BY id) prev
      FROM review_log)
    SELECT prev, rating, count(*) n FROM seq WHERE prev IS NOT NULL GROUP BY prev, rating`).all();
  const tAcc = {};
  for (const r of trans) (tAcc[r.prev] ??= {})[r.rating] = r.n;
  console.log('1) 行為連結 — 同卡上次評分 → 下次 (轉移矩陣):');
  for (const prev of [0, 1, 2, 3]) {
    const d = tAcc[prev];
    if (!d) continue;
    const t = Object.values(d).reduce((a, b) => a + b, 0);
    const names = ['Again', 'Hard', 'Good', 'Easy'];
    console.log(`   上次 ${names[prev]}: ` + names.map((nm, i) => `${nm} ${Math.round((d[i] ?? 0) / t * 100)}%`).join('  ') + `  (n=${t})`);
  }
  // 2. reps 曲線 (依複習次數的評分分布)
  console.log('\n2) reps 曲線 — 依卡當前複習次數的 Again 率:');
  const reps = db.prepare('SELECT c.reps, rating, count(*) n FROM review_log r JOIN cards c ON r.word_id=c.word_id GROUP BY c.reps, rating ORDER BY c.reps').all();
  const rAcc = {};
  for (const r of reps) (rAcc[r.reps] ??= {})[r.rating] = r.n;
  for (const repsN of Object.keys(rAcc).sort((a, b) => a - b)) {
    const d = rAcc[repsN];
    const t = Object.values(d).reduce((a, b) => a + b, 0);
    if (t >= 10) console.log(`   reps=${repsN}: Again ${Math.round((d[0] ?? 0) / t * 100)}%  Good ${Math.round((d[2] ?? 0) / t * 100)}%  (n=${t})`);
  }
  // 3. 難度分級曲線 (依難度級的 Again 率)
  console.log('\n3) 難度分級 — 依難度級 (每 0.5 級) 的 Again 率:');
  const diff = db.prepare('SELECT round(difficulty*2)/2 d, rating, count(*) n FROM review_log GROUP BY d, rating').all();
  const dAcc = {};
  for (const r of diff) (dAcc[r.d] ??= {})[r.rating] = r.n;
  for (const d of Object.keys(dAcc).sort((a, b) => a - b)) {
    const dist = dAcc[d];
    const t = Object.values(dist).reduce((a, b) => a + b, 0);
    if (t >= 30) console.log(`   級 ${d}: Again ${Math.round((dist[0] ?? 0) / t * 100)}%  Good ${Math.round((dist[2] ?? 0) / t * 100)}%  (n=${t})`);
  }
  // 4. 寫死 fallback
  console.log('\n4) 寫死 fallback (樣本不足/新卡時):');
  console.log('   新卡: Again 5% / Good 92%');
  console.log('   間隔>=14d: Again 5% · >=7d: 10% · >=3d: 18% · <3d: 30%');
  log('READ', `behavior 分析完成`);
}

// ─── F15-SR1: 報告 HTML 供應鏈加固（生成期套用） ───
// ① CDN 釘版 chart.js 4.4.1 @ cdnjs ＋ SRI integrity（防 jsdelivr 動態 minify banner 破 hash）
// ② 內嵌 <script> 內 `<` → \u003c（防 "</script>" 提前終止注入）
// ③ 對最終內嵌 script 內容算 sha256 寫 meta CSP（CSP3 准 hash，禁 nonce）
const CHART_CDN_TAG = '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==" crossorigin="anonymous"></script>';

function finalizeReportHtml(html) {
  // CDN 換成釘版 SRI（兜底：就算 template 仍含未釘版也一律換掉）
  let out = html.replace(
    /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"><\/script>/,
    () => CHART_CDN_TAG
  );
  // 對「最後一段內嵌 script」（含資料、非 CDN）做 `<`→`\u003c` 轉義
  // 註：只處理無 src 屬性的 `<script>` 塊，避免 CDN 那條被判為內嵌
  const m = out.match(/<script>([\s\S]*)<\/script>(\s*<\/body>)/);
  if (m) {
    const escaped = m[1].replace(/</g, '\\u003c');
    const hash = createHash('sha256').update(escaped).digest('base64');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'sha256-${hash}' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'none'">`;
    // 貪婪回溯取「最後一組」</script>…</body>=真模板尾；m[2] 補回 </body> 防尾端壞死
    out = out.slice(0, m.index) + `<script>${escaped}</script>${m[2]}` + out.slice(m.index + m[0].length);
    // CSP meta 插在 <head> 之後
    if (/<head>/.test(out)) out = out.replace(/<head>/, `<head>\n${csp}`);
    else out = `${csp}\n${out}`;
  }
  return out;
}

// ─── 分布對比: 模擬生成數據 vs 真實 DB, 輸出圖表 + 統計 ───
function cmdCompare() {
  const dir = args[0] || `${HOME}/.config/com.teno.app/sim-logs`;
  if (!existsSync(dir)) return console.log(`目錄不存在: ${dir}`);
  const files = readdirSync(dir).filter(f => /^day-\d+-/.test(f) && f.endsWith('.log')).sort((a, b) => parseInt(a.match(/day-(\d+)/)[1]) - parseInt(b.match(/day-(\d+)/)[1]));
  if (!files.length) return console.log(`無 day-N log (請先跑模擬): ${dir}`);
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : `${dir}/compare.html`;

  // ── 解析模擬 log ──
  const sim = { rating: { 0: 0, 1: 0, 2: 0, 3: 0 }, trans: { 0: {}, 1: {}, 2: {}, 3: {} }, diff: {} };
  const seq = {};
  for (const f of files) {
    for (const l of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      const ms = /\[store\.rate\] (\S+).*?rating= (\d)/.exec(l);
      if (ms) {
        const wid = ms[1], r = +ms[2];
        sim.rating[r] = (sim.rating[r] ?? 0) + 1;
        if (seq[wid] != null) sim.trans[seq[wid]][r] = (sim.trans[seq[wid]][r] ?? 0) + 1;
        seq[wid] = r;
      }
      const mf = /\[fsrs\] (\S+).*?rating= (\d).*?difficulty= ([\d.]+)/.exec(l);
      if (mf) {
        const r = +mf[2], d = Math.round(+mf[3] * 2) / 2;
        (sim.diff[d] ??= { 0: 0, 1: 0, 2: 0, 3: 0 })[r]++;
      }
    }
  }

  // ── 主 DB 真實分布 ──
  const real = { rating: {}, trans: { 0: {}, 1: {}, 2: {}, 3: {} }, diff: {} };
  for (const r of db.prepare('SELECT rating, count(*) n FROM review_log GROUP BY rating').all()) real.rating[r.rating] = r.n;
  for (const r of db.prepare('WITH seq AS (SELECT word_id, rating, lag(rating) OVER (PARTITION BY word_id ORDER BY id) prev FROM review_log) SELECT prev, rating, count(*) n FROM seq WHERE prev IS NOT NULL GROUP BY prev, rating').all()) real.trans[r.prev][r.rating] = r.n;
  for (const r of db.prepare('SELECT round(difficulty*2)/2 d, rating, count(*) n FROM review_log GROUP BY d, rating').all()) (real.diff[r.d] ??= { 0: 0, 1: 0, 2: 0, 3: 0 })[r.rating] = r.n;

  const dist = (o) => { const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return [0, 1, 2, 3].map(i => (o[i] ?? 0) / t); };
  const names = ['Again', 'Hard', 'Good', 'Easy'];
  const pct = (p) => Math.round(p * 100);
  const aad = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

  // 評分分布
  const rd = dist(real.rating), sd = dist(sim.rating);
  // 轉移矩陣 (上次 → 各評分, 4x4 展平)
  const rTrans = [0, 1, 2, 3].flatMap(p => { const t = Object.values(real.trans[p]).reduce((a, b) => a + b, 0) || 1; return [0, 1, 2, 3].map(i => (real.trans[p][i] ?? 0) / t); });
  const sTrans = [0, 1, 2, 3].flatMap(p => { const t = Object.values(sim.trans[p]).reduce((a, b) => a + b, 0) || 1; return [0, 1, 2, 3].map(i => (sim.trans[p][i] ?? 0) / t); });
  // 難度曲線 (Again 率 per 級)
  const diffKeys = [...new Set([...Object.keys(real.diff), ...Object.keys(sim.diff)])].filter(d => (real.diff[d] ? Object.values(real.diff[d]).reduce((a, b) => a + b, 0) : 0) >= 30).sort((a, b) => a - b);
  const rAgain = diffKeys.map(d => { const o = real.diff[d] || {}; const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return (o[0] ?? 0) / t; });
  const sAgain = diffKeys.map(d => { const o = sim.diff[d] || {}; const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return (o[0] ?? 0) / t; });

  const ratingDiff = aad(rd, sd);
  const transDiff = aad(rTrans, sTrans);
  const diffDiff = aad(rAgain, sAgain);

  console.log('════ 模擬 vs 真實 分布對比 ════');
  console.log(`評分分布  平均差: ${(ratingDiff * 100).toFixed(1)}%`);
  console.log(`轉移矩陣  平均差: ${(transDiff * 100).toFixed(1)}%`);
  console.log(`難度曲線  平均差: ${(diffDiff * 100).toFixed(1)}%`);
  console.log(`樣本: 模擬 ${files.length} 天 (評分 ${Object.values(sim.rating).reduce((a, b) => a + b, 0)}) vs 真實 ${Object.values(real.rating).reduce((a, b) => a + b, 0)}`);

  const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Teno 模擬 vs 真實分布對比</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==" crossorigin="anonymous"></script>
<style>
body{font-family:system-ui;background:#0f1115;color:#e5e7eb;margin:0;padding:24px}
h1{font-size:20px}h2{font-size:15px;margin-top:28px;color:#a78bfa}
.card{background:#1a1d24;border-radius:12px;padding:20px;margin-top:14px}
canvas{max-height:260px}.muted{color:#9ca3af;font-size:13px}
.stat{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}
.stat div{background:#1a1d24;border-radius:10px;padding:12px 18px}
.stat b{font-size:22px;display:block;color:#22c55e}
</style></head><body>
<h1>📊 模擬 vs 真實 分布對比</h1>
<div class="muted">${files[0].match(/day-\d+-([\d-]+)/)?.[1] ?? '?'} ~ ${files[files.length-1].match(/day-\d+-([\d-]+)/)?.[1] ?? '?'} · 模擬 ${files.length} 天</div>
<div class="stat">
  <div><b>${(ratingDiff * 100).toFixed(1)}%</b><span class="muted">評分分布平均差</span></div>
  <div><b>${(transDiff * 100).toFixed(1)}%</b><span class="muted">行為連結平均差</span></div>
  <div><b>${(diffDiff * 100).toFixed(1)}%</b><span class="muted">難度曲線平均差</span></div>
</div>
<div class="card"><h2>評分分布 (Again/Hard/Good/Easy)</h2><canvas id="c1"></canvas></div>
<div class="card"><h2>行為連結 — 上次評分 → 下次 (16 格)</h2><canvas id="c2"></canvas></div>
<div class="card"><h2>難度級 → Again 率曲線</h2><canvas id="c3"></canvas></div>
<script>
new Chart(document.getElementById('c1'), { type:'bar', data:{ labels:${JSON.stringify(names)}, datasets:[
  { label:'真實', data:${JSON.stringify(rd.map(pct))}, backgroundColor:'#a78bfa' },
  { label:'模擬', data:${JSON.stringify(sd.map(pct))}, backgroundColor:'#22c55e' }
]}, options:{ plugins:{legend:{position:'top'}}, scales:{y:{min:0,max:100}} } });
new Chart(document.getElementById('c2'), { type:'bar', data:{ labels:${JSON.stringify([0,1,2,3].flatMap(p => names.map(n => p + '→' + n)))}, datasets:[
  { label:'真實', data:${JSON.stringify(rTrans.map(pct))}, backgroundColor:'#a78bfa' },
  { label:'模擬', data:${JSON.stringify(sTrans.map(pct))}, backgroundColor:'#22c55e' }
]}, options:{ plugins:{legend:{position:'top'}}, scales:{y:{min:0,max:100}} } });
new Chart(document.getElementById('c3'), { type:'line', data:{ labels:${JSON.stringify(diffKeys)}, datasets:[
  { label:'真實 Again%', data:${JSON.stringify(rAgain.map(pct))}, borderColor:'#a78bfa', tension:0.3 },
  { label:'模擬 Again%', data:${JSON.stringify(sAgain.map(pct))}, borderColor:'#22c55e', tension:0.3 }
]}, options:{ plugins:{legend:{position:'top'}}, scales:{y:{min:0,max:100},x:{title:{display:true,text:'難度級'}}} } });
</script></body></html>`;
  writeFileSync(outFile, finalizeReportHtml(html));
  console.log(`\n✅ 對比圖表: ${outFile}`);
  log('READ', `compare: 評分差=${(ratingDiff * 100).toFixed(1)}% 轉移差=${(transDiff * 100).toFixed(1)}% 難度差=${(diffDiff * 100).toFixed(1)}%`);
}

// ─── 數學模型分析: 統計檢定模擬是否符合真實行為 ───
function gammaLn(x) {
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
  x -= 1;
  const g = 7, t = x + g + 0.5;
  let a = C[0];
  for (let i = 1; i < C.length; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, term = 1 / a;
    for (let n = 1; n < 500 && term > 1e-12; n++) { term *= x / (a + n); sum += term; }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let n = 1; n < 500; n++) {
    const an = -n * (n - a), b0 = b;
    b = b0 + 2 * n;
    d = an * d + b0; if (Math.abs(d) < 1e-12) d = 1e-12;
    c = b0 + an / c; if (Math.abs(c) < 1e-12) c = 1e-12;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - h * Math.exp(-x + a * Math.log(x) - gammaLn(a));
}
const chi2P = (chi2, df) => 1 - gammaP(df / 2, chi2 / 2);
// 效應量: 單列(r=1)用 phi, 多列用 Cramér's V。大樣本下比 p 值可靠。
const cramersV = (chi2, n, r, c) => {
  const k = Math.min(r, c) - 1;
  return k <= 0 ? Math.sqrt(chi2 / n) : Math.sqrt(chi2 / (n * k));
};
const pearson = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return { r: sxy / Math.sqrt(sxx * syy), n };
};
function logisticFit(ds, ps, ns) {
  const pts = [];
  for (let i = 0; i < ds.length; i++) {
    const p = Math.max(0.001, Math.min(0.999, ps[i]));
    pts.push({ x: ds[i], y: Math.log(p / (1 - p)), w: ns[i] || 1 });
  }
  const sw = pts.reduce((a, p) => a + p.w, 0);
  const mx = pts.reduce((a, p) => a + p.w * p.x, 0) / sw, my = pts.reduce((a, p) => a + p.w * p.y, 0) / sw;
  let sxx = 0, sxy = 0;
  for (const p of pts) { sxx += p.w * (p.x - mx) ** 2; sxy += p.w * (p.x - mx) * (p.y - my); }
  const b = sxy / sxx, a = my - b * mx;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  let ssRes = 0, ssTot = 0;
  const pm = ps.reduce((a, c) => a + c, 0) / ps.length;
  for (let i = 0; i < ds.length; i++) { ssRes += (ps[i] - sig(a + b * ds[i])) ** 2; ssTot += (ps[i] - pm) ** 2; }
  return { a, b, r2: 1 - ssRes / ssTot };
}
function chiSquareFit(obsCounts, expProbs) {
  const n = obsCounts.reduce((a, b) => a + b, 0);
  let chi2 = 0;
  for (let i = 0; i < obsCounts.length; i++) {
    const e = expProbs[i] * n;
    if (e > 0) chi2 += (obsCounts[i] - e) ** 2 / e;
  }
  return { chi2, n, df: obsCounts.length - 1 };
}

function cmdFit() {
  const dir = args[0] || `${HOME}/.config/com.teno.app/sim-logs`;
  if (!existsSync(dir)) return console.log(`目錄不存在: ${dir}`);
  const files = readdirSync(dir).filter(f => /^day-\d+-/.test(f) && f.endsWith('.log')).sort((a, b) => parseInt(a.match(/day-(\d+)/)[1]) - parseInt(b.match(/day-(\d+)/)[1]));
  if (!files.length) return console.log(`無 day-N log: ${dir}`);

  // 模擬分布
  const sim = { rating: { 0: 0, 1: 0, 2: 0, 3: 0 }, trans: { 0: {}, 1: {}, 2: {}, 3: {} }, diff: {} };
  const seq = {};
  for (const f of files) {
    for (const l of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      const ms = /\[store\.rate\] (\S+).*?rating= (\d)/.exec(l);
      if (ms) {
        const wid = ms[1], r = +ms[2];
        sim.rating[r] = (sim.rating[r] ?? 0) + 1;
        if (seq[wid] != null) sim.trans[seq[wid]][r] = (sim.trans[seq[wid]][r] ?? 0) + 1;
        seq[wid] = r;
      }
      const mf = /\[fsrs\] (\S+).*?rating= (\d).*?difficulty= ([\d.]+)/.exec(l);
      if (mf) { const r = +mf[2], d = Math.round(+mf[3] * 2) / 2; (sim.diff[d] ??= { 0: 0, 1: 0, 2: 0, 3: 0 })[r]++; }
    }
  }

  // 真實分布
  const real = { rating: {}, trans: { 0: {}, 1: {}, 2: {}, 3: {} }, diff: {} };
  for (const r of db.prepare('SELECT rating, count(*) n FROM review_log GROUP BY rating').all()) real.rating[r.rating] = r.n;
  for (const r of db.prepare('WITH seq AS (SELECT word_id, rating, lag(rating) OVER (PARTITION BY word_id ORDER BY id) prev FROM review_log) SELECT prev, rating, count(*) n FROM seq WHERE prev IS NOT NULL GROUP BY prev, rating').all()) real.trans[r.prev][r.rating] = r.n;
  for (const r of db.prepare('SELECT round(difficulty*2)/2 d, rating, count(*) n FROM review_log GROUP BY d, rating').all()) (real.diff[r.d] ??= { 0: 0, 1: 0, 2: 0, 3: 0 })[r.rating] = r.n;

  const names = ['Again', 'Hard', 'Good', 'Easy'];
  const pad = (s, w) => String(s).padStart(w);
  console.log('\n════════ 數學模型分析 — 模擬 vs 真實 ════════');
  console.log(`樣本: 模擬 ${files.length} 天 ${Object.values(sim.rating).reduce((a, b) => a + b, 0)} 評分 vs 真實 ${Object.values(real.rating).reduce((a, b) => a + b, 0)} 評分\n`);

  // 1. 評分分布 χ²
  const expProbs = [0, 1, 2, 3].map(i => (real.rating[i] ?? 0) / Object.values(real.rating).reduce((a, b) => a + b, 0));
  const obs = [0, 1, 2, 3].map(i => sim.rating[i] ?? 0);
  const f1 = chiSquareFit(obs, expProbs);
  const v1 = cramersV(f1.chi2, f1.n, 1, 4);
  console.log('1) 評分分布 (χ² 適配檢定)');
  console.log(`   χ²=${f1.chi2.toFixed(1)}  df=${f1.df}  p=${chi2P(f1.chi2, f1.df).toExponential(2)}  Cramér\'s V=${v1.toFixed(4)}`);
  console.log(`   真實: ${names.map((n, i) => `${n} ${(expProbs[i] * 100).toFixed(1)}%`).join(' ')}`);
  console.log(`   模擬: ${names.map((n, i) => `${n} ${(obs[i] / f1.n * 100).toFixed(1)}%`).join(' ')}`);

  // 2. 轉移矩陣 χ² (4x4)
  const rT = [], sT = [], rTraw = [], sTraw = [];
  for (let p = 0; p < 4; p++) {
    const rn = Object.values(real.trans[p]).reduce((a, b) => a + b, 0);
    const sn = Object.values(sim.trans[p]).reduce((a, b) => a + b, 0);
    for (let i = 0; i < 4; i++) {
      rTraw.push(real.trans[p][i] ?? 0); sTraw.push(sim.trans[p][i] ?? 0);
      rT.push((real.trans[p][i] ?? 0) / (rn || 1)); sT.push((sim.trans[p][i] ?? 0) / (sn || 1));
    }
  }
  let chi2T = 0;
  for (let i = 0; i < 16; i++) {
    const e = rT[i] * sTraw.reduce((a, b) => a + b, 0);
    if (e > 0) chi2T += (sTraw[i] - e) ** 2 / e;
  }
  const vT = cramersV(chi2T, sTraw.reduce((a, b) => a + b, 0), 4, 4);
  const corrT = pearson(rT, sT);
  console.log('\n2) 行為連結轉移矩陣 (16 格, 上次→下次)');
  console.log(`   χ²=${chi2T.toFixed(1)}  df=12  p=${chi2P(chi2T, 12).toExponential(2)}  Cramér\'s V=${vT.toFixed(4)}`);
  console.log(`   Pearson r=${corrT.r.toFixed(4)} (n=${corrT.n} 格)`);

  // 3. 難度曲線: Pearson r + Logistic 擬合斜率
  const diffKeys = [...new Set([...Object.keys(real.diff), ...Object.keys(sim.diff)])]
    .filter(d => (Object.values(real.diff[d] || {}).reduce((a, b) => a + b, 0)) >= 30)
    .sort((a, b) => a - b);
  const rA = [], sA = [], rN = [], sN = [];
  for (const d of diffKeys) {
    const ro = real.diff[d] || {}, so = sim.diff[d] || {};
    const rn = Object.values(ro).reduce((a, b) => a + b, 0), sn = Object.values(so).reduce((a, b) => a + b, 0);
    rA.push((ro[0] ?? 0) / (rn || 1)); rN.push(rn);
    sA.push((so[0] ?? 0) / (sn || 1)); sN.push(sn);
  }
  const corrD = pearson(rA, sA);
  const fitR = logisticFit(diffKeys.map(Number), rA, rN);
  const fitS = logisticFit(diffKeys.map(Number), sA, sN);
  console.log('\n3) 難度曲線 (級 → Again 率)');
  console.log(`   Pearson r=${corrD.r.toFixed(4)} (n=${corrD.n} 級)`);
  console.log(`   Logistic 斜率 b (難度↑ → Again 上升幅度): 真實=${fitR.b.toFixed(3)}  模擬=${fitS.b.toFixed(3)}`);
  console.log(`   擬合 R²: 真實=${fitR.r2.toFixed(3)}  模擬=${fitS.r2.toFixed(3)}`);

  // 4. 結論判定 (用效應量, 大樣本下 p 值易誤導)
  const effectV = (v, name) => v < 0.1 ? `${name}: ✅ 符合 (效應量小, 差異可忽略)` : v < 0.3 ? `${name}: △ 略偏 (效應量中等)` : `${name}: ⚠ 偏離 (效應量大)`;
  console.log('\n4) 結論 (效應量判定)');
  console.log(`   ${effectV(v1, '評分分布')}  (V=${v1.toFixed(4)}, 真實/模擬差: Again ${((expProbs[0] - obs[0] / f1.n) * 100).toFixed(1)}%)`);
  console.log(`   ${effectV(vT, '行為連結')}  (V=${vT.toFixed(4)}, 相關 r=${corrT.r.toFixed(3)})`);
  console.log(`   ${corrD.r > 0.85 ? '   難度曲線: ✅ 高度相關' : corrD.r > 0.6 ? '   難度曲線: △ 中相關' : '   難度曲線: ⚠ 相關不足'}  (r=${corrD.r.toFixed(3)}, 斜率比 模擬/真實=${(fitS.b / fitR.b).toFixed(2)}x)`);
  log('READ', `fit: 評分p=${chi2P(f1.chi2, f1.df).toExponential(1)} 轉移p=${chi2P(chi2T, 12).toExponential(1)} 難度r=${corrD.r.toFixed(3)}`);
}

// ─── 匯出/匯入容器: teno.db + app-log.db 單一檔案 (與 Rust 格式一致) ───
// "TENOC"(5) + version(1) + [u32 len][teno bytes] + [u32 len][app-log bytes]
function packContainer(includeLog) {
  // 先把 teno.db 的 WAL 併入主檔, 確保索引與資料一致 (避免 integrity 錯誤)
  try {
    const d = new DatabaseSync(DB);
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    d.close();
  } catch {}
  const teno = readFileSync(DB);
  let log = Buffer.alloc(0);
  if (includeLog && existsSync(appLogDbPath())) {
    // 先把 app-log.db 的 WAL 併入主檔, 確保匯出到完整資料
    try {
      const d = new DatabaseSync(appLogDbPath());
      d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      d.close();
    } catch {}
    log = readFileSync(appLogDbPath());
  }
  const head = Buffer.concat([Buffer.from('TENOC'), Buffer.from([1])]);
  const l1 = Buffer.alloc(4); l1.writeUInt32LE(teno.length);
  const l2 = Buffer.alloc(4); l2.writeUInt32LE(log.length);
  return Buffer.concat([head, l1, teno, l2, log]);
}
function unpackContainer(data) {
  if (data.length < 6 || data.subarray(0, 5).toString('latin1') !== 'TENOC') return { teno: data, log: null };
  let pos = 6;
  const l1 = data.readUInt32LE(pos); pos += 4;
  if (data.length < pos + l1) return { teno: data, log: null };
  const teno = data.subarray(pos, pos + l1); pos += l1;
  let log = null;
  if (data.length >= pos + 4) {
    const l2 = data.readUInt32LE(pos); pos += 4;
    if (data.length >= pos + l2) log = data.subarray(pos, pos + l2);
  }
  return { teno, log };
}

function cmdExportDb() {
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : `${HOME}/桌面/teno-backup.db`;
  const includeLog = !args.includes('--no-log');
  const data = packContainer(includeLog);
  writeFileSync(out, data);
  console.log(`✅ 已匯出 ${out} (${(data.length / 1024 / 1024).toFixed(2)} MB, ${includeLog ? '含操作日誌' : '不含操作日誌'})`);
  log('WRITE', `export-db ${out} ${includeLog ? '含log' : '無log'} ${data.length}b`);
}

function cmdImportDb() {
  const src = args[0];
  if (!src || !existsSync(src)) return console.log(`需: import-db <檔案> (${src ?? ''})`);
  const data = readFileSync(src);
  const { teno: tenoBytes, log: logBytes } = unpackContainer(data);
  // D19: magic 守門 —— 垃圾/截斷/損壞容器一律拒絕（守門在全部寫入副作用之前：
  // 拒絕不備份、不 rmWal、不覆寫、零 audit）。l2=0 空 log 段＝無 log（合約
  // lib.rs:519），不驗不拒不寫（?.length 防空 Buffer truthy 誤判）。
  const isSqlite = (b) => Buffer.isBuffer(b) && b.length >= 100
    && b.subarray(0, 16).toString('latin1') === 'SQLite format 3\0';
  if (!isSqlite(tenoBytes)) {
    console.log(`❌ 拒絕匯入: teno 段不是 SQLite 資料庫（magic 不符）— 來源 ${src}`);
    log('ERROR', `import-db rejected: not SQLite magic ${src}`);
    process.exitCode = 1; return;
  }
  if (logBytes?.length && !isSqlite(logBytes)) {
    console.log(`❌ 拒絕匯入: 操作日誌段不是 SQLite 資料庫 — 來源 ${src}`);
    log('ERROR', `import-db rejected: log segment not SQLite ${src}`);
    process.exitCode = 1; return;
  }
  backupDb();
  // D7: 覆寫前清掉舊 WAL/SHM（頂層 rmWal，語意同原本地定義）
  rmWal(DB);
  writeFileSync(DB, tenoBytes);
  if (logBytes?.length) { rmWal(appLogDbPath()); writeFileSync(appLogDbPath(), logBytes); }
  console.log(`✅ 已匯入 ${src} (teno.db=${(tenoBytes.length / 1024 / 1024).toFixed(2)} MB${logBytes?.length ? `, app-log.db=${(logBytes.length / 1024 / 1024).toFixed(2)} MB` : ', 無操作日誌'})`);
  log('WRITE', `import-db ${src} teno=${tenoBytes.length}b log=${logBytes?.length ? logBytes.length : 0}b`);
  audit('import-db', `匯入 DB ${args[0] || ''}`);
}

// ─── 自我測試: 一鍵檢查 DB/FSRS/模擬引擎/容器, 並寫入 [TEST] 標記 log ───
async function cmdSelfTest() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '✅' : '❌'} ${name} ${detail}`);
    log(ok ? 'OK' : 'ERROR', `selftest ${name} ${detail}`);
  };

  console.log('════ 自我測試 ════');
  // 1. DB 完整性
  try {
    const d = new DatabaseSync(DB, { readOnly: true });
    check('teno.db 完整性', d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
    check('review_log 無 rating 越界', d.prepare('SELECT count(*) n FROM review_log WHERE rating<0 OR rating>3').get().n === 0);
    check('cards 無 state 越界', d.prepare('SELECT count(*) n FROM cards WHERE state<0 OR state>3').get().n === 0);
    check('cards 無負間隔', d.prepare('SELECT count(*) n FROM cards WHERE scheduled_days<0').get().n === 0);
    d.close();
  } catch (e) { check('teno.db 檢查', false, e.message); }

  // 2. FSRS 單元 (新卡 init 難度應 ≈ 2.118, 非卡在 5)
  try {
    const f = new FSRS(null, 0.9, false, 365);
    const r = f.review({ stability: 0, difficulty: 5, state: 0, reps: 0, lapses: 0, elapsedDays: 0, scheduledDays: 0, step: 0 }, 2, null, [1/1440, 10/1440], [10/1440]);
    check('FSRS 新卡 Good 難度 init≈2.1', Math.abs(r.difficulty - 2.118) < 0.01, `got=${r.difficulty.toFixed(3)}`);
    check('FSRS 新卡 stability init≈2.31', Math.abs(r.stability - 2.307) < 0.01, `got=${r.stability.toFixed(3)}`);
    const r2 = f.review({ stability: 5, difficulty: 5, state: 2, reps: 5, lapses: 0, elapsedDays: 5, scheduledDays: 5, step: 0 }, 2, null, [1/1440, 10/1440], [10/1440]);
    check('FSRS 複習 Good 間隔成長', r2.dueDays > 5, `ivl=${r2.dueDays}`);
  } catch (e) { check('FSRS 單元', false, e.message); }

  // 3. (E8 退役) 舊 JS 模擬引擎段移除：政策隔離＋官方引擎取代＋零消费者

  // 4. 容器 round-trip
  try {
    const teno = Buffer.from('SQLite format 3\0FAKE');
    const logB = Buffer.from('LOG');
    const packed = Buffer.concat([Buffer.from('TENOC'), Buffer.from([1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(teno.length); return b; })(), teno, (() => { const b = Buffer.alloc(4); b.writeUInt32LE(logB.length); return b; })(), logB]);
    const u = unpackContainer(packed);
    check('容器 round-trip teno', u.teno.equals(teno));
    check('容器 round-trip log', u.log && u.log.equals(logB));
    // E10: 原「拒絕非SQLite」斷言 `|| true` 恆真＝哨兵失明。語意定案（D19）：
    // CLI 端 unpack 容錯是正確契約（raw fallback），嚴格攔截由 cmdImportDb magic
    // 守門分層負責——斷言改寫為真實契約＋標籤誠實化，並補截斷頭態第二路徑。
    const g = unpackContainer(Buffer.from('GARBAGE'));
    check('容器 非SQLite raw fallback', g.teno.length === 7 && g.teno.toString('latin1') === 'GARBAGE' && g.log === null, '(CLI 端容錯, 嚴格攔截=D19 magic 守門)');
    const t = unpackContainer(Buffer.concat([Buffer.from('TENOC'), Buffer.from([1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(9999); return b; })()]));
    check('容器 截斷頭 raw fallback', t.teno.length === 10 && t.log === null, '(頭宣稱 9999B 實僅 10B)');
  } catch (e) { check('容器 round-trip', false, e.message); }

  // 5. 寫入 [TEST] 標記 log (供 app-log 診斷識別)
  try {
    const appLogDb = appLogDbPath();
    const d = new DatabaseSync(appLogDb);
    d.exec(`CREATE TABLE IF NOT EXISTS app_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'log', message TEXT NOT NULL)`);
    d.prepare('INSERT INTO app_log (ts, level, message) VALUES (?, ?, ?)').run(Date.now(), 'test', `[TEST] selftest ${pass} 通過 / ${fail} 失敗`);
    d.close();
    check('寫入 [TEST] 標記 log', true);
  } catch (e) { check('寫入 [TEST] log', false, e.message); }

  console.log(`\n═══ 結果: ${pass} 通過 / ${fail} 失敗 ═══`);
  log('READ', `selftest 完成: ${pass} 通過 / ${fail} 失敗`);
}

function cmdLogRetention() {
  const days = parseInt(args[0]);
  if (isNaN(days) || days < 0) return console.log('需: log-retention <天數> (0 = 停用記錄)');
  const w = dbw();
  w.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('logRetentionDays', String(days));
  w.close();
  if (days > 0 && existsSync(appLogDbPath())) {
    const d = new DatabaseSync(appLogDbPath());
    const cutoff = Date.now() - days * 86400000;
    const r = d.prepare('DELETE FROM app_log WHERE ts < ?').run(cutoff);
    const s = d.prepare('DELETE FROM sim_runs WHERE ts < ?').run(cutoff);
    d.close();
    console.log(`已設定保留 ${days} 天, 並清理 ${r.changes} 筆操作 + ${s.changes} 筆模擬`);
  } else {
    console.log(`已設定保留 ${days} 天 (停用記錄)`);
  }
  log('WRITE', `log-retention ${days}`);
}

function cmdLogPrune() {
  const days = parseInt(db.prepare("SELECT value FROM settings WHERE key='logRetentionDays'").get()?.value ?? '14');
  if (days <= 0) return console.log('保留天數為 0 (停用), 無需清理');
  if (!existsSync(appLogDbPath())) return console.log('app-log.db 不存在');
  const d = new DatabaseSync(appLogDbPath());
  const cutoff = Date.now() - days * 86400000;
  const r = d.prepare('DELETE FROM app_log WHERE ts < ?').run(cutoff);
  const s = d.prepare('DELETE FROM sim_runs WHERE ts < ?').run(cutoff);
  d.close();
  console.log(`已清理 ${r.changes} 筆操作 + ${s.changes} 筆模擬 (保留 ${days} 天)`);
  log('WRITE', `log-prune: ${r.changes} logs + ${s.changes} sims`);
}

function cmdSimulate() {
  const days = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 30;
  const startArg = args.includes('--start') ? args[args.indexOf('--start') + 1] : null;
  const dayNum = args.includes('--day-num') ? parseInt(args[args.indexOf('--day-num') + 1]) : 1;
  const seed = args.includes('--seed') ? parseInt(args[args.indexOf('--seed') + 1]) : 1;
  const speed = args.includes('--speed') ? parseInt(args[args.indexOf('--speed') + 1]) : 10;
  // E3: 使用全域 DAY_CUTOFF/TZ_OFFSET（DB 驅動），不再硬編 300/480

  // 模擬 DB: 用 logDir/base.db (分析工具可從同目錄讀), 否則獨立 /tmp
  const logDir = args.includes('--log-dir') ? args[args.indexOf('--log-dir') + 1] : null;
  if (logDir) {
    try { mkdirSync(logDir, { recursive: true }); } catch {}
    // 清掉舊的 day log 和 report — 僅新 session (day-num=1) 才清, 續跑保留
    if (dayNum === 1 && !args.includes('--no-clean')) {
      try {
        for (const f of readdirSync(logDir)) {
          if (/^day-\d+-.*\.log$/.test(f) || f === 'report.html') rmSync(`${logDir}/${f}`, { force: true });
        }
        log('RUN', `已清空 ${logDir} 舊的 day log / report`);
      } catch {}
    }
  }
  const simDbPath = args.includes('--sim-db') ? args[args.indexOf('--sim-db') + 1]
    : (logDir ? `${logDir}/base.db` : `/tmp/teno-sim-${Date.now()}.db`);
  // --sim-db 顯式指定且檔案存在 → 續跑不覆蓋; 否則備份 app DB
  const explicitDb = args.includes('--sim-db');
  if (!(explicitDb && existsSync(simDbPath))) {
    const bak = spawnSync('sqlite3', [DB, `.backup '${simDbPath}'`], { encoding: 'utf8' });
    if (bak.status !== 0) {
      log('ERROR', `複製 DB 失敗: ${bak.stderr}`);
      return;
    }
    log('RUN', `simulate 用獨立 DB: ${simDbPath} (備份自 ${DB})`);
  } else {
    log('RUN', `simulate 續跑現有 DB: ${simDbPath}`);
  }
  const sdb = new DatabaseSync(simDbPath);
  sdb.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  // --from-zero: 清空模擬 DB 進度, 從零開始學
  if (args.includes('--from-zero')) {
    sdb.exec('DELETE FROM cards; DELETE FROM review_log;');
    log('RUN', 'from-zero: 清空卡片進度, 從零開始');
  }

  // 未指定 start: 自動用最早到期卡的日期 (讓現有 DB 的卡被處理)
  let start;
  if (startArg) {
    start = startArg;
  } else {
    const earliest = sdb.prepare("SELECT min(due) m FROM cards WHERE state>0 AND due IS NOT NULL").get();
    if (earliest && earliest.m) {
      start = new Date(earliest.m).toISOString().slice(0, 10);
      log('RUN', `未指定 start, 用最早到期卡日期: ${start}`);
    } else {
      start = new Date().toISOString().slice(0, 10);
    }
  }

  const ankiRow = sdb.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
  const anki = ankiRow ? JSON.parse(ankiRow.value) : {};
  const fsrsW = anki.fsrsWeights ? (() => { try { return JSON.parse('[' + anki.fsrsWeights + ']'); } catch { return null; } })() : null;
  const LEARN_STEPS = (anki.learnSteps || '1,10').split(',').map(x => parseFloat(x.trim()) / 1440);
  const RELEARN_STEPS = (anki.relearnSteps || '10').split(',').map(x => parseFloat(x.trim()) / 1440);

  let rng = mulberry32(seed);
  // --log-dir: 確保目錄存在
  if (logDir) { try { mkdirSync(logDir, { recursive: true }); } catch {} }
  let _dayLogFile = null;
  const _origLog = console.log.bind(console);
  function emit(line) {
    // log-dir 時: 只輸出摘要到 stdout (避免巨量輸出), 詳細寫 log 檔
    if (_dayLogFile) {
      if (/^\[(day|build)\]|day done/.test(line)) _origLog(line);
      try {
        const dir = _dayLogFile.slice(0, _dayLogFile.lastIndexOf('/'));
        mkdirSync(dir, { recursive: true });
        appendFileSync(_dayLogFile, line + '\n');
      } catch (e) { _origLog(`[emit] 寫檔失敗: ${e.message}`); }
    } else {
      _origLog(line);
    }
  }
  console.log = emit;
  // 依卡 reps 查真實 review_log 評分比例 — 行為模式固定讀 app 主 DB (teno.db),
  // 不受 --from-zero 清空模擬 DB 影響。非從零時也用真實歷史而非模擬自身數據。
  const _distCache = new Map();
  function getRealDist(reps) {
    if (_distCache.has(reps)) return _distCache.get(reps);
    let dist = null;
    try {
      const rows = db.prepare('SELECT rating, count(*) n FROM review_log r JOIN cards c ON r.word_id=c.word_id WHERE c.reps=? GROUP BY rating').all(reps);
      if (rows.length >= 2) {
        const cnt = { 0: 0, 1: 0, 2: 0, 3: 0 };
        for (const row of rows) cnt[row.rating] = row.n;
        const t = cnt[0] + cnt[1] + cnt[2] + cnt[3];
        if (t >= 10) dist = [cnt[0]/t, cnt[1]/t, cnt[2]/t, cnt[3]/t];
      }
    } catch {}
    _distCache.set(reps, dist);
    return dist;
  }
  // 同卡上次評分 → 下次評分的真實轉移矩陣 (行為連結, 讀 app 主 DB)
  const _transition = {};
  try {
    const rows = db.prepare('WITH seq AS (SELECT word_id, rating, lag(rating) OVER (PARTITION BY word_id ORDER BY id) prev FROM review_log) SELECT prev, rating, count(*) n FROM seq WHERE prev IS NOT NULL GROUP BY prev, rating').all();
    const acc = {};
    for (const r of rows) {
      if (r.prev == null) continue;
      (acc[r.prev] ??= {})[r.rating] = r.n;
    }
    for (const [prev, dist] of Object.entries(acc)) {
      const t = Object.values(dist).reduce((a, b) => a + b, 0);
      if (t >= 10) {
        const d = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) d[i] = (dist[i] ?? 0) / t;
        _transition[prev] = d;
      }
    }
  } catch {}
  // 難度分級曲線 (讀 app 主 DB): 每 0.5 級一段 (等效連續 100 級 + 線性插值)。
  // 級數越高 Again 率越高, 且高級數下降幅度小; 卡難度會隨複習變動, 總體走下降趨勢。
  const _diffBins = [];
  try {
    const rows = db.prepare("SELECT round(difficulty*2)/2 d, rating, count(*) n FROM review_log GROUP BY d, rating").all();
    const acc = {};
    for (const r of rows) (acc[r.d] ??= {})[r.rating] = r.n;
    for (const [d, dist] of Object.entries(acc)) {
      const t = Object.values(dist).reduce((a, c) => a + c, 0);
      if (t >= 30) {
        const dd = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) dd[i] = (dist[i] ?? 0) / t;
        _diffBins.push({ d: parseFloat(d), dist: dd });
      }
    }
    _diffBins.sort((a, b) => a.d - b.d);
  } catch {}
  // 依卡難度查曲線: 兩側有數據段 → 線性插值 (連續級數)
  function getDiffDist(diff) {
    if (!_diffBins.length) return null;
    let lo = null, hi = null;
    for (const b of _diffBins) {
      if (b.d <= diff && (!lo || b.d > lo.d)) lo = b;
      if (b.d >= diff && (!hi || b.d < hi.d)) hi = b;
    }
    if (!lo || !hi || lo === hi) return (lo || hi).dist;
    const t = (diff - lo.d) / (hi.d - lo.d);
    return lo.dist.map((v, i) => v * (1 - t) + hi.dist[i] * t);
  }
  // 混合基線分布與難度特性 (w = 難度權重)
  const blend = (base, diff, w) => base && diff ? base.map((v, i) => v * (1 - w) + diff[i] * w) : (diff || base);
  // 新卡第一次評分的真實分布 (讀 app 主 DB) — 真實用戶新卡 44% 直接 Again
  const _newCardDist = (() => {
    try {
      const rows = db.prepare('WITH first AS (SELECT word_id, rating, row_number() OVER (PARTITION BY word_id ORDER BY id) rn FROM review_log) SELECT rating, count(*) n FROM first WHERE rn=1 GROUP BY rating').all();
      const cnt = { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (const r of rows) cnt[r.rating] = r.n;
      const t = Object.values(cnt).reduce((a, b) => a + b, 0);
      if (t >= 30) return [cnt[0] / t, cnt[1] / t, cnt[2] / t, cnt[3] / t];
    } catch {}
    return [0.05, 0.02, 0.92, 0.01];
  })();
  function pick(card, lastRating) {
    const r = rng();
    // 新卡: 用真實第一次評分分布 (避免假設新卡易學)
    if (!card || card.state === 0) {
      const d = _newCardDist;
      let acc = 0; for (let i = 0; i < 4; i++) { acc += d[i]; if (r < acc) return i; } return 2;
    }
    // 基線: 行為連結(上次評分 → 轉移分布) 或 依 reps
    let dist;
    if (lastRating != null && _transition[lastRating]) {
      dist = _transition[lastRating];
    } else {
      dist = getRealDist(card.reps ?? 0);
      if (!dist) {
        const ivl = card.scheduledDays ?? card.interval ?? 0;
        if (ivl >= 14) dist = [0.05, 0.04, 0.89, 0.02];
        else if (ivl >= 7) dist = [0.10, 0.05, 0.83, 0.02];
        else if (ivl >= 3) dist = [0.18, 0.06, 0.74, 0.02];
        else dist = [0.30, 0.07, 0.61, 0.02];
      }
    }
    // 難度調整 (連續分級): 級數越高 Again 越高、下降幅度越小; 低級數恢復快
    // 權重可經環境變數 TENO_BEHAVIOR_W 調整 (實驗用), 預設 0.4
    const behaviorW = process.env.TENO_BEHAVIOR_W ? parseFloat(process.env.TENO_BEHAVIOR_W) : 0.6;
    const diffD = getDiffDist(card.difficulty ?? 5);
    if (diffD) dist = blend(dist, diffD, behaviorW);
    let acc = 0;
    for (let i = 0; i < 4; i++) { acc += dist[i]; if (r < acc) return i; }
    return 2;
  }

  function simLoadState() {
    const words = sdb.prepare('SELECT id, word, deck FROM words').all();
    const rows = sdb.prepare('SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended FROM cards').all();
    const cards = new Map();
    for (const r of rows) cards.set(r.word_id, {
      due: r.due, stability: r.stability, difficulty: r.difficulty,
      elapsedDays: r.elapsed_days > 0 ? r.elapsed_days : null,
      scheduledDays: r.scheduled_days,
      reps: r.reps, lapses: r.lapses, state: r.state, step: r.step ?? 0,
      lastReview: r.last_review, buried: !!r.buried, suspended: !!r.suspended,
      interval: r.scheduled_days || 0, lastReviewMs: r.last_review ? new Date(r.last_review).getTime() : 0, lastReviewIso: r.last_review || null,
    });
    return { words, cards, buried: new Set(), suspended: new Set() };
  }

  const shared = simLoadState();
  let simNow = new Date(start + 'T08:00:00Z').getTime();
  Date.now = () => simNow;
  const RealDate = Date;
  const MockDate = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(simNow); else super(...args); }
    static now() { return simNow; }
  };
  global.Date = MockDate;
  Date.now = () => simNow;

  log('RUN', `simulate ${days} 天 起始=${start} 流速=${speed}s 種子=${seed}`);

  let simTotal = 0;
  for (let d = 0; d < days; d++) {
    const dateStr = new Date(simNow).toISOString().slice(0, 10);
    if (logDir) _dayLogFile = `${logDir}/day-${dayNum + d}-${dateStr}.log`;
    console.log(`[day] Day ${dayNum + d} [${dateStr}] 翻卡學習`);

    const session = new Session({
      ...shared, fsrs: new FSRS(fsrsW, anki.desiredRetention ?? 0.9, true, anki.maxIvl ?? 365),
      dayCutoff: DAY_CUTOFF, timezoneOffset: TZ_OFFSET,
      newPerDay: args.includes('--new-per-day') ? parseInt(args[args.indexOf('--new-per-day') + 1]) : (anki.cardsPerDay ?? 80), learnSteps: anki.learnSteps ?? '1,10', relearnSteps: anki.relearnSteps ?? '10',
      maxReviewsPerDay: 1000, reviewMix: anki.reviewMix ?? 2, mode: 'flip', learnAheadLimit: anki.learnAheadLimit ?? 20,
    });
    const realLog = console.log;
    const sessionConsole = (...msg) => {
      const s = String(msg[0] || '');
      if (/^\[(build|next|requeue|resync)\]/.test(s)) return;
      realLog(...msg);
    };
    console.log = sessionConsole;
    session.buildQueue(null);
    session.running = true;
    console.log = realLog;

    let count = 0;
    const today = getToday(DAY_CUTOFF, TZ_OFFSET, simNow);
    console.log(`[build] words= ${shared.words.length} cards= ${shared.cards.size} new= ${anki.cardsPerDay ?? 80} learn= ${session.intradayLearning.length} review= ${session.mainQueue.length} today= ${today}`);

    while (session.running) {
      simNow += speed * 1000;
      const c = session.next();
      if (!c) break;
      const wid = c.word.id;
      const cardNow = session.cards.get(wid);
      const isNew = !cardNow || cardNow.state === 0;
      const rating = pick(cardNow, cardNow?._lastRating);
      let card = cardNow;
      if (!card) {
        // stability=0 → FSRS 走 init (新卡難度正確初始化 ~2.1, 與真實 app 一致)
        card = { due: new Date(simNow).toISOString(), stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0, step: 0, lastReview: null, buried: false, suspended: false, interval: 0, lastReviewMs: 0, lastReviewIso: null };
        session.cards.set(wid, card);
      }
      const res = session.fsrs.review(card, rating, rng(), LEARN_STEPS, RELEARN_STEPS);
      if (res.lapses > card.lapses) {
        const lm = anki.lapseMult ?? 0;
        if (lm === 0) res.stability = 1;
        else if (lm > 0) res.stability = Math.max(1, res.stability * lm);
      }
      const dueIso = new Date(simNow + Math.max(60000, Math.round(res.dueDays * 86400000))).toISOString();
      card.state = res.state;
      card.due = dueIso;
      card.stability = res.stability;
      card.difficulty = res.difficulty;
      card.step = res.step ?? 0;
      card.interval = res.dueDays ?? 0;
      card.scheduledDays = res.state === 2 ? Math.round(res.dueDays) : res.dueDays;
      card.reps = res.reps;
      card._lastRating = rating;
      card.lapses = res.lapses;
      card.elapsedDays = null;
      card.lastReviewIso = new Date(simNow).toISOString();
      card.lastReviewMs = simNow;

      console.log(`[store.rate] ${wid} flip rating= ${rating} -> state= ${res.state} dueDays= ${res.dueDays} due= ${dueIso} step= ${card.step} interval= ${card.interval}`);
      console.log(`[fsrs] ${wid} flip in_state= ${cardNow?.state ?? 0} in_ivl= ${cardNow?.scheduledDays ?? 0} rating= ${rating} -> out_state= ${res.state} out_ivl= ${res.dueDays} stability= ${res.stability.toFixed(3)} difficulty= ${res.difficulty.toFixed(2)} lapses= ${res.lapses} step= ${res.step}`);
      session.rate(rating);
      session.requeueIntraday(wid, card);
      console.log(`[rate] ${wid} rating= ${rating} newstate= ${res.state} counts= ${session.intradayLearning.length + session.mainQueue.length}學 state= QUESTION running= ${session.running}`);
      count++;
      simTotal++;
    }
    console.log(`[requeue] day done: ${count} 張`);
    // 成熟卡快照 (供 report 準確畫累計曲線)
    try {
      const mt = sdb.prepare('SELECT count(*) n FROM cards WHERE state=2 AND scheduled_days>=21').get().n;
      const learned2 = sdb.prepare('SELECT count(*) n FROM cards WHERE state>0').get().n;
      const total2 = sdb.prepare('SELECT count(*) n FROM words').get().n;
      console.log(`[mature] 成熟=${mt} 已學=${learned2} 總=${total2} (${total2 ? Math.round(mt/total2*100) : 0}%)`);
    } catch {}
    console.log(`[next] null: all queues empty (DONE)`);

    // 存回 DB
    const wdb = sdb;
    const upsert = wdb.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0)
      ON CONFLICT(word_id) DO UPDATE SET
        due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
        elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
        reps=excluded.reps, lapses=excluded.lapses, state=excluded.state, step=excluded.step,
        last_review=excluded.last_review`);
    for (const [wid, card] of shared.cards) {
      if (!card || card.state == null) continue;
      upsert.run(wid, card.due, card.stability ?? 2.5, card.difficulty ?? 5, card.elapsedDays ?? 0,
        card.scheduledDays ?? 0, card.reps ?? 0, card.lapses ?? 0, card.state ?? 0, card.step ?? 0,
        card.lastReviewIso || new Date(card.lastReviewMs).toISOString());
    }

    simNow += (24 * 3600 - 10 * count) * 1000;
  }
  const matureCards = sdb.prepare('SELECT count(*) n FROM cards WHERE state=2 AND scheduled_days>=21').get().n;
  const totalReviews = simTotal;
  const totalWords = sdb.prepare('SELECT count(*) n FROM words').get().n;
  sdb.close();
  writeSimRun({
    kind: 'simulate', days, seed: args.includes('--seed') ? parseInt(args[args.indexOf('--seed') + 1]) : 1,
    fromZero: args.includes('--from-zero'), totalReviews,
    matureCards, maturePct: totalWords ? Math.round(matureCards / totalWords * 100) : null,
  });
  log('READ', `simulate ${days} 天完成 (${start} 起, DB=${simDbPath})`);
}

// ─── 時間沙箱 — 把 Session 困在可調時間流速環境, 腳本控制評分 (用戶行為) ───
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── report — 分析 monitor log 生成 HTML 圖表報告 ───
function cmdReport() {
  const dir = args[0] || `${HOME}/桌面/log/成熟295天`;
  const isJson = args.includes('--json');
  const fail = (msg) => { if (isJson) process.stdout.write(JSON.stringify({ error: msg })); else console.log(msg); };
  if (!existsSync(dir)) return fail(`目錄不存在: ${dir}`);
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : `${dir}/report.html`;
  const files = readdirSync(dir).filter(f => /^day-\d+-/.test(f) && f.endsWith('.log')).sort((a, b) => parseInt(a.match(/day-(\d+)/)[1]) - parseInt(b.match(/day-(\d+)/)[1]));
  if (!files.length) return fail('無 log 檔案');

  const daily = [];
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    const day = parseInt(f.match(/day-(\d+)/)[1]);
    const date = (f.match(/day-\d+-([\d-]+)/) || [])[1];
    const store = (text.match(/\[store\.rate\]/g) || []).length;
    const rate0 = (text.match(/\[store\.rate\][^\n]*rating= 0 /g) || []).length;
    const rate2 = (text.match(/\[store\.rate\][^\n]*rating= 2 /g) || []).length;
    const ivls = [...text.matchAll(/\[store\.rate\][^\n]*dueDays= ([\d.]+)/g)].map(m => parseFloat(m[1]));
    const matureIds = [...text.matchAll(/\[store\.rate\] (\w+)[^\n]*dueDays= ([\d.]+)/g)]
      .filter(m => parseFloat(m[2]) >= 21).map(m => m[1]);
    // [mature] 快照: 當天實際成熟卡數 (準確累計)
    const mSnap = (text.match(/\[mature\] 成熟=(\d+)/) || [])[1];
    daily.push({ day, date, store, rate0, rate2, matureThisDay: ivls.filter(v => v >= 21).length, matureIds, matureSnap: mSnap ? parseInt(mSnap) : null });
  }

  const seenMature = new Set();
  let lastSnap = 0;
  const matureCumulativeSeries = daily.map(d => {
    // 優先用 [mature] 每日快照 (準確); 無則累計成熟卡新增
    if (d.matureSnap != null && d.matureSnap >= 0) { lastSnap = d.matureSnap; return d.matureSnap; }
    for (const id of d.matureIds) seenMature.add(id);
    return Math.max(lastSnap, seenMature.size);
  });

  let ivlDist = null, matureCumulative = null, totalWords = null;
  // DB 優先用 log 目錄的 base.db (模擬產生的), 否則 app DB
  let dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : `${dir}/base.db`;
  if (!existsSync(dbPath)) dbPath = `${dir}/mature.db`;
  if (!existsSync(dbPath)) dbPath = DB;
  if (existsSync(dbPath)) {
    try {
      const d = new DatabaseSync(dbPath, { readOnly: true });
      matureCumulative = d.prepare('SELECT count(*) n FROM cards WHERE state=2 AND scheduled_days>=21').get().n;
      // Anki card_counts: 新/學習中/年輕/成熟/重學 (新=無卡的單字)
      const words = d.prepare('SELECT count(*) n FROM words').get().n;
      totalWords = words; // E11: 提升作用域（原 :2783 取不到本查詢而硬編碼 4868）
      const cards = d.prepare('SELECT count(*) n FROM cards').get().n;
      ivlDist = d.prepare(`SELECT CASE WHEN state=0 THEN '新' WHEN state=1 THEN '學習中' WHEN state=2 AND scheduled_days<21 THEN '年輕' WHEN state=2 THEN '成熟' WHEN state=3 THEN '重學' END g, count(*) n FROM cards GROUP BY g ORDER BY CASE WHEN state=0 THEN 0 WHEN state=1 THEN 1 WHEN state=2 AND scheduled_days<21 THEN 2 WHEN state=2 THEN 3 ELSE 4 END`).all();
      const unlearned = Math.max(0, words - cards);
      if (unlearned > 0) ivlDist.push({ g: '新(無卡)', n: unlearned });
      d.close();
    } catch {}
  }

  const labels = daily.map(d => d.day);
  const dailyReviews = daily.map(d => d.store);
  const againPct = daily.map(d => d.store ? Math.round(d.rate0 / d.store * 100) : 0);
  const goodPct = daily.map(d => d.store ? Math.round(d.rate2 / d.store * 100) : 0);
  const matureDaily = daily.map(d => d.matureThisDay);
  // E11: 原硬編碼 4868（同函式 :2769 查詢困在 try 塊作用域取不到所致）→ 實時值；
  // 回退主庫僅在整組 DB 掃描皆敗時（R1 建議#1：禁「分子 A 庫/分母 B 庫」混源 pct）；主庫亦壞 → 0
  if (totalWords == null && matureCumulative == null) { try { totalWords = db.prepare('SELECT count(*) n FROM words').get().n; } catch { totalWords = 0; } }

  // --json: 輸出純資料給 app 用現有 chart.js 直接畫 UI
  if (isJson) {
    const totalReviews = daily.reduce((a, d) => a + d.store, 0);
    process.stdout.write(JSON.stringify({
      days: daily.length, totalWords, totalReviews, matureCumulative, maturePct: matureCumulative && totalWords ? Math.round(matureCumulative / totalWords * 100) : null,
      dateFrom: daily[0].date, dateTo: daily[daily.length - 1].date,
      labels, dailyReviews, matureDaily, matureCumulativeSeries, againPct, goodPct,
      ivlDist: ivlDist ?? [],
    }));
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Teno ${daily.length} 天成熟度分析</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==" crossorigin="anonymous"></script>
<style>
body{font-family:system-ui;background:#0f1115;color:#e5e7eb;margin:0;padding:24px}
h1{font-size:20px}h2{font-size:16px;margin-top:32px;color:#a78bfa}
.card{background:#1a1d24;border-radius:12px;padding:20px;margin-top:16px}
canvas{max-height:280px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.stat{display:flex;gap:24px;flex-wrap:wrap;margin-top:16px}
.stat div{background:#1a1d24;border-radius:10px;padding:14px 20px}
.stat b{font-size:24px;display:block;color:#22c55e}
.muted{color:#9ca3af;font-size:13px}
</style></head><body>
<h1>📊 Teno ${daily.length} 天成熟度分析</h1>
<div class="muted">${daily[0].date} ~ ${daily[daily.length-1].date} · ${totalWords} 單字</div>
<div class="stat">
  <div><b>${matureCumulative ?? '?'}</b><span class="muted">最終成熟卡</span></div>
  <div><b>${daily.length}</b><span class="muted">模擬天數</span></div>
  <div><b>${daily.reduce((a, d) => a + d.store, 0)}</b><span class="muted">總評分次數</span></div>
  <div><b>${matureCumulative && totalWords ? Math.round(matureCumulative / totalWords * 100) : '?'}%</b><span class="muted">成熟率</span></div>
</div>
<div class="card"><h2>每日複習量 + 成熟卡新增（複合圖）</h2><canvas id="c1"></canvas></div>
<div class="card"><h2>成熟卡累計（已成熟卡總數）</h2><canvas id="c2"></canvas></div>
<div class="grid">
  <div class="card"><h2>每日 Again 率</h2><canvas id="c3"></canvas></div>
  <div class="card"><h2>每日 Good 率</h2><canvas id="c4"></canvas></div>
</div>
${ivlDist ? `<div class="card"><h2>卡片狀態分布</h2><canvas id="c5"></canvas></div>` : ''}
<script>
new Chart(document.getElementById('c1'), { type:'bar', data:{ labels:${JSON.stringify(labels)}, datasets:[
  { type:'bar', label:'每日複習', data:${JSON.stringify(dailyReviews)}, backgroundColor:'#a78bfa', yAxisID:'y', order:2 },
  { type:'line', label:'成熟卡新增', data:${JSON.stringify(matureDaily)}, borderColor:'#22c55e', backgroundColor:'#22c55e55', fill:false, yAxisID:'y1', order:1 }
]}, options:{ plugins:{legend:{display:true,position:'top'}}, scales:{ y:{position:'left',title:{display:true,text:'複習量'}}, y1:{position:'right',title:{display:true,text:'成熟卡'},grid:{drawOnChartArea:false}} } } });
new Chart(document.getElementById('c2'), { type:'line', data:{ labels:${JSON.stringify(labels)}, datasets:[
  { label:'累計成熟卡', data:${JSON.stringify(matureCumulativeSeries)}, borderColor:'#22c55e', backgroundColor:'#22c55e33', fill:true, tension:0.3 }
]}, options:{ plugins:{legend:{display:false}}, scales:{ y:{title:{display:true,text:'成熟卡數'}} } } });
new Chart(document.getElementById('c3'), { type:'line', data:{ labels:${JSON.stringify(labels)}, datasets:[{label:'Again%', data:${JSON.stringify(againPct)}, borderColor:'#ef4444', fill:false}] }, options:{ plugins:{legend:{display:false}}, scales:{y:{min:0,max:100}} } });
new Chart(document.getElementById('c4'), { type:'line', data:{ labels:${JSON.stringify(labels)}, datasets:[{label:'Good%', data:${JSON.stringify(goodPct)}, borderColor:'#22c55e', fill:false}] }, options:{ plugins:{legend:{display:false}}, scales:{y:{min:0,max:100}} } });
${ivlDist ? `new Chart(document.getElementById('c5'), { type:'pie', data:{ labels:${JSON.stringify(ivlDist.map(d=>d.g))}, datasets:[{data:${JSON.stringify(ivlDist.map(d=>d.n))}, backgroundColor:['#fbbf24','#f97316','#06b6d4','#22c55e','#ef4444']}] } });` : ''}
</script></body></html>`;

  writeFileSync(outFile, finalizeReportHtml(html));
  console.log(`✅ 報告已生成: ${outFile}`);
  log('READ', `report ${dir}: ${daily.length} 天, ${daily.reduce((a, d) => a + d.store, 0)} 次評分`);
}

// ─── mature — 從零跑到目標成熟度 % (可調) ───
function cmdMature() {
  const targetPct = args[0] ? parseFloat(args[0]) : 95;
  if (isNaN(targetPct) || targetPct <= 0 || targetPct > 100) return console.log(`目標成熟度無效: ${args[0]}, 需 0-100`);
  const target = targetPct / 100;
  const maxDays = args.includes('--max-days') ? parseInt(args[args.indexOf('--max-days') + 1]) : 365;
  const start = args.includes('--start') ? args[args.indexOf('--start') + 1] : '2026-08-03';
  const seed = args.includes('--seed') ? parseInt(args[args.indexOf('--seed') + 1]) : 1;
  const speed = args.includes('--speed') ? parseInt(args[args.indexOf('--speed') + 1]) : 10;
  log('RUN', `mature 目標 ${targetPct}% 成熟, 最多 ${maxDays} 天, seed=${seed} speed=${speed}`);
  const matureLogDir = args.includes('--log-dir') ? args[args.indexOf('--log-dir') + 1] : `${HOME}/.config/com.teno.app/sim-logs`;
  mkdirSync(matureLogDir, { recursive: true });
  const MATURE_DB = `${matureLogDir}/mature.db`;
  // 先建立成熟 DB (備份 app DB)
  if (!existsSync(MATURE_DB)) {
    spawnSync('sqlite3', [DB, `.backup '${MATURE_DB}'`], { encoding: 'utf8' });
  }
  // --from-zero: 從零開始 (清空成熟 DB 進度)
  if (args.includes('--from-zero')) {
    const d = new DatabaseSync(MATURE_DB);
    d.exec('DELETE FROM cards; DELETE FROM review_log;');
    d.close();
    log('RUN', `from-zero: 清空 ${MATURE_DB} 卡片進度`);
  }
  // E12: totalReviews 原讀 mature.db review_log——simulate 只 upsert cards 零寫
  // log（全檔 INSERT INTO review_log 唯 cmdRate/import），讀到的永远是建檔時
  // app 真庫快照（使用者刷題史冒充模擬 effort）；成功分支更連傳都不傳（null）。
  // 正確計量＝本次 run 期間 cards.reps 總和增量（fsrs.js:305 每評 reps+1 官方語意）。
  const sumReps = (p) => { try { const d = new DatabaseSync(p, { readOnly: true }); const n = d.prepare('SELECT COALESCE(SUM(reps),0) n FROM cards').get().n; d.close(); return n; } catch { return null; } };
  const repsBase = sumReps(MATURE_DB); // 基線＝建檔/清空後、日循環前
  const simReviews = () => { const s = sumReps(MATURE_DB); return repsBase != null && s != null ? s - repsBase : null; };

  let day = 0, mature = 0;
  while (day < maxDays) {
    const date = new Date(Date.parse(start) + day * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    spawnSync('node', [process.argv[1] || new URL('./cli.mjs', import.meta.url).pathname, 'simulate', '--days', '1', '--start', dateStr, '--day-num', String(day + 1), '--seed', String(seed), '--speed', String(speed), '--sim-db', MATURE_DB, '--log-dir', matureLogDir, '--no-simrun'], {
      encoding: 'utf8', env: { ...process.env, TENO_DB: DB }, timeout: 120000,
    });
    const d = new DatabaseSync(MATURE_DB, { readOnly: true });
    const total = d.prepare('SELECT count(*) n FROM words').get().n;
    mature = d.prepare('SELECT count(*) n FROM cards WHERE state=2 AND scheduled_days>=21').get().n;
    const learned = d.prepare('SELECT count(*) n FROM cards WHERE state>0').get().n;
    d.close();
    const pct = total ? (mature / total * 100).toFixed(1) : '0';
    console.log(`Day ${day + 1} [${dateStr}] learned=${learned} mature=${mature} (${pct}%)`);
    day++;
    if (total && mature / total >= target) {
      console.log(`\n✅ 達到 ${targetPct}% 成熟卡! 共 ${day} 天`);
      log('READ', `mature 達 ${targetPct}%: ${day} 天`);
      writeSimRun({ kind: 'mature', days: day, targetPct, seed, fromZero: args.includes('--from-zero'), totalReviews: simReviews(), matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });
      return;
    }
  }
  const d = new DatabaseSync(MATURE_DB, { readOnly: true });
  const total = d.prepare('SELECT count(*) n FROM words').get().n;
  d.close(); // E12: totalReviews 改經 simReviews() 基線差（原讀 review_log＝備份快照謊數）
  console.log(`\n⚠ ${maxDays} 天內未達 ${targetPct}% 成熟 (最後 ${(mature / total * 100).toFixed(1)}%)`);
  writeSimRun({ kind: 'mature', days: day, targetPct, seed, fromZero: args.includes('--from-zero'), totalReviews: simReviews(), matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });
}

function cmdDiagnose() {
  const dir = args[0] || `${HOME}/桌面/log/成熟295天`;
  if (!existsSync(dir)) return console.log(`目錄不存在: ${dir}`);
  const files = readdirSync(dir).filter(f => /^day-\d+-/.test(f) && f.endsWith('.log')).sort((a, b) => parseInt(a.match(/day-(\d+)/)[1]) - parseInt(b.match(/day-(\d+)/)[1]));
  if (!files.length) return console.log('無 day-N log 檔案');

  let totalIssues = 0, prevCount = 0;
  const dayIssues = [];
  const issue = (day, type, msg) => { totalIssues++; dayIssues.push({ day, type, msg }); };

  for (const f of files) {
    const day = parseInt(f.match(/day-(\d+)/)[1]);
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    const lines = text.split('\n');
    const storeRates = lines.filter(l => l.includes('[store.rate]'));
    const nexts = lines.filter(l => l.includes('[next]'));

    if (storeRates.length === 0) issue(day, '空session', '無任何 [store.rate]');
    if (!text.includes('DONE') && !text.includes('all queues empty')) issue(day, '未完成', '缺少結束標記');

    // 相鄰同卡
    const seq = storeRates.map(l => (l.match(/\[store\.rate\] (\w+)/) || [])[1]);
    let maxConsec = 1, cur = 1;
    for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[i-1]) { cur++; maxConsec = Math.max(maxConsec, cur); } else cur = 1; }
    if (maxConsec > 3) issue(day, '重複循環', `相鄰 ${maxConsec} 次同一張卡`);

    // 評分越界 / dueDays / interval
    for (const l of storeRates) {
      const r = (l.match(/rating= (\d+)/) || [])[1];
      if (r && parseInt(r) > 3) issue(day, '評分越界', `rating=${r}`);
      const d = (l.match(/dueDays= ([\d.]+)/) || [])[1];
      if (d && (parseFloat(d) < 0 || parseFloat(d) > 365)) issue(day, '間隔異常', `dueDays=${d}`);
      const i = (l.match(/interval= (-?[\d.]+)/) || [])[1];
      if (i && parseFloat(i) < 0) issue(day, 'interval負數', `interval=${i}`);
    }
    // stability NaN
    for (const l of lines.filter(l => l.includes('[fsrs]'))) {
      const s = (l.match(/stability= ([^\s]+)/) || [])[1];
      if (s && (s.includes('NaN') || s.includes('Infinity'))) issue(day, 'stability異常', `stability=${s}`);
    }
    // 顯示未評分
    const nextCards = nexts.map(l => (l.match(/: (\w+)/) || [])[1]).filter(Boolean);
    const rateCards = new Set(storeRates.map(l => (l.match(/\[store\.rate\] (\w+)/) || [])[1]));
    const shownNotRated = nextCards.filter(c => c && !rateCards.has(c)).length;
    if (shownNotRated > 10) issue(day, '顯示未評分', `${shownNotRated} 張卡顯示但未評分`);
    // resync
    const resyncCount = (text.match(/\[resync\]/g) || []).length;
    if (resyncCount > 0) issue(day, 'resync觸發', `${resyncCount} 次撈回遺漏卡`);
    // state 異常
    for (const l of storeRates) { if (l.match(/-> state= 0 /)) { issue(day, 'state異常', '評分後變新卡(state 0)'); break; } }
    // 卡死循環
    const cardFreq = {};
    for (const l of storeRates) { const cid = (l.match(/\[store\.rate\] (\w+)/) || [])[1]; if (cid) cardFreq[cid] = (cardFreq[cid] || 0) + 1; }
    const maxFreq = Math.max(0, ...Object.values(cardFreq));
    if (maxFreq > 15) issue(day, '卡死循環', `同卡 ${maxFreq} 次`);
    // 單卡壟斷
    if (storeRates.length > 0) {
      const topFreq = Math.max(...Object.values(cardFreq));
      if (topFreq / storeRates.length > 0.05) issue(day, '單卡壟斷', `單卡 ${topFreq} 次 (${(topFreq / storeRates.length * 100).toFixed(1)}%)`);
    }
    // 複習量突變
    if (day > 1 && prevCount > 0 && storeRates.length > 0) {
      const ratio = storeRates.length / prevCount;
      if (ratio > 3 || ratio < 0.33) issue(day, '複習量突變', `Day${day-1} ${prevCount} → Day${day} ${storeRates.length}`);
    }
    prevCount = storeRates.length;
    // 全 Again / 全 Good
    if (storeRates.length > 10) {
      const r0 = storeRates.filter(l => l.includes('rating= 0 ')).length;
      const r2 = storeRates.filter(l => l.includes('rating= 2 ')).length;
      if (r0 === storeRates.length) issue(day, '全Again', '所有評分都是 Again');
      if (r2 === storeRates.length) issue(day, '全Good', '所有評分都是 Good');
    }
  }

  console.log(`\n════════ Log 診斷 (${files.length} 天) ════════`);
  if (totalIssues === 0) console.log('✅ 全部正常, 無異常');
  else {
    console.log(`⚠ 發現 ${totalIssues} 個異常, 涉及 ${new Set(dayIssues.map(d => d.day)).size} 天\n`);
    const byType = {};
    for (const i of dayIssues) byType[i.type] = (byType[i.type] || 0) + 1;
    console.log('── 異常類型統計 ──');
    for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n} 次`);
    console.log('\n── 異常詳情 (前 20) ──');
    for (const i of dayIssues.slice(0, 20)) console.log(`  Day ${i.day} [${i.type}] ${i.msg}`);
  }
  const storeCounts = files.map(f => (readFileSync(`${dir}/${f}`, 'utf8').match(/\[store\.rate\]/g) || []).length);
  const minR = Math.min(...storeCounts), maxR = Math.max(...storeCounts), avgR = (storeCounts.reduce((a, b) => a + b, 0) / storeCounts.length).toFixed(1);
  console.log(`\n── 概覽 ──`);
  console.log(`每日評分: 最小 ${minR} / 平均 ${avgR} / 最大 ${maxR}`);
  if (storeCounts.filter(c => c === 0).length) console.log(`⚠ ${storeCounts.filter(c => c === 0).length} 天無評分`);
  log('READ', `diagnose ${dir}: ${files.length} 天, ${totalIssues} 異常`);
}

function cmdExamSessions() {
  const sub = args[0];
  const r = db.prepare(`SELECT value FROM settings WHERE key='examSessions'`).get();
  const list = r ? JSON.parse(r.value) : [];
  if (sub === 'list' || !sub) {
    console.log(`測驗 Session (${list.length}):`);
    for (const s of list) console.log(`  ${s.id} ${s.mode} score=${s.score ?? '?'} ${new Date(s.timestamp).toLocaleString()}`);
    log('READ', `exam-sessions list: ${list.length} 個`);
  } else if (sub === 'clear') {
    if (!args.includes('--yes')) return console.log('將清除測驗 sessions, 加 --yes');
    backupDb();
    writeSetting('examSessions', '[]');
    log('WRITE', 'exam-sessions clear');
    console.log('已清除測驗 sessions');
  } else if (sub === 'max') {
    const v = parseInt(args[1]);
    if (isNaN(v)) return console.log('需: exam-sessions max <數量>');
    backupDb();
    writeSetting('maxExamSessions', String(v));
    if (list.length > v) writeSetting('examSessions', JSON.stringify(list.slice(0, v)));
    log('WRITE', `exam-sessions max=${v}`);
    console.log(`已設 maxExamSessions=${v}`);
  } else {
    console.log('exam-sessions 子命令: list | clear --yes | max <數量>');
  }
}

function cmdFolders() {
  const rows = db.prepare('SELECT * FROM folders').all();
  console.log('資料夾:');
  for (const r of rows) console.log(`  ${r.name} ${r.children ?? ''}`);
  log('READ', `folders: ${rows.length} 個`);
}

function cmdAdditions() {
  const rows = db.prepare('SELECT * FROM additions ORDER BY id DESC LIMIT 30').all();
  console.log(`候選單字 (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.id} ${r.word} [${r.deck}] ${r.definition ?? ''}`);
  log('READ', `additions: ${rows.length} 筆`);
}

function cmdEdits() {
  const rows = db.prepare('SELECT * FROM edits ORDER BY updated_at DESC LIMIT 20').all();
  console.log(`編輯歷史 (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.word_id} ${new Date(r.updated_at).toLocaleString()}`);
  log('READ', `edits: ${rows.length} 筆`);
}

// ═══════════════ 工具頁: 單字庫掃描 (重複/缺欄位) ═══════════════

function cmdScan() {
  const sub = args[0];
  const words = db.prepare('SELECT id, word, definition, part_of_speech, pronunciation, example, synonym, antonym, derivative, related, forms, examples, tags FROM words ORDER BY word').all();
  if (sub === 'dupes') {
    const seen = new Map();
    const dupes = [];
    for (const w of words) {
      const lower = (w.word || '').toLowerCase().trim();
      if (!lower) continue;
      if (seen.has(lower)) dupes.push({ word: lower, first: seen.get(lower), dup: w.id });
      else seen.set(lower, w.id);
    }
    console.log(`重複單字 (${dupes.length}):`);
    for (const d of dupes) console.log(`  ${d.word} (${d.first} / ${d.dup})`);
    log('READ', `scan dupes: ${dupes.length} 個重複`);
  } else if (sub === 'missing') {
    const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    const noDef = words.filter(w => !w.definition || !w.definition.trim());
    const noPos = words.filter(w => !w.part_of_speech || !w.part_of_speech.trim());
    const noEx = words.filter(w => !w.example && !parseList(w.examples).length);
    const noPron = words.filter(w => !w.pronunciation || !w.pronunciation.trim());
    const noRelated = words.filter(w => !w.synonym && !w.antonym && !w.derivative && !parseList(w.related).length);
    const noForms = words.filter(w => !parseList(w.forms).length);
    const summary = { 缺定義: noDef.length, 缺詞性: noPos.length, 缺例句: noEx.length, 缺發音: noPron.length, 缺相關詞: noRelated.length, 缺詞形: noForms.length };
    console.log('缺欄位統計:');
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
    const what = args[1];
    const map = { def: noDef, pos: noPos, ex: noEx, pron: noPron, related: noRelated, forms: noForms };
    if (what && map[what]) {
      console.log(`\n${what} 缺漏清單 (前 30):`);
      for (const w of map[what].slice(0, 30)) console.log(`  ${w.id} ${w.word}`);
    }
    log('READ', `scan missing: ${JSON.stringify(summary)}`);
  } else {
    console.log('scan 子命令: dupes | missing [def|pos|ex|pron|related|forms]');
  }
}

// ═══════════════ 工具頁: LLM 批次產生 (透過 Ollama API) ═══════════════

async function llmCall(prompt) {
  const baseUrl = process.env.LLM_URL || 'http://localhost:11434/api/generate';
  const model = process.env.LLM_MODEL || '';
  const m = model ? { model } : {};
  const body = JSON.stringify({ ...m, prompt, stream: false, options: { temperature: 0.1 } });
  const resp = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const j = await resp.json();
  return j.response ?? j.message?.content ?? '';
}

function cmdLlm() {
  const sub = args[0];
  if (!sub) return console.log('llm 子命令: pos | related | forms | pron | examples | spellcheck');
  const words = db.prepare('SELECT id, word, definition, part_of_speech, pronunciation, example, synonym, related, forms, examples FROM words ORDER BY word').all();
  const target = words.filter(w => {
    const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    if (sub === 'pos') return !w.part_of_speech;
    if (sub === 'related') return !w.synonym && !parseList(w.related).length;
    if (sub === 'forms') return !parseList(w.forms).length;
    if (sub === 'pron') return !w.pronunciation;
    return true;
  });
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 20;
  const batch = target.slice(0, limit);
  const prompts = {
    pos: (w) => `What is/are the part(s) of speech of "${w.word}"? If multiple, list them comma-separated. Return ONLY English POS labels (e.g. noun, verb, adjective), nothing else.`,
    pron: (w) => `Provide the IPA pronunciation of "${w.word}". Return ONLY the IPA string (e.g. /ˈhɛloʊ/), nothing else.`,
    related: (w) => `Provide synonyms and related words for "${w.word}". Return ONLY a JSON array of strings, nothing else.`,
    forms: (w) => `Provide word forms (past tense, -ing, -ed, derived nouns etc.) for "${w.word}". Return ONLY a JSON array of strings, nothing else.`,
    examples: (w) => `Provide 2 natural English example sentences using "${w.word}". Return ONLY a JSON array of strings, nothing else.`,
  };
  console.log(`LLM 產生 ${sub}: 待處理 ${target.length}, 本次批次 ${batch.length}`);
  if (!batch.length) return console.log('無待處理單字');
  (async () => {
    const results = { pos: 0, pron: 0, related: 0, forms: 0, examples: 0 };
    for (const w of batch) {
      try {
        const text = await llmCall(prompts[sub](w));
        const cleaned = text.replace(/```json|```/g, '').trim();
        let val = cleaned;
        if (['related', 'forms', 'examples'].includes(sub)) {
          try { val = JSON.parse(cleaned); } catch { val = cleaned.split(',').map(s => s.trim()).filter(Boolean); }
        }
        console.log(`  ${w.word}: ${typeof val === 'string' ? val.slice(0, 60) : JSON.stringify(val).slice(0, 60)}`);
        results[sub]++;
      } catch (e) { console.log(`  ${w.word}: ❌ ${e.message}`); }
    }
    log('READ', `llm ${sub}: 成功 ${results[sub]}/${batch.length}`);
  })().catch(e => log('ERROR', `llm ${sub} 失敗: ${e.message}`));
}

// ═══════════════ 工具頁: Cambridge 查詢 ═══════════════

async function cmdCambridge() {
  const word = args[0];
  const lang = args[1] === 'zh' ? 'zh' : 'en';
  if (!word) return console.log('需: cambridge <單字> [zh]');
  const url = lang === 'zh'
    ? `https://dictionary.cambridge.org/dictionary/english-chinese-traditional/${word}`
    : `https://dictionary.cambridge.org/dictionary/english/${word}`;
  log('RUN', `cambridge ${word} (${lang})`);
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return console.log(`HTTP ${resp.status}`);
  const html = await resp.text();
  // 簡易解析: 抓 definition / IPA / example
  const defs = [...html.matchAll(/class="def ddef_d db">(.*?)<\/div>\s*<\/div>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim())
    .filter(Boolean).slice(0, 5);
  const ipas = [...html.matchAll(/<span class="ipa[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 3);
  const exs = [...html.matchAll(/<span class="eg[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 3);
  console.log(`Cambridge ${word} (${lang}):`);
  console.log(`  IPA: ${ipas.join(', ') || '未找到'}`);
  console.log(`  定義:`);
  defs.forEach((d, i) => console.log(`    ${i + 1}. ${d}`));
  console.log(`  例句:`);
  exs.forEach((e, i) => console.log(`    ${i + 1}. ${e}`));
  log('READ', `cambridge ${word}: defs=${defs.length} ipa=${ipas.length} exs=${exs.length}`);
}

// ═══════════════ 工具頁: OCR 辨識字卡（CLI 版，與 GUI 同 pipeline）═══════════
// ocr <圖片路徑> [--deck 名] [--no-verify]
//   GUI 對應 : src/pages/ocr.js — 完成「辨識 → token 白名單 → 黑名單 → Cambridge
//   查證 → 入庫 OCR Inbox」。CLI 版以 image 路徑為輸入，Cambridge 走 fetch 直連
//   （不走 Tauri invoke，避免 dev-web 卡死）。依賴 tesseract.js + 離線資產。

import { createWorker } from 'tesseract.js';
import { DEFAULT_BLACKLIST, normalizeBlackWord } from '../src/lib/ocr-blacklist.js';

// OCR 離線資產（public/assets/ocr — 打包進 vite public 路由；Node 下用絕對路徑載入）
const OCR_ASSETS = resolve(process.cwd(), 'public/assets/ocr');

// CAMBRIDGE 查證（抽自 cmdCambridge；回 true=查到 senses）。ocr 用，非 cmdCambridge。
async function cambridgeVerify(word) {
  const url = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return false;
  const html = await resp.text();
  const defs = [...html.matchAll(/class="def ddef_d db">(.*?)<\/div>\s*<\/div>/g)];
  return defs.length > 0;
}

const _ocrTokenRe = /^[a-z][a-z'-]{1,30}$/i;   // 與 GUI tools.js:9 同正則

async function cmdOcr() {
  const imgPath = args[0];
  if (!imgPath || !existsSync(imgPath)) return console.log('需: ocr <圖片路徑> [--deck 名] [--no-verify]');
  const deck = (args.find((x, i) => args[i - 1] === '--deck') || 'OCR Inbox');
  const noVerify = args.includes('--no-verify');
  log('RUN', `ocr ${imgPath} deck=${deck} verify=${!noVerify}`);

  // 黑名單: 預設 ∪ db 自訂（與 store loadBlacklist 對齊）
  const blSet = new Set(DEFAULT_BLACKLIST.map(normalizeBlackWord));
  try {
    const custom = db.prepare(`SELECT value FROM settings WHERE key='blacklist'`).get();
    if (custom?.value) { try { JSON.parse(custom.value).forEach(w => blSet.add(normalizeBlackWord(w))); } catch {} }
  } catch {}

  // 1. OCR 辨識
  console.log('辨識中...');
  const buf = readFileSync(imgPath);
  const worker = await createWorker(['eng'], 1, {
    langPath: `${OCR_ASSETS}/lang`,
    gzip: true,
  });
  // Node 環境資產無 http server，改用 node_modules 相對/絕對路徑
  try {
    const { data } = await worker.recognize(buf);
    await worker.terminate();
    // 2. token 白名單過濾 │ 去重保序
    const seen = new Set(); const tokens = [];
    for (const raw of (data.text || '').split(/\s+/)) {
      const t = raw.toLowerCase().replace(/^[^\w'-]+/, '').replace(/[^\w'-]+$/, '');
      if (!_ocrTokenRe.test(t) || seen.has(t)) continue;
      seen.add(t); tokens.push(t);
    }
    console.log(`辨識出 ${tokens.length} 個候選單字: ${tokens.join(', ')}`);
    if (!tokens.length) { console.log('未偵測到有效單字'); log('DONE', `ocr ${imgPath}: 0 tokens`); return; }

    // 3. 黑名單過濾
    const clean = tokens.filter(w => !blSet.has(w));
    const blacklisted = tokens.length - clean.length;
    if (blacklisted) console.log(`黑名單擋掉 ${blacklisted}: ${tokens.filter(w => blSet.has(w)).join(', ')}`);

    // 4. Cambridge 查證（可 --no-verify 關）
    let toAdd = clean;
    if (!noVerify && clean.length) {
      const passed = []; let notFound = [];
      for (const w of clean) {
        try { (await cambridgeVerify(w)) ? passed.push(w) : notFound.push(w); }
        catch (e) { passed.push(w); }   // 離線降級放行（同 GUI）
      }
      toAdd = passed;
      if (notFound.length) console.log(`Cambridge 查不到 ${notFound.length}: ${notFound.join(', ')}`);
    }
    if (!toAdd.length) { console.log('無值得入庫的單字'); log('DONE', `ocr ${imgPath}: clean ${clean.length}→add ${toAdd.length}`); return; }

    // 5. 入庫（同 cmdImportCsv 慣例: Backup → INSERT → audit）
    backupDb();
    const w = dbw();
    const existing = new Set(db.prepare('SELECT lower(word) w FROM words').all().map(x => x.w));
    let added = 0, skipped = 0;
    const stmt = w.prepare(`INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const wt of toAdd) {
      if (existing.has(wt)) { skipped++; continue; }
      existing.add(wt);
      const id = nextWordId();
      stmt.run(id, wt, '', '', '', '', deck, '[]', '', '', '[]', '[]', '', '', '', '[]', new Date().toISOString());
      added++;
    }
    w.close();
    console.log(`已加入 ${added} 個單字到 ${deck}${skipped ? `（跳過 ${skipped} 重複）` : ''}`);
    log('WRITE', `ocr ${imgPath}: add=${added} skip=${skipped} blacklist=${blacklisted} deck=${deck}`);
    audit('ocr-import', `OCR 入庫 ${imgPath}: 新增 ${added}, 跳過 ${skipped}, 黑名單 ${blacklisted}`);
  } catch (e) {
    await worker.terminate().catch(() => {});
    console.error('OCR 辨識失敗:', e.message);
    log('ERROR', `ocr ${imgPath}: ${e.message}`);
  }
}

// ═══════════════ 語音模型 (piper) — 對應 UI「已安裝模型」 ═══════════════

function cmdPiper() {
  const sub = args[0];
  const dir = `${HOME}/.config/com.teno.app/piper-models`;
  const models = [];
  try {
    for (const f of readdirSyncSafe(dir)) {
      if (f.endsWith('.onnx')) models.push(f.replace(/\.onnx$/, ''));
    }
  } catch {}
  if (sub === 'list' || !sub) {
    console.log(`已安裝語音模型 (${models.length}):`);
    for (const m of models) console.log(`  ${m}`);
    const cur = db.prepare(`SELECT value FROM settings WHERE key='ttsVoice'`).get();
    console.log(`\n目前語音: ${cur?.value}`);
    log('READ', `piper list: ${models.length} 個模型`);
  } else if (sub === 'delete') {
    const name = args[1];
    if (!name) return console.log('需: piper delete <模型名>');
    if (!models.includes(name)) return console.log('無此模型');
    backupDb();
    rmSyncSafe(`${dir}/${name}.onnx`);
    log('WRITE', `piper delete ${name}`);
    console.log(`已刪除模型 ${name}`);
  } else if (sub === 'set') {
    const name = args[1];
    if (!name) return console.log('需: piper set <模型名>');
    if (!models.includes(name)) return console.log('無此模型, 可用: ' + models.join(', '));
    backupDb();
    writeSetting('ttsVoice', name);
    log('WRITE', `piper set ${name}`);
    console.log(`已設語音為 ${name}`);
  } else {
    console.log('piper 子命令: list | set <名> | delete <名>');
  }
}

// ═══════════════ Google Drive 同步狀態 ═══════════════

function cmdDrive() {
  const cfg = `${HOME}/.config/com.teno.app`;
  const creds = existsSync(`${cfg}/drive_creds.json`) ? JSON.parse(readFileSync(`${cfg}/drive_creds.json`, 'utf8')) : null;
  const tokens = existsSync(`${cfg}/drive_tokens.json`) ? JSON.parse(readFileSync(`${cfg}/drive_tokens.json`, 'utf8')) : null;
  const sub = args[0];
  if (sub === 'status' || !sub) {
    console.log(`憑證: ${creds ? (creds.client_id ? '已設定 (client_id=' + String(creds.client_id).slice(0, 20) + '…)' : '已設定') : '未設定'}`);
    console.log(`Token: ${tokens?.access_token ? `有效 (refresh_token: ${tokens.refresh_token ? '有' : '無'})` : '未登入'}`);
    console.log('子命令: status | creds | tokens | upload | download');
    log('READ', `drive: creds=${creds ? '有' : '無'} token=${tokens?.access_token ? '有' : '無'}`);
  } else if (sub === 'creds') {
    if (creds) console.log(JSON.stringify(creds, null, 1));
    else console.log('無憑證');
  } else if (sub === 'tokens') {
    if (tokens) console.log(JSON.stringify({ access_token: tokens.access_token?.slice(0, 20) + '…', refresh_token: tokens.refresh_token ? '有' : '無', expiry: tokens.expires_at ?? tokens.expiry }, null, 1));
    else console.log('未登入');
  } else if (sub === 'upload' || sub === 'download') {
    driveSync(sub).catch(e => console.log(`❌ Drive ${sub === 'upload' ? '上傳' : '下載'}失敗: ${e.message}`));
  } else {
    console.log('drive 子命令: status | creds | tokens | upload | download');
  }
}

// ─── Drive 上傳/下載 (mirror drive_sync.rs: refresh token + Drive API) ───
async function driveSync(sub) {
  const cfg = `${HOME}/.config/com.teno.app`;
  const creds = existsSync(`${cfg}/drive_creds.json`) ? JSON.parse(readFileSync(`${cfg}/drive_creds.json`, 'utf8')) : null;
  const tokenPath = `${cfg}/drive_tokens.json`;
  const tokens = existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, 'utf8')) : null;
  if (!creds?.client_id || !tokens?.refresh_token) throw new Error('尚未設定 Drive 憑證/登入，請先在 app 內完成 OAuth');

  // ensure_token: 過期就 refresh
  let access = tokens.access_token;
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = tokens.expires_at ?? tokens.expiry;
  if (!access || !expiresAt || nowSec >= expiresAt - 60) {
    const body = new URLSearchParams({
      client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
    });
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: String(body),
    });
    const v = await resp.json();
    if (!v.access_token) throw new Error('token refresh 失敗: ' + JSON.stringify(v).slice(0, 200));
    access = v.access_token;
    tokens.access_token = access;
    tokens.expires_at = nowSec + (v.expires_in || 3600) - 60;
    writeFileSync(tokenPath, JSON.stringify(tokens));
  }

  // D10-SR: 對齊 Rust drive_sync.rs pick_latest_file 語意 — modifiedTime
  // (RFC3339 UTC 字典序=max)，平手留首見；全缺 mtime 退回首顆有 id；
  // null/缺 id/非字串 條目跳過；空/非陣列 → null。
  const pickLatestDriveFile = (files) => {
    let fileId = null;
    let bestMtime = null;
    let firstWithId = null;
    const arr = Array.isArray(files) ? files : [];
    for (const f of arr) {
      if (!f || typeof f.id !== 'string') continue;
      if (firstWithId === null) firstWithId = f.id;
      if (typeof f.modifiedTime === 'string' && (bestMtime === null || f.modifiedTime > bestMtime)) {
        bestMtime = f.modifiedTime;
        fileId = f.id;
      }
    }
    return fileId ?? firstWithId;
  };
  // find_db_file
  const q = encodeURIComponent("name='teno.db' and trashed=false");
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${encodeURIComponent("modifiedTime desc")}&fields=files(id,modifiedTime)`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const list = await listResp.json();
  let fileId = pickLatestDriveFile(list?.files);

  if (sub === 'upload') {
    if (!fileId) {
      const meta = { name: 'teno.db', mimeType: 'application/x-sqlite3' };
      const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      const created = await createResp.json();
      fileId = created.id;
      if (!fileId) throw new Error('建立 Drive 檔案失敗: ' + JSON.stringify(created).slice(0, 200));
    }
    const data = readFileSync(DB);
    const upResp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/x-sqlite3' },
      body: data,
    });
    if (!upResp.ok) throw new Error(`上傳失敗 HTTP ${upResp.status}`);
    audit('drive-upload', `上傳 teno.db → Drive (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`✅ 已上傳 teno.db 至 Google Drive (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    if (!fileId) throw new Error('遠端尚未有備份，請先上傳');
    const dlResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (!dlResp.ok) throw new Error(`下載失敗 HTTP ${dlResp.status}`);
    const buf = Buffer.from(await dlResp.arrayBuffer());
    // 覆蓋前先備份
    if (existsSync(DB)) copyFileSync(DB, `${DB}.bak-sync`);
    rmWal(DB);
    writeFileSync(DB, buf);
    audit('drive-download', `從 Drive 下載 teno.db (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`✅ 已從 Google Drive 下載 teno.db (${(buf.length / 1024 / 1024).toFixed(1)} MB)，原檔備份為 teno.db.bak-sync`);
  }
}

// ═══════════════ 自動備份管理 — 對應 UI「自動備份管理」 ═══════════════

function cmdBackups() {
  const sub = args[0];
  const dir = `${HOME}/.config/com.teno.app`;
  const files = readdirSyncSafe(dir).filter(f => f.endsWith('.bak') || f.endsWith('.db.bak') || /\.db\.bak-\d{14}$/.test(f) || /^teno\.db\.bak/.test(f));
  const info = files.map(f => {
    const p = `${dir}/${f}`;
    return { name: f, size: existsSync(p) ? statSyncSafe(p) : 0, mtime: existsSync(p) ? mtimeSyncSafe(p) : 0 };
  }).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  if (sub === 'list' || !sub) {
    console.log(`自動備份 (${info.length}):`);
    for (const b of info) console.log(`  ${b.name} ${(b.size / 1024 / 1024).toFixed(1)}MB ${b.mtime ? new Date(b.mtime).toLocaleString() : ''}`);
    log('READ', `backups: ${info.length} 個`);
  } else if (sub === 'restore') {
    const name = args[1];
    if (!name) return console.log('需: backups restore <檔名>');
    if (!existsSync(`${dir}/${name}`)) return console.log('無此備份');
    backupDb();
    rmWal(DB);
    copyFileSync(`${dir}/${name}`, DB);
    log('WRITE', `backups restore ${name}`);
    console.log(`已還原 ${name} → ${DB}`);
  } else if (sub === 'delete') {
    const name = args[1];
    if (!name) return console.log('需: backups delete <檔名>');
    if (!existsSync(`${dir}/${name}`)) return console.log('無此備份');
    rmSyncSafe(`${dir}/${name}`);
    log('WRITE', `backups delete ${name}`);
    console.log(`已刪除 ${name}`);
  } else if (sub === 'prune') {
    const keep = parseInt(args[1]) || 10;
    backupDb();
    const toDelete = info.slice(keep);
    for (const b of toDelete) rmSyncSafe(`${dir}/${b.name}`);
    log('WRITE', `backups prune 保留 ${keep}`);
    console.log(`已保留最新 ${keep} 個, 刪除 ${toDelete.length} 個`);
  } else {
    console.log('backups 子命令: list | restore <名> | delete <名> | prune <保留數>');
  }
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function statSyncSafe(p) {
  try { return statSync(p).size; } catch { return 0; }
}
function mtimeSyncSafe(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}
function rmSyncSafe(p) {
  try { rmSync(p, { force: true }); } catch {}
}

// ─── 新 CLI 命令 ───

async function cmdStudy() {
  const readline = (await import('readline')).default;
  const mode = args[0] === 'mc' ? 'mc' : args[0] === 'spell' ? 'spell' : 'flip';
  const count = args[1] ? parseInt(args[1]) : 20;
  const s = loadState();
  // Load Anki settings from DB (not in loadState)
  const asRow = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
  const baseCfg = asRow ? JSON.parse(asRow.value) : {};
  let ankiCfg = baseCfg;
  if (mode === 'mc') {
    try { ankiCfg = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='ankiSettingsMc'`).get()?.value || '{}'); } catch { ankiCfg = baseCfg; }
  } else if (mode === 'spell') {
    try { ankiCfg = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='ankiSettingsSpell'`).get()?.value || '{}'); } catch { ankiCfg = baseCfg; }
  }
  // E7: mc/spell 卡狀態存於 base 行 mc_data/spell_data 容器欄（store.js:312-317/764-772
  // saveModeCard 同模型）。修前用 base cardMap 一通處理：mc/spell 作答覆寫 flip 卡
  // （污染排程）且 mode 自身狀態從未持久化。modeCardMap 拆出受評 mode 的卡圖
  // （flip 恆等 s.cards，:125）；queue/評分/elapsed/futureCounts/存檔讀取自動 mode-aware。
  const cardMap = modeCardMap(s, mode);

  // E6: 構造統一 fsrsCtx(mode) — 權重/retention clamp(0.7,0.99)/maxIvl/steps(A4 防線)
  // 與 store.rateCard:650-655/711-712 及 cmdAudit replay 同構。修前自建構造：retention
  // 未 clamp＋split-map steps → study 寫入值與 replay 漂移＝重演 E5 假 mismatch 模式
  const { fsrs, learnSteps, relearnSteps } = fsrsCtx(mode);
  const dayCutoffRow = db.prepare(`SELECT value FROM settings WHERE key='dayCutoff'`).get();
  const dayCutoff = dayCutoffRow ? parseInt(dayCutoffRow.value) : 0;
  const STATE_REVIEW = 2;

  // Build queue: due cards first, then new cards
  const queue = [];
  const now = Date.now();
  for (const [wid, card] of cardMap) {
    if (card.buried || card.suspended) continue;
    if (card.due && new Date(card.due).getTime() <= now) {
      const w = findWord(wid);
      if (!w) continue;
      // preview intervals
      const elapsed = card.elapsedDays ?? card.scheduledDays ?? 0;
      const state = {
        stability: card.stability ?? 0, difficulty: card.difficulty ?? 5,
        state: card.state ?? 0, reps: card.reps ?? 0, lapses: card.lapses ?? 0,
        step: card.step ?? 0, elapsedDays: elapsed, scheduledDays: card.scheduledDays ?? 0,
      };
      const iv = [];
      for (let r = 0; r < 4; r++) {
        try { const res = fsrs.review(state, r, 0.5, learnSteps, relearnSteps, null); iv.push(res.dueDays); } catch { iv.push(1); }
      }
      queue.push({ wid, word: w.word, def: w.definition, state: card.state, stability: card.stability, reps: card.reps, intervals: iv });
    }
  }
  // Add new cards to fill up to count
  const newSlots = Math.max(0, count - queue.length);
  let added = 0;
  for (const w of s.words) {
    if (added >= newSlots) break;
    if (!cardMap.has(w.id)) {
      const state = { stability: 0, difficulty: 5, state: 0, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };
      const iv = [];
      for (let r = 0; r < 4; r++) {
        try { const res = fsrs.review(state, r, 0.5, learnSteps, relearnSteps, null); iv.push(res.dueDays); } catch { iv.push(1); }
      }
      queue.push({ wid: w.id, word: w.word, def: w.definition, state: 0, stability: 0, reps: 0, intervals: iv });
      added++;
    }
  }

  if (queue.length === 0) { console.log('沒有待複習卡片'); return; }

  // Print queue
  console.log(`═══ CLI 學習 (${mode}) ═══`);
  console.log(`到期: ${queue.length - added}  新卡: ${added}  共: ${queue.length}`);
  console.log('a=Again  h=Hard  g=Good  e=Easy  q=結束\n');

  // Must use stdin directly for single-char; readline with per-line input works
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let reviewed = 0;
  const reviews = [];   // E6: 逐題複習記錄，結束時與 cards 同一連接寫 review_log
  const askNext = () => {
    return new Promise((resolve) => {
      if (reviewed >= queue.length) { resolve(); return; }
      const item = queue[reviewed];
      const iv = item.intervals.map(v => {
        if (v < 1) return `${Math.round(v * 1440)}m`;
        return `${Math.round(v)}d`;
      });
      console.log(`\n${reviewed + 1}/${queue.length}  ${item.word}`);
      if (item.def) console.log(`  ${item.def.slice(0, 80)}`);
      console.log(`  state=${item.state}  stability=${item.stability?.toFixed(1)}  reps=${item.reps}`);
      console.log(`  [a]Again ${iv[0]}  [h]Hard ${iv[1]}  [g]Good ${iv[2]}  [e]Easy ${iv[3]}`);
      const shownAt = Date.now();   // E6: duration 錨點（Anki 記 answer prompt 滯留同語意）
      rl.question('  > ', (ans) => {
        const key = ans.trim().toLowerCase();
        if (key === 'q') { rl.close(); resolve(); return; }
        const rating = { a: 0, h: 1, g: 2, e: 3 }[key];
        if (rating == null) { console.log(`  跳過 (無效: ${key})`); askNext().then(resolve); return; }

        // Rate via FSRS
      const card = cardMap.get(item.wid);
      // E6: elapsed 改 dayCutoff-aware（鏡像 cmdRate E4 — normTs→toLocalDateStr＋
      // getToday(now)＋daysBetween＋夾零；修前用 card?.elapsedDays 陳舊 DB 值 →
      // fsrs delta_t 漂移、寫進 log 的 elapsed_days 也髒）
      const atMs = Date.now();
      const tzM = ankiCfg.timezoneOffset ?? TZ_OFFSET;
      const lastTs = card?.lastReview ? new Date(normTs(card.lastReview)).getTime() : null;
      const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), tzM, dayCutoff) : null;
      const elapsed = lastDay != null ? Math.max(0, daysBetween(lastDay, getToday(dayCutoff, tzM, atMs))) : 0;
      const currentState = card ? {
        stability: card.stability ?? 0, difficulty: card.difficulty ?? 5,
        state: card.state ?? 0, reps: card.reps ?? 0, lapses: card.lapses ?? 0,
        step: card.step ?? 0, elapsedDays: elapsed, scheduledDays: card.scheduledDays ?? 0,
      } : { stability: 0, difficulty: 5, state: 0, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };

        const fuzz = generateFuzzFactor(item.wid + '_' + mode, currentState.reps);
        // E6: futureCounts 與 store:714-716/cmdRate E5 同條件（REVIEW/RELEARNING、
        // 複習前 cardMap 快照）— 修前恆 null
        const futureCounts = (currentState.state === STATE_REVIEW || currentState.state === 3)
          ? computeFutureDueCounts(cardMap, 90, dayCutoff, tzM) : null;
        const result = fsrs.review(currentState, rating, fuzz, learnSteps, relearnSteps, futureCounts);

        const newCard = {
          due: new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000))).toISOString(),
          stability: result.stability, difficulty: result.difficulty,
          elapsedDays: elapsed, scheduledDays: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
          reps: result.reps, lapses: result.lapses, state: result.state, step: result.step ?? 0,
          lastReview: new Date(atMs).toISOString(), buried: false, suspended: false,
          interval: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
        };
        cardMap.set(item.wid, newCard);
        // E6: 逐題記錄（reviewed_at=作答時刻非存檔時刻；duration=實測 A9 cap 60s 同構）
        reviews.push({ wid: item.wid, rating, elapsed, prev: currentState.state,
          post: result, atMs,
          durationMs: Math.min(60000, Math.max(0, Math.round(Date.now() - shownAt))) });
        console.log(`  → ${['Again','Hard','Good','Easy'][rating]}  next=${iv[rating]}  state=${result.state}`);

        reviewed++;
        askNext().then(resolve);
      });
    });
  };

  await askNext();
  rl.close();

  // Save all changes back to DB
  backupDb();
  ensureSchema();   // E6 R1#2: 對齊 cmdRate:1284 — 舊 DB 缺 new_state/duration/mode 欄時
                    // INSERT 硬失敗前先自我修復（app v5.2 migrate 之外路徑）
  const w = dbw();
  if (mode === 'flip') {
    for (const [wid, card] of cardMap) {
      w.prepare(`INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,buried,suspended,step)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(word_id) DO UPDATE SET due=excluded.due,stability=excluded.stability,difficulty=excluded.difficulty,elapsed_days=excluded.elapsed_days,scheduled_days=excluded.scheduled_days,reps=excluded.reps,lapses=excluded.lapses,state=excluded.state,last_review=excluded.last_review,buried=excluded.buried,suspended=excluded.suspended,step=excluded.step`)
        .run(wid, card.due, card.stability, card.difficulty, card.elapsedDays ?? 0, card.scheduledDays ?? 0, card.reps ?? 0, card.lapses ?? 0, card.state ?? 0, card.lastReview, card.buried ? 1 : 0, card.suspended ? 1 : 0, card.step ?? 0);
    }
    // ON CONFLICT 欄清單不含 mc_data/spell_data → flip 存檔天然不抹容器資料（E7 T6）
  } else {
    // E7: mc/spell 只寫容器欄，flip 欄永不觸碰。容器模板 due:''/state=0/reps=0/
    // stability=0/difficulty=5 逐字鏡像 store rateCard:760-763/saveModeCard:187-196
    // （R1#2：不補 S/D 會落 DB schema 預設 2.5/0.0 與 app 容器行值差；
    // due=datetime('now') 預設則讓 flip queue 誤判容器卡到期——關鍵細節）。
    // JSON=camelCase 全卡形＝store:769 baseCard.mcData={...newCard} 同形，
    // app hydrate(:316) 直接 spread 消費。
    const col = mode === 'mc' ? 'mc_data' : 'spell_data';
    const stmt = w.prepare(`INSERT INTO cards (word_id, due, state, reps, stability, difficulty, ${col})
      VALUES (?, '', 0, 0, 0, 5, ?)
      ON CONFLICT(word_id) DO UPDATE SET ${col}=excluded.${col}`);
    for (const [wid, card] of cardMap) stmt.run(wid, JSON.stringify(card));
  }
  // E6: review_log 修前全程零寫入 → optimize（fsrs-optimize.py per-mode WHERE）/audit
  // 看不到 CLI 複習。11 欄語意逐欄對齊 store.js rateCard:792-803＋cmdRate E4 INSERT：
  // duration=實測cap60s、elapsed=複習前、scheduled=round(dueDays) 無條件、
  // stability/difficulty=複習後、card_state=複習前、new_state=複習後、reviewed_at=逐題時刻 Z
  const insLog = w.prepare(`INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const rv of reviews) insLog.run(rv.wid, rv.rating, rv.durationMs, rv.elapsed,
    Math.round(rv.post.dueDays), rv.post.stability, rv.post.difficulty, mode,
    rv.prev, rv.post.state, new Date(rv.atMs).toISOString());
  w.close();
  log('WRITE', `study ${reviewed} reviewed (mode=${mode}) review_log +${reviews.length}`);
  console.log(`\n═══ 完成 ${reviewed} 張 ═══`);
}

async function cmdLeechList() {
  const s = loadState();
  const threshold = args[0] ? parseInt(args[0]) : 8;
  const leeches = [];
  for (const [wid, card] of s.cards) {
    if ((card.lapses ?? 0) >= threshold) {
      const w = findWord(wid);
      leeches.push({ word: w?.word ?? '?', id: wid, lapses: card.lapses, state: card.state, ivl: card.scheduledDays ?? card.interval ?? 0 });
    }
  }
  leeches.sort((a, b) => b.lapses - a.lapses);
  console.log(`Leech cards (lapses ≥ ${threshold}): ${leeches.length}`);
  for (const l of leeches) {
    console.log(`  ${l.word.padEnd(16)} lapses=${l.lapses} state=${l.state} ivl=${l.ivl}d`);
  }
  log('READ', `leech-list threshold=${threshold} count=${leeches.length}`);
}

async function cmdResetCard() {
  const wid = args[0];
  if (!wid) return console.log('需: reset-card <wordId>');
  backupDb();
  const w = dbw();
  const card = w.prepare('SELECT * FROM cards WHERE word_id=?').get(wid);
  if (!card) { w.close(); return console.log(`卡片不存在: ${wid}`); }
  w.prepare('DELETE FROM cards WHERE word_id=?').run(wid);
  w.prepare('DELETE FROM review_log WHERE word_id=?').run(wid);
  w.close();
  log('WRITE', `reset-card ${wid} (${card.reps} reviews, state=${card.state})`);
  audit('reset-card', `重置卡 ${wid} (${card.reps} reviews, state=${card.state})`);
  console.log(`已重置 ${wid}`);
}

async function cmdDbCheck() {
  const dbPath = args[0] || DB;
  console.log(`檢查 ${dbPath} …`);
  const start = Date.now();
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const r = d.prepare('PRAGMA integrity_check').all();
  d.close();
  const elapsed = (Date.now() - start) / 1000;
  console.log(`結果: ${r[0]?.integrity_check || JSON.stringify(r)} (${elapsed.toFixed(1)}s)`);
  const stats = new DatabaseSync(dbPath, { readOnly: true });
  for (const [label, sql] of Object.entries({
    單字: 'SELECT count(*) c FROM words',
    卡片: 'SELECT count(*) c FROM cards',
    複習: 'SELECT count(*) c FROM review_log',
    牌組: 'SELECT count(*) c FROM decks',
  })) {
    const c = stats.prepare(sql).get();
    console.log(`  ${label}: ${c.c}`);
  }
  stats.close();
  log('READ', `db-check ok`);
}

async function cmdRandom() {
  const n = args[0] ? parseInt(args[0]) : 10;
  const deck = args.includes('--deck') ? args[args.indexOf('--deck') + 1] : null;
  const state = args.includes('--state') ? parseInt(args[args.indexOf('--state') + 1]) : null;

  const all = db.prepare(`
    SELECT w.*, c.state, c.stability, c.difficulty, c.reps, c.lapses, c.scheduled_days, c.due, c.last_review
    FROM words w LEFT JOIN cards c ON c.word_id = w.id
    WHERE 1=1
      ${deck ? "AND w.deck = '" + deck.replace(/'/g, "''") + "'" : ''}
      ${state != null ? "AND COALESCE(c.state,0) = " + state : ''}
  `).all();

  if (all.length === 0) { console.log('無符合條件的單字'); return; }

  const selected = [];
  const indices = new Set();
  while (selected.length < Math.min(n, all.length)) {
    const i = Math.floor(Math.random() * all.length);
    if (indices.has(i)) continue;
    indices.add(i);
    selected.push(all[i]);
  }

  console.log(`隨機抽取 ${selected.length}/${all.length} 個單字:\n`);
  for (const w of selected) {
    console.log(`  📝 ${w.word}  (${w.id})`);
    if (w.definition) console.log(`     定義: ${w.definition}`);
    if (w.part_of_speech) console.log(`     詞性: ${w.part_of_speech}`);
    if (w.pronunciation) console.log(`     發音: ${w.pronunciation}`);
    if (w.synonym) console.log(`     同義: ${w.synonym}`);
    if (w.antonym) console.log(`     反義: ${w.antonym}`);
    if (w.derivative) console.log(`     衍生: ${w.derivative}`);
    if (w.related) console.log(`     關聯: ${w.related}`);
    if (w.forms) console.log(`     詞形: ${w.forms}`);
    if (w.examples) console.log(`     例句: ${w.examples}`);
    if (w.deck) console.log(`     牌組: ${w.deck}`);
    if (w.tags) console.log(`     標籤: ${w.tags}`);
    const stateNames = {0:'新卡',1:'學習',2:'複習',3:'複學'};
    if (w.state != null) {
      console.log(`     狀態: ${stateNames[w.state] || w.state}  stability=${w.stability?.toFixed(2)}  reps=${w.reps}  lapses=${w.lapses}  ivl=${w.scheduled_days}d`);
    }
    console.log();
  }
  log('READ', `random n=${selected.length} deck=${deck || 'all'} state=${state ?? 'all'}`);
}

// ─── 舊有命令區 ───

function usage() {
  console.log(`Teno 全控 CLI (唯讀預設, 寫入自動備份)
診斷:
  stats | dash | due | card <id> | history <id> | sql "<SELECT...>"
  search <詞> [--full] [--limit N]   (搜尋全部欄位)
  list [--deck X] [--state N] [--tag T] [--pos P] [--sort] [--full] [--limit N] [--desc]
單字:
  add --word cat --def 貓 --deck 日常 --pos noun --pron /kæt/ --ex "例句" --tags a,b --related x,y --forms cats,catty
  edit <id> --def 新定義 --deck X --tags a,b --desc 描述
  delete <id> --yes
  autofill set cambridge,dict-api,tatoeba,llm | autofill move <來源> up|down
Deck:
  decks | create-deck <名> [--color #hex] | update-deck <名> [--color] [--rename]
  merge-deck <來源> <目標> | rename-deck <舊> <新> | delete-deck <名> --yes
  deck-order move <名> up|down
Tag:
  tags | create-tag <名> [--color #hex] | delete-tag <名> | tag-words <名>
外觀 (主題/顏色):
  theme mode <dark|light> | theme accent <名> | theme intensity <0~1>
  theme palette <#色,...> | accent 可用: ${ACCENTS.join('/')}
發音:
  tts speed <0.3~3> | tts voice <名> | tts pitch <0~99> | tts engine <名>
  tts-play <單字id或英文> (用 espeak-ng 播放發音)
每日/目標:
  day <0~1439 分鐘日界線> | goal <每日目標> | streak
學習演算法:
  anki [flip|mc|spell] | anki set <欄位> <值> [--mode flip|mc|spell]
  simparams set <欄位> <值>
過濾 Deck:
  filtered | filtered-add <名> --query "..." [--max N] | filtered-delete <名>
測驗/資料:
  exam list | exam clear --yes | exam-sessions list|clear --yes|max <數>
  exam-run <flip|mc|spell> [--deck 字本] [--count N] [--answers 1,0,1] [--correct-pct 80] [--tag-correct correct] [--tag-wrong wrong]
  reset-all --yes
工具 (FSRS):
  optimize (用複習記錄最佳化 FSRS 權重) | health (健康檢查)
  simulate --days N --start YYYY-MM-DD [--day-num N] [--seed S] [--speed SEC]
    (真實學習模擬: 逐張卡依熟練度評分, 輸出完整 monitor log [build]/[next]/[store.rate]/[fsrs]/[requeue], 存回 DB)
  report [log目錄] [--out 檔] [--db 檔] (生成 HTML 圖表報告: 複習量/成熟曲線/評分/間隔分布)
  mature <目標%> [--max-days N] [--start 日期] (從零跑到目標成熟度, 每天模擬直到達成)
  diagnose [log目錄] (檢查 monitor log 的異常/bug: 循環/掉卡/resync/資料錯誤)
  fsrs-report (FSRS 行為監測: 評分分布/轉移/間隔/穩定性/水蛭)
  audit (一致性稽核: review_log 重算 vs cards 表)
  audit-log [--limit N] (查看審計軌跡: 設定變更/匯入匯出/CLI 寫入)
  diff <db1> [db2] (兩個 DB 差異比對)
  whatif <cardId> <ratings e.g. 2,2,0,2> [--mode flip|mc|spell] (評分序列預測)
工具 (單字庫):
  scan dupes | scan missing [def|pos|ex|pron|related|forms]
  llm pos|related|forms|pron|examples [--limit N]
  cambridge <單字> [zh]
  ocr <圖片路徑> [--deck 名] [--no-verify]  (辨識圖片→黑名單→Cambridge查證→入庫 OCR Inbox)
語音/Drive/備份:
  piper list|set <名>|delete <名> (已安裝語音模型)
  drive status|creds|tokens (Google Drive 同步狀態)
  backups list|restore <名>|delete <名>|prune <保留數> (自動備份管理)
資料表:
  folders | additions | edits
設定:
  settings [key] | set <key> <value>
CSV:
  export-csv [路徑] | import-csv <路徑>
評分/模擬:
  rate <id> <0|1|2|3> | sim [--ratings 0,2,1] | stray | doublefire [log]
修復 (寫入, 自動備份):
  fix reset-card <id> | fix graduate <id> | fix rewind <id> | fix reset-stray
  leech-list [門檻=8] | reset-card <id> | db-check [路徑]
  study [flip|mc|spell] [數量=20]    (終端機互動學習)
  random [n=10] [--deck X] [--state N] (隨機抽單字秀完整資訊)
備份:
  backup | restore <檔>
環境: TENO_DB=路徑 預設 ${DB}, TENO_LOG=log路徑 預設 /tmp/teno-cli.log`);
}

const handlers = {
  stats: cmdStats, dash: cmdDash, due: cmdDue, card: cmdCard, history: cmdHistory,
  sql: cmdSql, search: cmdSearch, list: cmdList,
  add: cmdAdd, edit: cmdEdit, delete: cmdDelete,
  decks: cmdDecks, 'create-deck': cmdCreateDeck, 'update-deck': cmdUpdateDeck,
  'merge-deck': cmdMergeDeck, 'deck-order': cmdDeckOrder,
  'rename-deck': cmdRenameDeck, 'delete-deck': cmdDeleteDeck,
  tags: cmdTags, 'create-tag': cmdCreateTag, 'delete-tag': cmdDeleteTag,
  'tag-words': cmdTagWords, autofill: cmdAutofill,
  settings: cmdSettings, set: cmdSet, anki: cmdAnki, sim: cmdSim,
  simparams: cmdSimParams, theme: cmdTheme, tts: cmdTts, 'tts-play': cmdTtsPlay, day: cmdDay,
  goal: cmdGoal, streak: cmdStreak,
  'filtered': cmdFilteredDecks, 'filtered-add': cmdFilteredDeckAdd, 'filtered-delete': cmdFilteredDeckDelete,
  'reset-all': cmdResetAll, exam: cmdExam, 'exam-run': cmdExamRun,
  optimize: cmdOptimize, health: cmdHealth, 'fsrs-report': cmdFsrsReport, simulate: cmdSimulate, report: cmdReport, mature: cmdMature, diagnose: cmdDiagnose,
  audit: cmdAudit, 'audit-log': cmdAuditLog, diff: cmdDiff, whatif: cmdWhatif,
  scan: cmdScan, llm: cmdLlm, cambridge: cmdCambridge, ocr: cmdOcr,
  piper: cmdPiper, drive: cmdDrive, backups: cmdBackups,
  'exam-sessions': cmdExamSessions, folders: cmdFolders, additions: cmdAdditions, edits: cmdEdits,
  'export-csv': cmdExportCsv, 'import-csv': cmdImportCsv,
  rate: cmdRate, sim: cmdSim, stray: cmdStray, doublefire: cmdDoublefire,
  fix: cmdFix, backup: cmdBackup, restore: cmdRestore,
  logs: cmdLogs, sims: cmdSims, 'log-retention': cmdLogRetention, 'log-prune': cmdLogPrune,
  behavior: cmdBehavior, compare: cmdCompare, fit: cmdFit, selftest: cmdSelfTest,
  'export-db': cmdExportDb, 'import-db': cmdImportDb,
  'leech-list': cmdLeechList, 'reset-card': cmdResetCard, 'db-check': cmdDbCheck,
  study: cmdStudy, random: cmdRandom,
};

// ─── 程式化 API — 供 UI 層 / Discord bot / 其他腳本 import ───
// 用法: const api = await import('./cli.mjs');
//       api.runCli(['stats']);   // 等同 CLI
//       api.api.rate('w_xxx', 2); // 直接呼叫 (需自行處理輸出)
export const api = {
  db, today, ANKI,
  loadState, makeSession, localDue, findWord, nextWordId,
  addWord: (data) => { args.splice(0); args.push('add', ...data); cmdAdd(); },
  editWord: cmdEdit, deleteWord: cmdDelete,
  rateCard: cmdRate, resetStray: () => { args.splice(0); args.push('fix', 'reset-stray'); cmdFix(); },
};

export async function runCli(argv = process.argv.slice(2)) {
  const t0 = Date.now();
  const old = [...args];
  args.length = 0; args.push(...argv);
  const c = args.shift();
  log('CMD', `node tools/cli.mjs ${argv.join(' ')}`);
  try {
    if (handlers[c]) {
      await handlers[c]();
      log('DONE', `${c} (${((Date.now() - t0) / 1000).toFixed(2)}s)`);
    } else {
      args.push(...old);
      log('UNKNOWN', `未知命令: ${c}`);
      usage();
    }
  } catch (err) {
    log('ERROR', `${c} 失敗: ${err.message}\n${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
    console.error(`命令 ${c} 失敗:`, err.message);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await runCli();
}

