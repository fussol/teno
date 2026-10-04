// ═══════════════════════════════════════════════════════════════
// Settings — Anki parameters, goals, deck management, word editing,
//            CSV import/export, data management.
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { withPageScope } from '../lib/scope-dom.js';
import { initCustomSelects } from '../lib/custom-select.js';   // G14: renderInPlace 重渲染後重建 custom-select

// KEEPALIVE1：本頁圖層根（預渲染後不再是 #pageContainer）


import { toast } from '../lib/toast.js';
import { speak } from '../lib/tts.js';
import pkg from '../../package.json';
import { ACCENTS, ACCENT_GROUPS } from '../lib/theme.js';
import { isAndroid, isWeb, downloadBlob, downloadBlobFromArray, pickFile } from '../lib/platform.js';
import { setLauncherIcon, exportDbDialog, exportDbData, exportDbToDownloads, importDbDialog, writeDbBytes, listBackups, backupDb, restoreBackup as apiRestoreBackup, exportBackupDialog as apiExportBackup, exportBackupData as apiExportBackupData, deleteBackup as apiDeleteBackup, importAppLogText as apiImportAppLogText, resetAppLogDb as apiResetAppLogDb, listPiperVoices, importPiperModelDialog, installPiperModel, deletePiperModel, listAndroidVoices, webdavStatus, webdavUpload, webdavDownload, webdavMediaUpload, webdavMediaDownload, webdavPatchUpload, webdavPatchDownload, webdavLogArchiveStatus, webdavLogArchiveUpload, webdavLogArchivePrune, webdavLogout, webdavServerGetConfig, webdavServerSaveConfig, webdavServerStart, webdavServerStop, webdavServerStatus, webdavCloudList, webdavCloudDelete, webdavServerListLocal, webdavServerDeleteLocal, widgetGetStatus, widgetSaveConfig, widgetRefresh, widgetRequestPerms } from '../lib/api.js';
import { renderContent as renderImportContent, onMount as onMountImport } from './import.js';
import { renderContent as renderExportContent, onMount as onMountExport } from './export.js';
import { renderContent as renderTagContent, onMount as onMountTag } from './tag-manager.js';
import { ICON_PRESETS } from '../lib/icon-presets.js';
import { clampLearnAhead, UI_SCALE_LABELS } from '../lib/store.js';
import { FIELD_LABELS, FIELD_KEYS, FIELD_STUDY_ONLY } from '../lib/word-extra.js';
import { pageRoot, escapeHtml, _ankiMode, setAnkiMode } from './settings/_shared.js';
import { renderSettingsContent } from './settings/sections.js';
import { bindWebdavSyncPage } from './settings/webdav.js';
import { runExportDb, runImportDb, showBackups } from './settings/backup.js';
import { bindDeckManager, renderDeckManager, renderFilteredDecks } from './settings/deck-manager.js';
import { setSetting } from '../lib/db.js';

// 欄位顯示三組（設定頁 master）：瀏覽器字卡正面／背面＋學習測驗共用


// ─── 模組級狀態 ───
 // 'flip' | 'mc' | 'spell'





export function render(s) {
  return renderSettingsContent(s);
}



const COLLAPSE_KEY = 'teno-settings-collapsed';
function _collapseKeyOf(titleEl) {
  const t = (titleEl?.textContent || '').replace(/\s+/g, '').slice(0, 24);
  return t || 'untitled';
}
function _loadCollapsedSet() {
  try {
    const a = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
    if (Array.isArray(a)) return new Set(a);
  } catch (_) {}
  return null; // 首次：全部收起（只留標題）
}
function _saveCollapsedSet(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch (_) {}
}
/** 把一個 section 設為收合／展開，並同步 aria-expanded */
function _setCollapsed(sec, collapsed) {
  sec.classList.toggle('collapsed', collapsed);
  const t = sec.querySelector(':scope > .section-title')
    || sec.querySelector(':scope > .section-header .section-title');
  t?.setAttribute('aria-expanded', String(!collapsed));
}
/** 由 DOM 現況導出收合集合（單一真相：class，不靠點擊歷程累積） */
function _collapsedSetFromDom(sections) {
  return new Set(sections.filter(s => s.classList.contains('collapsed'))
    .map(s => s.dataset.collapseKey).filter(Boolean));
}
function bindCollapsibleSections() {
  const container = pageRoot();
  if (!container) return;
  // 頂層 section：沒有 .section 祖先（排除匯入／匯出／標籤內嵌的子 section）
  const sections = [...container.querySelectorAll('.section')]
    .filter(el => !(el.parentElement && el.parentElement.closest('.section')));
  if (!sections.length) return;
  let collapsed = _loadCollapsedSet();
  const firstRun = collapsed === null;
  if (firstRun) collapsed = new Set();
  sections.forEach(sec => {
    const head = sec.querySelector(':scope > .section-header');
    const titleEl = sec.querySelector(':scope > .section-title')
      || head?.querySelector('.section-title');
    if (!titleEl) return;
    const key = _collapseKeyOf(titleEl);
    sec.dataset.collapseKey = key;
    sec.classList.add('collapsible');
    const isCollapsed = firstRun ? true : collapsed.has(key);
    _setCollapsed(sec, isCollapsed);
    const clickTarget = head || titleEl;
    if (clickTarget.dataset.collapseBound) return;
    clickTarget.dataset.collapseBound = '1';
    clickTarget.addEventListener('click', (e) => {
      // 標題列裡的按鈕／輸入（字本管理的新增字本等）點了只做自己的事，不觸發收合
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      const willExpand = sec.classList.contains('collapsed');
      // ACCORDION1：展開新的之前，先把其他全部收合（最多一個展開）
      if (willExpand) {
        sections.forEach(other => { if (other !== sec) _setCollapsed(other, true); });
      }
      _setCollapsed(sec, !willExpand);
      _saveCollapsedSet(_collapsedSetFromDom(sections));
    });
  });
  // 舊 localStorage 可能存了「多個展開」→ 載入時強制收斂成最多一個
  const expanded = sections.filter(s => !s.classList.contains('collapsed'));
  if (expanded.length > 1) expanded.slice(1).forEach(s => _setCollapsed(s, true));
  if (firstRun || expanded.length > 1) {
    _saveCollapsedSet(_collapsedSetFromDom(sections));
  }
}

/** KEEPALIVE1：包一層把 onMount 內的全域查詢限制在本頁圖層內（見 lib/scope-dom.js） */
export function onMount(s) {
  return withPageScope(pageRoot(), () => _mount(s));
}
function _mount(s) {
  bindCollapsibleSections();
  const modelList = document.getElementById('piperModelList');
  if (modelList) modelList.innerHTML = '';

  const updateVoices = (voices) => {
    const group = document.getElementById('ttsVoiceGroup');
    if (!group) return;
    if (!voices || !voices.length) {
      group.innerHTML = `<span style="color:var(--text-secondary);font-size:13px">${isAndroid || isWeb ? '無可用語音' : '無可用語音，請匯入模型'}</span>`;
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
  } else if (isWeb) {
    // 網站版語音清單 = 瀏覽器 speechSynthesis（voices 常需等載入事件）
    const fillWebVoices = () => {
      const vs = (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : []) || [];
      updateVoices(vs.map(v => v.name));
    };
    fillWebVoices();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', fillWebVoices);
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
  // DICTREBUILD：同一顆按鈕一併存 AI API 設定（位址／模型／格式／金鑰）
  document.getElementById('mwKeysSaveBtn')?.addEventListener('click', async () => {
    const dk = (document.getElementById('mwDictKeyInput')?.value || '').trim();
    const tk = (document.getElementById('mwThesKeyInput')?.value || '').trim();
    const au = (document.getElementById('llmApiUrlInput')?.value || '').trim();
    const am = (document.getElementById('llmModelInput')?.value || '').trim();
    const af = document.getElementById('llmApiFormatInput')?.value === 'openai' ? 'openai' : 'ollama';
    const ak = (document.getElementById('llmApiKeyInput')?.value || '').trim();
    try {
      await setSetting('mwDictKey', dk); await setSetting('mwThesKey', tk);
      await setSetting('llmApiUrl', au); await setSetting('llmModel', am);
      await setSetting('llmApiFormat', af); await setSetting('llmApiKey', ak);
    } catch (_) {}
    s.state.mwDictKey = dk; s.state.mwThesKey = tk;
    s.state.llmApiUrl = au; s.state.llmModel = am;
    s.state.llmApiFormat = af; s.state.llmApiKey = ak;
    toast(dk || tk ? '設定已儲存' : '設定已清除', 'toast-success');
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
      try { await setSetting('launcherIcon', key); } catch { /* 非 Tauri 環境可忽略 */ }
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
      await setSetting('exampleDisplayMax', String(val));
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
        for (const c of ctxs) {
          const key = 'fieldVis' + c[0].toUpperCase() + c.slice(1);
          await setSetting(key, JSON.stringify(vals));
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

  bindWebdavSyncPage(s);

  // ─── WIDGET1：桌面 Widget／提醒通知（Android；設定即存→Kotlin 重武裝鬧鐘）───
  (function bindWidget() {
    if (!isAndroid) return;
    const rot = document.getElementById('widgetRotate');
    if (!rot) return;
    const nOn = document.getElementById('widgetNotifyOn');
    const nInt = document.getElementById('widgetNotifyInterval');
    const cDue = document.getElementById('notifyContentDue');
    const cWord = document.getElementById('notifyContentWord');
    const cGoal = document.getElementById('notifyContentGoal');
    const res = document.getElementById('widgetResident');
    const wEl = document.getElementById('widgetPermStatus');
    const nEl = document.getElementById('notifPermStatus');
    let loaded = false;
    const collect = () => ({
      rotateMin: parseInt(rot.value, 10) || 60,
      notifyOn: !!nOn.checked,
      notifyIntervalMin: Math.min(1440, Math.max(1, parseInt(nInt.value, 10) || 60)),
      notifyDue: !!cDue.checked,
      notifyWord: !!cWord.checked,
      notifyGoal: !!cGoal.checked,
      residentOn: !!res.checked,
    });
    // 狀態字串分兩區：widget 區看 DB／精確鬧鐘；通知區看通知權限
    const wText = (st) => {
      if (!st?.supported) return '';
      const parts = [];
      parts.push(st.dbOk ? 'DB 就緒' : 'DB 尚未建立（先開一次 App）');
      if (!st.exactAlarmOk) parts.push('精確鬧鐘未授權 → 換字間隔可能延遲');
      return parts.join('　');
    };
    const nText = (st) => {
      if (!st?.supported) return '';
      return st.notifGranted ? '通知權限 ✓' : '通知未授權（按「授權」）';
    };
    const paint = (st) => {
      if (wEl) wEl.textContent = wText(st);
      if (nEl) nEl.textContent = nText(st);
    };
    (async () => {
      try {
        const st = await widgetGetStatus();
        if (!st?.supported) return;
        if (st.rotateMin) rot.value = String(st.rotateMin);
        nOn.checked = !!st.notifyOn;
        nInt.value = String(st.notifyIntervalMin ?? 60);
        cDue.checked = st.notifyDue !== false;
        cWord.checked = st.notifyWord !== false;
        cGoal.checked = st.notifyGoal !== false;
        res.checked = !!st.residentOn;
        paint(st);
      } catch (e) { console.warn('[widget] status:', e); }
      loaded = true;
    })();
    const save = async () => {
      if (!loaded) return;   // 初值回填完成前不寫（避免把預設蓋掉）
      try {
        const st = await widgetSaveConfig(collect());
        paint(st);
      } catch (e) { console.warn('[widget] save:', e); }
    };
    for (const el of [rot, nOn, nInt, cDue, cWord, cGoal, res]) el.addEventListener('change', save);
    document.getElementById('widgetRefreshBtn')?.addEventListener('click', async () => {
      try { await widgetRefresh(); toast('Widget 已刷新'); }
      catch (e) { console.warn('[widget] refresh:', e); toast('Widget 刷新失敗'); }
    });
    // 兩顆「授權」鈕走同命令（一次要通知＋精確鬧鐘），狀態字串各區各顯示
    const requestPerms = async () => {
      try { paint(await widgetRequestPerms()); }
      catch (e) { console.warn('[widget] perms:', e); }
    };
    document.getElementById('widgetPermBtn')?.addEventListener('click', requestPerms);
    document.getElementById('notifPermBtn')?.addEventListener('click', requestPerms);
  })();

  // ── Anki 模式分頁 ──
  document.querySelectorAll('.study-mode-tab[data-anki-mode]').forEach(el => {
    el.addEventListener('click', () => {
      setAnkiMode(el.dataset.ankiMode);
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
      await setSetting('backupIntervalH', h);
      await setSetting('backupKeepMax', n);
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
export function renderInPlace(s) {
  const container = pageRoot();
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




