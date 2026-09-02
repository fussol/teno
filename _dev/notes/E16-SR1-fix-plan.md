# E16-SR1 修復計畫書 — 刪除 deprecated/sim-behavior.js 零引用死檔

- **Bug ID**: E16-SR1
- **規格來源**: scope-requests.md E16-SR1（PM2 登案，2026-08-28）
- **任務書**: PM-SR1-MISSION §佇列3
- **基線**: HEAD `d04986a`(v5.8.3)
- **首相**: SR1（資料層）

## 1. Bug 定義
`src/lib/deprecated/sim-behavior.js`（196 行，7.6KB）為零引用孤兒檔。原本唯一 import 者是已刪的 `src/lib/deprecated/sim-engine.js:13`（E16 上波刪除），自此全庫 src/ 零 runtime 引用。屬 E8 政策隔離的舊 JS 模擬鏈殘廢，官方 fsrs-rs `simulate_fsrs` 為唯一模擬路徑。

## 2. Root cause
E16 主 bug（SIM 三死檔）上波已刪 sim-engine/themes/svg，但 sim-behavior 因白名單邊界（當時非 E16 授權範圍）刻意留存，並在 verify-e16 設了「sim-behavior 本波必須仍在」臨時釘（T5a）。本波 E16-SR1 任務書明授權刪除。

## 3. 修法
- 刪 `src/lib/deprecated/sim-behavior.js`。
- 刪後 `deprecated/` 目錄空 → 一併消失（`rmdir`）。

## 4. 驗證
- grep 全庫（src/ tools/ _dev/src）零 runtime 引用。
- 檔案不存在。
- 既有 fsrs/sim harness 回歸：`tools/verify-e13-simparams-guard.mjs`、`tools/verify-g8-simhistory-cap.mjs`、`tools/verify-f16-csv-data.mjs`(T3a src/ exportCsvData 呼叫釘)。
- 自建 `_dev/notes/verify-e16-sr1-orphan.mjs`（放 _dev/notes 因 tools/ 不在本顆白名單）雙態：動工前在場（RED→但現是 RED 態應已刪後 GREEN）；負控制還原檔 → 檔案在 = 紅。

## 5. 治理邊界（鐵律⑦）
- `tools/verify-e16-orphan-deletion.mjs` T5a「sim-behavior 本波必須仍在」在刪除後變紅——該工具檔**不在本任務白名單**（白名單 tools 檔僅 d5/d20/f16/g24），依鐵律⑦不逕改 → 登 scope-requests 請總統對 verify-e16 的 T5 臨時釘裁示更新為「已刪」態。

## 6. 風險
- 零。全庫零引用，刪除無破壞面。

## 7. 可選項
- 保留 sim-behavior 供未功歷史對照 → **不做**（git 歷史保留，磁碟不需留；E8 政策隔離明確排除舊模擬鏈）。

## 8. 過審後動工 checklist
- [x] grep 全庫零 runtime 引用（統證明，165 檔掃 0 命中）
- [x] rm sim-behavior.js + deprecated/ 空則 rmdir（file+dir 皆消失）
- [x] 檔案不存在
- [x] verify-e16-sr1-orphan.mjs GREEN（刪後 3/0）
- [x] 回歸 e13（T5 既有 2 FAIL 零因果）+ g8(flag 8/8) + f16(16/0)

## 版本
E16 屬 code 路徑變更 → 下一版 5.8.4（version.sh patch）。

## 版本紀錄
- v1.0（送審）：初版。
- v1.1（審查採納）：①§5 承諾之 scope-requests 請求 row 已落盤（`E16-SR2`，對 verify-e16 T5a 釘裁示）；②§8 checklist 補勾；③範圍外註記：e13 harness 為 cli.mjs 既有失敗（stash 對照 HEAD 同 24/2，零因果）；g8 需 --experimental-test-module-mocks flag。刪除本體零變動。