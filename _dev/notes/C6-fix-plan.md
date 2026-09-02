# C6 Fix Plan v1.2 — dashboard 同頁「待複習」數字互相矛盾（hero vs 字本 grid）

## Bug 定義
同一 dashboard 頁（同 mode tab 下）：
- **hero :98 + 概覽 statTile :149**：`modeDue = s.dueCount` = scheduler.getDueCards 的 `due.length` — 含 learning＋cap 後 review＋**new 卡額度**，排除 buried/suspended。
- **字本 grid :859-913**：每 deck 自己算 `isDue = card && due<=today && state!==0` — 含 buried/suspended、含**超 cap 的 review**、**不含 new**、learning 計入。
→ 各 deck「待複習」加總 ≠ hero「待複習」（三個方向的分歧：new 計入與否、buried/cap 排除與否）。使用者看到的是同一頁互相矛盾的數字。

## Root cause（2026-08-27 實錘）
- `src/pages/dashboard.js:59`：modeDue 取 `s.dueCount`（權威可學數，C5 剛對齊）。
- `src/pages/dashboard.js:877-883`（renderDeckGrid.isDue）+ `:160-186`（computeCombinedStats，其 due 欄實際無顯示消費者＝死欄位）：第二套平行實作，語意各缺一片。
- 沒有單一來源：grid 從不經 scheduler。

## 修法（dashboard.js 單檔）
單一真值源 = C5 後的 getDueCards，一次呼叫、集合共用：
1. `render()` 內以當前 mode 引數（逐字 copy store.js:486-503 的 per-mode fallback 鏈：ankiSettings{,Mc,Spell}.cardsPerDay / tz / ratedNew{,Mc,Spell} / simParams{,Mc,Spell}.maxReviewsPerDay fallback）呼叫 `getDueCards(words, modeCards, buriedM, suspM, ...)`（dashboard 已 import scheduler.js，補 getDueCards import）。
2. 構造 **reviewDueSet**：`due` 中剔除 new 卡（`!modeCards.get(id)` 者＝無卡 new）→「待複習」＝learning＋relearning＋review 且今日可學、未 buried/suspended、cap 內。**new 卡不標「待複習」**（Anki 語意：new ≠ due；hero 已有獨立「新詞」tile）。
3. hero :98 / statTile :149 顯示 `reviewDueSet.size`（原 s.dueCount 含 new → 一併改成嚴格待複習語意）。
4. `renderDeckGrid(decks, words, cards, s, dueSet)`：`isDue` 改 `dueSet.has(word.id)` → Σ grid == hero 天然成立。
5. computeCombinedStats 的死 `due` 欄：改接 dueSet（順帶，零顯示影響）。

### 可選項定論
- hero 改顯示 `reviewDueSet.size`（丟 new）→ **做**：root fix 就是單源；且 new 混入「待複習」本身就是第 4 種矛盾（hero 待複習 vs 新詞 tile 重複計數）。main.js badge 的 dueCount（可學語意）不動 — 那是 app 圖標層「可學」非頁面「待複習」。
- 模擬器 maxReviewsPerDay=0 → cap 不觸發，Set 自然正確。
- 不動 store.js（白名單外，且 s.dueCount 仍需給 badge）。
- 範圍外：badge 語意「可學 vs 待複習」命名規範；renderDeckGrid 每 deck 顯示「可學(含 new)」視圖（新需求非 bug）；store due 三連呼效能（refreshDerived 端，另案）。

## 驗證方式
`tools/verify-c6-dashboard-due.mjs`（--experimental-test-module-mocks；svg/chart mock 脫除 vite ?raw，render 為純字串函數）：
- 兩 deck fixture：deckA 混 new/learning/review(≤today)/超cap review/buried review/suspended review；deckB 純 new。cap=1、cardsPerDay=2。
- T1 渲染字串抽「待複習」全部數字：hero 數字 == statTile 數字 == Σ grid 數字（各處恰 1/1/2 處存在性斷言）。
- T2 語意錨點：hero=2 ＝ {r_early, lrn}；buried/suspended/超 cap/new 不計入；learning 計入。
- 負控制（--expect-legacy，/tmp HEAD 還原 dashboard.js）：hero=99(sentinel dueCount) ≠ Σgrid=6（舊平行實作含 buried/susp/超cap/learning）— bug 實錘。
- 回歸：node --check、vite build、verify-c5（同調用鏈上游）、verify-a6。
- （v1.1 偏離記錄）原 T4「mode 切換渲染」取消：`_dashboardMode` 為模組私有 let、無 setter，測試不可達；mc/spell fallback 鏈改由 source-review 靜態核對（委員 #2 職責）。原第 5 點 computeCombinedStats 死 `due` 欄改接 dueSet 取消：本檔無渲染消費者，動它只增 diff 面積——死欄位原樣登記不動。（R1#1 糾正：原宣稱「全庫 stats.due 零消費者」有誤 — settings.js:116/321 渲染的是 **store 版** computeCombinedStats 的 due（另一套平行實作、不同頁面，非本 bug 同頁矛盾範圍）→ 登 scope-requests SR2。）
- （R1#3 ❌ 修訂 v1.2）剔除條件補 `c.state === STATE_NEW`：state-0 容器卡（跨 mode 評分/undo 承載，store.js:194/323）在 cards 內 truthy 但 scheduler 歸 newQueue，原一行剔件會誤計「待複習」；fixture 補 a0 容器卡釘死。tzM 同步改逐字鏡像 store fallback（原 x??x 死式，R1#1 M1）。

## 風險
- 低-中：顯示層單源化；唯一行為變化＝hero 待複習不再含 new 卡數（变小、更貼 Anki）、grid 數字不再含 buried/suspended/超 cap（= 實際可學）。
- getDueCards 在 render 多呼一次（原本 s.dueCount 是 refreshDerived 快取）：純函數、O(words)，儀表板每渲染一次頂多多一次線性掃描，可忽略。
- fallback 鏈與 store.js 逐字鏡像 → 若未來 store 改引數需兩處同步：腳本以 mc/spell simParams fallback 斷言釘住。

## 審查等級
單檔、顯示層，但改三個顯示點語意＋新增 scheduler 呼叫 → 3 名委員。

## 狀態
- [x] 根因查證（行號實錘）
- [x] 驗證腳本實跑（正向 7/7 + 負控制 6/6 雙向四象限有牙）
- [x] 送審 R1（3 委員：#1 ✅ #2 ✅ #3 ❌ state-0 容器卡 MED）
- [x] v1.2 修訂（剔件補 STATE_NEW＋tzM 鏡像＋fixture 補 a0）→ R2 #3 複審 ✅ → commit
