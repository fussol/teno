// settings/sections.js — renderSettingsContent 模板主體（P4 Step1 自 settings.js 純搬移）
// 相依：原源 13 件 + settings.js 私有 7 件（循環 import：本檔只讀不寫，函式體執行期才取值）
import { icon } from '../../lib/svg.js';
import pkg from '../../../package.json' with { type: 'json' };
import { ACCENTS, ACCENT_GROUPS } from '../../lib/theme.js';
import { isAndroid, isWeb, isTauri } from '../../lib/platform.js';
import { renderContent as renderImportContent } from '../import.js';
import { renderContent as renderExportContent } from '../export.js';
import { renderContent as renderTagContent } from '../tag-manager.js';
import { ICON_PRESETS } from '../../lib/icon-presets.js';
import { UI_SCALE_LABELS } from '../../lib/store.js';
import { FIELD_LABELS, FIELD_KEYS, FIELD_STUDY_ONLY } from '../../lib/word-extra.js';
import { FIELD_VIS_GROUPS, _ankiMode, escapeAttr, formatCutoffHHMM, renderAnkiFields } from './_shared.js';
import { renderDeckManager, renderFilteredDecks } from './deck-manager.js';

export function renderSettingsContent(s) {
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
        ${isAndroid && isTauri ? `
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
        ` : ''}
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
          ${isAndroid || isWeb ? '' : `<button class="btn btn-sm" id="importPiperModelBtn" title="從本機選擇 .onnx 檔案">${icon('upload')}</button>`}
        </div>
        ${isWeb ? `
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">${icon('volume')} 語音來源</div>
            <div class="config-field-hint">「電腦 Piper」＝請執行 Teno 的電腦以 Piper 合成後傳回手機播放（音質較好；需連得到電腦，離線自動退回瀏覽器語音）；「瀏覽器」＝用手機內建語音。</div>
          </div>
          <select id="ttsSourceSel" class="form-input" style="width:auto">
            <option value="browser" ${(s.state.ttsSource || 'browser') === 'browser' ? 'selected' : ''}>瀏覽器</option>
            <option value="piper" ${s.state.ttsSource === 'piper' ? 'selected' : ''}>電腦 Piper</option>
          </select>
        </div>` : ''}
        ${isAndroid || isWeb ? '' : `
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

    <!-- 介面備註（僅 devMode 顯示：一般用戶不需要開關說明文字） -->
    ${s.state.devMode ? `
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
    ` : ''}

    <!-- UISCALE1：介面大小（僅桌機顯示設定；手機一律 100% 不理設定值） -->
    ${isAndroid ? '' : `
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
    `}

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
          <div class="config-field-hint">三組各別設定要顯示哪些欄位（例句含片語；英文單字只有字卡正反面可以隱藏）。「複習次數」「上次複習」只在學習組——三個模式各有自己的卡狀態，故只顯示你當下模式的數據。</div>
        </div>
        ${FIELD_VIS_GROUPS.map(([ctx, name, hint]) => {
          const cur = Array.isArray(s.state['fieldVis' + ctx[0].toUpperCase() + ctx.slice(1)])
            ? s.state['fieldVis' + ctx[0].toUpperCase() + ctx.slice(1)]
            : FIELD_KEYS.filter(k => !FIELD_STUDY_ONLY.includes(k));   // REPS1: fresh 不自動勾僅限學習情境的欄位
          // REPS1: reps/lastReview 只在學習情境有意義（瀏覽器無對應模式、測驗不寫卡），
          //   故僅「學習組」提供開關；瀏覽器正面／背面組不列，免得勾了沒反應。
          const groupKeys = ctx === 'study'
            ? FIELD_KEYS
            : FIELD_KEYS.filter(k => !FIELD_STUDY_ONLY.includes(k));
          return `<div style="margin-bottom:var(--s3)">
            <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:2px">${name}</div>
            <div class="config-field-hint" style="margin-bottom:6px">${hint}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${groupKeys.map(k => {
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
        ${s.state.devMode ? `
        <div class="config-field" style="margin-top:var(--s2);border-top:1px dashed var(--border-subtle);padding-top:var(--s2)">
          <div class="config-field-info">
            <div class="config-field-label">${icon('archive')} 日誌歸檔（只進雲端不出雲端）</div>
            <div class="config-field-hint">唯一入口在這裡；預設不同步。傳完 24h 後本地釋放已上傳區間（error 保留）。<span id="logArchiveStatus">讀取中…</span></div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2)">
            <button class="btn btn-sm" id="logArchiveUploadBtn">${icon('upload')} 上傳歸檔</button>
            <button class="btn btn-sm" id="logArchivePruneBtn">${icon('trash')} 釋放已上傳</button>
          </div>
        </div>` : ''}
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
    <!-- SIMPLIFY1：15 顆按鈕 → 3 顆可見。
         自動化的：設定欄位失焦即存＋自動測連線／差量優先失敗自動整包／
                   啟動停止合一／媒體併入主上傳／雲端列表自動重整。
         收進「進階」：媒體重試、清除設定、內嵌本地雲後台、來源切換。 -->
    <div class="section">
      <div class="section-title">${icon('upload')} WebDAV 同步</div>
      <div class="config-section">
        <!-- SIMPLIFY2：兩個子項目各自可收納（使用者指定）；「（免開瀏覽器）」字樣刪除 -->
        <details id="webdavConfigSection" style="margin-bottom:var(--s2)">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-secondary);user-select:none">連線設定（URL／帳號／密碼）</summary>
        <div style="margin-top:var(--s2)">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">伺服器 URL</div>
            <div class="config-field-hint">填好即自動儲存並測試連線（不用按按鈕）</div>
          </div>
          <input type="text" id="webdavUrl" class="form-input" placeholder="http://192.168.50.69:8080" style="width:100%">
        </div>
        <div class="config-field">
          <div class="config-field-info"><div class="config-field-label">帳號</div></div>
          <input type="text" id="webdavUser" class="form-input" placeholder="帳號" style="width:100%">
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">密碼</div>
            <div class="config-field-hint">帳密只輸這一次，存本機 0600，之後上傳下載自動帶</div>
          </div>
          <input type="password" id="webdavPass" class="form-input" placeholder="密碼" style="width:100%">
        </div>
        </div>
        </details>
        <div id="webdavSyncSection" style="margin-top:var(--s3)">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);margin-bottom:var(--s3)">
            <input type="checkbox" id="webdavAutoUpload">
            自動同步（備份時上傳，有變更才傳；媒體一併帶；失敗下週期自動重試，狀態列可見）
          </label>
          <div class="config-field">
            <div class="config-field-info">
              <div class="config-field-label">${icon('upload')} 同步</div>
              <div class="config-field-hint">整顆 TENOC 同步包（teno.db＋app-log.db）。上傳／下載會**先走差量**（幾 KB），不可用時自動改走整包 —— 不用自己選。舊蓋新會先擋、分叉留雙檔、空檔拒傳。</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--s2)">
              <button class="btn btn-sm btn-primary" id="webdavUploadBtn">${icon('upload')} 上傳</button>
              <button class="btn btn-sm btn-primary" id="webdavDownloadBtn">${icon('download')} 下載</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:var(--s2)" id="webdavStatusText">檢查中…</div>
        </div>

        <details style="margin-top:var(--s3);border-top:1px solid var(--border-subtle);padding-top:var(--s2)">
          <summary style="cursor:pointer;font-size:13px;color:var(--text-secondary);user-select:none">進階</summary>
          <div style="margin-top:var(--s2)">
            <div style="display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-bottom:var(--s3)">
              <span id="mediaQueueWrap" style="display:none">
                <button class="btn btn-sm" id="webdavMediaFlushBtn">${icon('image')} 媒體重試 (<span id="mediaQueueCount">0</span>)</button>
                <button class="btn btn-sm" id="webdavMediaFlushCancelBtn" style="display:none">${icon('x')} 取消</button>
              </span>
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--text-tertiary)">
                <input type="checkbox" id="mediaWifiOnly"> 僅 WiFi 傳圖
              </label>
              <button class="btn btn-sm btn-secondary" id="webdavClearBtn">${icon('x')} 清除設定</button>
            </div>
            ${isAndroid || isWeb ? '' : `
            <div id="webdavServerSection" style="border-top:1px solid var(--border-subtle);padding-top:var(--s2)">
              <div class="config-field">
                <div class="config-field-info">
                  <div class="config-field-label">${icon('cloud')} 內嵌本地雲（跟著 Teno 起）</div>
                  <div class="config-field-hint">桌機開 Teno 就等於開雲，手機直接連；跟 ~/teno-webdav-app 同一空間。填好自動儲存。</div>
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">
                <input type="checkbox" id="webdavSrvAutostart">
                Teno 啟動時自動開啟（獨立版已頂著時自動讓路）
              </label>
              <div class="config-field">
                <div class="config-field-info"><div class="config-field-label">Port</div></div>
                <input type="number" id="webdavSrvPort" class="form-input" min="1" max="65535" value="8080" style="width:110px">
              </div>
              <div class="config-field">
                <div class="config-field-info"><div class="config-field-label">帳號</div></div>
                <input type="text" id="webdavSrvUser" class="form-input" placeholder="teno" style="width:100%">
              </div>
              <div class="config-field">
                <div class="config-field-info">
                  <div class="config-field-label">密碼</div>
                  <div class="config-field-hint">只輸這一次，存本機 0600；內嵌不設裸奔（要裸奔請用獨立版 --no-auth）</div>
                </div>
                <input type="password" id="webdavSrvPass" class="form-input" placeholder="密碼（已存則留空＝不改）" style="width:100%">
              </div>
              <div style="margin-top:var(--s2)">
                <button class="btn btn-sm btn-primary" id="webdavSrvToggleBtn">${icon('play')} 啟動本地雲</button>
              </div>
              <div style="font-size:12px;color:var(--text-tertiary);margin-top:var(--s2)" id="webdavSrvStatusText">檢查中…</div>
            </div>
            `}
          </div>
        </details>

        <!-- 雲端檔案 CLOUDBROWSE1（SIMPLIFY2：可收納）
             預設展開 —— 這是手機裝 APK 的主路徑，藏起來會多一步 -->
        <details id="webdavCloudSection" open style="margin-top:var(--s3);border-top:1px solid var(--border-subtle);padding-top:var(--s2)">
          <summary style="cursor:pointer;font-size:13px;color:var(--text-secondary);user-select:none">雲端檔案</summary>
          <div style="margin-top:var(--s2)">
          <div style="display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-bottom:var(--s2)">
            <button class="btn btn-sm btn-secondary" id="cloudUpBtn">↑</button>
            <span id="cloudPathLabel" style="font-size:12px;color:var(--text-secondary);font-weight:700">/</span>
            <span id="cloudSourceLabel" style="font-size:11px;color:var(--text-tertiary)"></span>
            <span style="flex:1"></span>
            ${isAndroid ? '' : `<button class="btn btn-sm btn-secondary" id="cloudSrcToggleBtn" title="本機直讀／雲端列表切換">切換來源</button>`}
          </div>
          <div id="cloudFileTable" style="font-size:13px;color:var(--text-tertiary)">載入中…</div>
          </div>
        </details>
      </div>
    </div>

    <!-- 桌面 Widget／提醒通知（Android 原生 AppWidget；僅 Android App，瀏覽器版與桌機不顯示） -->
    ${isAndroid && isTauri ? `
    <div class="section">
      <div class="section-title">${icon('home')} 桌面 Widget</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">抽字間隔</div>
            <div class="config-field-hint">抽字 widget 的自動換字間隔；狀態 widget 到期即時更新。手機深度休眠時可能稍有延遲（開下方常駐可縮小）</div>
          </div>
          <select id="widgetRotate" class="form-input" style="width:auto">
            <option value="15">15 分</option>
            <option value="60">1 時</option>
            <option value="180">3 時</option>
            <option value="1440">每天</option>
          </select>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">抽字顯示欄位</div>
            <div class="config-field-hint">在字／音標／詞性／釋義／例句之外額外顯示（含字本）；widget 與定時通知的字卡共用這組勾選。勾越多卡片越高，可把 widget 拉大（該欄沒資料就不佔行）</div>
          </div>
          <div style="display:flex;gap:var(--s3);flex-wrap:wrap">
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldSyllables"> 音節</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldDeck"> 字本</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldRelated"> 相關字</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldForms"> 變化形</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldSynonym"> 同義</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="widgetFieldAntonym"> 反義</label>
          </div>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">背景常駐</div>
            <div class="config-field-hint">每日＋開 App 刷新已足夠省電；只有要很密的間隔才需開（系統要求會有一則低耗電常駐通知，可關）</div>
          </div>
          <input type="checkbox" id="widgetResident">
        </div>
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
          <button class="btn btn-sm" id="widgetRefreshBtn">${icon('clock')} 立即刷新</button>
          <button class="btn btn-sm btn-secondary" id="widgetPermBtn">${icon('shield')} 授權</button>
        </div>
        <div id="widgetPermStatus" style="margin-top:var(--s2);font-size:12px;color:var(--text-tertiary)"></div>
      </div>
    </div>

    <!-- 提醒通知（獨立於 widget，無 widget 也能用） -->
    <div class="section">
      <div class="section-title">${icon('clock')} 提醒通知</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">間隔提醒</div>
            <div class="config-field-hint">每隔 X 從下方勾選的內容隨機抽一則推播（下限 1 秒，單位到小時、小時無上限例如 100；深度休眠時可能稍有延遲）</div>
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center">
            <input type="checkbox" id="widgetNotifyOn">
            <input type="number" id="widgetNotifyInterval" class="form-input" style="width:6em" min="1" step="1" value="60">
            <select id="widgetNotifyIntervalUnit" class="form-input" style="width:auto">
              <option value="1">秒</option>
              <option value="60" selected>分鐘</option>
              <option value="3600">小時</option>
            </select>
          </div>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">顯示內容</div>
            <div class="config-field-hint">每次到點從勾選項目隨機抽一則；至少勾一項才會推播</div>
          </div>
          <div style="display:flex;gap:var(--s3);flex-wrap:wrap">
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="notifyContentDue"> 今日到期</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="notifyContentWord"> 隨機字卡</label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="notifyContentGoal"> 今日進度</label>
          </div>
        </div>
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
          <button class="btn btn-sm btn-secondary" id="notifPermBtn">${icon('shield')} 授權</button>
        </div>
        <div id="notifPermStatus" style="margin-top:var(--s2);font-size:12px;color:var(--text-tertiary)"></div>
      </div>
    </div>
    ` : ''}

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
          <div class="section-title">${icon('book')} API</div>
          <div class="config-section">
            <div class="config-field-hint" style="margin-bottom:var(--s2)">詞典來源（韋氏 Key）＋ AI 接口（英中翻譯用）。金鑰分開存本機 DB，不上傳別處。<br>AI 接口可接<b>本地</b>（ollama）或<b>公開</b>（OpenAI 相容）—— 手機請填電腦的 tailnet 位址。</div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">Dictionary key</span>
              <input type="password" id="mwDictKeyInput" placeholder="Collegiate Dictionary key" value="${escapeAttr(s.state.mwDictKey || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">Thesaurus key</span>
              <input type="password" id="mwThesKeyInput" placeholder="Collegiate Thesaurus 或 Intermediate Thesaurus key（自動相容）" value="${escapeAttr(s.state.mwThesKey || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">API</span>
              <input type="text" id="llmApiUrlInput" placeholder="本地 http://100.x.y.z:11434 ／ 公開 https://api.openai.com/v1" value="${escapeAttr(s.state.llmApiUrl || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">模型</span>
              <input type="text" id="llmModelInput" placeholder="例 qwen2.5:14b（留空自動偵測）" value="${escapeAttr(s.state.llmModel || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <span style="font-size:12px;min-width:92px;color:var(--text-secondary)">格式</span>
              <select id="llmApiFormatInput" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
                <option value="ollama"${s.state.llmApiFormat === 'openai' ? '' : ' selected'}>ollama（本地）</option>
                <option value="openai"${s.state.llmApiFormat === 'openai' ? ' selected' : ''}>OpenAI 相容（公開）</option>
              </select>
              <input type="password" id="llmApiKeyInput" placeholder="公開 API 金鑰（本地留空）" value="${escapeAttr(s.state.llmApiKey || '')}" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
              <button class="btn btn-sm" id="mwKeysSaveBtn">${icon('check')} 儲存</button>
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