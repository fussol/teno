# PM8 任務書 — store / 資料層 / 瀏覽器域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src/lib/store.js`、`src/lib/db.js`、`src/lib/browser.js`、`src/lib/tag-manager.js`
- `src/pages/exam-flip.js`、`exam-mc.js`、`exam-spell.js`（僅 G11 listener）、`src/pages/deck-browser.js`、`src/pages/study-v4.js`（若有）
- `_dev/notes/`、`tools/verify-*.mjs`
- **不碰** `src/main.js`、`src/lib/tts.js`、`src/pages/settings.js`

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **D14** db.js:137-148 — GUI 單字刪除留 review_log/exam_history 孤兒
2. **D13** store.js:1049-1120 — GUI 匯入/還原/Drive 無 audit_log（db.js:43 承諾不符）
3. **D15** store.js:1057-1111 — importWords 交易 rollback 後 in-memory 與 DB 分歧、無錯誤提示
4. **G16** store.js:130,969 — sidebarOpen/toggleSidebar 死碼
5. **G18** store.js removeTagFromAll/updateTag — 逐詞序列 DB round-trip
6. **G17** browser.js:172-209 — 每次 render 全量 filter+sort（萬級詞庫）
7. **G19** deck-browser.js:520,538,922,939 — .db.getSetting 錯（db.js 無 db 物件）→ autoFillOrder 存不進
8. **G11** browser.js:562-570,608-612 / tag-manager.js:291 / study-spell.js:130-137 / deck-browser.js:1326,1391 / tools.js:332 / exam 系列 — listener 累積（常駐節點/visualViewport/document，無 cleanup；main.js 那部分屬 PM6，只動上述檔）
9. **H1** `~/teno/teno-backup.db` / `phone-db.db` 副本 — integrity_check 報 `wrong # of entries in index idx_review_log_word`（僅修**副本**，嚴禁碰現役 `~/.config/com.teno.app/teno.db`）：跑 `PRAGMA integrity_check` → `REINDEX` → 再 `integrity_check`，記錄修復前後，commit 一份修復報告到 `_dev/notes/`（code 不改則可不 commit code）
10. **G16b** store.js:977 — sidebar 相關死碼跨頁（與 PM6 G3 相鄰，避免同時改；若 PM6 已 commit 就先拉 rebase 再動）
11. **H3** `_backup_humanEvents` 700KB+ page tracking JSON — 收斂（若需動 settings 存檔邏輯 → scope-requests；store.js 側可直接處理）

完成標準：佇列全數有 `fix: <ID>` commit（H1 為報告 commit）。結束回報五欄摘要。