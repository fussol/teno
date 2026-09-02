# C9 修復計畫書 v1.1 — incrementGoal fire-and-forget → undo 的 goal 還原被 in-flight 寫入覆寫

## 1. Bug 定義
用戶評分後立刻 Ctrl+Z undo（常見操作），goal streak「今日已達」可能被幽靈寫入覆寫：
undo 已把 `goal_streak` 還原為評分前值，但先前評分觸發的 `incrementGoal`（未被追縱的
fire-and-forget promise）其 DB 寫入若**後於** undo 的還原寫入落庫，最終 DB 又變成
「今天已統計」→ 用戶明明 undo 了，重開 app 後每日目標仍顯示今天完成（幽靈進度）。
記憶體態在 undo 後正確，但 DB 是持久化真值源 → 重啟即回靈。

## 2. Root cause（2026-08-28 實錘，行號為當今 HEAD 實際行號）
- `src/engine/session-utils.js:105`：`store.actions.incrementGoal('flip').catch(() => {});`
  （同構：`session-mc-utils.js:119`、`session-spell-utils.js:116`）
  fire-and-forget，回傳 promise 被丟棄，無任何追縱。
- `src/lib/store.js:1095-1115 incrementGoal`：同步段（push today + computeStreak +
  `updateGoalStreak` 頭部 state 合併）在呼叫 tick 內完成；**非同步段**
  `await db.saveGoalStreak → await refreshDerived → notify` 在呼叫者之外續跑。
- `src/lib/db.js:600 saveGoalStreak`：`JSON.stringify(data.dates)` 參數在呼叫點即定值
  （payload 穩定），但 `await execute(...)` 落庫視併發交錯——兩個寫者對同一
  `goal_streak` 表寫入，無 happens-before。
- undo 端：`store.js:932-945`（`undoLastRating` 內 goalStreak 還原）讀
  `snap.goalStreakBefore`（store.js:681 `JSON.parse(JSON.stringify(...))` 深拷貝，
  **讀端正確**）→ 還原記憶體 → `await db.saveGoalStreak`（W2）。
- 競態序列：W1(incrementGoal，含 today) 在 rateCard tick 發出；W2(undo 還原) 在後一個
  macrotask 發出（C8 鎖於 rateCard 同步尾釋放，undo 立即進得來）。兩筆非同步
  `db.execute` 無序列化保證；W1 後落 → DB 覆寫 → bug。

註：稽核單（2026-08-13）行號 session-utils.js:101 → 實際 :105（C8 commit 後漂移），依鐵律⑥登記。

## 3. 修法（三同構檔各 2 加 1 改，共 ~12 行）— v1.0 變體 B
以「promise 追縱鏈 + undo 前 drain」封堵，store/db 零改動。**行為保真原則**：
`incrementGoal(...)` 維持在 rateCard 呼叫點**立即執行**（記憶體同步 push／localStorage
計數／DB 寫發出的時序與現行逐字相同），鏈只追縱「完成」不延後「呼叫」：

1. 模組層（`_ratingLock` 宣告旁）新增：
   `let _goalPending = Promise.resolve(); // C9: incrementGoal in-flight 追縱鏈（undo 前必排空）`
2. rateCard 內 fire-and-forget 改為追縱（呼叫點、時機不變）：
   ```js
   const _goalP = store.actions.incrementGoal('flip').catch(() => {});
   _goalPending = _goalPending.then(() => _goalP); // C9: 追縱完成，undo 前統一排空
   ```
   - 鏈尾覆蓋所有尚未落地的 increment（單變數只記最後一筆＝漏洞，見 §7 棄案論證）。
   - `_goalPending` 永不 reject（.catch 在 p 上）；正常情形每次評分後鏈即落地，undo 零延遲。
   - 呼叫點仍在 `_ratingLock` 持有區間 → 鏈賦值無並發竞争（JS 單線程＋鎖內）。
3. undoRating 內、取得 `_ratingLock` 之後、`store.actions.undoLastRating` 之前：
   `await _goalPending; // C9: in-flight goal 增量必全數落地後才還原（goal_streak 寫序序列化）`
   - 在 try 內 → 拋錯由 C8 finally 釋鎖。
   - 效果：undo 的還原寫入 W_und **必然晚於全部 increment 寫入落庫** → 幽靈覆寫路徑閉合。
   - increment 彼此間寫入順序不再約定，但 payload 同含 today（`includes` 冪等 push）→ 無害。

棄案（§7 詳）：變體 A `_goalPending.then(() => incrementGoal(...))` 把「呼叫」也延上鏈
——慢 DB 時記憶體 push 延後 → 下一張卡 `goalStreakBefore` 快照窗口錯位 → 反而引入新時序差異。

改動行數：3 檔 ×（1 宣告 + 2 行改寫 + 1 行插入）≈ 12 行。非共享外部檔（store.js/db.js 不動）。

## 4. 驗證方式（tools/verify-c9-goal-undo-race.mjs）
harness 沿用 C8 範式（FakeDatabase + mock 三件套 + jsdom + 真 store/engine），
閘門位於 **db.saveGoalStreak 層**（mock.module db.js 透包裝＋payload 呼叫時刻深拷貝快照＝
生產 execute 掛起前參數定值語意）——記憶體同步段與生產逐字同序，只有 DB 落地受閘。
全部確定態、無時間擡測。

- T1 flip 主鏈路：全新 state（dates.flip=[]）→ 開閘 → 評 A（store.rateCard 真跑、
  increment 掛起）→ pressUndo → 斷言 in-flight 窗口內 undoLastRating 觸發數
  （LEGACY=1 / FIXED=0）→ 放閘續跑 → 斷言**記憶體** `goalStreak.dates.flip.length`
  （LEGACY=1 幽靈 / FIXED=0）＋**DB goal_streak 表**解析後 flip 長度（LEGACY=1 / FIXED=0）。
  → 雙態、記憶體＋持久化雙面、斷言有牙。
- T2 回歸釘（兩態恆綠）：無閘評分→undo 照常生效（log 1→0、dates=[]、鎖正常）。
- T3/T4 mc/spell 同構鏡像（含各自 mode 的 dates key 與 goalStreakBefore 路徑）。
- T5 靜態標記：三檔含 `// C9:`（LEGACY=0 / FIXED=1）。
- T6 鏈式序列化釘：連評兩卡（雙閘掛起）→ **亂序放閘（先 B 後 A）** → undo 必等全鏈排空；
  「單變數只追最後一筆」變體在此轉紅（R1#2 變異實錘：恰該釘紅、餘綠）。終態釘為行為保真
  （undo B 不誤刪 A 之正當 today，兩恆態=1，自註無幽靈可辨）。
- T7 屬性釘（兩態恆綠）：incrementGoal 拋錯（reject）不拖垮 undo、鎖必釋。
- T8 drain 鎖覆蓋釘（R1#3-F1 採納）：drain 掛起期間鎖必持有 → 第二次評分被 lock 丟棄
  （rateCalls spy 鑑別）＋終態 log 乾淨；封堵「drain 放鎖外」TOCTOU 變體（check-acquire
  原子性破壞 → 第二評竄入覆寫快照 → undo 錯靶）。
- 負控制：`/tmp` HEAD 副本（git show 三檔）跑 `--expect-legacy` 必 ALL PASS＝舊碼 bug
  精準重現；正常模式對未修碼跑→辨證斷言集必紅（送審前實跑雙向留證）。
- 回歸組合拳：verify-c8-undo-race、verify-c7-undo-gate、verify-c3-rating-lock、
  verify-c1-undo-modes + `node --check` 三檔 + `vite build`。

## 5. 風險
- undo 前 `await _goalPending`：鏈滯留＝incrementGoal 的 DB 往返尚未落地（通常已 resolve，
  零延遲）。极端情況（DB 卡住）undo 多等一次 DB 往返，不鎖死（finally 兜底；且評分路徑
  本來就 await 同規模 DB 往返）。
- incrementGoal 改為鏈上執行：其內部行為（localStorage _totalRated 同步累加、dates push）
  延後到鏈微任務執行點——與評分渲染路徑無耦合（rateCard 不同步讀 goal）。
- 兩張卡連評後單次 undo：`goalStreakBefore` 快照在 store.rateCard 捕獲時，前一筆 increment
  的**記憶體同步 push** 已落 state（呼叫 tick 內），快照必含 today → undo 後 today 保留，
  正當進度不误傷（T6 覆蓋）。

## 6. 範圍外清單（憲法⑥登記）
- C9-SR?（不登，呈總統備註）：`_totalRated`（G4 生涯計數）undo 不回滾——评分即 +1 生涯數，
  undo 後幽靈 +1。屬 G4 域延伸，非本單「undo 還原被覆寫」命題。
- store 層 per-mode goalStreak 寫入序列化（DB 層單寫者队列）屬 store.js 域（非 PM1 白名單），
  engine 鏈已封堵**本 mode 並發路徑**；全面 DB 序列化屬後續另立單。逐名登記（R1#1-F1/R1#2-F1、F2 採納）：
  1. **跨 mode payload 串道幽靈**：`goal_streak` 為單行全 mode payload（db.js:607 整包 dates），
     三檔 engine 鏈互不相見。flip 慢寫掛起＋ms 級切 mc 頁評分/undo 交錯 → mc-undo 的整包還原
     可能被 flip 後落寫覆寫（flip 幽靈復活）。本單不封堵，歸 store 層序列化另立單收斂。
  2. **settings 第三寫者**：`settings.js:980/:1086 → updateGoalStreak → saveGoalStreak`（改
     dailyGoal）。payload 取 live 記憶體（含已同步 push 的 today），對 dates 無害；與 undo
     交錯需跨頁零延遲點擊，可忽略。同隨該單收斂。
- 多級 undo、`refreshDerived` 殭尾 notify：無狀態破壞（純重渲染），不動。
- `rateCard` 的 `_ratingLock=false` 不在 finally（同步段拋錯鎖死）＝C10 本尊（佇列下一顆），非本單。

## 7. 可選項定案（憲法⑦）
- （做）鏈式 `_goalPending` 而非「rateCard 頭 await」：後者把 goal DB 往返塞進評分关键路徑，
  增加渲染延遲，且無法防止兩評分間 increment 併發交錯 → 棄。
- （做）undo 端 drain 於鎖內：與 C8 互斥語意一致（鎖持有期間無第三方寫者）。
- （不做）store.js 端改動 → 白名單外，上列範圍外。
- （不做）undo 回滾 `_totalRated` → 範圍外（見 §6）。

## 8. 審查紀錄
**R1（2026-08-28，3 委員）**：#1 ✅（修法五點逐項核證＋/tmp 套修法 29/29＋HEAD 覆蓋負控制 29/29＋
單變數變體轉紅實錘；F1 跨 mode 幽靈措辭補強→採納 §6）；#2 ✅（incrementGoal 消費者三檔零漏網＋
goalStreak 寫者窮舉含 settings 第三寫者＋undo 域四腳本 HEAD/修後雙態 exit 0＋四象限無假綠方向；
F1/F2 逐名登記→採納 §6）；#3 ❌（變異 A 恰紅✅ 變異 B 恰紅✅ **變異 C「drain 放鎖外」存活**——
自建探針實錘 TOCTOU：第二評竄入→undo 錯靶；處方補 T8→採納；另 T2 mode 參數脆弱→修、
T1 對棄案變體偽綠→註明依賴 T6）。
**v1.1**：產品碼修法不變（drain 本就在鎖內，#3 確認決策正確僅腳本未執約）；腳本補 T8＋rateCalls
spy＋T2 參數修正；§4/§6 升版。
**R2（2026-08-28，#3 席位複審）**：✅ 放行。變體 C（鎖外 drain）→ T8 恰 2 斷言轉紅餘 31 綠
（R1 缺口閉合）；變體 B（刪 drain）→ 恰 10 紅可與缺標記分辨；基底修法 33/33 ALL PASS；
undo 域四回歸修後 exit 0；§4/§6/§8 無宣稱超載。編輯小疵兩處（§4 閘層描述、T7 目次）已補。
總計：審查 2 輪 4 人次，全席 ✅。
