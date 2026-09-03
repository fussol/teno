import { icon } from '../lib/svg.js';
import { toast } from '../lib/toast.js';
import { fetchGet, fetchLLM, lookupCambridge } from '../lib/api.js';

// OCR token 白名單（計畫 v1.3 §5，與 store.importOcrText 端同一正則）
const _OCR_TOKEN_RE = /^[a-z][a-z'-]{1,30}$/i;

export function render(s) {
  const tasks = s.state.backgroundTasks || [];
  const running = tasks.filter(t => t.status === 'running');
  const done = tasks.filter(t => t.status !== 'running');
  const _selHtml = (id, opts, fallback) => `<div class="cs" id="${id}Cs"><button class="cs-t" data-id="${id}" data-value="${fallback}">${opts.find(o=>o[1]===fallback)[0]}<svg class="cs-a" width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6z" fill="#888"/></svg></button><div class="cs-m">${opts.map(o=>`<div class="cs-o${o[1]===fallback?' s':''}" data-value="${o[1]}">${o[0]}</div>`).join('')}</div></div>`;
  return `
    <style>
      .tool-progress{display:flex;align-items:center;gap:var(--s2);margin-top:var(--s2)}
      .tool-progress-bar{height:6px;background:var(--accent);border-radius:3px;transition:width .2s;max-width:100%}
      .tool-progress span{font-size:12px;color:var(--text-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
      .task-item{display:flex;align-items:center;gap:var(--s2);padding:6px 8px;margin-bottom:4px;background:var(--bg-secondary);border-radius:var(--r1);font-size:13px}
      .task-item .task-label{flex:1;color:var(--text-primary)}
      .task-item .task-status{font-size:11px;color:var(--text-tertiary)}
      .task-item .task-dismiss{cursor:pointer;color:var(--text-tertiary);font-size:16px;line-height:1;padding:0 4px}
      .task-item .task-dismiss:hover{color:var(--text-primary)}
      .tool-row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
      .cs{position:relative;font-size:12px;min-height:30px;flex-shrink:0}
      .cs-t{display:flex;align-items:center;gap:6px;width:100%;height:100%;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);cursor:pointer;white-space:nowrap;transition:border-color .15s;font-family:inherit;font-size:inherit}
      .cs-t:hover,.cs.o .cs-t{border-color:var(--accent)}
      .cs-a{margin-left:auto;transition:transform .15s;flex-shrink:0}
      .cs.o .cs-a{transform:rotate(180deg)}
      .cs-m{display:none;position:absolute;top:100%;left:0;right:0;margin-top:2px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);overflow:hidden;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3)}
      .cs.o .cs-m{display:block}
      .cs-o{padding:6px 10px;cursor:pointer;color:var(--text-primary);transition:background .1s}
      .cs-o:hover{background:var(--bg-hover)}
      .cs-o.s{color:var(--accent);font-weight:600}
    </style>
    <div class="page-title">${icon('tools')} 工具</div>
    <div class="page-subtitle">輔助工具，幫你整理單字庫</div>

    <div class="section">
      <div class="section-title">${icon('chart')} 學習分析</div>
      <div class="card card-interactive" id="toolsGoSimulator" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('chart')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">學習分析</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">成熟度、複習統計、評分分布、模擬圖表</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevron-right')}</span>
        </div>
      </div>
      ${s.state.devMode ? `
      <div class="card card-interactive" id="toolsGoAppLog" style="cursor:pointer;margin-top:var(--s3)">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--green-container, var(--accent-container));display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--green, var(--accent));flex-shrink:0">${icon('list')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">操作日誌</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">操作記錄與模擬歷史 (隔離 DB)</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevron-right')}</span>
        </div>
      </div>
      ` : ''}
    </div>

    <div class="section" id="bgTaskSection">
      <div class="section-title">${icon('activity')} 背景任務</div>
      <div class="config-section" id="bgTaskConfig">
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
          <div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r1);font-size:12px;color:var(--text-secondary)">${t.result.message}</div>
          ` : ''}
        `).join('')}
      </div>
    </div>

    <!-- Duplicate Finder -->
    <div class="section">
      <div class="section-title">${icon('search')} 尋找重複</div>
      <div class="config-section">
        <button class="btn" onclick="window.__findIssues()">${icon('search')} 開始掃描</button>
        <div class="tool-output" id="issuesResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Spell Check -->
    <div class="section">
      <div class="section-title">${icon('edit')} 拼字檢查</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 檢查單字拼字是否正確
        </div>
        <button class="btn" onclick="window.__spellCheckLLM()">${icon('edit')} 開始檢查</button>
        <div class="tool-output" id="spellResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Part of Speech -->
    <div class="section">
      <div class="section-title">${icon('hash')} 自動產生詞性</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為缺少詞性的單字自動補上
        </div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          ${_selHtml('posMethod', [['Cambridge 字典','cambridge'],['本地 LLM','llm']], 'cambridge')}
          <button class="btn" onclick="window.__genPos()">${icon('hash')} 開始產生</button>
        </div>
        <div class="tool-output" id="posResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Examples -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生例句</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為沒有例句的單字產生例句，或翻譯現有例句為中文
        </div>
          <div style="display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s2);flex-wrap:wrap">
          ${_selHtml('exampleMethod', [['字典 API','dictionary-api'],['Cambridge 字典','cambridge'],['Tatoeba 例句','tatoeba'],['本地 LLM','llm']], 'dictionary-api')}
          <button class="btn" onclick="window.__genExamples()">${icon('sparkle')} 開始產生</button>
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;white-space:nowrap;flex-shrink:0">少於</label>
          <input id="exampleThreshold" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句就新增</label>
          <input id="exampleCount" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句＆顯示最多</label>
          <input id="exampleDisplayMax" type="number" value="0" min="0"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句(0=全顯示)</label>
        </div>
        <div id="llmUrlRow" style="display:none;margin-bottom:var(--s2)">
          <div style="display:flex;gap:var(--s2);margin-bottom:4px">
            <input id="llmUrl" type="text" value="http://localhost:11434/api/generate" placeholder="Ollama API 網址"
              style="flex:2;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
            <input id="llmModel" type="text" value="" placeholder="模型名稱 (留空自動偵測)"
              style="flex:1;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
          </div>
        </div>
        <div class="tool-output" id="examplesResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Fetch Pronunciation -->
    <div class="section">
      <div class="section-title">${icon('mic')} 自動抓取發音</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為缺少音標的單字自動補上
        </div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          ${_selHtml('pronMethod', [['Cambridge 字典','cambridge']], 'cambridge')}
          <button class="btn" onclick="window.__genPronunciations()">${icon('mic')} 開始抓取</button>
        </div>
        <div class="tool-output" id="pronResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Related Words -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生相關詞</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少相關詞（同義詞、近似詞）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genRelatedLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="relatedResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Forms -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生詞形變化</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少詞形變化（過去式、-ing、-ed、派生名詞等）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genFormsLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="formsResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- OCR Recognize → 獨立工具頁入口 -->
    <div class="section">
      <div class="card card-interactive" id="toolsGoOcr" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('camera')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">OCR 辨識字卡</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">拍照或選圖、圈選範圍，自動辨識並加入字本</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevronR')}</span>
        </div>
      </div>
    </div>

    <!-- 照片切割掃描 → 獨立切割頁入口（2026-09-01 元首令） -->
    <div class="section">
      <div class="card card-interactive" id="toolsGoCrop" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('scan')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">照片切割掃描</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">拖曳畫多個切割框，每塊放大 2x 逐塊辨識，跨張累積一次匯入</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevronR')}</span>
        </div>
      </div>
    </div>

    <!-- Cambridge Dictionary -->
    <div class="section">
      <div class="section-title">${icon('book')} Cambridge 字典查詢</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          從 Cambridge Dictionary 查詢單字定義、IPA、例句
        </div>
         <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2)">
           ${_selHtml('cambridgeDict', [['英英','en'],['英中','zh']], 'en')}
            <input id="cambridgeWord" type="text" placeholder="輸入英文單字"
              style="flex:1;min-width:0;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
           <button class="btn" onclick="window.__lookupCambridge()">${icon('search')} 查詢</button>
         </div>
        <div class="tool-output" id="cambridgeResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>
  `;
}

function renderSpellResult(r) {
  if (!r.entries || !r.entries.length) return `<div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r1);font-size:12px;color:var(--green)">${icon('check')} 所有單字拼字正確！</div>`;
  let html = `<div style="margin:4px 0 4px 24px;padding:6px 8px;background:var(--bg-base);border-radius:var(--r1)"><div style="margin-bottom:4px;font-size:12px;color:var(--text-secondary)">發現 ${r.entries.length} 個可能拼錯的單字：</div>`;
  for (const e of r.entries) {
    html += `<div style="display:flex;align-items:center;gap:var(--s2);padding:4px 6px;margin-bottom:2px;background:var(--bg-secondary);border-radius:var(--r1);font-size:13px">
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
export function onMount(s) {
  document.getElementById('toolsGoSimulator')?.addEventListener('click', () => s.actions.navigate('simulator'));
  document.getElementById('toolsGoAppLog')?.addEventListener('click', () => s.actions.navigate('app-log'));
  document.getElementById('toolsGoOcr')?.addEventListener('click', () => s.actions.navigate('ocr'));
  document.getElementById('toolsGoCrop')?.addEventListener('click', () => s.actions.navigate('crop'));
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

  const _posCN = {noun:'名詞',verb:'動詞',adjective:'形容詞',adverb:'副詞',preposition:'介係詞',conjunction:'連接詞',pronoun:'代名詞',interjection:'感嘆詞',exclamation:'感嘆詞',determiner:'限定詞',article:'冠詞',phrase:'片語',idiom:'慣用語',suffix:'後綴',prefix:'前綴',abbreviation:'縮寫','plural noun':'複數名詞'};
  const _normalizePos = (pos) => (pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean).join(', ');
  const _normalizePron = (pron) => (pron || '').trim();

  // ponytail: shared LLM model detection
  async function detectModel(resultElId) {
    const llmRow = document.getElementById('llmUrlRow');
    if (llmRow) llmRow.style.display = 'block';
    const baseUrl = (document.getElementById('llmUrl')?.value || '').trim().replace(/\/api\/generate$/, '') || 'http://localhost:11434';
    let model = (document.getElementById('llmModel')?.value || '').trim();
    if (model) return { baseUrl, model };
    const el = document.getElementById(resultElId);
    if (!el) return null;
    el.style.display = 'block';
    try {
      el.innerHTML = `<div>偵測 Ollama 模型...</div>`;
      const resp = await fetchGet(`${baseUrl}/api/tags`);
      const list = (JSON.parse(resp).models || []).map(m => m.name);
      if (!list.length) { el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無可用模型</div>`; return null; }
      model = list[0];
      document.getElementById('llmModel').value = model;
      return { baseUrl, model };
    } catch (e) {
      el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無法連線 Ollama，請確認 http://localhost:11434 有在運作</div>`;
      return null;
    }
  }

  function hideLlmRow() {
    const r = document.getElementById('llmUrlRow');
    if (r) r.style.display = 'none';
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
      if (seen.has(lower)) issues.push(`${icon('info')} 重複: 「${lower}」(${seen.get(lower)} / ${w.id})`);
      seen.set(lower, w.id);
    }
    const noDef = words.filter(w => !w.definition || w.definition.trim() === '');
    if (noDef.length > 0) {
      issues.push(`${icon('edit')} 缺少定義: ${noDef.length} 詞`);
      noDef.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${w.word}</span>`));
    }
    const noPos = words.filter(w => !w.pos);
    if (noPos.length > 0) {
      issues.push(`${icon('hash')} 缺少詞性: ${noPos.length} 詞`);
      noPos.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${w.word}</span>`));
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

  // ─── Part of Speech Generator ────────────────
  window.__genPos = async () => {
    const method = _getMethod('posMethod', 'cambridge');
    if (method === 'llm') {
      const llm = await detectModel('posResult');
      if (!llm) return;
      await genPosViaLLM(s, llm);
    } else {
      await genPosViaCambridge(s);
    }
  };
  document.querySelector('button.btn[onclick*="__genPos"]')?.addEventListener('click', e => { console.log('click', e); });

  async function genPosViaCambridge(s) {
    hideLlmRow();
    const words = s.state.words;
    const taskId = 'gen-pos-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 搜尋詞性', words.length);
    let count = 0, fail = 0;
    const CON = 2;
    const queue = [...words.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const newRaw = [...new Set((data.senses || []).flatMap(s => (s.part_of_speech || '').split(',').map(p => p.trim()).filter(Boolean)))];
          const existing = new Set((w.pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean));
          const toAdd = newRaw.map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(p => !existing.has(p));
          if (toAdd.length) {
            const merged = [...existing, ...toAdd].filter(Boolean).join(', ');
            await s.actions.editWord(w.id, { pos: merged }); count++;
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, count + fail, words.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已更新詞性${fail ? `，${fail} 詞無新詞性` : ''}` });
    const container = document.getElementById('posResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已更新詞性${fail ? `，${fail} 詞無新詞性` : ''}</div>`;
    }
    toast(`詞性查詢完成：${count} 更新${fail ? `，${fail} 無新詞性` : ''}`, fail ? '' : 'toast-success');
  }

  async function genPosViaLLM(s, llm) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const noPos = words.filter(w => !w.pos || !w.pos.trim());
    if (noPos.length === 0) {
      const c = document.getElementById('posResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">所有單字都有詞性了！</div>`; }
      return;
    }
    const taskId = 'gen-pos-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生詞性', noPos.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noPos.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, `What is/are the part(s) of speech of "${w.word}"? If multiple, list them comma-separated. Return ONLY English POS labels (e.g. noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, determiner, article, plural noun), nothing else.`);
          const pos = _normalizePos(text);
          if (pos) { await s.actions.editWord(w.id, { pos }); count++; }
          else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noPos.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加詞性${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('posResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加詞性${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 詞性完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  function _exampleConfig() {
    const threshold = parseInt(document.getElementById('exampleThreshold')?.value, 10) || 1;
    const count = parseInt(document.getElementById('exampleCount')?.value, 10) || 1;
    return { threshold, count };
  }

  function _countSentences(text) {
    if (!text || !text.trim()) return 0;
    return text.split('\n').filter(l => l.trim().length > 2).length;
  }

  function _dedupSentences(text, newLines) {
    const existing = new Set(
      (text || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
    );
    return [...new Set(newLines)].filter(l => !existing.has(l.trim().toLowerCase()));
  }

  window.__genExamples = async () => {
    const method = _getMethod('exampleMethod', 'dictionary-api');
    const { threshold, count } = _exampleConfig();
    if (method === 'llm') {
      const llm = await detectModel('examplesResult');
      if (!llm) return;
      await genExamplesViaLLM(s, llm, count);
    } else if (method === 'cambridge') {
      await genExamplesViaCambridge(s, threshold);
    } else if (method === 'tatoeba') {
      await genExamplesViaTatoeba(s, threshold);
    } else {
      await genExamplesViaDictApi(s, threshold);
    }
  };

  async function genExamplesViaDictApi(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const container = document.getElementById('examplesResult');
      if (container) { container.style.display = 'block'; container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-' + Date.now();
    s.actions.startBackgroundTask(taskId, '字典 API 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 3;
    const queue = need.map(w => ({ w }));
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w.word)}`);
          if (res.ok) {
            const data = await res.json();
            const fresh = [];
            for (const entry of data) {
              for (const m of entry.meanings || []) {
                for (const d of m.definitions || []) {
                  if (d.example) fresh.push(d.example.trim());
                }
              }
            }
            const unique = _dedupSentences(w.example, fresh);
            if (unique.length) {
              const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 300));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}</div>`;
    }
    toast(`例句查詢完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaTatoeba(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-tat-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Tatoeba 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 3;
    const queue = [...need.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const res = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w.word)}&lang=eng`);
          if (res.ok) {
            const body = await res.json();
            const fresh = (body.data || []).map(s => s.text).filter(Boolean);
            const unique = _dedupSentences(w.example, fresh);
            if (unique.length) {
              const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`Tatoeba 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaCambridge(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-cam-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 2;
    const queue = [...need.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const fresh = [];
          for (const sense of data.senses || []) {
            for (const ex of sense.examples || []) {
              if (ex) fresh.push(ex.trim());
            }
          }
          const unique = _dedupSentences(w.example, fresh);
          if (unique.length) {
            const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
            await s.actions.editWord(w.id, { example: merged }); ok++;
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`Cambridge 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaLLM(s, llm, count) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const existing = [];
    const queue = [];
    for (const w of words) {
      const n = _countSentences(w.example);
      if (n < count) {
        queue.push(w);
        existing.push(w.example || '');
      }
    }
    if (queue.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${count} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生例句', queue.length);
    let ok = 0, fail = 0;
    const CON = 5;
    const entries = queue.map((w, i) => ({ w, existing: existing[i] }));
    const q = [...entries.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, q.length) }, async () => {
      while (q.length > 0) {
        const [, { w, existing }] = q.shift();
        try {
          const prompt = `Create ${count} short example sentences using the word "${w.word}". Format: one sentence per line, each ending with proper punctuation (. ! ?). Only output the sentences, nothing else.`;
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
          const lines = text.split('\n').filter(Boolean).map(l => l.trim()).filter(l => l.length > 5).slice(0, count);
          if (lines.length) {
            const unique = _dedupSentences(existing, lines);
            if (unique.length) {
              const merged = [(existing || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, ok + fail, queue.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  window.__spellCheckLLM = async () => {
    const llm = await detectModel('spellResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    const words = s.state.words;
    const unique = [...new Set(words.map(w => w.word.toLowerCase().trim()).filter(Boolean))];

    const sc = document.getElementById('spellResult');
    if (sc) { sc.style.display = 'block'; sc.innerHTML = `<div>載入字典...</div>`; }

    let dict, isKnownWord;
    try {
      const mod = await import('../lib/dictionary.js');
      dict = await mod.loadDictionary();
      isKnownWord = mod.isKnownWord;
      if (sc) sc.innerHTML = `<div>字典已載入 (${dict.size} 詞)，過濾中...</div>`;
    } catch (e) {
      if (sc) sc.innerHTML = `<div style="color:var(--orange)">${icon('info')} 字典載入失敗: ${e.message}</div>`;
      toast('字典載入失敗，跳過字典檢查', 'toast-error');
    }
    const unknown = [];
    for (const w of unique) {
      if (w.length <= 1) continue;
      if (!dict || !isKnownWord(w)) unknown.push(w);
    }
    const skipped = unique.length - unknown.length;
    const taskId = 'spellcheck-' + Date.now();
    s.actions.startBackgroundTask(taskId, `LLM 拼字檢查 (字典過濾 ${skipped} 詞)`, unknown.length);
    let corrections = {};
    let checked = 0;
    const CON = 3;
    const batchSize = 50;
    const batches = [];
    for (let i = 0; i < unknown.length; i += batchSize) batches.push(unknown.slice(i, i + batchSize));
    await Promise.all(Array.from({ length: Math.min(CON, batches.length) }, async () => {
      while (batches.length > 0) {
        const batch = batches.shift();
        try {
          const prompt = `You are a spell checker. Only flag words that are ACTUALLY MISSPELLED (typos, wrong letters, missing letters). Rules: (1) DO NOT flag British/American spelling variants (e.g. favour/favor, fulfil/fulfill, anaesthetic/anesthetic, offence/offense, honour/honor, paralyse/paralyze, practise/practice). (2) DO NOT suggest different tenses or plural forms (e.g. choke→choking, stare→stares, theory→theories, trauma→traumas). (3) DO NOT suggest synonyms or rephrase expressions, only fix actual typos. (4) Multiple-word expressions (phrases, collocations) should only be flagged if they contain a real typo. (5) Return ONLY a JSON object where keys are misspelled words and values are corrections. Skip everything that is correctly spelled. List: ${JSON.stringify(batch)}`;
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
          const cleaned = text.replace(/```json|```/g, '').trim();
          const result = JSON.parse(cleaned);
          if (typeof result === 'object' && !Array.isArray(result)) Object.assign(corrections, result);
        } catch (e) {}
        checked += batch.length;
        s.actions.updateBackgroundTask(taskId, checked, unknown.length);
      }
    }));

    const entries = Object.entries(corrections).filter(([k, v]) => k.toLowerCase() !== v.toLowerCase());
    const spellResultData = { type: 'spellcheck', entries: entries.map(([w, r]) => ({ wrong: w, right: r, count: words.filter(x => x.word.toLowerCase().trim() === w).length })) };
    s.actions.completeBackgroundTask(taskId, spellResultData);
    const container = document.getElementById('spellResult');
    if (!container) return;
    container.style.display = 'block';

    if (!entries.length) {
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字拼字正確！</div>`;
      return;
    }
    container.innerHTML = renderSpellResult(spellResultData);
    container.querySelectorAll('.spell-apply').forEach(btn => btn.addEventListener('click', () => __applyOne(btn.dataset.wrong, btn.dataset.right, btn)));
    document.getElementById('spellApplyAll')?.addEventListener('click', () => container.querySelectorAll('.spell-apply').forEach(b => b.click()));
  };

  function __applyOne(wrong, right, btn) {
    const matches = s.state.words.filter(w => w.word.toLowerCase().trim() === wrong.toLowerCase().trim());
    if (!matches.length) { toast(`找不到 ${wrong}`, ''); return; }
    Promise.all(matches.map(w => s.actions.editWord(w.id, { word: right })))
      .then(() => {
        btn.closest('div')?.remove();
        toast(`已修正 ${matches.length} 筆: ${wrong} → ${right}`, 'toast-success');
      })
      .catch(() => toast('套用失敗', ''));
  }

  window.__genPronunciations = async () => {
    const method = _getMethod('pronMethod', 'cambridge');
    if (method === 'llm') {
      const llm = await detectModel('pronResult');
      if (!llm) return;
      await genPronViaLLM(s, llm);
    } else {
      await genPronViaCambridge(s);
    }
  };

  async function genPronViaCambridge(s) {
    hideLlmRow();
    const words = s.state.words;
    const noPron = words.filter(w => !w.pron || !w.pron.trim());
    if (noPron.length === 0) {
      const container = document.getElementById('pronResult');
      if (container) { container.style.display = 'block'; container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有發音了！</div>`; }
      return;
    }
    const taskId = 'pron-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 字典抓取發音', noPron.length);
    let count = 0, fail = 0;
    const CON = 2;
    const queue = noPron.map(w => ({ w }));
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const pron = _normalizePron(data.uk_ipa || data.us_ipa);
          if (pron) { await s.actions.editWord(w.id, { pron }); count++; }
          else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, count + fail, noPron.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加發音${fail ? `，${fail} 詞查無發音` : ''}` });
    const container = document.getElementById('pronResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加發音${fail ? `，${fail} 詞查無發音` : ''}</div>`;
    }
    toast(`發音查詢完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genPronViaLLM(s, llm) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const noPron = words.filter(w => !w.pron || !w.pron.trim());
    if (noPron.length === 0) {
      const c = document.getElementById('pronResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有發音了！</div>`; }
      return;
    }
    const taskId = 'pron-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生音標', noPron.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noPron.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, `Provide the IPA pronunciation of "${w.word}". Return ONLY the IPA string (e.g. /ˈhɛloʊ/), nothing else.`);
          if (text && text.trim()) {
            const cleaned = text.trim().replace(/^\/+|\/+$/g, '');
            const pron = cleaned ? `/${cleaned}/` : null;
            if (pron) { await s.actions.editWord(w.id, { pron }); count++; }
            else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noPron.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加音標${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('pronResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加音標${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 音標完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  window.__genRelatedLLM = async () => {
    const words = s.state.words;
    const noRel = words.filter(w => !w.related || !Array.isArray(w.related) || w.related.length === 0);
    const llm = await detectModel('relatedResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    if (noRel.length === 0) {
      const c = document.getElementById('relatedResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有相關詞了！</div>`; }
      return;
    }

    const taskId = 'gen-related-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生相關詞', noRel.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noRel.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array of synonyms/similar words for "${w.word}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`
          );
          if (relText && relText.trim()) {
            try {
              const cleaned = relText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
              const arr = JSON.parse(cleaned);
              await s.actions.editWord(w.id, { related: Array.isArray(arr) ? [...new Set(arr)] : [] });
              count++;
            } catch (_) { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noRel.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加相關詞${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('relatedResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加相關詞${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 相關詞完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  };

  window.__genFormsLLM = async () => {
    const words = s.state.words;
    const noForms = words.filter(w => !w.forms || !Array.isArray(w.forms) || w.forms.length === 0);
    const llm = await detectModel('formsResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    if (noForms.length === 0) {
      const c = document.getElementById('formsResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有詞形變化了！</div>`; }
      return;
    }

    const taskId = 'gen-forms-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生詞形變化', noForms.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noForms.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array of inflections/derivations (past tense, -ing, -s, past participle) for "${w.word}". Example: ["gets","got","getting"]. Only the JSON array, no markdown.`
          );
          if (relText && relText.trim()) {
            try {
              const cleaned = relText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
              const arr = JSON.parse(cleaned);
              await s.actions.editWord(w.id, { forms: Array.isArray(arr) ? [...new Set(arr)] : [] });
              count++;
            } catch (_) { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noForms.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加詞形變化${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('formsResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加詞形變化${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 詞形變化完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  };

  window.__lookupCambridge = async () => {
    const word = document.getElementById('cambridgeWord')?.value?.trim();
    if (!word) { toast('請輸入單字', ''); return; }
    const lang = _getMethod('cambridgeDict', 'en');
    const el = document.getElementById('cambridgeResult');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<div>查詢中...</div>`;
    try {
      const json = await lookupCambridge(word, lang);
      const data = JSON.parse(json);
      let html = `<div style="padding:8px;background:var(--bg-base);border-radius:var(--r1)">`;
      html += `<div style="font-size:16px;font-weight:600;margin-bottom:4px">${data.word}</div>`;
      if (data.uk_ipa || data.us_ipa) {
        html += `<div style="margin-bottom:6px;font-size:13px;color:var(--text-secondary)">`;
        if (data.uk_ipa) html += `UK: ${data.uk_ipa} `;
        if (data.us_ipa) html += `US: ${data.us_ipa}`;
        html += `</div>`;
      }
        for (const s of (data.senses || [])) {
        const posCN = _posCN;
        const pos = (s.part_of_speech || '').split(',').map(p => posCN[p.trim()] || p.trim()).join(', ');
        html += `<div style="margin-top:4px;padding:6px;background:var(--bg-secondary);border-radius:var(--r1)">`;
        html += `<div style="font-size:12px;color:var(--accent);margin-bottom:2px">${pos}${s.cefr_level ? ` <span style="color:var(--orange)">${s.cefr_level}</span>` : ''}</div>`;
        html += `<div style="font-size:13px;margin-bottom:2px">${icon('info')} ${s.definition}</div>`;
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
    window.__maxExampleLines = parseInt(exampleDisplayMax.value, 10) || 0;
    import('../lib/db.js').then(m => m.getSetting('exampleDisplayMax')).then(v => {
      const n = parseInt(v, 10);
      if (n > 0) { window.__maxExampleLines = n; exampleDisplayMax.value = n; }
    }).catch(() => {});
    exampleDisplayMax.addEventListener('input', () => {
      const n = parseInt(exampleDisplayMax.value, 10) || 0;
      window.__maxExampleLines = n;
      import('../lib/db.js').then(m => m.setSetting('exampleDisplayMax', String(n))).catch(() => {});
    });
  }

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
