# API 調用系統化整理 — 改動記錄

## 概述

將原本散落在 8 個檔案中的動態 `import('@tauri-apps/api/core')` + `invoke()` 呼叫，集中到單一 `src/lib/api.js`，各頁面改從 `api.js` 靜態 import。同時修正 `speak_text` 的參數對應 bug（JS 傳了 `speed`/`pitch` 但 Rust 吃 `length_scale`/`noise_scale`）。

---

## 1. 新增 `src/lib/api.js`

**路徑：** `src/lib/api.js`
**狀態：** 全新檔案

```javascript
import { invoke } from '@tauri-apps/api/core'

// ─── LLM / Network ─────────────────────────────────────
export const fetchLLM = (url, model, prompt, apiFormat) =>
  invoke('fetch_llm', { url, model, prompt, apiFormat })

export const fetchGet = (url) =>
  invoke('fetch_get', { url })

// ─── Scraping ──────────────────────────────────────────
export const lookupCambridge = (word) =>
  invoke('lookup_cambridge', { word })

export const scrapeQuizlet = (url) =>
  invoke('scrape_quizlet', { url })

// ─── TTS ───────────────────────────────────────────────
export const speakText = (text, opts = {}) => {
  const { speed = 1, voice = 'en-us', pitch = 50 } = opts
  return invoke('speak_text', {
    text,
    voice,
    lengthScale: Math.max(0.3, Math.min(3, speed)),
    noiseScale: Math.max(0, Math.min(1, pitch / 99))
  })
}

export const checkTtsEngines = () =>
  invoke('check_tts_engines')

// ─── Backup ────────────────────────────────────────────
export const backupDb = () =>
  invoke('backup_db')

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

export const backupNow = async () => {
  await getDbMtime()
  await backupDb()
  await pruneBackups(100)
}

// ─── Database / Export ─────────────────────────────────
export const writeDbBytes = (buf) =>
  invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) })

export const exportDbDialog = () =>
  invoke('export_db_dialog')

export const exportCsvDialog = (csv, filename) =>
  invoke('export_csv_dialog', { csv, filename })
```

**作用：** 所有 `invoke()` 的唯一入口。其他檔案不再直接呼叫 `invoke()`，全部透過此模組的 named export。

**關鍵修正：**
- `speakText` 將 JS 端的 `speed`（預設 1）對應到 Rust 的 `lengthScale`，並 clamp 到 0.3–3.0
- `speakText` 將 JS 端的 `pitch`（預設 50，範圍 0–99）對應到 Rust 的 `noiseScale`（`pitch / 99`，clamp 到 0.0–1.0）
- `writeDbBytes` 自動將 `ArrayBuffer` / `Uint8Array` 轉為 `Array.from(new Uint8Array(buf))`
- `pruneBackups` 使用 camelCase `maxCount`（Tauri 自動轉 snake_case）

---

## 2. 修改 `src/lib/tts.js`

### 2a. 取代動態 import（第 1–4 行）

**改前：**
```javascript
// TTS — Native TTS via Tauri command (espeak-ng), fallback to Web Speech API.

let _enVoice = null;
let _hasNative = null;
```

**改後：**
```javascript
// TTS — Piper TTS via Tauri command, fallback to Web Speech API.

import { speakText as nativeSpeak } from './api.js'

let _enVoice = null;
let _hasNative = null;
```

**作用：** 靜態 import `api.js` 的 `speakText`（alias 為 `nativeSpeak`），不再動態 import invoke。

### 2b. 取代 invoke（第 33–44 行）

**改前：**
```javascript
async function speakAsync(text, speed, voice, pitch) {
  if (_hasNative !== false) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('speak_text', { text, speed, voice, pitch });
      _hasNative = true;
      return;
    } catch (e) {
```

**改後：**
```javascript
async function speakAsync(text, speed, voice, pitch) {
  if (_hasNative !== false) {
    try {
      await nativeSpeak(text, { speed, voice, pitch });
      _hasNative = true;
      return;
    } catch (e) {
```

**作用：** 改用 `nativeSpeak`（來自 `api.js`），參數傳遞 `{ speed, voice, pitch }`，由 `api.js` 的 `speakText` 負責 mapping 為 Rust 接受的 `lengthScale` / `noiseScale`。

---

## 3. 修改 `src/lib/backup-scheduler.js`

### 3a. 加入靜態 import（第 1–4 行）

**改前：**
```javascript
let timer = null;
let lastBackupMtime = 0;
const INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 100;
```

**改後：**
```javascript
import { getDbMtime, backupDb, pruneBackups } from './api.js'

let timer = null;
let lastBackupMtime = 0;
const INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 100;
```

### 3b. 取代動態 import + invoke（第 21–35 行）

**改前：**
```javascript
async function tick() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // ponytail: checkpoint flushes WAL so mtime reflects real changes
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    const mtime = await invoke('get_db_mtime');
    if (mtime <= lastBackupMtime) return;
    await invoke('backup_db');
    await invoke('prune_backups', { maxCount: MAX_BACKUPS });
    lastBackupMtime = mtime;
  } catch (e) {
    console.warn('[auto-backup]', e);
  }
}
```

**改後：**
```javascript
async function tick() {
  try {
    // ponytail: checkpoint flushes WAL so mtime reflects real changes
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    const mtime = await getDbMtime();
    if (mtime <= lastBackupMtime) return;
    await backupDb();
    await pruneBackups(MAX_BACKUPS);
    lastBackupMtime = mtime;
  } catch (e) {
    console.warn('[auto-backup]', e);
  }
}
```

**作用：** 刪除 `const { invoke } = await import('@tauri-apps/api/core')`，改用靜態 import 的 `getDbMtime()` / `backupDb()` / `pruneBackups()`。

---

## 4. 修改 `src/pages/import.js`

### 4a. 加入靜態 import（第 1–3 行）

**改前：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
```

**改後：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { scrapeQuizlet } from '../lib/api.js';
```

### 4b. 取代 invoke（第 507–508 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const cards = await invoke('scrape_quizlet', { url });
```

**改後：**
```javascript
  try {
    const cards = await scrapeQuizlet(url);
```

**作用：** 改為直接呼叫 `scrapeQuizlet(url)`。

---

## 5. 修改 `src/pages/export.js`

### 5a. 加入靜態 import（第 1–4 行）

**改前：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { buildCSV } from '../core/import.js';
```

**改後：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { buildCSV } from '../core/import.js';
import { exportCsvDialog, exportDbDialog, writeDbBytes } from '../lib/api.js';
```

### 5b. 取代 export_csv_dialog 呼叫（第 81–87 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('export_csv_dialog', { csv, filename: fname });
    toast(`已匯出 ${filtered.length} 詞 → ${path}`, 'toast-success');
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

async function runExportDb() {
  try {
    const d = await import('../lib/db.js');
    try {
      const ev = localStorage.getItem('humanEvents');
      if (ev) await d.setSetting('_backup_humanEvents', ev);
      const pf = localStorage.getItem('humanProfile');
      if (pf) await d.setSetting('_backup_humanProfile', pf);
    } catch (_) {}
    await d.checkpoint();
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('export_db_dialog');
    toast(`資料庫已匯出 → ${path}`, 'toast-success');
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}
```

**改後：**
```javascript
  try {
    const path = await exportCsvDialog(csv, fname);
    toast(`已匯出 ${filtered.length} 詞 → ${path}`, 'toast-success');
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

async function runExportDb() {
  try {
    const d = await import('../lib/db.js');
    try {
      const ev = localStorage.getItem('humanEvents');
      if (ev) await d.setSetting('_backup_humanEvents', ev);
      const pf = localStorage.getItem('humanProfile');
      if (pf) await d.setSetting('_backup_humanProfile', pf);
    } catch (_) {}
    await d.checkpoint();
    const path = await exportDbDialog();
    toast(`資料庫已匯出 → ${path}`, 'toast-success');
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}
```

### 5c. 取代 write_db_bytes 呼叫（第 120–122 行）

**改前：**
```javascript
      await d.checkpoint();
      await d.closeDB();
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) });
```

**改後：**
```javascript
      await d.checkpoint();
      await d.closeDB();
      await writeDbBytes(buf);
```

---

## 6. 修改 `src/pages/settings.js`

### 6a. 加入靜態 import（第 6–11 行）

**改前：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { speak } from '../lib/tts.js';
import { ACCENTS, ACCENT_GROUPS } from '../lib/theme.js';
import { closeDB } from '../lib/db.js';
```

**改後：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { speak } from '../lib/tts.js';
import { ACCENTS, ACCENT_GROUPS } from '../lib/theme.js';
import { closeDB } from '../lib/db.js';
import { exportDbDialog, writeDbBytes, listBackups, backupDb, restoreBackup as apiRestoreBackup, exportBackupDialog as apiExportBackup, deleteBackup as apiDeleteBackup } from '../lib/api.js';
```

**作用：** 因 settings.js 內有同名 local function `restoreBackup`、`exportBackup`、`deleteBackup`，故使用 `as` alias 避免衝突。local function 保留原名，內部呼叫 `api*` 版本。

### 6b. 取代 export_db_dialog 呼叫（第 324–325 行）

**改前：**
```javascript
    await d.checkpoint();
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('export_db_dialog');
```

**改後：**
```javascript
    await d.checkpoint();
    const path = await exportDbDialog();
```

### 6c. 取代 write_db_bytes 呼叫（第 345–347 行）

**改前：**
```javascript
      await d.checkpoint();
      await d.closeDB();
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) });
```

**改後：**
```javascript
      await d.checkpoint();
      await d.closeDB();
      await writeDbBytes(buf);
```

### 6d. 取代 list_backups 呼叫（第 366–367 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const list = await invoke('list_backups');
```

**改後：**
```javascript
  try {
    const list = await listBackups();
```

### 6e. 取代 backup_db + restore_backup 呼叫（第 407–411 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Auto-backup current DB first
    await invoke('backup_db');
    await invoke('restore_backup', { filename });
```

**改後：**
```javascript
  try {
    // Auto-backup current DB first
    await backupDb();
    await apiRestoreBackup(filename);
```

### 6f. 取代 export_backup_dialog 呼叫（第 420–422 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('export_backup_dialog', { filename });
```

**改後：**
```javascript
  try {
    const path = await apiExportBackup(filename);
```

### 6g. 取代 delete_backup 呼叫（第 430–433 行）

**改前：**
```javascript
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_backup', { filename });
```

**改後：**
```javascript
  try {
    await apiDeleteBackup(filename);
```

---

## 7. 修改 `src/pages/tools.js`

### 7a. 加入靜態 import（第 1–3 行）

**改前：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
```

**改後：**
```javascript
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { fetchGet, fetchLLM, lookupCambridge } from '../lib/api.js';
```

### 7b. 取代 detectModel 內的 fetch_get（第 242–245 行）

**改前：**
```javascript
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      el.innerHTML = `<div>偵測 Ollama 模型...</div>`;
      const resp = await invoke('fetch_get', { url: `${baseUrl}/api/tags` });
```

**改後：**
```javascript
    try {
      el.innerHTML = `<div>偵測 Ollama 模型...</div>`;
      const resp = await fetchGet(`${baseUrl}/api/tags`);
```

### 7c. 取代 __genExamplesLLM 內的動態 import + fetch_llm（第 335–351 行）

**改前：**
```javascript
    const { baseUrl, model } = llm;
    const { invoke } = await import('@tauri-apps/api/core');

    if (noExample.length === 0) {
      ...
    }

    const taskId = 'gen-examples-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生例句', noExample.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noExample.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const sentence = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model, prompt: `Generate a simple English example sentence using the word "${w.word}". Return ONLY the sentence, nothing else.` });
```

**改後：**
```javascript
    const { baseUrl, model } = llm;

    if (noExample.length === 0) {
      ...
    }

    const taskId = 'gen-examples-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生例句', noExample.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noExample.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const sentence = await fetchLLM(`${baseUrl}/api/generate`, model, `Generate a simple English example sentence using the word "${w.word}". Return ONLY the sentence, nothing else.`);
```

### 7d. 取代 __translateExamplesLLM 內的動態 import + fetch_llm（第 372–391 行）

**改前：**
```javascript
    const { baseUrl, model } = llm;
    const { invoke } = await import('@tauri-apps/api/core');

    if (!needTrans.length) {
```

**改後：**
```javascript
    const { baseUrl, model } = llm;

    if (!needTrans.length) {
```

以及：

**改前：**
```javascript
          const translation = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model, prompt });
```

**改後：**
```javascript
          const translation = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
```

### 7e. 取代 __spellCheckLLM 內的動態 import + fetch_llm（第 409–447 行）

**改前：**
```javascript
    const { baseUrl, model } = llm;
    const { invoke } = await import('@tauri-apps/api/core');

    const words = s.state.words;
```

**改後：**
```javascript
    const { baseUrl, model } = llm;

    const words = s.state.words;
```

以及：

**改前：**
```javascript
          const text = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model, prompt });
```

**改後：**
```javascript
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
```

### 7f. 取代 __getPronunciations 內的動態 import + lookup_cambridge（第 496–503 行）

**改前：**
```javascript
    const CON = 2;
    const queue = noPron.map(w => ({ w }));
    const { invoke } = await import('@tauri-apps/api/core');
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const json = await invoke('lookup_cambridge', { word: w.word });
```

**改後：**
```javascript
    const CON = 2;
    const queue = noPron.map(w => ({ w }));
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
```

### 7g. 取代 __genRelatedLLM 內的動態 import + fetch_llm（第 526–546 行）

**改前：**
```javascript
    const { baseUrl, model } = llm;
    const { invoke } = await import('@tauri-apps/api/core');

    if (noRel.length === 0) {
```

**改後：**
```javascript
    const { baseUrl, model } = llm;

    if (noRel.length === 0) {
```

以及：

**改前：**
```javascript
          const relText = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
            prompt: `Return a JSON array...`
          });
```

**改後：**
```javascript
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array...`
          );
```

### 7h. 取代 __genFormsLLM 內的動態 import + fetch_llm（第 567–586 行）

**改前：**
```javascript
    const { baseUrl, model } = llm;
    const { invoke } = await import('@tauri-apps/api/core');

    if (noForms.length === 0) {
```

**改後：**
```javascript
    const { baseUrl, model } = llm;

    if (noForms.length === 0) {
```

以及：

**改前：**
```javascript
          const relText = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
            prompt: `Return a JSON array...`
          });
```

**改後：**
```javascript
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array...`
          );
```

### 7i. 取代 __lookupCambridge 內的動態 import + lookup_cambridge（第 622–623 行）

**改前：**
```javascript
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const json = await invoke('lookup_cambridge', { word });
```

**改後：**
```javascript
    try {
      const json = await lookupCambridge(word);
```

---

## 8. 修改 `src/pages/browser.js`

### 8a. 加入靜態 import（第 8–10 行）

**改前：**
```javascript
import { speak, stopSpeech } from '../lib/tts.js';
import { hashCode, mulberry32 } from '../lib/rng.js';
```

**改後：**
```javascript
import { speak, stopSpeech } from '../lib/tts.js';
import { hashCode, mulberry32 } from '../lib/rng.js';
import { fetchGet, fetchLLM } from '../lib/api.js';
```

### 8b. 取代 autoFillNewWord 內的動態 import（第 803 行）

**改前：**
```javascript
      const { invoke } = await import('@tauri-apps/api/core');

      let definition = '', pos = '', pron = '', example = '';
```

**改後：**
```javascript
      let definition = '', pos = '', pron = '', example = '';
```

### 8c. 取代 autoFillNewWord 內的 fetch_get + fetch_llm（第 820–876 行）

共 7 個呼叫，全部從：
```javascript
await invoke('fetch_get', { url: `${baseUrl}/api/tags` });
```
改為：
```javascript
await fetchGet(`${baseUrl}/api/tags`);
```

以及從：
```javascript
await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
  prompt: `...`
});
```
改為：
```javascript
await fetchLLM(`${baseUrl}/api/generate`, model,
  `...`
);
```

具體變動範圍：lines 820, 825, 830, 835, 839, 847, 857, 872（原始行號）。

### 8d. 取代 llmFillRelated（第 946–952 行）

**改前：**
```javascript
async function llmFillRelated(inputId, word) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
      prompt: `Return a JSON array of synonyms/similar words for "${word}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`
    });
```

**改後：**
```javascript
async function llmFillRelated(inputId, word) {
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array of synonyms/similar words for "${word}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`
    );
```

### 8e. 取代 llmFillForms（第 966–972 行）

**改前：**
```javascript
async function llmFillForms(inputId, word) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
      prompt: `Return a JSON array...`
    });
```

**改後：**
```javascript
async function llmFillForms(inputId, word) {
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array...`
    );
```

---

## 9. 修改 `src/pages/deck-browser.js`

### 9a. 加入靜態 import（第 4–5 行）

**改前：**
```javascript
import { speak, stopSpeech } from '../lib/tts.js';
```

**改後：**
```javascript
import { speak, stopSpeech } from '../lib/tts.js';
import { fetchGet, fetchLLM } from '../lib/api.js';
```

### 9b. 取代 autoFillNewWord 內的動態 import（第 411 行）

**改前：**
```javascript
    const { invoke } = await import('@tauri-apps/api/core');

    let definition = '', pos = '', pron = '', example = '';

    // try Free Dictionary API for pron (IPA is reliable)
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (res.ok) {
        const data = await res.json();
        const entry = data[0];
        pron = entry.phonetics?.find(p => p.text)?.text || '';
      }
    } catch (_) {}

    try {
      const baseUrl = 'http://localhost:11434';
      const tagsResp = await invoke('fetch_get', { url: `${baseUrl}/api/tags` });
```

**改後：**
```javascript
    let definition = '', pos = '', pron = '', example = '';

    // try Free Dictionary API for pron (IPA is reliable)
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (res.ok) {
        const data = await res.json();
        const entry = data[0];
        pron = entry.phonetics?.find(p => p.text)?.text || '';
      }
    } catch (_) {}

    try {
      const baseUrl = 'http://localhost:11434';
      const tagsResp = await fetchGet(`${baseUrl}/api/tags`);
```

### 9c. 取代 autoFillNewWord 內所有 fetch_llm（第 431–477 行）

全部 6 個呼叫從 `invoke('fetch_llm', { url, model, prompt })` 改為 `fetchLLM(url, model, prompt)`，模式與 browser.js 完全相同。

### 9d. 取代 llmFillRelated（第 1081–1087 行）

**改前：**
```javascript
async function llmFillRelated(inputId, word) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
      prompt: `Return a JSON array...`
    });
```

**改後：**
```javascript
async function llmFillRelated(inputId, word) {
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array...`
    );
```

### 9e. 取代 llmFillForms（第 1101–1107 行）

**改前：**
```javascript
async function llmFillForms(inputId, word) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await invoke('fetch_llm', { url: `${baseUrl}/api/generate`, model,
      prompt: `Return a JSON array...`
    });
```

**改後：**
```javascript
async function llmFillForms(inputId, word) {
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array...`
    );
```

---

## 改動總結

| 檔案 | 變動類型 | 行數 |
|------|---------|------|
| `src/lib/api.js` | 新增 | 67 行 |
| `src/lib/tts.js` | 修改 import + invoke | 2 處 |
| `src/lib/backup-scheduler.js` | 修改 import + tick() | 2 處 |
| `src/pages/import.js` | 修改 import + invoke | 2 處 |
| `src/pages/export.js` | 修改 import + 3 處 invoke | 4 處 |
| `src/pages/settings.js` | 修改 import + 7 處 invoke（含 alias） | 8 處 |
| `src/pages/tools.js` | 修改 import + 9 處 invoke | 10 處 |
| `src/pages/browser.js` | 修改 import + 9 處 invoke | 10 處 |
| `src/pages/deck-browser.js` | 修改 import + 8 處 invoke | 9 處 |

**總計：** 9 個檔案（1 新增、8 修改），~54 處改動。
**Rust 端：** 無改動。
**前端 build：** 成功（50 modules, 895ms）。
**Rust build：** 成功（release profile, 1m04s）。
