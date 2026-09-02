# D15-fix-plan.md — importWords 批次 DB 寫失敗時 `state.words` 未回滾

**Bug**: `importWords` 建立 `newWords` 並在迴圈內 push 到 `state.words`（`store.js:1262-1264`），但 DB 批次寫入單一 transaction（`store.js:1272-1282`）在後。當 DB 寫入失敗，原碼只 `txFailed → added = 0`（`store.js:1280`），**`state.words` 內已 push 的 `newWords` 沒有撤銷**。

**症狀（用戶實測）**: OCR「無法正常工作」——tools 站選圖→辨識→候選勾選→「加入字本」，UI 顯示已入庫，但實際 DB 0 顆 → 重開 app 全消失。前一輪復現：`importOcrText` 在 DB 失效時 `state.words` 進 4 顆、DB 0 顆。

**原因**: 批次寫失敗時，in-memory `state.words` 已汙染，與 DB 不一致（UI 顯示有、資料庫無）。

## Root cause 定點
- `store.js:1262` `state.words.push(word)` — 迴圈內即時 push
- `store.js:1276` `db.saveWord(w)` 批次 tx，失敗 → `txFailed = true`
- `store.js:1283` 失敗分支原碼僅 `added = 0`，**無 state.words 回滾**

## 修法（D15/G4 補全）
`store.js:1283-1289`:
```js
if (txFailed) {
  const newIds = new Set(newWords.map(w => w.id));
  state.words = state.words.filter(w => !newIds.has(w.id));
  added = 0;
}
```
批次失敗時把這批 `newWords`（依 id 集合）從 `state.words` 過濾掉，`added` 歸零 → UI 與 DB 一致。

## 驗證
開發新 harness `_dev/notes/verify-d15-rollback.mjs`（mock SQLite + `createStore().actions.init()` + 觸發 `INSERT INTO words` 失敗）：
- **P1** DB 失敗：`added=0`、DB 0 新增、`state.words` 無殘留 charlie/delta、維持 2 顆 ✅
- **P2** DB 成功：`added=2`、入庫正常 ✅
- **P3** 負控制：正常路徑不誤觸 rollback ✅
- **P4** partial：雖已 in-memory push，tx 失敗仍全量撤 ✅
- **14/14 PASS**

**既有驗證器演進**（S-2 同步釘義務，因為修法把單行 block 擴成多行）:
- `tools/verify-ocr-imp.mjs`: `T0c` 正則容忍多行 block；新增 `T0d` 釘 rollback；`T3` 負控制剝除目標改為整個 rollback block → **全 PASS**（T3 雜訊剝除後 added=3 幽靈再現，證驗證器有牙）

## 額外證據（用戶測試圖）
用戶提供清晰測試圖（`img_3e338d785be6.jpeg`, 1884x4080, 英文單字卡）：
- 系統 tesseract：可清晰辨識（"refresh"/"revive"/"pleasantly different" 等）
- app 離線管線（tesseract.js UMD→worker→lang 三路徑）：**505ms / conf 67** 辨識成功，內容清晰
- 證明 OCR 引擎鏈功能正常——「無法正常工作」的根因確在入庫層的 D15，非引擎

## 風險
低。`state.words` reassign（`filter` 回傳新陣列）與既有先例一致（`:310 loadAll`、`:1528 deleteWord`）。語意：批次勢敗即使部分已 push，亦全量撤，符合「單一 tx 全有或全無」。

## 送審紀錄
v1.0 2026-08-29