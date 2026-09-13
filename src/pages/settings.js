// ═══════════════════════════════════════════════════════════════
// Settings — Anki parameters, goals, deck management, word editing,
//            CSV import/export, data management.
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { initCustomSelects } from '../lib/custom-select.js';   // G14: renderInPlace 重渲染後重建 custom-select
import { toast } from '../lib/toast.js';
import { speak } from '../lib/tts.js';
import pkg from '../../package.json';
import { ACCENTS, ACCENT_GROUPS } from '../lib/theme.js';
import { isAndroid, downloadBlob, downloadBlobFromArray } from '../lib/platform.js';
import { exportDbDialog, exportDbData, exportDbToDownloads, importDbDialog, listBackups, backupDb, restoreBackup as apiRestoreBackup, exportBackupDialog as apiExportBackup, exportBackupData as apiExportBackupData, deleteBackup as apiDeleteBackup, importAppLogText as apiImportAppLogText, resetAppLogDb as apiResetAppLogDb, listPiperVoices, importPiperModelDialog, installPiperModel, deletePiperModel, listAndroidVoices, webdavSaveConfig, webdavStatus, webdavTest, webdavUpload, webdavDownload, webdavLogout, webdavServerGetConfig, webdavServerSaveConfig, webdavServerStart, webdavServerStop, webdavServerStatus } from '../lib/api.js';
import { renderContent as renderImportContent, onMount as onMountImport } from './import.js';
import { renderContent as renderExportContent, onMount as onMountExport } from './export.js';
import { renderContent as renderTagContent, onMount as onMountTag } from './tag-manager.js';
import { ICON_PRESETS } from '../lib/icon-presets.js';
import { clampLearnAhead, UI_SCALE_LABELS } from '../lib/store.js';
import { FIELD_LABELS, FIELD_KEYS } from '../lib/word-extra.js';

// 欄位顯示三組（設定頁 master）：瀏覽器字卡正面／背面＋學習測驗共用
const FIELD_VIS_GROUPS = [
  ['browserFront', '瀏覽器・正面', '字庫／字本點開字卡先看到的面（點一下翻到背面）'],
  ['browserBack', '瀏覽器・背面', '點一下正面後翻到的面'],
  ['study', '學習／測驗', '翻卡／多選／拼字，學習和測驗共用同一組'],
];

// ─── 模組級狀態 ───
let _ankiMode = 'flip'; // 'flip' | 'mc' | 'spell'

const DECK_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#b69dff', '#78716c',
];

function getDeckPalette(s) { return s.state.colorPalette || DECK_PALETTE; }

export function render(s) {
  return renderSettingsContent(s);
}

function renderAnkiFields(s, mode) {
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
    <button class="btn-primary" id="saveAnkiBtn" style="width:100%;justify-content:center;margin-top:var(--s3)">${icon('check')} 儲存 ${modeLabels[mode]} Anki 設定</button>
  `;
}

function renderSettingsContent(s) {
  const { ankiSettings, goalStreak, stats, decks, words } = s.state;

  return `
    <style>.voice-chip.active{background:var(--accent) !important;color:var(--accent-on) !important;border-color:var(--accent) !important}</style>
    <div class="page-title">${icon('settings')} 設定</div>

    <!-- Day cutoff (BETA-B) -->
    <div class="section">
      <div class="section-title">${icon('clock')} 每日重置時間</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('clock')} 重置時間點</div>
          </div>
          <input type="time" id="setDayCutoff" value="${formatCutoffHHMM(s.state.dayCutoff || 0)}" style="width:120px;text-align:center">
        </div>
        <div style="margin-top:var(--s2)">
          <button class="btn-primary btn-sm" id="saveDayCutoffBtn">${icon('check')} 更新</button>
        </div>
      </div>
    </div>

    <!-- Theme Settings (beta-d: light/dark mode + 4 accent presets) -->
    <div class="section">
      <div class="section-title">${icon('layers')} 主題配色</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('layers')} 模式</div>
          </div>
          <div style="display:flex;gap:var(--s2)">
            <button id="modeDarkBtn" class="btn btn-sm ${s.state.themeMode === 'dark' ? 'btn-primary' : 'btn-secondary'}" data-mode="dark">${icon('moon')} 深色</button>
            <button id="modeLightBtn" class="btn btn-sm ${s.state.themeMode === 'light' ? 'btn-primary' : 'btn-secondary'}" data-mode="light">${icon('sun')} 淺色</button>
          </div>
        </div>
        <div class="config-field config-field-stack">
          <div class="config-field-info">
            <div class="config-field-label">${icon('layers')} 強調色</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:var(--s2)">
            ${ACCENT_GROUPS.map(g => `
              <div>
                <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);margin-bottom:var(--s1);letter-spacing:0.5px">${g.label}</div>
                <div class="swatch-grid">
                  ${g.items.map(item => `
                    <button class="swatch ${s.state.themeAccent === item.id ? 'selected' : ''}" data-accent="${item.id}" title="${item.cht}">
                      <span class="swatch-dot" style="width:16px;height:16px;border-radius:50%;background:${ACCENTS[item.id]};display:inline-block"></span>
                    </button>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('layers')} 強調強度</div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--s3)">
            <input type="range" id="accentIntensityRange" class="accent-range" min="0" max="1" step="0.05" value="${s.state.themeAccentIntensity}" style="flex:1;min-width:0">
            <span class="tnum" id="accentIntensityLabel" style="font-size:12px;min-width:4ch;flex-shrink:0;color:var(--text-tertiary)">${Math.round(s.state.themeAccentIntensity * 100)}%</span>
          </div>
        </div>
        <div class="config-field config-field-stack">
          <div class="config-field-info">
            <div class="config-field-label">${icon('appWindow')} App 圖示</div>
          </div>
          <div class="swatch-grid">
            ${ICON_PRESETS.map(p => `
              <button class="swatch ${(s.state.launcherIcon || 'original') === p.key ? 'selected' : ''}" data-icon-key="${p.key}" title="${p.label}">
                <span class="swatch-dot" style="width:16px;height:16px;border-radius:4px;background:${p.bg};display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(128,128,128,.35)">
                  <span class="swatch-inner" style="width:8px;height:8px;border-radius:2px;background:${p.main};display:inline-block"></span>
                </span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- TTS Settings -->
    <div class="section">
      <div class="section-title">${icon('volume')} 語音設定</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('volume')} 語音</div>
          </div>
          <div id="ttsVoiceGroup" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:32px">
            <span style="color:var(--text-secondary);font-size:13px">掃描中…</span>
          </div>
          ${isAndroid ? '' : `<button class="btn btn-sm" id="importPiperModelBtn" title="從本機選擇 .onnx 檔案">${icon('upload')}</button>`}
        </div>
        ${isAndroid ? '' : `
        <div class="config-field">
          <div style="display:flex;align-items:center;gap:var(--s3);width:100%">
            <input type="text" class="form-input" id="piperUrlInput" placeholder="貼上 HuggingFace 網址自動安裝" style="flex:1;min-width:0">
            <button class="btn btn-sm" id="installPiperBtn" title="從 HuggingFace 下載安裝">${icon('download')}</button>
          </div>
          <div class="config-field-hint">例如 https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high</div>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">已安裝模型</div>
          </div>
          <div id="piperModelList" style="display:flex;flex-direction:column;gap:var(--s2);margin-top:var(--s2)"></div>
        </div>
        `}
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('volume')} 朗讀速度</div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--s3)">
            <input type="range" id="ttsSpeedRange" min="0.3" max="3.0" step="0.1" value="${s.state.ttsSpeed}" style="flex:1;min-width:0">
            <span class="tnum" id="ttsSpeedLabel" style="min-width:4ch;text-align:center;flex-shrink:0">${s.state.ttsSpeed.toFixed(1)}</span>
          </div>
        </div>
        <div style="margin-top:var(--s2)">
          <button class="btn btn-sm" id="testTtsBtn">${icon('volume')} 試聽</button>
        </div>
      </div>
    </div>

    <!-- 介面備註（使用者 2026-09-10 裁示：預設關，設定頁可開） -->
    <div class="section">
      <div class="section-title">${icon('info')} 介面備註</div>
      <div class="config-section">
        <div class="config-field" style="justify-content:space-between;align-items:center">
          <div class="config-field-info">
            <div class="config-field-label">顯示輔助說明文字</div>
          </div>
          <div class="switch ${s.state.uiHints ? 'on' : ''}" id="uiHintsToggle" role="switch" aria-checked="${!!s.state.uiHints}"></div>
        </div>
      </div>
    </div>

    <!-- UISCALE1：介面大小（五檔，目前＝最小；Ctrl +/- / Ctrl+0 / Ctrl+滾輪） -->
    <div class="section">
      <div class="section-title">${icon('search')} 介面大小</div>
      <div class="config-section">
        <div class="config-field-info" style="margin-bottom:var(--s2)">
          <div class="config-field-hint">整頁等比縮放（跟瀏覽器 Ctrl +/- 同手感；Ctrl+0 回 100%）</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${UI_SCALE_LABELS.map((label, i) => `
            <button class="btn btn-sm ${((s.state.uiScaleIdx ?? 0) === i) ? '' : 'btn-ghost'}" data-uiscale="${i}"
              style="${((s.state.uiScaleIdx ?? 0) === i) ? '' : 'opacity:.65'}">${label}</button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Exam Saved Sessions Settings -->
    <div class="section">
      <div class="section-title">${icon('clock')} 測驗進度</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('save')} 最多保留進度組數</div>
          </div>
          <input type="number" id="maxExamSessionsInput" min="1" max="50" value="${s.state.maxExamSessions || 5}" style="width:80px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px;text-align:center;font-family:var(--mono)">
        </div>
      </div>
    </div>

    <!-- 例句顯示（三處共用） -->
    <div class="section">
      <div class="section-title">${icon('list')} 例句顯示</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('list')} 例句顯示句數</div>
            <div class="config-field-hint">瀏覽器字卡／學習／測驗共用同一設定，超過的隨機抽樣隱藏（0＝全部顯示）</div>
          </div>
          <input type="number" id="exampleDisplayMaxInput" min="0" max="50" value="${window.__maxExampleLines ?? 0}" style="width:80px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px;text-align:center;font-family:var(--mono)">
        </div>
      </div>
    </div>

    <!-- 欄位顯示（隱藏或顯示欄位：正面／背面／學習測驗共用三組，取消勾選＝該處不顯示） -->
    <div class="section">
      <div class="section-title">${icon('eye')} 欄位顯示</div>
      <div class="config-section">
        <div class="config-field-info" style="margin-bottom:var(--s2)">
          <div class="config-field-hint">三組各別設定要顯示哪些欄位（例句含片語；英文單字只有字卡正反面可以隱藏）</div>
        </div>
        ${FIELD_VIS_GROUPS.map(([ctx, name, hint]) => {
          const cur = Array.isArray(s.state['fieldVis' + ctx[0].toUpperCase() + ctx.slice(1)])
            ? s.state['fieldVis' + ctx[0].toUpperCase() + ctx.slice(1)]
            : [...FIELD_KEYS];
          return `<div style="margin-bottom:var(--s3)">
            <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:2px">${name}</div>
            <div class="config-field-hint" style="margin-bottom:6px">${hint}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${FIELD_KEYS.map(k => {
                const forced = ctx === 'study' && k === 'word';
                const checked = forced || cur.includes(k);
                return `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);border:1px solid var(--border);border-radius:100px;padding:3px 10px;${forced ? 'opacity:.55;' : 'cursor:pointer'}">
                <input type="checkbox" data-fieldvis-ctx="${ctx}" value="${k}" ${checked ? 'checked' : ''}${forced ? ' disabled title="學習／測驗一定顯示英文單字"' : ''}>${FIELD_LABELS[k]}${forced ? '（固定）' : ''}
              </label>`;
              }).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- 日誌分類（LOG-SCOPE1：源頭分開存；error 強制保留，開關擋不住它） -->
    <div class="section">
      <div class="section-title">${icon('list')} 日誌</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('database')} 保留天數</div>
            <div class="config-field-hint">error 級別固定保留 90 天，不受此數影響；0＝只留 error</div>
          </div>
          <input type="number" id="logRetentionInput" min="0" max="365" value="${s.state.logRetentionDays ?? 14}" style="width:80px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px;text-align:center;font-family:var(--mono)">
        </div>
        <div class="config-field-info" style="margin:var(--s2) 0 6px">
          <div class="config-field-label">記錄哪些分類<span class="hint-inline" style="font-weight:400;color:var(--text-tertiary)">（關掉＝不再寫入，已存的不刪）</span></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${[['study', '學習'], ['sync', '同步'], ['ocr', '辨識'], ['system', '系統'], ['misc', '其他']].map(([sc, label]) => `
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);border:1px solid var(--border);border-radius:100px;padding:3px 10px;cursor:pointer">
              <input type="checkbox" data-logscope="${sc}" ${(s.state.logScopes || {})[sc] !== false ? 'checked' : ''}>${label}
            </label>`).join('')}
        </div>
        <div class="config-field" style="margin-top:var(--s2)">
          <div class="config-field-info">
            <div class="config-field-label">除錯鏡像<span class="hint-inline" style="font-weight:400;color:var(--text-tertiary)">（console 轉發＋teno-monitor.log）</span></div>
            <div class="config-field-hint">關了只剩 error 會寫；除錯時再開</div>
          </div>
          <button class="switch-btn ${s.state.logMirror !== false ? 'on' : ''}" id="logMirrorToggle" style="flex-shrink:0" aria-pressed="${s.state.logMirror !== false}">${s.state.logMirror !== false ? '開' : '關'}</button>
        </div>
      </div>
    </div>

    <!-- Anki Settings (per-mode) -->
    <div class="section">
      <div class="section-title">${icon('brain')} Anki 設定</div>
      <div class="config-section">
        <div class="study-mode-tabs">
          <button class="study-mode-tab ${_ankiMode === 'flip' ? 'active' : ''}" data-anki-mode="flip">${icon('galleryHorizontalEnd')} 翻卡 <span class="tab-badge">${s.state.ankiSettings?.cardsPerDay ?? 20}</span></button>
          <button class="study-mode-tab ${_ankiMode === 'mc' ? 'active' : ''}" data-anki-mode="mc">${icon('form')} 多選 <span class="tab-badge">${s.state.ankiSettingsMc?.cardsPerDay ?? 20}</span></button>
          <button class="study-mode-tab ${_ankiMode === 'spell' ? 'active' : ''}" data-anki-mode="spell">${icon('edit')} 拼字 <span class="tab-badge">${s.state.ankiSettingsSpell?.cardsPerDay ?? 20}</span></button>
        </div>
        ${renderAnkiFields(s, _ankiMode)}
      </div>
    </div>

    <!-- Goal Settings -->
    <div class="section">
      <div class="section-title">${icon('flame')} 目標設定</div>
      <div class="config-section">
        <div class="goal-grid">
          <div class="goal-item">
            <div class="goal-val">${stats.total}</div>
            <div class="goal-lbl">總詞</div>
          </div>
          <div class="goal-item">
            <div class="goal-val" style="color:var(--green)">${stats.learned}</div>
            <div class="goal-lbl">已學</div>
          </div>
          <div class="goal-item">
            <div class="goal-val" style="color:var(--amber)">${stats.total - stats.learned}</div>
            <div class="goal-lbl">剩餘</div>
          </div>
          <div class="goal-item">
            <div class="goal-val" style="color:var(--accent)">${goalStreak.dailyGoal}</div>
            <div class="goal-lbl">每日目標</div>
          </div>
        </div>
        <div style="margin-top:var(--s4);display:flex;align-items:center;gap:var(--s3)">
          <span class="config-field-label">每日目標：</span>
          <input type="number" id="setDailyGoal" min="1" max="200" value="${goalStreak.dailyGoal}" style="width:70px;text-align:center">
          <button class="btn-primary btn-sm" onclick="window.__saveGoal()">${icon('check')} 更新</button>
        </div>
      </div>
    </div>

    <!-- Deck Management -->
    ${renderDeckManager(s)}

    <!-- Stats -->
    <div class="section">
      <div class="section-title">${icon('chart')} 統計</div>
      <div class="card">
        <div class="stat-row">
          <span class="stat-item">${icon('database')} <span class="stat-val">${stats.total}</span> <span class="stat-label">總詞</span></span>
          <span class="stat-item">${icon('pencil')} <span class="stat-val">${stats.learned}</span> <span class="stat-label">已學習</span></span>
          <span class="stat-item">${icon('galleryHorizontalEnd')} <span class="stat-val">${stats.new}</span> <span class="stat-label">新詞</span></span>
          <span class="stat-item">${icon('clock')} <span class="stat-val">${stats.due}</span> <span class="stat-label">待複習</span></span>
          <span class="stat-item">${icon('star')} <span class="stat-val">${stats.avgDifficulty ? stats.avgDifficulty.toFixed(1) : '-'}</span> <span class="stat-label">平均難度</span></span>
          <span class="stat-item">${icon('brain')} <span class="stat-val">${stats.mature}</span> <span class="stat-label">Mature</span></span>
        </div>
      </div>
    </div>

    <!-- Filtered Decks -->
    ${renderFilteredDecks(s)}

    <!-- Embedded: Tag Manager -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('hash')} 標籤管理</div>
      </div>
      <div class="config-section" style="border:none;padding:0">
        ${renderTagContent(s)}
      </div>
    </div>

    <!-- Embedded: Import -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('upload')} 匯入</div>
      </div>
      <div>
        ${renderImportContent(s)}
      </div>
    </div>

    <!-- Embedded: Export -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('save')} 匯出</div>
      </div>
      <div class="config-section">
        ${renderExportContent(s)}
      </div>
    </div>

    <!-- WebDAV 同步（本地雲：同 LAN／Tailscale 自建空間） -->
    <div class="section">
      <div class="section-title">${icon('upload')} WebDAV 同步</div>
      <div class="config-section">
        <div id="webdavConfigSection">
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">伺服器 URL</div>
              <div class="config-field-hint">桌機 WebDAV 位址，如 http://192.168.50.69:8080（尾 slash 可加可不加）</div>
            </div>
            <input type="text" id="webdavUrl" class="form-input" placeholder="http://192.168.50.69:8080" style="width:100%">
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">帳號</div>
            </div>
            <input type="text" id="webdavUser" class="form-input" placeholder="帳號" style="width:100%">
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">密碼</div>
              <div class="config-field-hint">帳密只輸這一次，存本機 0600，之後上傳下載自動帶</div>
            </div>
            <input type="password" id="webdavPass" class="form-input" placeholder="密碼" style="width:100%">
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2)">
            <button class="btn-primary btn-sm" id="webdavSaveBtn">${icon('check')} 儲存</button>
            <button class="btn btn-sm btn-secondary" id="webdavTestBtn">${icon('zap')} 測試連線</button>
          </div>
        </div>
        <div id="webdavSyncSection" style="margin-top:var(--s3)">
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">${icon('upload')} 同步</div>
              <div class="config-field-hint">整顆 TENOC 同步包上傳／下載（teno.db＋app-log.db）；版本＝最後更改時間，舊蓋新先擋，分叉留雙檔，空檔拒傳</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--s2)">
              <button class="btn btn-sm btn-primary" id="webdavUploadBtn">${icon('upload')} 上傳同步</button>
              <button class="btn btn-sm btn-secondary" id="webdavDownloadBtn">${icon('download')} 下載</button>
              <button class="btn btn-sm btn-secondary" id="webdavClearBtn">${icon('x')} 清除設定</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary)" id="webdavStatusText">檢查中…</div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-tertiary);margin-top:var(--s2)">
            <input type="checkbox" id="webdavAutoUpload">
            自動備份時同步上傳到這台 WebDAV（跟本地備份同一節奏，有變更才傳）
          </label>
        </div>
        ${isAndroid ? '' : `
        <div id="webdavServerSection" style="margin-top:var(--s3);border-top:1px solid var(--border-subtle);padding-top:var(--s3)">
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">${icon('cloud')} 內嵌本地雲（跟著 Teno 起）</div>
              <div class="config-field-hint">桌機開 Teno 就等於開雲，手機直接連；跟 ~/teno-webdav-app 同一空間同一語義。App 關掉後換獨立版頂（狀態行會講誰在聽）。手機請用 Termux 獨立版。</div>
            </div>
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">Port</div>
            </div>
            <input type="number" id="webdavSrvPort" class="form-input" min="1" max="65535" value="8080" style="width:110px">
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">帳號</div>
            </div>
            <input type="text" id="webdavSrvUser" class="form-input" placeholder="teno" style="width:100%">
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">密碼</div>
              <div class="config-field-hint">只輸這一次，存本機 0600；內嵌不設裸奔（要裸奔請用獨立版 --no-auth）</div>
            </div>
            <input type="password" id="webdavSrvPass" class="form-input" placeholder="密碼（已存則留空＝不改）" style="width:100%">
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-tertiary);margin-top:var(--s2)">
            <input type="checkbox" id="webdavSrvAutostart">
            Teno 啟動時自動開啟內嵌本地雲（獨立版已頂著時自動讓路）
          </label>
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s2)">
            <button class="btn-primary btn-sm" id="webdavSrvSaveBtn">${icon('check')} 儲存</button>
            <button class="btn btn-sm btn-primary" id="webdavSrvStartBtn">${icon('play')} 啟動</button>
            <button class="btn btn-sm btn-secondary" id="webdavSrvStopBtn">${icon('x')} 停止</button>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:var(--s2)" id="webdavSrvStatusText">檢查中…</div>
        </div>
        `}
      </div>
    </div>

    <!-- Danger Zone -->
    <div class="section">
      <div class="section-title" style="color:var(--red)">${icon('trash')} 危險區域</div>
      <div class="config-section" style="border-color:rgba(248,113,113,.2);display:flex;flex-direction:column;gap:var(--s3)">
        ${s.state.devMode ? `
        <button class="btn btn-danger" id="dangerResetBtn">
          ${icon('trash')} 重設所有資料
        </button>
        ` : ''}
        <div style="border-top:1px solid var(--border-subtle);padding-top:var(--s3);display:flex;gap:var(--s3);flex-wrap:wrap;align-items:center">
          <button class="btn btn-sm" id="dangerExportBtn">${icon('save')} 匯出 .db 備份</button>
          <button class="btn btn-sm" id="dangerImportBtn">${icon('upload')} 匯入 .db 備份</button>
        </div>
        <div style="border-top:1px solid var(--border-subtle);padding-top:var(--s3)">
          <button class="btn btn-sm" id="dangerBackupBtn">${icon('clock')} 自動備份管理</button>
          <div id="backupList" style="margin-top:var(--s2);display:none;font-size:12px;color:var(--text-tertiary)"></div>
          ${s.state.devMode ? `
          <div style="display:flex;gap:var(--s4);margin-top:var(--s3);flex-wrap:wrap">
            <label style="font-size:12px;color:var(--text-tertiary);display:flex;align-items:center;gap:6px">
              備份間隔(時)
              <input type="number" id="backupIntervalH" min="1" max="168" value="${s.state.backupIntervalH ?? 24}" style="width:64px">
            </label>
            <label style="font-size:12px;color:var(--text-tertiary);display:flex;align-items:center;gap:6px">
              最多保留(個)
              <input type="number" id="backupKeepMax" min="1" max="100" value="${s.state.backupKeepMax ?? 7}" style="width:64px">
            </label>
          </div>
          <div class="config-field-hint" style="margin-top:4px">預設一天備份一次、最多留 7 個（超出刪最舊）。修改即時生效。</div>
          ` : ''}
        </div>
      </div>
    </div>

    <!-- OCR 錄入過濾（獨立 section，僅 devMode 顯示） -->
        ${s.state.devMode ? `
        <div class="section">
          <div class="section-title">${icon('shield')} OCR 錄入過濾</div>
          <div class="config-section">
            <!-- Cambridge 查證開關 -->
            <div class="config-field" style="justify-content:space-between;align-items:center">
              <div class="config-field-info">
                <div class="config-field-label">Cambridge 查證</div>
                <div class="config-field-hint">錄入時連線 Cambridge 查證，查得到的才入庫；離線時自動降級放行</div>
              </div>
              <button class="switch-btn ${s.state.ocrCambridgeVerify ? 'on' : ''}" id="ocrCambVerifyToggle" style="flex-shrink:0" aria-pressed="${s.state.ocrCambridgeVerify}">${s.state.ocrCambridgeVerify ? '開' : '關'}</button>
            </div>
            <div class="config-field-hint" style="margin:var(--s2) 0">黑名單（${s.state.blacklist.length} 詞）：功能詞＋草漯檢定詞，系統預設，無法修改</div>
            <div id="blacklistList" style="max-height:160px;overflow-y:auto;border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--s1)">
              ${s.state.blacklist.slice().sort().map(w => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 6px;font-size:12px;border-bottom:1px solid var(--border-subtle)">
                  <span style="font-family:var(--mono)">${w}</span>
                </div>`).join('')}
            </div>
            <div style="border-top:1px solid var(--border-subtle);margin-top:var(--s3);padding-top:var(--s2)">
              <div class="config-field-hint" style="margin-bottom:var(--s1)">AI 還原模型（可選）：離線拼字還原找不到的字，丟本機 ollama 補強。留空＝關閉（純離線，手機預設）。桌面部屬可設 e.g. qwen3-ocr64k</div>
              <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2)">
                <input type="text" id="ocrRestoreModelInput" placeholder="留空＝關閉；輸入 ollama 模型名啟用" value="${s.state.ocrRestoreModel || ''}" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
                <button class="btn btn-sm" id="ocrRestoreModelBtn">${icon('check')} 設定</button>
              </div>
              <div class="config-field-hint" style="margin-bottom:var(--s1)">灰名單（${s.state.graylist.length} 詞）：OCR 辨識時「未勾選淘汰」的字自動加入，不進入一般學習序；可手動增刪或 CSV 匯入</div>
              <div id="graylistInputRow" style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2)">
                <input type="text" id="graylistAddInput" placeholder="輸入單字加入灰名單" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
                <button class="btn btn-sm" id="graylistAddBtn">${icon('plus')} 加入</button>
              </div>
              <div id="graylistCsvRow" style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2)">
                <input type="file" id="graylistCsvInput" accept=".csv,.txt,text/csv" style="flex:1;font-size:12px">
                <button class="btn btn-sm" id="graylistCsvBtn">${icon('upload')} 匯入 CSV</button>
              </div>
              <div id="graylistList" style="max-height:160px;overflow-y:auto;border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--s1)">
                ${s.state.graylist.slice().sort().map(w => `
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 6px;font-size:12px;border-bottom:1px solid var(--border-subtle)">
                    <span style="font-family:var(--mono)">${w}</span>
                    <button class="gl-del" data-w="${w}" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;padding:2px 4px">移除</button><!-- G-HARD1: 原 var(--danger,#f87171)，--danger 全庫未定義， fallback 恆生效；改語意色 --red -->
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- D段：韋氏字典 API Key（自備；dictionaryapi.com 註冊，Dictionary＋Thesaurus 各一把，各 1000 次/天免費） -->
        <div class="section">
          <div class="section-title">${icon('book')} 韋氏字典</div>
          <div class="config-section">
            <div class="config-field-hint" style="margin-bottom:var(--s2)">自動補齊的「韋氏字典」來源用。兩把 key 分開存本機 DB，不上傳別處。</div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">Dictionary key</span>
              <input type="password" id="mwDictKeyInput" placeholder="Collegiate Dictionary key" value="${escapeAttr(s.state.mwDictKey || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">Thesaurus key</span>
              <input type="password" id="mwThesKeyInput" placeholder="Collegiate Thesaurus 或 Intermediate Thesaurus key（自動相容）" value="${escapeAttr(s.state.mwThesKey || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <button class="btn btn-sm" id="mwKeysSaveBtn">${icon('check')} 儲存 Key</button>
              <button class="btn btn-sm" id="mwKeysTestBtn">${icon('search')} 測試連線</button>
            </div>
            <div id="mwKeysTestResult" style="font-size:12px"></div>
          </div>
        </div>

        <!-- About / Version (tap version 10× → developer mode) -->
        <div class="section">
          <div class="section-title">${icon('info')} 關於</div>
          <div class="config-section">
            <div style="display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap">
              <div style="width:44px;height:44px;border-radius:12px;background:var(--accent);color:var(--accent-on);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px">T</div>
              <div>
                <div style="font-weight:700">Teno</div>
                <div class="muted" style="font-size:11px">英文單字學習 · FSRS 間隔重複 · GPLv3</div>
              </div>
            </div>
            <div style="border-top:1px solid var(--border-subtle);margin-top:var(--s3);padding-top:var(--s3)">
              <div id="versionTap" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="muted" style="font-size:12px">版本</span>
                <span style="font-weight:700;font-variant-numeric:tabular-nums">${pkg.version}</span>
                ${s.state.devMode ? '<span style="font-size:11px;color:var(--green);background:rgba(34,197,94,.15);padding:2px 8px;border-radius:99px">🔓 開發者模式</span>' : ''}
              </div>
              ${s.state.devMode ? '<div id="devModeHint" style="font-size:11px;color:var(--text-tertiary);margin-top:4px">開發者模式已開啟（模擬器的 CLI 工具已解鎖）</div>' : ''}
              ${s.state.devMode ? `<button class="btn btn-sm" id="devModeOffBtn" style="margin-top:var(--s2)">${icon('x')} 關閉開發者模式</button>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function runExportDb() {
  try {
    const d = await import('../lib/db.js');
    try {
      // H3（2026-09-01 顧問報告）：humanEvents 上限 50000 事件全量塞 DB 曾實測 700KB+ 累積。
      // 備份只帶最近 500 筆（90 天內、分析統計足夠），體積歸零、還原端照吃。
      const ev = localStorage.getItem('humanEvents');
      if (ev) {
        try {
          const arr = JSON.parse(ev);
          if (Array.isArray(arr)) {
            const trimmed = JSON.stringify(arr.slice(-500));
            await d.setSetting('_backup_humanEvents', trimmed);
          } else {
            await d.setSetting('_backup_humanEvents', ev);
          }
        } catch (_) { await d.setSetting('_backup_humanEvents', ev); }
      }
      const pf = localStorage.getItem('humanProfile');
      if (pf) await d.setSetting('_backup_humanProfile', pf);
    } catch (_) {}
    await d.checkpoint();
    if (isAndroid) {
      // EXPORTBIG1: 大檔直寫優先（零 IPC 資料；回傳含大小）；失敗才退回舊 IPC 路（小檔用）
      try {
        const msg = await exportDbToDownloads('teno-backup.db');
        await d.addAudit('export-db', `匯出 .db 備份 (Android 直寫) ${msg}`).catch(() => {});
        toast(`資料庫已匯出到 下載/Teno（${msg}）`, 'toast-success');
      } catch (e2) {
        const data = await exportDbData();
        downloadBlobFromArray(data, 'teno-backup.db', 'application/octet-stream');
        await d.addAudit('export-db', '匯出 .db 備份 (Android 舊路)').catch(() => {});
        toast('資料庫已匯出（僅 teno.db）', 'toast-success');
      }
    } else {
      const path = await exportDbDialog();
      await d.addAudit('export-db', `匯出 → ${path}`).catch(() => {});
      toast(`資料庫已匯出 → ${path}`, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

async function runImportDb() {
  if (!confirm('匯入備份將取代所有現有資料（會自動備份原資料庫），確定繼續？')) return;
  try {
    const { checkpoint, closeDB } = await import('../lib/db.js');
    const { checkpointAppLog, closeAppLog } = await import('../lib/app-log.js');
    // 順序（D6）：checkpoint（WAL 合併→備份完整）→ backupDb（安全網）→ flush app-log
    // → 關閉連線（teno.db + app-log.db）→ 匯入覆寫 → reload。
    // 覆寫（write_db_container）同時換 teno.db+app-log.db 並先刪 -wal/-shm，
    // 任何存活連線都會造成髒頁回刷/混合態，故 close 必須全部前於覆寫。
    await checkpoint();
    await backupDb();
    await checkpointAppLog();
    await closeDB();
    await closeAppLog();
    await importDbDialog();
    toast('匯入成功，重新載入中…', 'toast-success');
    setTimeout(() => window.location.reload(), 500);
  } catch (e) {
    // 連線可能已關閉 → 重開避免半死狀態（與 restoreBackup catch 同構；
    // app-log 由 getDb() 惰性重連）。取消發生在覆寫前 → 舊檔完好無損。
    try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}
    if (e !== '使用者取消') toast('匯入失敗: ' + e, 'toast-error');
  }
}

// ─── 備份管理 ──────────────────────────────────
let _backupsData = null;

async function showBackups() {
  const el = document.getElementById('backupList');
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  try {
    const list = await listBackups();
    _backupsData = list;
    if (!list || list.length === 0) {
      el.innerHTML = '<div style="padding:8px 0">尚無自動備份</div>';
      el.style.display = 'block';
      return;
    }
    let html = '<div style="margin-top:8px;font-weight:600;color:var(--text-secondary)">自動備份列表</div>';
    for (const b of list) {
      const size = b.size > 1024 * 1024
        ? (b.size / 1024 / 1024).toFixed(1) + ' MB'
        : b.size > 1024 ? Math.round(b.size / 1024) + ' KB' : b.size + ' B';
      const d = new Date(b.timestamp * 1000);
      const dateStr = d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      // LOG-BACKUP1: 增量行——徽標＋筆數，還原走「回放到此」（reset＋逐 patch import）
      const isPatch = b.kind === 'applog-patch';
      const kindTag = isPatch
        ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:700">日誌增量${Number.isFinite(b.rows) ? ` ＋${b.rows}筆` : ''}</span>`
        : `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg-hover);color:var(--text-secondary);font-weight:700">主庫全量</span>`;
      const restoreBtn = isPatch
        ? `<button class="btn btn-xs" data-breplay="${escapeAttr(b.filename)}" style="font-size:11px">${icon('clock')} 回放到此</button>`
        : `<button class="btn btn-xs" data-brestore="${escapeAttr(b.filename)}" style="font-size:11px">${icon('rotate')} 還原</button>`;
      html += `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid var(--border-subtle)">
        <span style="flex:1;color:var(--text-primary)">${dateStr} ${kindTag}</span>
        <span class="muted" style="font-size:11px;width:60px">${size}</span>
        ${restoreBtn}
        <button class="btn btn-xs" data-bexport="${escapeAttr(b.filename)}" style="font-size:11px">${icon('save')} 匯出</button>
        <button class="btn btn-xs" data-bdelete="${escapeAttr(b.filename)}" style="font-size:11px;color:var(--red)">${icon('x')}</button>
      </div>`;
    }
    el.innerHTML = html;
    el.style.display = 'block';

    // Attach event listeners
    el.querySelectorAll('[data-brestore]').forEach(btn =>
      btn.addEventListener('click', () => restoreBackup(btn.dataset.brestore, btn)));
    el.querySelectorAll('[data-breplay]').forEach(btn =>
      btn.addEventListener('click', () => replayAppLogTo(btn.dataset.breplay, btn)));
    el.querySelectorAll('[data-bexport]').forEach(btn =>
      btn.addEventListener('click', () => exportBackup(btn.dataset.bexport)));
    el.querySelectorAll('[data-bdelete]').forEach(btn =>
      btn.addEventListener('click', () => deleteBackup(btn.dataset.bdelete)));
  } catch (e) {
    el.innerHTML = '<div style="padding:8px 0;color:var(--red)">讀取備份失敗: ' + escapeHtml(String(e)) + '</div>';
    el.style.display = 'block';
  }
}

async function restoreBackup(filename, btn) {
  if (!confirm('確定要還原此備份？所有現有資料將被取代（會自動備份目前資料庫）。')) return;
  if (btn) btn.disabled = true;
  try {
    const { checkpoint, closeDB, initDB } = await import('../lib/db.js');
    const { closeAppLog } = await import('../lib/app-log.js');
    // 順序：checkpoint（WAL 合併→備份完整）→ backupDb（安全網）→ closeDB + closeAppLog → 還原 → reload
    await checkpoint();
    // Auto-backup current DB first
    await backupDb();
    await closeDB();
    await closeAppLog();
    await apiRestoreBackup(filename);
    toast('還原成功，重新載入中…', 'toast-success');
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('還原失敗: ' + e, 'toast-error');
    // DB 已關閉 → 重開避免半死狀態
    try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function exportBackup(filename) {
  try {
    if (isAndroid) {
      const data = await apiExportBackupData(filename);
      downloadBlobFromArray(data, filename, 'application/octet-stream');
      toast('備份已匯出', 'toast-success');
    } else {
      const path = await apiExportBackup(filename);
      toast('備份已匯出 → ' + path, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

// LOG-BACKUP1: 備份檔名取 ts（數字比；nanos 19 碼與舊秒級 10 碼混排時字串比會錯）
function backupTsOf(name) {
  const m = /^(?:teno-|applog-)(\d+)(?:\.db|\.patch\.txt)$/.exec(name || '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : -1;
}

// LOG-BACKUP1: 日誌回放——reset 日誌庫後，把「此前全部 patch」按 ts 順序 import。
// import 去重冪等，重跑同一鏈不翻倍。主庫完全不動。
async function replayAppLogTo(filename, btn) {
  if (!confirm('確定要把操作日誌回放到這個時間點？（目前的日誌會被清空後重放；單字主庫完全不受影響）')) return;
  if (btn) btn.disabled = true;
  try {
    const { closeAppLog, checkpointAppLog } = await import('../lib/app-log.js');
    try { await checkpointAppLog(); } catch (_) {}
    await backupDb(); // 安全網：先備份當下（主庫＋未備增量一起落檔）
    await closeAppLog();
    await apiResetAppLogDb();
    const list = await listBackups();
    const targetTs = backupTsOf(filename);
    const chain = (list || [])
      .filter(b => b.kind === 'applog-patch' && backupTsOf(b.filename) <= targetTs)
      .map(b => b.filename)
      .sort((a, b) => backupTsOf(a) - backupTsOf(b));
    let added = 0, skipped = 0, bad = 0, files = 0;
    for (const f of chain) {
      const data = await apiExportBackupData(f); // Vec<u8>→數字陣列（patch KB 級）
      const text = new TextDecoder('utf-8').decode(new Uint8Array(data));
      const r = await apiImportAppLogText(text);
      added += r.log_added + r.sim_added;
      skipped += r.log_skipped + r.sim_skipped;
      bad += r.bad_lines;
      files += 1;
    }
    toast(`日誌已回放 ${files} 個增量：新增 ${added} 筆（重複 ${skipped}、壞行 ${bad}），重新載入中…`, 'toast-success');
    setTimeout(() => window.location.reload(), 800);
  } catch (e) {
    toast('日誌回放失敗: ' + e, 'toast-error');
    try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteBackup(filename) {
  if (!confirm('確定刪除此備份？')) return;
  try {
    await apiDeleteBackup(filename);
    toast('已刪除', 'toast-success');
    showBackups(); // refresh list
  } catch (e) {
    toast('刪除失敗: ' + e, 'toast-error');
  }
}

// ─── 字本管理 ───────────────────────────────────
function renderDeckManager(s) {
  const { decks, words } = s.state;
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('book')} 字本管理</div>
        <button class="btn btn-sm" id="deckAddBtn">${icon('plus')} 新增字本</button>
      </div>
      <div class="config-section">
        ${decks.length === 0 ? `
          <div style="text-align:center;padding:var(--s6);color:var(--text-tertiary);font-size:13px">
            尚無字本，點擊「新增字本」建立
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:var(--s2);padding:0 var(--s1)">
            ${decks.map((d, i) => {
              const count = words.filter(w => w.deck === d.name).length;
              const first = i === 0;
              const last = i === decks.length - 1;
              return `
                <div class="deck-mgr-row" data-deck-id="${escapeAttr(d.id)}">
                  <span class="deck-mgr-dot" style="background:${d.color};box-shadow:0 0 6px ${d.color}"></span>
                  <span class="deck-mgr-name">${escapeHtml(d.name)}</span>
                  <span class="deck-mgr-count">${count} 詞</span>
                  <div class="deck-mgr-actions">
                    <button class="btn btn-ghost btn-sm" data-deck-action="move-up" data-deck-id="${escapeAttr(d.id)}" title="上移" ${first ? 'disabled style="opacity:0.3"' : ''}>${icon('chevronU')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="move-down" data-deck-id="${escapeAttr(d.id)}" title="下移" ${last ? 'disabled style="opacity:0.3"' : ''}>${icon('chevronD')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="merge" data-deck-id="${escapeAttr(d.id)}" title="合併">${icon('shuffle')}</button>
                    <button class="btn btn-ghost btn-sm" data-deck-action="edit" data-deck-id="${escapeAttr(d.id)}" title="編輯">${icon('edit')}</button>
                    <button class="btn btn-ghost btn-sm danger" data-deck-action="delete" data-deck-id="${escapeAttr(d.id)}" title="刪除">${icon('trash')}</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

// ─── 單字列表（搜尋、編輯、刪除，可收納）────────
function renderFilteredDecks(s) {
  const { filteredDecks } = s.state;
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('filter')} 過濾牌組</div>
        <button class="btn btn-sm" id="filteredDeckAddBtn">${icon('plus')} 新增</button>
      </div>
      <div class="config-section">
        ${filteredDecks.length === 0 ? `
          <div style="text-align:center;padding:var(--s6);color:var(--text-tertiary);font-size:13px">
            尚無過濾牌組。過濾牌組可讓您依條件篩選卡片進行專項複習。
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:var(--s2)">
            ${filteredDecks.map(fd => `
              <div class="deck-mgr-row" data-fd-id="${escapeAttr(fd.id)}">
                <span class="deck-mgr-dot" style="background:${fd.color || '#f59e0b'};box-shadow:0 0 6px ${fd.color || '#f59e0b'}"></span>
                <span class="deck-mgr-name">${escapeHtml(fd.name)}</span>
                <span class="deck-mgr-count" style="font-size:11px;color:var(--text-tertiary)">${escapeHtml(fd.search_query)}</span>
                <div class="deck-mgr-actions">
                  <button class="btn btn-ghost btn-sm" data-fd-action="edit" data-fd-id="${escapeAttr(fd.id)}" title="編輯">${icon('edit')}</button>
                  <button class="btn btn-ghost btn-sm danger" data-fd-action="delete" data-fd-id="${escapeAttr(fd.id)}" title="刪除">${icon('trash')}</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

export function onMount(s) {
  const modelList = document.getElementById('piperModelList');
  if (modelList) modelList.innerHTML = '';

  const updateVoices = (voices) => {
    const group = document.getElementById('ttsVoiceGroup');
    if (!group) return;
    if (!voices || !voices.length) {
      group.innerHTML = `<span style="color:var(--text-secondary);font-size:13px">${isAndroid ? '無可用語音' : '無可用語音，請匯入模型'}</span>`;
      return;
    }
    // Android voices are objects { name, language }, Piper voices are strings
    let voiceNames;
    if (isAndroid) {
      const en = voices.filter(v => /^en[-_]us|^en[-_]gb/i.test(v.language));
      voiceNames = (en.length ? en : voices).map(v => v.name);
    } else {
      voiceNames = voices;
    }
    let current = s.state.ttsVoice;
    if (!voiceNames.includes(current)) { current = voiceNames[0]; s.actions.setTtsVoice(current); }
    group.innerHTML = voiceNames.map(v => {
      const label = isAndroid
        ? v.replace(/^[a-z]{2}-[a-z]{2}-x-/, '').replace(/-/g, ' ')  // prettify Google voice names
        : v.replace(/_/g, ' ');
      return `<span class="voice-chip${v === current ? ' active' : ''}" data-voice="${v}" style="cursor:pointer;padding:2px 10px;border-radius:var(--r2);font-size:13px;background:var(--bg2);border:1px solid var(--border);transition:background-color .15s,border-color .15s,color .15s">${label}</span>`;
    }).join('');

    // Piper model list (desktop only)
    const list = document.getElementById('piperModelList');
    if (list) {
      list.innerHTML = (voices || []).map(v => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--s3);padding:var(--s2);background:var(--bg2);border-radius:var(--r2)">
          <span>${(typeof v === 'string' ? v : v.name).replace(/_/g, ' ')}</span>
          <button class="btn btn-sm btn-secondary del-model-btn" data-model="${typeof v === 'string' ? v : v.name}">${icon('x')}</button>
        </div>`).join('');
      list.querySelectorAll('.del-model-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.model;
          try {
            await deletePiperModel(name);
            const updated = await listPiperVoices();
            updateVoices(updated);
            toast('模型已刪除', 'toast-success');
          } catch (e) { toast('刪除失敗: ' + e, 'toast-error'); }
        });
      });
    }
  };

  document.getElementById('ttsVoiceGroup')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.voice-chip');
    if (chip) {
      s.actions.setTtsVoice(chip.dataset.voice);
      chip.parentElement.querySelectorAll('.voice-chip').forEach(c => c.classList.toggle('active', c === chip));
    }
  });

  if (isAndroid) {
    listAndroidVoices().then(voices => { if (voices && voices.length) updateVoices(voices); }).catch(() => {});
  } else {
    listPiperVoices().then(voices => { if (voices && voices.length) updateVoices(voices); }).catch(() => {});
  }

  document.getElementById('testTtsBtn')?.addEventListener('click', () => {
    const chip = document.querySelector('#ttsVoiceGroup .voice-chip.active') || document.querySelector('#ttsVoiceGroup .voice-chip');
    const voice = chip?.dataset?.voice || 'en_US-ryan-high';
    const speed = parseFloat(document.getElementById('ttsSpeedRange')?.value) || 0.9;
    speak('Hello, this is a test of the text to speech system.', speed, voice);
  });

  document.getElementById('importPiperModelBtn')?.addEventListener('click', async () => {
    try {
      const voices = await importPiperModelDialog();
      if (!voices) return;
      updateVoices(voices);
      toast('語音模型已匯入', 'toast-success');
    } catch (e) { if (e !== '使用者取消') toast('匯入失敗: ' + e, 'toast-error'); }
  });
  document.getElementById('installPiperBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('piperUrlInput');
    const url = input?.value?.trim();
    if (!url) { toast('請輸入 HuggingFace 網址', 'toast-warn'); return; }
    input.disabled = true;
    document.getElementById('installPiperBtn').disabled = true;
    try {
      const voices = await installPiperModel(url);
      updateVoices(voices);
      input.value = '';
      toast('語音模型安裝完成', 'toast-success');
    } catch (e) { toast('安裝失敗: ' + e, 'toast-error'); }
    finally { input.disabled = false; document.getElementById('installPiperBtn').disabled = false; }
  });
  document.getElementById('ttsSpeedRange')?.addEventListener('input', (e) => {
    document.getElementById('ttsSpeedLabel').textContent = parseFloat(e.target.value).toFixed(1);
  });
  document.getElementById('ttsSpeedRange')?.addEventListener('change', (e) => {
    s.actions.setTtsSpeed(parseFloat(e.target.value));
  });
  // (voice-chip click handler is set within updateVoices)

  const saveCutoffBtn = document.getElementById('saveDayCutoffBtn');
  if (saveCutoffBtn) saveCutoffBtn.addEventListener('click', async () => {
    const v = document.getElementById('setDayCutoff')?.value || '00:00';
    const [hh, mm] = v.split(':').map(x => parseInt(x) || 0);
    const minutes = (hh || 0) * 60 + (mm || 0);
    await s.actions.setDayCutoff(minutes);
    toast(`每日重置時間設為 ${v}`, 'toast-success');
  });

  // ── 版本資訊 / 開發者模式 (連點版本 10 下，無提示) ──
  let _verTap = 0, _verTimer = null;
  const versionTap = document.getElementById('versionTap');
  if (versionTap) versionTap.addEventListener('click', () => {
    _verTap++;
    clearTimeout(_verTimer);
    _verTimer = setTimeout(() => { _verTap = 0; }, 2500);
    if (_verTap >= 10) {
      _verTap = 0;
      s.actions.setDevMode(true);
      toast('開發者模式已開啟 🔓', 'toast-success');
      renderInPlace(s);
    }
  });
  document.getElementById('devModeOffBtn')?.addEventListener('click', async () => {
    await s.actions.setDevMode(false);
    toast('開發者模式已關閉', '');
    renderInPlace(s);
  });

  // ── 介面備註開關（no-hints body class；關＝隱藏全 app 輔助說明） ──
  document.getElementById('uiHintsToggle')?.addEventListener('click', async () => {
    const v = await s.actions.setUiHints(!s.state.uiHints);
    const sw = document.getElementById('uiHintsToggle');
    if (sw) { sw.classList.toggle('on', v); sw.setAttribute('aria-checked', String(v)); }
    toast(v ? '介面備註已開啟' : '介面備註已關閉', '');
    renderInPlace(s);
  });

  // ── UISCALE1：介面大小五檔（點檔位即套用＋存 DB；快捷鍵走 main.js） ──
  document.querySelectorAll('[data-uiscale]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = await s.actions.setUiScale(parseInt(btn.dataset.uiscale, 10));
      toast(`介面大小 ${UI_SCALE_LABELS[i]}`, '');
      renderInPlace(s);
    });
  });

  // ── OCR 錄入過濾：Cambridge 查證開關 ＋ 黑名單 增/刪（devMode） ──
  document.getElementById('ocrCambVerifyToggle')?.addEventListener('click', async () => {
    const v = await s.actions.toggleOcrCambridgeVerify();
    toast(v ? 'Cambridge 查證已開啟' : 'Cambridge 查證已關閉', v ? 'toast-success' : '');
    renderInPlace(s);
  });
  // D段：韋氏 Key 存檔（寫 DB＋同步回 state，免重啟即用）
  document.getElementById('mwKeysSaveBtn')?.addEventListener('click', async () => {
    const dk = (document.getElementById('mwDictKeyInput')?.value || '').trim();
    const tk = (document.getElementById('mwThesKeyInput')?.value || '').trim();
    const { setSetting } = await import('../lib/db.js');
    try { await setSetting('mwDictKey', dk); await setSetting('mwThesKey', tk); } catch (_) {}
    s.state.mwDictKey = dk; s.state.mwThesKey = tk;
    toast(dk || tk ? '韋氏 Key 已儲存' : '韋氏 Key 已清除', 'toast-success');
    renderInPlace(s);
  });
  // MWTEST1：韋氏連線測試（用輸入框當下值打 gross，不經存檔；綠＝有 entries，黃＝key 有效但查無字，紅＝key 無效／網路錯）
  document.getElementById('mwKeysTestBtn')?.addEventListener('click', async () => {
    const dk = (document.getElementById('mwDictKeyInput')?.value || '').trim();
    const tk = (document.getElementById('mwThesKeyInput')?.value || '').trim();
    const box = document.getElementById('mwKeysTestResult');
    const say = (html) => { if (box) box.innerHTML = html; };
    if (!dk && !tk) { toast('請先填入至少一把 Key', 'toast-error'); say(''); return; }
    const btn = document.getElementById('mwKeysTestBtn');
    if (btn) btn.disabled = true;
    say('<span style="color:var(--text-secondary)">測試中…（查詢 gross）</span>');
    try {
      const { lookupMerriam } = await import('../lib/api.js');
      const { merriamToFields } = await import('../lib/merriam.js');
      const raw = await lookupMerriam('gross', dk, tk);
      const f = merriamToFields(JSON.parse(raw), 'gross');
      const hasEntry = !!(f.pos || f.definition || f.pron || f.example || f.forms || f.synonym || f.etymology || f.syllables);
      if (hasEntry) {
        const bits = [`詞性 ${escapeHtml((f.pos || '').split(',')[0] || '—')}`, `同義 ${escapeHtml((f.synonym || '').split(',').slice(0, 3).join('、') || '—')}`];
        say(`<span style="color:var(--green)">${icon('check')} 連線正常（gross 查到 ${bits.join('、')}）</span>`);
        toast('韋氏連線正常', 'toast-success');
      } else if ((f.suggest || []).length) {
        say(`<span style="color:var(--yellow, #eab308)">${icon('info')} Key 有效，但 gross 查無字（suggest：${escapeHtml(f.suggest.slice(0, 3).join('、'))}）</span>`);
        toast('Key 有效，但查無 gross', '');
      } else {
        say(`<span style="color:var(--yellow, #eab308)">${icon('info')} Key 有效，但 gross 無內容回來</span>`);
        toast('查無內容', '');
      }
    } catch (e) {
      const m = String(e?.message || e);
      if (/401|Invalid API key|Not subscribed/i.test(m)) {
        say(`<span style="color:var(--red, #ef4444)">${icon('x')} Key 無效：${escapeHtml(m.slice(0, 100))}</span>`);
        toast('韋氏 Key 無效', 'toast-error');
      } else if (/timed out/i.test(m)) {
        say(`<span style="color:var(--red, #ef4444)">${icon('x')} 連線逾時，請重試</span>`);
        toast('韋氏請求逾時', 'toast-error');
      } else {
        say(`<span style="color:var(--red, #ef4444)">${icon('x')} 查詢失敗：${escapeHtml(m.slice(0, 100))}</span>`);
        toast('韋氏測試失敗', 'toast-error');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  // AI 還原模型（可選進階；留空＝關閉純離線）
  document.getElementById('ocrRestoreModelBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('ocrRestoreModelInput');
    const v = (input?.value || '').trim();
    const { setSetting } = await import('../lib/db.js');
    try { await setSetting('ocrRestoreModel', v); } catch (_) {}
    toast(v ? `AI 還原已啟用：${v}` : 'AI 還原已關閉（純離線）', v ? 'toast-success' : '');
    renderInPlace(s);
  });
  document.getElementById('graylistAddBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('graylistAddInput');
    const w = (input?.value || '').toLowerCase().trim();
    if (!w) { toast('請輸入單字', 'toast-warn'); return; }
    await s.actions.addToGraylist(w);
    toast(`已將 ${w} 加入灰名單`, 'toast-success');
    renderInPlace(s);
  });
  document.getElementById('graylistAddInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('graylistAddBtn')?.click();
  });
  document.querySelectorAll('.gl-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const w = btn.dataset.w;
      await s.actions.removeFromGraylist(w);
      toast(`已從灰名單移除 ${w}`, '');
      renderInPlace(s);
    });
  });
  // 灰名單 CSV 匯入
  document.getElementById('graylistCsvBtn')?.addEventListener('click', () => {
    document.getElementById('graylistCsvInput')?.click();
  });
  document.getElementById('graylistCsvInput')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text().catch(() => '');
    const res = await s.actions.importGraylistCsv(txt);
    toast(`灰名單匯入：新增 ${res.imported} 詞${res.skipped ? `（跳過 ${res.skipped} 重複）` : ''}`, res.imported ? 'toast-success' : '');
    renderInPlace(s);
  });

  // ── Theme (beta-d: mode + accent) ──
  document.getElementById('modeDarkBtn')?.addEventListener('click', async () => {
    await s.actions.setThemeMode('dark');
    document.getElementById('modeDarkBtn').className = 'btn btn-sm btn-primary';
    document.getElementById('modeLightBtn').className = 'btn btn-sm btn-secondary';
  });
  document.getElementById('modeLightBtn')?.addEventListener('click', async () => {
    await s.actions.setThemeMode('light');
    document.getElementById('modeDarkBtn').className = 'btn btn-sm btn-secondary';
    document.getElementById('modeLightBtn').className = 'btn btn-sm btn-primary';
  });
  document.querySelectorAll('.swatch[data-accent]').forEach(el => {
    el.addEventListener('click', async () => {
      const name = el.dataset.accent;
      await s.actions.setThemeAccent(name);
      document.querySelectorAll('.swatch[data-accent]').forEach(c => c.classList.toggle('selected', c.dataset.accent === name));
    });
  });
  // App 圖示切換（Android activity-alias；非 Android no-op）
  document.querySelectorAll('[data-icon-key]').forEach(el => {
    el.addEventListener('click', async () => {
      const key = el.dataset.iconKey;
      const preset = ICON_PRESETS.find(p => p.key === key);
      // 樂觀更新：先改 UI + 存 DB，再呼叫 Android（即使切換 crash，指示/狀態也正確）
      document.querySelectorAll('[data-icon-key]').forEach(c => c.classList.toggle('selected', c.dataset.iconKey === key));
      try { const d = await import('../lib/db.js'); await d.setSetting('launcherIcon', key); } catch { /* 非 Tauri 環境可忽略 */ }
      // F7：切 icon 成功點同步寫 splash cache（localStorage，渲染快取非業務資料），
      // 消「切換後首次冷啟動殘留舊底色」窗口——cache 與 DB 同點更新
      try { localStorage.setItem('_splashIconKey', key); } catch { /* 無痕吞 */ }
      try {
        await setLauncherIcon(key);
        // Android：切換後 app 會自動重啟以套用新 icon（避免系統 finish / launcher 顯示舊 icon）
        toast(`圖示已切換為 ${preset?.label || key}，重新啟動中…`, 'toast-success');
      } catch (e) {
        console.error('[settings] 切換圖示失敗:', e);
        toast('切換圖示失敗（重開機後套用）: ' + e, 'toast-error');
      }
    });
  });

  // Accent intensity slider
  {
    const r = document.getElementById('accentIntensityRange');
    const l = document.getElementById('accentIntensityLabel');
    if (r) {
      r.addEventListener('input', () => { if (l) l.textContent = `${Math.round(parseFloat(r.value) * 100)}%`; });
      r.addEventListener('change', async () => { await s.actions.setThemeAccentIntensity(parseFloat(r.value)); });
    }
  }

  document.getElementById('maxExamSessionsInput')?.addEventListener('change', async () => {
    const val = parseInt(document.getElementById('maxExamSessionsInput')?.value);
    if (val > 0) {
      await s.actions.setMaxExamSessions(val);
    }
  });

  document.getElementById('exampleDisplayMaxInput')?.addEventListener('change', async () => {
    const el = document.getElementById('exampleDisplayMaxInput');
    const val = Math.max(0, Math.min(50, parseInt(el?.value) || 0));
    el.value = val;
    window.__maxExampleLines = val;
    try {
      const d = await import('../lib/db.js');
      await d.setSetting('exampleDisplayMax', String(val));
      toast(val === 0 ? '例句顯示：全部顯示' : `例句顯示：最多 ${val} 句`, 'toast-success');
    } catch (e) {
      toast('例句顯示設定儲存失敗: ' + e, 'toast-error');
    }
  });

  // ── 欄位顯示（三組；學習／測驗共用：study 寫入時同步 exam，渲染端 exam 讀 study 別名）──
  document.querySelectorAll('[data-fieldvis-ctx]')?.forEach(cb => {
    cb.addEventListener('change', async () => {
      const ctx = cb.dataset.fieldvisCtx;
      const ctxs = ctx === 'study' ? ['study', 'exam'] : [ctx];
      const vals = Array.from(document.querySelectorAll(`[data-fieldvis-ctx="${ctx}"]:checked`)).map(x => x.value);
      // 學習組英文單字強制保留（checkbox disabled 仍會被 :checked 選中，雙保險）
      if (ctx === 'study' && !vals.includes('word')) vals.unshift('word');
      try {
        const d = await import('../lib/db.js');
        for (const c of ctxs) {
          const key = 'fieldVis' + c[0].toUpperCase() + c.slice(1);
          await d.setSetting(key, JSON.stringify(vals));
          s.state[key] = [...vals];
          window.__fieldVis = window.__fieldVis || {};
          window.__fieldVis[c] = [...vals];
        }
        toast('欄位顯示已更新', 'toast-success');
      } catch (e) {
        toast('欄位顯示儲存失敗: ' + e, 'toast-error');
      }
    });
  });

  document.getElementById('logRetentionInput')?.addEventListener('change', async () => {
    const val = parseInt(document.getElementById('logRetentionInput')?.value);
    if (Number.isFinite(val) && val >= 0) {
      await s.actions.setLogRetention(val);
      toast(`${val === 0 ? '操作日誌已停用（僅保留 error）' : `操作日誌保留 ${val} 天（error 固定 90 天）`}`, 'toast-success');
    }
  });

  // LOG-SCOPE1：分類開關（關掉只擋新寫入，已存的不動；error 照寫）
  document.querySelectorAll('[data-logscope]')?.forEach(cb => {
    cb.addEventListener('change', async () => {
      await s.actions.setLogScope(cb.dataset.logscope, cb.checked);
      toast(`日誌「${cb.dataset.logscope}」${cb.checked ? '開始記錄' : '已暫停記錄（舊的不刪）'}`, 'toast-success');
    });
  });

  // LOG-SCOPE1：除錯鏡像開關
  document.getElementById('logMirrorToggle')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    await s.actions.setLogMirror(on);
    btn.className = `switch-btn ${on ? 'on' : ''}`;
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '開' : '關';
    toast(on ? '除錯鏡像已開啟' : '除錯鏡像已關閉（僅 error 保留）', 'toast-success');
  });

  // ── WebDAV Sync（帳密存一次，之後自動帶；上傳自動對帳）──
  async function updateWebdavUI() {
    const st = document.getElementById('webdavStatusText');
    try {
      const status = await webdavStatus();
      st.textContent = `狀態: ${status}`;
    } catch (e) {
      st.textContent = `狀態: ${e}`;
    }
  }
  updateWebdavUI();

  // WebDAV 自動上傳開關（存 db settings，預設關；開了才跟本地自動備份同一 tick 上傳）
  import('../lib/db.js').then(async ({ getSetting, setSetting }) => {
    const box = document.getElementById('webdavAutoUpload');
    if (!box) return;
    try {
      const flag = await getSetting('webdavAutoUpload');
      box.checked = flag === 1 || flag === true || flag === '1';
    } catch (_) {}
    box.addEventListener('change', async () => {
      try {
        await setSetting('webdavAutoUpload', box.checked ? 1 : 0);
        toast(box.checked ? '已開啟：自動備份時同步上傳 WebDAV' : '已關閉 WebDAV 自動上傳', 'toast-success');
      } catch (e) {
        toast('設定儲存失敗: ' + e, 'toast-error');
      }
    });
  }).catch(() => {});

  document.getElementById('webdavSaveBtn')?.addEventListener('click', async () => {
    const url = document.getElementById('webdavUrl').value.trim();
    const user = document.getElementById('webdavUser').value.trim();
    const pass = document.getElementById('webdavPass').value;
    if (!url || !user) { toast('請填寫 URL 和帳號', 'toast-warn'); return; }
    try {
      const result = await webdavSaveConfig(url, user, pass);
      document.getElementById('webdavPass').value = '';
      toast(result, 'toast-success');
      updateWebdavUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  document.getElementById('webdavTestBtn')?.addEventListener('click', async () => {
    try {
      const result = await webdavTest();
      toast(result, 'toast-success');
      updateWebdavUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  document.getElementById('webdavUploadBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('webdavUploadBtn');
    btn.disabled = true;
    btn.textContent = '處理中…';
    try {
      // D3 同源：WAL checkpoint → 主檔完整後再上傳（webdav_upload 只 fs::read 主檔）
      const { checkpoint } = await import('../lib/db.js');
      await checkpoint();
      try {
        const result = await webdavUpload();
        toast(result, 'toast-success');
      } catch (e) {
        // WEBDAV-GUARD1：遠端比較新→擋下，問過才硬蓋（舊蓋新防呆）
        const msg = String(e);
        if (msg.includes('CONFLICT:')) {
          // SYNC2-Q1：分叉→不自動蓋，遠端已存 conflict 檔，人看完再選
          toast(msg, 'toast-error');
          if (confirm(msg.replace('CONFLICT:', '') + '\n\n確定要用本地版強制覆蓋遠端？（遠端舊版已存 conflict 檔＋伺服器 .history）')) {
            const result = await webdavUpload(true);
            toast(result + '（已強制覆蓋）', 'toast-success');
          } else {
            toast('已取消上傳（兩邊都在，本地未動）', '');
            return;
          }
        } else if (msg.includes('EMPTY_LOCAL:')) {
          toast(msg, 'toast-error');
          return;
        } else if (msg.includes('REMOTE_NEWER:') && confirm(msg.replace('REMOTE_NEWER:', '') + '\n\n確定要用本地舊版覆蓋遠端新版？')) {
          const result = await webdavUpload(true);
          toast(result + '（已強制覆蓋）', 'toast-success');
        } else if (!msg.includes('REMOTE_NEWER:')) {
          throw e;
        } else {
          toast('已取消上傳（遠端較新，本地未動）', '');
          return;
        }
      }
      const _d = await import('../lib/db.js');
      await _d.addAudit('webdav-upload', 'WebDAV 全庫上傳同步').catch(() => {});
      updateWebdavUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    } finally {
      btn.disabled = false;
      btn.textContent = '上傳同步';
    }
  });

  document.getElementById('webdavDownloadBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('webdavDownloadBtn');
    btn.disabled = true;
    try {
      if (!confirm('確定要從 WebDAV 下載備份並取代目前資料？（會自動備份目前資料庫）')) return;
      const { checkpoint, closeDB, initDB } = await import('../lib/db.js');
      const { closeAppLog } = await import('../lib/app-log.js');
      await checkpoint();
      await backupDb();
      await closeDB();
      await closeAppLog();
      try {
        const result = await webdavDownload();
        toast(result, 'toast-success');
      } catch (e) {
        // WEBDAV-GUARD1：本地比較新→擋下，問過才硬蓋（舊蓋新防呆）
        const msg = String(e);
        if (msg.includes('CONFLICT:')) {
          toast(msg, 'toast-error');
          if (confirm(msg.replace('CONFLICT:', '') + '\n\n確定要用遠端版強制覆蓋本地？（本地有新進度，會被吃掉）')) {
            const result = await webdavDownload(true);
            toast(result + '（已強制覆蓋）', 'toast-success');
          } else {
            toast('已取消下載（兩邊都在，本地未動）', '');
            try { await initDB(2); } catch (_) {}
            return;
          }
        } else if (msg.includes('EMPTY_REMOTE:')) {
          toast(msg, 'toast-error');
          try { await initDB(2); } catch (_) {}
          return;
        } else if (msg.includes('LOCAL_NEWER:') && confirm(msg.replace('LOCAL_NEWER:', '') + '\n\n確定要用遠端舊版覆蓋本地新版？')) {
          const result = await webdavDownload(true);
          toast(result + '（已強制覆蓋）', 'toast-success');
        } else if (!msg.includes('LOCAL_NEWER:')) {
          throw e;
        } else {
          toast('已取消下載（本地較新，本地未動）', '');
          try { await initDB(2); } catch (_) {}
          return;
        }
      }
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      toast(String(e), 'toast-error');
      try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('webdavClearBtn')?.addEventListener('click', async () => {
    await webdavLogout();
    toast('已清除 WebDAV 設定', 'toast-success');
    updateWebdavUI();
  });

  // ── 內嵌本地雲 WEBDAV-EMBED1（桌機限定；手機走 Termux 獨立版）──
  async function updateWebdavSrvUI() {
    const st = document.getElementById('webdavSrvStatusText');
    if (!st) return;
    try {
      const status = await webdavServerStatus();
      st.textContent = `狀態: ${status}`;
    } catch (e) {
      st.textContent = `狀態: ${e}`;
    }
    try {
      const cfg = await webdavServerGetConfig();
      const port = document.getElementById('webdavSrvPort');
      const user = document.getElementById('webdavSrvUser');
      const auto = document.getElementById('webdavSrvAutostart');
      if (port && cfg.port) port.value = cfg.port;
      if (user && cfg.username) user.value = cfg.username;
      if (auto) auto.checked = !!cfg.autostart;
    } catch (_) {}
  }
  updateWebdavSrvUI();

  document.getElementById('webdavSrvSaveBtn')?.addEventListener('click', async () => {
    const port = parseInt(document.getElementById('webdavSrvPort')?.value, 10) || 8080;
    const user = document.getElementById('webdavSrvUser')?.value.trim() || 'teno';
    const pass = document.getElementById('webdavSrvPass')?.value || '';
    const autostart = !!document.getElementById('webdavSrvAutostart')?.checked;
    try {
      const result = await webdavServerSaveConfig(port, user, pass, autostart);
      document.getElementById('webdavSrvPass').value = '';
      toast(result, 'toast-success');
      updateWebdavSrvUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  document.getElementById('webdavSrvStartBtn')?.addEventListener('click', async () => {
    try {
      const result = await webdavServerStart();
      toast(result, 'toast-success');
      updateWebdavSrvUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  document.getElementById('webdavSrvStopBtn')?.addEventListener('click', async () => {
    try {
      const result = await webdavServerStop();
      toast(result, 'toast-success');
      updateWebdavSrvUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  // ── Anki 模式分頁 ──
  document.querySelectorAll('.study-mode-tab[data-anki-mode]').forEach(el => {
    el.addEventListener('click', () => {
      _ankiMode = el.dataset.ankiMode;
      renderInPlace(s);
    });
  });

  // ── Anki 設定儲存（依當前模式） ──
  window.__saveAnki = async () => {
    const el = (id) => document.getElementById(id);
    const _n = (id, fb) => { const v = parseFloat(el(id)?.value); return Number.isFinite(v) ? v : fb; };
    const cardsPerDay = _n('setCardsPerDay', 20);
    const payload = {
      maxIvl: _n('setMaxIvl', 365),
      cardsPerDay,
      desiredRetention: _n('setDesiredRetention', 0.9),
      leechThreshold: _n('setLeechThreshold', 8),
      fsrsWeights: el('setFsrsWeights')?.value?.trim() || null,
      learnSteps: el('setLearnSteps')?.value?.trim() || '1,10',
      relearnSteps: el('setRelearnSteps')?.value?.trim() || '10',
      learnAheadLimit: clampLearnAhead(_n('setLearnAheadLimit', 20)),
    };
    if (_ankiMode === 'mc') {
      await s.actions.updateAnkiSettingsMc(payload);
    } else if (_ankiMode === 'spell') {
      await s.actions.updateAnkiSettingsSpell(payload);
    } else {
      await s.actions.updateAnkiSettings(payload);
    }
    const maxRev = _n('setMaxReviewsPerDay', 1000);
    await s.actions.updateSimParams({ maxReviewsPerDay: Math.max(0, maxRev) });
    await s.actions.updateGoalStreak({ dailyGoal: cardsPerDay });
    const display = document.querySelector('.goal-item:last-child .goal-val');
    if (display) display.textContent = cardsPerDay;
    toast(`${_ankiMode === 'mc' ? '多選' : _ankiMode === 'spell' ? '拼字' : '翻卡'}設定已儲存`, 'toast-success');
  };

  const saveAnkiBtn = document.getElementById('saveAnkiBtn');
  if (saveAnkiBtn) saveAnkiBtn.addEventListener('click', window.__saveAnki);

  // ── Optimize Weights ──
  const optBtn = document.getElementById('optimizeWeightsBtn');
  if (optBtn) optBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('optimizeStatus');
    const detailEl = document.getElementById('optimizeDetail');
    optBtn.disabled = true;
    optBtn.textContent = '最佳化中...';
    try {
      const result = await s.actions.optimizeWeights((info) => {
        if (statusEl) statusEl.textContent = `Epoch ${info.epoch}/${info.totalEpochs} · loss ${info.currentLoss.toFixed(4)} · 改善 ${info.improvement}`;
      }, _ankiMode);
      const ta = document.getElementById('setFsrsWeights');
      if (ta) ta.value = result.weights.map(w => w.toFixed(4)).join(', ');
      const lossStr = result.initialLoss != null ? `${result.initialLoss.toFixed(4)} → ${result.finalLoss.toFixed(4)}` : '官方 fsrs-rs 優化';
      const impr = result.initialLoss != null ? ((result.initialLoss - result.finalLoss) / result.initialLoss * 100).toFixed(1) : null;
      const testStr = result.testLoss != null ? `測試集 loss: ${result.testLoss.toFixed(4)}` : '';
      const overfit = result.testLoss != null && result.finalLoss != null && (result.testLoss - result.finalLoss) > 0.05 ? '⚠️ 可能過擬合 (測試 loss 明顯高於訓練)' : '';
      if (statusEl) statusEl.textContent = result.initialLoss != null ? `完成！Loss ${lossStr}（改善 ${impr}%）` : `完成！${lossStr}`;
      if (detailEl) {
        detailEl.style.display = 'block';
        detailEl.innerHTML = `
          <div style="display:flex;flex-wrap:wrap;gap:var(--s3);padding:var(--s2) 0">
            ${result.finalLoss != null ? `<span style="color:var(--text-tertiary)">訓練 loss: ${result.finalLoss.toFixed(4)}</span>` : `<span style="color:var(--text-tertiary)">官方 fsrs-rs 演算法</span>`}
            ${testStr ? `<span style="color:var(--text-tertiary)">${testStr}</span>` : ''}
            <span style="color:var(--text-tertiary)">記錄數: ${result.reviewCount}</span>
          </div>
          ${overfit ? `<div style="color:var(--orange);font-size:11px">${overfit}</div>` : ''}
          <div style="margin-top:4px">
            <button class="btn btn-sm" id="simPreviewBtn" style="font-size:11px">${icon('chart')} 用此權重模擬</button>
            <span id="simPreviewStatus" style="font-size:11px;color:var(--text-tertiary);margin-left:var(--s2)"></span>
          </div>
        `;
        const simBtn = document.getElementById('simPreviewBtn');
        if (simBtn) simBtn.addEventListener('click', async () => {
          const sps = document.getElementById('simPreviewStatus');
          if (sps) sps.textContent = '執行中...';
          try {
            const result2 = await s.actions.runSimulation(365, result.weights.join(','));
            s.actions.navigate('simulator');
          } catch (e) {
            if (sps) sps.textContent = '模擬失敗';
          }
        });
      }
      toast(`FSRS 權重已最佳化 (${result.reviewCount} 筆記錄)`, 'toast-success');
    } catch (e) {
      toast(e.message, 'toast-error');
      if (statusEl) statusEl.textContent = e.message;
    } finally {
      optBtn.disabled = false;
      optBtn.textContent = '從歷史資料最佳化';
    }
  });

  // ── Health Check ──
  const hcBtn = document.getElementById('healthCheckBtn');
  if (hcBtn) hcBtn.addEventListener('click', async () => {
    const el = document.getElementById('healthCheckResult');
    if (!el) return;
    if (el.style.display === 'block') { el.style.display = 'none'; return; }
    try {
      const r = await s.actions.runHealthCheck(_ankiMode);
      const wordSummary = `${r.totalCards} 卡 · ${r.states.new}新 ${r.states.learning}學 ${r.states.review}複 ${r.states.relearning}重學`;
      const avg = `平均穩定度 ${r.avgStability.toFixed(1)}d · 難度 ${r.avgDifficulty.toFixed(1)} · 保留率 ${(r.retention * 100).toFixed(0)}%`;
      const dueRet = r.dueRetention != null ? `· 今日到期預測保留 ${(r.dueRetention * 100).toFixed(0)}%` : '';
      const issues = [];
      if (r.leeches > 0) issues.push(`水蛭 ${r.leeches} 張`);
      if (r.lowStabilityCards > 0) issues.push(`低穩定度 ${r.lowStabilityCards} 張`);
      if (r.highDifficultyCards > 0) issues.push(`高難度 ${r.highDifficultyCards} 張`);
      const leechList = r.topLeeches.length > 0
        ? r.topLeeches.map(l => `${escapeHtml(l.word)}(${l.lapses})`).join(' ')
        : '';
      const workload = `未來30天待覆習 ${r.workload.totalDue} 張 · 平均每天 ${(r.workload.daily.reduce((a,b)=>a+b,0) / 30).toFixed(0)} 張`;
      el.style.display = 'block';
      el.innerHTML = `
        <div style="padding:var(--s2);background:var(--bg-surface);border:1px solid var(--border);border-radius:6px">
          <div style="margin-bottom:4px">${wordSummary}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">${avg} ${dueRet}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">${workload}</div>
          ${issues.length > 0 ? `<div style="font-size:11px;color:var(--orange);margin-bottom:2px">⚠️ ${issues.join(' · ')}</div>` : ''}
          ${leechList ? `<div style="font-size:11px;color:var(--text-tertiary)">水蛭: ${leechList}</div>` : ''}
        </div>
      `;
    } catch (e) {
      el.style.display = 'block';
      el.textContent = '檢查失敗: ' + e.message;
    }
  });

  window.__saveGoal = async () => {
    const v = parseInt(document.getElementById('setDailyGoal')?.value);
    const val = Number.isFinite(v) ? v : 20;
    const modeKey = _ankiMode === 'mc' ? 'ankiSettingsMc' : _ankiMode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
    if (s.state[modeKey]) {
      const updateFn = _ankiMode === 'mc' ? 'updateAnkiSettingsMc' : _ankiMode === 'spell' ? 'updateAnkiSettingsSpell' : 'updateAnkiSettings';
      await s.actions[updateFn]({ cardsPerDay: val });
    }
    await s.actions.updateGoalStreak({ dailyGoal: val });
    const display = document.querySelector('.goal-item:last-child .goal-val');
    if (display) display.textContent = val;
    toast('每日目標已更新', 'toast-success');
  };

  document.getElementById('dangerResetBtn')?.addEventListener('click', () => {
    if (confirm('確定要清除所有資料？所有單字、進度與設定將永久遺失！')) s.actions.resetAll();
  });
  document.getElementById('dangerExportBtn')?.addEventListener('click', runExportDb);
  document.getElementById('dangerImportBtn')?.addEventListener('click', runImportDb);
  document.getElementById('dangerBackupBtn')?.addEventListener('click', showBackups);
  const biEl = document.getElementById('backupIntervalH');
  const bkEl = document.getElementById('backupKeepMax');
  const applyBackupCfg = async () => {
    const h = Math.max(1, Math.min(168, parseInt(biEl?.value) || 24));
    const n = Math.max(1, Math.min(100, parseInt(bkEl?.value) || 7));
    try {
      const d = await import('../lib/db.js');
      await d.setSetting('backupIntervalH', h);
      await d.setSetting('backupKeepMax', n);
      s.state.backupIntervalH = h;
      s.state.backupKeepMax = n;
      const { startAutoBackup, stopAutoBackup } = await import('../lib/backup-scheduler.js');
      stopAutoBackup();
      startAutoBackup();
      toast(`自動備份：每 ${h} 小時一次、保留 ${n} 個`, 'toast-success');
    } catch (e) {
      toast('備份設定儲存失敗: ' + e, 'toast-error');
    }
  };
  biEl?.addEventListener('change', applyBackupCfg);
  bkEl?.addEventListener('change', applyBackupCfg);

  // ── 過濾牌組事件 ──
  document.getElementById('filteredDeckAddBtn')?.addEventListener('click', () => {
    showFilteredDeckModal(s);
  });

  document.querySelectorAll('[data-fd-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-fd-id');
      const fd = s.state.filteredDecks.find(d => d.id === id);
      if (fd) showFilteredDeckModal(s, fd);
    });
  });

  document.querySelectorAll('[data-fd-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-fd-id');
      const fd = s.state.filteredDecks.find(d => d.id === id);
      if (!fd) return;
      if (!confirm(`確定要刪除過濾牌組「${fd.name}」？`)) return;
      await s.actions.deleteFilteredDeck(id);
      toast(`已刪除過濾牌組「${fd.name}」`, 'toast-success');
      renderInPlace(s);
    });
  });

  // ── 字本管理事件 ──
  bindDeckManager(s);

  // ── 從側邊欄觸發新增字本 ──
  if (s.state._pendingDeckModal) {
    s.state._pendingDeckModal = false;
    openDeckModal(s, null);
  }

  // ── 嵌入的匯出/匯入/標籤管理 ──
  onMountExport(s, renderInPlace);
  onMountImport(s, renderInPlace);
  onMountTag(s, renderInPlace);

  // G23：設定的 inline onclick 於 WebKitGTK 可能不觸發 → mount 層統一把 button[onclick] 轉 addEventListener
  //（__saveGoal/__saveAnki 等已掛 window.*，轉綁後 WebKitGTK 正常；移除 inline 防重複觸發）
  document.querySelectorAll('button[onclick]').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/window\.__(\w+)\(/);
    if (m && typeof window['__' + m[1]] === 'function') {
      btn.addEventListener('click', window['__' + m[1]]);
      btn.removeAttribute('onclick');
    }
  });
}

// ─── 字本管理事件綁定 ─────────────────────────
function bindDeckManager(s) {
  const addBtn = document.getElementById('deckAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDeckModal(s, null));

  document.querySelectorAll('[data-deck-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deckId;
      const action = btn.dataset.deckAction;
      if (action === 'move-up') { await s.actions.moveDeck(id, -1); renderInPlace(s); return; }
      if (action === 'move-down') { await s.actions.moveDeck(id, 1); renderInPlace(s); return; }
      const deck = s.state.decks.find(d => d.id === id);
      if (!deck) return;
      if (action === 'edit') openDeckModal(s, deck);
      else if (action === 'delete') confirmDeleteDeck(s, deck);
      else if (action === 'merge') openMergeModal(s, deck);
    });
  });

}

function openDeckModal(s, deck) {
  const isEdit = !!deck;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  document.getElementById('deckModal')?.remove();

  const html = `
    <div class="modal-overlay open" id="deckModal">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <div class="modal-title">${icon(isEdit ? 'edit' : 'plus')} ${isEdit ? '編輯字本' : '新增字本'}</div>
          <button class="modal-close" id="deckModalClose">${icon('x')}</button>
        </div>
        <div class="form-group">
          <label class="form-label">字本名稱 *</label>
          <input class="form-input" id="deckName" placeholder="TOEFL 5000" value="${escapeAttr(deck?.name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">顏色</label>
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center">
            ${getDeckPalette(s).slice(0, 8).map(c => `
              <button type="button" class="color-swatch" data-color="${c}" style="background:${c}"
                aria-label="選擇顏色 ${c}"></button>
            `).join('')}
            <label class="color-swatch color-swatch-custom" title="自訂顏色">
              ${icon('sliders')}
              <input type="color" id="deckColorCustom" value="${deck?.color || '#b69dff'}">
            </label>
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-tertiary);margin-left:var(--s1)" id="deckColorLabel">${deck?.color || '#b69dff'}</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">新卡權重 <span style="font-size:11px;color:var(--text-tertiary)">（DW1）</span></label>
          <input class="form-input" id="deckNewWeight" type="number" min="0" max="100" step="0.5" value="${deck?.newWeight ?? 1}" style="width:100px">
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">1 = 正常隨機；越高，這本的新卡越容易被抽到；0 = 今天不出這本的新卡（既有卡複習不受影響）</div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<button class="btn btn-danger" id="deckModalDelete" style="margin-right:auto">${icon('trash')} 刪除</button>` : ''}
          <button class="btn" id="deckModalCancel">取消</button>
          <button class="btn-primary" id="deckModalSave">${icon('check')} ${isEdit ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  let chosenColor = deck?.color || '#b69dff';
  const colorLabel = document.getElementById('deckColorLabel');
  const setColor = (c) => {
    chosenColor = c;
    if (colorLabel) colorLabel.textContent = c;
    container.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color === c);
    });
  };
  setColor(chosenColor);

  container.querySelectorAll('.color-swatch[data-color]').forEach(sw => {
    sw.addEventListener('click', () => setColor(sw.dataset.color));
  });
  const custom = document.getElementById('deckColorCustom');
  if (custom) custom.addEventListener('input', () => setColor(custom.value));

  const close = () => document.getElementById('deckModal')?.remove();
  document.getElementById('deckModalClose')?.addEventListener('click', close);
  document.getElementById('deckModalCancel')?.addEventListener('click', close);
  document.getElementById('deckModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckModal') close();
  });

  document.getElementById('deckModalSave')?.addEventListener('click', async () => {
    const name = document.getElementById('deckName')?.value.trim();
    if (!name) { toast('請輸入字本名稱', 'toast-error'); return; }
    // 檢查重複名稱
    const dup = s.state.decks.find(d => d.name.toLowerCase() === name.toLowerCase() && d.id !== deck?.id);
    if (dup) { toast('已有同名字本', 'toast-error'); return; }
    // DW1: 新卡權重 — Number.isFinite 防呆（parseFloat+?? 接不住 NaN），clamp [0,100]
    const rawW = parseFloat(document.getElementById('deckNewWeight')?.value);
    const newWeight = Number.isFinite(rawW) ? Math.min(100, Math.max(0, rawW)) : 1;

    if (isEdit && deck) {
      await s.actions.updateDeck(deck.id, { name, color: chosenColor, newWeight });
      toast(`已更新字本「${name}」`, 'toast-success');
    } else {
      await s.actions.createDeck(name, chosenColor, newWeight);
      toast(`已建立字本「${name}」`, 'toast-success');
    }
    close();
    renderInPlace(s);
  });

  if (isEdit) {
    document.getElementById('deckModalDelete')?.addEventListener('click', async () => {
      if (!deck) return;
      await s.actions.deleteDeck(deck.id);
      toast(`已刪除字本「${deck.name}」及其中所有單字`, 'toast-success');
      close();
      renderInPlace(s);
    });
  }
}

async function confirmDeleteDeck(s, deck) {
  const count = s.state.words.filter(w => w.deck === deck.name).length;
  const msg = count > 0
    ? `確定要刪除字本「${deck.name}」？內含 ${count} 個單字將一併刪除。`
    : `確定要刪除字本「${deck.name}」？`;
  if (!confirm(msg)) return;
  await s.actions.deleteDeck(deck.id);
  toast(`已刪除字本「${deck.name}」`, 'toast-success');
  renderInPlace(s);
}

function openMergeModal(s, srcDeck) {
  const others = s.state.decks.filter(d => d.id !== srcDeck.id);
  const html = `
    <div class="modal-overlay open" id="mergeModal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${icon('shuffle')} 合併字本</div>
          <button class="modal-close" id="mergeModalClose">${icon('x')}</button>
        </div>
        <div style="padding:var(--s4) 0">
          <div style="font-size:13px;color:var(--text-primary);margin-bottom:var(--s4);font-weight:600">
            ${escapeHtml(srcDeck.name)} <span style="color:var(--text-tertiary)">(${s.state.words.filter(w => w.deck === srcDeck.name).length} 詞)</span>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s3)">合併到哪個字本？</div>
          <select id="mergeTargetSelect" class="form-input" style="width:100%">
            ${others.map(d => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)} (${s.state.words.filter(w => w.deck === d.name).length} 詞)</option>`).join('')}
          </select>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:var(--s3)">來源字本的單字和學習進度都會保留，僅變更所屬字本名稱。</div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="mergeModalCancel">取消</button>
          <button class="btn-primary" id="mergeModalConfirm">${icon('shuffle')} 合併</button>
        </div>
      </div>
    </div>`;
  const container = document.getElementById('pageContainer');
  container.insertAdjacentHTML('beforeend', html);
  const close = () => document.getElementById('mergeModal')?.remove();
  document.getElementById('mergeModalClose')?.addEventListener('click', close);
  document.getElementById('mergeModalCancel')?.addEventListener('click', close);
  document.getElementById('mergeModal')?.addEventListener('click', e => { if (e.target.id === 'mergeModal') close(); });
  document.getElementById('mergeModalConfirm')?.addEventListener('click', async () => {
    const targetId = document.getElementById('mergeTargetSelect')?.value;
    if (!targetId) return;
    const target = s.state.decks.find(d => d.id === targetId);
    if (!target) return;
    await s.actions.mergeDeck(srcDeck.id, targetId);
    close();
    toast(`已將「${srcDeck.name}」合併至「${target.name}」`, 'toast-success');
    renderInPlace(s);
  });
}

// ─── 過濾牌組 Modal ─────────────────────────────
function showFilteredDeckModal(s, fd = null) {
  const isEdit = !!fd;
  const container = document.getElementById('pageContainer');
  if (!container) return;

  const html = `
    <div class="modal-overlay open" id="fdModal">
      <div class="modal">
        <div class="modal-header">
          <h3>${isEdit ? '編輯過濾牌組' : '新增過濾牌組'}</h3>
          <button class="btn btn-ghost" id="fdModalClose">${icon('x')}</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--s3);padding:var(--s4) 0">
          <div>
            <label class="form-label">名稱</label>
            <input type="text" id="fdName" class="form-input" value="${escapeAttr(fd?.name || '')}" placeholder="例如：困難卡片">
          </div>
          <div>
            <label class="form-label">搜尋條件</label>
            <input type="text" id="fdQuery" class="form-input" value="${escapeAttr(fd?.search_query || '')}" placeholder="is:due deck:TOEFL tag:hard">
            <div style="margin-top:var(--s1);font-size:11px;color:var(--text-tertiary)">
              支援：is:due, is:new, is:learning, is:review, deck:名稱, tag:標籤, lapses:>5, props:ivl>30
            </div>
          </div>
          <div style="display:flex;gap:var(--s3)">
            <div style="flex:1">
              <label class="form-label">最多卡片數</label>
              <input type="number" id="fdMaxCards" class="form-input" value="${fd?.max_cards || 100}" min="1" max="1000">
            </div>
            <div style="flex:1">
              <label class="form-label">排序方式</label>
              <select id="fdOrderBy" class="form-input">
                <option value="due" ${fd?.order_by === 'due' ? 'selected' : ''}>到期時間</option>
                <option value="random" ${fd?.order_by === 'random' ? 'selected' : ''}>隨機</option>
                <option value="added" ${fd?.order_by === 'added' ? 'selected' : ''}>加入時間</option>
                <option value="interval" ${fd?.order_by === 'interval' ? 'selected' : ''}>間隔天數</option>
                <option value="lapses" ${fd?.order_by === 'lapses' ? 'selected' : ''}>遺忘次數</option>
              </select>
            </div>
          </div>
          <div>
            <label class="form-label">顏色</label>
            <div style="display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
              <input type="color" id="fdColor" class="form-input" value="${escapeAttr(fd?.color || '#f59e0b')}" style="width:60px">
              <span id="fdColorLabel" style="font-size:12px;color:var(--text-tertiary)">${escapeHtml(fd?.color || '#f59e0b')}</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<button class="btn btn-danger" id="fdModalDelete" style="margin-right:auto">${icon('trash')} 刪除</button>` : ''}
          <button class="btn" id="fdModalCancel">取消</button>
          <button class="btn-primary" id="fdModalSave">${icon('check')} ${isEdit ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  const colorInput = document.getElementById('fdColor');
  const colorLabel = document.getElementById('fdColorLabel');
  if (colorInput && colorLabel) {
    colorInput.addEventListener('input', () => {
      colorLabel.textContent = colorInput.value;
    });
  }

  const close = () => document.getElementById('fdModal')?.remove();
  document.getElementById('fdModalClose')?.addEventListener('click', close);
  document.getElementById('fdModalCancel')?.addEventListener('click', close);
  document.getElementById('fdModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'fdModal') close();
  });

  document.getElementById('fdModalSave')?.addEventListener('click', async () => {
    const name = document.getElementById('fdName')?.value.trim();
    const query = document.getElementById('fdQuery')?.value.trim();
    const maxCards = parseInt(document.getElementById('fdMaxCards')?.value) || 100;
    const orderBy = document.getElementById('fdOrderBy')?.value || 'due';
    const color = document.getElementById('fdColor')?.value || '#f59e0b';

    if (!name) { toast('請輸入名稱', 'toast-error'); return; }
    if (!query) { toast('請輸入搜尋條件', 'toast-error'); return; }

    const data = { name, search_query: query, max_cards: maxCards, order_by: orderBy, color };

    if (isEdit && fd) {
      data.id = fd.id;
      await s.actions.updateFilteredDeck(fd.id, data);
      toast(`已更新過濾牌組「${name}」`, 'toast-success');
    } else {
      await s.actions.createFilteredDeck(data);
      toast(`已建立過濾牌組「${name}」`, 'toast-success');
    }
    close();
    renderInPlace(s);
  });

  if (isEdit) {
    document.getElementById('fdModalDelete')?.addEventListener('click', async () => {
      if (!fd) return;
      if (!confirm(`確定要刪除過濾牌組「${fd.name}」？`)) return;
      await s.actions.deleteFilteredDeck(fd.id);
      toast(`已刪除過濾牌組「${fd.name}」`, 'toast-success');
      close();
      renderInPlace(s);
    });
  }

  // ponytail: inline onclick broken in WebKitGTK, use addEventListener
  document.querySelectorAll('button[onclick]').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/window\.__(\w+)\(/);
    if (m && typeof window['__' + m[1]] === 'function') {
      btn.addEventListener('click', window['__' + m[1]]);
      btn.removeAttribute('onclick');
    }
  });
}

// ─── 匯入事件綁定 ──────────────────────────────
// ─── 重新渲染當頁（保留搜尋狀態）─────────────
function renderInPlace(s) {
  const container = document.getElementById('pageContainer');
  if (container) {
    container.innerHTML = render(s);
    onMount(s);
    if (typeof initCustomSelects === 'function') initCustomSelects(container);   // G14: 重渲染後重建 custom-select 轉換
  }
}

// ─── Helpers ───────────────────────────────────
function parseTagsInput(str) {
  return String(str || '')
    .split(/[,\n]/)
    .map(t => t.trim())
    .filter(t => t.length > 0 && t.length <= 32);
}

// ─── HTML escaping ─────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

function formatCutoffHHMM(minutes) {
  const m = Math.max(0, Math.min(1439, minutes | 0));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
