# D2 修復計畫書 — restore/download 順序反轉

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅，含 D4 配套共識）
> 範圍：D2 主體（settings.js + lib.rs）+ **D4 配套**（drive_sync.rs，分開 commit）

---

## 1. Bug 定義

**症狀**：還原備份 / Google Drive 下載後，reload 顯示舊資料（還原看似無效）或 DB 打不開（disk I/O error）。

**Root cause**（#3 實錘）：
- `restoreBackup`（settings.js:540-551）：`backupDb() → apiRestoreBackup() → reload` — **DB 連線全程開著**
- `restore_backup`（lib.rs:1328-1348）：`fs::copy` 直接覆寫開著的 teno.db（非原子）
- `drive_download`（drive_sync.rs:285-306）：已 tmp+rename 但**不刪 wal/shm**、JS 端不關 DB
- 機制：Windows 上連線開著 → `remove_file(-wal/-shm)` 靜默失敗 → 舊 WAL 殘留 → 新連線 replay 舊資料（誤 recovery）；Linux 上舊連線持舊 inode，1.5s 空窗寫入進 unlink 檔 → 資料丟失；zombie 連線 shm 被刪 → reload 後 disk I/O error
- 實測：現況 restore 後新連線 `OperationalError: disk I/O error`；drive_download 後殘留 WAL replay 舊資料（rows=150 期望 50）

## 2. 修復方案

### 2.1 `src/pages/settings.js:540-551` — restoreBackup 重排
```js
async function restoreBackup(filename, btn) {
  if (!confirm('確定要還原此備份？所有現有資料將被取代（會自動備份目前資料庫）。')) return;
  if (btn) btn.disabled = true;
  try {
    const { checkpoint, closeDB, initDB } = await import('../lib/db.js');
    const { closeAppLog } = await import('../lib/app-log.js');
    await checkpoint();      // WAL 合併 → 備份完整（#3/#4）
    await backupDb();        // 安全網，close 前（#5）
    await closeDB();         // 最後連線關閉 → 自動 checkpoint + 刪 wal/shm
    await closeAppLog();
    await apiRestoreBackup(filename);
    toast('還原成功，重新載入中…', 'toast-success');
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('還原失敗: ' + e, 'toast-error');
    try { const { initDB } = await import('../lib/db.js'); await initDB(2); } catch (_) {}  // 失敗重連，防半死
  } finally {
    if (btn) btn.disabled = false;
  }
}
```
- listener（:528-529）改 `restoreBackup(btn.dataset.brestore, btn)`

### 2.2 `src/pages/settings.js:904-916` — driveDownloadBtn 同樣處理
- 補 confirm + checkpoint → backupDb → closeDB + closeAppLog → driveDownload → reload(500ms)；catch re-initDB

### 2.3 `src-tauri/src/lib.rs:1328-1348` — restore_backup 改 tmp+rename + magic 驗證
```rust
// 防呆：確認來源是合法 SQLite（擋空檔/HTML/截斷）
let head = std::fs::read(&src).map_err(|e| format!("讀取備份失敗: {}", e))?;
if head.len() < 16 || &head[..16] != b"SQLite format 3\0" {
    return Err("備份檔案不是有效資料庫".to_string());
}
let tmp = app_dir.join("teno.db.restore_tmp");
std::fs::copy(&src, &tmp).map_err(|e| format!("還原失敗: {}", e))?;
// 刪 WAL/SHM 在 rename 前（對齊 write_db_container 既有 pattern）
let _ = std::fs::remove_file(&wal);
let _ = std::fs::remove_file(&shm);
std::fs::rename(&tmp, &db_path).map_err(|e| format!("還原失敗: {}", e))?;
```

### 2.4 `src-tauri/src/drive_sync.rs:300-305` — drive_download 補刪 wal/shm（**D4 配套，分開 commit**）
```rust
std::fs::write(&tmp, &buf).map_err(|e| format!("寫入暫存失敗: {}", e))?;
let _ = std::fs::remove_file(db.with_extension("db-wal"));
let _ = std::fs::remove_file(db.with_extension("db-shm"));
std::fs::rename(&tmp, &db).map_err(|e| format!("覆蓋資料庫失敗: {}", e))?;
```

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | 最後連線關閉自動 checkpoint；Windows rename 語意；3 處精修 |
| #2 | 資料 | ✅ | drive_download 必須同批補 wal/shm（否則 D2 修一半）；失敗 re-initDB |
| #3 | 實測 | ✅ | 實錘 disk I/O error + WAL replay；擬案流程全綠；tmp+rename 強防護 |
| #4 | 副作用 | ✅ | 修正三點：D4 wal/shm、失敗恢復、checkpoint 先行 |
| #5 | 整合 | ✅ | backupDb 維持 close 前（checkpoint 補完整）；launcherIcon 例外已知 |

## 4. 驗證方式

1. **Rust**：cargo check / cargo build
2. **JS**：vite build
3. **行為**（#3 已實測）：closeDB 後 restore → reload 讀到新資料、無 disk I/O error；drive_download 清 wal/shm 後正確讀遠端資料
4. **失敗路徑**：invoke 失敗 → initDB 重連（無半死狀態）

## 5. 風險

- **低**：restore 前 checkpoint + backupDb 安全網（備份完整）
- **低**：magic 驗證擋非法檔（舊備份若被破壞會拒絕還原 — 正確行為）
- **已知例外**：Android launcherIcon restore 後被 alias 覆寫（既有行為，非 D2 引入）
