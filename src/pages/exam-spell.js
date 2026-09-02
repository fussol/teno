import { icon, splitFieldsHtml, fmtExample } from '../lib/svg.js';
import { toast } from '../main.js';
import { renderSavedSessions, buildSession } from '../core/exam-session.js';
import { bindSpeakClick } from '../lib/tts.js';

let e = {
  phase: 'config',
  decks: [],
  words: [],
  idx: 0,
  correct: 0,
  wrong: 0,
  userInput: '',
  totalTime: 0,
  cardStart: 0,
  pendingScore: null,     // B2: 延遲窗計分暫存（'correct'|'wrong'|null，不序列化；nextWord/末題按鈕/exit 時 flush）
  autoNextTimer: null,    // B2: autoNext 的 timer id（exit/重啟/恢復時清理）
  examRecorded: false,    // B4: 本場已完成並寫入 exam_history（防重：同場只記一次；startExam/resumeSession 重置）
  settings: { count: 0, autoNext: true, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function wordPool(s) {
  if (!e.decks.length) return [];
  const deckNames = new Set(s.state.decks.filter(d => e.decks.includes(d.id)).map(d => d.name));
  return s.state.words.filter(w => deckNames.has(w.deck));
}

export function render(s) {
  if (e.phase === 'result') return renderResult(s);
  if (e.phase === 'exam') return renderExam(s);
  return renderConfig(s);
}

function renderConfig(s) {
  const { decks, systemTags, tags: userTags } = s.state;
  const pool = wordPool(s);
  if (!decks.length) {
    return `<div class="page-title">${icon('edit')} 拼字測驗</div>
      <div class="page-subtitle">看定義拼出單字</div>
      <div class="empty-state" style="padding:var(--s16)">
        ${icon('box')}<h3>沒有單字</h3>
        <p>先新增或匯入單字</p>
        <button class="btn-primary" data-goto="browser">${icon('plus')} 新增單字</button>
      </div>`;
  }
  return `<div class="page-title">${icon('edit')} 拼字測驗</div>
    <div class="page-subtitle">看定義拼出單字，不影響學習進度</div>
    <div style="display:flex;flex-wrap:wrap;gap:24px;margin-top:24px;align-items:flex-start">
      ${renderSavedSessions(s.state.examSessions || [], 'spell', s.state.maxExamSessions || 5)}
      <div class="study-card" style="flex:1;max-width:480px;padding:32px">
      <div style="width:100%">
        <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:12px">${icon('book')} 選擇字本</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:12px;color:var(--text-tertiary)" id="esDeckStatus">已選 ${e.decks.length}/${decks.length} 字本</span>
          <button class="btn btn-sm" id="esToggleAll">全選</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px">
          ${decks.map(d => {
            const selected = e.decks.includes(d.id);
            return `<div class="study-opt${selected?' selected':''}" style="padding:8px 14px;margin:0" data-es-deck="${d.id}">
              <span class="dot" style="width:6px;height:6px;border-radius:50%;background:${d.color};display:inline-block;flex-shrink:0"></span>
              <span class="study-opt-text" style="font-size:13px">${d.name}</span>
            </div>`;
          }).join('')}
        </div>
        <div style="margin:16px 0;padding-top:16px;border-top:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:12px">${icon('sliders')} 設定</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)">
              <span>測驗數量</span>
              <input type="number" id="esCount" class="form-input form-number" value="${e.settings.count}" min="0" max="${pool.length}">
              <span style="font-size:11px;color:var(--text-tertiary)">0=全部 (${pool.length})</span>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary);cursor:pointer">
              <span>自動跳下一題</span>
               <input type="checkbox" id="esAutoNext" ${e.settings.autoNext?'checked':''}>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)">
              <span>間隔秒數</span>
              <input type="number" id="esDelay" class="form-input form-number" value="${e.settings.delay}" min="0.5" max="10" step="0.5">
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)">
              <span>答對標籤</span>
              <select id="esTagCorrect" class="form-input" style="width:130px">
                <option value="">-- 自動建立 --</option>
                <optgroup label="系統標籤">
                ${(systemTags||[]).map(t => `<option value="${t.role}" ${e.settings.tagCorrect === t.role ? 'selected':''}>${t.name}</option>`).join('')}
                </optgroup>
                <optgroup label="自訂標籤">
                ${(userTags||[]).map(t => `<option value="${t.name}" ${e.settings.tagCorrect === t.name ? 'selected':''}>${t.name}</option>`).join('')}
                </optgroup>
              </select>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--text-secondary)">
              <span>答錯標籤</span>
              <select id="esTagWrong" class="form-input" style="width:130px">
                <option value="">-- 自動建立 --</option>
                <optgroup label="系統標籤">
                ${(systemTags||[]).map(t => `<option value="${t.role}" ${e.settings.tagWrong === t.role ? 'selected':''}>${t.name}</option>`).join('')}
                </optgroup>
                <optgroup label="自訂標籤">
                ${(userTags||[]).map(t => `<option value="${t.name}" ${e.settings.tagWrong === t.name ? 'selected':''}>${t.name}</option>`).join('')}
                </optgroup>
              </select>
            </label>
          </div>
        </div>
        <button class="study-flip-btn" id="esStartBtn" style="width:100%;margin-top:0">${icon('play')} 開始測驗</button>
      </div>
    </div>
    </div>`;
}

function renderExam(s) {
  const w = e.words[e.idx];
  if (!w) return '';
  const total = e.words.length;
  // B9: 進度條以「已答題數」計（原 idx 制永遠到不了 100%、答題後落後一題）；
  //     spell 無 e.results — 以 w._correct !== undefined 為已答（B1/B4 同源）
  const answered = e.words.reduce((n, w) => n + (w._correct !== undefined ? 1 : 0), 0);
  const pct = Math.round((answered / total) * 100);

  let body;
  if (e.userInput === '') {
    body = `<div class="study-card" style="padding:40px 32px">
        <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px;font-weight:500">請拼出這個單字</div>
        <div class="tts-click" data-speak="${esc(w.word)}" title="點擊播放發音" style="cursor:pointer">
        ${splitFieldsHtml(w.pos, w.definition) || `<div class="study-def" style="font-size:26px;font-weight:700;color:var(--text-primary);margin-bottom:4px">${esc(w.definition || '(無定義)')}</div>
        ${w.pos ? `<div class="study-pos" style="margin-bottom:12px">${esc(w.pos)}</div>` : ''}`}
        </div>
        <div class="study-input-row">
          <input class="study-input" id="esInput" type="text" placeholder="輸入英文單字..." autofocus>
          <button class="study-submit" id="esSubmitBtn">確認</button>
        </div>
      </div>
      <div class="study-hint" style="position:static;margin-top:12px">Enter: 確認 · 點擊題目播放發音</div>`;
  } else {
    const isCorrect = e.userInput.toLowerCase() === w.word.toLowerCase();
    body = `<div class="study-card" style="padding:40px 32px">
        <div class="study-result ${isCorrect ? 'study-correct' : 'study-wrong'}" style="margin-bottom:12px">
          ${isCorrect ? '✓ 正確' : '✗ 錯誤'}
        </div>
        <div class="study-word-row">
          <div class="study-word" style="font-size:32px">${esc(w.word)}</div>
        </div>
        ${!isCorrect ? `<div style="margin-top:10px;font-size:14px;font-weight:600;color:var(--red)">你的輸入：<span style="color:inherit">${esc(e.userInput)}</span></div>` : ''}
        <div style="margin-top:16px">
          ${splitFieldsHtml(w.pos, w.definition) || `<div class="study-def">${esc(w.definition || '(無定義)')}</div>`}
          ${w.example ? `<div class="study-example">${fmtExample(w.example)}</div>` : ''}
          ${w.pron ? `<div class="study-pron" style="margin-top:10px">${esc(w.pron)}</div>` : ''}
          ${w.related?.length ? `<div class="study-chips" style="margin-top:10px"><span class="study-chips-label">相似</span>${w.related.map(r => `<span class="chip-accent">${esc(r)}</span>`).join('')}</div>` : ''}
          ${w.forms?.length ? `<div class="study-chips" style="margin-top:10px"><span class="study-chips-label">變化</span>${w.forms.map(f => `<span class="chip-subtle">${esc(f)}</span>`).join('')}</div>` : ''}
          ${w.description ? `<div style="font-size:13px;color:var(--text-tertiary);margin-top:12px;line-height:1.5">${esc(w.description)}</div>` : ''}
        </div>
        ${!e.settings.autoNext ? `
          <button class="study-flip-btn" id="esNextBtn" style="margin-top:20px">${e.idx < e.words.length - 1 ? icon('arrow-right')+' 下一題' : icon('check')+' 查看結果'}</button>
        ` : ''}
      </div>
      <div class="study-hint" style="position:static;margin-top:12px">${e.settings.autoNext ? '即將跳下一題...' : '點擊下一題繼續'}</div>`;
  }

  return `<div class="study-wrap" style="padding-bottom:40px">
    <div class="study-toolbar">
      <span>拼字測驗</span>
      <span>${e.idx+1} / ${total}</span>
      <button class="btn btn-sm study-toolbar-exit" id="esExitBtn">${icon('x')} 退出</button>
    </div>
    <div class="study-progress-bar"><div class="study-progress-fill" style="width:${pct}%"></div></div>
    ${body}
  </div>`;
}

function renderResult(s) {
  const total = e.correct + e.wrong;
  const pct = total > 0 ? Math.round((e.correct / total) * 100) : 0;
  const mins = Math.floor(e.totalTime / 60);
  const secs = e.totalTime % 60;

  return `<div class="study-wrap" style="padding-bottom:40px;justify-content:center">
    <div class="study-card" style="max-width:480px;padding:40px 32px;text-align:center">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="${pct>=60?'var(--green)':'var(--red)'}" stroke-width="2" style="margin-bottom:8px"><path d="M20 6 9 17l-5-5"/></svg>
      <h2 style="color:var(--text-primary);margin:0 0 4px;font-size:22px">拼字測驗完成！</h2>
      <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">${total} 題 · ${mins}:${String(secs).padStart(2,'0')}</div>
      <div style="font-size:48px;font-weight:800;color:${pct>=60?'var(--green)':'var(--red)'};margin-bottom:20px">${pct}<span style="font-size:20px">%</span></div>
      <div style="display:flex;justify-content:center;gap:32px;margin-bottom:20px">
        <div><div style="font-size:28px;font-weight:800;color:var(--green)">${e.correct}</div><div style="font-size:11px;color:var(--text-tertiary)">正確</div></div>
        <div><div style="font-size:28px;font-weight:800;color:var(--red)">${e.wrong}</div><div style="font-size:11px;color:var(--text-tertiary)">錯誤</div></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="study-flip-btn" id="esRetryBtn" style="font-size:14px;padding:12px 24px">${icon('refresh')} 再考一次</button>
        <button class="btn" id="esTagBtn" style="${total===0?'opacity:.5;pointer-events:none':''}">${icon('tag')} 加上標籤</button>
        <button class="btn" data-goto="dashboard">${icon('home')} 回首頁</button>
      </div>
    </div>
  </div>`;
}

function startExam(s) {
  if (!e.decks.length) { toast('請至少選擇一個字本', 'toast-error'); return; }
  const pool = wordPool(s);
  if (!pool.length) { toast('所選字本中沒有單字', 'toast-error'); return; }
  e.settings.count = parseInt(document.getElementById('esCount')?.value) || 0;
  e.settings.autoNext = document.getElementById('esAutoNext')?.checked ?? true;
  e.settings.delay = parseFloat(document.getElementById('esDelay')?.value) || 1.5;
  e.settings.tagCorrect = document.getElementById('esTagCorrect')?.value || 'correct';
  e.settings.tagWrong = document.getElementById('esTagWrong')?.value || 'wrong';
  // B8: 深拷貝 pool（wordPool 回傳 s.state.words 活參考）— _correct 作答旗標寫在副本上，不污染 state.words
  let words = shuffle(pool.map(w => ({ ...w })));
  if (e.settings.count > 0 && e.settings.count < words.length) words = words.slice(0, e.settings.count);
  e.words = words;
  for (const w of words) { w._correct = undefined; }   // B4: 新場重置作答旗標（B8 後 resume 舊場 _correct 由 session.spellData 還原，不再依賴活參考殘留）
  e.idx = 0;
  e.correct = 0;
  e.wrong = 0;
  e.userInput = '';
  e.totalTime = 0;
  e.cardStart = Date.now();
  e.pendingScore = null;   // B2: 重置
  e.examRecorded = false;  // B4: 新場可再記錄（防重旗標重置）
  e.id = undefined;        // B5: 新場重置 session id（resume 殘留的舊 id 若不清 → buildSession 沿用 → saveExamSession 覆蓋已存 session）
  if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }   // B2: 殘留 timer 防護
  e.phase = 'exam';
  renderInPlace(s);
}

function resumeSession(s, session) {
  e.pendingScore = null;   // B2: 重置置函式頂（任何 early return 之前）
  e.examRecorded = false;  // B4: 恢復場完成可記錄（防重旗標重置）
  if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }
  const wordMap = new Map(s.state.words.map(w => [w.id, w]));
  // B8: 深拷貝（wordMap 回傳 s.state.words 活參考）— _correct 寫在副本上，不污染 state.words；
  //     舊場作答旗標改由 session.spellData 序列化還原（B4 語意：記錄集合＝spellData 舊場殘留＋新答，取代活參考殘留）
  const words = session.wordIds.map(id => wordMap.get(id)).filter(Boolean).map(w => ({ ...w }));
  if (!words.length) { toast('無法恢復進度：單字已不存在', 'toast-error'); return; }
  const spellData = session.spellData || {};
  for (const w of words) {
    if (spellData[w.id] !== undefined) w._correct = spellData[w.id];
  }
  e.id = session.id;
  e.decks = session.deckIds;
  e.settings = { ...session.settings };
  e.words = words;
  e.idx = Math.min(session.idx, words.length - 1);
  e.correct = session.correct;
  e.wrong = session.wrong;
  e.totalTime = session.totalTime;
  e.userInput = '';
  e.cardStart = Date.now();
  e.phase = 'exam';
  renderInPlace(s);
}

function submitSpelling(s) {
  const w = e.words[e.idx];
  if (!w || e.userInput !== '') return;
  const input = document.getElementById('esInput');
  if (!input) return;
  e.userInput = input.value.trim();
  if (!e.userInput) { toast('請輸入答案', 'toast-error'); return; }
  e.totalTime += (Date.now() - e.cardStart) / 1000;
  const isCorrect = e.userInput.toLowerCase() === w.word.toLowerCase();
  w._correct = isCorrect;                          // B1 既有（applyTags 依賴，保留）
  e.pendingScore = isCorrect ? 'correct' : 'wrong';   // B2: 延遲窗內不直接計分
  if (e.settings.autoNext) {
    // B2: timer 先設後 render（防 onMount 補跳 guard 同步級聯）；callback 先 nextWord 後清；末題也走 nextWord（統一 flush）
    if (e.autoNextTimer) clearTimeout(e.autoNextTimer);
    e.autoNextTimer = setTimeout(() => { nextWord(s); e.autoNextTimer = null; }, e.settings.delay * 1000);
  }
  renderInPlace(s);
}

function flushPendingScore() {
  if (e.pendingScore) { e[e.pendingScore]++; e.pendingScore = null; }   // B2: 唯一計分入口（冪等）
}

// B8: 收集本場已答題的 _correct 至 session.spellData（resume 還原用 — 取代活參考殘留傳遞）
function collectSpellData() {
  const spellData = {};
  for (const w of e.words) {
    if (w._correct !== undefined) spellData[w.id] = w._correct;
  }
  return spellData;
}

// B10: sidebar 導航離開測驗頁 → 模擬 exit（flush + build + save + phase=config），fire-and-forget
//      window.__navFromSidebar 由 main.js bindNav 設定、renderPage 消費後清除 →
//      bottom-nav 離開續答（B1/B2 既有行為）不受影響。
function saveOnLeave(s) {
  if (e.phase !== 'exam' || !window.__navFromSidebar) return;
  if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }
  flushPendingScore();
  const session = { ...buildSession(e, 'spell'), spellData: collectSpellData() };   // B8: _correct 序列化進 session（不靠活參考殘留）
  e.phase = 'config';
  s.actions.saveExamSession(session).catch(err => console.warn('[exam-spell] saveOnLeave error:', err));
}

// B4: 完成時將本場作答寫入 exam_history（記錄動作的唯一入口 — 呼叫點皆轉呼叫此 helper；不 await）
// spell 無 e.results — 從 B1 既有 w._correct 派生（與 applyTags 同源資料；記錄集合＝「整場答過之題」＝spellData 舊場還原＋新答，B8 後不依賴活參考殘留）
async function recordExamResult(s) {
  if (e.phase !== 'result') return;   // B4: phase guard（呼叫點誤放零副作用）
  if (e.examRecorded) return;         // B4: 防重（同場只記一次）
  e.examRecorded = true;              // 同步設旗標（async 前），renderInPlace 不等待
  try {
    const entries = e.words
      .filter(w => w._correct !== undefined)   // B1 既有 per-word 作答旗標
      .map(w => ({ wordId: w.id, correct: w._correct }));
    if (entries.length) await s.actions.recordExam({ mode: 'spell', entries });
  } catch (err) { console.warn('[exam-spell] recordExam error:', err); }
  // B6: 完成後刪除已存 session（resume 場 e.id 有值）→ 防 resume 重答剩餘題目、applyTags 重複套標籤
  // 集中在此 helper：2 個完成路徑（nextWord 末題 / 手動查看結果）皆經 recordExamResult
  if (e.id) {
    try {
      await s.actions.deleteExamSession(e.id);
      e.id = undefined;   // 刪成功才清 id（失敗保留 + warn — session 仍在 config 列表可手動刪）
    } catch (err) { console.warn('[exam-spell] deleteExamSession error:', err); }
  }
}

function nextWord(s) {
  if (e.phase !== 'exam' || s.state.currentPage !== 'exam-spell') return;   // B2: phase guard + bottom-nav page guard（對齊 flip B1）
  flushPendingScore();          // B2: 計分 flush
  e.idx++;
  e.userInput = '';
  e.cardStart = Date.now();
  if (e.idx >= e.words.length) {
    e.phase = 'result';
    recordExamResult(s);   // B4: 正常完成（autoNext timer / 手動下一題 / resume 續答收斂）→ 寫入 exam_history
    renderInPlace(s);
    return;
  }
  renderInPlace(s);
  setTimeout(() => {
    const el = document.getElementById('esInput');
    el?.focus();
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

async function applyTags(s) {
  const tagCorrect = e.settings.tagCorrect || 'correct';
  const tagWrong = e.settings.tagWrong || 'wrong';
  const tags = s.state.systemTags || [];
  const ct = tags.find(t => t.role === tagCorrect) || { role: tagCorrect };
  const wt = tags.find(t => t.role === tagWrong) || { role: tagWrong };
  const tc = ct.role;
  const tw = wt.role;
  for (const w of e.words) {
    if (w._correct === undefined) continue;
    const tag = w._correct ? tc : tw;
    const opposite = tag === tc ? tw : tc;
    if (!w.tags) w.tags = [];
    const changed = !w.tags.includes(tag) || w.tags.includes(opposite);
    if (changed) {
      w.tags = w.tags.filter(t => t !== opposite);
      if (!w.tags.includes(tag)) w.tags.push(tag);
      try { await s.actions.editWord(w.id, { tags: w.tags }); } catch (e) { console.warn('[exam-spell] editWord tag error:', e); }
    }
  }
  toast('標籤已套用', 'toast-success');
}

export function onMount(s) {
  document.querySelectorAll('[data-goto]').forEach(el =>
    el.addEventListener('click', () => s.actions.navigate(el.dataset.goto)));

  if (e.phase === 'config') {
    delete window.__pageCleanup;   // B10: config/result 無需 leave-save（exit/reset 後清除 stale 註冊）
    if (!e.decks.length) e.decks = s.state.decks.map(d => d.id);
    document.getElementById('esToggleAll')?.addEventListener('click', () => {
      const all = e.decks.length !== s.state.decks.length;
      e.decks = all ? s.state.decks.map(d => d.id) : [];
      document.querySelectorAll('[data-es-deck]').forEach(el => el.classList.toggle('selected', all));
      updateStatus(s);
    });
    document.querySelectorAll('[data-es-deck]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.esDeck;
        const i = e.decks.indexOf(id);
        if (i === -1) e.decks.push(id);
        else e.decks.splice(i, 1);
        el.classList.toggle('selected');
        updateStatus(s);
      });
    });
    document.getElementById('esStartBtn')?.addEventListener('click', () => startExam(s));
    document.querySelectorAll('.exam-session-item[data-sid]').forEach(el => {
      el.addEventListener('click', () => {
        const sid = el.dataset.sid;
        const session = s.state.examSessions.find(sess => sess.id === sid);
        if (session) resumeSession(s, session);
      });
    });
    document.querySelectorAll('[data-sdel]').forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const sid = el.dataset.sdel;
        await s.actions.deleteExamSession(sid);
        renderInPlace(s);
      });
    });
    updateStatus(s);
  }

  if (e.phase === 'exam') {
    window.__pageCleanup = () => saveOnLeave(s);   // B10: sidebar 離開時存檔+重置（renderPage 每頁切換消費後清除）
    // B2: bottom-nav 離開又回來時，已答+autoNext 但 timer 已被 page guard 消費 → 補跳不卡死（恰跳 1 題）
    if (e.userInput !== '' && e.settings.autoNext && !e.autoNextTimer) { nextWord(s); return; }
    const input = document.getElementById('esInput');
    const submit = document.getElementById('esSubmitBtn');
    if (input) {
      input.focus();
      setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          submitSpelling(s);
        }
      });
    }
    if (submit) submit.addEventListener('click', () => submitSpelling(s));
    document.getElementById('esNextBtn')?.addEventListener('click', () => {
      if (e.idx < e.words.length - 1) {
        nextWord(s);
      } else {
        flushPendingScore();   // B2: 手動查看結果（autoNext 關）— 計分 flush 再進結果頁
        e.phase = 'result';
        recordExamResult(s);   // B4: 手動完成 → 寫入 exam_history
        renderInPlace(s);
      }
    });
    document.getElementById('esPlayBtn')?.remove();
    bindSpeakClick(document.getElementById('pageContainer'), () => s.state);
    document.getElementById('esExitBtn')?.addEventListener('click', async () => {
      if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }   // B2: 殘留 timer 防護
      flushPendingScore();   // B2: exit 前 flush（延遲窗退出計分不遺失；resume 重問雙計為既有行為，見 B2 計畫書風險）
      const session = { ...buildSession(e, 'spell'), spellData: collectSpellData() };   // B8: _correct 序列化進 session（不靠活參考殘留）
      await s.actions.saveExamSession(session);
      e.phase = 'config';
      renderInPlace(s);
    });
    document.addEventListener('keydown', esKeyHandler);
    window.__esKeyHandler = esKeyHandler;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        const el = document.getElementById('esInput');
        if (el && document.activeElement === el) {
          el.scrollIntoView({ block: 'center' });
        }
      });
    }
  } else {
    if (window.__esKeyHandler) {
      document.removeEventListener('keydown', window.__esKeyHandler);
      delete window.__esKeyHandler;
    }
  }

  if (e.phase === 'result') {
    delete window.__pageCleanup;   // B10
    document.getElementById('esRetryBtn')?.addEventListener('click', () => {
      e.phase = 'config';
      renderInPlace(s);
    });
    document.getElementById('esTagBtn')?.addEventListener('click', () => applyTags(s));
  }
}

function esKeyHandler(ev) {
  if (ev.key === 'p' || ev.key === 'P') {
    const store = window.__examStore;
    const w = e.words?.[e.idx];
    if (store && w) {
      import('../lib/tts.js').then(({ speak }) => {
        speak(w.word, store.state.ttsSpeed || 0.9, store.state.ttsVoice || 'en-us', store.state.ttsPitch || 50);
      }).catch(() => {});
    }
  }
}

function updateStatus(s) {
  const el = document.getElementById('esDeckStatus');
  if (el) el.textContent = `已選 ${e.decks.length}/${s.state.decks.length} 字本`;
}

function renderInPlace(s) {
  window.__examStore = s;
  const c = document.getElementById('pageContainer');
  if (c) { c.innerHTML = render(s); onMount(s); }
}
