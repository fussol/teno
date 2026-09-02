# D3 修復計畫書 — drive_upload 無 checkpoint（上傳缺最近資料）

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅）
> 範圍：僅 D3 專案

---

## 1. Bug 定義

**症狀**：Google Drive 上傳的備份缺最近複習資料（可能缺整天 review_log/FSRS 狀態）。

**Root cause**：`drive_upload`（drive_sync.rs:265-282）用 `std::fs::read(teno.db)` 只讀**主檔**，完全不碰 `-wal`。App 是 WAL 模式（實測 `journal_mode=wal`），已提交未 checkpoint 的交易只存在 WAL → 主檔落後 → 上傳舊檔。
- 實測：常駐連線下主檔連 schema 都缺（COUNT: no such table）；checkpoint 後完整（3/3 筆）
- 附加風險（#2）：fs::read 不持 SQLite lock，與 scheduler 每 10 分鐘 checkpoint 並發可能讀到 torn file → 上傳損壞檔覆蓋 Drive 遠端（真正的資料遺失向量）

## 2. 修復方案（1 處）

### `src/pages/settings.js` driveSyncBtn（:904 前）— upload 前 checkpoint

```js
      // D3: WAL checkpoint → 主檔完整後再上傳（drive_upload 只 fs::read 主檔）
      const { checkpoint } = await import('../lib/db.js');
      await checkpoint();
      const result = await driveUpload();
```

- 與既有下載（:920-922）/還原（:544-547）路徑同構
- **不補 busy_timeout**（5/5 委員一致實錘：tauri-plugin-sql → sqlx-sqlite 0.8.6 預設 `busy_timeout=5s`，`options/mod.rs:201` + `establish.rs:282-285`；JS `PRAGMA busy_timeout` 無效）
- 選配：#2 建議 db.js:62 checkpoint catch 改 `console.warn`（避免吞錯）

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | bug 實測證實（WAL 主檔缺資料）；checkpoint 位置正確；busy_timeout 事實錯誤撤回 |
| #2 | 資料 | ✅ | 比 stale 更嚴重：torn file 覆蓋遠端；sqlx 預設 5s 已覆蓋 |
| #3 | 實測 | ✅ | 端到端實測（sqlx 同 stack）：checkpoint 前 no such table → 後完整 |
| #4 | 副作用 | ✅ | 上傳不需 closeDB（不覆蓋 DB）；與 D2/D4 對稱 |
| #5 | 整合 | ✅ | 唯一必要變更一行；與下載/還原同構 |

## 4. 驗證方式

1. **行為**（#3 已實測）：常駐連線 → checkpoint 前主檔缺資料 → checkpoint 後完整
2. **Build**：vite build 通過
3. **對稱性**：upload / download / restore 三路徑都有 checkpoint

## 5. 風險

- **低**：checkpoint 是同步寫檔（大庫可能數百 ms），上傳前多一次 IO；busy 由 5s timeout 兜底
- **殘留**（範圍外）：fs::copy/fs::read 不持 lock，scheduler 同刻 tick 仍可能 torn（窗口毫秒級）— 100% 原子需 SQLite backup API，列 future work
