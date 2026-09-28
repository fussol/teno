// 文法翻譯練習（grammar 插件頁）—— 入口放學習介面，資料與批改 prompt 隨頁打包。
// MC 本地判分；翻譯走設定裡的 LLM（fetchLLM 自己解析端點）。
// 結果記 localStorage：ponytail: 插件先不動 DB schema，要跨裝置備份再改成 SQLite table。
import { icon } from '../lib/svg.js';
import { fetchLLM, parseLLMJson } from '../lib/api.js';
import { radarChart } from '../lib/chart.js';
import { logPractice, loadPractice, practiceRows } from '../lib/practice-log.js';
import { toast } from '../lib/toast.js';
import { getSetting } from '../lib/db.js';
import { mergeBank } from '../lib/bank.js';
import questionsRaw from '../assets/grammar/questions.jsonl?raw';
import gradingPromptRaw from '../assets/grammar/translation_grading.md?raw';
import topicsRaw from '../assets/grammar/pattern_titles.json?raw';

const BASE = questionsRaw.trim().split('\n').map(l => JSON.parse(l));
// 題庫 = 內建主本 ⊕ DB 覆蓋層（工具頁出題/刪題寫 settings.grammar_bank_overlay；讀失敗＝用主本）
let QUESTIONS = BASE;
const loadBankOv = async () => {
  try {
    const ov = await getSetting('grammar_bank_overlay');
    // 無條件合併：覆蓋層被清空時也要退回 BASE（有長度條件會殘留舊合併結果）
    if (ov && typeof ov === 'object') QUESTIONS = mergeBank(BASE, ov);
  } catch { /* DB 未就緒 → 內建題庫 */ }
};
const PROMPT_HEAD = gradingPromptRaw.split('【題目】')[0];
const TOPICS = JSON.parse(topicsRaw);   // pattern id -> [章標題, 句型標題]
// 出題主題：第N章 章名｜句型（題題都要顯示）
const topicOf = (q, max = 60) => {
  const t = TOPICS[q.pattern];
  if (!t) return `${q.axis}`;
  const pat = t[1].length > max ? t[1].slice(0, max) + '…' : t[1];
  return `第${q.chapter}章 ${t[0]}｜${pat}`;
};
const AXES = ['動詞與時態', '非謂語動詞', '子句與連接', '名詞・代名詞・比較', '句型與語序'];
const SET_SIZE = 10;

// 官方 0–5 換算（與批改 prompt 同一張表：≥95→5、80–94→4…）
const official = (v) => (v >= 95 ? 5 : v >= 80 ? 4 : v >= 60 ? 3 : v >= 40 ? 2 : v >= 20 ? 1 : 0);
const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

let mode = null;          // null=主選單 | 'mc' | 'tr'
let src = 'normal';       // 'normal'=練習（未出現>作過） | 'wrong'=錯題專練（完全分開）
let queue = [];
let idx = 0;
let pick = null;          // mc 已選項
let trText = '';
// 非同步批改：qid -> {status:'pending'|'done'|'error', out/text/err}。批改不擋作答，完成才回填。

// 作答＋批改記憶：qid -> {status,out/text/err}（localStorage 足夠；要跟 DB 備份走再進 settings）
const trStore = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('teno:grammar:tr') || '{}');
    // App 關掉時還在 pending 的批次 → 轉 error，不留永久轉圈
    for (const k of Object.keys(o)) if (o[k]?.status === 'pending') o[k] = { status: 'error', err: '批改中斷（App 關閉）', text: o[k].text };
    return o;
  } catch { return {}; }
})();
const saveTr = (qid, entry) => {
  trStore[qid] = entry;
  try { localStorage.setItem('teno:grammar:tr', JSON.stringify(trStore)); } catch { /* 溢位：記到這為止 */ }
};
const trGrades = {};
let setSeq = 0;           // 換組就 +1：舊批次回來只入帳、不動畫面
const doneInSession = new Set();   // 本輪已出過的題（池抽乾才重置）→ 不退出就一直有新題
let trResultsOpen = false;        // 手機版看批改結果的列表視圖
let storeRef = null;        // onMount 注入；子頁是動態 import，不用全域物件傳遞

const record = (row) => logPractice('grammar', row);

// 出題順序（規則：全程亂序；練習模式「未出現過」排前面 → 作過的題天然低頻）
// 錯題練習完全獨立：只抽錯題。src='normal' 時錯題只在「未出現補滿後」才輪得到。
function orderedPool(m, s) {
  const type = m === 'mc' ? 'mc' : 'translate';
  const shuf = () => Math.random() - 0.5;
  const rows = practiceRows('grammar');
  const wrong = new Set(rows.filter(r => !r.ok && (r.mode === 'mc') === (m === 'mc')).map(r => r.qid));
  const pool = QUESTIONS.filter(q => q.type === type && (s !== 'wrong' || wrong.has(q.id)));
  if (s === 'wrong') return pool.sort(shuf);
  const seen = new Set(rows.filter(r => (r.mode === 'mc') === (m === 'mc')).map(r => r.qid));
  return [...pool.filter(q => !seen.has(q.id)).sort(shuf), ...pool.filter(q => seen.has(q.id)).sort(shuf)];
}

function newSet(m, s = 'normal') {
  const ordered = orderedPool(m, s);
  if (!ordered.length) { toast('目前沒有錯題，先去練習', 'toast-error'); return false; }
  mode = m; src = s;
  queue = ordered.slice(0, SET_SIZE);
  queue.forEach(q => doneInSession.add(q.id));
  idx = 0; pick = null;
  for (const k of Object.keys(trGrades)) delete trGrades[k];
  // 舊作答/批改跟著題目回來（記憶）
  queue.forEach(q => { if (trStore[q.id]) trGrades[q.id] = trStore[q.id]; });
  trText = trGrades[queue[0]?.id]?.text || '';
  setSeq++;
  trResultsOpen = false;
}

// 池抽不到（本輪全出過）→ 重置再抽，題目永遠接得上
function extendQueue() {
  const ordered = orderedPool(mode, src);   // 同規則：亂序＋未出現優先＋尊重錯題專練範圍
  let extra = ordered.filter(q => !doneInSession.has(q.id)).slice(0, SET_SIZE);
  if (!extra.length) {
    doneInSession.clear();
    extra = ordered.slice(0, SET_SIZE);
  }
  extra.forEach(q => doneInSession.add(q.id));
  queue.push(...extra);
}

// 統一前進：清作答狀態、快沒題就補一批
function advance() {
  idx++; pick = null;
  trText = trGrades[queue[idx]?.id]?.text || '';   // 下一題帶著上次作答（沒寫過＝空）
  if (queue.length - idx < 2) extendQueue();
  reRender();
}

function stats() {
  const log = practiceRows('grammar');
  const per = {};
  for (const a of AXES) per[a] = { n: 0, ok: 0 };
  for (const r of log) if (per[r.axis]) { per[r.axis].n++; if (r.ok) per[r.axis].ok++; }
  return { log, per };
}

function axisChart() {
  const { log, per } = stats();
  if (!log.length) return '<p style="color:var(--text-tertiary);font-size:13px;margin:0">還沒有練習紀錄</p>';
  const data = AXES.map(a => ({ label: a, value: per[a].n ? Math.round(per[a].ok / per[a].n * 100) : 0 }));
  // ponytail: 雷達圖 = 五軸正確率快照；要跨模式分軸（mc/tr 各一張）等資料量夠再拆
  return radarChart(data, { max: 100, size: 280, color: 'var(--cyan)' }) +
    `<p style="color:var(--text-tertiary);font-size:12px;margin:4px 0 0;text-align:center">五軸正確率（%）· 共 ${log.length} 筆</p>`;
}

function scoreChips(rv) {
  const keys = [['content', '內容'], ['organization', '組織'], ['grammar', '文法句構'], ['vocab', '字彙拼字'], ['axis', '本題軸']];
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
    ${keys.map(([k, label]) => `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;text-align:center;min-width:88px">
      <div style="font-size:18px;font-weight:700;font-family:var(--mono)">${rv[k] != null ? fmt(rv[k]) : '—'}</div>
      <div style="font-size:11px;color:var(--text-tertiary)">${label} · 官方 ${rv[k] != null ? official(rv[k]) : '?'}/5</div>
    </div>`).join('')}
  </div>`;
}

function header(title, back = true) {
  return `<div class="page-title">
    ${back ? `<button class="btn btn-sm" data-back="topics" style="margin-right:8px">${icon('arrowLeft')} 返回</button>` : ''}
    ${icon('bookOpen')} ${title}
  </div>`;
}

function homeView() {
  const { log } = stats();
  const cards = [
    { m: 'mc', s: 'normal', label: '多選練習', desc: '四選一，即時對答案 · 沒出過的題優先（亂序）', color: 'var(--cyan)', ic: 'form' },
    { m: 'tr', s: 'normal', label: '翻譯批改', desc: '中文譯英文，LLM 逐題批改 · 沒出過的題優先（亂序）', color: 'var(--orange)', ic: 'edit' },
    { m: 'mc', s: 'wrong', label: '多選 · 錯題練習', desc: '只抽答錯過的題，完全獨立（亂序）', color: 'var(--red)', ic: 'form' },
    { m: 'tr', s: 'wrong', label: '翻譯 · 錯題練習', desc: '只抽批改沒過的題，完全獨立（亂序）', color: 'var(--red)', ic: 'edit' },
  ].map(c => `
    <div class="mode-card" data-mode="${c.m}" data-src="${c.s}" style="cursor:pointer;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:20px;display:flex;gap:14px;align-items:center">
      <div style="width:40px;height:40px;border-radius:var(--r-md);background:${c.color}20;display:flex;align-items:center;justify-content:center;color:${c.color};flex-shrink:0">${icon(c.ic)}</div>
      <div><div style="font-size:15px;font-weight:600;color:var(--text-primary)">${c.label}</div>
      <div style="font-size:12px;color:var(--text-tertiary)">${c.desc}</div></div>
    </div>`).join('');
  return `${header('文法翻譯', false)}
    <div class="page-subtitle">16 章句型 · ${QUESTIONS.filter(q => q.type === 'mc').length} 題多選／${QUESTIONS.filter(q => q.type === 'translate').length} 題翻譯</div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px;max-width:600px;margin-left:auto;margin-right:auto">${cards}</div>
    <div style="margin-top:24px;max-width:600px;margin-left:auto;margin-right:auto">${axisChart()}</div>`;
}

function mcView(q) {
  if (pick != null) {
    const ok = pick === q.answer;
    return `${header('多選練習')}
      <div class="study-card" style="max-width:640px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;margin-top:12px;margin-left:auto;margin-right:auto">
        <div style="font-size:12px;color:var(--text-tertiary)">${topicOf(q)} · ${q.axis}</div>
        <div style="font-size:17px;color:var(--text-primary);margin:8px 0 16px;line-height:1.6">${q.stem}</div>
        ${q.options.map((o, i) => {
          const isAns = i === q.answer, isPick = i === pick;
          const bg = isAns ? 'var(--green)' : isPick ? 'var(--red)' : 'transparent';
          const bd = isAns || isPick ? bg : 'var(--border)';
          const fg = isAns || isPick ? '#fff' : 'var(--text-primary)';
          return `<div style="border:1px solid ${bd};border-radius:var(--r-md);padding:10px 14px;margin-bottom:8px;background:${bg};color:${fg}">${String.fromCharCode(65 + i)}. ${o}</div>`;
        }).join('')}
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin:12px 0 0">${q.explain || ''}</p>
        <button class="btn btn-primary" data-next style="margin-top:16px">下一題</button>
      </div>`;
  }
  return `${header('多選練習')}
    <div class="study-card" style="max-width:640px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;margin-top:12px;margin-left:auto;margin-right:auto">
      <div style="font-size:12px;color:var(--text-tertiary)">${topicOf(q)} · ${q.axis} · 難度 ${'●'.repeat(q.difficulty || 1)}</div>
      <div style="font-size:17px;color:var(--text-primary);margin:8px 0 16px;line-height:1.6">${q.stem}</div>
      ${q.options.map((o, i) => `
        <button class="study-opt" data-opt="${i}" style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:var(--r-md);padding:10px 14px;margin-bottom:8px;background:var(--bg-elevated);color:var(--text-primary);cursor:pointer">
          <span style="font-weight:600;margin-right:8px">${String.fromCharCode(65 + i)}</span>${o}
        </button>`).join('')}
    </div>`;
}

function trView(q) {
  const doneN = Object.values(trGrades).filter(g => g.status === 'done').length;
  return `${header('翻譯批改')}
    <div style="max-width:640px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;margin-top:12px;margin-left:auto;margin-right:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--text-tertiary)">${topicOf(q, 44)} · ${q.axis}</span>
        <button class="btn btn-sm" data-results>批改結果${doneN ? ` (${doneN})` : ''}</button>
      </div>
      <div style="font-size:17px;color:var(--text-primary);margin:8px 0 16px;line-height:1.7">${q.translation}</div>
      <textarea id="trInput" data-qid="${q.id}" rows="4" placeholder="寫出你的英文譯文…" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-elevated);color:var(--text-primary);font-size:15px;line-height:1.6;resize:vertical">${trText}</textarea>
      <button class="btn btn-primary" data-grade style="margin-top:12px">批改並下一題（背景）</button>
      <p style="font-size:12px;color:var(--text-tertiary);margin-top:8px">送出後直接繼續作答；批改完成會提示，桌機右側可看批改序列</p>
    </div>
    ${gradePanel()}`;
}

function trResultCards() {
  return queue.filter(q => trGrades[q.id]).map((q) => {
    const g = trGrades[q.id];
    const head = `<div style="font-size:12px;color:var(--text-tertiary)">${topicOf(q, 40)} · ${q.axis}</div>
      <div style="font-size:13px;color:var(--text-primary);margin-top:4px">${q.translation}</div>`;
    if (g.status === 'pending') {
      return `<div style="border:1px dashed var(--border);border-radius:var(--r-md);padding:12px 14px;margin-bottom:10px">${head}
        <div style="font-size:13px;color:var(--text-tertiary);margin-top:6px">批改中…</div></div>`;
    }
    if (g.status === 'error') {
      return `<div style="border:1px solid var(--red);border-radius:var(--r-md);padding:12px 14px;margin-bottom:10px">${head}
        <div style="font-size:13px;color:var(--red);margin-top:6px">批改失敗：${g.err}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">你的答案：${g.text}</div></div>`;
    }
    const rv = g.out.review || {};
    // 修改建議＋緣由：新版 suggestions；舊批改結果 fallback issues（軸+錯因）
    const sugs = (g.out.suggestions || []).length ? g.out.suggestions
      : (g.out.issues || []).map(i => ({ what: i.axis, why: i.why }));
    return `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:12px 14px;margin-bottom:10px;background:var(--bg-surface)">${head}
      <div style="font-size:13px;color:var(--text-secondary);border-left:3px solid var(--border);padding-left:10px;margin:8px 0">你的答案：${g.text}</div>
      ${scoreChips(rv)}
      ${g.out.answer ? `<div style="border-left:3px solid var(--green);background:var(--bg-elevated);border-radius:var(--r-md);padding:9px 12px;margin:8px 0;font-size:14px;line-height:1.7;color:var(--text-primary)"><b style="font-size:12px;color:var(--green)">訂正</b><br>${g.out.answer}</div>` : ''}
      ${sugs.length ? `<div style="margin:8px 0"><b style="font-size:13px;color:var(--text-primary)">修改建議</b><ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:var(--text-secondary);line-height:1.7">${sugs.map(x => `<li><b style="color:var(--text-primary)">${x.what || ''}</b>${x.why ? `<br><span style="color:var(--text-tertiary)">緣由：${x.why}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${g.out.comment ? `<p style="font-size:13px;color:var(--text-primary);line-height:1.7;margin:4px 0">${g.out.comment}</p>` : ''}
    </div>`;
  }).join('') || '<p style="color:var(--text-tertiary);font-size:13px">還沒有批改結果</p>';
}

function resultsView() {
  const pending = Object.values(trGrades).filter(g => g.status === 'pending').length;
  return `${header('批改結果', false).replace('</div>', `<button class="btn btn-sm" data-backq style="margin-right:8px">${icon('arrowLeft')} 回作答</button></div>`)}
    <div style="max-width:640px;margin:12px auto 0">
      ${pending ? `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px">${pending} 題批改中，完成會自動出現</div>` : ''}
      ${trResultCards()}
    </div>
    ${gradePanel()}`;
}

export function render() {
  if (idx >= queue.length) extendQueue();   // 理論上到不了（advance 自動補），保險
  const body = mode == null ? homeView()
    : trResultsOpen ? resultsView()
    : mode === 'mc' ? mcView(queue[idx]) : trView(queue[idx]);
  // 頁面標記：導頁後非同步回呼不許把別頁蓋掉（reRender 會認這個標記）
  return `<span data-page="grammar" hidden></span>${body}`;
}

// 桌機右側「批改序列」：>=1100px 顯示（CSS .grade-queue），手機隱藏 → 看結果頁
function gradePanel() {
  const entries = queue.map((q, i) => ({ q, i, g: trGrades[q.id] })).filter(e => e.g);
  if (!entries.length) return '';
  const pending = entries.filter(e => e.g.status === 'pending').length;
  const rows = entries.map(({ q, i, g }) => {
    const right = g.status === 'pending' ? '<span style="color:var(--text-tertiary);font-size:11px">批改中…</span>'
      : g.status === 'error' ? '<span style="color:var(--red);font-size:11px">失敗</span>'
      : (() => { const rv = g.out.review || {};
          const avg = ['content', 'organization', 'grammar', 'vocab'].reduce((s2, k) => s2 + (rv[k] ?? 0), 0) / 4;
          const good = ['content', 'organization', 'grammar', 'vocab'].every(k => (rv[k] ?? 0) >= 80);
          return `<b style="font-size:12px;font-family:var(--mono);color:${good ? 'var(--green)' : 'var(--orange)'}">${avg.toFixed(1)}</b>`; })();
    return `<div style="display:flex;justify-content:space-between;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(q.translation || '').slice(0, 9)}</span>${right}</div>`;
  }).join('');
  return `<aside class="grade-queue" style="position:fixed;right:14px;top:76px;width:238px;max-height:calc(100vh - 120px);overflow:auto;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:12px 14px;box-shadow:var(--shadow-md);z-index:30">
    <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px">批改序列${pending ? ` · ${pending} 進行中` : ''}</div>
    ${rows}
  </aside>`;
}

function reRender() {
  const el = document.getElementById('pageContainer');
  // 頁面標記不符 = 使用者已導去別頁 → 不准蓋掉別的頁（非同步批改可能 60 秒後才回來）
  if (!el || !el.querySelector('[data-page="grammar"]')) return;
  const ti = document.getElementById('trInput');
  // 收輸入框（批改回呼可能在使用者打下一題到一半時回來）——只收「屬於當前題」的框，
  // 否則 advance() 換題時會把上一題的字帶進下一題
  if (ti && ti.dataset.qid === queue[idx]?.id) trText = ti.value;
  el.innerHTML = render();
  mountBindings();
}

function grade() {
  const q = queue[idx];
  const text = (document.getElementById('trInput')?.value || trText).trim();
  if (!text) { toast('先寫出你的譯文', 'toast-error'); return; }
  trText = text;
  const seq = setSeq;
  trGrades[q.id] = { status: 'pending', text };
  saveTr(q.id, { status: 'pending', text });
  // 立刻前進，不等批改 —— 時間不留白
  advance();

  const head = PROMPT_HEAD;
  const body = head + '\n【題目】\n' +
    `1. id=${q.id}#user\n   中文：${q.translation}\n   參考譯文：${q.reference}\n` +
    `   axis（題目給，不可改）：${q.axis}\n   學生答案：${text}\n\n` +
    '（共 1 題。回覆最後附一個 ```json code block。）\n' +
    '（下列數字只是欄位格式示範，禁止照抄，一律填現場實際評分）欄位：{"results":[{"id":"帶回題目id","ok":true,' +
    '"review":{"content":91.37,"organization":87.42,"grammar":68.15,"vocab":79.26,"axis":73.44},' +
    '"issues":[{"axis":"五軸之一","why":"..."}],"suggestions":[{"what":"...","why":"..."}],' +
    '"comment":"...","answer":"訂正後最佳譯文"}],"total":352.00}';

  const s = storeRef;
  const baseUrl = ((s?.state?.llmApiUrl || '').trim() || 'http://localhost:11434')
    .replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
  // chat 路徑（messages）＝240/300s；預設 14b 實測秒解（qwen3 單輪 60s 必超時）
  fetchLLM(`${baseUrl}/api/generate`, s?.state?.llmModel || 'qwen2.5:14b', body, undefined, [{ role: 'user', content: body }])
    .then((text2) => {
      const raw = parseLLMJson(text2);
      if (!raw || !raw.results) throw new Error('回應裡找不到批改 JSON');
      const out = raw.results[0];
      const rv = out.review || {};
      // 紀錄永遠入帳（歷史不因換頁/換組而丟），畫面只在同組才更新
      record({ qid: q.id, mode: 'tr', axis: q.axis, ok: (['content', 'organization', 'grammar', 'vocab'].every(k => (rv[k] ?? 0) >= 80)), scores: rv });
      saveTr(q.id, { status: 'done', out, text });   // 歷史永遠入庫，不隨換組消失
      if (seq === setSeq) {
        trGrades[q.id] = { status: 'done', out, text };
        toast(`第 ${queue.findIndex(x => x.id === q.id) + 1} 題批改完成`, 'toast-success');
      }
    })
    .catch((e) => {
      const msg = e?.message || String(e);
      saveTr(q.id, { status: 'error', err: msg, text });
      if (seq === setSeq) trGrades[q.id] = { status: 'error', err: msg, text };
      console.error('[grammar-tr]', e);
      toast('批改失敗：' + msg, 'toast-error');
    })
    .finally(() => { if (seq === setSeq) reRender(); });
}

function mountBindings() {
  document.querySelectorAll('[data-back]').forEach(el =>
    el.addEventListener('click', () => { mode = null; storeRef?.actions.navigate(el.dataset.back); }));
  document.querySelectorAll('[data-mode]').forEach(el =>
    el.addEventListener('click', () => { if (newSet(el.dataset.mode, el.dataset.src || 'normal') !== false) reRender(); }));
  document.querySelectorAll('[data-opt]').forEach(el =>
    el.addEventListener('click', () => {
      const q = queue[idx];
      pick = Number(el.dataset.opt);
      record({ qid: q.id, mode: 'mc', axis: q.axis, ok: pick === q.answer });
      reRender();
    }));
  document.querySelector('[data-grade]')?.addEventListener('click', grade);
  document.querySelectorAll('[data-next]').forEach(el =>
    el.addEventListener('click', advance));
  document.querySelector('[data-results]')?.addEventListener('click', () => {
    const el = document.getElementById('trInput');
    if (el) trText = el.value;          // 離開前收答案，回來還在
    trResultsOpen = true; reRender();
  });
  document.querySelector('[data-backq]')?.addEventListener('click', () => { trResultsOpen = false; reRender(); });
}

export function onMount(s) {
  storeRef = s;
  loadPractice('grammar').then(loadBankOv).then(() => reRender()).catch(() => {});
  mountBindings();
}
