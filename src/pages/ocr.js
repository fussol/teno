// ═══════════════════════════════════════════════════════════════
// OCR 工具獨立頁 — 取圖雙源 ＋ 矩形切割 ＋ 辨識 ＋ 候選入庫
// 計畫：OCR-CAPTURE-fix-plan.md（總統直修，過審 ✅ 2026-08-29）
//
// 取圖：原生相機（capture=environment）／匯入照片（image/*）
// 切割：影像回顯 → 拖矩形 overlay（顯示座標）→ 映射回原圖 → canvas 裁切 → File
// 辨識：既有 getActiveEngine().recognize(cropFile) → token 白名單 → 候選
// 入庫：s.actions.importOcrText（黑名單/Cambridge/補欄位 pipeline 原封不動）
// ═══════════════════════════════════════════════════════════════
import { icon } from '../lib/svg.js';
import { toast } from '../lib/toast.js';
import { listEngines } from '../lib/ocr/engine.js';
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_KEYS } from '../lib/ocr/preprocess.js';
import { cornersToRect, defaultCorners, moveCorner, untangleCorners } from '../lib/ocr/crop.js';

// OCR token 白名單（計畫 v1.3 §5，與 tools.js 舊 block / store.importOcrText 同一正則）
const _OCR_TOKEN_RE=/^[a-z][a-z'-]{1,30}$/i;

// ═══ F′ 匯入來源擴充 — 純函式層（export 供 harness/測試直接驗證）═══
// 文字副檔名：.txt / .md / .csv / .srt（type 空值時的兜底判定）
const _TEXT_EXT = /\.(txt|md|markdown|csv|srt|tsv|log)$/i;

/** 檔案分類：text（fast-path 跳 OCR）/ image（原 OCR pipeline）/ pdf（後續）/ other */
export function classifyImportFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  if (type.startsWith('text/') || type === 'application/json' || _TEXT_EXT.test(name)) return 'text';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return 'image';
  return 'other';
}

/** 文字檔 → token 陣列：白名單 regex + 去重 + 去 noise（數字/標點/網址/markdown 符號/超長）。
 *  與 OCR 辨識後的 token 白名單同正則（_OCR_TOKEN_RE），保持兩路徑語意一致。 */
export function extractTextTokens(text) {
  const seen = new Set();
  const out = [];
  const raw = String(text || '');
  for (const line of raw.split(/[\r\n]+/)) {
    // srt 時間戳行（00:00:01,000 --> ...）與純數字行整行跳過
    if (/^\d+(\r)?$/.test(line.trim()) || /-->/.test(line)) continue;
    for (let w of line.split(/[\s,;!?()\[\]{}|*#_~`"“”‘’]+/)) {
      w = w.toLowerCase()
        .replace(/^[^a-z-]+/, '')      // 前導非字母（含 **bold、-list）
        .replace(/[^a-z'-]+$/, '')      // 尾端非字母
        .replace(/^[-']+|[-']+$/g, '');  // 邊緣連字號/單引號修邊
      // 字內數字剝離（cat2→cat）；含 http/www 的 token（網址）直接淘汰
      if (/https?:|www\./.test(w)) continue;
      w = w.replace(/\d+/g, '');
      if (!w || !_OCR_TOKEN_RE.test(w) || seen.has(w)) continue;
      seen.add(w); out.push(w);
    }
  }
  return out;
}

const _ENG_LABELS = { tesseract: 'Tesseract.js (預設)', paddle: 'PaddleOCR 輕量版', 'vision-ai': 'Vision AI (Ollama) · 桌面限定' };

/** 螢光筆色卡 swatch 顯示色（近似色相中點顯示用，非過濾範圍） */
const SWATCH = { yellow: '#f5d75c', green: '#6ee06b', pink: '#f07fb6' };

/** 桌面 Tauri 環境判定（非 Android/mobile；node harness 安全）——vision-ai 僅桌面列出 */
function _isDesktop() {
  try {
    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    if (/Android|Mobi|iPhone|iPad|iPod/i.test(ua)) return false;
    return !!(typeof window !== 'undefined' && window.__TAURI__?.core);
  } catch (_) { return false; }
}

/** 引擎選單選項（vision-ai 依桌面限定過濾），純函式供 harness/測試注入判定 */
export function engineSelectOptions(isDesktop = _isDesktop()) {
  return listEngines()
    .filter(e => e.id !== 'vision-ai' || isDesktop)
    .map(e => ({ id: e.id, label: _ENG_LABELS[e.id] || e.id }));
}

/** 顯示座標 → 原圖座標 映射（純函式，供 harness 測試） */
export function mapToSource(sx, sy, dispW, dispH, imgW, imgH) {
  const sxr = dispW > 0 ? imgW / dispW : 0;
  const syr = dispH > 0 ? imgH / dispH : 0;
  const sx2 = Math.max(0, Math.min(imgW, Math.round(sx * sxr)));
  const sy2 = Math.max(0, Math.min(imgH, Math.round(sy * syr)));
  return { sx: sx2, sy: sy2 };
}

function _label(id, opts, fallback) {
  return `<div class="cs" id="${id}Cs"><button class="cs-t" data-id="${id}" data-value="${fallback}">${opts.find(o => o[1] === fallback)[0]}${icon('chevron-down', 10, 'cs-a')}</button><div class="cs-m">${opts.map(o => `<div class="cs-o${o[1] === fallback ? ' s' : ''}" data-value="${o[1]}">${o[0]}</div>`).join('')}</div></div>`;
}

export function render(s) {
  return `
    <style>
      .ocr-page{max-width:640px;margin:0 auto}
      .ocr-back{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer;margin-bottom:var(--s3);padding:6px 10px;border-radius:var(--r1);border:1px solid transparent;transition:.15s;background:transparent;font-family:inherit}
      .ocr-back:hover{color:var(--text-primary);border-color:var(--border)}
      .ocr-sources{display:flex;gap:var(--s2);margin-bottom:var(--s3);flex-wrap:wrap}
      .ocr-source-btn{flex:1;min-width:150px;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;transition:.15s}
      .ocr-source-btn:hover{border-color:var(--accent);background:var(--bg-hover)}
      .ocr-source-btn .ico{color:var(--accent)}
      .ocr-stage{display:none;margin-top:var(--s2)}
      .ocr-img-wrap{position:relative;width:100%;overflow:hidden;border-radius:var(--r-md);border:1px solid var(--border);background:#000;-webkit-user-select:none;user-select:none}
      .ocr-img-wrap.cutting{-webkit-user-select:none;user-select:none;touch-action:none}
      .ocr-crop-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}
      .ocr-crop-handle{position:absolute;width:20px;height:20px;border-radius:50%;background:var(--accent);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);pointer-events:auto;z-index:4;cursor:grab;touch-action:none;transform:translate(-50%,-50%)}
      /* OCR3 全螢幕切割 overlay：圖區鎖 touch-action，外層可滑說明 */
      .ocr-ov{position:fixed;inset:0;z-index:150;background:rgba(0,0,0,.92);display:flex;flex-direction:column}
      .ocr-ov-head{display:flex;align-items:center;gap:8px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top,0));background:var(--bg-surface);border-bottom:1px solid var(--border)}
      .ocr-ov-title{font-size:14px;font-weight:700;color:var(--text-primary);flex:1}
      .ocr-ov-dims{font-size:11px;color:var(--text-tertiary);font-family:var(--mono,monospace)}
      .ocr-ov-zoom{display:flex;gap:4px;align-items:center}
      .ocr-ov-zoom button{min-width:36px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-primary);font-size:13px;font-weight:700;cursor:pointer}
      .ocr-ov-zoom button.on{border-color:var(--accent);color:var(--accent)}
      .ocr-ov-stage{flex:1;overflow:auto;position:relative;display:flex;align-items:center;justify-content:center;padding:12px;touch-action:pan-x pan-y}
      .ocr-ov-imgbox{position:relative;touch-action:none;flex-shrink:0}
      .ocr-ov-img{display:block;user-select:none;-webkit-user-select:none;-webkit-user-drag:none}
      .ocr-ov-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}
      .ocr-ov-handle{position:absolute;width:36px;height:36px;border-radius:50%;background:var(--accent);border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.6),0 0 0 8px rgba(182,157,255,.18);pointer-events:auto;z-index:4;cursor:grab;touch-action:none;transform:translate(-50%,-50%)}
      .ocr-ov-foot{padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom,0));background:var(--bg-surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .ocr-ov-hint{font-size:11px;color:var(--text-tertiary);flex:1;min-width:140px}
      .ocr-img{display:block;width:100%;height:auto}
      .ocr-hl-row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin:-6px 0 var(--s3)}
      .ocr-hl-row .hl-tag{font-size:12px;color:var(--text-secondary);white-space:nowrap}
      .ocr-hl-color{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:var(--r1);border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;transition:.15s}
      .ocr-hl-color.active{border-color:var(--accent);background:var(--bg-hover)}
      .ocr-hl-swatch{width:10px;height:10px;border-radius:50%;flex:none}
      .ocr-crop-row{display:flex;gap:var(--s2);margin-top:var(--s2);align-items:center;flex-wrap:wrap}
      .ocr-hint{font-size:11px;color:var(--text-tertiary)}
      .ocr-result{display:none;margin-top:var(--s3)}
      .ocr-loading{display:none;padding:8px;text-align:center;color:var(--text-secondary);font-size:13px}
      .ocr-cand-title{font-size:12px;color:var(--text-secondary);margin-bottom:6px}
      .ocr-cand-list{max-height:240px;overflow-y:auto}
      .ocr-cand{display:flex;align-items:center;gap:8px;padding:5px 6px;margin-bottom:2px;background:var(--bg-secondary);border-radius:var(--r1);font-size:13px;cursor:pointer}
      .ocr-cand input{accent-color:var(--accent)}
      .ocr-cand span{color:var(--text-primary)}
      .ocr-mask-badge{font-size:11px;color:var(--text-tertiary);font-weight:400}
      .ocr-cand-row{display:flex;gap:var(--s2);align-items:center;margin-top:var(--s2)}
      .ocr-dim-label{font-size:11px;color:var(--text-tertiary);flex:1;text-align:right}
    </style>

    <div class="ocr-page">
      <button class="ocr-back" id="ocrBackBtn">${icon('chevronL')} 返回工具</button>
      <div class="page-title">${icon('camera')} OCR 辨識字卡</div>
      <div class="page-subtitle">拍照或選圖，在畫面上圈出要辨識的區域，自動加入字本</div>

      <!-- OCR 模式切換 → 決定過濾策略（掃描 vs 螢光筆），取圖來源在下方 -->
      <div style="display:flex;gap:var(--s2);margin-bottom:var(--s3)">
        ${['scan', 'highlight'].map(m => `
          <button class="ocr-mode-btn${s.state.ocrMode === m ? ' active' : ''}" data-mode="${m}" data-active="${s.state.ocrMode === m}" style="flex:1;padding:10px 12px;border-radius:var(--r-md);border:1px solid ${s.state.ocrMode === m ? 'var(--accent)' : 'var(--border)'};background:${s.state.ocrMode === m ? 'var(--bg-hover)' : 'var(--bg-surface)'};color:var(--text-primary);cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;transition:.15s">
            ${icon(m === 'scan' ? 'scan' : 'edit')} ${m === 'scan' ? '全掃描' : '螢光筆'}
          </button>`).join('')}
      </div>

      <!-- 螢光筆顏色（僅 highlight 模式；HSV 過濾色卡可調） -->
      <div class="ocr-hl-row" id="ocrHlRow" style="display:${s.state.ocrMode === 'highlight' ? 'flex' : 'none'}">
        <span class="hl-tag">螢光筆顏色</span>
        ${HIGHLIGHTER_KEYS.map(k => {
          const c = HIGHLIGHTER_COLORS[k];
          const active = (s.state.ocrHighlightColor || 'yellow') === k;
          return `
          <button class="ocr-hl-color${active ? ' active' : ''}" data-hl-color="${k}" data-active="${active}" style="border-color:${active ? 'var(--accent)' : 'var(--border)'}">
            <span class="ocr-hl-swatch" style="background:${SWATCH[k]}"></span> ${c.name}
          </button>`;
        }).join('')}
      </div>

      <!-- 取圖雙源 -->
      <div class="ocr-sources">
        <button class="ocr-source-btn" id="ocrCaptureBtn">
          <span class="ico">${icon('camera')}</span> 原生相機
        </button>
        <button class="ocr-source-btn" id="ocrImportBtn">
          <span class="ico">${icon('image')}</span> 匯入檔案
        </button>
      </div>
      <input type="file" id="ocrCameraInput" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="ocrImportInput" accept="image/*,.pdf,.txt,.md,.csv,.srt,text/*" multiple style="display:none">

      <!-- 辨識引擎選單 -->
      <div style="display:flex;gap:var(--s2);margin-bottom:var(--s3);align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-tertiary);white-space:nowrap">辨識引擎</span>
        <select id="ocrEngineSelect" class="form-input" style="padding:6px;border-radius:4px;font-size:12px">${engineSelectOptions().map(e => `<option value="${e.id}">${e.label}</option>`).join('')}</select>
      </div>

      <!-- 影像預覽＋切割（B′ 兩態：preview 純瀏覽 / cutting 四角成型） -->
      <div class="ocr-stage" id="ocrStage">
        <div class="ocr-img-wrap" id="ocrImgWrap">
          <img id="ocrImgEl" class="ocr-img" alt="待辨識影像">
          <svg class="ocr-crop-svg" id="ocrCropSvg" style="display:none" preserveAspectRatio="none">
            <polygon id="ocrCropPoly" fill="rgba(59,130,246,.16)" stroke="var(--accent)" stroke-width="2" />
          </svg>
          <div class="ocr-crop-handle" id="ocrHandle0" style="display:none"></div>
          <div class="ocr-crop-handle" id="ocrHandle1" style="display:none"></div>
          <div class="ocr-crop-handle" id="ocrHandle2" style="display:none"></div>
          <div class="ocr-crop-handle" id="ocrHandle3" style="display:none"></div>
        </div>
        <div class="ocr-crop-row">
          <button class="btn" id="ocrCutStartBtn" style="flex:0">${icon('scan')} 切割</button>
          <button class="btn" id="ocrCutDoneBtn" style="display:none;flex:0">${icon('check')} 完成</button>
          <button class="btn" id="ocrCutCancelBtn" style="display:none;flex:0">${icon('x')} 取消</button>
          <button class="btn" id="ocrClearCropBtn" style="display:none">${icon('x')} 清除</button>
          <button class="btn" id="ocrConfirmBtn" style="flex:1">${icon('check')} 辨識已選取範圍</button>
          <span class="ocr-dim-label" id="ocrDimLabel"></span>
        </div>
        <div class="ocr-hint" id="ocrHint">預覽圖可直接下滑瀏覽；按「切割」進全螢幕切割畫面（字太小會自動局部掃描補第二槍）</div>
      </div>

      <!-- OCR3 全螢幕切割畫面（overlay；預覽頁保持純瀏覽可滑動） -->
      <div class="ocr-ov" id="ocrCropOverlay" style="display:none">
        <div class="ocr-ov-head">
          <span class="ocr-ov-title">切割照片</span>
          <span class="ocr-ov-dims" id="ocrOvDims"></span>
          <div class="ocr-ov-zoom" id="ocrOvZoom">
            <button data-zoom="1" class="on">1x</button>
            <button data-zoom="1.5">1.5x</button>
            <button data-zoom="2">2x</button>
          </div>
        </div>
        <div class="ocr-ov-stage" id="ocrOvStage">
          <div class="ocr-ov-imgbox" id="ocrOvImgBox">
            <img id="ocrOvImg" class="ocr-ov-img" alt="待切割影像">
            <svg class="ocr-ov-svg" id="ocrOvSvg" preserveAspectRatio="none">
              <polygon id="ocrOvPoly" fill="rgba(59,130,246,.16)" stroke="var(--accent)" stroke-width="2" />
            </svg>
            <div class="ocr-ov-handle" id="ocrOvHandle0" style="display:none"></div>
            <div class="ocr-ov-handle" id="ocrOvHandle1" style="display:none"></div>
            <div class="ocr-ov-handle" id="ocrOvHandle2" style="display:none"></div>
            <div class="ocr-ov-handle" id="ocrOvHandle3" style="display:none"></div>
          </div>
        </div>
        <div class="ocr-ov-foot">
          <button class="btn" id="ocrOvCancel">${icon('x')} 取消</button>
          <span class="ocr-ov-hint">拖曳四個圓點框選；可放大微調；完成後回預覽辨識</span>
          <button class="btn" id="ocrOvDone" style="flex:1">${icon('check')} 完成</button>
        </div>
      </div>

      <!-- 結果 -->
      <div class="ocr-result" id="ocrResultArea">
        <div class="ocr-loading" id="ocrLoading">辨識中...</div>
        <div id="ocrCandidatesContainer" style="display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="display:flex;gap:2px;align-items:center" id="ocrTabsDots"></div>
            <div style="font-size:12px;color:var(--text-tertiary)" id="ocrTabTitle"></div>
          </div>
          <div id="ocrSwipeWrap" style="overflow-x:hidden;position:relative">
            <div id="ocrSwipeTrack" style="display:flex;transition:transform .18s ease;will-change:transform">
              <div class="ocr-cand-list" id="ocrListNew" style="flex:0 0 100%"></div>
              <div class="ocr-cand-list" id="ocrListDup" style="flex:0 0 100%"></div>
              <div class="ocr-cand-list" id="ocrListNoise" style="flex:0 0 100%"></div>
            </div>
          </div>
          <div class="ocr-cand-row">
            <button class="btn btn-sm" id="ocrSelectAllBtn">全選</button>
            <button class="btn btn-sm" id="ocrSelectNoneBtn">全不選</button>
            <button class="btn" id="ocrDupMoveBtn" style="display:none;flex:0 0 auto">${icon('shuffle')} 批量轉移勾選到字本</button>
            <button class="btn" id="ocrConfirmImportBtn" style="flex:1">${icon('check')} 將勾選單字加入字本</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function onMount(s) {
  const $ = (id) => document.getElementById(id);
  const backBtn   = $('ocrBackBtn');
  const capBtn    = $('ocrCaptureBtn');
  const impBtn    = $('ocrImportBtn');
  const camIn     = $('ocrCameraInput');
  const impIn     = $('ocrImportInput');
  const engSel    = $('ocrEngineSelect');
  const stage     = $('ocrStage');
  const wrap      = $('ocrImgWrap');
  const imgEl     = $('ocrImgEl');
  const svgEl     = $('ocrCropSvg');
  const polyEl    = $('ocrCropPoly');
  const handles   = [0, 1, 2, 3].map(i => $('ocrHandle' + i));
  const cutStartBtn = $('ocrCutStartBtn');
  const clearBtn  = $('ocrClearCropBtn');
  const confBtn   = $('ocrConfirmBtn');
  const dimLabel  = $('ocrDimLabel');
  const hint      = $('ocrHint');
  const area      = $('ocrResultArea');
  const loadEl    = $('ocrLoading');
  const candC     = $('ocrCandidatesContainer');
  // 註：舊單清單 #ocrCandidatesList 已隨三頁籤 UI（ocrListNew/Dup/Noise，
  // 元首令 2026-09-01 v2）退役，此處不再綁定。候選渲染一律走
  // appendCandidates()（classifyTokens＋renderTabs）；容器級查詢用 candC。

  if (!capBtn || !impBtn || !engSel) return;

  let _busy = false;
  let _imgW = 0, _imgH = 0;        // 原圖尺寸
  let dispW = 0, dispH = 0;        // 顯示尺寸（由 wrap rect 即時量）
  let _crop = null;                // 顯示座標 {x,y,w,h}（由四角 cornersToRect 收斂）
  let _cropMode = 'preview';       // B′ 兩態：preview 純瀏覽（不綁切割）/ cutting 四角成型
  let _corners = null;             // cutting 態的四角 [{x,y}×4]（顯示座標）
  let _savedCrop = null;           // enterCutting 前的裁剪快照（「取消」回退用）
  let _dragIdx = null;             // 正在拖動的 handle 索引
  let _file = null;                // 目前載入的原始 File（不圈選時直接饋引擎，繞開 canvas 污染）

  // 引擎選單還原＋持久化（原生 select.value，禁讀 cs trigger 文案）
  import('../lib/db.js').then(m => m.getSetting('ocr_engine')).then(v => {
    if (typeof v === 'string' && Array.from(engSel.options).some(o => o.value === v)) engSel.value = v;
  }).catch(() => {});
  engSel.addEventListener('change', () => {
    import('../lib/db.js').then(m => m.setSetting('ocr_engine', engSel.value)).catch(() => {});
  });

  const allBtn = (ids) => ids.map(id => document.getElementById(id));

  backBtn?.addEventListener('click', () => s.actions.navigate('tools'));

  const _setBusy = (b) => {
    _busy = b;
    [capBtn, impBtn].forEach(bn => { bn.disabled = b; bn.style.opacity = b ? '.5' : ''; });
  };

  const _resetResult = () => {
    area.style.display = 'none';
    loadEl.style.display = 'none';
    // 連拍保護（2026-09-01）：候選清單有累積批（_batchTokens 非空）時不清 —
    // runFile→_showStage 在拍下一張時會走這裡，清了候選就斷連拍累積。
    if (_batchTokens.size === 0) candC.style.display = 'none';
  };
  /** 連拍批次結束（匯入完成或使用者手動清）：清累積批，恢復 _resetResult 清候選行為 */
  const _endBatch = () => { _batchTokens = new Set(); };

  // ─── 三清單候選系統（元首令 2026-09-01 v2）：OCR 主頁同款 ───
  // 全新不重複（預設勾）／重複（可批量轉移字本）／黑灰名單+雜訊（勾=override 強制加入）
  // 手機左右滑切換；電腦 ←→ 切換清單、↑↓ 逐字焦點、Space/Enter 切勾選。
  let _tabIdx = 0;
  const TAB_NAMES = ['全新單字', '重複', '黑灰名單與雜訊'];
  let _newTokens = new Map();    // token → 還原標記（可選）
  let _dupTokens = new Set();
  let _noiseTokens = new Set();
  const COMMON3 = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'];
  function isNoiseToken(t) {
    if (s.actions.isBlacklisted?.(t) || s.actions.isGraylisted?.(t)) return true;
    if (t.length <= 2) return true;
    if (t.length === 3 && !COMMON3.includes(t)) return true;
    return false;
  }
  function activeListEl() {
    return [$('ocrListNew'), $('ocrListDup'), $('ocrListNoise')][_tabIdx];
  }
  function classifyTokens(tokens, restoreMap) {
    const map = restoreMap || {};
    for (const t of tokens) {
      if (isNoiseToken(t)) { _noiseTokens.add(t); continue; }
      const dup = (s.state.words || []).some(w => w.word === t);
      if (dup) { if (!_dupTokens.has(t)) _dupTokens.add(t); }
      else if (!_newTokens.has(t)) _newTokens.set(t, map[t] || null);
      else if (map[t] && !_newTokens.get(t)) _newTokens.set(t, map[t]);
    }
  }
  function renderTabs() {
    const lists = [
      { el: $('ocrListNew'), tokens: _newTokens, def: true },
      { el: $('ocrListDup'), tokens: _dupTokens, def: true },
      { el: $('ocrListNoise'), tokens: _noiseTokens, def: false },
    ];
    lists.forEach((L, i) => {
      if (!L.el) return;
      const prevChecked = new Set();
      L.el.querySelectorAll('.ocr-cand-cb:checked').forEach(cb => prevChecked.add(cb.dataset.w));
      const html = [];
      const keys = [...(L.tokens.keys ? L.tokens.keys() : L.tokens)].sort();
      for (const t of keys) {
        const bl = s.actions.isBlacklisted?.(t);
        const grey = !bl && s.actions.isGraylisted?.(t);
        const badge = i === 2 ? (bl ? ' 🔒黑名單' : grey ? ' 🔒灰名單' : ' 🚫雜訊') : '';
        const rest = i === 0 && L.tokens.get ? L.tokens.get(t) : null;
        const checked = prevChecked.has(t) ? 'checked' : (L.def ? 'checked' : '');
        html.push(`<label class="ocr-cand"><input type="checkbox" class="ocr-cand-cb" data-w="${t}" ${checked}><span>${t}${rest ? ` <em style="color:var(--accent);font-style:normal;font-size:10px">⇠ 由 ${rest} 還原</em>` : ''}${badge}</span></label>`);
      }
      L.el.innerHTML = html.join('') || `<div style="font-size:12px;color:var(--text-tertiary);padding:8px">（空）</div>`;
    });
    const dots = $('ocrTabsDots');
    if (dots) dots.innerHTML = [0, 1, 2].map(i =>
      `<span style="display:inline-block;width:${i === _tabIdx ? 18 : 7}px;height:7px;border-radius:4px;background:${i === _tabIdx ? 'var(--accent)' : 'var(--border)'};margin:0 2px;transition:all .15s"></span>`).join('');
    const title = $('ocrTabTitle');
    if (title) title.textContent = `${TAB_NAMES[_tabIdx]}（${lists[_tabIdx]?.tokens.size || 0} 字）— ←→ 或滑動切換`;
    const track = $('ocrSwipeTrack');
    if (track) track.style.transform = `translateX(-${_tabIdx * 100}%)`;
    const dupBtn = $('ocrDupMoveBtn');
    if (dupBtn) dupBtn.style.display = _tabIdx === 1 ? '' : 'none';
  }
  // 滑動切換
  let _swipeX = null;
  const swipeWrap = $('ocrSwipeWrap');
  swipeWrap?.addEventListener('pointerdown', (e) => { _swipeX = e.clientX; });
  swipeWrap?.addEventListener('pointerup', (e) => {
    if (_swipeX === null) return;
    const dx = e.clientX - _swipeX;
    if (dx < -40 && _tabIdx < 2) { _tabIdx++; renderTabs(); focusCand(0); }
    else if (dx > 40 && _tabIdx > 0) { _tabIdx--; renderTabs(); focusCand(0); }
    _swipeX = null;
  });
  // 鍵盤導航：←→ 切清單、↑↓ 焦點、Space/Enter 勾
  let _focusIdx = -1;
  function focusCand(idx) {
    const cbs = activeListEl()?.querySelectorAll('.ocr-cand-cb') || [];
    if (!cbs.length) { _focusIdx = -1; return; }
    _focusIdx = Math.max(0, Math.min(cbs.length - 1, idx));
    cbs.forEach((cb, i) => {
      const label = cb.closest('.ocr-cand');
      if (!label) return;
      if (i === _focusIdx) { label.style.outline = '2px solid var(--accent)'; label.style.outlineOffset = '1px'; cb.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else label.style.outline = '';
    });
  }
  function _ocrKeyNav(e) {
    if (!document.getElementById('ocrCandidatesContainer')) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if ((tag === 'input' && e.target?.type === 'text') || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (_tabIdx > 0) { _tabIdx--; renderTabs(); focusCand(0); } return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (_tabIdx < 2) { _tabIdx++; renderTabs(); focusCand(0); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); const cbs = activeListEl()?.querySelectorAll('.ocr-cand-cb') || []; focusCand(_focusIdx < 0 ? 0 : _focusIdx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusCand(Math.max(0, _focusIdx - 1)); return; }
    if (e.key === ' ' || e.key === 'Enter') {
      const cbs = activeListEl()?.querySelectorAll('.ocr-cand-cb') || [];
      if (_focusIdx >= 0 && cbs[_focusIdx]) { e.preventDefault(); cbs[_focusIdx].checked = !cbs[_focusIdx].checked; }
    }
  }
  document.addEventListener('keydown', _ocrKeyNav);
  { const pc = window.__pageCleanup; window.__pageCleanup = () => { document.removeEventListener('keydown', _ocrKeyNav); if (pc) try { pc(); } catch (_) {} }; }

  function appendCandidates(tokens, restoreMap, s2) {
    classifyTokens(tokens, restoreMap);
    renderTabs();
    candC.style.display = 'block';
  }

  const _showStage = () => {
    stage.style.display = 'block';
    _resetResult();
  };

  // 圖載入後：重設尺寸、回預覽態、清除切割、計算顯示比例
  function layoutImage() {
    const r = wrap.getBoundingClientRect();
    dispW = r.width;
    dispH = r.height;
    _crop = null;
    _corners = null;
    _cropMode = 'preview';
    wrap.classList.remove('cutting');
    svgEl.style.display = 'none';
    handles.forEach(h => { h.style.display = 'none'; });
    cutStartBtn.style.display = '';
    clearBtn.style.display = 'none';
    dimLabel.textContent = '';
    hint.textContent = '預覽圖可直接下滑瀏覽；按「切割」拖四角框選要辨識的區域';
  }

  // B′ cutting 視覺更新：畫 polygon 四角 + 放 handle
  function paintCorners() {
    if (_cropMode !== 'cutting' || !_corners) { svgEl.style.display = 'none'; return; }
    svgEl.style.display = 'block';
    polyEl.setAttribute('points', _corners.map(c => `${c.x},${c.y}`).join(' '));
    handles.forEach((h, i) => {
      h.style.display = 'block';
      h.style.left = _corners[i].x + 'px';
      h.style.top = _corners[i].y + 'px';
    });
  }
  // 由四角收斂到 _crop（顯示軸向矩形，供 cropToFile 用）
  function collapseCrop() {
    const r = cornersToRect(_corners);
    _crop = r;
    if (_crop) dimLabel.textContent = `${Math.max(1, Math.round(_crop.w * (_imgW / dispW)))} × ${Math.max(1, Math.round(_crop.h * (_imgH / dispH)))} px`;
  }

  // loadFile(imgEl)：把 file 塞進 <img>，resolve 後取得原始尺寸
  function loadFile(file) {
    _file = file;
    return new Promise((resolve, reject) => {
      // 用 FileReader 讀成 data: URL 作 img src——blob: URL 在 WebKitGTK(桌面 Tauri)
      // 渲染不出來(只顯黑框)，data: 是 same-origin 且 WebKitGTK 正常顯示；CSP 已允許。
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('無法讀取該影像'));
      fr.onload = () => {
        imgEl.onload = () => {
          _imgW = imgEl.naturalWidth;
          _imgH = imgEl.naturalHeight;
          layoutImage();
          resolve();
        };
        imgEl.onerror = () => reject(new Error('無法載入該影像'));
        imgEl.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function runFile(file) {
    if (_busy) return;
    _setBusy(true);
    _showStage();   // 先顯示 stage，wrap 才有真實 rect（layoutImage 依此量 dispW/H）
    loadFile(file)
      .catch(e => toast(`載入失敗：${e.message}`, 'toast-error'))
      .finally(() => _setBusy(false));
  }

  // ─── OCR 模式切換（scan 全掃描 / highlight 螢光筆）＋持久化 ───
  let _mode = s.state.ocrMode || 'scan';
  let _hlColor = s.state.ocrHighlightColor || 'yellow';
  const hlRow = $('ocrHlRow');
  const modeBtns = document.querySelectorAll('.ocr-mode-btn');
  // 螢光筆顏色選擇（僅 highlight；持久化 ocrHighlightColor，存 db 非 store）
  const hlColorBtns = Array.from(document.querySelectorAll('.ocr-hl-color'));
  const _applyHlColor = (k) => {
    _hlColor = k;
    s.state.ocrHighlightColor = k;   // session 回寫，render 再進才一致（A3 同族）
    hlColorBtns.forEach(b => {
      const on = b.dataset.hlColor === k;
      b.dataset.active = String(on);
      b.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
      b.classList.toggle('active', on);
    });
  };
  // A2 修復：ocrHighlightColor 不只寫，onMount 還原（比照引擎選單模式）
  import('../lib/db.js').then(m => m.getSetting('ocrHighlightColor')).then(v => {
    if (typeof v === 'string' && HIGHLIGHTER_KEYS.includes(v)) { _hlColor = v; _applyHlColor(v); }
  }).catch(() => {});
  hlColorBtns.forEach(btn => btn.addEventListener('click', async () => {
    if (_busy || _mode !== 'highlight') return;
    _applyHlColor(btn.dataset.hlColor);
    try {
      const { setSetting } = await import('../lib/db.js');
      await setSetting('ocrHighlightColor', _hlColor);
    } catch (_) {}
  }));
  // 模式切換 → 同步螢光筆顏色 row 顯示（highlight 才見）
  const _syncHlRow = () => { if (hlRow) hlRow.style.display = _mode === 'highlight' ? 'flex' : 'none'; };
  _applyHlColor(_hlColor);
  modeBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (_busy) return;
      const m = btn.dataset.mode;
      if (m === _mode) return;
      _mode = m;
      // A3 修復：session 內回寫 store state，重進頁才不會回退成開機值
      s.state.ocrMode = m;
      _syncHlRow();
      modeBtns.forEach(b => {
        b.dataset.active = String(b.dataset.mode === m);
        b.style.borderColor = b.dataset.mode === m ? 'var(--accent)' : 'var(--border)';
        b.style.background = b.dataset.mode === m ? 'var(--bg-hover)' : 'var(--bg-surface)';
      });
      try {
        const { setSetting } = await import('../lib/db.js');
        await setSetting('ocrMode', m);
      } catch (_) {}
    });
  });

  capBtn.addEventListener('click', () => { if (!_busy) camIn.click(); });
  impBtn.addEventListener('click', () => { if (!_busy) impIn.click(); });
  camIn.addEventListener('change', () => { const f = camIn.files?.[0]; camIn.value = ''; if (f) runFile(f); });
  // ─── 連拍模式（2026-09-01 元首令）：大頁拆多張小範圍連拍，候選跨張累積 ───
  // 大圖單張掃 = token 爆量+匯入極慢（enrich 逐字網路）。連拍小範圍（單字卡/單行）
  // 每張少量字，辨識完疊進候選不清，拍下一張繼續；全部勾完一次匯入。
  // runFile 辨識完成後走 appendCandidates()（候選 merge，非覆蓋）。

  // ─── F′：匯入多檔分流（image → OCR pipeline；text → fast-path 抽 token 直入候選；pdf → 提示後續）───
  impIn.addEventListener('change', async () => {
    const files = Array.from(impIn.files || []);
    impIn.value = '';
    if (!files.length || _busy) return;
    const groups = { image: [], text: [], pdf: [], other: [] };
    for (const f of files) groups[classifyImportFile(f)].push(f);
    const msgs = [];
    // 1. PDF：尚未支援（計畫 §F′.4 — PDF render 依賴 WebKit 能力，列後續）
    if (groups.pdf.length) {
      toast(`PDF 匯入尚未支援（${groups.pdf.length} 個檔案略過）`, 'toast-error');
    }
    // 2. 文字檔 fast-path：全部 token 併集去重 → 直接進候選清單（跳過 OCR）
    if (groups.text.length) {
      _setBusy(true);
      try {
        const merged = new Set();
        for (const f of groups.text) {
          for (const t of extractTextTokens(await f.text())) merged.add(t);
        }
        const tokens = [...merged];
        _resetResult();
        area.style.display = 'block';
        if (!tokens.length) {
          loadEl.style.display = 'block';
          loadEl.textContent = '文字檔未抽到有效單字';
        } else {
          loadEl.style.display = 'none';
          // 三頁籤走 appendCandidates（classifyTokens：新字→全新頁籤預設勾、
          // 已有→重複頁籤、黑灰→雜訊頁籤帶 🔒 badge 可勾 override），
          // 與圖片辨識路徑同渲染（F′ 文字檔 fast-path 修：舊 candL 已退役）。
          appendCandidates(tokens, {}, s);
          const maskedCount = tokens.filter(t => s.actions.isBlacklisted?.(t) || s.actions.isGraylisted?.(t)).length;
          const summaryEl = $('ocrMaskSummary');
          if (summaryEl) {
            summaryEl.textContent = maskedCount
              ? `文字檔抽出 ${tokens.length} 字（其中 ${maskedCount} 個受黑灰名單遮蔽，可勾選強制加入）`
              : `文字檔抽出 ${tokens.length} 字`;
            summaryEl.style.display = 'block';
          }
          candC.style.display = 'block';
          msgs.push(`文字檔抽出 ${tokens.length} 字`);
        }
      } catch (e) {
        toast(`文字檔讀取失敗：${e.message}`, 'toast-error');
      } finally { _setBusy(false); }
    }
    // 3. 圖片：逐一進原 OCR pipeline（多張依序處理，最後一張停在預覽）
    if (groups.image.length) {
      for (const f of groups.image) runFile(f);
      msgs.push(`${groups.image.length} 張圖片進入辨識`);
    }
    if (msgs.length === 1) toast(msgs[0], '');
  });

  // ─── 切割 B′：兩態狀態機（preview 純瀏覽 / cutting 四角成型）───
  function dispPos(ev) {
    const r = wrap.getBoundingClientRect();
    let cx, cy;
    if (ev.touches && ev.touches[0]) { cx = ev.touches[0].clientX; cy = ev.touches[0].clientY; }
    else { cx = ev.clientX; cy = ev.clientY; }
    return {
      x: Math.max(0, Math.min(dispW, cx - r.left)),
      y: Math.max(0, Math.min(dispH, cy - r.top)),
    };
  }
  const cutDoneBtn = $('ocrCutDoneBtn');
  const cutCancelBtn = $('ocrCutCancelBtn');

  // cutting 態走：按「切割」進逼 → 四角 handle 顯示 → 拖曳 → 完成/取消回 preview
  function enterCutting() {
    if (_busy) return;
    _savedCrop = _crop ? { x: _crop.x, y: _crop.y, w: _crop.w, h: _crop.h } : null;   // 取消回退快照
    _corners = _crop ? (() => {
      // 若已有切割框，用它當四角起始
      return [
        { x: _crop.x, y: _crop.y },
        { x: _crop.x + _crop.w, y: _crop.y },
        { x: _crop.x + _crop.w, y: _crop.y + _crop.h },
        { x: _crop.x, y: _crop.y + _crop.h },
      ];
    })() : defaultCorners(dispW, dispH);
    _cropMode = 'cutting';
    wrap.classList.add('cutting');
    cutStartBtn.style.display = 'none';
    cutDoneBtn.style.display = '';
    cutCancelBtn.style.display = '';
    clearBtn.style.display = 'none';
    hint.textContent = '拖曳四個圓點調整框選範圍；完成後按「完成」';
    paintCorners();
  }
  function leaveCutting(commit) {
    _cropMode = 'preview';
    wrap.classList.remove('cutting');
    cutStartBtn.style.display = '';
    cutDoneBtn.style.display = 'none';
    cutCancelBtn.style.display = 'none';
    clearBtn.style.display = '';
    svgEl.style.display = 'none';
    handles.forEach(h => { h.style.display = 'none'; });
    if (commit) { collapseCrop(); hint.textContent = '已框選；可按「切割」再調整，或直接辨識'; }
    else { _corners = null; _crop = _savedCrop; _savedCrop = null; hint.textContent = '已取消切割；預覽圖可直接下滑瀏覽'; }
  }
  // ─── OCR3 全螢幕切割 overlay（專門切割畫面；預覽頁保持純瀏覽可滑）───
  // 狀態：_ovCorners（overlay 顯示座標四角）、_ovZoom、_ovOpen。
  // 完成時換算回預覽座標 → _crop（collapseCrop 沿用預覽 dispW/H）。
  const ovEl      = $('ocrCropOverlay');
  const ovStage   = $('ocrOvStage');
  const ovImgBox  = $('ocrOvImgBox');
  const ovImg     = $('ocrOvImg');
  const ovSvg     = $('ocrOvSvg');
  const ovPoly    = $('ocrOvPoly');
  const ovHandles = [0, 1, 2, 3].map(i => $('ocrOvHandle' + i));
  const ovDims    = $('ocrOvDims');
  let _ovOpen = false;
  let _ovCorners = null;
  let _ovZoom = 1;
  let _ovDragIdx = null;
  let _ovBaseW = 0, _ovBaseH = 0;   // zoom=1 時圖顯示尺寸
  const _ovZoomBtns = () => Array.from(document.querySelectorAll('#ocrOvZoom button'));
  function _ovApplyZoom() {
    if (!_ovBaseW) return;
    ovImg.style.width = Math.round(_ovBaseW * _ovZoom) + 'px';
    ovImg.style.height = Math.round(_ovBaseH * _ovZoom) + 'px';
    _ovLayout();
  }
  function _ovLayout() {
    if (!_ovOpen || !_ovCorners) return;
    const W = _ovBaseW * _ovZoom, H = _ovBaseH * _ovZoom;
    ovImgBox.style.width = W + 'px';
    ovImgBox.style.height = H + 'px';
    ovSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    ovPoly.setAttribute('points', _ovCorners.map(c => `${c.x * _ovZoom},${c.y * _ovZoom}`).join(' '));
    ovHandles.forEach((hh, i) => {
      hh.style.display = 'block';
      hh.style.left = (_ovCorners[i].x * _ovZoom) + 'px';
      hh.style.top = (_ovCorners[i].y * _ovZoom) + 'px';
    });
    // 尺寸（原圖 px）
    const r = cornersToRect(_ovCorners);
    if (r && _imgW && _ovBaseW) {
      const k = _imgW / _ovBaseW;
      if (ovDims) ovDims.textContent = `${Math.max(1, Math.round(r.w * k))} × ${Math.max(1, Math.round(r.h * k))} px`;
    }
  }
  function _ovPos(ev) {
    const r = ovImgBox.getBoundingClientRect();
    const cx = (ev.touches?.[0] || ev).clientX;
    const cy = (ev.touches?.[0] || ev).clientY;
    return {
      x: Math.max(0, Math.min(_ovBaseW, (cx - r.left) / _ovZoom)),
      y: Math.max(0, Math.min(_ovBaseH, (cy - r.top) / _ovZoom)),
    };
  }
  function openCropOverlay() {
    if (_busy || !_file) { if (!_file) toast('請先拍照或匯入圖片', 'toast-error'); return; }
    _savedCrop = _crop ? { ..._crop } : null;
    // overlay 圖源：沿用預覽 imgEl 的 data: URL（WebKitGTK 安全）
    ovImg.src = imgEl.src;
    _ovOpen = true;
    _ovZoom = 1;
    _ovZoomBtns().forEach(b => b.classList.toggle('on', b.dataset.zoom === '1'));
    ovEl.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.getElementById('contentArea')?.style.setProperty('overflow', 'hidden');
    // 等一幀讓 stage 有尺寸，再量 base
    requestAnimationFrame(() => {
      const maxW = ovStage.clientWidth - 24, maxH = ovStage.clientHeight - 24;
      const iw = _imgW || 1, ih = _imgH || 1;
      const fit = Math.min(maxW / iw, maxH / ih, 1);
      // 小圖放大到至少可操作（短邊≥320），大圖縮到塞入
      const boost = Math.min(iw, ih) * fit < 320 ? 320 / (Math.min(iw, ih) * fit) : 1;
      const k = fit * Math.min(boost, 3);
      _ovBaseW = Math.max(1, Math.round(iw * k));
      _ovBaseH = Math.max(1, Math.round(ih * k));
      // 初角：有舊框→映射到 overlay 座標；否則中央 60%
      if (_crop && dispW > 0) {
        const sx = _ovBaseW / dispW, sy = _ovBaseH / dispH;
        _ovCorners = [
          { x: _crop.x * sx, y: _crop.y * sy },
          { x: (_crop.x + _crop.w) * sx, y: _crop.y * sy },
          { x: (_crop.x + _crop.w) * sx, y: (_crop.y + _crop.h) * sy },
          { x: _crop.x * sx, y: (_crop.y + _crop.h) * sy },
        ];
      } else {
        _ovCorners = defaultCorners(_ovBaseW, _ovBaseH);
      }
      _ovApplyZoom();
      hint.textContent = '切割畫面中；完成後回預覽辨識';
    });
  }
  function closeCropOverlay(commit) {
    _ovOpen = false;
    ovEl.style.display = 'none';
    document.body.style.overflow = '';
    document.getElementById('contentArea')?.style.removeProperty('overflow');
    ovHandles.forEach(hh => { hh.style.display = 'none'; });
    if (commit && _ovCorners) {
      // overlay 座標 → 預覽座標 → _crop
      if (dispW > 0 && _ovBaseW > 0) {
        const kx = dispW / _ovBaseW, ky = dispH / _ovBaseH;
        const prev = _ovCorners.map(c => ({ x: c.x * kx, y: c.y * ky }));
        const r = cornersToRect(prev);
        _crop = r;
        if (_crop) dimLabel.textContent = `${Math.max(1, Math.round(_crop.w * (_imgW / dispW)))} × ${Math.max(1, Math.round(_crop.h * (_imgH / dispH)))} px`;
        clearBtn.style.display = '';
        hint.textContent = '已框選；可再按「切割」調整，或直接辨識';
      }
    } else {
      _ovCorners = null;
      _crop = _savedCrop; _savedCrop = null;
      hint.textContent = '已取消切割；預覽圖可直接下滑瀏覽';
    }
  }
  $('ocrOvZoom')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-zoom]');
    if (!b) return;
    _ovZoom = parseFloat(b.dataset.zoom) || 1;
    _ovZoomBtns().forEach(x => x.classList.toggle('on', x === b));
    _ovApplyZoom();
  });
  ovHandles.forEach((hh, i) => {
    hh.addEventListener('pointerdown', (ev) => {
      if (_busy || !_ovOpen) return;
      ev.preventDefault(); ev.stopPropagation();
      _ovDragIdx = i;
      if (hh.setPointerCapture) { try { hh.setPointerCapture(ev.pointerId); } catch (_) {} }
    });
    hh.addEventListener('pointermove', (ev) => {
      if (_ovDragIdx !== i || !_ovOpen) return;
      ev.preventDefault();
      const p = _ovPos(ev);
      _ovCorners = untangleCorners(moveCorner(_ovCorners, i, p.x, p.y, _ovBaseW, _ovBaseH), _ovBaseW, _ovBaseH);
      _ovLayout();
    });
    const _endOv = () => { if (_ovDragIdx === i) _ovDragIdx = null; };
    hh.addEventListener('pointerup', _endOv);
    hh.addEventListener('pointercancel', _endOv);
  });
  $('ocrOvDone')?.addEventListener('click', () => closeCropOverlay(true));
  $('ocrOvCancel')?.addEventListener('click', () => closeCropOverlay(false));
  // 切割入口 → 全螢幕 overlay（OCR3；獨立 crop 頁已刪除併入）
  cutStartBtn?.addEventListener('click', openCropOverlay);
  cutDoneBtn?.addEventListener('click', () => leaveCutting(true));
  cutCancelBtn?.addEventListener('click', () => leaveCutting(false));

  // 四角 handle 各自 pointer（僅 cutting 態綁定；preview 態 wrap 零 pointer → 手機可滑頁）
  handles.forEach((h, i) => {
    h.addEventListener('pointerdown', (ev) => {
      if (_busy || _cropMode !== 'cutting') return;
      ev.preventDefault();
      ev.stopPropagation();
      _dragIdx = i;
      if (h.setPointerCapture) { try { h.setPointerCapture(ev.pointerId); } catch (_) {} }
    });
    h.addEventListener('pointermove', (ev) => {
      if (_dragIdx !== i || _cropMode !== 'cutting') return;
      ev.preventDefault();
      const p = dispPos(ev);
      _corners = untangleCorners(moveCorner(_corners, i, p.x, p.y, dispW, dispH), dispW, dispH);
      collapseCrop();
      paintCorners();
    });
    const _endH = () => { if (_dragIdx === i) _dragIdx = null; };
    h.addEventListener('pointerup', _endH);
    h.addEventListener('pointercancel', _endH);
  });

  // 清除切割（回 preview 全清）
  clearBtn?.addEventListener('click', () => {
    if (_cropMode === 'cutting') leaveCutting(false);
    _crop = null;
    _corners = null;
    dimLabel.textContent = '';
    hint.textContent = '預覽圖可直接下滑瀏覽；按「切割」拖四角框選要辨識的區域';
  });

  // ─── 切割 → File（原圖座標 → canvas 裁切 → toBlob → new File）───
  function cropToFile() {
    // 不圈選 → 直接回原始 File 給引擎（繞開 canvas；WebKitGTK 對 blob: 圖源會 taint，
    // toBlob 回 null →「切割失敗」，Chrome 卻正常——此分支根治該差異）
    if (!_crop || _crop.w <= 2 || _crop.h <= 2) {
      if (_file) return Promise.resolve(_file);
    }
    let sx = 0, sy = 0, dw = _imgW, dh = _imgH;
    if (_crop && _crop.w > 2 && _crop.h > 2) {
      const s = { x0: _crop.x, y0: _crop.y, x1: _crop.x + _crop.w, y1: _crop.y + _crop.h };
      const a = mapToSource(s.x0, s.y0, dispW, dispH, _imgW, _imgH);
      const b = mapToSource(s.x1, s.y1, dispW, dispH, _imgW, _imgH);
      sx = a.sx; sy = a.sy;
      dw = Math.max(1, b.sx - a.sx);
      dh = Math.max(1, b.sy - a.sy);
    }
    const cv = document.createElement('canvas');
    cv.width = dw; cv.height = dh;
    const ctx = cv.getContext('2d');
    // 用 createImageBitmap 重建圖源，斷絕原 blob: URL 的原生 taint（WebKitGTK 下 blob:
    // 為 opaque source，drawImage 會污染 canvas → toBlob 回 null）。ImageBitmap 來自
    // File(Blob) 本身，非跨源，drawImage 後 canvas 乾淨。
    return createImageBitmap(_file).then(bitmap => {
      ctx.drawImage(bitmap, sx, sy, dw, dh, 0, 0, dw, dh);
      bitmap.close?.();
      return new Promise((resolve, reject) => {
        cv.toBlob((blob) => {
          if (!blob) return reject(new Error('切割失敗'));
          resolve(new File([blob], 'ocr-crop.png', { type: 'image/png' }));
        }, 'image/png');
      });
    });
  }

  // ─── 辨識 ───
  confBtn?.addEventListener('click', async () => {
    if (_busy) return;
    // B′：若仍在 cutting 態，先收斂四角成 _crop 再辨識（等同隱式「完成」）
    if (_cropMode === 'cutting' && _corners) { collapseCrop(); leaveCutting(true); }
    if (_crop && (_crop.w <= 2 || _crop.h <= 2)) {
      toast('選取範圍太小，請重新圈選或不圈選', 'toast-error');
      return;
    }
    _setBusy(true);
    _resetResult();
    area.style.display = 'block';
    loadEl.style.display = 'block';
    loadEl.textContent = '辨識中...';
    try {
      let cropFile = await cropToFile();
      // 螢光筆模式（A-1′）: HSV 前處理 — 只把「實體螢光筆劃線」的 ROI 併圖饋給
      // 引擎，其餘背景/內文忽略。mask 全空 → 保留原圖（提示，精準回退整張辨識）。
      if (_mode === 'highlight' && cropFile) {
        const { filterHighlighter, resolveColor } = await import('../lib/ocr/preprocess.js');
        const spec = resolveColor(_hlColor) || resolveColor('yellow');
        const hl = await filterHighlighter(cropFile, spec);
        if (hl.file) {
          cropFile = hl.file;
          loadEl.textContent = `偵測到 ${hl.count}px 螢光區域（${hl.boxes.length} 塊），僅辨識畫線文字...`;
        } else {
          loadEl.textContent = '未偵測到螢光區域，改為辨識整張圖';
        }
      }
      // OCR3 自動前處理：灰階拉伸→暗底反白→行高放大→條件二值化
      // （不均→局部自適應，乾淨→全域 Otsu）→去噪→白邊。全自動條件式，
      // loadEl 顯示實際分支（使用者看得到自動化在幹嘛）。
      try {
        const { autoEnhanceSmallText } = await import('../lib/ocr/auto-preprocess.js');
        const en = await autoEnhanceSmallText(cropFile);
        if (en.file) {
          cropFile = en.file;
          loadEl.textContent = `自動前處理（${en.note}）...`;
        }
      } catch (e) { console.warn('[ocr] 自動前處理失敗（回退原圖）', e.message || e); }
      const { getActiveEngine } = await import('../lib/ocr/engine.js');
      const { engine } = await getActiveEngine();
      // OCR3 PSM 情境選擇：有框選或 highlight 聚焦→6，整頁 scan→3；DPI 預設 300
      let _psm = 3;
      try {
        const { selectPsm } = await import('../lib/ocr/tesseract-adapter.js');
        _psm = selectPsm({ hasCrop: !!(_crop && _crop.w > 2 && _crop.h > 2), mode: _mode });
      } catch (_) {}
      const res = await engine.recognize(cropFile, { psm: _psm, dpi: 300 });
      const seen = new Set();
      let tokens = [];
      const tokConf = {};      // token → 最高 confidence(0..100)
      // block-aware 提取：各 block 內的 token 記錄其信心，供螢光筆模式(高信心)/AI 還原保證
      const blocks = Array.isArray(res.blocks) && res.blocks.length ? res.blocks : [{ text: res.text || '', confidence: res.confidence || 1 }];
      for (const block of blocks) {
        const conf = Math.round((block.confidence ?? 1) * 100);
        for (const raw of String(block.text || '').split(/\s+/)) {
          const t = raw.toLowerCase().replace(/^[^\w'-]+/, '').replace(/[^\w'-]+$/, '');
          if (!_OCR_TOKEN_RE.test(t) || seen.has(t)) continue;
          seen.add(t); tokens.push(t);
          tokConf[t] = Math.max(tokConf[t] || 0, conf);
        }
      }
      // 螢光筆模式（方案 B）：整張辨識但只留高 confidence token——
      // 螢光筆標記的重點字通常在辨識信心較高，低信心雜字直接淘汰。
      if (_mode === 'highlight') {
        const filtered = tokens.filter(t => (tokConf[t] ?? 0) >= 50);
        if (filtered.length) tokens = filtered;
        // 若高信心全空仍保留原 tokens（避免整批誤殺）
      }
      loadEl.style.display = 'none';
      if (!tokens.length) {
        loadEl.style.display = 'block';
        loadEl.textContent = '未偵測到有效單字，請重新圈選範圍或換張圖';
        return;
      }
      // ── 離線還原層：words.txt Damerau edit-distance（手機/桌面通用，即時零成本）──
      // 還原亂碼成真英文字；歧義/非英文字還原不出 → 淘汰（不進候選）。
      const restoreMap = {};   // 還原字 → 原亂碼 token
      const { loadDictionary, restoreFromDictionary } = await import('../lib/dictionary.js');
      await loadDictionary();
      const restored = {};     // 原 token → 還原後的字
      const unresolvedOffline = [];
      for (const t of tokens) {
        const r = restoreFromDictionary(t);
        if (r) { restored[t] = r; }
        else unresolvedOffline.push(t);
      }
      // ── 可選 AI 補強（進階/devMode）──
      // 預設關閉（ocrRestoreModel 空＝不呼叫 LLM，純離線）。只有設定明確指定模型才觸發，
      // 對「離線找不到的 token」補強。桌面部屬可設 ollama 模型，手機預設不背任何權重。
      const aiModel = (s.state.ocrRestoreModel || '').trim();
      if (aiModel && unresolvedOffline.length) {
        try {
          const { fetchLLM } = await import('../lib/api.js');
          const baseUrl = s.state.ollamaUrl || 'http://localhost:11434';
          loadEl.style.display = 'block';
          loadEl.textContent = 'AI 補強還原中...';
          const list = JSON.stringify(unresolvedOffline);
          const prompt = `You are given a JSON array of OCR-misread English word tokens. For each, round-trip to the most likely intended REAL English dictionary word. Reply ONLY with a JSON array of the same length, each element the corrected lowercase word, OR "NA" if it's not a plausible English word. No explanations, no markdown.\nInput: ${list}`;
          const raw = await fetchLLM(`${baseUrl}/api/generate`, aiModel, prompt);
          const cleaned = String(raw || '').trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
          const arr = JSON.parse(cleaned);
          if (Array.isArray(arr) && arr.length === unresolvedOffline.length) {
            for (let i = 0; i < unresolvedOffline.length; i++) {
              const v = String(arr[i] ?? '').trim().toLowerCase();
              if (v && v !== 'na' && /^[a-z][a-z'-]{1,30}$/.test(v)) restored[unresolvedOffline[i]] = v;
            }
          }
        } catch (e) {
          console.warn('[ocr] AI 補強失敗（僅用離線結果）', e.message || e);
        }
      }
      // 收斂最終候選：已還原 → 用還原字；還原不出（歧義/非英文字）→ 淘汰
      let finalTokens = [];
      for (const t of tokens) {
        const r = restored[t];
        if (!r) continue;                        // 還原不出 → 刪
        if (!finalTokens.includes(r)) finalTokens.push(r);
        if (r !== t) restoreMap[r] = t;          // 有變 → 標「還原」
      }
      // OCR3 自動第二槍：主辨識 <3 字 → 同一 cropFile 跑 tile 局部掃描補槍
      // （shouldSecondShot 主判據用字數；tesseract confidence 灌水不採信）
      try {
        const { shouldSecondShot } = await import('../lib/ocr/auto-preprocess.js');
        if (shouldSecondShot({ finalCount: finalTokens.length })) {
          const second = await autoTileSecondShot(cropFile, engine, _psm);
          if (!second.skipped && second.tokens.length) {
            // tile 的 token 也要過字典還原（與主流程同語義），還原不出淘汰
            for (const tk of second.tokens) {
              if (finalTokens.includes(tk)) continue;
              const rr = restoreFromDictionary(tk);
              if (!rr || finalTokens.includes(rr)) continue;
              finalTokens.push(rr);
              if (rr !== tk) restoreMap[rr] = tk;
            }
            loadEl.textContent = `自動局部掃描補了 ${second.tokens.length} 字（剔除 ${second.dropped} 碎片）...`;
          }
        }
      } catch (e) { console.warn('[ocr] 自動第二槍失敗（保留主辨識結果）', e.message || e); }
      loadEl.style.display = 'none';
      if (!finalTokens.length) {
        loadEl.style.display = 'block';
        loadEl.textContent = '未偵測到有效單字，請重新圈選範圍或換張圖';
        return;
      }
      // ─── 連拍累積（2026-09-01）：候選不清空，跨張 merge（去重、保留既有勾選）───
      appendCandidates(finalTokens, restoreMap, s);
      candC.style.display = 'block';
    } catch (e) {
      loadEl.style.display = 'block';
      loadEl.textContent = `辨識失敗：${e.message}`;
    } finally {
      _setBusy(false);
    }
  });

  // ─── OCR3 自動第二槍（TILE-SCAN 收編）：主流程 finalTokens<3 時自動觸發 ───
  // 同一 cropFile 切 3×3 重疊網格 → 逐片 auto 前處理 → recognize → 跨片投票。
  // 小圖（短邊<600）跳過（tile 無意義）。呼叫端在 confBtn 內。
  async function autoTileSecondShot(feedFile, engine, psm) {
    const bitmap = await createImageBitmap(feedFile);
    const FW = bitmap.width, FH = bitmap.height;
    if (Math.min(FW, FH) < 600) { bitmap.close?.(); return { tokens: [], dropped: 0, skipped: true }; }
    const { tileGrid, crossTileVote, tileUpscaleFactor } = await import('../lib/ocr/tile-scan.js');
    const { autoEnhanceSmallText } = await import('../lib/ocr/auto-preprocess.js');
    const tiles = tileGrid({ width: FW, height: FH }, 3, 3);
    const perTile = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      loadEl.textContent = `主辨識字太少，自動局部掃描中 ${i + 1}/${tiles.length}...`;
      const f = tileUpscaleFactor(t.w);
      const cv = document.createElement('canvas');
      cv.width = t.w * f; cv.height = t.h * f;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, t.x, t.y, t.w, t.h, 0, 0, cv.width, cv.height);
      const pieceBlob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('片轉存失敗')), 'image/png'));
      let feed = new File([pieceBlob], `tile-${i}.png`, { type: 'image/png' });
      try {
        const en = await autoEnhanceSmallText(feed);
        if (en.file) feed = en.file;
      } catch (_) {}
      const r = await engine.recognize(feed, { psm, dpi: 300 });
      const toks = [];
      const seen2 = new Set();
      const blks = Array.isArray(r.blocks) && r.blocks.length ? r.blocks : [{ text: r.text || '', confidence: 1 }];
      for (const block of blks) {
        for (const raw of String(block.text || '').split(/\s+/)) {
          const tk = raw.toLowerCase().replace(/^[^\w'-]+/, '').replace(/[^\w'-]+$/, '');
          if (!_OCR_TOKEN_RE.test(tk) || seen2.has(tk)) continue;
          seen2.add(tk);
          const bb = block.bbox || [0, 0, 0, 0];
          const cx = bb[0] + bb[2] / 2 >= 0 ? t.x + (bb[0] + bb[2] / 2) / f : undefined;
          const cy = bb[1] + bb[3] / 2 >= 0 ? t.y + (bb[1] + bb[3] / 2) / f : undefined;
          toks.push({ t: tk, cx, cy });
        }
      }
      perTile.push({ tile: i, tokens: toks });
    }
    bitmap.close?.();
    const { keep, dropped } = crossTileVote(perTile, tiles);
    return { tokens: [...keep], dropped: dropped.size, skipped: false };
  }

  allBtn(['ocrSelectAllBtn', 'ocrSelectNoneBtn']).forEach((btn, i) => {
    btn?.addEventListener('click', () => {
      // 容器級查詢：三頁籤（ocrListNew/Dup/Noise）全在 candC 內，一次全選/全不選
      candC.querySelectorAll('.ocr-cand-cb').forEach(cb => { cb.checked = (i === 0); });
    });
  });

  // 入庫
  $('ocrConfirmImportBtn')?.addEventListener('click', async () => {
    const picked = Array.from(candC.querySelectorAll('.ocr-cand-cb:checked')).map(cb => cb.dataset.w);
    const allCand = Array.from(candC.querySelectorAll('.ocr-cand-cb')).map(cb => cb.dataset.w);
    if (!picked.length) { toast('請先勾選要加入的單字（連拍模式下可再拍繼續疊加）', ''); return; }
    const btn = $('ocrConfirmImportBtn');
    btn.disabled = true;
    try {
      // 勾選的遮蔽字 → override（一次性授權，plan C.4 §4：不永久改黑/灰名單）
      const overrideWords = picked.filter(w => s.actions.isBlacklisted?.(w) || s.actions.isGraylisted?.(w));
      // 未勾選淘汰字 → 自動加入灰名單（不進一般學習序，OCR 錄入自動排除）
      const dropped = allCand.filter(w => !picked.includes(w));
      let greyAdded = 0;
      if (dropped.length) {
        for (const w of dropped) { if (!s.actions.isGraylisted?.(w)) { await s.actions.addToGraylist(w); greyAdded++; } }
      }
      const res = await s.actions.importOcrText(picked, undefined, {
        override: new Set(overrideWords),
      });
      _endBatch();   // 連拍批結束（清 _batchTokens；後續 _resetResult 恢復清候選行為）
      // 清三頁籤 token 集＋重繪（本批候選清空，下一批從零開始）
      _newTokens.clear(); _dupTokens.clear(); _noiseTokens.clear(); renderTabs();
      candC.style.display = 'none';
      loadEl.style.display = 'block';
      // 被擋數（plan C.4 §3）：res.blacklisted 直接顯示既有盲區修復
      const maskedBlocked = res.blacklisted || 0;
      if (res.added > 0) {
        const enrichNote = res.enriched > 0 ? `（欄位補齊 ${res.enriched} 字）` : (res.enriched === 0 && res.added > 0 ? '（欄位待補：離線無 Cambridge 資料）' : '');
        loadEl.textContent = `已加入 ${res.added} 個單字到 OCR Inbox${enrichNote}${res.skipped ? `（跳過 ${res.skipped} 重複）` : ''}${maskedBlocked > 0 ? `（另有 ${maskedBlocked} 個未加入：黑灰名單/失效）` : ''}`;
        toast(`已加入 ${res.added} 字${res.enriched > 0 ? `，欄位補齊 ${res.enriched} 字` : ''}`, 'toast-success');
      } else {
        loadEl.textContent = res.skipped ? `全部 ${res.skipped} 字已存在，未新增` : '入庫失敗，請再試一次';
        toast(res.skipped ? '單字已存在' : '入庫失敗', res.skipped ? '' : 'toast-error');
      }
      if (greyAdded) toast(`已將 ${greyAdded} 個未勾選字加入灰名單`, '');
      // override 字實際入庫數（res.addedIds 只含真正新增的字——重複字不入列，避免「已強制加入」高估）
      const addedOverrideIds = (res.addedIds || []).filter(id => store.state.words.some(x => x.id === id));
      if (overrideWords.length) toast(`已強制加入 ${addedOverrideIds.length}/${overrideWords.length} 個黑灰名單字`, '');
    } catch (e) {
      toast(`入庫失敗：${e.message}`, 'toast-error');
    } finally {
      btn.disabled = false;
    }
  });

  // 離頁清理
  if (window.__pageCleanup) try { window.__pageCleanup(); } catch (_) {}
  window.__pageCleanup = () => {
    if (imgEl.src && imgEl.src.startsWith('blob:')) URL.revokeObjectURL(imgEl.src);
  };
}