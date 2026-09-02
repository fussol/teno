# C8 修法計畫書 v1.1（2026-08-27，PM1）

> **v1.1 變更（R1 三委員全 ✅ 非阻斷建議採納，產品修法零改動）**：
> ① 驗證腳本加 T7「undo 拋錯後鎖必釋」屬性釘（#3-F1：M-c 變異存活補牙）；
> ② 消費者計數筆誤修正 21→24（#2：每檔 8 處×3，既有 5×3＋新增 3×3）；
> ③ 修法副本斷言數 13→14（非 legacy 多 T1b×2－佔位 1；加 T7 後 15）。
> 審查詳見 §審查紀錄。

## Bug 定義
rateCard in-flight（`await store.actions.rateCard` 未歸還）期間按 Ctrl+Z／點 undoBtn：
undo **照跑**——對「上一張」的快照執行 `store.actions.undoLastRating`，與尚未完成的
本次評分 DB 寫入交錯。後果（實測設計見驗證）：
1. store 層交錯：undo 刪 log/還原卡片的 await 鏈與評分寫 log/寫卡 await 鏈互插 →
   DB 與 memory 分歧（刪掉不該刪的、留下心殭屍 log）。
2. engine 層交錯：undoRating 同步段（results.pop／current 放回／state 還原）與
   rateCard 續航段（`_undoSnapshot` 覆寫、session.rate、next()、state 賦值）互插 →
   session.current/results/queue 三類狀態至少一类不一致（可持續到下次評分崩面）。

## Root Cause（2026-08-27 實錘行號，HEAD=3e36002；audit 2026-08-13 :87-133 已漂移）
三同構檔 rateCard 有鎖、undoRating 無鎖：

| 檔 | rateCard 鎖鏈 | undoRating |
|---|---|---|
| session-utils.js | :93 check → :94 set → :102 catch 釋 → :135 renderFn 前釋 | :152-188 **零鎖檢查/零鎖取得** |
| session-mc-utils.js | :108 → :109 → :116 → :151 | :169-209 同上 |
| session-spell-utils.js | :105 → :106 → :113 → :141 | :159-196 同上 |

呼叫端（undoBtn click ＋ keydown Ctrl+Z，三檔 mount 內共 6 處）直接 fire-and-forget
呼叫 undoRating，無任何在途防護。副問題（同缺陷類，反向）：undoRating 在途
（`await store.actions.undoLastRating` 窗口）時，頁面 click 路徑直呼 rateCard
（mc 選項按鈕等不经 keydown state gate）→ 評分照跑，同樣交錯。
「單向鎖＝沒鎖」：兩條寫鏈共用同一狀態域（reviewLog/cards/_undoSnapshot/session/results），
必須雙向互斥才算修復。

## 修法（三檔同構；undoRating 頭尾加鎖；rateCard 零改動）
檔：`src/engine/session-utils.js`、`src/engine/session-mc-utils.js`、`src/engine/session-spell-utils.js`

undoRating 由：
```js
export async function undoRating(store, renderFn) {
  if (!_undoSnapshot) return;
  ...body...
  _undoSnapshot = null;
  renderFn();
}
```
改為：
```js
export async function undoRating(store, renderFn) {
  if (!_undoSnapshot) return;
  if (_ratingLock) return; // C8: 評分 in-flight 期間 undo 丟棄（與 rateCard :93 共鎖雙向互斥）
  _ratingLock = true;
  try {
    ...body 原樣（await store.actions.undoLastRating 起至 _undoSnapshot = null）...
  } finally {
    _ratingLock = false; // C8: 任何路徑釋鎖（含 await 拋錯——undo 半途而廢不永久鎖死）
  }
  renderFn();
}
```
- 丟棄語意（silent drop）與 rateCard 連按（:93 丟棄）對稱；Anki undo 亦是單飛。
- `renderFn()` 移入 try 外（finally 之後）：renderFn throw 不再留鎖（同 C10 前防線，雙保險）。
- body 零改動：undo 語意（C1 快照、C2 承接、A5/C7 旗標）不動。
- 每處加 `// C8:` 標記（驗證腳本靜態斷言用）。

### 可選項定案（憲法⑦）
- **undo 排隊（延後執行）而非丟棄**：不做。連按/連點的排隊會造成「按了沒反應後來突然跳一格」
  的驚跳感；rateCard 連按既有語意即丟棄（C3 已定案 6324eb4），undo 對齊同一語意。
- **rateCard 加 try/finally（C10）**：不做，屬下一顆（一 bug 一 commit）；本修法 undoRating
  自帶 finally 不依賴 C10。
- **incrementGoal await（C9）**：不做，屬再下一顆。本修法後 in-flight 窗口仍含
  incrementGoal fire-and-forget（goal 域，非本 bug 的卡狀態域）。
- **keydown 層加鎖 gate（`if (_ratingLock)` 於 handler）**：不做。鎖查在函式頭是單一
  權威點（表決：undoBtn click 路徑也要擋，handler 層擋不全）。

## 消費者清單（憲法②）
- `_ratingLock` 讀寫點（修後）：三檔 rateCard check/set/catch 釋/renderFn 前釋（既有）
  ＋ undoRating check/set/finally 釋（新增）。全庫 grep 實錘僅三檔，每檔 8 處（宣告 1＋
  rateCard 4＋undoRating 3）共 **24 處**（v1.1 修 #2 筆誤：原誤植 21）。
- `undoRating` 呼叫端：三檔 mount 內 undoBtn click＋Ctrl+Z 共 6 處，全部 fire-and-forget
  ——鎖查在函式頭全覆蓋（call site 零改動）。
- `_undoSnapshot`：本修法不改其生命週期（body 原樣）。
- 驗證腳本既有 lock 斷言：verify-c3-rating-lock（rateCard 連按語意，不動）、
  verify-c7-undo-gate（undo 觸發斷言——其 rateCurrent 全程 await，鎖已釋後才 pressUndo，
  零冲击；列回歸必跑）。

## 驗證方式（tools/verify-c8-undo-race.mjs，法④先行實跑）
C3/C7 harness 三件套 mock＋真實 store/engine；**store.actions.rateCard /
undoLastRating 以可開閘 deferred 包裹**（模擬慢 DB，把 in-flight 窗口拉成可控確定態——
非時間擡測）：
- T1（flip 主鏈路）：評 A 完成 → B 翻面 ANSWER → 開 rate 閘→ fire rateCard(B)（不 await）
  → **同步＋微任務刷新後**斷言：undo spy 計數（Ctrl+Z 已派發）＝修前 1（對 A 快照誤 undo）
  ／修後 0（鎖丟棄）。放閘 → 評分化落地。
- T1b（修後正向不誤傷）：放閘鎖釋後再按 Ctrl+Z → undo 生效（B 還原，current 回 B、log -1）。
- T2（反向互斥）：undo 在途（undo 閘開）時直呼 rateCard → 修前 store.rate spy +1（交錯）
  ／修後 0；放閘 undo 完成。
- T3/T4（mc/spell 同構）：T1 等价 mc（pickAnswer+rate）與 spell（submitAnswer+rate）鏈路。
- T5（靜態標記）：三檔含 `// C8:`；負控制斷言不存在。
- T6（C7 回歸釘）：鎖釋後完成畫面/QUESTION undo 仍照常（抽一鍵）。
- 負控制標準做法：/tmp 副本 `git show HEAD:<三檔>` 覆蓋＋`--expect-legacy` 全綠
  （bug 精準重現：T1 誤 undo=1、T2 交錯=1、T3/T4=1、T5 標記零）。

### 送審前實跑紀錄（2026-08-27 v1.0 凍結；v1.1 加 T7 後複跑）
- 負控制：HEAD 三檔（未修）＋`--expect-legacy` → **14/14 ALL PASS exit 0**（bug 精準重現：
  T1 in-flight 誤 undo=1、放閘 log 淨=1（A 誤刪 B 落庫）、T2 交錯評分=1、mc/spell=1、標記零；
  T7 屬性釘兩態恆綠）
- 未修態正常模式：**8 FAIL exit 1**（紅集＝T1×2,T2,T3,T4,T5×3；恆綠=T1前置,T1b,T2前置,T6×2,T7）
- 修法副本（/tmp/c8v）：正常模式 **15/15 ALL PASS exit 0**
- T7 驗牙（M-c 重演 /tmp/c8m：finally 換順序釋鎖）：**恰 1 紅＝T7（got=0 鎖卡死）**——牙確認

## 動工後實跑（憲法⑧）
- 三檔 undoRating 加鎖 + try/finally 實裝 → `node --check` 三檔 OK
- verify-c8 正常（修法後）：**17/17 ALL PASS exit 0**（T8 補牙後斷言數增至 17）
- verify-c8 `--expect-legacy` 對 HEAD 未修三檔（/tmp/c8leg）：**16/16 ALL PASS exit 0**
- 回歸組合拳全綠：c3=0 / c7=0 / c1=0 / undo-cycle=0 / next-after-undo=0 / c5=0 / c6=0
- vite build ✓ 734ms

## 實裝事故紀錄（誠實歸責，2026-08-27）
動工首次實裝時，python 三段 patch 把 undoRating body 段（含 `_undoSnapshot = null;`）用
`end` 錨點切分，替換字串重建 body 時**整行 `_undoSnapshot = null;` 被遺漏**（既不在 try 內、
也未補回），導致 undo 完成後 engine 快照未清 → 第二次 Ctrl+Z 重複 pop results。verify-c8
當時未抓到此（其 T1b 只驗 undo 觸發、不驗二次 no-op）；**是回歸組合拳的 verify-c7
T3（results 5 vs 6）＋T4（重複 undo）組合逮到**。根因非修法設計錯誤，是實裝手誤＋驗證腳本
本尊盲區。處置：① `_undoSnapshot = null;` 補入 try 尾（body 完成必清、拋錯保留屬 undo
事務化範圍外）；② verify-c8 補 **T8 快照必清釘**（undo 後二次 Ctrl+Z no-op + results 不重複
pop），並用「刪除該行」變異驗牙（T8 精準紅＝恰 1 FAIL）。
教訓（入 memory 候選）：**重構函式體改動後，單跑本尊 bug 腳本不足——undo 鏈必跑
c7+c3+c1+undo-cycle 全套回歸；且 try/finally 包裹類修法，驗證腳本必須含「狀態清理完成」
正向釘，不能只驗「拋錯路徑釋鎖」。**

## 審查紀錄（憲法⑤）
### R1（v1.0 送審，3 委員）——全 ✅
- **#1 修法正確性 ✅**：第三條寫鏈窮舉（rateCard/undoRating/ensureQueue/flipCard/pickAnswer/
  submitAnswer/requeueIntraday/exam flushPendingScore/頁面層）——目標域唯一兩條非同步寫鏈
  即 rateCard↔undoRating，雙向互斥完整；死鎖/漏釋逐路徑安全（body 無早退、finally 必達、
  renderFn 在 try 外）。非阻斷觀察：**完成畫面 completion-undo 在途時 store notify→
  ensureQueue 命中 reset 分支**＝C7 路徑 pre-existing 競態（非本修法引入）→ 登範圍外後續單。
- **#2 消費者/治理相容 ✅**：undoRating 全庫恰 6 呼叫端窮舉屬實；函式頭鎖＝單一權威點
  （handler 層 gate 不做屬正確）；mc data-r4 評分按鈕直呼 rateCard 繞 keydown gate 實錘、
  T2 覆蓋成立；/tmp/c8v 實跑 verify-c3 26 斷言＋verify-c7 32 斷言＋c1/undo-cycle/next-after-undo
  全綠＝零逆轉。瑕疵：計數 21→24（v1.1 已修）。
- **#3 驗證方法學 ✅**：三態獨立重跑復現；變異牙檢 M-a（剝 check）紅集＝{T1,T3,T4,T1log}、
  M-b（剝 set）紅集＝恰{T2}互不串擾、M-c（剝 finally）**存活**→ F1 補 T7（v1.1 已補並驗牙）；
  閘門確定性（入口同步 spy＋受控掛起）審查通過；負控制 1vs2 機制真實。F2 計數瑣碎（已修）。

## 風險
- undo 由「照跑但可能炸狀態」改「in-flight 期間丟棄」：用戶在極速連點下少 undo 一次，
  再按即補——相對於狀態損壞屬嚴格改善。
- undoRating 取得鎖後若 body 拋錯：finally 釋鎖，undo 半途（store 已 undo、engine 同步段
  未跑完）——此半途風險**修前同樣存在且更糟**（修前連鎖都沒有）；登範圍外：undo 事務化
  （需 store 層 rollback 設計）另案。
- 三檔 mount 的 call site 不動 → C7 修法（gate 放寬＋mount 早退）零衝擊，verify-c7 列回歸。
- 回滾：移除 undoRating 三行＋try/finally 包裝即復原。

## 範圍外（憲法⑥登記）
- C10：rateCard 鎖無 try/finally（easter-egg throw 永久鎖死）——佇列下一顆。
- C9：incrementGoal fire-and-forget goal 覆寫——佇列再下一顆。
- undo 半途而廢的事務化回滾（store 層 rollback）——新特性另案。
- keydown handler 層鎖 gate——見可選項定案（不做）。
- **C8-SR0（R1#1 發現）**：完成畫面 completion-undo 在途時 store notify→re-render→
  ensureQueue 命中 `session.reset()` 分支清 results——C7 路徑 pre-existing 競態
  （非本修法引入、同白名單三檔）→ 列後續 bug 單呈總統裁示。

## 審查
動 undo/lock 核心 → 依法 3 委員。重點：#1 修法正確性（雙向互斥完整性：还有没有第三条
写链绕锁？）、#2 消費者/呼叫端窮舉＋與 C3/C7 相容、#3 驗證方法學（閘門設計的確定性、
負控制有牙）。
