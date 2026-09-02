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

export const scrapeQuizlet = (url) =>
  invoke('scrape_quizlet', { url })

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
export const backupDb = async () => {
  await checkpoint()
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

// ─── Database / Export ─────────────────────────────────
export const importDbDialog = () =>
  invoke('import_db_dialog')

export const writeDbBytes = (buf) =>
  invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) })

export const exportDbDialog = (includeLog = true) =>
  invoke('export_db_dialog', { includeLog })

export const exportCsvDialog = (csv, filename) =>
  invoke('export_csv_dialog', { csv, filename })

// ─── Android export (returns data for Blob download) ──
export const exportDbData = (includeLog = true) =>
  invoke('export_db_data', { includeLog })

export const exportBackupData = (filename) =>
  invoke('export_backup_data', { filename })

// ─── Google Drive Sync ───────────────────────────────
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
