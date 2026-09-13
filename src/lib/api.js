import { invoke } from '@tauri-apps/api/core'
import { checkpoint } from './db.js'

// ─── CLI ─────────────────────────────────────────────────────
export const runCli = (args) =>
  invoke('run_cli', { args })

export const getAppPaths = () =>
  invoke('get_app_paths')

// ─── LLM / Network ─────────────────────────────────────
export const fetchLLM = (url, model, prompt, apiFormat) =>
  invoke('fetch_llm', { url, model, prompt, apiFormat })

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

export const webdavUpload = () =>
  invoke('webdav_upload')

export const webdavDownload = () =>
  invoke('webdav_download')

export const webdavLogout = () =>
  invoke('webdav_logout')
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
