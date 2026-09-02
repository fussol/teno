# PM1 任務書 — 學習 session / 模擬器域

> **⚠️ 佇列已全數結算（2026-08-28，本檔為歷史任務書）**：C4-C10/G4/G4b/G8/G26 十顆
> 全數有 `fix:` commit＋驗證綠。逐顆 commit hash 見 `_dev/notes/PM1-checkpoint.md`。
> 新 session 開工前必跑 `git log --grep=<ID>` 反查，**勿重做已完成顆**（2026-08-28
> 已有 session 未反查即重建 C4 計畫書 v1 草稿＋2 行 stub 驗證腳本覆蓋在案，已清除）。

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src/engine/session-utils.js`、`src/engine/session-mc-utils.js`、`src/engine/session-spell-utils.js`
- `src/engine/session-v4.js`、`src/core/scheduler.js`
- `src/pages/dashboard.js`、`src/lib/easter-eggs.js`、`src/lib/simulator.js`
- `tools/verify-*.mjs`（新建）、`_dev/notes/`（計畫書/log）

## Bug 佇列（依序，audit 2026-08-13 行號僅供參考，動工前實錘）
1. **C4** session-utils.js:24-26（三份同）評分預覽 FSRS maxIvl=36500（store 用 ankiCfg.maxIvl=365）→ 成熟卡預覽 428d 實際 346d
2. **C5** session-v4.js:86-88 vs scheduler.js:147-149 — maxReviewsPerDay cap 不一致（session 只 cap review、scheduler cap 總和）→ dashboard 50 vs 實際 70
3. **C6** dashboard.js:98 + 概覽 grid — 同頁三種「待複習」數字互相矛盾（hero/概覽/字本 grid）
4. **C7** session-utils.js:189,215 — 完成畫面無法 undo 最後一張；下一張未翻答案前 Ctrl+Z 被擋
5. **C8** session-utils.js:87-133 — rateCard in-flight 期間 Ctrl+Z race（_ratingLock 不擋 undo、快照 await 後才更新）
6. **C9** session-utils.js:101（三份同）— incrementGoal fire-and-forget → undo 的 goal 還原被 in-flight 覆寫
7. **C10** session-utils.js:94-131 — _ratingLock 無 try/finally → easter-egg throw 後永久鎖死
8. **G4** easter-eggs.js:49 — _totalRated 無人寫入 → 成就永不觸發；里程碑用單次 session 數、重啟後重來
9. **G8** simulator.js:330-335 — _simResults 無上限、每筆保留全詞表快照 → 記憶體線性成長
10. **G26** simulator.js 手機 viewport — 切換模式時舊 render ref 失效

注意：C8/C10 與既有 `_ratingLock` 實作（C3 已修，commit 6324eb4）同檔同區塊，修法必須相容；C7 的 undo 鏈要對齊既有 undoSnapshot 機制（C1 已修 per-mode 快照）。G26 若需動 simulator.js 以外檔 → scope-requests。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。
