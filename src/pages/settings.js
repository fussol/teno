// ═══════════════════════════════════════════════════════════════
// Settings — Anki parameters, goals, deck management, word editing,
//            CSV import/export, data management.
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { initCustomSelects } from '../lib/custom-select.js';   // G14: renderInPlace 重渲染後重建 custom-select
import { toast } from '../main.js';
import { speak } from '../lib/tts.js';
import pkg from '../../package.json';
import { ACCENTS, ACCENT_GROUPS } from '../lib/theme.js';
import { isAndroid, downloadBlob, downloadBlobFromArray } from '../lib/platform.js';
import { exportDbDialog, exportDbData, importDbDialog, listBackups, backupDb, restoreBackup as apiRestoreBackup, exportBackupDialog as apiExportBackup, exportBackupData as apiExportBackupData, deleteBackup as apiDeleteBackup, listPiperVoices, importPiperModelDialog, installPiperModel, deletePiperModel, listAndroidVoices, driveSaveCreds, driveOAuth, driveUpload, driveDownload, driveStatus, driveLogout, setLauncherIcon } from '../lib/api.js';
import { renderContent as renderImportContent, onMount as onMountImport } from './import.js';
import { renderContent as renderExportContent, onMount as onMountExport } from './export.js';
import { renderContent as renderTagContent, onMount as onMountTag } from './tag-manager.js';
import { ICON_PRESETS } from '../lib/icon-presets.js';
import { clampLearnAhead } from '../lib/store.js';

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
            <button id="modeDarkBtn" class="btn-sm ${s.state.themeMode === 'dark' ? 'btn-primary' : 'btn-secondary'}" data-mode="dark">${icon('moon')} 深色</button>
            <button id="modeLightBtn" class="btn-sm ${s.state.themeMode === 'light' ? 'btn-primary' : 'btn-secondary'}" data-mode="light">${icon('sun')} 淺色</button>
          </div>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('layers')} 強調色</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:var(--s3)">
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
        <div class="config-field">
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

    ${s.state.devMode ? `
    <!-- 操作日誌 -->
    <div class="section">
      <div class="section-title">${icon('list')} 操作日誌</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('database')} 保留天數</div>
          </div>
          <input type="number" id="logRetentionInput" min="0" max="365" value="${s.state.logRetentionDays ?? 14}" style="width:80px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px;text-align:center;font-family:var(--mono)">
        </div>
      </div>
    </div>
    ` : ''}

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

    <!-- Google Drive Sync -->
    <div class="section">
      <div class="section-title">${icon('upload')} Google Drive 同步</div>
      <div class="config-section">
        <div id="driveCredsSection">
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">Client ID</div>
              <div class="config-field-hint">OAuth 2.0 Desktop 用戶端的 Client ID</div>
            </div>
            <input type="text" id="driveClientId" class="form-input" placeholder="貼上 Client ID" style="width:100%">
          </div>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">Client Secret</div>
            </div>
            <input type="text" id="driveClientSecret" class="form-input" placeholder="貼上 Client Secret" style="width:100%">
          </div>
          <button class="btn-primary btn-sm" id="driveSaveCredsBtn">${icon('check')} 儲存憑證</button>
        </div>
        <div id="driveSyncSection">
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">${icon('upload')} 同步狀態</div>
              <div class="config-field-hint">將資料庫同步到 Google Drive appDataFolder</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--s2)">
              <button class="btn btn-sm btn-primary" id="driveSyncBtn">${icon('upload')} 上傳同步</button>
              <button class="btn btn-sm btn-secondary" id="driveDownloadBtn">${icon('download')} 下載</button>
              <button class="btn btn-sm btn-secondary" id="driveLogoutBtn" style="display:none">${icon('x')} 登出</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary)" id="driveStatusText">檢查中…</div>
        </div>
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
          <label style="font-size:12px;color:var(--text-tertiary);display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" id="exportIncludeLog" checked> 一併匯出操作日誌
          </label>
        </div>
        <div style="border-top:1px solid var(--border-subtle);padding-top:var(--s3)">
          <button class="btn btn-sm" id="dangerBackupBtn">${icon('clock')} 自動備份管理</button>
          <div id="backupList" style="margin-top:var(--s2);display:none;font-size:12px;color:var(--text-tertiary)"></div>
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
                <div class="muted" style="font-size:11px">錄入時連線 Cambridge 查證，查得到的才入庫；離線時自動降級放行</div>
              </div>
              <button class="switch-btn ${s.state.ocrCambridgeVerify ? 'on' : ''}" id="ocrCambVerifyToggle" style="flex-shrink:0" aria-pressed="${s.state.ocrCambridgeVerify}">${s.state.ocrCambridgeVerify ? '開' : '關'}</button>
            </div>
            <div class="muted" style="font-size:11px;margin:var(--s2) 0">黑名單（${s.state.blacklist.length} 詞）：功能詞＋草漯檢定詞，系統預設，無法修改</div>
            <div id="blacklistList" style="max-height:160px;overflow-y:auto;border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--s1)">
              ${s.state.blacklist.slice().sort().map(w => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 6px;font-size:12px;border-bottom:1px solid var(--border-subtle)">
                  <span style="font-family:var(--mono)">${w}</span>
                </div>`).join('')}
            </div>
            <div style="border-top:1px solid var(--border-subtle);margin-top:var(--s3);padding-top:var(--s2)">
              <div class="muted" style="font-size:11px;margin-bottom:var(--s1)">AI 還原模型（可選）：離線拼字還原找不到的字，丟本機 ollama 補強。留空＝關閉（純離線，手機預設）。桌面部屬可設 e.g. qwen3-ocr64k</div>
              <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2)">
                <input type="text" id="ocrRestoreModelInput" placeholder="留空＝關閉；輸入 ollama 模型名啟用" value="${s.state.ocrRestoreModel || ''}" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
                <button class="btn btn-sm" id="ocrRestoreModelBtn">${icon('check')} 設定</button>
              </div>
              <div class="muted" style="font-size:11px;margin-bottom:var(--s1)">灰名單（${s.state.graylist.length} 詞）：OCR 辨識時「未勾選淘汰」的字自動加入，不進入一般學習序；可手動增刪或 CSV 匯入</div>
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
                    <button class="gl-del" data-w="${w}" style="background:none;border:none;color:var(--danger,#f87171);cursor:pointer;font-size:12px;padding:2px 4px">移除</button>
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>
        ` : ''}

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
    const includeLog = document.getElementById('exportIncludeLog')?.checked ?? true;
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
    if (includeLog) {
      try {
        const { checkpointAppLog } = await import('../lib/app-log.js');
        await checkpointAppLog();
      } catch (_) {}
    }
    if (isAndroid) {
      const data = await exportDbData(includeLog);
      downloadBlobFromArray(data, 'teno-backup.db', 'application/octet-stream');
      await d.addAudit('export-db', `匯出 .db 備份 (Android, includeLog=${includeLog})`).catch(() => {});
      toast(includeLog ? '資料庫 + 操作日誌已匯出' : '資料庫已匯出 (不含操作日誌)', 'toast-success');
    } else {
      const path = await exportDbDialog(includeLog);
      await d.addAudit('export-db', `匯出 → ${path} (includeLog=${includeLog})`).catch(() => {});
      toast(includeLog ? `資料庫 + 操作日誌已匯出 → ${path}` : `資料庫已匯出 → ${path}`, 'toast-success');
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
      html += `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid var(--border-subtle)">
        <span style="flex:1;color:var(--text-primary)">${dateStr}</span>
        <span class="muted" style="font-size:11px;width:60px">${size}</span>
        <button class="btn btn-xs" data-brestore="${escapeAttr(b.filename)}" style="font-size:11px">${icon('rotate')} 還原</button>
        <button class="btn btn-xs" data-bexport="${escapeAttr(b.filename)}" style="font-size:11px">${icon('save')} 匯出</button>
        <button class="btn btn-xs" data-bdelete="${escapeAttr(b.filename)}" style="font-size:11px;color:var(--red)">${icon('x')}</button>
      </div>`;
    }
    el.innerHTML = html;
    el.style.display = 'block';

    // Attach event listeners
    el.querySelectorAll('[data-brestore]').forEach(btn =>
      btn.addEventListener('click', () => restoreBackup(btn.dataset.brestore, btn)));
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

  // ── OCR 錄入過濾：Cambridge 查證開關 ＋ 黑名單 增/刪（devMode） ──
  document.getElementById('ocrCambVerifyToggle')?.addEventListener('click', async () => {
    const v = await s.actions.toggleOcrCambridgeVerify();
    toast(v ? 'Cambridge 查證已開啟' : 'Cambridge 查證已關閉', v ? 'toast-success' : '');
    renderInPlace(s);
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
    if (!w) { toast('請輸入單字', ''); return; }
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
    document.getElementById('modeDarkBtn').className = 'btn-sm btn-primary';
    document.getElementById('modeLightBtn').className = 'btn-sm btn-secondary';
  });
  document.getElementById('modeLightBtn')?.addEventListener('click', async () => {
    await s.actions.setThemeMode('light');
    document.getElementById('modeDarkBtn').className = 'btn-sm btn-secondary';
    document.getElementById('modeLightBtn').className = 'btn-sm btn-primary';
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

  document.getElementById('logRetentionInput')?.addEventListener('change', async () => {
    const val = parseInt(document.getElementById('logRetentionInput')?.value);
    if (Number.isFinite(val) && val >= 0) {
      await s.actions.setLogRetention(val);
      toast(`${val === 0 ? '操作日誌已停用' : `操作日誌保留 ${val} 天`}`, 'toast-success');
    }
  });

  // ── Google Drive Sync ──
  async function updateDriveUI() {
    const credsSection = document.getElementById('driveCredsSection');
    const syncSection = document.getElementById('driveSyncSection');
    const st = document.getElementById('driveStatusText');
    const logoutBtn = document.getElementById('driveLogoutBtn');
    try {
      const status = await driveStatus();
      if (status === '未設定') {
        credsSection.style.display = '';
        syncSection.style.display = 'none';
      } else {
        credsSection.style.display = 'none';
        syncSection.style.display = '';
        st.textContent = `狀態: ${status}`;
        logoutBtn.style.display = '';
      }
    } catch (e) {
      st.textContent = `狀態: ${e}`;
    }
  }
  updateDriveUI();

  document.getElementById('driveSaveCredsBtn')?.addEventListener('click', async () => {
    const id = document.getElementById('driveClientId').value.trim();
    const secret = document.getElementById('driveClientSecret').value.trim();
    if (!id || !secret) { toast('請填寫 Client ID 和 Secret', 'toast-warn'); return; }
    try {
      const result = await driveSaveCreds(id, secret);
      toast(result, 'toast-success');
      updateDriveUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    }
  });

  document.getElementById('driveSyncBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('driveSyncBtn');
    btn.disabled = true;
    btn.textContent = '處理中…';
    try {
      const status = await driveStatus();
      if (status === '未登入' || status === '憑證已過期' || status === '憑證可更新') {
        const oauthResult = await driveOAuth();
        toast(oauthResult, 'toast-success');
      }
      // D3: WAL checkpoint → 主檔完整後再上傳（drive_upload 只 fs::read 主檔）
      const { checkpoint } = await import('../lib/db.js');
      await checkpoint();
      const result = await driveUpload();
      toast(result, 'toast-success');
      const _d = await import('../lib/db.js');
      await _d.addAudit('drive-upload', 'Google Drive 全庫上傳同步').catch(() => {});
      updateDriveUI();
    } catch (e) {
      toast(String(e), 'toast-error');
    } finally {
      btn.disabled = false;
      btn.textContent = '上傳同步';
    }
  });

  document.getElementById('driveDownloadBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('driveDownloadBtn');
    btn.disabled = true;
    try {
      if (!confirm('確定要從 Google Drive 下載備份並取代目前資料？（會自動備份目前資料庫）')) return;
      const { checkpoint, closeDB, initDB } = await import('../lib/db.js');
      const { closeAppLog } = await import('../lib/app-log.js');
      await checkpoint();
      await backupDb();
      await closeDB();
      await closeAppLog();
      const result = await driveDownload();
      toast(result, 'toast-success');
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      toast(String(e), 'toast-error');
      try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('driveLogoutBtn')?.addEventListener('click', async () => {
    await driveLogout();
    toast('已登出 Google Drive', 'toast-success');
    updateDriveUI();
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

    if (isEdit && deck) {
      await s.actions.updateDeck(deck.id, { name, color: chosenColor });
      toast(`已更新字本「${name}」`, 'toast-success');
    } else {
      await s.actions.createDeck(name, chosenColor);
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
