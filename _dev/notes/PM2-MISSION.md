# PM2 任務書 — CLI / 工具域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `tools/cli.mjs`（唯一正式 CLI；`_dev/cli/` 是舊版不准碰）
- `src/lib/deprecated/sim-engine.js`、`src/lib/themes.js`、`src/pages/svg.js`（僅 E16 刪除用）
- `tools/verify-*.mjs`（新建）、`_dev/notes/`

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **E4** cli.mjs:1210-1211 — CLI rate 寫 review_log 缺 duration/elapsed_days/scheduled_days/stability/difficulty → 官方優化當 delta_t=0 首刷
2. **E5** cli.mjs:1192,1239 — rate/sim 用 Math.random() fuzz（app 是確定性 seed）+ 不套 greaterThanLast → audit mismatch
3. **E6** cli.mjs:3318-3323 — cmdStudy 不寫 review_log → optimize/audit 看不到 CLI 複習
4. **E7** cli.mjs:3186-3327 — study mc/spell 用 base card 評分覆寫 → 污染 flip 卡狀態
5. **E8** cli.mjs:2145 — selftest 模擬引擎檢查 import 不存在路徑 → 永遠 ❌
6. **D7** cli.mjs:1362-1372 — CLI restore 不刪 wal/shm（cmdImportDb 有）
7. **D8** cli.mjs:1105-1147 — CLI CSV round-trip 損壞：7 欄丟資料、pos/pron header 不一致、tags 雙重序列化
8. **D19** cli.mjs:2097-2104 — CLI 匯入不驗證 SQLite magic
9. **D20** cli.mjs:704-716 — cmdDeleteDeck 留 review_log 孤兒、decks 記錄未刪
10. **E9** cli.mjs:1176-1177 — rate --date 無驗證 → Invalid time value 難懂錯誤
11. **E10** cli.mjs:2161 — selftest 容器檢查 `|| true` 恆真
12. **E11** cli.mjs:2614,2649 — cmdReport totalWords 硬編碼 4868
13. **E12** cli.mjs:2725 — cmdMature totalReviews 讀快照值（simulate 不寫 review_log）
14. **E13** cli.mjs:927 — simparams set parseFloat 無 isNaN → 寫入 NaN
15. **E14** cli.mjs:735,742,... — 全新 DB 跑 theme/tts/day 讀回 .value → TypeError
16. **E15** cli.mjs:89 — loadState 讀 words 缺 pronunciation/example/image/description 4 欄
17. **E16** 孤兒檔案刪除 — src/lib/deprecated/sim-engine.js、themes.js、pages/svg.js（先 grep 全專案確認零引用再刪；sim-engine 已被政策隔離 deprecated）

紀律：FSRS 優化政策 = 官方 fsrs-rs only，嚴禁把隔離的 JS optimizer 接回。E4/E5/E6 動到 review_log 寫入格式時，欄位語意必須與 app 端 store.js rateCard 完全對齊（dayCutoff-aware、Z 結尾 ISO——E2 已修的教訓）。驗證一律用 tmp DB 副本，嚴禁碰 `~/.config/com.teno.app/teno.db`。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。
