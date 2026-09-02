# OCR-CD D′ subagent-log — 入庫自動填欄位（enrich overwrite + 多 sense + UI 同步）

- 日期: 2026-08-30
- 專員: OCR-CD（OCR 優化 C/D′）｜本 log 記 D′（入庫自動填欄位）
- 任務書: `_dev/notes/PM-OCR-CD-MISSION.md`
- 計劃書: `_dev/notes/OCR-OPTIMIZE-plan.md` §D′
- 版本: **5.9.5**（D′ commit，接 C 的 5.9.4）

## 動工範圍（D′ 段）
- `src/lib/store.js` `enrichOcrWords`（:1317）：
  - 加 `overwrite=false` 參數（D′.2 §2 覆寫策略）。
  - **多 sense 合併**（D′.2 §3）：不只 senses[0]，迴圈全部 sense 匯總 definition（`；`併）＋examples（去重取前 3）＋首個 pos。修三個致命瑕疵之一的「只取 senses[0]」。
  - pos/pron 保守（不覆寫已有）；definition/examples 依 overwrite 決定覆寫或只填空欄。
- `src/lib/store.js` `importOcrText`（:1506）：**fire-and-forget → await** `this.enrichOcrWords(res.addedIds, true)`，catch 不卡流程（D′.1 修「看不到在填」）；加 `res.enriched`＝實際補齊數（離線/查無 sense 時 < added）。
- `src/pages/ocr.js` 入庫文案：依 `res.enriched` 條件反映——`（欄位補齊 N 字）` 或 `（欄位待補：離線無 Cambridge 資料）`（依 D′.2 §4 失敗回報不虛報）；toast「欄位補齊 N 字」。
- `tools/verify-ocr2-enrich.mjs`（新增 harness，24 checks：多 sense合併/覆寫策略/await同步/charlie無sense負案例）。
- `_dev/notes/verify-ocr-blacklist.mjs` T7 同步：D′ 後 importOcrText 入庫即填齊（definition 非空）＋再次 enrich 回傳 0——反映正確新行為。

## 驗證
- `node --check src/lib/store.js src/pages/ocr.js` → OK
- `node --experimental-test-module-mocks tools/verify-ocr2-enrich.mjs` → **ALL PASS 24 checks**
  - T0a-c 靜態（overwrite 參數 / 多 sense 迴圈 / await）／ T1 空欄字填齊＋兩 sense 併＋charlie 無 sense 負案例(filled=0)／ T2 單 sense／ T3 overwrite=true 覆寫 vs false 保守／ T4 端到端 await（非 fire-and-forget，入庫即填）／ PRE/NC git HEAD 動工前實態→只取 sense0（不含 sense1）＝原缺陷重現
- D′ harness PRE 紅態：未動工時 T0/T1(sense1)/T3a/T4 全紅（只取 sense0、無 overwrite、無 await）——測試敏感度確認
- 既有回歸全綠：verify-ocr-graylist ✓、verify-ocr-blacklist(已更新 T7) ✓、verify-ocr-import ✓、verify-ocr-v2-integration ✓、verify-restore-dict ✓
- C harness verify-ocr2-override 重跑 → ALL PASS（D′ 未破壞 C）
- `npx vite build` → EXIT:0

## 審查
審查輪數: **1 輪 3 人次（全 ✅ 過審）**，store.js 共享核心採 3 席。
- Reviewer #1 ✅：overwrite 設計合理（唯一呼叫者 importOcrText 傳 true）、多 sense 合併正確、await 雙層 catch 不卡死、無越界。建議補 checks 數落差+修 T1 pron 假綠。
- Reviewer #2 ✅：PRE 負控制敏感度實證（拔牙測試 stash 退回 HEAD→9 紅→pop 復原）、T4 await 行為級測試、bravo 正確避黑名單。指出 T1 pron 假綠。
- Reviewer #3 ✅：store.js D′ 正確、C override 未破壞、T7 更新正確；**發現審查期間 HEAD 前進到 f58c236（OCR2-A commit）覆蓋掉 ocr.js D′ 文案**——已重植文案（改為依 res.enriched 條件，離線不虛報）。
- 修正：T1 pron 恆真假綠→精確值；補 charlie 無 sense 負案例；ocr.js 文案依 res.enriched 實際補齊（防斷網虛報）。

## 版本
5.9.6（錯開 f58c236 佔用的 5.9.5）。

## commit
`git add` 明確檔案：src/lib/store.js tools/verify-ocr2-enrich.mjs _dev/notes/verify-ocr-blacklist.mjs package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock _dev/notes/subagent-log/2026-08-30-OCR-CD-DPrime.md（ocr.js 用 git apply --cached 僅 stage D′ 文案 hunk，不含 B′ 別人的工作）
Commit message: `feat: OCR2-D′ 入庫自動填滿單字欄位（enrich overwrite+多sense合併+await UI同步，入庫即見完整卡）+ harness 24項含 PRE 負控制 (5.9.6)`

## 未完成
- 全部交付。B′ 段（切割兩態，OCR-AB 未完）仍留 working tree 未 commit，供接續者接手。