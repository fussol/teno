# G18 修法計畫書 v1.0

## Bug 定義
`src/lib/store.js` 的三個 tag 函式逐詞 `await db.saveWord(w)`（每個迴圈一次 DB round-trip）：
- `removeTagFromAll`（:1313-1324）
- `updateTag`（:1353，改名時 :1357-1364 逐詞）
- `deleteTag`（:1376 起，逐詞）
萬級詞庫時改一個 tag 做幾千次 INSERT...ON CONFLICT → 效能災難。audit G18：「removeTagFromAll/updateTag 逐詞序列 DB round-trip」。

## Root Cause
改 scrapped 詞時直接在迴圈內逐個 await saveWord，未包事務、未批次。

## 修法（db.js 新增批次 API + store.js 三處改用它）
1. **db.js** 新增：
```js
export async function saveWordsInTx(words) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try { for (const w of words) await saveWord(w); await d.execute('COMMIT'); }
  catch (e) { try { await d.execute('ROLLBACK'); } catch {} throw e; }
}
```
（循 bulkSaveWords:155 模式但只存選定 words、不 DELETE 全表。）
2. **store.js** 三函式改為「先收集受影響 words 進陣列 → 一次 saveWordsInTx(帶 audit)」。removeTagFromAll 收集後仍計算 touched、保留 deleteTagConfig/deleteTag 各自的 tagConfig 更新邏輯。

## 消費者清單（憲法②）
- 新 API `saveWordsInTx`：store.js 三處呼叫
- 既有 `saveWord` 仍被 browser 單改、import 等使用（不動）
- 三 tag 函式呼叫端：tag-manager.js / settings.js 的 tag 管理 UI

## 驗證
tools/verify-g18-tag-batch.mjs：
- T1 實錘現行 removeTagFromAll/updateTag/deleteTag 是逐詞 saveWord（原始碼 grep — 修前 marker）
- T2 db.js 新 saveWordsInTx 存在且包 BEGIN/COMMIT
- T3 store.js 三函式改用 saveWordsInTx（fix marker）
- T4 功能等價：removeTagFromAll 仍移除所有含該 tag 的 words（狀態 + touched 正確）
- T5 負控制：修前逐詞 + 無事務 → T2/T3 FAIL（bug 重現）
- 回歸：涉及 tag 的既有行為不變

## 風險
- 中低：批次化改變錯誤處理語義（逐詞 catch 變整批 rollback）— audit 原逐詞 try/catch 隱藏單詞失敗，批次化後一詞失敗整批回滾（更安全）。需確認無「期望單詞失敗但不影響其他」的需求。
- saveWordsInTx 需 db.js 已在 store 的 require 下（循既有 db.saveWord 暴露方式）。