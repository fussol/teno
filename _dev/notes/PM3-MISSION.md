# PM3 任務書 — Rust 核心域（lib.rs）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src-tauri/src/lib.rs`、`src-tauri/src/cambridge/url.rs`
- `tools/verify-*.mjs` 或 `src-tauri/tests/`（新建驗證用）
- `_dev/notes/`
- **不碰** `Cargo.toml`（他相所有；要加 dep → scope-requests）

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **D5** lib.rs:1212-1224 — backup_db fs::copy 無 WAL checkpoint → 備份缺最近複習
2. **F9** lib.rs:488-494 — install_piper_model 目錄網址 model_name off-by-one → 永遠 404
3. **F10** lib.rs:397-398 — import_piper_model_dialog Android FilePath::Url as_path()=None → 必失敗
4. **F12** lib.rs:250,290,322 — scrape_quizlet/fetch_llm/fetch_get/install_piper_model 用 curl（Android 無 curl；lookup_cambridge 已改 ureq 可參照模式）
5. **D16** lib.rs:518-540 — TENOC 容器 version byte 未驗證、trailing garbage 不報錯
6. **D17** lib.rs:1218-1221 — 同秒備份檔名碰撞覆寫
7. **F13** cambridge/url.rs:2-10 — lookup_cambridge 未 URL-encode 詞彙 → 片語查詢失敗
8. **F14** lib.rs:1132-1134 — /tmp/teno-monitor.log symlink 寫入（ symlink 攻擊面）
9. **F15** lib.rs:79-96 — open_report file:// 視窗無 CSP + CDN script 無 SRI
10. **F16** lib.rs:78,1365 — dead commands：open_report / export_csv_data 註冊但無呼叫
11. **F19** lib.rs:1055 — simulate_fsrs today_days 用 UTC 天數（Anki 用當地）→ 跨時區偏差

注意：F15/F16 同檔重疊（open_report）→ 合併思考但**仍各開計畫書各 commit**，F16 若結論是刪 dead command 需先窮舉前端 invoke 消費者（憲法②grep 清單）。D5/D17 都碰 backup_db，順序 D5→D17，計畫書互相引用。curl→ureq（F12）注意 fetch_get 已有 HTTPS-only 政策（F8 已修，允許 localhost http 例外）——改寫時保留該政策驗證。Rust 驗證：`cargo check` + `cargo test`（在 src-tauri 下）；能寫 unit test 的優先寫 unit test。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。
