# A11 修復計畫書 — leech 標記公式（非官方 isLeech 節奏）

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅ 全過）
> 範圍：僅 A11 專案，不夾帶其他 bug

---

## 1. Bug 定義

**症狀**：`src/lib/store.js:672` leech 標記用 `result.lapses >= threshold`（threshold = ankiCfg.leechThreshold || 8），非官方 Anki isLeech 節奏（threshold=8 時 8/12/16/20 才觸發）→ lapses 一旦 ≥8 條件永遠成立，加上 `word.tags.includes(leechTag)` 冪等保護 → **只在 lapses=8 標記一次**，12/16/20 不會再標。

**Root cause**：官方 Anki（rslib `leech_threshold_met`）：`lapses >= threshold && (lapses - threshold) % max(1, ceil(threshold/2)) === 0`。teno 的 scheduler.js 已實作正確的 `isLeech()`，但 store.js 呼叫點沒用它，用了裸 `>=`。

## 2. 修復方案（2 處）

### 2.1 `src/lib/store.js:533` — requireScheduler 解構加 isLeech
```js
// 現況
const { computeFutureDueCounts, getToday, toLocalDateStr } = requireScheduler();
// 改為
const { computeFutureDueCounts, getToday, toLocalDateStr, isLeech } = requireScheduler();
```
- `isLeech` 是 `src/core/scheduler.js:165` 的 named export；store.js:424 動態 import 整個 module namespace → 同源解構零風險
- 現況 isLeech 全 repo 零呼叫點（新增第一個 caller，無既有依賴）

### 2.2 `src/lib/store.js:672` — 換官方節奏
```js
// 現況
if (rating === AGAIN && result.lapses >= threshold) {
// 改為
if (rating === AGAIN && isLeech(result.lapses, threshold)) {
```
- `result.lapses` 是 fsrs.js review() 內 AGAIN 後 +1 的新值（post-increment）— 與 Anki 判定時機一致
- 保留 `word.tags.includes(leechTag)` 冪等保護（8/12/16/20 重觸發時不重複 push）

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | 官方測試向量 ALL PASS；requireScheduler 解構可行（:533 同 pattern） |
| #2 | Anki | ✅ | 與 rslib `leech_threshold_met` 逐點吻合；lapses 時機（review 卡 Again 才 +1）一致 |
| #3 | 副作用 | ✅ | isLeech 零呼叫點；12/16/20 被 includes 擋不重寫；不需 migration |
| #4 | 實測 | ✅ | 30/31 檢查點過；8/12/16/20 節奏 + 冪等實測通過 |
| #5 | 整合 | ✅ | 前三位宣稱全數複驗通過；精確 diff 兩行 |

**非阻塞備註**（已記錄，不影響實作）：
- 奇數 threshold（3/5/7…）teno `Math.ceil` vs 官方 `floor` 微差 — 預設 8 完全一致，可選修
- relearning 狀態 Again 不 +lapses → 9-11 不重貼 tag 屬修正非回歸
- 保留 `|| 8`（改 `?? 8` 會讓 threshold=0 靜默失效）
- fsrs-optimizer.js:345 的 `>=` 是健康報告統計（列 leech 卡），語意正確不用改

## 4. 驗證方式

1. **單元**：node import scheduler.js 的 isLeech 跑官方向量（threshold=8 → 7F/8T/9-11F/12T/16T/20T）
2. **行為**：模擬 review 卡連續 Again → 觸發序列 = 8,12,16,20（非舊的 8 一次）
3. **冪等**：tag 已存在時不重複 push / saveWord
4. **Build**：vite build 通過

## 5. 風險

- **低**：改動 2 行，無資料 migration；唯一行為差異是 12/16/20 重新滿足條件（tag 已存在 → includes 擋住 → 對 word.tags 無可見變化；未來若接 leech suspension 有正確 fire point）
