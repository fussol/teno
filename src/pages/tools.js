import { icon } from '../lib/svg.js';
import { normalizePos } from '../core/import.js'; // G-TOOL1＋COMBO1: 組合包外只剩 __lookupCambridge 用（去尾點＋短形映射＋去重）
import { toast } from '../lib/toast.js';
import { fetchGet, fetchLLM, lookupCambridge } from '../lib/api.js';

// OCR token 白名單（計畫 v1.3 §5，與 store.importOcrText 端同一正則）
const _OCR_TOKEN_RE = /^[a-z][a-z'-]{1,30}$/i;

// G-XSS6: 本地 escape（全檔原零設施；體檢 issues 列表插使用者字串）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function render(s) {
  const tasks = s.state.backgroundTasks || [];
  const running = tasks.filter(t => t.status === 'running');
  const done = tasks.filter(t => t.status !== 'running');
  const _selHtml = (id, opts, fallback) => `<div class="cs" id="${id}Cs"><button class="cs-t" data-id="${id}" data-value="${fallback}">${opts.find(o=>o[1]===fallback)[0]}${icon('chevron-down', 10, 'cs-a')}</button><div class="cs-m">${opts.map(o=>`<div class="cs-o${o[1]===fallback?' s':''}" data-value="${o[1]}">${o[0]}</div>`).join('')}</div></div>`;
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
      .switch-sm{width:32px;height:18px;flex-shrink:0}
      .switch-sm::after{width:12px;height:12px;top:2px;left:3px}
      .switch-sm.on::after{left:15px}
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
          <div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r1);font-size:12px;color:var(--text-secondary)">${t.result.message}</div>
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
      <div style="display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s3)">
        <div class="switch" id="autofillOverwriteSwitch" role="switch" aria-checked="false" title="覆寫已有欄位"></div>
        <span style="font-size:12px;color:var(--text-secondary)">覆寫已有欄位（開＝整欄取代＋無視門檻；關＝只補缺失）</span>
      </div>
    <!-- 組合包：一鍵全補（2026-09-08 使用者裁示：裸詞一次填滿，各欄來源可調＋記憶＋可收合；COMBO1 起十一欄各別開關，獨立卡併入） -->
      <div class="card" style="margin-bottom:var(--s3)">
        <div class="card-title">${icon('sparkle')} 一鍵全補組合包</div>
        <div class="card-desc">只挑已啟用欄位全空的裸詞（只有單字），按下面選的來源一次填完；字源/音節只吃韋氏；開關關掉的欄位不會動；每欄「覆寫」開＝該欄直接覆蓋原本內容（預設全關＝只補缺失）；全域覆寫開＝全部欄位重跑。來源選擇、開關與覆寫都會記住（含收合狀態）。</div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          <button class="btn btn-sm" id="comboToggle">收合來源設定 ▾</button>
          <button class="btn" onclick="window.__comboFull()">${icon('sparkle')} 開始全補</button>
          <button class="btn btn-sm" id="comboAllOn">全選</button>
          <button class="btn btn-sm" id="comboAllOff">全關</button>
          <button class="btn btn-sm" id="comboOwAllOn">覆寫全開</button>
          <button class="btn btn-sm" id="comboOwAllOff">覆寫全關</button>
        </div>
        <div id="comboSrcGrid" style="display:grid;gap:var(--s2);margin-bottom:var(--s2)">
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_pos" role="switch" aria-checked="true" title="是否補詞性"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">詞性</span>${_selHtml('comboPos', [['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_pos" role="switch" aria-checked="false" title="覆寫已有詞性"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_example" role="switch" aria-checked="true" title="是否補例句"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">例句</span>${_selHtml('comboExample', [['字典 API','dictionary-api'],['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['Tatoeba 例句','tatoeba'],['本地 LLM','llm']], 'dictionary-api')}<div class="switch switch-sm" id="comboOw_example" role="switch" aria-checked="false" title="覆寫已有例句"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_pron" role="switch" aria-checked="true" title="是否補發音"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">發音</span>${_selHtml('comboPron', [['Cambridge 字典','cambridge'],['韋氏字典','merriam'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_pron" role="switch" aria-checked="false" title="覆寫已有發音"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_related" role="switch" aria-checked="true" title="是否補相關詞"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">相關詞</span>${_selHtml('comboRelated', [['本地 LLM','llm'],['韋氏字典','merriam']], 'llm')}<div class="switch switch-sm" id="comboOw_related" role="switch" aria-checked="false" title="覆寫已有相關詞"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_forms" role="switch" aria-checked="true" title="是否補詞形"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">詞形</span>${_selHtml('comboForms', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_forms" role="switch" aria-checked="false" title="覆寫已有詞形"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_trans" role="switch" aria-checked="true" title="是否補翻譯"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">翻譯</span>${_selHtml('comboTrans', [['Cambridge 英中','cambridge'],['本地 LLM','llm']], 'cambridge')}<div class="switch switch-sm" id="comboOw_trans" role="switch" aria-checked="false" title="覆寫已有翻譯"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_syn" role="switch" aria-checked="true" title="是否補同義詞"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">同義詞</span>${_selHtml('comboSyn', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_syn" role="switch" aria-checked="false" title="覆寫已有同義詞"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_ant" role="switch" aria-checked="true" title="是否補反義詞"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">反義詞</span>${_selHtml('comboAnt', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_ant" role="switch" aria-checked="false" title="覆寫已有反義詞"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_phrase" role="switch" aria-checked="true" title="是否補片語"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">片語</span>${_selHtml('comboPhrase', [['韋氏字典','merriam'],['本地 LLM','llm']], 'merriam')}<div class="switch switch-sm" id="comboOw_phrase" role="switch" aria-checked="false" title="覆寫已有片語"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_etymology" role="switch" aria-checked="true" title="是否補字源"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">字源</span><span style="font-size:12px;color:var(--text-tertiary)">韋氏字典（固定）</span><div class="switch switch-sm" id="comboOw_etymology" role="switch" aria-checked="false" title="覆寫已有字源"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
          <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap"><div class="switch switch-sm on" id="comboOn_syllables" role="switch" aria-checked="true" title="是否補音節"></div><span style="font-size:12px;min-width:52px;color:var(--text-secondary)">音節</span><span style="font-size:12px;color:var(--text-tertiary)">韋氏字典（固定）</span><div class="switch switch-sm" id="comboOw_syllables" role="switch" aria-checked="false" title="覆寫已有音節"></div><span style="font-size:11px;color:var(--text-tertiary)">覆寫</span></div>
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

// ─── 來源記憶（2026-09-08 使用者裁示）：全部來源選單＋組合包收合狀態＋欄位開關（COMBO1）───
// 存 db setting methodSources（JSON；demo 走記憶體）。恢復時直接讀 DOM 選項
// 反查 label，不在 JS 另存選項表（render 改選項不用同步這裡）。
let _srcMem = null; // { selectors: {id: value}, comboCollapsed: bool, comboOn: {field: bool}, comboOw: {field: bool} }
const _SRC_BLOB_KEY = 'methodSources';
function _saveSrcMem() {
  const snap = JSON.stringify(_srcMem || {});
  import('../lib/db.js').then(m => m.setSetting(_SRC_BLOB_KEY, snap)).catch(() => {});
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
export function onMount(s) {
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

  // ─── C段：自動補齊全域覆寫開關（db setting autofillOverwrite，預設關）───
  // 開＝組合包全部欄位取代＋無視門檻；關＝各欄覆寫開關各管各欄。組合包經 _ow() 讀取。
  let _autofillOverwrite = false;
  const _ow = () => _autofillOverwrite;
  const _owTag = () => (_autofillOverwrite ? '（覆寫模式）' : '');
  import('../lib/db.js').then(m => m.getSetting('autofillOverwrite')).then(v => {
    _autofillOverwrite = v === '1' || v === true;
    const sw = document.getElementById('autofillOverwriteSwitch');
    if (sw) { sw.classList.toggle('on', _autofillOverwrite); sw.setAttribute('aria-checked', String(_autofillOverwrite)); }
  }).catch(() => {});
  document.getElementById('autofillOverwriteSwitch')?.addEventListener('click', async () => {
    _autofillOverwrite = !_autofillOverwrite;
    const sw = document.getElementById('autofillOverwriteSwitch');
    if (sw) { sw.classList.toggle('on', _autofillOverwrite); sw.setAttribute('aria-checked', String(_autofillOverwrite)); }
    try {
      const { setSetting } = await import('../lib/db.js');
      await setSetting('autofillOverwrite', _autofillOverwrite ? '1' : '0');
    } catch (_) {}
    toast(_autofillOverwrite ? '覆寫模式開：自動補齊將取代已有欄位' : '覆寫模式關：只補缺失欄位', '');
  });

  // ─── 來源記憶載入＋組合包收合開關（每導航一次跑一次；存檔走 module 級 _srcMem）───
  import('../lib/db.js').then(m => m.getSetting(_SRC_BLOB_KEY)).then(v => {
    try {
      const stored = v ? JSON.parse(v) : null;
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
    // COMBO2: 逐欄覆寫（全域開＝全部重跑；否則各欄開關各管各欄，預設全關＝只補缺失）
    const owEff = {};
    for (const f of on) owEff[f] = _ow() || _comboOw(f);
    const owFields = on.filter(f => owEff[f]);
    const owTag = _ow() ? '（覆寫模式）' : (owFields.length ? `（覆寫：${owFields.map(f => COMBO_CN[f]).join('、')}）` : '');
    // COMBO2: 挑字（全域覆寫開＝全量；否則裸詞＋覆寫欄有料的字；覆寫欄全關時退化成裸詞）
    const targets = _ow() ? [...s.state.words] : s.state.words.filter(w => _isBare(w) || on.some(f => owEff[f] && !_isEmptyField(f, w)));
    if (!targets.length) {
      say(`<div style="color:var(--green)">${icon('check')} 沒有需要全補的單字${_ow() || owFields.length ? '' : '（已啟用欄位全空的裸詞）'}！</div>`);
      return;
    }
    const vals = Object.values(M);
    if (vals.includes('merriam') && _mwKeyMissing()) return;
    // 詞形固定 LLM → 有 LLM 欄就偵測；連不上則 LLM 欄跳過、其餘照做
    let llm = null, llmOk = false;
    if (vals.includes('llm')) {
      llm = await detectModel('comboResult');
      llmOk = !!llm;
      if (!llmOk) toast('連不上 Ollama：LLM 來源的欄位會跳過，其餘照做', 'toast-warn');
    } else hideLlmRow();
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
      let html = `<div style="padding:8px;background:var(--bg-base);border-radius:var(--r1)">`;
      html += `<div style="font-size:16px;font-weight:600;margin-bottom:4px">${data.word}</div>`;
      if (data.uk_ipa || data.us_ipa) {
        html += `<div style="margin-bottom:6px;font-size:13px;color:var(--text-secondary)">`;
        if (data.uk_ipa) html += `UK: ${data.uk_ipa} `;
        if (data.us_ipa) html += `US: ${data.us_ipa}`;
        html += `</div>`;
      }
        for (const s of (data.senses || [])) {
        const pos = normalizePos(s.part_of_speech || '');
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
