# B6 Fix Plan — 完成的測驗不刪除 → 可無限 resume 重答、重複套標籤

## 1. Bug 事實

**位置**：三頁 exam-flip.js / exam-mc.js / exam-spell.js 的 recordExamResult helper（B4 引入）

**問題**：測驗完成（phase='result'）後不刪除已存 session。使用者 resume 一場測驗答完後，config 頁的 session 列表仍顯示該場 → 可再次 resume 重答剩餘題目、applyTags 重複套標籤。

## 2. 根因

完成路徑只記錄 exam_history（B4），從不清理 resume 用的 session。

## 3. 修法（集中式，三頁同構 +8 行）

recordExamResult helper 尾端（B4 防重旗標後）加：

```js
// B6: 完成後刪除已存 session（resume 場 e.id 有值）→ 防 resume 重答剩餘題目、applyTags 重複套標籤
if (e.id) {
  try {
    await s.actions.deleteExamSession(e.id);
    e.id = undefined;   // 刪成功才清 id（失敗保留 + warn — session 仍在 config 列表可手動刪）
  } catch (err) { console.warn('[exam-XX] deleteExamSession error:', err); }
}
```

**覆蓋面**：三頁所有完成路徑都收斂到 recordExamResult（B4 架構）→ 單一插入點覆蓋全部：
- flip 3 路徑：resume 全答完 / nextWord 末題 / 手動查看結果
- mc 2 路徑：nextWord 末題（含 B3 armJump 收斂）/ 手動按鈕
- spell 2 路徑：nextWord 末題 / 手動按鈕

**防重機制**：
- B4 `e.examRecorded` 旗標 → body 恰跑一次 → delete 恰一次
- B5 startExam 重置 `e.id=undefined` → 新場不觸發刪除
- 刪除失敗 catch+warn → session 保留可手動刪（不資料遺失）

## 4. 消費者清單

| # | 位置 | 影響 |
|---|---|---|
| 1 | 三頁 recordExamResult | 唯一插入點 |
| 2 | store.js deleteExamSession(:1670-1673) | 消費端（不動） |
| 3 | B5 e.id 生命週期 | startExam 重置 → 新場不觸發 |

## 5. 驗證

tools/verify-b6-exam-delete.mjs 72/72（真實源碼 new Function 載入 + 真實 buildSession）：T0 靜態區塊在場、T1a/b/c 三種完成路徑→刪除+deleteCalls=1、T2 新場 delete 零呼叫+他人 session 不誤刪、T3 拋錯不噴錯、T4 重複呼叫只刪 1 次、T5 負控制剝除→bug 再現。verify-b5 51/51 回歸、node --check 三頁、vite build 761ms。

## 6. 範圍外

- 未完成測驗的 resume（保留 — 這是功能）
- B10（sidebar 導航存檔，另案）
