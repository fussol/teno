// 作文批改（essay 插件頁）—— 與翻譯分開呼叫、分開存檔（使用者：作文獨立給分）。
// 第一階段單發：貼作文 → LLM 給 review(0–100 兩位小數)＋五軸 → 雷達＋優缺點。
// ponytail: 未做第二階段逐句訂正（要多輪 messages），需要時在 fetchLLM 傳 messages 接上。
import { icon } from '../lib/svg.js';
import { fetchLLM, parseLLMJson } from '../lib/api.js';
import { radarChart } from '../lib/chart.js';
import { toast } from '../lib/toast.js';
import { logPractice, loadPractice, practiceRows } from '../lib/practice-log.js';
import promptRaw from '../assets/grammar/essay_grading.md?raw';

const AXES = ['動詞與時態', '非謂語動詞', '子句與連接', '名詞・代名詞・比較', '句型與語序'];
const official = (v) => (v >= 95 ? 5 : v >= 80 ? 4 : v >= 60 ? 3 : v >= 40 ? 2 : v >= 20 ? 1 : 0);
const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

let text = '';
let out = null;
let busy = false;
let storeRef = null;

function header() {
  return `<div class="page-title">
    <button class="btn btn-sm" data-back="study" style="margin-right:8px">${icon('arrowLeft')} 返回</button>
    ${icon('edit')} 作文批改
  </div>`;
}

function scoreCards(rv) {
  const keys = [['content', '內容'], ['organization', '組織'], ['grammar', '文法句構'], ['vocab', '字彙拼字']];
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0">
    ${keys.map(([k, label]) => `<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:10px 14px;text-align:center;min-width:96px">
      <div style="font-size:20px;font-weight:700;font-family:var(--mono)">${rv[k] != null ? fmt(rv[k]) : '—'}</div>
      <div style="font-size:11px;color:var(--text-tertiary)">${label} · 官方 ${rv[k] != null ? official(rv[k]) : '?'}/5</div>
    </div>`).join('')}
  </div>`;
}

export function render() {
  const rows = practiceRows('essay');
  let body = `${header()}
    <div class="page-subtitle">貼上你的學測作文，給四項評分＋五軸雷達（與翻譯批改各自獨立計分）</div>
    <div style="max-width:680px;margin-top:14px;margin-left:auto;margin-right:auto">
      <textarea id="essayInput" rows="10" placeholder="把作文貼在這裡…" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-elevated);color:var(--text-primary);font-size:15px;line-height:1.7;resize:vertical">${text}</textarea>
      <button class="btn btn-primary" data-grade ${busy ? 'disabled' : ''} style="margin-top:12px">${busy ? '批改中…' : '批改'}</button>
      ${busy ? '<p style="font-size:12px;color:var(--text-tertiary);margin-top:8px">依設定的 LLM 端點評分，通常 10–90 秒</p>' : ''}
    </div>`;

  if (out) {
    const rv = out.review || {};
    const ax = out.axis || {};
    body += `<div style="max-width:680px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:22px;margin-top:18px;margin-left:auto;margin-right:auto">
      <div style="font-size:13px;font-weight:600;color:var(--text-primary)">評分</div>
      ${scoreCards(rv)}
      <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:6px">五軸雷達（內部 0–100）</div>
      ${radarChart(AXES.map(a => ({ label: a, value: Number(ax[a]) || 0 })), { max: 100, size: 280, color: 'var(--orange)' })}
      ${(out.strengths || []).length ? `<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:8px">優點</div>
        <ul style="margin:6px 0 0;padding-left:20px;font-size:14px;color:var(--text-secondary);line-height:1.7">${out.strengths.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      ${(out.issues || []).length ? `<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:12px">優先改善</div>
        <ul style="margin:6px 0 0;padding-left:20px;font-size:14px;color:var(--text-secondary);line-height:1.7">${out.issues.map(x => `<li><b style="color:var(--text-primary)">${x.axis || ''}</b>：${x.why || ''}${x.sentence ? ` <span style="color:var(--text-tertiary)">（${x.sentence}）</span>` : ''}</li>`).join('')}</ul>` : ''}
      <button class="btn" data-clear style="margin-top:16px">再批一篇</button>
    </div>`;
  }

  body += rows.length
    ? `<p style="font-size:12px;color:var(--text-tertiary);margin-top:16px">已批改 ${rows.length} 篇</p>`
    : '';
  return body;
}

function grade() {
  const el = document.getElementById('essayInput');
  const v = (el ? el.value : text).trim();
  if (v.length < 40) { toast('作文太短（至少 40 字）', 'toast-error'); return; }
  text = v;
  busy = true; reRender();

  const body = promptRaw + '\n\n【對話紀錄】\n學生（第 1 階段）：\n' + v +
    '\n\n請完成第一階段整體評分，回覆最後附一個 ```json code block。';

  const s = storeRef;
  const baseUrl = ((s?.state?.llmApiUrl || '').trim() || 'http://localhost:11434')
    .replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
  // 走 messages（chat 240/300s）—— 作文輸出長，單輪 60s 必爆；預設 14b，要更好模型去設定頁選
  fetchLLM(`${baseUrl}/api/generate`, s?.state?.llmModel || 'qwen2.5:14b', body, undefined, [{ role: 'user', content: body }])
    .then((raw) => {
      const parsed = parseLLMJson(raw, 'stage');
      if (!parsed || !parsed.review) throw new Error('回應裡找不到評分 JSON');
      out = parsed;
      const rv = parsed.review;
      logPractice('essay', {
        qid: `essay-${Date.now()}`, mode: 'essay', axis: '',
        ok: ['content', 'organization', 'grammar', 'vocab'].every(k => (rv[k] ?? 0) >= 80),
        scores: { review: rv, axis: parsed.axis || {} },
      });
    })
    .catch((e) => toast('批改失敗：' + e.message, 'toast-error'))
    .finally(() => { busy = false; reRender(); });
}

function reRender() {
  const el = document.getElementById('pageContainer');
  if (el) el.innerHTML = render();
  mountBindings();
}

function mountBindings() {
  document.querySelectorAll('[data-back]').forEach(el =>
    el.addEventListener('click', () => { out = null; storeRef?.actions.navigate(el.dataset.back); }));
  document.querySelector('[data-grade]')?.addEventListener('click', grade);
  document.querySelector('[data-clear]')?.addEventListener('click', () => { out = null; text = ''; reRender(); });
}

export function onMount(s) {
  storeRef = s;
  loadPractice('essay').then(() => reRender()).catch(() => {});
  mountBindings();
}
