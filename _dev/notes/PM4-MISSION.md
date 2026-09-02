# PM4 任務書 — Drive 同步域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src-tauri/src/drive_sync.rs`
- `src/pages/settings.js` 的 Drive 區塊**不碰**（PM6 所有）→ 需前端配合就 scope-requests
- `_dev/notes/`

## Bug 佇列（依序）
1. **F11** drive_sync.rs:43-44,56-73 — OAuth client secret 硬編碼進 binary；tokens/creds 明文 0644
2. **D11** drive_sync.rs:296-303 — 下載內容無 SQLite magic 驗證 → 空檔/損壞檔直接毀本機 DB
3. **D10** drive_sync.rs:155-166 — 同名多檔取 first() 無排序、無 modifiedTime 比較、last-write-wins

注意：F11 是安全案——secret 從 source 移除後要改走編譯期 env/密件注入或 tauri 內建機制，**方案要務實可 build**（不能讓 build 依賴外部機密才能編譯）；tokens 檔權限 0600。D11 修法（magic 驗證）要兼容 TENOC 容器格式（header 10B 'TENOC\x01...' + SQLite magic @offset10）與裸 SQLite 兩種。OAuth 測試嚴禁真連 Google API 燒 quota，用本地 mock/離線斷言。secret 輪換不在範圍（記範圍外清單）。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。
