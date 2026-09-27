// 學測題庫（gsat 插件頁）—— 97–115 年學測英文，本地判分（不叫 LLM）。
// v2：官方 5 大題分入口、整卷依原序（題組不拆）、錯題本（列表＋單題重做）、統計（正確率/誘答/復原率/模考配分）。
import { icon } from '../lib/svg.js';
import { logPractice, loadPractice, practiceRows } from '../lib/practice-log.js';
import { getSetting, setSetting } from '../lib/db.js';
import { fetchLLM, parseLLMJson } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import { radarChart, lineChart, barChart } from '../lib/chart.js';
import gsatRaw from '../assets/gsat/gsat.jsonl?raw';
import gsatTrRaw from '../assets/gsat/gsat_translate.jsonl?raw';
import gsatTrPromptRaw from '../assets/gsat/gsat_tr_grading.md?raw';

const ALL = [
  ...gsatRaw.trim().split('\n').map(l => JSON.parse(l)),
  ...gsatTrRaw.trim().split('\n').map(l => JSON.parse(l)),   // 中譯英（非選擇）也進學測題庫
];

// section 有 17 種編碼變體（占/佔、（）/()、分/%）→ 正規化成官方大題＋配分
const catOf = (sec = '') => {
  if (/中\s*譯\s*英|翻\s*譯\s*題/.test(sec)) return '中譯英';
  if (/詞彙/.test(sec)) return '詞彙';
  if (/綜合測驗/.test(sec)) return '綜合測驗';
  if (/文意選填/.test(sec)) return '文意選填';
  if (/篇章結構/.test(sec)) return '篇章結構';
  if (/閱讀/.test(sec)) return '閱讀測驗';
  return sec || '其他';
};
const wOf = (sec = '') => { const m = sec.match(/(\d+)\s*[分%]/); return m ? Number(m[1]) : 0; };

// 每題自帶其文章（詞彙除外）→ 題組 = 連續同文章字串，groupInfo 自動切段
const QUESTIONS = ALL
  .map(q => ({ ...q, cat: catOf(q.section), w: q.w ?? wOf(q.section) }))   // 中譯英每題 4 分（section 寫的是大題 8 分）
  .sort((a, b) => Number(a.year) - Number(b.year) || Number(a.no) - Number(b.no));

const BY_ID = new Map(QUESTIONS.map(q => [q.id, q]));
const CATS = ['詞彙', '綜合測驗', '文意選填', '篇章結構', '閱讀測驗', '中譯英'];
const YEARS = [...new Set(QUESTIONS.map(q => Number(q.year)))].sort((a, b) => a - b);
const yearOf = (qid) => Number(String(qid || '').split('-')[1]);
const noSort = (arr) => arr.sort((a, b) => Number(a.no) - Number(b.no));   // no 是 JSON number

// 各年配分（同大題同年去重取值；正常情況每年總和 72）
const YEAR_TOTAL = {};
for (const y of YEARS) {
  const per = {};
  for (const q of QUESTIONS.filter(x => Number(x.year) === y)) {
    // 中譯英題目 w=4/句，但年配分是大題 8 分；其餘取題配分
    per[q.cat] = q.cat === '中譯英' ? 8 : Math.max(per[q.cat] || 0, q.w);
  }
  YEAR_TOTAL[y] = Object.values(per).reduce((s, v) => s + v, 0);
}

let view = 'home';        // home | year | quiz | result | wrong | stats
let cat = null;
let year = null;
let queue = [];
let idx = 0;
let pick = null;
let results = [];
let single = false;       // 錯題單題重做
let fullPaper = false;    // 整卷模考（一年全卷、全大題依原序）
// paperActive＝「有一份整卷存檔在進行」——只有 startPaper(full)/restoreProgress 亮燈；
// fullPaper 只是入口意向（點 data-full 先亮、還沒開卷），拿它寫檔會把分類練習誤存成整卷進度
let paperActive = false;
let graded = false;        // 整卷已交卷批改 → 結果頁（錯題報告跟著存檔走，放棄才消失）
// 計時器：timerAcc＝累積（毫秒），timerMark＝本段起點（離開作答頁自動停錶）
let timerAcc = 0;
let timerMark = 0;
let timerInt = null;

function timerMs() { return timerAcc + (timerMark ? Date.now() - timerMark : 0); }
function timerPause() { if (timerMark) { timerAcc += Date.now() - timerMark; timerMark = 0; } }
function fmtTimer(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
// 碼錶獨立右欄：與 meta 文字分屬兩個 flex item（並排不互壓）
const timerHtml = () => fullPaper && paperActive
  ? `<span class="gsat-timer" style="flex-shrink:0">${icon('clock', 12)}<b id="paperTimer">${fmtTimer(timerMs())}</b></span>` : '';

// 實例 id：多實例（測試/換頁殘留）共用 document listener 時，只有當前頁的實例響應
const GID = Math.random().toString(36).slice(2, 9);
const isMine = () => document.querySelector('[data-page="gsat"]')?.dataset.gsid === GID;

// 累積式 passage（前組自帶前幾篇全文）→ 只顯示本組新增段落，不然好幾篇文章黏在同一頁
function passageShown(i) {
  const p = queue[i]?.passage;
  const prev = queue[i - 1]?.passage || '';
  return prev && p && p.startsWith(prev) ? p.slice(prev.length) : p;
}

// 題幹統一：句中題號空位（＿31＿ / 裸題號）→ 一致的底線空格槽；1990s、4,000 不誤傷
function stemHtml(q) {
  const s = q.stem || '';
  if (q.type === 'translate' || !q.no) return s;
  return s.replace(new RegExp(`[＿_]?\\s?(?<![\\d,.])${q.no}(?![\\d,.])[＿_]?`, 'g'),
    `<span class="gsat-fill">${q.no}</span>`);
}

const keyHint = `<p style="font-size:11px;color:var(--text-tertiary);margin:8px 0 0">鍵盤：1-5/A-E 選答 · 題組按 A-E 直接填空 · ← → 上下題 · Enter 下一題/交卷 · Esc 回首頁</p>`;
const keyHintTr = `<p style="font-size:11px;color:var(--text-tertiary);margin:8px 0 0">鍵盤：Ctrl+Enter 送出跳題 · Esc 首頁（← → 移游標）</p>`;
// 中譯英背景批改：qid -> {status, out/text/err}

// 作答＋批改記憶：qid -> {status,out/text/err}（localStorage 足夠；要跟 DB 備份走再進 settings）
const trStore = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('teno:gsat:tr') || '{}');
    // App 關掉時還在 pending 的批次 → 轉 error，不留永久轉圈
    for (const k of Object.keys(o)) if (o[k]?.status === 'pending') o[k] = { status: 'error', err: '批改中斷（App 關閉）', text: o[k].text };
    return o;
  } catch { return {}; }
})();
const saveTr = (qid, entry) => {
  trStore[qid] = entry;
  try { localStorage.setItem('teno:gsat:tr', JSON.stringify(trStore)); } catch { /* 溢位：記到這為止 */ }
};
const trGrades = {};
// 中譯英草稿：qid -> 未送出的字（per-qid，換題/回頭不丟；送出的字在 trGrades[qid].text）
const drafts = {};
let setSeq = 0;   // 換卷/換題集合就 +1：舊批次的背景批改回來只入帳、不動畫面
const TR_OFFICIAL = (avg) => (avg >= 93 ? 4 : avg >= 80 ? 3 : avg >= 60 ? 2 : avg >= 40 ? 1 : 0);   // 官方每題 4 分
let storeRef = null;

const loadLog = () => practiceRows('gsat');

// ── 中途退出的進度：只有「整卷模考」需要記（其餘模式記了沒意義——單題/分題型重進就重抽）。
//    payload 只有 year＋作到第幾題＋本卷結果；題目序列用 year 現場重建，不存 id。
//    DB settings 為準（關 app 記得住、跟備份走），localStorage 當鏡像＋DB 未就緒的降級。
const PROG_KEY = 'teno:gsat:progress';
const SET_KEY = 'gsat_progress';
let resumed = false;   // 剛還原進度 → 顯示「放棄這卷」

function saveProgress() {
  // 規則：存檔只進不出——整卷進行中（paperActive）寫入；單題重做/分類練習不動舊存檔。
  // 清檔只有一條路：clearProgress（放棄這卷）。回首頁、逛統計都算暫離，照存。
  if (!paperActive || !queue.length) return;
  // t=計時（ms，交卷後凍結）、g=已批改（結果頁跟著存檔走，放棄才消失）
  const payload = { v: 1, year, idx, results, t: timerMs(), g: graded || undefined };
  try {
    localStorage.setItem(PROG_KEY, JSON.stringify(payload));
  } catch { /* 無 localStorage → 只靠 DB */ }
  setSetting(SET_KEY, payload).catch(() => {});
}

function paperQueue(y) {
  return noSort(QUESTIONS.filter(q => Number(q.year) === Number(y)));
}

// 現存的整卷存檔（同步讀 LS 鏡像）：開新卷前的覆蓋確認共用（未完成存檔／已批改報告都算）
function existingSave() {
  try {
    const p = JSON.parse(localStorage.getItem(PROG_KEY) || 'null');
    if (p && p.v === 1 && p.year != null && typeof p.idx === 'number' && paperQueue(p.year).length) return p;
  } catch { /* 損檔 */ }
  return null;
}

async function restoreProgress() {
  let p = null;
  try {
    const dbVal = await getSetting(SET_KEY);
    if (dbVal && typeof dbVal === 'object') p = dbVal;   // DB 準
  } catch { /* DB 未就緒 → 走 localStorage */ }
  if (!p) {
    try { p = JSON.parse(localStorage.getItem(PROG_KEY) || 'null'); } catch { /* 損檔 */ }
  } else {
    try { localStorage.setItem(PROG_KEY, JSON.stringify(p)); } catch {}
  }
  try {
    if (!p || p.v !== 1 || p.year == null || typeof p.idx !== 'number' || p.idx < 0) return false;
    const qs = paperQueue(p.year);
    if (!qs.length) return false;
    const saved = Array.isArray(p.results) ? p.results : [];
    // 完整性：結果與題序一對一（null＝未答空洞，允許；有值但 qid 不對＝損檔棄掉）
    if (saved.some((r, i) => r && r.qid !== qs[i]?.id)) return false;
    queue = qs;
    queue.forEach(q => { if (trStore[q.id]) trGrades[q.id] = trStore[q.id]; });   // 關 app 前的批改跟著回來
    idx = Math.min(p.idx | 0, qs.length - 1);
    // 題組（文選/綜合/閱讀）＝整組一頁作答：存檔位置落在組中段 → 拉回組首（答案全保留）
    if (qs[idx].passage) {
      const pp = qs[idx].passage;
      while (idx > 0 && qs[idx - 1].passage === pp) idx--;
    }
    results = saved;   // 對齊佇列的答案全保留（整卷可自由前後走）
    pick = results[idx] ? results[idx].picked : null;   // 本題已答過 → 還原答題狀態
    cat = null; year = Number(p.year);
    fullPaper = true; single = false; paperActive = true;
    timerAcc = p.t || 0; timerMark = 0;
    // 已批改（g）→ 錯題報告頁；舊版逐題批改的完整存檔也算已批改（免重批、免重複入帳）
    graded = !!p.g || (saved.length >= qs.length && qs.every((_, i) => saved[i] && typeof saved[i].ok === 'boolean'));
    view = graded ? 'result' : 'quiz';
    return true;
  } catch (e) { console.error('[gsat-restore]', e); return false; }   // 失敗要留痕：靜默吞掉過一次（const 遮蔽）導致還原永遠 false
}

function clearProgress() {
  try { localStorage.removeItem(PROG_KEY); } catch {}
  setSetting(SET_KEY, '').catch(() => {});
}

// ── 作答 ──
async function startPaper(y, full = false) {
  // 規則：同卷進度直接續作（不問）；換別卷＝覆蓋存檔（未完成/報告都算）→ 點頭才換。
  if (full) {
    const old = existingSave();
    if (old && Number(old.year) !== Number(y)) {
      const what = old.g ? `${old.year} 年的錯題報告` : `${old.year} 年未完成的存檔`;
      if (!confirm(`已有 ${what}，開始新卷會覆蓋它，放棄嗎？`)) return false;
    } else if (old && Number(old.year) === Number(y)) {
      if (await restoreProgress()) { resumed = true; reRender(); return true; }
      // 損檔 → 當新卷開始
    }
  }
  year = y;
  fullPaper = full;
  paperActive = full;
  graded = false;
  timerAcc = 0; timerMark = 0;
  const pool = full
    ? QUESTIONS.filter(q => Number(q.year) === y)
    : QUESTIONS.filter(q => q.cat === cat && Number(q.year) === y);
  queue = noSort(pool);
  idx = 0; pick = null; results = []; single = false; view = 'quiz';
  for (const k of Object.keys(trGrades)) delete trGrades[k];
  queue.forEach(q => { if (trStore[q.id]) trGrades[q.id] = trStore[q.id]; });   // 舊作答/批改跟著題目回來
  setSeq++;
  return true;
}

function startSingle(qid) {
  const q = BY_ID.get(qid);
  if (!q) return;
  cat = q.cat; year = Number(q.year); fullPaper = false; paperActive = false;   // 單題重做不寫/不清整卷存檔
  graded = false;
  queue = [q]; idx = 0; pick = null; results = []; single = true; view = 'quiz';
  for (const k of Object.keys(trGrades)) delete trGrades[k];
  setSeq++;
}

function groupInfo() {
  const q = queue[idx];
  if (!q || !q.passage) return null;
  let a = idx, b = idx;
  while (a > 0 && queue[a - 1].passage === q.passage) a--;
  while (b < queue.length - 1 && queue[b + 1].passage === q.passage) b++;
  return { pos: idx - a + 1, n: b - a + 1 };
}

// 桌機右側「批改序列」（中譯英背景批改）；>=1100px 才顯示（CSS .grade-queue）
function gradePanel() {
  const entries = queue.map((q) => ({ q, g: trGrades[q.id] })).filter(e => e.g);
  if (!entries.length) return '';
  const pending = entries.filter(e => e.g.status === 'pending').length;
  const rows = entries.map(({ q, g }) => {
    const right = g.status === 'pending' ? '<span style="color:var(--text-tertiary);font-size:11px">批改中…</span>'
      : g.status === 'error' ? '<span style="color:var(--red);font-size:11px">失敗</span>'
      : (() => { const rv = g.out.review || {};
          const avg = (Number(rv.content) + Number(rv.grammar) + Number(rv.natural)) / 3;
          return `<b style="font-size:12px;font-family:var(--mono);color:${TR_OFFICIAL(avg) >= 3 ? 'var(--green)' : 'var(--orange)'}">${TR_OFFICIAL(avg)}/4</b>`; })();
    return `<div style="display:flex;justify-content:space-between;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(q.stem || '').slice(0, 9)}</span>${right}</div>`;
  }).join('');
  return `<aside class="grade-queue" style="position:fixed;right:14px;top:76px;width:238px;max-height:calc(100vh - 120px);overflow:auto;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:12px 14px;box-shadow:var(--shadow-md);z-index:30">
    <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">批改序列${pending ? ` · ${pending} 進行中` : ''}</div>
    ${rows}
  </aside>`;
}

function wrongStats() {
  const byQ = new Map();
  for (const r of loadLog()) {
    const e = byQ.get(r.qid) || { wrong: 0, picks: [], lastOk: true };
    if (!r.ok) {
      e.wrong++;
      const p = r.scores && r.scores.picked;
      if (p) e.picks.push(p);
    }
    e.lastOk = !!r.ok;
    byQ.set(r.qid, e);
  }
  const everWrong = [...byQ.entries()].filter(([, e]) => e.wrong > 0);
  const unresolved = everWrong
    .filter(([, e]) => !e.lastOk)
    .map(([qid, e]) => ({ qid, q: BY_ID.get(qid), ...e }))
    .filter(x => x.q);
  const fixed = everWrong.length - unresolved.length;
  return { unresolved, everWrong: everWrong.length, fixed, rate: everWrong.length ? Math.round(fixed / everWrong.length * 100) : 0 };
}

// ── 視圖 ──
function header(title, backAttr = 'data-home') {
  return `<div class="page-title">
    <button class="btn btn-sm" ${backAttr} style="margin-right:8px">${icon('arrowLeft')} 返回</button>
    ${icon('scrollText')} ${title}
  </div>`;
}

function homeView() {
  const log = loadLog();
  const ws = wrongStats();
  const cards = CATS.map(c => {
    const n = QUESTIONS.filter(q => q.cat === c).length;
    const done = log.filter(r => r.axis === c || (BY_ID.get(r.qid) || {}).cat === c).length;
    return `<button class="btn" data-cat="${c}" style="min-width:150px;padding:14px;text-align:left">
      <div style="font-weight:700;font-size:15px">${c}</div>
      <div style="font-size:11px;opacity:.75">${n} 題${done ? ` · 答過 ${done} 題` : ''}</div>
    </button>`;
  }).join('');
  return `<div class="page-title"><button class="btn btn-sm" data-back="study" style="margin-right:8px">${icon('arrowLeft')} 返回</button>${icon('scrollText')} 學測題庫</div>
    <div class="page-subtitle">97–115 年 · ${ALL.length} 題 · 官方 5 大題 · 整卷依原序作答</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;max-width:640px;margin-left:auto;margin-right:auto">${cards}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;max-width:640px;margin-left:auto;margin-right:auto">
      <button class="btn" data-full style="min-width:150px;padding:14px;text-align:left">
        <div style="font-weight:700;font-size:15px">整卷模考</div>
        <div style="font-size:11px;opacity:.75">一年 ${Math.max(...YEARS.map(y => QUESTIONS.filter(q => Number(q.year) === y).length))} 題全卷（選擇＋中譯英）</div>
      </button>
      <button class="btn ${ws.unresolved.length ? 'btn-primary' : ''}" data-wrong style="min-width:150px;padding:14px;text-align:left">
        <div style="font-weight:700;font-size:15px">錯題本</div>
        <div style="font-size:11px;opacity:.75">${ws.unresolved.length ? `${ws.unresolved.length} 題待補平` : ws.everWrong ? `全部補平（曾錯 ${ws.everWrong}）` : '還沒有錯題'}</div>
      </button>
      <button class="btn" data-stats style="min-width:150px;padding:14px;text-align:left">
        <div style="font-weight:700;font-size:15px">統計</div>
        <div style="font-size:11px;opacity:.75">正確率 · 誘答 · 復原率 · 配分</div>
      </button>
    </div>
    ${log.length ? `<p style="font-size:12px;color:var(--text-tertiary);margin-top:16px">歷次作答 ${log.length} 筆 · 答對 ${log.filter(r => r.ok).length} 筆</p>` : ''}`;
}

function yearView() {
  const inScope = (q) => fullPaper || q.cat === cat;
  const matchLog = (r) => {
    const q = BY_ID.get(r.qid);
    return q && inScope(q) && (q.cat === r.axis || fullPaper || r.axis === cat);
  };
  const ys = [...new Set(QUESTIONS.filter(inScope).map(q => Number(q.year)))].sort((a, b) => a - b);
  const log = loadLog();
  const rows = ys.map(y => {
    const mine = log.filter(r => yearOf(r.qid) === y && matchLog(r));
    const total = QUESTIONS.filter(q => inScope(q) && Number(q.year) === y).length;
    return `<button class="btn" data-year="${y}" style="min-width:86px">${y} 年<br><span style="font-size:11px;opacity:.7">${total} 題${mine.length ? ` · ${mine.filter(r => r.ok).length}/${mine.length}` : ''}</span></button>`;
  }).join('');
  const title = fullPaper ? '整卷模考' : cat;
  const sub = fullPaper
    ? '選年份：該年全卷（所有大題依原卷順序）'
    : '選年份開始作答（依原卷順序、題組不拆）';
  return `${header(title)}
    <div class="page-subtitle">${sub}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;max-width:640px;margin-left:auto;margin-right:auto">${rows}</div>`;
}

function resumeBarHtml() {
  if (!fullPaper) return '';
  if (graded) return `<p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">本卷已批改 · <button class="btn btn-sm" data-abandon style="padding:2px 8px;font-size:11px">放棄這卷（清除報告）</button></p>`;
  return `<p style="font-size:12px;color:var(--text-tertiary);margin:0 0 10px">${resumed ? `已恢復上次進度（第 ${idx + 1} 題） · ` : ''}<button class="btn btn-sm" data-abandon style="padding:2px 8px;font-size:11px">放棄這卷</button></p>`;
}

// ── 整卷導航：上/下一題自由走（非整卷走各自的原按鈕）──
function prevBtn() { return fullPaper && idx > 0 ? `<button class="btn" data-prev>上一題</button>` : ''; }
function nextBtn() { return fullPaper && idx < queue.length - 1 ? `<button class="btn" data-next>下一題</button>` : ''; }
function submitBtn() {
  if (!fullPaper) return '';
  const done = queue.every((_, i) => results[i]);
  return done ? `<button class="btn btn-primary" data-submit style="margin-top:14px">全部作答完成（${queue.length} 題）· 交卷對答案</button>` : '';
}
const navHtml = () => `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">${prevBtn()}${nextBtn()}</div>`;

function trQuestionView(q) {
  const g = trGrades[q.id];
  const title = fullPaper ? `${year} 年 · 整卷模考` : single ? '錯題重做' : `${cat} · ${year} 年`;
  const last = idx + 1 >= queue.length;
  const nextLabel = fullPaper ? '下一題' : last ? '看結果' : '下一題';
  return `${header(title, single ? 'data-wrong' : 'data-home')}
    <div style="max-width:720px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:22px;margin-top:12px;margin-left:auto;margin-right:auto">
      ${resumeBarHtml()}
      ${keyHintTr}
      <div style="font-size:12px;color:var(--text-tertiary);display:flex;justify-content:space-between;align-items:center;gap:4px 10px"><span>${q.cat} · ${q.year} 年 · 配分 ${q.w} 分${g ? ` · ${g.status === 'pending' ? '批改中…' : g.status === 'done' ? '已批改' : '批改失敗'}` : ''}</span>${timerHtml()}</div>
      <div style="font-size:16px;color:var(--text-primary);margin:8px 0 14px;line-height:1.8">${q.stem || ''}</div>
      <textarea id="gsatTrInput" data-qid="${q.id}" rows="3" placeholder="寫出你的英文譯文…" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-elevated);color:var(--text-primary);font-size:15px;line-height:1.6;resize:vertical">${drafts[q.id] ?? trGrades[q.id]?.text ?? ''}</textarea>
      <button class="btn btn-primary" data-ggrade style="margin-top:12px">送出（背景批改）並${nextLabel}</button>
      ${fullPaper ? `<p style="font-size:12px;color:var(--text-tertiary);margin-top:8px">依設定的 LLM 端點評分；不等批改、直接下一題（Ctrl+Enter 送出）</p>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">${prevBtn()}</div>${submitBtn()}` : `<p style="font-size:12px;color:var(--text-tertiary);margin-top:8px">依設定的 LLM 端點評分；不等批改、直接下一題（Ctrl+Enter 送出）</p>`}
    </div>
    ${gradePanel()}`;
}

// 文意選填大題：10 空一次填完再批改（逐題作答會被消去法反推下一題答案）
function groupFillView(q, gi) {
  const start = idx;
  const members = queue.slice(start, start + gi.n);
  // 非整卷＝交卷即批；整卷只存答案，交卷才對
  const graded = !fullPaper && members.every((m, k) => results[start + k] && typeof results[start + k].ok === 'boolean');
  const title = fullPaper ? `${year} 年 · 整卷模考` : single ? '錯題重做' : `${cat} · ${year} 年`;
  const last = start + gi.n >= queue.length;
  const rows = members.map((m, k) => {
    const r = graded ? results[start + k] : null;
    const cur = results[start + k]?.picked || '';
    const ans = (m.options || []).find(o => o[0] === m.answer);
    const optText = (key) => ((m.options || []).find(o => o[0] === key) || [key, ''])[1];
    // 自訂下拉浮層（替代原生 select）：點主鈕開選單、點選項即存
    const dd = `<div class="gsat-dd" data-gsel="${k}" data-value="${cur}">
      <button type="button" class="gsat-dd-btn"><span class="gsat-dd-val">${cur ? `${cur}. ${optText(cur)}` : '—'}</span></button>
      <div class="gsat-dd-menu" hidden>
        <button type="button" class="gsat-dd-opt${cur ? '' : ' on'}" data-v="">—</button>
        ${(m.options || []).map(([key, text]) => `<button type="button" class="gsat-dd-opt${cur === key ? ' on' : ''}" data-v="${key}"><b>${key}.</b> ${text}${cur === key ? '<span class="gsat-dd-check">✓</span>' : ''}</button>`).join('')}
      </div></div>`;
    const right = graded
      ? `<span style="font-size:13px;white-space:nowrap;color:${r?.ok ? 'var(--green)' : 'var(--red)'}">${r?.picked || '未答'}${r?.ok ? ' ✓' : ` ✗ → ${m.answer}. ${ans?.[1] || ''}`}</span>`
      : dd;
    return `<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--border)">
      <b style="color:var(--text-secondary);min-width:22px;font-size:13px">${m.no}</b>
      <div style="flex:1;font-size:14px;line-height:1.7;color:var(--text-primary)">${stemHtml(m)}</div>
      ${right}</div>`;
  }).join('');
  return `${header(title, single ? 'data-wrong' : 'data-home')}
    <div style="max-width:720px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:22px;margin-top:12px;margin-left:auto;margin-right:auto">
      ${resumeBarHtml()}
      <div style="font-size:12px;color:var(--text-tertiary);display:flex;justify-content:space-between;align-items:center;gap:4px 10px"><span>${q.cat} · ${q.year} 年 · 題組 ${gi.pos}/${gi.n} · ${graded ? '已批改' : fullPaper ? '一次填完 · 整卷交卷才對答案' : '一次填完再交卷'}</span>${timerHtml()}</div>
      ${keyHint}
      ${q.passage ? `<div style="max-height:260px;overflow:auto;border:1px dashed var(--border);border-radius:var(--r-md);padding:12px;margin:10px 0;font-size:14px;line-height:1.8;color:var(--text-secondary);white-space:pre-wrap">${passageShown(start)}</div>` : ''}
      ${rows}
      ${fullPaper
        ? `${navHtml()}${submitBtn()}`
        : graded
          ? `<button class="btn btn-primary" data-next style="margin-top:14px">${last ? '看結果' : '下一題'}</button>`
          : `<button class="btn btn-primary" data-gsubmit style="margin-top:14px">交卷（${gi.n} 題一起批改）</button>`}
    </div>
    ${gradePanel()}`;
}

function questionView() {
  // 上一題/還原可能落在題組中段 → 拉回組首（groupFillView 以 idx 為組首）
  let early = groupInfo();
  if (early && early.pos > 1) { idx -= early.pos - 1; early = groupInfo(); }
  const q = queue[idx];
  if (q.type === 'translate') return trQuestionView(q);
  const g = early;
  if (g && g.n > 1) return groupFillView(q, g);   // 規則：同題組子題一起答、一起批（文選/綜合/閱讀）
  // 整卷：選取只記答案、不即時對（交卷才判）→ 無綠紅/無答對答錯、可改答
  const answered = fullPaper ? results[idx] != null : pick != null;
  const cur = fullPaper ? results[idx]?.picked : pick;
  const feedback = !fullPaper && answered;
  // 文意選填：10 單字共用選項庫 → 橫排 chips（單字配對）；其餘大題 4-5 個 → 直排大按鈕
  const bank = (q.options || []).length >= 10;
  const styleOf = (key) => {
    const hit = feedback && (key === q.answer || key === cur);
    const sel = answered && key === cur;
    const bg = hit ? (key === q.answer ? 'var(--green)' : 'var(--red)') : 'var(--bg-elevated)';
    const fg = hit ? '#fff' : 'var(--text-primary)';
    if (!feedback && sel) return `border:2px solid var(--cyan);background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;`;
    return `border:1px solid ${hit ? bg : 'var(--border)'};background:${bg};color:${fg};cursor:${feedback ? 'default' : 'pointer'};`;
  };
  const dis = !fullPaper && answered ? 'disabled' : '';   // 非整卷答了鎖定；整卷可改答
  const opts = bank
    ? `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px">${(q.options || []).map(([key, text]) =>
        `<button data-pick="${key}" ${dis} style="${styleOf(key)}border-radius:var(--r-md);padding:7px 11px;font-size:14px;white-space:nowrap"><b style="margin-right:5px">${key}.</b>${text}</button>`).join('')}</div>`
    : (q.options || []).map(([key, text]) =>
        `<button data-pick="${key}" ${dis} style="${styleOf(key)}display:block;width:100%;text-align:left;border-radius:var(--r-md);padding:9px 13px;margin-bottom:8px;font-size:14px"><b style="margin-right:8px">${key}.</b>${text}</button>`).join('');

  const title = single ? '錯題重做' : fullPaper ? `${year} 年 · 整卷模考` : `${cat} · ${year} 年`;
  const prog = single
    ? `錯題重做 · 1 題`
    : `第 ${idx + 1}/${queue.length} 題 · ${q.cat}${g ? ` · 題組 ${g.pos}/${g.n}` : ''}`;
  const resumeBar = resumeBarHtml();

  return `${header(title, single ? 'data-wrong' : 'data-home')}
    <div style="max-width:720px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:22px;margin-top:12px;margin-left:auto;margin-right:auto">
      ${resumeBar}
      ${keyHint}
      <div style="font-size:12px;color:var(--text-tertiary);display:flex;justify-content:space-between;align-items:center;gap:4px 10px"><span>${prog} · 配分 ${q.w} 分</span>${timerHtml()}</div>
      ${q.passage ? `<div style="max-height:220px;overflow:auto;border:1px dashed var(--border);border-radius:var(--r-md);padding:12px;margin:10px 0;font-size:14px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${passageShown(idx)}</div>` : ''}
      <div style="font-size:16px;color:var(--text-primary);margin:8px 0 14px;line-height:1.7">${stemHtml(q)}</div>
      ${opts}
      ${feedback && cur === q.answer ? `<p style="font-size:13px;color:var(--green);margin:10px 0 0">答對</p>` : ''}
      ${feedback && cur !== q.answer ? `<p style="font-size:13px;color:var(--red);margin:10px 0 0">答錯 · 正解 ${q.answer}</p>` : ''}
      ${fullPaper
        ? `${navHtml()}${submitBtn()}`
        : answered ? `<button class="btn btn-primary" data-next style="margin-top:14px">${idx + 1 >= queue.length ? '看結果' : '下一題'}</button>` : ''}
    </div>
    ${gradePanel()}`;
}

// 中譯英批改結果卡（結果頁用；pending 會隨批改完成自動回填）
function trCardsHtml() {
  const items = queue.filter(q => q.type === 'translate');
  if (!items.length) return '';
  const cards = items.map((q) => {
    const g = trGrades[q.id];
    const head = `<div style="font-size:12px;color:var(--text-tertiary)">中譯英 · ${q.year} 年 · 配分 ${q.w} 分</div>
      <div style="font-size:13px;color:var(--text-primary);margin-top:4px">${q.stem}</div>`;
    if (!g) {
      return `<div style="border:1px dashed var(--border);border-radius:var(--r-md);padding:12px 14px;margin-top:10px">${head}
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:6px">批改狀態未保留（可由錯題本重做）</div></div>`;
    }
    if (g.status === 'pending') {
      return `<div style="border:1px dashed var(--border);border-radius:var(--r-md);padding:12px 14px;margin-top:10px">${head}
        <div style="font-size:13px;color:var(--text-tertiary);margin-top:6px">批改中…（完成自動出現）</div></div>`;
    }
    if (g.status === 'error') {
      return `<div style="border:1px solid var(--red);border-radius:var(--r-md);padding:12px 14px;margin-top:10px">${head}
        <div style="font-size:13px;color:var(--red);margin-top:6px">批改失敗：${g.err}</div></div>`;
    }
    const rv = g.out.review || {};
    const avg = (Number(rv.content) + Number(rv.grammar) + Number(rv.natural)) / 3;
    const keys = [['content', '內容'], ['grammar', '文法'], ['natural', '通順']];
    return `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:12px 14px;margin-top:10px;background:var(--bg-surface)">${head}
      <div style="font-size:13px;color:var(--text-secondary);border-left:3px solid var(--border);padding-left:10px;margin:8px 0">你的答案：${g.text}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
        ${keys.map(([k, label]) => `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;text-align:center;min-width:96px">
          <div style="font-size:17px;font-weight:700;font-family:var(--mono)">${rv[k] != null ? Number(rv[k]).toFixed(2) : '—'}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">${label} 0–100</div>
        </div>`).join('')}
        <div style="border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;text-align:center;min-width:96px;background:var(--bg-elevated)">
          <div style="font-size:17px;font-weight:700;font-family:var(--mono)">${TR_OFFICIAL(avg)}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">官方換算 /4</div>
        </div>
      </div>
      ${g.out.corrected ? `<div style="border-left:3px solid var(--green);background:var(--bg-elevated);border-radius:var(--r-md);padding:9px 12px;margin:8px 0;font-size:14px;line-height:1.7;color:var(--text-primary)"><b style="font-size:12px;color:var(--green)">訂正</b><br>${g.out.corrected}</div>` : ''}
      ${(g.out.suggestions || []).length ? `<div style="margin:8px 0"><b style="font-size:13px;color:var(--text-primary)">修改建議</b><ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--text-secondary);line-height:1.7">${g.out.suggestions.map(x => `<li><b style="color:var(--text-primary)">${x.what || ''}</b>${x.why ? `<br><span style="color:var(--text-tertiary)">緣由：${x.why}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${g.out.comment ? `<p style="font-size:13px;color:var(--text-primary);line-height:1.7;margin:4px 0">${g.out.comment}</p>` : ''}
    </div>`;
  }).join('');
  return `<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:16px">中譯英批改</div>${cards}`;
}

// 中譯英：送出即前進，批改在背景跑
function ggrade() {
  const q = queue[idx];
  const text = (document.getElementById('gsatTrInput')?.value || '').trim();
  if (!text) { toast('先寫出你的譯文', 'toast-error'); return; }
  const seq = setSeq;
  trGrades[q.id] = { status: 'pending', text };
  saveTr(q.id, { status: 'pending', text });
  results[idx] = { qid: q.id, ok: false, picked: null, tr: true };   // 對齊佇列（整卷可回頭改答）
  pick = null;
  idx++;
  if (fullPaper) idx = Math.min(idx, queue.length - 1);   // 整卷：停在最後一題等交卷（不進結果頁）
  else if (idx >= queue.length) view = 'result';
  reRender();

  const body = gsatTrPromptRaw + '\n\n【題目】\nid=' + q.id +
    '\n中文：' + q.stem + '\n學生譯文：' + text +
    '\n\n（共 1 題。回覆最後附一個 ```json code block。）';
  const st = storeRef;
  const baseUrl = ((st?.state?.llmApiUrl || '').trim() || 'http://localhost:11434')
    .replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
  // 走 messages（chat 路徑）＝240/300s 限時；單輪只有 60s。qwen3 實測 154–203s 必爆（thinking 太慢），
  // 預設改 qwen2.5:14b：完整 prompt 實測 5s，單輪 60s 都綽綽有餘；模型要更好的 → 設定頁自選。
  fetchLLM(`${baseUrl}/api/generate`, st?.state?.llmModel || 'qwen2.5:14b', body, undefined, [{ role: 'user', content: body }])
    .then((raw2) => {
      const parsed = parseLLMJson(raw2);
      if (!parsed || !parsed.results || !parsed.results[0]) throw new Error('回應裡找不到批改 JSON');
      const out = parsed.results[0];
      const rv = out.review || {};
      const avg = (Number(rv.content) + Number(rv.grammar) + Number(rv.natural)) / 3;
      const ok = avg >= 80;
      const off = TR_OFFICIAL(avg);
      logPractice('gsat', { qid: q.id, mode: 'tr', axis: '中譯英', ok, scores: { review: rv, official: off } });
      const i = results.findIndex(r => r && r.qid === q.id);
      if (i >= 0) results[i].ok = ok;
      saveTr(q.id, { status: 'done', out, text });   // 歷史永遠入庫
      if (seq === setSeq) {
        trGrades[q.id] = { status: 'done', out, text };
        toast(`中譯英批改完成：官方 ${off}/4`, 'toast-success');
      }
    })
    .catch((e) => {
      const msg = e?.message || String(e);
      saveTr(q.id, { status: 'error', err: msg, text });
      if (seq === setSeq) trGrades[q.id] = { status: 'error', err: msg, text };
      console.error('[gsat-tr]', e);
      toast('批改失敗：' + msg, 'toast-error');
    })
    .finally(() => { if (seq === setSeq) reRender(); });
}

// ── 整卷交卷：全部作答完才對答案（MC 現算入帳；中譯英吃背景批改結果）──
function gradePaper() {
  if (!fullPaper) return;
  if (!queue.every((_, i) => results[i])) { toast('還有題目沒作答', 'toast-error'); return; }
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    const r = results[i];
    if (q.type === 'translate') {
      const g = trGrades[q.id];
      if (g?.status === 'done') {
        const rv = g.out.review || {};
        r.ok = (Number(rv.content) + Number(rv.grammar) + Number(rv.natural)) / 3 >= 80;
      }   // pending/error → ok 保持 false，結果頁標「批改中」不計配分；入帳由 ggrade 回呼負責
    } else {
      r.ok = r.picked === q.answer;
      logPractice('gsat', { qid: q.id, mode: 'mc', axis: q.cat, ok: r.ok, scores: { picked: r.picked, year: q.year, no: q.no } });
    }
  }
  graded = true;
  resumed = false;
  timerPause();
  view = 'result';
  saveProgress();
  reRender();
}

function resultView() {
  const trPending = (q) => q.type === 'translate' && trGrades[q.id]?.status === 'pending';
  const trErr = (q) => q.type === 'translate' && trGrades[q.id]?.status === 'error';
  const pendingN = fullPaper ? queue.filter(trPending).length : 0;
  const errN = fullPaper ? queue.filter(trErr).length : 0;
  const ok = results.filter(r => r && r.ok).length;
  const total = fullPaper ? queue.length : results.length;
  const scoreW = results.filter(r => r && r.ok).reduce((s, r) => s + (BY_ID.get(r.qid)?.w || 0), 0);
  // 批改中/批改失敗的中譯英不計配分（還沒成績）→ 從分母剔除，批完自動回來
  const totalW = queue.reduce((s, q) => s + (fullPaper && (trPending(q) || trErr(q)) ? 0 : q.w), 0);
  const wrongList = results.filter(r => r && !r.ok && BY_ID.get(r.qid)?.type !== 'translate').map(r => {
    const q = BY_ID.get(r.qid);
    return `<li style="margin-bottom:8px;font-size:13px;line-height:1.6">
      <b style="color:var(--text-primary)">${q.no}.</b> ${stemHtml(q)}
      <span style="color:var(--text-tertiary)">（你選 ${r.picked || '未答'} · 正解 ${q.answer}）</span>
    </li>`;
  }).join('');
  const title = single ? '錯題重做 · 結果' : fullPaper ? `${year} 年整卷 · 完成` : `${cat} · ${year} 年 · 完成`;
  const wrongTitle = fullPaper ? `${year} 年整卷錯題報告` : '錯題';
  return `${header(title, single ? 'data-wrong' : 'data-home')}
    <div style="max-width:640px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;margin-top:12px;margin-left:auto;margin-right:auto">
      ${resumeBarHtml()}
      <div style="font-size:40px;font-weight:700;font-family:var(--mono)">${ok}/${total}</div>
      <div style="font-size:13px;color:var(--text-tertiary);display:flex;justify-content:space-between;align-items:center;gap:4px 10px;flex-wrap:wrap"><span>答對題數 · 配分 ${totalW} 分 → 你得 ${scoreW} 分${totalW ? `（${Math.round(scoreW / totalW * 100)}%）` : ''}</span>${fullPaper ? `<span class="gsat-timer" style="flex-shrink:0">${icon('clock', 13)}用時 ${fmtTimer(timerMs())}</span>` : ''}</div>
      ${pendingN ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${pendingN} 題中譯英批改中…（完成自動計分）</div>` : ''}
      ${errN ? `<div style="font-size:12px;color:var(--red);margin-top:4px">${errN} 題中譯英批改失敗（見下方批改卡，不計配分）</div>` : ''}
      ${trCardsHtml()}
      ${wrongList ? `<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:16px">${wrongTitle}</div>
        <ul style="margin:8px 0 0;padding-left:20px;color:var(--text-secondary)">${wrongList}</ul>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">
        ${single ? '<button class="btn" data-wrong>回錯題本</button>' : `<button class="btn" data-restart>再戰此卷</button>
        <button class="btn" data-wrong>錯題本</button>
        <button class="btn" data-stats>統計</button>`}
        <button class="btn" data-home>回首頁</button>
      </div>
    </div>`;
}

// 錯題弱點分析（純本地統計，免 LLM）：密度雷達／近期趨勢／復原死角／弱文章／重複釘子戶／選項傾向
function weaknessBlock() {
  const log = loadLog();
  if (log.length < 5) return '';
  const catOfRow = (r) => (r.axis && CATS.includes(r.axis)) ? r.axis : (BY_ID.get(r.qid) || {}).cat || catOf(r.axis || '');
  const perCat = {};
  for (const r of log) {
    const c = catOfRow(r);
    if (!c) continue;
    (perCat[c] ||= { n: 0, wrong: 0 });
    perCat[c].n++;
    if (!r.ok) perCat[c].wrong++;
  }

  // 1) 各大題錯題密度（錯/作答 → 只看做過的，比總正確率乾淨）
  const radar = CATS.filter(c => perCat[c]).map(c => ({ label: c, value: Math.round(perCat[c].wrong / perCat[c].n * 100) }));

  // 2) 近期趨勢：最近 30 筆 vs 更早
  const n = log.length, tail = log.slice(-30), head = log.slice(0, n - 30);
  const rate = (arr) => arr.length ? Math.round(arr.filter(r => r.ok).length / arr.length * 100) : null;
  const recent = rate(tail), before = rate(head);
  const trend = (recent != null && before != null)
    ? `近 ${tail.length} 題 <b>${recent}%</b>（此前 ${before}%）${recent >= before ? '↑ 進步中' : '↓ 退步了'}`
    : '';

  // 3) 復原死角：各大題未補平數
  const ws = wrongStats();
  const stuck = CATS.map(c => [c, ws.unresolved.filter(x => x.q.cat === c).length]).filter(([, v]) => v > 0);
  const stuckLine = stuck.length ? stuck.map(([c, v]) => `${c} ${v} 題`).join(' · ') : '';

  // 4) 弱文章 Top5：錯題依 passage 聚合
  const byPass = {};
  for (const r of log) {
    if (r.ok) continue;
    const q = BY_ID.get(r.qid);
    if (!q || !q.passage) continue;
    const k = q.passage;
    (byPass[k] ||= { n: 0, year: q.year, cat: q.cat });
    byPass[k].n++;
  }
  const weakPass = Object.entries(byPass).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([pass, e]) => `<li>${pass.slice(0, 42).replace(/\s+/g, ' ')}… <span style="color:var(--text-tertiary)">（${e.year}·${e.cat}，錯 ${e.n}）</span></li>`).join('');

  // 5) 重複釘子戶：同題錯 ≥2（不論是否已補平）
  const wrongTimes = {};
  for (const r of log) if (!r.ok) wrongTimes[r.qid] = (wrongTimes[r.qid] || 0) + 1;
  const nails = Object.entries(wrongTimes).filter(([, v]) => v >= 2);
  const nailLine = nails.length ? `同題錯 ≥2 次：<b>${nails.length} 題</b>（列表下方標「釘子」）` : '';

  // 6) 選項傾向：各大題答錯時最常選的字母（選填題字母=字彙庫位置，僅同篇內可比 → 標明僅供參考）
  const pickTrend = {};
  for (const r of log) {
    if (r.ok || !r.scores || !r.scores.picked) continue;
    const c = catOfRow(r);
    const k = `${c}|${r.scores.picked}`;
    pickTrend[k] = (pickTrend[k] || 0) + 1;
  }
  const pickLine = CATS.map(c => {
    const entries = Object.entries(pickTrend).filter(([k]) => k.startsWith(c + '|')).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    const [key, cnt] = entries[0];
    return `${c} 最常誤選 <b>${key.split('|')[1]}</b>（${cnt} 次）`;
  }).filter(Boolean).join('；');

  return `<div style="max-width:720px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:18px;margin-top:12px;margin-left:auto;margin-right:auto">
    <div style="font-size:13px;font-weight:600;color:var(--text-primary)">弱點分析</div>
    ${radarChart(radar, { max: 100, size: 250, color: 'var(--red)' })}
    <div style="font-size:12px;color:var(--text-tertiary);text-align:center;margin-bottom:8px">各大題錯題密度（錯/作答 %）</div>
    ${trend ? `<p style="font-size:13px;color:var(--text-secondary);margin:6px 0">${trend}</p>` : ''}
    ${stuckLine ? `<p style="font-size:13px;color:var(--text-secondary);margin:6px 0">未補平分佈：${stuckLine}</p>` : ''}
    ${nailLine ? `<p style="font-size:13px;color:var(--text-secondary);margin:6px 0">${nailLine}</p>` : ''}
    ${pickLine ? `<p style="font-size:12px;color:var(--text-tertiary);margin:6px 0">選項傾向：${pickLine}（選填題字母僅同篇文章內可比）</p>` : ''}
    ${weakPass ? `<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-top:8px">最常錯的文章</div>
      <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--text-secondary);line-height:1.7">${weakPass}</ul>` : ''}
  </div>`;
}

function wrongView() {
  const ws = wrongStats();
  const rows = ws.unresolved.map(x => {
    const picks = (x.wrong >= 2 ? '釘子 · ' : '') + (x.picks.length ? `錯 ${x.wrong} 次（選 ${x.picks.join('、')}）` : `錯 ${x.wrong} 次`);
    return `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:12px 14px;margin-bottom:8px;background:var(--bg-surface)">
      <div style="font-size:11px;color:var(--text-tertiary)">${x.q.cat} · ${x.q.year} 年 · 第 ${x.q.no} 題 · ${picks} · 正解 ${x.q.answer}</div>
      <div style="font-size:14px;color:var(--text-primary);margin:4px 0 8px;line-height:1.6">${stemHtml(x.q)}</div>
      <button class="btn btn-sm" data-retry="${x.qid}">重做這題</button>
    </div>`;
  }).join('');
  return `${header('錯題本')}
    <div class="page-subtitle">未補平 ${ws.unresolved.length} 題 · 曾錯 ${ws.everWrong} 題 · 已補平 ${ws.fixed}（復原率 ${ws.rate}%）</div>
    ${weaknessBlock()}
    <div style="max-width:720px;margin-top:14px;margin-left:auto;margin-right:auto">${rows || '<p style="color:var(--text-tertiary);font-size:14px">沒有待補平的錯題</p>'}</div>`;
}

function statsView() {
  const log = loadLog();
  if (!log.length) return `${header('統計')}<p style="color:var(--text-tertiary);margin-top:20px">還沒有作答紀錄</p>`;

  // A1a：五大題正確率（雷達）
  const perCat = {};
  for (const r of log) {
    const c = r.axis && CATS.includes(r.axis) ? r.axis : (BY_ID.get(r.qid) || {}).cat || catOf(r.axis || '');
    (perCat[c] ||= { n: 0, ok: 0 });
    perCat[c].n++; if (r.ok) perCat[c].ok++;
  }
  const radar = CATS.filter(c => perCat[c]).map(c => ({ label: c, value: Math.round(perCat[c].ok / perCat[c].n * 100) }));

  // A1b：逐年正確率（折線）
  const perYear = {};
  for (const r of log) {
    const y = yearOf(r.qid);
    (perYear[y] ||= { n: 0, ok: 0 });
    perYear[y].n++; if (r.ok) perYear[y].ok++;
  }
  const line = Object.keys(perYear).map(Number).sort((a, b) => a - b)
    .map(y => ({ label: `${y}`, value: Math.round(perYear[y].ok / perYear[y].n * 100) }));

  // A2：答錯時選到的字母分佈
  const wrongPicks = {};
  for (const r of log) if (!r.ok && r.scores && r.scores.picked) wrongPicks[r.scores.picked] = (wrongPicks[r.scores.picked] || 0) + 1;
  const bars = Object.keys(wrongPicks).sort().map(k => ({ label: k, value: wrongPicks[k] }));

  // A3：復原率
  const ws = wrongStats();

  // A4：模考估計（已答正確率 × 該年配分；未作答部分假設相同水準 → 估計）
  const est = Object.keys(perYear).map(Number).sort((a, b) => a - b).map(y => {
    const rate = perYear[y].ok / perYear[y].n;
    const total = YEAR_TOTAL[y] || 72;
    const estScore = Math.round(rate * total * 10) / 10;
    return `${y} 年：已答 ${perYear[y].n} 題，正確率 ${Math.round(rate * 100)}% → 估計 ${estScore}/${total} 分`;
  });

  return `${header('統計')}
    <div style="max-width:640px;margin-left:auto;margin-right:auto">
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:8px">五大題正確率</div>
      ${radarChart(radar, { max: 100, size: 280, color: 'var(--cyan)' })}
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:14px">逐年正確率</div>
      ${lineChart(line, { min: 0, max: 100, height: 120, color: 'var(--green)', xLabels: true, fmt: v => v + '%' })}
      ${bars.length ? `<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:14px">答錯時選到的選項（誘答分佈）</div>
      ${barChart(bars, { height: 110, color: 'var(--red)' })}` : ''}
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:14px">錯題復原率</div>
      <p style="font-size:14px;color:var(--text-secondary);margin:6px 0 0">曾錯 ${ws.everWrong} 題 · 已補平 ${ws.fixed} 題 · 復原率 <b>${ws.rate}%</b></p>
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:14px">模考估計總分（依官方配分加權）</div>
      <ul style="margin:6px 0 0;padding-left:20px;font-size:13px;color:var(--text-secondary);line-height:1.8">${est.map(e => `<li>${e}</li>`).join('')}</ul>
      <p style="font-size:11px;color:var(--text-tertiary);margin-top:6px">估計 = 已答正確率 × 該年配分（未作答部分假設同一水準）；非正式成績</p>
    </div>`;
}

export function render() {
  const body = (() => {
    switch (view) {
      case 'year': return yearView();
      case 'quiz': return idx >= queue.length ? resultView() : questionView();
      case 'result': return resultView();
      case 'wrong': return wrongView();
      case 'stats': return statsView();
      default: return homeView();
    }
  })();
  return `<span data-page="gsat" data-gsid="${GID}" hidden></span>${body}`;
}

function reRender() {
  const el = document.getElementById('pageContainer');
  if (!el || !el.querySelector('[data-page="gsat"]')) return;   // 已導去別頁 → 批改回呼不准蓋掉別的頁
  const onQuiz = view === 'quiz' && paperActive;
  if (onQuiz) { if (!timerMark) timerMark = Date.now(); }
  else { timerPause(); if (timerInt) { clearInterval(timerInt); timerInt = null; } }   // 離開作答頁停錶＋收計時器
  const ti = document.getElementById('gsatTrInput');
  // 草稿按 DOM 自帶的 qid 收（idx 可能已換題）→ prev/next 換題回頭都不丟
  if (ti?.dataset.qid) drafts[ti.dataset.qid] = ti.value;
  el.innerHTML = render();
  mountBindings();
  saveProgress();
}

function mountBindings() {
  document.querySelectorAll('[data-back]').forEach(el =>
    el.addEventListener('click', () => storeRef?.actions.navigate(el.dataset.back)));
  document.querySelectorAll('[data-home]').forEach(el =>
    el.addEventListener('click', () => { view = 'home'; reRender(); }));
  document.querySelectorAll('[data-cat]').forEach(el =>
    el.addEventListener('click', () => { cat = el.dataset.cat; fullPaper = false; view = 'year'; reRender(); }));
  document.querySelectorAll('[data-full]').forEach(el =>
    el.addEventListener('click', () => { fullPaper = true; view = 'year'; reRender(); }));
  document.querySelectorAll('[data-year]').forEach(el =>
    el.addEventListener('click', () => { startPaper(Number(el.dataset.year), fullPaper).then(ok => { if (ok !== false) reRender(); }); }));
  document.querySelectorAll('[data-restart]').forEach(el =>
    el.addEventListener('click', () => {
      if (fullPaper) clearProgress();   // 再戰＝主動放棄舊存檔/報告，重開新一卷
      startPaper(year, fullPaper).then(ok => { if (ok !== false) reRender(); });
    }));
  document.querySelectorAll('[data-wrong]').forEach(el =>
    el.addEventListener('click', () => { view = 'wrong'; reRender(); }));
  document.querySelectorAll('[data-stats]').forEach(el =>
    el.addEventListener('click', () => { view = 'stats'; reRender(); }));
  document.querySelectorAll('[data-retry]').forEach(el =>
    el.addEventListener('click', () => { startSingle(el.dataset.retry); reRender(); }));
  document.querySelectorAll('[data-abandon]').forEach(el =>
    el.addEventListener('click', () => {
      clearProgress();
      resumed = false; queue = []; idx = 0; pick = null; results = []; view = 'home'; paperActive = false;
      graded = false; timerAcc = 0; timerMark = 0;
      reRender();
    }));
  document.querySelector('[data-ggrade]')?.addEventListener('click', ggrade);
  // 中譯英頁進場自動 focus：免滑鼠直接打字
  const trTi = document.getElementById('gsatTrInput');
  if (trTi && document.activeElement !== trTi) trTi.focus();
  document.querySelectorAll('[data-gsubmit]').forEach(el =>
    el.addEventListener('click', () => {
      const g = groupInfo();
      if (!g || (results[idx] && typeof results[idx].ok === 'boolean')) return;   // 不變式：已批過不重送
      let blank = 0;
      for (let k = 0; k < g.n; k++) if (!results[idx + k]?.picked) blank++;
      if (blank) { toast(`還有 ${blank} 空沒填`, 'toast-error'); return; }
      resumed = false;
      for (let k = 0; k < g.n; k++) {
        const m = queue[idx + k];
        const picked = results[idx + k].picked;
        const ok = picked === m.answer;
        results[idx + k] = { qid: m.id, ok, picked };
        logPractice('gsat', { qid: m.id, mode: 'mc', axis: m.cat, ok, scores: { picked, year: m.year, no: m.no } });
      }
      pick = null;
      reRender();
    }));
  // 自訂下拉浮層：主鈕開合菜單（點外部關）；點選項即存答案
  document.querySelectorAll('.gsat-dd-btn').forEach(btn =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const open = menu && !menu.hidden;
      document.querySelectorAll('.gsat-dd-menu').forEach(m => { m.hidden = true; });
      if (menu && !open) menu.hidden = false;
    }));
  document.querySelectorAll('.gsat-dd-opt').forEach(opt =>
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = opt.closest('.gsat-dd');
      const k = +dd.dataset.gsel;
      const m = queue[idx + k];
      if (!m) return;
      resumed = false;
      results[idx + k] = { qid: m.id, picked: opt.dataset.v };   // 整卷/非整卷同路徑：先存答案，gsubmit/交卷才判
      reRender();
    }));
  document.querySelectorAll('[data-pick]').forEach(el =>
    el.addEventListener('click', () => {
      resumed = false;
      const q = queue[idx];
      pick = el.dataset.pick;
      if (fullPaper) {
        results[idx] = { qid: q.id, picked: pick };   // 整卷：不即時對答案、不入統計
      } else {
        const ok = pick === q.answer;
        results[idx] = { qid: q.id, ok, picked: pick };
        logPractice('gsat', { qid: q.id, mode: 'mc', axis: q.cat, ok, scores: { picked: pick, year: q.year, no: q.no } });
      }
      reRender();
    }));
  document.querySelectorAll('[data-prev]').forEach(el =>
    el.addEventListener('click', () => {
      resumed = false;
      idx = Math.max(0, idx - 1);   // 落在題組中段 → questionView 拉回組首
      pick = results[idx] ? results[idx].picked : null;
      reRender();
    }));
  document.querySelectorAll('[data-next]').forEach(el =>
    el.addEventListener('click', () => {
      resumed = false;
      const g = groupInfo();
      idx += g && g.n > 1 ? g.n : 1;   // 題組整組跳過（子題一起答 → 一起過）
      pick = null;
      if (idx >= queue.length) {
        if (fullPaper) idx = queue.length - 1;   // 整卷：停在最後一題，等交卷
        else view = 'result';
      }
      reRender();
    }));
  document.querySelectorAll('[data-submit]').forEach(el =>
    el.addEventListener('click', gradePaper));
  // 計時器：作答中每秒刷新（離開 view 由 reRender 停錶）
  if (view === 'quiz' && fullPaper && !timerInt) {
    timerInt = setInterval(() => {
      const el = document.getElementById('paperTimer');
      if (el) el.textContent = fmtTimer(timerMs());
    }, 1000);
    timerInt.unref?.();   // Node 測試不被拖住
  }
}

// ── 快捷鍵：數字/字母選答 · 題組字母直填 · ←→ 上下題 · Enter 下一題/交卷 · Ctrl+Enter 送 tr · Esc 首頁 ──
function onKey(e) {
  if (!isMine()) return;   // 多實例殘留 listener：不是自己 render 的頁就不動
  const k = e.key;
  // Escape 先於輸入框守門：打字中也放行回首頁（草稿已存 drafts 不丟）
  if (k === 'Escape') {
    if (view === 'quiz' || view === 'year' || view === 'result') { view = 'home'; reRender(); e.preventDefault(); }
    return;
  }
  if (e.target?.matches?.('textarea,input,select')) {
    // 打字中不搶；唯一放行：Ctrl/Cmd+Enter 送出中譯英
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.querySelector('[data-ggrade]')) {
      document.querySelector('[data-ggrade]').click();
      e.preventDefault();
    }
    return;
  }
  if (view !== 'quiz') return;
  if (k === 'Enter') {
    const target = document.querySelector('[data-submit]') || document.querySelector('[data-next]') || document.querySelector('[data-gsubmit]');
    if (target) { target.click(); e.preventDefault(); }
    return;
  }
  if (k === 'ArrowLeft') { const el = document.querySelector('[data-prev]'); if (el) { el.click(); e.preventDefault(); } return; }
  if (k === 'ArrowRight') { const el = document.querySelector('[data-next]'); if (el) { el.click(); e.preventDefault(); } return; }
  if (/^[1-9]$/.test(k)) {
    const dd = document.querySelector(`.gsat-dd[data-gsel="${+k - 1}"] .gsat-dd-btn`);
    if (dd) { dd.click(); e.preventDefault(); return; }   // 題組頁：數字開第 n 空的浮層
    document.querySelectorAll('[data-pick]')[+k - 1]?.click();   // 單題頁：第 n 個選項
    return;
  }
  if (/^[a-eA-E]$/.test(k)) {
    const letter = k.toUpperCase();
    // 題組頁：開著的浮層直接選值；否則填第一個未填空 → 連打字母即可填完整組
    const open = [...document.querySelectorAll('.gsat-dd-menu')].find(m => !m.hidden);
    const dd = open || [...document.querySelectorAll('.gsat-dd')].find(x => !x.dataset.value);
    const opt = dd?.querySelector(`[data-v="${letter}"]`);
    if (opt) { opt.click(); e.preventDefault(); return; }
    document.querySelector(`[data-pick="${letter}"]`)?.click();   // 單題頁：字母＝選項
  }
}

// document 級 listener 模組只綁一次（每次 onMount 疊一個會無限累積）；isMine 擋跨頁/跨實例
let docBound = false;
export function onMount(s) {
  storeRef = s;
  view = 'home';
  Promise.all([
    restoreProgress().then(ok => { resumed = ok; }),
    loadPractice('gsat'),
  ]).finally(() => reRender());
  mountBindings();
  if (docBound) return;
  docBound = true;
  document.addEventListener('keydown', onKey);   // onKey 用 isMine 擋非本頁
  document.addEventListener('click', (e) => {
    if (isMine() && !e.target.closest?.('.gsat-dd')) document.querySelectorAll('.gsat-dd-menu').forEach(m => { m.hidden = true; });
  });
}
