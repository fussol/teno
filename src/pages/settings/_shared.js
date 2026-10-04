// settings 頁共用純件：子檔直連此檔，settings↔子檔循環只餘 renderInPlace（依賴 render/onMount 頁面核心，不可下沉）
import { icon } from '../../lib/svg.js';

export const pageRoot = () => document.getElementById('page-settings') || document.getElementById('pageContainer');

export const FIELD_VIS_GROUPS = [
  ['browserFront', '瀏覽器・正面', '字庫／字本點開字卡先看到的面（點一下翻到背面）'],
  ['browserBack', '瀏覽器・背面', '點一下正面後翻到的面'],
  ['study', '學習／測驗', '翻卡／多選／拼字，學習和測驗共用同一組'],
];

export let _ankiMode = 'flip'; // 'flip' | 'mc' | 'spell'
export function setAnkiMode(v) { _ankiMode = v; } // import 繫結不可賦值 → setter

const DECK_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#b69dff', '#78716c',
];

export function getDeckPalette(s) { return s.state.colorPalette || DECK_PALETTE; }

export function renderAnkiFields(s, mode) {
  const ankiSettings = mode === 'mc' ? s.state.ankiSettingsMc
    : mode === 'spell' ? s.state.ankiSettingsSpell
    : s.state.ankiSettings;
  const logLength = s.state.reviewLog.length;
  const modeLabels = { flip: '翻卡', mc: '多選', spell: '拼字' };
  return `
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">最大間隔 (天)</div>
      </div>
      <input type="number" id="setMaxIvl" min="1" max="3650" value="${ankiSettings.maxIvl}">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">每日新卡片</div>
      </div>
      <input type="number" id="setCardsPerDay" min="1" max="9999" value="${ankiSettings.cardsPerDay}">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">每日最大複習</div>
        <div class="config-field-hint">每天最多複習多少張卡 (0 = 不限)</div>
      </div>
      <input type="number" id="setMaxReviewsPerDay" min="0" max="100000" value="${s.state.simParams?.maxReviewsPerDay ?? 1000}">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">${icon('clock')} 期望保留率 (DR)</div>
        <div class="config-field-hint">數值越高，複習越頻繁但保留越好 (0.8~0.97)</div>
      </div>
      <input type="number" id="setDesiredRetention" min="0.8" max="0.97" step="0.01" value="${Math.round(Number(ankiSettings.desiredRetention) * 100) / 100}">
    </div>
    <div class="config-field" style="flex-wrap:wrap;">
      <div class="config-field-info" style="flex-basis:100%;">
        <div class="config-field-label">${icon('cup')} FSRS 權重</div>
        <div class="config-field-hint">21 個數值，逗號分隔。留空 = 預設</div>
      </div>
      <textarea id="setFsrsWeights" rows="2" style="width:100%;margin-top:6px;font-family:monospace;font-size:11px;resize:vertical"
        placeholder="0.212, 1.2931, 2.3065, ...">${escapeHtml(ankiSettings.fsrsWeights || '')}</textarea>
      <div style="margin-top:6px;display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" id="optimizeWeightsBtn">${icon('galleryHorizontalEnd')} 從歷史資料最佳化</button>
        <button class="btn btn-sm" id="healthCheckBtn">${icon('brain')} 健康檢查</button>
        <span id="optimizeStatus" style="font-size:11px;color:var(--text-tertiary)">${logLength} 筆記錄</span>
      </div>
      <div id="healthCheckResult" style="margin-top:6px;font-size:12px;display:none"></div>
      <div id="optimizeDetail" style="margin-top:6px;font-size:12px;display:none"></div>
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">${icon('galleryHorizontalEnd')} 水蛭門檻</div>
        <div class="config-field-hint">忘記次數達此值後標記（0 = 關閉）</div>
      </div>
      <input type="number" id="setLeechThreshold" min="0" max="20" value="${ankiSettings.leechThreshold}">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">${icon('clock')} 學習步驟</div>
        <div class="config-field-hint">新卡片的學習間隔（分鐘，逗號分隔）</div>
      </div>
      <input type="text" id="setLearnSteps" value="${escapeAttr(ankiSettings.learnSteps || '1,10')}" style="width:120px" placeholder="1,10">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">${icon('clock')} 重學步驟</div>
        <div class="config-field-hint">忘記後重新學習的間隔（分鐘，逗號分隔）</div>
      </div>
      <input type="text" id="setRelearnSteps" value="${escapeAttr(ankiSettings.relearnSteps || '10')}" style="width:120px" placeholder="10">
    </div>
    <div class="config-field">
      <div class="config-field-info">
        <div class="config-field-label">${icon('sliders')} 提前學習上限</div>
        <div class="config-field-hint">學習中卡片到期前多少分鐘視為可複習（0 = 關閉）</div>
      </div>
      <input type="number" id="setLearnAheadLimit" min="0" max="20" value="${ankiSettings.learnAheadLimit ?? 20}" style="width:70px">
    </div>
    <button class="btn-primary" id="saveAnkiBtn" style="width:100%;justify-content:center;margin-top:var(--s3)">${icon('check')} 儲存 ${modeLabels[mode]} Ankiiv>
    </div>
  `;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function escapeAttr(str) { return escapeHtml(str); }

export function formatCutoffHHMM(minutes) {
  const m = Math.max(0, Math.min(1439, minutes | 0));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
