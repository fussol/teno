# PM7 任務書 — 匯入 / 匯出 / 日誌 / 排程域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src/core/import.js`、`src/lib/export.js`、`src/lib/app-log.js`、`src/lib/backup-scheduler.js`
- `_dev/notes/`、`tools/verify-*.mjs`
- **不碰** `src/lib/store.js`、`src/lib/db.js`（PM8）、`src/pages/*`、`src-tauri/*`

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **G21** import.js:114-118 + import.js:87 — CANONICAL_FIELDS 缺 tags/examples、FIELD_MAP 缺中文標記/描述 → 匯入整欄靜默丟失
2. **G28** import.js:441,467 — 匯入無重入保護 → 雙擊產生重複單字
3. **D12** import.js:136-150 — mapAnkiRows 死碼 → Anki TSV 自動欄位對應失效
4. **D18** backup-scheduler.js:8-13 — 每次啟動都備份（lastBackupMtime 初始 0）→ 洗掉有差異的舊備份
5. **G24** export.js:39-51 — render 引用未定義 words → ReferenceError（目前無入口）
6. **G25** app-log.js:84-114 — resetAttempted 永久 true → 二次損壞不再重建、flush 無限重試
7. **G29** app-log.js:103-111 — refresh 與載入更多併發覆蓋
8. **G30** backup-scheduler.js:11-17 — tick 無重入保護 → 併發重複備份

注意：import/export 都是資料完整性問題——驗證用 tmp CSV/TSV 檔實測 round-trip（遵循已修 D1 的教訓）。G21 會改 CANONICAL_FIELDS/FIELD_MAP，要先窮舉所有引用這些常數的檔案（憲法② grep）確認不會漏欄。G25/G29 同檔（app-log.js）依序修。G30 與 D18 同檔（backup-scheduler.js）依序修，D18→G30。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。