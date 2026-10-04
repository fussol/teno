import { invoke } from '@tauri-apps/api/core'
import { checkpoint } from './db.js'

// ─── CLI ─────────────────────────────────────────────────────
export const runCli = (args) =>
  invoke('run_cli', { args })

export const getAppPaths = () =>
  invoke('get_app_paths')

// ─── LLM / Network ─────────────────────────────────────
/**
 * DICTREBUILD：把使用者填的位址正規化成實際端點。
 *   'ollama' → {base}/api/generate
 *   'openai' → {base}/chat/completions
 * 已是完整端點時原樣沿用。
 */
export const buildLlmEndpoint = (base, format) => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (format === 'openai') {
    if (/\/chat\/completions$/.test(b)) return b;
    return b.replace(/\/api\/generate$/, '') + '/chat/completions';
  }
  if (/\/api\/generate$/.test(b)) return b;
  return b.replace(/\/chat\/completions$/, '') + '/api/generate';
};

/**
 * 本地／公開 AI API 的**單一解析點**。
 *
 * 全 app 有 19 個呼叫點，全都傳 `${baseUrl}/api/generate`（ollama 慣例）與模型名。
 * 為了不動那 19 處，端點／模型／格式／金鑰一律在此解析：
 *   設定有填 → 以設定為準（可指向本地 ollama 或公開 OpenAI 相容 API）
 *   設定留空 → 完全沿用呼叫端傳入的值（與改動前行為逐字相同）
 */
export const fetchLLM = async (url, model, prompt, apiFormat, messages) => {
  let cfg = null;
  try {
    const { getSetting } = await import('./db.js');
    const [u, m, f, k] = await Promise.all([
      getSetting('llmApiUrl'), getSetting('llmModel'),
      getSetting('llmApiFormat'), getSetting('llmApiKey'),
    ]);
    cfg = {
      url: String(u || '').trim(),
      model: String(m || '').trim(),
      format: f === 'openai' ? 'openai' : 'ollama',
      key: String(k || '').trim(),
    };
  } catch (_) { cfg = null; }   // 非 Tauri（CLI/web-demo）→ 沿用呼叫端傳入值
  const override = !!cfg && (cfg.url !== '' || cfg.key !== '' || cfg.format === 'openai');
  // messages 省略時 undefined 會被 JSON.stringify 拔掉 → Rust 端 Option 收 None → 走單輪舊路徑
  if (!override) return invoke('fetch_llm', { url, model, prompt, apiFormat, messages });
  return invoke('fetch_llm', {
    url: buildLlmEndpoint(cfg.url || 'http://localhost:11434', cfg.format),
    model: cfg.model || model,
    prompt,
    apiFormat: cfg.format,
    apiKey: cfg.key,
    messages,
  });
};

// 抽 LLM 回覆裡的批改 JSON：```json 區塊／尾段裸 JSON → 逗號清理 → 依未閉合堆疊補尾括號
// （qwen 系常吐 }} 漏掉 ]，實測 3/3 必現），全敗回 null 由呼叫端報錯
export const parseLLMJson = (raw, key = 'results') => {
  const blocks = [...raw.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]);
  const tail = raw.match(new RegExp('\\{\\s*"' + key + '"[\\s\\S]*'));
  const cands = [...(tail ? [tail[0]] : []), ...blocks];
  for (let i = cands.length - 1; i >= 0; i--) {
    const cleaned = cands[i].replace(/\s*`+\s*$/, '').replace(/,\s*([}\]])/g, '$1');
    // 修復行走：qwen 常漏中間的 ]（吐 }} 應為 }] }）——缺的括號就地補，收尾補齊未閉合
    const stack = [];
    let out = '';
    let inStr = false;
    let esc = false;
    let bad = false;
    for (const ch of cleaned) {
      if (inStr) {
        out += ch;
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; out += ch; continue; }
      if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); out += ch; continue; }
      if (ch === '}' || ch === ']') {
        if (stack[stack.length - 1] === ch) { stack.pop(); out += ch; continue; }
        const at = stack.lastIndexOf(ch);   // 模型跳過了上層括號 → 就地補齊它們
        if (at === -1) { bad = true; out += ch; continue; }
        for (let k = stack.length - 1; k > at; k--) out += stack.pop();
        stack.pop();   // 自己那層（at）由 out += ch 收掉，不可重複
        out += ch;
        continue;
      }
      out += ch;
    }
    if (bad) continue;
    out += stack.reverse().join('');
    try { return JSON.parse(out); } catch { /* 下一個候選 */ }
  }
  return null;
};

export const fetchGet = (url) =>
  invoke('fetch_get', { url })

// ─── Scraping ──────────────────────────────────────────
export const lookupCambridge = (word, lang) =>
  invoke('lookup_cambridge', { word, lang })

// D段：韋氏官方 JSON API（collegiate＋thesaurus；key 自備存設定頁）
export const lookupMerriam = (word, dictKey, thesKey) =>
  invoke('lookup_merriam', { word, dictKey, thesKey })

export const scrapeQuizlet = (url) =>
  invoke('scrape_quizlet', { url })

// ─── Anki .apkg 匯入 ─────────────────────────────────────
export const inspectApkgDialog = () =>
  invoke('inspect_apkg_dialog')

export const getApkgMedia = (filename, token) =>
  invoke('get_apkg_media', token ? { filename, token } : { filename }) // F-RACE1: 帶 token 精確取圖；舊相容省略即退回掃描

// ─── SHAREPACK1: 單字套含圖打包（words.csv＋media/＋manifest.json）───
export const exportSharePack = (csv, filename, wordIds) =>
  invoke('export_share_pack', { csv, filename, wordIds })

export const importSharePackDialog = () =>
  invoke('import_share_pack_dialog')

export const getShareMedia = (filename, token) =>
  invoke('get_share_media', token ? { filename, token } : { filename })

// ─── MEDIAPEEL1: 媒體庫（content-addressed；sha1 優先，缺檔回退 DB）───
export const mediaPut = (data, filename) =>
  invoke('media_put', { data, filename: filename || '' })
export const mediaGet = (sha, ext) =>
  invoke('media_get', { sha, ext: ext || '' })
export const mediaList = () =>
  invoke('media_list')
export const webdavMediaUpload = () =>
  invoke('webdav_media_upload')
export const webdavMediaDownload = () =>
  invoke('webdav_media_download')
export const webdavPatchUpload = () =>
  invoke('webdav_patch_upload')
export const webdavPatchDownload = () =>
  invoke('webdav_patch_download')
export const webdavLogArchiveStatus = () =>
  invoke('webdav_log_archive_status')
export const webdavLogArchiveUpload = () =>
  invoke('webdav_log_archive_upload')
export const webdavLogArchivePrune = () =>
  invoke('webdav_log_archive_prune')

// ─── TTS ───────────────────────────────────────────────
export const speakText = (text, opts = {}) => {
  const { speed = 1, voice = 'en_US-ryan-high', pitch } = opts
  return invoke('speak_text', {
    text,
    voice,
    pitch: pitch ?? 50,
    lengthScale: Math.max(0.3, Math.min(3, 1.0 / Math.max(0.3, speed) * 0.9)),
    noiseScale: 0.667,
  })
}

export const speakAndroid = (text, opts = {}) => {
  const { speed = 1, voice = '' } = opts
  return invoke('speak_android', { text, voice, speed })
}

export const stopAndroid = () =>
  invoke('stop_android')

/** 切換 launcher icon（Android activity-alias；非 Android 為 no-op） */
export const setLauncherIcon = (name) =>
  invoke('set_launcher_icon', { name })

/** 查目前使用的 launcher icon key（Android；非 Android 回 original） */
export const getLauncherIcon = () =>
  invoke('get_launcher_icon')

/** 重置 app-log.db（操作日誌 DB 損壞時刪檔重建；teno.db 不受影響） */
export const resetAppLogDb = () =>
  invoke('reset_app_log')

export const listAndroidVoices = () =>
  invoke('list_voices_android')

export const listPiperVoices = () =>
  invoke('list_piper_voices')

export const importPiperModelDialog = () =>
  invoke('import_piper_model_dialog')

export const installPiperModel = (url) =>
  invoke('install_piper_model', { url })

export const deletePiperModel = (name) =>
  invoke('delete_piper_model', { name })

// ─── DB-TX1: 單連線真交易 ─────────────────────────────────
// 為什麼需要：plugin-sql 的 execute 走 sqlx Pool（max_connections=10），
//   多次 execute 組出的 BEGIN…COMMIT **不保證同一條連線** →
//   BEGIN 開在 A、迴圈語句落在 B、COMMIT 又另一條 → A 的交易懸置並握死寫鎖。
//   實測後果：264 筆寫入失敗、最長鎖死 2 小時 11 分（含 29 筆複習靜默丟失）。
// 故：JS 端一律不再自己組交易，整批交給 Rust 在單一連線上以 BEGIN IMMEDIATE 執行。
// statements: [{ sql: string, params?: any[] }] → 回傳受影響列數
export const sqlTx = (statements) =>
  invoke('sql_tx', { statements })

// ─── Backup ────────────────────────────────────────────
// D5-SR1: 先 WAL checkpoint（WAL 內最新交易合併回主檔）再 backup，備份完整不漏最近複習
// LOG-BACKUP1: 主庫＋日誌庫雙 checkpoint——patch 讀的是 app-log.db 檔，WAL 沒併入會漏行
export const backupDb = async () => {
  await checkpoint()
  try {
    const { checkpointAppLog } = await import('./app-log.js');
    await checkpointAppLog();
  } catch (_) {}
  return invoke('backup_db')
}

export const listBackups = () =>
  invoke('list_backups')

export const restoreBackup = (filename) =>
  invoke('restore_backup', { filename })

export const deleteBackup = (filename) =>
  invoke('delete_backup', { filename })

export const exportBackupDialog = (filename) =>
  invoke('export_backup_dialog', { filename })

export const pruneBackups = (maxCount) =>
  invoke('prune_backups', { maxCount })

export const getDbMtime = () =>
  invoke('get_db_mtime')

// LOG-BACKUP1: app-log.db mtime（自動備份變更偵測取兩庫 max）
export const getAppLogMtime = () =>
  invoke('get_app_log_mtime')

// ─── Database / Export ─────────────────────────────────
export const importDbDialog = () =>
  invoke('import_db_dialog')

export const exportDbDialog = () =>
  invoke('export_db_dialog')

export const exportCsvDialog = (csv, filename) =>
  invoke('export_csv_dialog', { csv, filename })

// ─── Android export (returns data for Blob download) ──
export const exportDbData = () =>
  invoke('export_db_data')

// EXPORTBIG1: Android 大檔直寫 Downloads（Rust 打包＋Kotlin 流式寫檔，零位元組過
// IPC/WebView；20MB+ 必走這條；回傳檔名＋大小字串）
export const exportDbToDownloads = (filename) =>
  invoke('export_db_to_downloads', { filename })

// B段：捆包匯出（teno.db＋app-log.db TENOC 容器；呼叫端先雙 checkpoint＋大小守門）
export const exportDbBundleData = () =>
  invoke('export_db_bundle_data')

export const exportBundleDialog = () =>
  invoke('export_bundle_dialog')

// devMode 限定：操作日誌 → 文字檔（ts ISO | level | message）
export const exportAppLogText = () =>
  invoke('export_app_log_text')

// 操作日誌 ← 文字檔（匯出格式逆操作；去重併入，回傳 {log_added,log_skipped,sim_added,sim_skipped,bad_lines}）
export const importAppLogText = (text) =>
  invoke('import_app_log_text', { text })

export const exportBackupData = (filename) =>
  invoke('export_backup_data', { filename })

// ─── WebDAV Sync（同 LAN／Tailscale 自建空間；帳密存一次，之後自動帶）───
export const webdavSaveConfig = (url, username, password) =>
  invoke('webdav_save_config', { url, username, password })

export const webdavStatus = () =>
  invoke('webdav_status')

export const webdavTest = () =>
  invoke('webdav_test')

export const webdavUpload = (force) =>
  invoke('webdav_upload', force ? { force: true } : {})

export const webdavDownload = (force) =>
  invoke('webdav_download', force ? { force: true } : {})

export const webdavLogout = () =>
  invoke('webdav_logout')

// ─── 內嵌本地雲（WEBDAV-EMBED1：桌機跟著 Teno 起；手機走 Termux 獨立版）───
export const webdavServerGetConfig = () =>
  invoke('webdav_server_get_config')

export const webdavServerSaveConfig = (port, username, password, autostart) =>
  invoke('webdav_server_save_config', { port, username, password, autostart })

export const webdavServerStart = () =>
  invoke('webdav_server_start')

export const webdavServerStop = () =>
  invoke('webdav_server_stop')

export const webdavServerStatus = () =>
  invoke('webdav_server_status')

// ─── 雲端檔案瀏覽 CLOUDBROWSE1（免開瀏覽器；本機直讀＋遠端 PROPFIND）───
export const webdavCloudList = (path) =>
  invoke('webdav_cloud_list', path ? { path } : {})
export const webdavCloudDelete = (path) =>
  invoke('webdav_cloud_delete', { path })
export const webdavCloudGet = (path) =>
  invoke('webdav_cloud_get', { path })
export const webdavServerListLocal = (path) =>
  invoke('webdav_server_list_local', path ? { path } : {})
export const webdavServerDeleteLocal = (path) =>
  invoke('webdav_server_delete_local', { path })
export const driveSaveCreds = (clientId, clientSecret) =>
  invoke('drive_save_creds', { clientId, clientSecret })

export const driveOAuth = () =>
  invoke('drive_oauth')

export const driveUpload = () =>
  invoke('drive_upload')

export const driveDownload = () =>
  invoke('drive_download')

export const driveStatus = () =>
  invoke('drive_status')

export const driveLogout = () =>
  invoke('drive_logout')

export const optimizeFsrs = (reviews) =>
  invoke('optimize_fsrs', { reviews })

// ─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1, 對齊 Anki 26.08) ───
// mode: 'simulate' | 'workload' | 'optimal'
export const simulateFsrs = (req) =>
  invoke('simulate_fsrs', { req })

// ─── 桌面 Widget 與通知（Android 原生 AppWidget；桌面端回 supported:false）───
export const widgetGetStatus = () =>
  invoke('widget_get_status')

export const widgetSaveConfig = (cfg) =>
  invoke('widget_save_config', { cfg })

export const widgetRefresh = () =>
  invoke('widget_refresh')

export const widgetRequestPerms = () =>
  invoke('widget_request_perms')

// WEB-SERVE：網站版匯入三件套（瀏覽器選檔 → bytes；桌面仍走 dialog，不 import 亦可）
export const writeDbBytes = (data) =>
  invoke('write_db_bytes', { data });

export const importSharePackBytes = (data, fileName) =>
  invoke('import_share_pack_bytes', { data, fileName });

export const inspectApkgData = (data, fileName) =>
  invoke('inspect_apkg_data', { data, fileName });
