import { icon } from '../lib/svg.js';
import { withPageScope } from '../lib/scope-dom.js';
import { normalizePos } from '../core/import.js'; // G-TOOL1＋COMBO1: 組合包外只剩 __lookupCambridge 用（去尾點＋短形映射＋去重）
import { toast } from '../lib/toast.js';
import { fetchGet, fetchLLM, lookupCambridge, parseLLMJson } from '../lib/api.js';
import { getSetting, setSetting, getAllWords, saveWordsInTx, deleteWord } from '../lib/db.js';
import { mergeBank, validateQuestion, nextQid } from '../lib/bank.js';
import { normPerms, AI_CATS } from '../lib/aiperms.js';
import { runTurn } from '../lib/aiagent-core.js';
import { importBuiltin } from '../lib/sharepack.js';

// KEEPALIVE1：本頁圖層根（預渲染後不再是 #pageContainer）
const pageRoot = () => document.getElementById('page-tools') || document.getElementById('pageContainer');

// OCR token 白名單（計畫 v1.3 §5，與 store.importOcrText 端同一正則）
const _OCR_TOKEN_RE = /^[a-z][a-z'-]{1,30}$/i;

// G-XSS6: 本地 escape（全檔原零設施；體檢 issues 列表插使用者字串）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── 文法題庫管理（工具頁）：AI 出題／刪題 → 覆蓋層存 settings，文法頁載入時合併 ───
// SHAREPACK2：核心題庫不預載——settings.grammar_bank_core；未匯入＝只出 gate 卡
let BANK_BASE = [];
let BANK_TOPICS = {};
let bankCoreReady = false;
const hydrateBankCore = (data) => { BANK_BASE = data.qs; BANK_TOPICS = data.topics || {}; bankCoreReady = true; };
let bOv = { up: {}, rm: [] };
let bReady = null;          // 覆蓋層載入 promise（入庫前必等，id 才不撞）
let bPreview = [];          // LLM 出題 → 預覽 → 確認入庫
let bDel = '';              // 兩段式刪題（按一次備刪、再按才刪）
let bEdit = null;           // 編輯器狀態：null | { id: ''=新增, form: {...} }
let bF = { pat: '', type: '', q: '' };
let bankS = null;           // _mount 注入：LLM 設定（同文法頁批改的解析法）
let bChat = [];             // AI 助手對話軌跡（module 級：跨頁保留、不落 DB 不上雲）
let bChatBusy = false;
let aiPermsCur = null;      // 權限快照（UI 讀寫同一份，存 settings.ai_perms）
let aiLastImage = null;     // 聊天最近附加的圖片（File，供 AI 的 ocr.last_image 工具）
const bankAll = () => mergeBank(BANK_BASE, bOv);
const axisOf = (pat) => BANK_BASE.find(x => x.pattern === pat)?.axis || '句型與語序';
const bankLoad = () => (bReady = bReady || (async () => {
  try {
    const core = await getSetting('grammar_bank_core');
    if (core && Array.isArray(core.qs) && core.qs.length) hydrateBankCore(core);
  } catch { /* DB 未就緒 */ }
  // gate 反轉：核心就位→題庫管理區；未匯入→gate 卡（區塊預設 hidden）
  const gate = document.getElementById('bankGate');
  const sec = document.getElementById('bankSection');
  if (gate && sec) { gate.hidden = bankCoreReady; sec.hidden = !bankCoreReady; }
  try {
    const o = await getSetting('grammar_bank_overlay');
    if (o && typeof o === 'object') bOv = { up: o.up || {}, rm: o.rm || [] };
  } catch { /* DB 未就緒 */ }
})());

function bankListHtml() {
  const all = bankAll();
  let rows = all;
  if (bF.pat) rows = rows.filter(q => q.pattern === bF.pat);
  if (bF.type) rows = rows.filter(q => q.type === bF.type);
  if (bF.q) { const t = bF.q.toLowerCase(); rows = rows.filter(q => (q.stem || q.translation || '').toLowerCase().includes(t)); }
  const shown = rows.slice(0, 80);
  const head = `<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">顯示 ${shown.length}/${rows.length} 筆（題庫共 ${all.length}）</div>`;
  if (!shown.length) return head + '<p style="font-size:12px;color:var(--text-tertiary)">沒有符合的題</p>';
  return head + shown.map(q => {
    const text = q.type === 'mc' ? q.stem : q.translation;
    const tag = (q.id in bOv.up) ? ' <b style="color:var(--green);font-size:10px">新</b>' : (bOv.rm.includes(q.id) ? '' : '');
    return `<div class="tool-row" style="border-bottom:1px solid var(--border);padding:5px 0;flex-wrap:nowrap">
      <span style="font-size:10px;font-family:var(--mono);color:var(--text-tertiary);min-width:88px">${esc(q.id)}${tag}</span>
      <span style="flex:1;min-width:0;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(text)}</span>
      <span style="font-size:10px;color:var(--text-tertiary)">${q.type === 'mc' ? '多選' : '翻譯'}</span>
      <button class="btn btn-sm bank-edit" data-id="${esc(q.id)}" style="font-size:11px;padding:2px 10px">編輯</button>
      <button class="btn btn-sm bank-del" data-id="${esc(q.id)}" style="font-size:11px;padding:2px 10px;color:var(--red)">${bDel === q.id ? '再按確認' : '刪'}</button>
    </div>`;
  }).join('');
}
function bankFillList() {
  const el = document.getElementById('bankList');
  if (el) {
    el.innerHTML = bankListHtml();
    el.querySelectorAll('.bank-del').forEach(b => b.addEventListener('click', bankDel));
    el.querySelectorAll('.bank-edit').forEach(b => b.addEventListener('click', e => {
      const id = e.currentTarget.dataset.id;
      bankEditOpen(bankAll().find(q => q.id === id));
    }));
  }
  const c = document.getElementById('bankCount');
  if (c) c.textContent = bankAll().length;
}
async function bankDel(e) {
  const id = e.currentTarget.dataset.id;
  if (bDel !== id) { bDel = id; bankFillList(); toast('再按一次確認刪除', 'toast-warn'); return; }
  bDel = '';
  const nv = { up: { ...bOv.up }, rm: [...bOv.rm] };
  if (id in nv.up) delete nv.up[id];                                          // 移除覆寫
  if (BANK_BASE.some(q => q.id === id) && !nv.rm.includes(id)) nv.rm.push(id); // 主本題一律進 rm（改過再刪也要刪乾淨，否則復活）
  try { await setSetting('grammar_bank_overlay', nv); }
  catch (err) { toast('刪除寫入失敗：' + (err?.message || err), 'toast-error'); return; }
  bOv = nv;
  bankFillList();
  toast('已刪除 ' + id, 'toast-success');
}
function bankPreviewHtml() {
  const el = document.getElementById('bankPreview');
  if (!el) return;
  if (!bPreview.length) { el.innerHTML = ''; return; }
  el.innerHTML = bPreview.map(q => {
    if (q.type === 'mc') {
      return `<div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:6px;background:var(--bg-elevated)">
        <div style="font-size:13px;color:var(--text-primary)">${esc(q.stem)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.6">${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${esc(o)}${i === q.answer ? ' ✓' : ''}`).join('<br>')}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${esc(q.explain)} · 難度 ${q.difficulty || 1}</div>
      </div>`;
    }
    return `<div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:6px;background:var(--bg-elevated)">
      <div style="font-size:13px;color:var(--text-primary)">${esc(q.translation)}</div>
      <div style="font-size:12px;color:var(--green);margin-top:4px">${esc(q.reference)}</div>
      ${q.comment ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${esc(q.comment)}</div>` : ''}
    </div>`;
  }).join('') +
  `<div class="tool-row" style="margin-top:6px">
     <button class="btn btn-primary" id="bankCommit">全部入庫（${bPreview.length} 題）</button>
     <button class="btn" id="bankDiscard">捨棄</button>
   </div>`;
  document.getElementById('bankCommit')?.addEventListener('click', bankCommit);
  document.getElementById('bankDiscard')?.addEventListener('click', () => { bPreview = []; bankPreviewHtml(); });
}
async function bankCommit() {
  if (!bPreview.length) return;
  let list = bankAll();
  const nv = { up: { ...bOv.up }, rm: [...bOv.rm] };
  for (const q of bPreview) {
    const id = nextQid(list, q.pattern, q.type === 'mc' ? 'mc' : 'tr');
    const item = { ...q, id };
    nv.up[id] = item;
    list = [...list, item];
  }
  try { await setSetting('grammar_bank_overlay', nv); }
  catch (err) { toast('入庫寫入失敗：' + (err?.message || err), 'toast-error'); return; }
  const n = bPreview.length;
  bOv = nv; bPreview = [];
  bankPreviewHtml(); bankFillList();
  toast(`已入庫 ${n} 題（重開文法頁即生效）`, 'toast-success');
}
async function bankGen() {
  const pat = document.getElementById('bankPat')?.value;
  const type = document.getElementById('bankType')?.value || 'mc';
  const n = Number(document.getElementById('bankN')?.value || 3);
  const btn = document.getElementById('bankGen');
  const mat = (document.getElementById('bankPrompt')?.value || '').trim();
  // 匯入路線：以 {/[ 開頭一律當 JSON 解析（{results:[...]} 或裸陣列）→ 進預覽待確認，不打 LLM
  if (mat.startsWith('{') || mat.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(mat); }
    catch { toast('JSON 解析失敗；若只想當材料用，把開頭的 { 或 [ 去掉', 'toast-error'); return; }
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : null);
    if (arr) {
      await bReady;
      const ok = [], bad = [];
      for (const it of arr) {
        const qpat = it?.pattern || pat;
        if (!qpat || !BANK_TOPICS[qpat]) { bad.push('無句型 ' + qpat); continue; }
        const q = { ...it, type: it.type === 'translate' ? 'translate' : (it.type === 'mc' ? 'mc' : type),
          pattern: qpat, chapter: Number(qpat.split('-')[0]) || 1, axis: axisOf(qpat) };
        const err = validateQuestion(q);
        if (err) bad.push(err); else ok.push(q);
      }
      if (!ok.length) { toast('匯入失敗：' + (bad[0] || '沒有題目'), 'toast-error'); return; }
      bPreview = ok;
      bankPreviewHtml();
      toast(`匯入 ${ok.length} 題待確認${bad.length ? `（${bad.length} 題不合格丟棄）` : ''}`, 'toast-success');
      return;
    }
    // JSON 但無 results 陣列 → 當材料往下走 LLM
  }
  if (!pat || !BANK_TOPICS[pat]) { toast('選一個句型', 'toast-error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '出題中…'; }
  try {
    await bReady;                       // 覆蓋層先到位，nextQid 才不會撞舊 id
    const t = BANK_TOPICS[pat];
    const chapter = Number(pat.split('-')[0]) || 1;
    const spec = type === 'mc'
      ? `每題欄位：{"type":"mc","stem":"英文題幹（空格用 ______）","options":["四個選項"],"answer":0,"explain":"中文解析：正解理由＋錯誤選項為何錯","difficulty":1}
規則：answer 是正確選項索引(0-3)、四個選項只有一個正確、difficulty 為 1-3 的整數；題幹與選項只考指定句型；禁止抄任何範例。`
      : `每題欄位：{"type":"translate","translation":"中文題目","reference":"正確自然的英文參考譯文","comment":"句型重點（中文一句）"}
規則：參考譯文必須正確運用指定句型、自然且文法完整；禁止抄任何範例。`;
    const body = `你是高中英文文法命題專家。針對指定句型出 ${n} 題。
只回 JSON：{"results":[題目陣列]}，最後附一個 \`\`\`json code block。
${spec}
${mat ? `出題材料（依材料命題，可改寫但不可偏離）：\n${mat}\n` : ''}句型：pattern=${pat}（第${chapter}章 ${t[0]}）：${t[1]}`;
    const s = bankS;
    const base = ((s?.state?.llmApiUrl || '').trim() || 'http://localhost:11434')
      .replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
    const text = await fetchLLM(`${base}/api/generate`, s?.state?.llmModel || 'qwen2.5:14b', body, undefined, [{ role: 'user', content: body }]);
    const raw = parseLLMJson(text, 'results');
    const arr = Array.isArray(raw?.results) ? raw.results : [];
    const ok = [], bad = [];
    for (const it of arr) {
      const q = { ...it, type, pattern: pat, chapter, axis: axisOf(pat) };
      const err = validateQuestion(q);
      if (err) bad.push(err); else ok.push(q);
    }
    if (!ok.length) throw new Error(bad.length ? '格式不合格：' + bad[0] : '回應裡找不到 results');
    bPreview = ok.slice(0, n);
    bankPreviewHtml();
    toast(`取得 ${bPreview.length} 題${bad.length ? `，${bad.length} 題格式不合格已丟棄` : ''}`, 'toast-success');
  } catch (e) {
    toast('出題失敗：' + (e?.message || e), 'toast-error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '生成'; }
  }
}

// ─── AI 助手：io 綁定（core 純函式吃這個）＋權限 UI＋聊天 ───
const AI_CAT_LABELS = { bank: '題庫覆蓋層', settings: '設定', words: '單字庫/圖片' };
const AI_IO = {
  bankAll: async () => { await bReady; return bankAll(); },
  getOverlay: async () => { await bReady; return { up: { ...bOv.up }, rm: [...bOv.rm] }; },
  saveOverlay: async (nv) => { await setSetting('grammar_bank_overlay', nv); bOv = nv; bankFillList(); },
  getSetting, setSetting,
  searchWords: async (q, limit) => {
    const t = String(q || '').toLowerCase();
    const ws = await getAllWords();
    const rows = ws.filter(w => !t || String(w.word || '').toLowerCase().includes(t)
      || String(w.definition || '').toLowerCase().includes(t)).slice(0, limit);
    return { total: ws.length, rows };
  },
  saveWords: async (ws) => {
    const withId = ws.map(w => (w.word && !w.id)
      ? { ...w, id: 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) } : w);
    await saveWordsInTx(withId);
    return withId.length;
  },
  removeWords: async (ids) => {
    let n = 0;
    for (const id of ids) { try { await deleteWord(id); n++; } catch (_) {} }
    return n;
  },
  ocrLastImage: async (opts) => {
    if (!aiLastImage) throw new Error('沒有可 OCR 的圖片（先用 📎 附加圖片）');
    const { getActiveEngine } = await import('../lib/ocr/engine.js');
    const { engine } = await getActiveEngine();
    const res = await engine.recognize(aiLastImage, { psm: Number(opts?.psm) || 3, dpi: 300 });
    return String(res?.text || '');
  },
};

function aiPermsRender(p) {
  const el = document.getElementById('aiPermsGrid');
  if (!el || !p) return;
  const hd = 'text-align:center;color:var(--text-tertiary);font-size:11px';
  el.innerHTML = `<div style="display:grid;grid-template-columns:1fr 40px 40px 40px;gap:6px 4px;align-items:center;font-size:12px">
    <span></span><span style="${hd}">讀</span><span style="${hd}">寫</span><span style="${hd}">刪</span>
    ${AI_CATS.map(c => `<span>${AI_CAT_LABELS[c]}</span>` + ['r', 'w', 'd'].map(a =>
      `<label style="text-align:center;cursor:pointer"><input type="checkbox" data-cat="${c}" data-act="${a}"${p[c][a] ? ' checked' : ''}></label>`).join('')).join('')}
  </div>`;
  el.querySelectorAll('input').forEach(cb => cb.addEventListener('change', async () => {
    const next = normPerms(Object.fromEntries(AI_CATS.map(c =>
      [c, Object.fromEntries([...el.querySelectorAll(`input[data-cat="${c}"]`)]
        .map(x => [x.dataset.act, x.checked]))])));
    aiPermsCur = next;
    try { await setSetting('ai_perms', next); toast('AI 權限已更新', 'toast-success'); }
    catch (e) { toast('權限寫入失敗：' + (e?.message || e), 'toast-error'); aiPermsRender(aiPermsCur); }
  }));
}

function aiChatRender() {
  const el = document.getElementById('aiChatLog');
  if (!el) return;
  if (!bChat.length) {
    el.innerHTML = '<div style="color:var(--text-tertiary);font-size:12px">還沒有對話。權限沒開時它碰不到任何資料，只能閒聊。</div>';
    return;
  }
  el.innerHTML = bChat.slice(-40).map(m => {
    if (m.role === 'user') return `<div style="text-align:right;margin:6px 0"><span style="display:inline-block;max-width:88%;padding:5px 10px;background:var(--accent);color:var(--accent-on);border-radius:10px 10px 2px 10px;font-size:13px;text-align:left;white-space:pre-wrap">${esc(m.content)}</span></div>`;
    if (m.role === 'tool') return `<div style="margin:4px 0;font-family:var(--mono);font-size:11px;color:var(--text-tertiary);background:var(--bg-elevated);border-left:2px solid var(--border);padding:3px 8px;white-space:pre-wrap">⚙ ${esc(m.content)}</div>`;
    return `<div style="margin:6px 0"><span style="display:inline-block;max-width:88%;padding:5px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px 10px 10px 2px;font-size:13px;white-space:pre-wrap">${esc(m.content)}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function aiChatSend() {
  if (bChatBusy) return;
  const input = document.getElementById('aiChatInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  if (input) input.value = '';
  bChat.push({ role: 'user', content: text });
  aiChatRender();
  bChatBusy = true;
  const btn = document.getElementById('aiChatSend');
  if (btn) { btn.disabled = true; btn.textContent = '思考中…'; }
  try {
    const perms = normPerms(aiPermsCur ?? await getSetting('ai_perms'));
    aiPermsCur = perms;
    const s = bankS;
    const base = ((s?.state?.llmApiUrl || '').trim() || 'http://localhost:11434')
      .replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
    await runTurn(bChat, {
      perms,
      io: AI_IO,
      ctx: { hasImage: !!aiLastImage },
      parseJson: (t, k) => parseLLMJson(t, k),
      llm: (prompt) => fetchLLM(`${base}/api/generate`, s?.state?.llmModel || 'qwen2.5:14b', prompt, undefined, [{ role: 'user', content: prompt }]),
    });
  } catch (e) {
    bChat.push({ role: 'assistant', content: '錯誤：' + (e?.message || e) });
  } finally {
    bChatBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '送出'; }
    aiChatRender();
  }
}

// ─── 手動新增／修改（同一張覆蓋層，存前過 validateQuestion） ───
function bankEditOpen(q) {
  bEdit = q
    ? { id: q.id, form: {
        type: q.type, pattern: q.pattern,
        stem: q.stem || '', options: [...(q.options || [])], answer: q.answer ?? 0,
        explain: q.explain || '', difficulty: q.difficulty || 1,
        translation: q.translation || '', reference: q.reference || '', comment: q.comment || '',
      } }
    : { id: '', form: {
        type: 'mc', pattern: bF.pat || Object.keys(BANK_TOPICS)[0],
        stem: '', options: ['', '', '', ''], answer: 0, explain: '', difficulty: 1,
        translation: '', reference: '', comment: '',
      } };
  bDel = '';
  bankEditHtml();
  document.getElementById('bankEdit')?.scrollIntoView({ block: 'nearest' });
}
// 表單 DOM → bEdit.form（切類型/儲存前收值；另一類型的既有值留著不清）
function bankReadForm() {
  if (!bEdit) return;
  const g = id => document.getElementById(id)?.value;
  const f = bEdit.form;
  if (g('beType')) f.type = g('beType');
  if (g('bePat')) f.pattern = g('bePat');
  if (f.type === 'mc') {
    if (g('beStem') != null) f.stem = g('beStem');
    f.options = [0, 1, 2, 3].map(i => g('beO' + i) ?? '');
    const r = document.querySelector('input[name="beAns"]:checked');
    if (r) f.answer = Number(r.value);
    if (g('beExp') != null) f.explain = g('beExp');
    if (g('beDif')) f.difficulty = Number(g('beDif'));
  } else {
    if (g('beZh') != null) f.translation = g('beZh');
    if (g('beRef') != null) f.reference = g('beRef');
    if (g('beCom') != null) f.comment = g('beCom');
  }
}
function bankEditHtml() {
  const el = document.getElementById('bankEdit');
  if (!el) return;
  if (!bEdit) { el.innerHTML = ''; return; }
  const f = bEdit.form;
  const selStyle = 'font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)';
  const inputStyle = 'flex:1;min-width:0;font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box';
  const ta = (id, v, ph) => `<textarea id="${id}" rows="2" placeholder="${ph}" style="width:100%;font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box;resize:vertical">${esc(v)}</textarea>`;
  const patOpts = Object.keys(BANK_TOPICS).map(p => `<option value="${p}"${p === f.pattern ? ' selected' : ''}>${p} ${esc(BANK_TOPICS[p][1])}</option>`).join('');
  const fields = f.type === 'mc' ? `
    <div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">題幹</div>${ta('beStem', f.stem, '英文題幹（空格用 ______）')}
    <div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">選項（選一個正解）</div>
    ${[0, 1, 2, 3].map(i => `<div class="tool-row" style="margin-bottom:4px;flex-wrap:nowrap">
        <span style="width:16px;font-size:12px;font-weight:600;color:var(--text-secondary)">${String.fromCharCode(65 + i)}</span>
        <input id="beO${i}" value="${esc(f.options[i] ?? '')}" style="${inputStyle}">
        <label style="font-size:12px;color:var(--text-secondary);white-space:nowrap;display:flex;align-items:center;gap:3px">
          <input type="radio" name="beAns" value="${i}"${f.answer === i ? ' checked' : ''}> 正解</label>
      </div>`).join('')}
    <div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">解析（中文）</div>${ta('beExp', f.explain, '為何對、其他選項為何錯')}
    <div class="tool-row" style="margin-top:6px"><span style="font-size:12px;color:var(--text-tertiary)">難度</span>
      <select id="beDif" style="${selStyle}">${[1, 2, 3].map(d => `<option value="${d}"${Number(f.difficulty) === d ? ' selected' : ''}>${d}</option>`).join('')}</select></div>`
    : `<div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">中文題目</div>${ta('beZh', f.translation, '要翻譯的中文')}
    <div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">參考譯文（英文）</div>${ta('beRef', f.reference, '正確自然的英文')}
    <div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">句型重點（中文，可空）</div>${ta('beCom', f.comment, '這題考什麼')}`;
  el.innerHTML = `
    <div class="tool-row" style="margin-bottom:6px">
      <b style="font-size:13px;color:var(--text-primary)">${bEdit.id ? esc(bEdit.id) : '新增題目'}</b>
      <select id="beType" style="${selStyle}"><option value="mc"${f.type === 'mc' ? ' selected' : ''}>多選</option><option value="translate"${f.type === 'translate' ? ' selected' : ''}>翻譯</option></select>
      <select id="bePat" style="${selStyle};max-width:100%">${patOpts}</select>
    </div>
    ${fields}
    <div class="tool-row" style="margin-top:8px">
      <button class="btn btn-primary" id="beSave">儲存</button>
      <button class="btn" id="beCancel">取消</button>
    </div>`;
  document.getElementById('beSave')?.addEventListener('click', bankSaveEdit);
  document.getElementById('beCancel')?.addEventListener('click', () => { bEdit = null; bankEditHtml(); });
  document.getElementById('beType')?.addEventListener('change', e => { bankReadForm(); bEdit.form.type = e.target.value; bankEditHtml(); });
}
async function bankSaveEdit() {
  bankReadForm();
  const f = bEdit.form;
  const chapter = Number(String(f.pattern).split('-')[0]) || 1;
  const q = f.type === 'mc'
    ? { type: 'mc', stem: (f.stem || '').trim(), options: (f.options || []).slice(0, 4).map(s => String(s).trim()),
        answer: f.answer, explain: (f.explain || '').trim(), difficulty: Number(f.difficulty) || 1,
        pattern: f.pattern, chapter, axis: axisOf(f.pattern) }
    : { type: 'translate', translation: (f.translation || '').trim(), reference: (f.reference || '').trim(),
        comment: (f.comment || '').trim(), pattern: f.pattern, chapter, axis: axisOf(f.pattern) };
  const err = validateQuestion(q);
  if (err) { toast('格式不合格：' + err, 'toast-error'); return; }
  const nv = { up: { ...bOv.up }, rm: [...bOv.rm] };
  const id = bEdit.id || nextQid(bankAll(), q.pattern, q.type === 'mc' ? 'mc' : 'tr');
  nv.up[id] = { ...q, id };
  try { await setSetting('grammar_bank_overlay', nv); }
  catch (e) { toast('儲存失敗：' + (e?.message || e), 'toast-error'); return; }
  bOv = nv;
  bEdit = null;
  bankEditHtml(); bankFillList();
  toast('已儲存 ' + id, 'toast-success');
}

export function render(s) {
  const tasks = s.state.backgroundTasks || [];
  const running = tasks.filter(t => t.status === 'running');
  const done = tasks.filter(t => t.status !== 'running');
  const _selHtml = (id, opts, fallback) => `<div class="cs" id="${id}Cs"><button class="cs-t" data-id="${id}" data-value="${fallback}"><span class="cs-lbl">${opts.find(o=>o[1]===fallback)[0]}</span>${icon('chevron-down', 10, 'cs-a')}</button><div class="cs-m">${opts.map(o=>`<div class="cs-o${o[1]===fallback?' s':''}" data-value="${o[1]}">${o[0]}</div>`).join('')}</div></div>`;
  return `
    <style>
      .tool-progress{display:flex;align-items:center;gap:var(--s2);margin-top:var(--s2)}
      .tool-progress-bar{height:6px;background:var(--accent);border-radius:3px;transition:width .2s;max-width:100%}
      .tool-progress span{font-size:12px;color:var(--text-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
      .task-item{display:flex;align-items:center;gap:var(--s2);padding:6px 8px;margin-bottom:4px;background:var(--bg-elevated);border-radius:var(--r-sm);font-size:13px}
      .task-item .task-label{flex:1;color:var(--text-primary)}
      .task-item .task-status{font-size:11px;color:var(--text-tertiary)}
      .task-item .task-dismiss{cursor:pointer;color:var(--text-tertiary);font-size:16px;line-height:1;padding:0 4px}
      .task-item .task-dismiss:hover{color:var(--text-primary)}
      .tool-row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
      .cs{position:relative;font-size:12px;min-height:30px;flex-shrink:1;min-width:0}
      .cs-t{display:flex;align-items:center;gap:6px;width:100%;height:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);cursor:pointer;white-space:nowrap;transition:border-color .15s;font-family:inherit;font-size:inherit;min-width:0;overflow:hidden}
      .cs-lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
      .cs-t:hover,.cs.o .cs-t{border-color:var(--accent)}
      .cs-a{margin-left:auto;transition:transform .15s;flex-shrink:0}
      .cs.o .cs-a{transform:rotate(180deg)}
      .cs-m{display:none;position:absolute;top:100%;left:0;right:0;margin-top:2px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);overflow:hidden;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3)}
      .cs.o .cs-m{display:block}
      .cs-o{padding:6px 10px;cursor:pointer;color:var(--text-primary);transition:background .1s}
      .cs-o:hover{background:var(--bg-hover)}
      .cs-o.s{color:var(--accent);font-weight:600}
      .switch-sm{width:32px;height:18px;flex-shrink:0}
      .switch-sm::after{width:12px;height:12px;top:2px;left:3px}
      .switch-sm.on::after{left:15px}
      /* 一鍵全補每列：來源選單可壓縮（ellipsis），其餘固定項不換行，
         否則窄螢幕會把「覆寫」開關擠到下一行（2026-09-25 手機實測） */
      .combo-row{display:flex;align-items:center;gap:var(--s2);flex-wrap:nowrap;min-width:0}
      .combo-name{font-size:12px;min-width:44px;color:var(--text-secondary);flex-shrink:0}
      .combo-ow{font-size:11px;color:var(--text-tertiary);flex-shrink:0;white-space:nowrap}
      /* 窄螢幕（手機 360px → 容器約 270px）：收固定項預算，讓來源名稱不被截斷 */
      @media (max-width:420px){
        .combo-row{gap:5px}
        .combo-name{min-width:36px}
        .combo-ow{font-size:10px}
      }
    </style>
    <div class="page-title">${icon('tools')} 工具</div>
    <div class="page-subtitle">輔助工具，幫你整理單字庫</div>

    <!-- A套：快速入口（三卡橫排；手機自動塌單欄） -->
    <div class="section">
      <div class="grid grid-3">
        <div class="card card-interactive" id="toolsGoSimulator" style="cursor:pointer">
          <div style="display:flex;align-items:center;gap:var(--s3)">
            <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('chart')}</div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary)">學習分析</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">成熟度、複習統計、模擬圖表</div>
            </div>
          </div>
        </div>
        <!-- OCR Recognize → 獨立工具頁入口 -->
        <div class="card card-interactive" id="toolsGoOcr" style="cursor:pointer">
          <div style="display:flex;align-items:center;gap:var(--s3)">
            <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('camera')}</div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary)">OCR 辨識字卡</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">拍照或選圖，圈選辨識入字本</div>
            </div>
          </div>
        </div>
        ${s.state.devMode ? `
        <div class="card card-interactive" id="toolsGoAppLog" style="cursor:pointer">
          <div style="display:flex;align-items:center;gap:var(--s3)">
            <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--green-container, var(--accent-container));display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--green, var(--accent));flex-shrink:0">${icon('list')}</div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text-primary)">操作日誌</div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">操作記錄與模擬歷史 (隔離 DB)</div>
            </div>
          </div>
        </div>
        ` : ''}
      </div>
    </div>

    <div class="section" id="bgTaskSection">
      <div class="section-title">${icon('activity')} 背景任務</div>
      <div class="card">
      <div id="bgTaskConfig">
        ${running.map(t => `
          <div class="task-item" data-task-id="${t.id}">
            <span class="task-label">${t.label}</span>
            <div style="flex:1;max-width:200px">
              <div style="display:flex;align-items:center;gap:6px">
                <div style="flex:1;height:6px;background:var(--bg-base);border-radius:3px;overflow:hidden">
                  <div class="task-progress-fill" style="width:${t.total > 0 ? (t.done / t.total * 100) : 0}%;height:100%;background:var(--accent);border-radius:3px;transition:width .3s"></div>
                </div>
                <span class="task-status">${t.done}/${t.total}</span>
              </div>
            </div>
            <span style="color:var(--accent);font-size:11px">進行中...</span>
          </div>
        `).join('')}
        ${done.map(t => `
          <div class="task-item" data-task-id="${t.id}" style="opacity:.7">
            <span class="task-label">${t.label}</span>
            <span class="task-status" style="color:${t.status === 'failed' ? 'var(--red)' : 'var(--green)'}">${t.status === 'failed' ? '失敗' : '完成'} (${t.total} 筆)</span>
            <span class="task-dismiss" data-dismiss="${t.id}">×</span>
          </div>
          ${t.result && t.result.type === 'spellcheck' ? renderSpellResult(t.result) : ''}
          ${t.result && t.result.type === 'summary' ? `
          <div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r-sm);font-size:12px;color:var(--text-secondary)">${t.result.message}</div>
          ` : ''}
        `).join('')}
      </div><!-- /bgTaskConfig -->
      </div><!-- /card -->
    </div>

    <!-- A套：檢查與清理家族（兩卡並排） -->
    <div class="section">
      <div class="section-title">${icon('search')} 檢查與清理</div>
      <div class="grid grid-2 tool-grid">
        <div class="card">
          <div class="card-title">${icon('search')} 尋找重複</div>
          <div class="card-desc">掃描字庫中的重複單字</div>
          <div><button class="btn" onclick="window.__findIssues()">${icon('search')} 開始掃描</button></div>
          <div class="tool-output" id="issuesResult" style="margin-top:var(--s3);display:none"></div>
        </div>
        <div class="card">
          <div class="card-title">${icon('edit')} 拼字檢查</div>
          <div class="card-desc">用 LLM 檢查單字拼字是否正確</div>
          <div><button class="btn" onclick="window.__spellCheckLLM()">${icon('edit')} 開始檢查</button></div>
          <div class="tool-output" id="spellResult" style="margin-top:var(--s3);display:none"></div>
        </div>
      </div>
    </div>

    <!-- A套：自動補齊家族（組合包＋九卡網格；手機塌單欄） -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動補齊</div>
      <div class="card-desc">為缺少欄位的單字自動補上詞性、例句、發音、相關詞、詞形、中文翻譯、同義詞、反義詞、片語、字源與音節（下面一鍵全補組合包，各欄可各別開關＋選來源）</div>
    <!-- 組合包：一鍵全補（2026-09-08 使用者裁示：裸詞一次填滿，各欄來源可調＋記憶＋可收合；COMBO1 起十一欄各別開關，獨立卡併入） -->
      <div class="card" style="margin-bottom:var(--s3)">
        <div class="card-title">${icon('sparkle')} 一鍵全補組合包</div>
        <div class="card-desc">只挑已啟用欄位全空的裸詞（只有單字），按下面選的來源一次填完；字源/音節只吃韋氏；開關關掉的欄位不會動；每欄「覆寫」開＝該欄直接覆蓋原本內容（預設全關＝只補缺失）。範圍可選一或多個字本（沒選＝全部）、加入時間可限某日以前/以後。來源選擇、開關與覆寫都會記住（含收合狀態）。</div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          <button class="btn btn-sm" id="comboToggle">收合來源設定 ▾</button>
          <button class="btn" onclick="window.__comboFull()">${icon('sparkle')} 開始全補</button>
          <button class="btn btn-sm" id="comboAllOn">全選</button>
          <button class="btn btn-sm" id="comboAllOff">全關</button>
          <button class="btn btn-sm" id="comboOwAllOn">覆寫全開</button>
          <button class="btn btn-sm" id="comboOwAllOff">覆寫全關</button>
        </div>
        <div id="comboScopeDeck" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:var(--s2)">
          <span class="muted" style="font-size:12px;font-weight:600">範圍：</span>
          <button class="exam-deck-chip selected" data-scope="">全部</button>
          ${(s.state.decks || []).map(d => `<button class="exam-deck-chip" data-scope="${esc(d.name)}"><span style="width:7px;height:7px;border-radius:50%;background:${d.color || 'var(--text-tertiary)'};display:inline-block"></span>${esc(d.name)}</button>`).join('')}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:var(--s2)">
          <span class="muted" style="font-size:12px;font-weight:600">加入時間：</span>
          <select id="comboDateMode" style="font-size:12px"><option value="">不限</option><option value="before">以前</option><option value="after">以後</option></select>
          <input type="date" id="comboDate" style="font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary)">
        </div>
        <div id="comboSrcGrid" style="display:grid;gap:var(--s2);margin-bottom:var(--s2)">
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_pos" role="switch" aria-checked="true" title="是否補詞性"></div><span class="combo-name">詞性</span>${_selHtml('comboPos', [['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_pos" role="switch" aria-checked="false" title="覆寫已有詞性"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_example" role="switch" aria-checked="true" title="是否補例句"></div><span class="combo-name">例句</span>${_selHtml('comboExample', [['字典 API','dictionary-api'],['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['Tatoeba 例句','tatoeba'],['本地 LLM','llm']], 'dictionary-api')}<div class="switch switch-sm" id="comboOw_example" role="switch" aria-checked="false" title="覆寫已有例句"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_pron" role="switch" aria-checked="true" title="是否補發音"></div><span class="combo-name">發音</span>${_selHtml('comboPron', [['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_pron" role="switch" aria-checked="false" title="覆寫已有發音"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_related" role="switch" aria-checked="true" title="是否補相關詞"></div><span class="combo-name">相關詞</span>${_selHtml('comboRelated', [['本地 LLM','llm'],['韋氏字典','merriam']], 'llm')}<div class="switch switch-sm" id="comboOw_related" role="switch" aria-checked="false" title="覆寫已有相關詞"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_forms" role="switch" aria-checked="true" title="是否補詞形"></div><span class="combo-name">詞形</span>${_selHtml('comboForms', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_forms" role="switch" aria-checked="false" title="覆寫已有詞形"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_trans" role="switch" aria-checked="true" title="是否補翻譯"></div><span class="combo-name">翻譯</span>${_selHtml('comboTrans', [['Cambridge 英中','cambridge'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_trans" role="switch" aria-checked="false" title="覆寫已有翻譯"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_syn" role="switch" aria-checked="true" title="是否補同義詞"></div><span class="combo-name">同義詞</span>${_selHtml('comboSyn', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_syn" role="switch" aria-checked="false" title="覆寫已有同義詞"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_ant" role="switch" aria-checked="true" title="是否補反義詞"></div><span class="combo-name">反義詞</span>${_selHtml('comboAnt', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_ant" role="switch" aria-checked="false" title="覆寫已有反義詞"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_phrase" role="switch" aria-checked="true" title="是否補片語"></div><span class="combo-name">片語</span>${_selHtml('comboPhrase', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_phrase" role="switch" aria-checked="false" title="覆寫已有片語"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_etymology" role="switch" aria-checked="true" title="是否補字源"></div><span class="combo-name">字源</span><span style="font-size:12px;color:var(--text-tertiary)">韋氏字典（固定）</span><div class="switch switch-sm" id="comboOw_etymology" role="switch" aria-checked="false" title="覆寫已有字源"></div><span class="combo-ow">覆寫</span></div>
          <div class="combo-row"><div class="switch switch-sm on" id="comboOn_syllables" role="switch" aria-checked="true" title="是否補音節"></div><span class="combo-name">音節</span><span style="font-size:12px;color:var(--text-tertiary)">韋氏字典（固定）</span><div class="switch switch-sm" id="comboOw_syllables" role="switch" aria-checked="false" title="覆寫已有音節"></div><span class="combo-ow">覆寫</span></div>
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;white-space:nowrap;flex-shrink:0">少於</label>
          <input id="exampleThreshold" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句就新增</label>
          <input id="exampleCount" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句＆顯示最多</label>
          <input id="exampleDisplayMax" type="number" value="${window.__maxExampleLines ?? 0}" min="0"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句(0=全顯示)</label>
        </div>
        <!-- DICTREBUILD：AI API 位址／模型已移入「設定 → 韋氏字典 → API」 -->
        <div class="tool-output" id="comboResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div><!-- /自動補齊 section -->

    <!-- A套：字典查詢家族 -->
    <div class="section">
      <div class="section-title">${icon('book')} 字典查詢</div>
      <div class="card">
        <div class="card-title">${icon('book')} Cambridge 字典查詢</div>
        <div class="card-desc">從 Cambridge Dictionary 查詢單字定義、IPA、例句</div>
         <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2)">
           ${_selHtml('cambridgeDict', [['英英','en'],['英中','zh']], 'en')}
            <input id="cambridgeWord" type="text" placeholder="輸入英文單字"
              style="flex:1;min-width:0;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
           <button class="btn" onclick="window.__lookupCambridge()">${icon('search')} 查詢</button>
         </div>
        <div class="tool-output" id="cambridgeResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- 文法題庫管理 gate：核心未匯入（預設可見；bankLoad 就位後反轉） -->
    <div class="section" id="bankGate">
      <div class="section-title">${icon('layers')} 文法題庫管理</div>
      <div class="card" style="text-align:center;padding:24px">
        <div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:6px">核心題庫尚未匯入</div>
        <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">出題／刪題要疊在核心題庫上；匯入題包後才可用（成品與內建無差）</div>
        <button class="btn btn-primary" id="bankGateImport">${icon('download')} 匯入核心題庫</button>
      </div>
    </div>

    <!-- 文法題庫管理：AI 出題／刪題 → settings 覆蓋層（文法頁載入合併，免重編譯） -->
    <div class="section" id="bankSection" hidden>
      <div class="section-title">${icon('layers')} 文法題庫管理</div>
      <div class="card" style="margin-bottom:var(--s3)">
        <div class="card-title">${icon('wand')} AI 出題</div>
        <div class="card-desc">選句型與題數 → LLM 依既定 schema 出題 → 預覽（✓＝正解）→ 確認入庫。寫入 DB 覆蓋層，不動打包題庫、不需重編譯。</div>
        <div class="tool-row" style="margin-top:var(--s2)">
          <select id="bankPat" style="font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);max-width:100%">
            ${Object.keys(BANK_TOPICS).map(p => `<option value="${p}">${p} ${esc(BANK_TOPICS[p][1])}</option>`).join('')}
          </select>
          <select id="bankType" style="font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
            <option value="mc">多選</option>
            <option value="translate">翻譯</option>
          </select>
          <select id="bankN" style="font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
            ${[1,2,3,4,5].map(n => `<option value="${n}"${n === 3 ? ' selected' : ''}>${n} 題</option>`).join('')}
          </select>
          <button class="btn btn-primary" id="bankGen">生成</button>
        </div>
        <textarea id="bankPrompt" rows="3" placeholder="材料（選填）：貼課文／文法重點／單字表 → 按生成會帶進 prompt；或直接貼 API 回傳的題目 JSON（{results:[…]} 或裸陣列）→ 按生成直接匯入預覽"
          style="width:100%;margin-top:6px;font-size:12px;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box;resize:vertical"></textarea>
        <div id="bankPreview" style="margin-top:var(--s2)"></div>
      </div>
      <div class="card" style="margin-bottom:var(--s3)">
        <div class="card-title">${icon('edit')} 新增與修改</div>
        <div class="card-desc">手動新增一題，或按下方列表的「編輯」載入修改；儲存前一樣過既定 schema 檢查，寫入同一個覆蓋層。</div>
        <div class="tool-row" style="margin-top:var(--s2)">
          <button class="btn" id="bankNew">${icon('plus')} 新增題目</button>
        </div>
        <div id="bankEdit" style="margin-top:var(--s2)"></div>
      </div>
      <div class="card">
        <div class="card-title">${icon('trash')} 刪題</div>
        <div class="card-desc">題庫共 <b id="bankCount">…</b> 題（含 AI 新增）。刪除＝標進覆蓋層，文法頁起不再出題。</div>
        <div class="tool-row" style="margin-top:var(--s2)">
          <select id="bankFPat" style="font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);max-width:100%">
            <option value="">全部句型</option>
            ${Object.keys(BANK_TOPICS).map(p => `<option value="${p}">${p} ${esc(BANK_TOPICS[p][1])}</option>`).join('')}
          </select>
          <select id="bankFType" style="font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
            <option value="">全部類型</option>
            <option value="mc">多選</option>
            <option value="translate">翻譯</option>
          </select>
          <input id="bankQ" type="text" placeholder="搜尋題幹／中文…" style="flex:1;min-width:120px;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
        </div>
        <div id="bankList" style="margin-top:var(--s2)"></div>
      </div>
    </div>

    <!-- AI 助手：逐類別權限矩陣（預設全關 fail-closed）→ 聊天 agent 只碰打開的類別 -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} AI 助手</div>
      <div class="card" style="margin-bottom:var(--s3)">
        <div class="card-title">${icon('shield')} 權限矩陣</div>
        <div class="card-desc">預設全關＝AI 物理摸不到：資料不注入、工具不給、寫入直接拒。讀/寫/刪逐類別開；<b>ai_perms 本身 AI 永遠改不了</b>（防自我授權），只有這張表能動。</div>
        <div id="aiPermsGrid" style="margin-top:var(--s2);max-width:340px"></div>
      </div>
      <div class="card">
        <div class="card-title">${icon('brain')} 聊天</div>
        <div class="card-desc">用上面的權限對話與操作（分析、增刪題、讀寫設定/單字庫）；可附加文字檔（txt/md/json/csv）。工具軌跡列在對話裡；LLM 走設定頁的 API 設定。</div>
        <div id="aiChatLog" style="max-height:320px;min-height:110px;overflow:auto;padding:8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;line-height:1.6;margin-top:var(--s2)"></div>
        <div class="tool-row" style="margin-top:var(--s2)">
          <input id="aiChatInput" type="text" placeholder="例：幫我分析題庫覆蓋 / 刪掉 g-1-1-mc-3 / llmModel 現在是什麼"
            style="flex:1;min-width:0;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
          <button class="btn" id="aiChatAttach" title="附加檔案：文字檔直接讀、圖片給 AI 的 OCR 工具、其他格式會明說無法讀取">${icon('upload')}</button>
          <button class="btn btn-primary" id="aiChatSend">送出</button>
          <input type="file" id="aiChatFile" style="display:none">
        </div>
      </div>
    </div>
  `;
}

function renderSpellResult(r) {
  if (!r.entries || !r.entries.length) return `<div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r-sm);font-size:12px;color:var(--green)">${icon('check')} 所有單字拼字正確！</div>`;
  let html = `<div style="margin:4px 0 4px 24px;padding:6px 8px;background:var(--bg-base);border-radius:var(--r-sm)"><div style="margin-bottom:4px;font-size:12px;color:var(--text-secondary)">發現 ${r.entries.length} 個可能拼錯的單字：</div>`;
  for (const e of r.entries) {
    html += `<div style="display:flex;align-items:center;gap:var(--s2);padding:4px 6px;margin-bottom:2px;background:var(--bg-elevated);border-radius:var(--r-sm);font-size:13px">
      <span style="flex:1;color:var(--red);text-decoration:line-through">${e.wrong}</span>
      <span style="font-size:12px;color:var(--text-tertiary)">→</span>
      <span style="flex:1;color:var(--green);font-weight:600">${e.right}</span>
      <span style="font-size:11px;color:var(--text-quaternary)">${e.count} 筆</span>
      <button class="btn btn-sm spell-apply" data-wrong="${e.wrong}" data-right="${e.right}" style="font-size:11px;padding:2px 10px">套用</button>
    </div>`;
  }
  html += `<button class="btn" id="spellApplyAll" style="margin-top:4px;font-size:11px">${icon('check')} 全部套用</button></div>`;
  return html;
}

// BH-04: module 級 flag 擋重複綁定常駐 document click（仿 lib/custom-select.js G5 _globalDocBound；須在 onMount 外，renderPage 每次導航重跑 onMount 會重生閉包內變數）
let _toolsCsBound = false;

// ─── 來源記憶（2026-09-08 使用者裁示）：全部來源選單＋組合包收合狀態＋欄位開關（COMBO1）───
// 存 db setting methodSources（JSON；demo 走記憶體）。恢復時直接讀 DOM 選項
// 反查 label，不在 JS 另存選項表（render 改選項不用同步這裡）。
let _srcMem = null; // { selectors: {id: value}, comboCollapsed: bool, comboOn: {field: bool}, comboOw: {field: bool} }
const _SRC_BLOB_KEY = 'methodSources';
function _saveSrcMem() {
  const snap = JSON.stringify(_srcMem || {});
  setSetting(_SRC_BLOB_KEY, snap).catch(() => {});
}
function _applySrcMem() {
  if (!_srcMem) return;
  const sel = _srcMem.selectors || {};
  for (const [id, val] of Object.entries(sel)) {
    const p = document.getElementById(id + 'Cs');
    if (!p) continue;
    const o = p.querySelector(`.cs-o[data-value="${val}"]`);
    if (!o) continue;
    const t = p.querySelector('.cs-t');
    t.dataset.value = val;
    if (t.childNodes[0]) t.childNodes[0].textContent = o.textContent;
    p.querySelectorAll('.cs-o').forEach(c => c.classList.toggle('s', c === o));
  }
  // COMBO1: 欄位開關恢復（沒存過＝全開，DOM 預設即全開）
  // COMBO2: 每欄覆寫開關恢復（沒存過＝全關，DOM 預設即全關）
  const on = _srcMem.comboOn || {};
  for (const [f, v] of Object.entries(on)) {
    const el = document.getElementById('comboOn_' + f);
    if (!el) continue;
    el.classList.toggle('on', !!v);
    el.setAttribute('aria-checked', String(!!v));
  }
  const ow = _srcMem.comboOw || {};
  for (const [f, v] of Object.entries(ow)) {
    const el = document.getElementById('comboOw_' + f);
    if (!el) continue;
    el.classList.toggle('on', !!v);
    el.setAttribute('aria-checked', String(!!v));
  }
  if (_srcMem.comboCollapsed) {
    document.getElementById('comboSrcGrid')?.style.setProperty('display', 'none');
    const tg = document.getElementById('comboToggle');
    if (tg) tg.textContent = '展開來源設定 ▸';
  }
}
/** KEEPALIVE1：包一層把 onMount 內的全域查詢限制在本頁圖層內（見 lib/scope-dom.js） */
export function onMount(s) {
  return withPageScope(pageRoot(), () => _mount(s));
}
function _mount(s) {
  document.getElementById('toolsGoSimulator')?.addEventListener('click', () => s.actions.navigate('simulator'));
  document.getElementById('toolsGoAppLog')?.addEventListener('click', () => s.actions.navigate('app-log'));
  document.getElementById('toolsGoOcr')?.addEventListener('click', () => s.actions.navigate('ocr'));
  window.__dismissTask = (id) => s.actions.dismissBackgroundTask(id);
  document.getElementById('bgTaskConfig')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-dismiss');
    if (btn) window.__dismissTask(btn.dataset.dismiss);
  });
  window.__toolsOnMountStatus = 'onMount_started';

  const tasks = s.state.backgroundTasks || [];
  const spellTask = tasks.find(t => t.status === 'done' && t.result && t.result.type === 'spellcheck');
  if (spellTask) {
    const container = document.getElementById('spellResult');
    if (container) {
      container.innerHTML = renderSpellResult(spellTask.result);
      container.style.display = 'block';
      container.querySelectorAll('.spell-apply').forEach(btn => btn.addEventListener('click', () => __applyOne(btn.dataset.wrong, btn.dataset.right, btn)));
      document.getElementById('spellApplyAll')?.addEventListener('click', () => container.querySelectorAll('.spell-apply').forEach(b => b.click()));
    }
  }

  let _prevBgTasks = '';
  const _unsub = s.subscribe((state) => {
    const tasks = state.backgroundTasks || [];
    const now = JSON.stringify(tasks.map(t => ({ id: t.id, done: t.done, total: t.total, status: t.status })));
    if (now === _prevBgTasks) return;
    _prevBgTasks = now;
    requestAnimationFrame(() => {
      const section = document.getElementById('bgTaskConfig');
      const taskIds = new Set(tasks.map(t => t.id));
      document.querySelectorAll('.task-item').forEach(el => { if (!taskIds.has(el.dataset.taskId)) el.remove(); });
      for (const t of tasks) {
        let el = document.querySelector(`.task-item[data-task-id="${t.id}"]`);
        if (!el && t.status === 'running') {
          const div = document.createElement('div');
          div.className = 'task-item';
          div.dataset.taskId = t.id;
          div.innerHTML = `<span class="task-label">${t.label}</span><div style="flex:1;max-width:200px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:6px;background:var(--bg-base);border-radius:3px;overflow:hidden"><div class="task-progress-fill" style="width:0%;height:100%;background:var(--accent);border-radius:3px;transition:width .3s"></div></div><span class="task-status">0/${t.total}</span></div></div><span style="color:var(--accent);font-size:11px">進行中...</span>`;
          section?.prepend(div);
        } else if (el) {
          if (t.status !== 'running') {
            el.innerHTML = `<span class="task-label">${t.label}</span><span class="task-status" style="color:${t.status === 'failed' ? 'var(--red)' : 'var(--green)'}">${t.status === 'failed' ? '失敗' : '完成'} (${t.total} 筆)</span><span class="task-dismiss" data-dismiss="${t.id}">×</span>`;
          } else {
            const bar = el.querySelector('.task-progress-fill');
            const label = el.querySelector('.task-status');
            if (bar) bar.style.width = t.total > 0 ? `${(t.done / t.total) * 100}%` : '0%';
            if (label) label.textContent = `${t.done}/${t.total}`;
          }
        }
      }
    });
  });
  window.__pageCleanup = () => { _unsub(); delete window.__pageCleanup; };

  // ponytail: shared LLM model detection
  // DICTREBUILD: 位址與模型改由「設定 → 韋氏字典 → API」讀取（原本的輸入框已移入設定）。
  // 設定留空時沿用本地預設，行為與改動前相同。
  async function detectModel(resultElId) {
    const baseUrl = ((s.state.llmApiUrl || '').trim() || 'http://localhost:11434').replace(/\/api\/generate$/, '').replace(/\/chat\/completions$/, '');
    let model = (s.state.llmModel || '').trim();
    if (model) return { baseUrl, model };
    const el = document.getElementById(resultElId);
    if (!el) return null;
    el.style.display = 'block';
    try {
      el.innerHTML = `<div>偵測本地 AI 模型...</div>`;
      const resp = await fetchGet(`${baseUrl}/api/tags`);
      const list = (JSON.parse(resp).models || []).map(m => m.name);
      if (!list.length) { el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無可用模型</div>`; return null; }
      model = list[0];
      return { baseUrl, model };
    } catch (e) {
      el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無法連線 AI API（${baseUrl}）：${String(e?.message || e)}——請到「設定 → 韋氏字典 → API」確認位址</div>`;
      return null;
    }
  }

  // ponytail: read method selector value
  function _getMethod(id, fallback) {
    const el = document.getElementById(id + 'Cs');
    return el ? el.querySelector('.cs-t').dataset.value : fallback;
  }

  function _initCustomSelects() {
    if (_toolsCsBound) return; _toolsCsBound = true;
    document.addEventListener('click', e => {
      const t = e.target.closest('.cs-t');
      document.querySelectorAll('.cs.o').forEach(c => { if (c !== t?.closest('.cs')) c.classList.remove('o'); });
      if (t) { t.closest('.cs').classList.toggle('o'); return; }
      const o = e.target.closest('.cs-o');
      if (o) {
        const p = o.closest('.cs');
        const t = p.querySelector('.cs-t');
        t.dataset.value = o.dataset.value;
        t.childNodes[0].textContent = o.textContent;
        p.querySelectorAll('.cs-o').forEach(c => c.classList.toggle('s', c === o));
        p.classList.remove('o');
        // 來源記憶：任何來源選單（含組合包）切換即存
        if (t.dataset.id) {
          _srcMem = _srcMem || { selectors: {}, comboCollapsed: false };
          _srcMem.selectors = _srcMem.selectors || {};
          _srcMem.selectors[t.dataset.id] = o.dataset.value;
          _saveSrcMem();
        }
      }
    });
  }

  // ─── Duplicate Finder ─────────────────────────
  window.__findIssues = () => {
    const words = s.state.words;
    const container = document.getElementById('issuesResult');
    if (!container) return;
    const issues = [];
    const seen = new Map();
    for (const w of words) {
      const lower = w.word?.toLowerCase().trim();
      if (!lower) continue;
      if (seen.has(lower)) issues.push(`${icon('info')} 重複: 「${esc(lower)}」(${esc(seen.get(lower))} / ${esc(w.id)})`);
      seen.set(lower, w.id);
    }
    const noDef = words.filter(w => !w.definition || w.definition.trim() === '');
    if (noDef.length > 0) {
      issues.push(`${icon('edit')} 缺少定義: ${noDef.length} 詞`);
      noDef.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${esc(w.word)}</span>`));
    }
    const noPos = words.filter(w => !w.pos);
    if (noPos.length > 0) {
      issues.push(`${icon('hash')} 缺少詞性: ${noPos.length} 詞`);
      noPos.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${esc(w.word)}</span>`));
    }
    container.style.display = 'block';
    if (issues.length === 0) {
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} 沒發現問題！</div>`;
      toast('掃描完成，無問題', 'toast-success');
    } else {
      container.innerHTML = issues.map(i => `<div style="padding:2px 0;font-size:12px">${i}</div>`).join('');
      toast(`發現 ${issues.length} 個問題`, '');
    }
  };

  // ─── 來源記憶載入＋組合包收合開關（每導航一次跑一次；存檔走 module 級 _srcMem）───
  getSetting(_SRC_BLOB_KEY).then(v => {
    try {
      // AUTOFILL0：getSetting 對 JSON 字串已先 parse（db.js:649），所以 v 回來就是物件。
      // 舊碼對物件再 JSON.parse → String(物件)="[object Object]" → 必 throw → 永遠走 catch
      // → 來源選擇／欄位開關／逐欄覆寫在 app 重啟後全部回預設（UI 宣稱「都會記住」為假）。
      // 與 FVPERSIST1（fieldVis 記不住）同源同位置，該次只修了 array 分支、object 未修。
      const stored = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : null);
      // 合併：載入完成前使用者已點過選單/收合/開關/覆寫的話，以手上的為準（防競態洗掉）
      _srcMem = {
        selectors: { ...(stored?.selectors || {}), ...(_srcMem?.selectors || {}) },
        comboCollapsed: _srcMem ? !!_srcMem.comboCollapsed : !!stored?.comboCollapsed,
        comboOn: { ...(stored?.comboOn || {}), ...(_srcMem?.comboOn || {}) },
        comboOw: { ...(stored?.comboOw || {}), ...(_srcMem?.comboOw || {}) },
      };
    }
    catch { _srcMem = _srcMem || { selectors: {}, comboCollapsed: false }; }
    _applySrcMem();
  }).catch(() => {});
  document.getElementById('comboToggle')?.addEventListener('click', () => {
    const grid = document.getElementById('comboSrcGrid');
    const tg = document.getElementById('comboToggle');
    if (!grid || !tg) return;
    const collapsed = grid.style.display !== 'none';
    grid.style.display = collapsed ? 'none' : '';
    tg.textContent = collapsed ? '展開來源設定 ▸' : '收合來源設定 ▾';
    _srcMem = _srcMem || { selectors: {}, comboCollapsed: false };
    _srcMem.comboCollapsed = collapsed;
    _saveSrcMem();
  });
  // COMBO1: 欄位開關（點即存；全選/全關批次）
  const _setComboOn = (f, v) => {
    const el = document.getElementById('comboOn_' + f);
    if (!el) return;
    el.classList.toggle('on', !!v);
    el.setAttribute('aria-checked', String(!!v));
    _srcMem = _srcMem || { selectors: {}, comboCollapsed: false };
    _srcMem.comboOn = _srcMem.comboOn || {};
    _srcMem.comboOn[f] = !!v;
    _saveSrcMem();
  };
  document.querySelectorAll('[id^="comboOn_"]')?.forEach(el => {
    el.addEventListener('click', () => _setComboOn(el.id.replace('comboOn_', ''), !el.classList.contains('on')));
  });
  document.getElementById('comboAllOn')?.addEventListener('click', () => {
    document.querySelectorAll('[id^="comboOn_"]')?.forEach(el => _setComboOn(el.id.replace('comboOn_', ''), true));
  });
  document.getElementById('comboAllOff')?.addEventListener('click', () => {
    document.querySelectorAll('[id^="comboOn_"]')?.forEach(el => _setComboOn(el.id.replace('comboOn_', ''), false));
  });
  // COMBO2: 每欄覆寫開關（點即存，預設全關；全域覆寫開時各欄照樣跑，全關回來各欄維持）
  const _setComboOw = (f, v) => {
    const el = document.getElementById('comboOw_' + f);
    if (!el) return;
    el.classList.toggle('on', !!v);
    el.setAttribute('aria-checked', String(!!v));
    _srcMem = _srcMem || { selectors: {}, comboCollapsed: false };
    _srcMem.comboOw = _srcMem.comboOw || {};
    _srcMem.comboOw[f] = !!v;
    _saveSrcMem();
  };
  document.querySelectorAll('[id^="comboOw_"]')?.forEach(el => {
    el.addEventListener('click', () => _setComboOw(el.id.replace('comboOw_', ''), !el.classList.contains('on')));
  });
  document.getElementById('comboOwAllOn')?.addEventListener('click', () => {
    document.querySelectorAll('[id^="comboOw_"]')?.forEach(el => _setComboOw(el.id.replace('comboOw_', ''), true));
  });
  document.getElementById('comboOwAllOff')?.addEventListener('click', () => {
    document.querySelectorAll('[id^="comboOw_"]')?.forEach(el => _setComboOw(el.id.replace('comboOw_', ''), false));
  });
  // 範圍 chips：沒選＝全部字本；點「全部」清掉其它，點字本則收掉「全部」
  document.getElementById('comboScopeDeck')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    const wrap = document.getElementById('comboScopeDeck');
    const chips = [...wrap.querySelectorAll('[data-scope]')];
    const deckChips = chips.filter(c => c.dataset.scope);
    if (b.dataset.scope === '') {
      deckChips.forEach(c => c.classList.remove('selected'));
      b.classList.add('selected');
    } else {
      b.classList.toggle('selected');
      chips.find(c => c.dataset.scope === '')?.classList.toggle('selected', !deckChips.some(c => c.classList.contains('selected')));
    }
  });

  // ─── 組合包：一鍵全補（2026-09-08 使用者裁示；COMBO1 起十一欄各別開關，獨立卡併入；COMBO2 起每欄覆寫開關）───
  // 只做已啟用欄位全空的裸詞（覆寫開＝全量）。每詞各來源最多抓一次（cam英/cam中/
  // 韋氏/dictapi/tatoeba 快取），各欄拼成一個 patch、一次 editWord。
  const COMBO_FIELDS = ['pos', 'example', 'pron', 'related', 'forms', 'trans', 'syn', 'ant', 'phrase', 'etymology', 'syllables'];
  const COMBO_CN = { pos: '詞性', example: '例句', pron: '發音', related: '相關詞', forms: '詞形', trans: '翻譯', syn: '同義詞', ant: '反義詞', phrase: '片語', etymology: '字源', syllables: '音節' };
  // 欄位→word 物件鍵（trans 寫 definition；related/forms 是陣列）
  const COMBO_KEY = { pos: 'pos', example: 'example', pron: 'pron', related: 'related', forms: 'forms', trans: 'definition', syn: 'synonym', ant: 'antonym', phrase: 'phrases', etymology: 'etymology', syllables: 'syllables' };
  function _comboOn(f) {
    const el = document.getElementById('comboOn_' + f);
    return el ? el.classList.contains('on') : true;
  }
  function _comboOnFields() {
    return COMBO_FIELDS.filter(_comboOn);
  }
  // COMBO2: 每欄覆寫開關讀值（DOM 無此鈕＝關，預設全關；全域覆寫開時該欄照樣跑）
  function _comboOw(f) {
    const el = document.getElementById('comboOw_' + f);
    return el ? el.classList.contains('on') : false;
  }
  // COMBO2: 單欄空值判定（與 _isBare 同語意，供覆寫挑字用）
  function _isEmptyField(f, w) {
    const v = w[COMBO_KEY[f]];
    if (Array.isArray(v)) return !v || v.length === 0;
    return !v || !String(v).trim();
  }
  function _exampleConfig() {
    const threshold = parseInt(document.getElementById('exampleThreshold')?.value, 10) || 1;
    const count = parseInt(document.getElementById('exampleCount')?.value, 10) || 1;
    return { threshold, count };
  }
  async function _mwLookup(word) {
    const { lookupMerriam } = await import('../lib/api.js');
    const { merriamToFields } = await import('../lib/merriam.js');
    const raw = await lookupMerriam(word, s.state.mwDictKey || '', s.state.mwThesKey || '');
    const payload = JSON.parse(raw);
    return merriamToFields(payload, word);
  }
  function _mwKeyMissing() {
    if (!((s.state.mwDictKey || '').trim() || (s.state.mwThesKey || '').trim())) {
      toast('請先在設定 → 韋氏字典填入 API Key', 'toast-error');
      return true;
    }
    return false;
  }
  function _mwErr(e) {
    const m = String(e?.message || e || '');
    if (/401/.test(m)) return 'Key 無效（401），請檢查設定 → 韋氏字典';
    if (/429/.test(m)) return '超過每日免費額度（429），明天再試';
    if (/請先在設定填入/.test(m)) return m;
    if (/timed out/.test(m)) return '韋氏請求逾時，請重試';
    return `韋氏查詢失敗：${m.slice(0, 80)}`;
  }
  function _isBare(w) {
    const empty = (v) => !v || !String(v).trim();
    const emptyArr = (a) => !a || !Array.isArray(a) || a.length === 0;
    // COMBO1: 只看已啟用欄位（關掉的欄位不列入裸詞判定；derivative 從不歸組合包管）
    for (const f of _comboOnFields()) {
      const v = w[COMBO_KEY[f]];
      if (Array.isArray(v) ? !emptyArr(v) : !empty(v)) return false;
    }
    return true;
  }

  window.__comboFull = async () => {
    // COMBO1: 只組已啟用欄位（關掉的不進 M、不判定、不顯示；字源/音節固定韋氏但可關）
    const on = _comboOnFields();
    const el = document.getElementById('comboResult');
    const say = (html) => { if (el) { el.style.display = 'block'; el.innerHTML = html; } };
    if (!on.length) {
      say(`<div style="color:var(--orange)">${icon('info')} 十一欄全關了，先開至少一欄再補。</div>`);
      toast('組合包欄位全關，請先開啟至少一欄', '');
      return;
    }
    const SRC = {
      pos: _getMethod('comboPos', 'cambridge'),
      example: _getMethod('comboExample', 'dictionary-api'),
      pron: _getMethod('comboPron', 'cambridge'),
      related: _getMethod('comboRelated', 'llm'),
      forms: _getMethod('comboForms', 'merriam'),
      trans: _getMethod('comboTrans', 'cambridge'),
      syn: _getMethod('comboSyn', 'merriam'),
      ant: _getMethod('comboAnt', 'merriam'),
      phrase: _getMethod('comboPhrase', 'merriam'),
      // AUTOFILL-ENGINE1: 字源/音節只吃韋氏（only Merriam provides these），無選單
      etymology: 'merriam',
      syllables: 'merriam',
    };
    const M = {};
    for (const f of on) M[f] = SRC[f];
    // COMBO2: 逐欄覆寫（各欄開關各管各欄，預設全關＝只補缺失）
    const owEff = {};
    for (const f of on) owEff[f] = _comboOw(f);
    const owFields = on.filter(f => owEff[f]);
    const owTag = owFields.length ? `（覆寫：${owFields.map(f => COMBO_CN[f]).join('、')}）` : '';
    // COMBO2: 挑字（裸詞＋覆寫欄有料的字；覆寫全關時退化成裸詞）
    let targets = s.state.words.filter(w => _isBare(w) || on.some(f => owEff[f] && !_isEmptyField(f, w)));
    // 範圍：一或多個字本（chips 沒選＝全部；words.deck 存字本名）
    const scope = [...document.querySelectorAll('#comboScopeDeck .exam-deck-chip.selected')].map(b => b.dataset.scope).filter(Boolean);
    if (scope.length) targets = targets.filter(w => scope.includes(w.deck || ''));
    // 加入時間：以前＝該日 23:59:59.999 前、以後＝該日 00:00 起（皆含當天）；沒 createdAt 當 0（算進以前）
    const dm = document.getElementById('comboDateMode')?.value || '';
    const dv = document.getElementById('comboDate')?.value || '';
    if (dm && dv) {
      const day = new Date(`${dv}T00:00:00`);
      const end = new Date(day); end.setDate(day.getDate() + 1);
      const dayMs = day.getTime(), endMs = end.getTime();
      targets = targets.filter(w => {
        const t = w.createdAt ? new Date(w.createdAt).getTime() : 0;
        return dm === 'before' ? t < endMs : t >= dayMs;
      });
    }
    if (!targets.length) {
      say(`<div style="color:var(--green)">${icon('check')} 沒有需要全補的單字${owFields.length || scope.length || (dm && dv) ? '' : '（已啟用欄位全空的裸詞）'}！</div>`);
      return;
    }
    const vals = Object.values(M);
    if (vals.includes('merriam') && _mwKeyMissing()) return;
    // 詞形固定 LLM → 有 LLM 欄就偵測；連不上則 LLM 欄跳過、其餘照做
    let llm = null, llmOk = false;
    if (vals.includes('llm')) {
      llm = await detectModel('comboResult');
      llmOk = !!llm;
      if (!llmOk) toast('連不上 AI API：LLM 來源的欄位會跳過，其餘照做', 'toast-warn');
    }
    const { threshold, count } = _exampleConfig();
    const CN = {};
    for (const f of on) CN[f] = COMBO_CN[f];
    const stat = {};
    const bump = (f, k) => { stat[f] = stat[f] || { ok: 0, fail: 0, skip: 0 }; stat[f][k]++; };
    const taskId = 'combo-full-' + Date.now();
    s.actions.startBackgroundTask(taskId, '一鍵全補' + owTag, targets.length);
    let doneWords = 0, emptyWords = 0, aborted = false;
    const queue = [...targets];
    const quotaHit = (e) => /401|429/.test(String(e?.message || e));
    const llmJson = async (prompt) => {
      const text = await fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
      const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
      const arr = JSON.parse(cleaned);
      return Array.isArray(arr) ? [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] : null;
    };
    async function fillWord(w) {
      // AUTOFILL-ENGINE1: 分派收斂共用引擎（getMw suggest 快拋、LLM raw/JSON
      // 雙通道、quota 中止整批語意全沿用；字源/音節走 M 固定韋氏）。
      // COMBO2: overwrite 傳逐欄表（全域開時全 true；否則各欄開關各管各欄）。
      const { fillWordFields } = await import('../lib/autofill-engine.js');
      let camEn = null, camZh = null, mwF = null, usedRemote = false;
      const getCamEn = async () => { if (!camEn) { camEn = JSON.parse(await lookupCambridge(w.word)); usedRemote = true; } return camEn; };
      const getCamZh = async () => { if (!camZh) { camZh = JSON.parse(await lookupCambridge(w.word, 'zh')); usedRemote = true; } return camZh; };
      const getMw = async () => {
        if (!mwF) { mwF = await _mwLookup(w.word); usedRemote = true; if (mwF.suggest.length) throw new Error('suggest'); }
        return mwF;
      };
      const abortMw = (e) => { aborted = true; queue.length = 0; toast(_mwErr(e), 'toast-error'); };
      const llmJson = async (prompt) => {
        const text = await fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
        const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
        const arr = JSON.parse(cleaned);
        return Array.isArray(arr) ? [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] : null;
      };
      const llmText = async (prompt) => fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
      const r = await fillWordFields({
        wordText: w.word, existing: w, methods: M, overwrite: owEff,
        threshold, count,
        fetchers: { getCamEn, getCamZh, getMw, llmJson, llmText, llmOk },
        onStat: bump,
      });
      usedRemote = usedRemote || r.usedRemote;
      if (r.aborted) { abortMw(r.abortError); return null; }
      return r.patch || {};
    }
    const CON = 3;
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0 && !aborted) {
        const w = queue.shift();
        try {
          const patch = await fillWord(w);
          if (patch === null) continue; // quota 中止
          if (Object.keys(patch).length) { await s.actions.editWord(w.id, patch); doneWords++; }
          else emptyWords++;
        } catch (e) { emptyWords++; }
        s.actions.updateBackgroundTask(taskId, doneWords + emptyWords, targets.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `一鍵全補完成：${doneWords} 詞已填${emptyWords ? `，${emptyWords} 詞無新內容` : ''}${aborted ? '（額度中止）' : ''}` });
    const lines = Object.entries(CN).map(([k, label]) => {
      const st = stat[k];
      const owMark = owEff[k] ? '（覆寫）' : '';
      if (!st || (!st.ok && !st.fail && !st.skip)) return `<div>${label}${owMark}：未執行</div>`;
      return `<div>${label}${owMark}：${st.ok} 成功${st.fail ? ` / ${st.fail} 失敗` : ''}${st.skip ? ` / ${st.skip} 跳過（無 LLM）` : ''}</div>`;
    }).join('');
    say(`<div style="color:var(--green)">${icon('check')} ${doneWords} 詞已全補${emptyWords ? `，${emptyWords} 詞無新內容` : ''}${aborted ? '（額度中止）' : ''}</div><div style="margin-top:4px;font-size:12px;color:var(--text-secondary)">${lines}</div>`);
    toast(`一鍵全補完成：${doneWords} 成功${emptyWords ? `，${emptyWords} 無新內容` : ''}`, aborted ? '' : 'toast-success');
  };

  window.__lookupCambridge = async () => {
    const word = document.getElementById('cambridgeWord')?.value?.trim();
    if (!word) { toast('請輸入單字', 'toast-warn'); return; }
    const lang = _getMethod('cambridgeDict', 'en');
    const el = document.getElementById('cambridgeResult');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<div>查詢中...</div>`;
    try {
      const json = await lookupCambridge(word, lang);
      const data = JSON.parse(json);
      let html = `<div style="padding:8px;background:var(--bg-base);border-radius:var(--r-sm)">`;
      html += `<div style="font-size:16px;font-weight:600;margin-bottom:4px">${data.word}</div>`;
      if (data.uk_ipa || data.us_ipa) {
        html += `<div style="margin-bottom:6px;font-size:13px;color:var(--text-secondary)">`;
        if (data.uk_ipa) html += `UK: ${data.uk_ipa} `;
        if (data.us_ipa) html += `US: ${data.us_ipa}`;
        html += `</div>`;
      }
        for (const s of (data.senses || [])) {
        const pos = normalizePos(s.part_of_speech || '');
        html += `<div style="margin-top:4px;padding:6px;background:var(--bg-elevated);border-radius:var(--r-sm)">`;
        html += `<div style="font-size:12px;color:var(--accent);margin-bottom:2px">${pos}${s.cefr_level ? ` <span style="color:var(--orange)">${s.cefr_level}</span>` : ''}</div>`;
        // DICTREBUILD：英中模式只回翻譯（definition 空）→ 不要留一行空白的資訊圖示
        if (s.definition) html += `<div style="font-size:13px;margin-bottom:2px">${icon('info')} ${s.definition}</div>`;
        if (s.translation) html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:2px">${icon('translate')} ${s.translation}</div>`;
        for (const ex of (s.examples || [])) {
          const txt = typeof ex === 'string' ? ex : `${ex.english}${ex.chinese ? ` / ${ex.chinese}` : ''}`;
          html += `<div style="font-size:12px;color:var(--text-tertiary);padding-left:12px">• ${txt}</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red)">${icon('error')} 查詢失敗: ${e}</div>`;
    }
  };

  document.getElementById('cambridgeWord')?.addEventListener('keydown', e => { if (e.key === 'Enter') window.__lookupCambridge(); });
  const exampleDisplayMax = document.getElementById('exampleDisplayMax');
  if (exampleDisplayMax) {
    // EXRACE1：不再從 input 預設值回寫全域——input 掛載時從全域渲染，
    // 寫回只在使用者 input 事件發生（下方 listener）。歸零窗口＝例句限數失效根因。
    getSetting('exampleDisplayMax').then(v => {
      const n = parseInt(v, 10);
      if (n > 0) { window.__maxExampleLines = n; exampleDisplayMax.value = n; }
    }).catch(() => {});
    exampleDisplayMax.addEventListener('input', () => {
      const n = parseInt(exampleDisplayMax.value, 10) || 0;
      window.__maxExampleLines = n;
      setSetting('exampleDisplayMax', String(n)).catch(() => {});
    });
  }

  // 文法題庫管理：核心＋覆蓋層載入 → 列表；出題/篩選/刪題接線
  bankS = s;
  bankLoad().then(() => { if (bankCoreReady) bankFillList(); });
  document.getElementById('bankGateImport')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      hydrateBankCore(await importBuiltin('grammar'));
      document.getElementById('bankGate').hidden = true;
      document.getElementById('bankSection').hidden = false;
      await bankLoad();   // 覆蓋層若還沒讀完就一起等
      bankFillList();
      toast('核心題庫已匯入', 'toast-success');
    } catch (err) {
      toast('匯入失敗：' + (err?.message || err), 'toast-error');
      btn.disabled = false;
    }
  });
  document.getElementById('bankGen')?.addEventListener('click', bankGen);
  document.getElementById('bankQ')?.addEventListener('input', e => { bF.q = e.target.value; bankFillList(); });
  document.getElementById('bankFPat')?.addEventListener('change', e => { bF.pat = e.target.value; bankFillList(); });
  document.getElementById('bankFType')?.addEventListener('change', e => { bF.type = e.target.value; bankFillList(); });
  document.getElementById('bankNew')?.addEventListener('click', () => bankEditOpen(null));

  // AI 助手：權限載入（fail-closed：讀不到＝全關）＋聊天接線
  getSetting('ai_perms').then(v => { aiPermsCur = normPerms(v); aiPermsRender(aiPermsCur); });
  aiChatRender();
  document.getElementById('aiChatSend')?.addEventListener('click', aiChatSend);
  document.getElementById('aiChatInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') aiChatSend(); });
  document.getElementById('aiChatAttach')?.addEventListener('click', () => document.getElementById('aiChatFile')?.click());
  document.getElementById('aiChatFile')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const input = document.getElementById('aiChatInput');
    try {
      const buf = await f.arrayBuffer();
      const u8 = new Uint8Array(buf);
      // 圖片（magic bytes）→ 存給 AI 的 ocr.last_image 工具，聊天框給佔位提示
      const isImg = (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)  // png
        || (u8[0] === 0xff && u8[1] === 0xd8)                                                 // jpeg
        || (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46)                               // gif
        || (u8[0] === 0x42 && u8[1] === 0x4d)                                                 // bmp
        || (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50);          // webp
      if (isImg) {
        aiLastImage = f;
        if (input) input.value = `【圖片 ${f.name}】`;
        toast('圖片已附加：指示 AI 用 OCR 讀取（如「照這張圖出題」）', 'toast-success');
        return;
      }
      // 其他格式 → 試著當文字解；解不動（NUL byte／大量亂碼）→ 明說無法讀取
      let text = new TextDecoder('utf-8').decode(buf);
      const probe = text.slice(0, 4000);
      const hasNul = probe.includes(String.fromCharCode(0));
      const garbage = (probe.match(/\uFFFD/g) || []).length;
      if (hasNul || garbage > Math.max(8, probe.length * 0.02)) {
        toast(`${f.name}：無法讀取（此格式不支援，先轉文字或圖片）`, 'toast-error');
        return;
      }
      if (text.length > 20000) text = text.slice(0, 20000) + '\n…（超過 2 萬字已截斷）';
      if (input) input.value = `【檔案 ${f.name}】\n${text}`;
      toast(`已附加 ${f.name}（${text.length} 字），補一句指示再送出`, 'toast-success');
    } catch (err) { toast('讀檔失敗：' + (err?.message || err), 'toast-error'); }
  });

  _initCustomSelects();
  // ponytail: inline onclick broken in WebKitGTK, use addEventListener instead
  document.querySelectorAll('button[onclick]').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/window\.__(\w+)\(/);
    if (m && typeof window['__' + m[1]] === 'function') {
      if (m[1] === 'dismissTask') {
        const id = btn.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        if (id) btn.addEventListener('click', () => window.__dismissTask(id));
      } else {
        btn.addEventListener('click', window['__' + m[1]]);
      }
      btn.removeAttribute('onclick');
    }
  });
}
