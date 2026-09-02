# B2 — autoNext 延遲窗計分競態（三頁 pendingScore 統一）（v4 — 定案 ✅）

狀態：**第 3 輪 3/3 ✅ 通過 — 定案可實作（2026-08）**
關聯：v3 定案 ⚠️→✅（語法修正後）「B2. autoNext 延遲窗」

## Bug 定義

三頁測驗（flip/mc/spell）在「作答」時**立即計分**（`e.correct++`/`e.wrong++`），但**跳下一題**由 `setTimeout(nextWord, delay)` 延遲執行。延遲窗（作答後 ~delay 秒）內若使用者退出或離開頁面，殘留 timer 會：

1. **計分與進度分裂**：作答瞬間 `correct/wrong` 已 +1、但 `idx` 尚未前進 → 退出存檔後 `session.idx` 仍指當前題；mc/spell 的 exit **根本沒清 timer** → timer fire 時頁面已離開 exam → `nextWord` 無任何 guard → `idx++` 錯位 + `renderInPlace` **蓋掉 config 頁/其他頁**。
2. **spell 末題失控**：spell `submitSpelling` 末題直接 `setTimeout(() => { e.phase='result'; renderInPlace(s); }, ms)`（exam-spell.js:263）→ 退出後殘留 timer **強制跳結果頁**。
3. **mc/spell 無 timer 管理**：裸 `setTimeout`（exam-mc.js:274、exam-spell.js:261/:263），無 clear、無殘留防護。
4. **B1 遺留同步級聯 bug（第 1 輪委員 #3 實錘）**：exam-flip.js:381 onMount guard `if (e.judged && e.settings.autoNext && !e.autoNextTimer) nextWord(s);` 在**作答瞬間**誤觸發 — B1 的 answerCorrect/answerWrong 順序是「計分 → `renderInPlace(s)`（:281/:292）→ **之後**才設 autoNextTimer（:284/:295）」，renderInPlace 觸發 onMount 時 `autoNextTimer` 仍為 null → guard 成立 → 同步 `nextWord` → 重入 renderInPlace → guard 再成立（judged 未重置、timer 仍 null）→ **遞迴級聯直到 idx>=length → 作答第一題瞬間整場跳結果頁**。
5. **B1 遺留補跳路徑級聯（第 2 輪 3 委員一致實錘，v2 修法殘餘）**：`e.judged` 在 `nextWord`（:299-310）**從不重置**（只重置 `answered`/`cardStart`）。即使作答路徑級聯被消除（timer 先設），**bottom-nav 返回補跳路徑**（:381 guard → 直呼 nextWord，無任何 timer）仍級聯：補跳 nextWord 內 renderInPlace 重入 onMount → guard 再成立（judged 仍 true、timer 為 null）→ 遞迴直跳結果頁；同根因造成 **timer 正常 fire 推進後 stale judged 誤跳未答題**、**第一場結束 judged 殘留 → 再考開場即級聯**、**補跳重入 onMount 不 return → 同一 DOM 重複綁定 → 單擊雙計**（flip 的 answerCorrect/Wrong 無作答 guard，不像 mc :266/spell :247）。

**範圍**：三頁作答計分路徑（flip `answerCorrect/answerWrong`、mc `pickOption`、spell `submitSpelling`）＋ timer 路徑（設/清/guard）＋ 結束路徑（末題 result、exit）＋ onMount 補跳（flip 修正既有、mc/spell 新增）。

## Root Cause

計分（`correct/wrong++`）與推進（`idx++`）**不在同一原子動作內**：作答瞬間計分、延遲窗後推進；且 flip 的 `judged` 全域旗標生命週期不完整（nextWord/startExam 不重置），與 onMount 補跳 guard 在多條路徑形成同步級聯；timer 設定在 `renderInPlace` 之後、callback 先清後跳，加劇重入。任何中斷（exit / bottom-nav 離開 / 頁面切換 / 再考）都會造成計分與進度分裂或殘留 timer 蓋頁。

## 修正方案（v3 — 吸收第 1/2 輪 6 委員盲點）

### 核心機制 A：`e.pendingScore` 延遲計分（三頁同款）

- 作答時**不再立即計分**，改寫 `e.pendingScore = 'correct' | 'wrong'`（**不序列化進 session**，v3 定案）。
- **唯一 flush 語法**（v3 定案，冪等：null 後 no-op，可安全多點呼叫）：
  ```js
  function flushPendingScore() {
    if (e.pendingScore) { e[e.pendingScore]++; e.pendingScore = null; }
  }
  ```
- **flush 點**：`nextWord()` 開頭（guard 之後；涵蓋 timer fire、手動下一題、補跳）、末題「查看結果」按鈕分支、`exit handler`（v3 ⚠️ 採「exit 前 flush」— 計分不遺失）。
- **重置點**：`startExam` 與 `resumeSession` 設 `pendingScore = null`（防殘留污染新場）；`resumeSession` 重置**置函式頂**（任何 early return 之前）。

### 核心機制 B：Timer 順序修正（消除作答/timer 路徑級聯）

三頁作答函式的 timer **設定移到 `renderInPlace(s)` 之前**，callback **先 `nextWord(s)` 後清 timer**：

```js
if (e.settings.autoNext) {
  if (e.autoNextTimer) clearTimeout(e.autoNextTimer);
  e.autoNextTimer = setTimeout(() => { nextWord(s); e.autoNextTimer = null; }, e.settings.delay * 1000);
}
renderInPlace(s);
```

- 作答 renderInPlace 時 guard 見 timer≠null → 不 fire（作答路徑級聯消失）。
- timer fire 的 nextWord 內 renderInPlace 時 timer 尚未清 → 不 fire；nextWord 結束後才清（**不可**先清後跳：先清則 nextWord 內 renderInPlace 觸發 guard 再跳一次 → 每題跳兩次）。
- bottom-nav 返回補跳不受影響：timer 被 page guard 消費（callback 內 nextWord 被擋 return）→ 清 timer → 返回 onMount guard 條件成立 → 補跳。

### 核心機制 C：onMount 補跳 guard（消除補跳路徑級聯 — 第 2 輪 3 委員一致要求）

guard 語意：「當前題已判分、autoNext 開、timer 已被消費」→ 補跳且**補跳後 return（防外層 onMount 對新 DOM 重複綁定 → 單擊雙計）**；並**修復 flip `judged` 生命週期**（恢復「judged = 當前題已判分」不變量，一次消除補跳級聯／stale 誤跳／跨場殘留三路徑）：

- **flip nextWord（:299-310）**：在 `e.answered = false;`（:302）旁加：
  ```js
  e.judged = false;
  e.answeredCorrect = false;
  ```
  （renderExam 未答分支不讀 judged/answeredCorrect，重置對渲染無副作用；B1 的 judged 殘留本就無作用，僅 guard 受害。）
- **flip startExam（:204-226 reset 區塊）**：加 `e.judged = false; e.answeredCorrect = false;`（防第一場結束殘留 → 再考開場級聯）。
- **flip :381 guard** 改為（維持 B1 條件＋補跳後 return）：
  ```js
  if (e.judged && e.settings.autoNext && !e.autoNextTimer) { nextWord(s); return; }
  ```
- **mc onMount exam 區塊開頭（:353 前）新增**：
  ```js
  const w0 = e.words[e.idx];
  if (w0?._answered && e.settings.autoNext && !e.pendingNext) { nextWord(s); return; }
  ```
- **spell onMount exam 區塊開頭（:345 前）新增**：
  ```js
  if (e.userInput !== '' && e.settings.autoNext && !e.autoNextTimer) { nextWord(s); return; }
  ```

時序安全（第 2 輪委員模擬驗證）：mc/spell 的 guard 條件是 per-word/per-input 判定（`w0._answered`＝renderExam :137 同源、`userInput!==''`＝renderExam :131 同源），補跳後隨題重置 → **天然免疫級聯**；flip 靠 judged 重置免疫。timer 未 fire 即返回（timer 非 null）→ 不補跳，稍後正常 fire；resume 情境（pendingScore=null、mc pendingNext 由 B3 設定）→ 不誤觸；autoNext 關 → 不補跳（手動按鈕路徑）。**B2 單獨落地、B3 未到時**：mc resume 已答卡無 pendingNext → guard 補跳跳走（等同 flip firstUn 語意，優於現況卡死）。

### 1. exam-flip.js

| 位置 | 現況 | 改為 |
|---|---|---|
| :6-20 e 初始物件 | 無 pendingScore | 加 `pendingScore: null,` |
| :277-286 answerCorrect | `e.correct++;`（:278）且 timer 在 renderInPlace 後（:281/:284） | `e.pendingScore = 'correct';`；**保留 `e.results[e.idx] = true;`（B1，不可刪 — applyTags/resume 依賴）**；timer 區塊移到 renderInPlace 前＋callback「先 nextWord 後清」（機制 B） |
| :288-297 answerWrong | `e.wrong++;`（:289）同上 | `e.pendingScore = 'wrong';`；**保留 `e.results[e.idx] = false;`**；timer 同上（機制 B） |
| :299-310 nextWord | guard 後直接 `e.idx++`；只重置 answered/cardStart | guard 後先 `flushPendingScore()`（機制 A）；`e.answered = false;` 旁加 `e.judged = false; e.answeredCorrect = false;`（機制 C） |
| :381 onMount guard | B1 既有 | 維持條件＋補跳後 `return;`（機制 C：`if (e.judged && e.settings.autoNext && !e.autoNextTimer) { nextWord(s); return; }`） |
| :399-406 efNextBtn 末題分支 | `e.phase = 'result';` | 先 `flushPendingScore()` 再 result（手動查看結果無 timer fire） |
| :407-413 efExitBtn | clear timer → buildSession | clear timer → `flushPendingScore()` → buildSession |
| :204-226 startExam | 僅 clear timer（B1 :222） | 加 `e.pendingScore = null;` ＋ `e.judged = false; e.answeredCorrect = false;`（機制 C） |
| :228-275 resumeSession | 無 pendingScore 重置 | **函式頂**（:230 前）加 `e.pendingScore = null;`；兩分支（sentinel :252-254、firstUn :270-272）重置 judged 旁**一併重置 `e.answeredCorrect = false;`**（一致性） |

### 2. exam-mc.js

| 位置 | 現況 | 改為 |
|---|---|---|
| :6-16 e 初始物件 | 無 | 加 `pendingScore: null, pendingNext: null,` |
| :264-276 pickOption | `e.correct++/e.wrong++`（:270/:271）＋ 裸 `setTimeout(nextWord)`（:274，renderInPlace :272 之後） | `e.pendingScore = (idx === w._correctIdx) ? 'correct' : 'wrong';`；timer 設 pendingNext（設前防禦性 `if (e.pendingNext) clearTimeout(e.pendingNext)`）＋移到 renderInPlace 前＋callback「先 nextWord 後清」（機制 B） |
| :278-287 nextWord | 無 guard、直接 `e.idx++` | 開頭 guard：`if (e.phase !== 'exam' || s.state.currentPage !== 'exam-mc') return;`；guard 後 `flushPendingScore()`（機制 A） |
| :352-382 onMount exam 區塊 | 無補跳 | 開頭加機制 C 補跳（`w0?._answered && autoNext && !e.pendingNext` ＋ `{ nextWord(s); return; }`） |
| :362-369 emNextBtn 末題分支 | `e.phase = 'result';` | 先 `flushPendingScore()` |
| :370-381 emExitBtn | 無 timer 清理 | 開頭 `if (e.pendingNext) { clearTimeout(e.pendingNext); e.pendingNext = null; }`；buildSession 前 `flushPendingScore()` |
| :201-229 startExam | 無 | 加 `e.pendingScore = null;` ＋ `if (e.pendingNext) { clearTimeout(e.pendingNext); e.pendingNext = null; }`（對齊 flip :222 clear+null 模式；防禦性） |
| :231-262 resumeSession | 無 | **函式頂**（`if (!session) return;` :232 **之前**，字面符合機制 A）加 `e.pendingScore = null;` ＋ `if (e.pendingNext) { clearTimeout(e.pendingNext); e.pendingNext = null; }` |

### 3. exam-spell.js

| 位置 | 現況 | 改為 |
|---|---|---|
| :6-17 e 初始物件 | 無 | 加 `pendingScore: null, autoNextTimer: null,` |
| :245-266 submitSpelling | `e.correct++/e.wrong++`（:255/:256）；末題 `setTimeout(() => result)`（:263） | `e.pendingScore = isCorrect ? 'correct' : 'wrong';`；**保留 `w._correct = isCorrect;`（:254，applyTags :289-290 依賴，不可刪）**；**末題也走 nextWord**（v3 明定）；timer 統一設 autoNextTimer＋移到 renderInPlace 前＋callback「先 nextWord 後清」（機制 B） |
| :268-278 nextWord | 無 guard、無末題處理 | guard（`'exam-spell'`）＋`flushPendingScore()`＋末題判斷 `if (e.idx >= e.words.length) { e.phase = 'result'; renderInPlace(s); return; }`（focus setTimeout 留在非末題路徑，末題 return 前不 focus） |
| :344-389 onMount exam 區塊 | 無補跳 | 開頭加機制 C 補跳（`e.userInput !== '' && autoNext && !e.autoNextTimer` ＋ `{ nextWord(s); return; }`） |
| :358-365 esNextBtn 末題分支 | `e.phase = 'result';` | 先 `flushPendingScore()` |
| :368-373 esExitBtn | 無 timer 清理 | 開頭 `if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }`；buildSession 前 `flushPendingScore()` |
| :205-225 startExam | 無 | 加 `e.pendingScore = null;` ＋ `if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }` |
| :227-243 resumeSession | 無 | **函式頂**（:228 前）加 `e.pendingScore = null;` ＋ clear autoNextTimer |

### 配套與範圍控制

- **mc/spell nextWord 加 phase＋page guard**：B1 風險區（B1-fix-plan.md:177）明載「mc/spell 也有同款 autoNext timer 競態＋bottom-nav 離開無清理…另立議題」。B2 既在 mc/spell 引入 timer 管理，不加 guard 則 exit 後 timer fire 仍會蓋頁，故納入本批。僅兩行 guard，不動 main.js。
- **exit handler 全部 flush 後再 buildSession**：v3 ⚠️ 採「exit 前 flush」；結果頁計數維持 `e.correct/e.wrong` 來源，不動 renderResult。
- **buildSession/exam-session.js 不動**：pendingScore 不序列化（v3 定案）；B1 已序列化 results。
- **flip 的 `e.results[e.idx] = true/false` 寫入保留**（B1 核心，applyTags/resume 依賴）— B2 只延遲計分，**不延遲 results 寫入**（第 2 輪委員 #3 建議，明註防誤刪）。
- **cli.mjs 不動**（首相 A 的 A1/A2 未 commit 改動在工作區，B2 無關）；**chart.js / base.css / store.js / Cargo.toml 不動**（任務禁令）。

## 使用點窮舉（憲法第 2 條 — grep 三形態）

grep 形態一（計分寫入點 — `correct++|wrong++` 於作答路徑）：
- exam-flip.js:278（answerCorrect）、:289（answerWrong）— 改 pendingScore（**results 寫入保留**）
- exam-mc.js:270/:271（pickOption）— 改 pendingScore
- exam-spell.js:255/:256（submitSpelling）— 改 pendingScore

grep 形態二（setTimeout 設點，作答/推進路徑）：
- exam-flip.js:284/:295（B1 autoNextTimer，改順序＋callback 順序）
- exam-mc.js:274（裸 setTimeout → pendingNext 管理化）
- exam-spell.js:261/:263（兩分支 → 統一 autoNextTimer＋末題走 nextWord）
- exam-spell.js:273（nextWord 內 focus 輔助 setTimeout，50ms）與 :349（onMount scrollIntoView 100ms）：**不納入管理** — `el?.` optional chaining／detached element no-op 保護，exit 後殘留 fire 無副作用；列此註記維持窮舉完整性

grep 形態三（timer 清點與重置點）：
- exit handler：flip :408（B1 已有）、mc :370-381（補 pendingNext）、spell :368-373（補 autoNextTimer）
- startExam：flip :222（B1 已有）、mc :201-229（補 clear+null）、spell :205-225（補）
- resumeSession：flip :241（B1 已有）、mc :231-262（補）、spell :227-243（補）

`pendingScore` 寫入：flip :278/:289、mc pickOption、spell submitSpelling（3 頁各 1 點）；`flushPendingScore()` 呼叫：nextWord＋末題按鈕＋exit（3 頁各 3 點）。

## 驗證項目

> 模擬忠實性要求（第 1 輪委員 #3 立、第 2 輪 3 委員覆核）：**模擬 harness 必須以真實源碼控制流為藍本**（含 onMount guard 同步觸發、renderInPlace→onMount 重入、click handler 先設 judged/answered 再呼叫作答函式、fake timer id ≥ 1 防 `!0` 誤判、bottom-nav 切頁），**不得手抄計畫書 snippet** — B1/B2 v2 前例證明省略 guard 的模擬會漏掉同步級聯。

1. **Node 模擬（fake timers，忠實）**：flip 答 3 題（對/錯/對）→ 每次作答 renderInPlace 時 timer 已設（guard 不 fire、無級聯）→ timer fire 逐題 flush → 結果頁 `correct=2, wrong=1`、`pendingScore=null`、`results=[true,false,true]`（results 斷言僅 flip；mc/spell 以各自作答狀態為準）。
2. **Node 模擬：末題** — 答末題 → timer fire → nextWord flush → phase='result' 且計數含末題（三頁同測）。
3. **Node 模擬：延遲窗 exit（限 flip — 第 1 輪 3 委員一致）** — 答題後 0ms 即 exit → exit handler clear timer＋flush → session.correct/wrong 含該題、session.idx 停當前題 → **JSON round-trip**（undefined→null）→ resume（B1 firstUn）→ 從下一題續、**不重答不雙計**。mc 此場景 resume 續答由 B3 完成、spell resume 重問雙計為既有行為（見風險）— 不在本項範圍。
4. **Node 模擬：bottom-nav 離開返回補跳（三頁，第 2 輪補強）** — 答題 → timer 未 fire 即切頁 → timer fire 被 page guard 擋（不蓋頁、idx 不變）→ 返回 exam 頁 → onMount 補跳（flip :381 既有條件＋return；mc/spell 新增）→ **恰跳 1 題**（`idx` 增 1、`phase==='exam'`、guard 只 fire 1 次、未答題保留）→ 續答計數正確。補跳後單擊作答**不雙計**（return 防重複綁定）。
5. **Node 模擬：autoNext 關閉** — 答題 → 手動「下一題」/「查看結果」→ flush 正確計數（含末題手動分支）。
6. **Node 模擬：殘留 timer 計數** — exit 後快轉 delay*2，斷言無 callback 副作用 fire（mc/spell 新增；flip B1 已有）。
7. **Node 模擬：級聯回歸（第 2 輪補項）** —
   a. 作答第一題（含 onMount guard）→ 不級聯（B1 遺留 bug 已修）；
   b. **補跳路徑**（機制 C 情境）→ 不級聯（v2 殘餘 bug 已修，guardFires=1）；
   c. **第二場再考**：第一場結束（judged 殘留）→ startExam 重置 → 開場作答不級聯；
   d. **stale judged**：timer 正常 fire 推進到未答題 → 離開再返回 → 不誤跳未答題；
   e. 全程斷言 `results.length === words.length` 不變（無越界寫入）。
8. **源碼 grep 覆核**：三頁作答路徑無裸 `e.correct++/e.wrong++`；三頁 timer 設定皆在 renderInPlace 前、callback 皆先 nextWord 後清；flip 保留 `e.results[e.idx]` 寫入（`grep -n "results\[e.idx\]" src/pages/exam-flip.js` 應得 2 行）；**B1 回歸**：applyTags 亂序標籤、刪字錯位 lockstep、舊存檔 sentinel（B1 驗證 1/2/4/7/8 對照重跑）。
9. `npm run build`（vite build）通過。
10. 瀏覽器實測（環境允許時）：優先「答題→延遲窗內離開→返回」的 flip 流程（本次模擬失敗路徑）；三頁作答→延遲窗內退出→恢復續答，計數與結果頁一致。

## 風險

- **B1 遺留雙級聯 bug（作答路徑＋補跳路徑）屬 B1 範圍**：B2 以機制 B＋C 一併修正（驗證 7a/7b 實錘）；release note 明載。
- **judged 語意修正**：nextWord/startExam 重置 `judged/answeredCorrect` 改變 B1 殘留行為 — renderExam 未答分支不讀兩者，渲染無副作用；僅 guard 行為變正確。
- **計分延遲語意變更**：結果頁/存檔計數在「延遲窗內」較舊版少 1 — 只影響延遲窗內中斷的觀測；exit 前 flush 已消除存檔分歧。
- **spell 延遲窗 exit→resume 重問雙計**（既有行為，B2 不引入）：spell 不寫 per-word 作答狀態（`w._correct` 不序列化、resume :239 重置 userInput=''）→ resume 必然重問當前題 → exit flush 已計＋重答再計＝雙計。根治需 per-word 序列化＋resume firstUn（與 B3 同型），另立議題。本計畫書**不宣稱 spell 零雙計**。
- **mc 延遲窗 exit→resume 續答依賴 B3**（resume timer）：B2→B3 執行順序依賴明載；B2 單獨落地時 mc resume 已答卡由機制 C 補跳跳走（等價 flip firstUn 語意，優於現況卡死）。
- **mc applyTags 未答詞標 wrong**（`_picked=-1 ≠ _correctIdx`，exam-mc.js:298）：B2 後作答出口皆有 flush，**正常作答路徑無未答詞可達 result**；惟既有「無 mcData resume 卡」（`_picked=-1` 重渲染前）在 B2 單獨落地時仍可達 result 且被 applyTags 標 wrong（B1 既有、未惡化）→ **B3 計畫書必須加 applyTags 未答 guard**（v3 B3 已明載 #4 額外 bug）。
- **guard 新增**：mc/spell nextWord 加 page guard 後，非 exam 頁面呼叫 nextWord 的合法路徑會被擋 — 現況無此路徑（呼叫點僅 timer、exam 按鈕、onMount 補跳）。
- **首相 A 未 commit 改動共存**：fsrs.js/session-v4.js/store.js/chart.js/base.css/cli.mjs/verify-*.mjs 8 檔為 A1/A2 工作區改動；B2 commit 只 add 組二檔案（git status 分離，憲法第 9 條），不動上述檔案。

## 流程（憲法）

- 計畫書 → 3 名唯讀委員獨立審查（leaf，無寫入權）→ 不過修再送（上限 10 輪）→ 3/3 ✅ 才動工。
- 動工前再次 `git status` 確認分離；commit message 含 bug 編號＋摘要。
- 本計畫書含審查歷程，保存至定案。

## 審查歷程

- v3 定案：⚠️→✅（語法修正後）「B2. autoNext 延遲窗」（fix-plan-critical-v3.md:141-146）
- **第 1 輪（v1）：3❌** — 委員 #1：mc/spell 加 guard 卻無 onMount 補跳 → 返回卡死＋pendingScore 殘留；驗證 3 對 mc/spell 不成立（無 firstUn）；窮舉漏 spell:273/:349。委員 #2：同卡死（條件寫法以 `_answered`/`userInput` 對齊 render 判定）；spell「零雙計」claim 不實；mc 續答依賴 B3 未載明；行號 off-by-one；resumeSession 重置置頂。委員 #3：**實錘 B1 作答路徑同步級聯**（:381 guard × timer 後設 → 作答第一題即整場跳結果頁）；驗證 4 聲稱的補跳機制缺席；模擬必須忠實含 guard。
- **第 2 輪（v2）：3❌** — 3 委員一致實錘 **flip 補跳路徑級聯**（v2 機制 B 只修作答/timer 路徑）：`e.judged` 在 nextWord 從不重置 → 補跳 nextWord 內 renderInPlace 重入 → guard 再 fire → 遞迴直跳結果頁；同根因：stale judged 誤跳未答題（timer fire 推進後離開再返回）、跨場殘留（第一場結束 judged=true → 再考開場級聯）、補跳不 return → 重複綁定單擊雙計（flip answerCorrect/Wrong 無作答 guard）。委員 #1 修法：nextWord 重置 judged/answeredCorrect；委員 #2 加 startExam 重置＋guard 補跳 return＋驗證補項 (a)-(e)；委員 #3 修法：guard 加 `e.answered &&`（等效）＋建議 mc startExam/resumeSession 的 pendingNext 補 clear、明註保留 `results[e.idx]` 寫入、B1 回歸重跑、`npm run build` 指令。
- **v3 修正**：機制 B 不變；機制 C 擴充為「judged 生命週期修復＋補跳 return」（flip nextWord/startExam 重置 judged/answeredCorrect；flip :381 與 mc/spell 補跳皆 `{ nextWord(s); return; }`）；表格明註保留 results 寫入；mc startExam/resumeSession 補 clearTimeout；驗證 4/7 補強（恰跳 1 題、guardFires=1、第二場、stale judged、陣列長度不變）；驗證 8 加 results grep＋B1 回歸重跑；驗證 9 寫明 `npm run build`；風險段補 mc applyTags 未答詞 → B3 義務。
- **第 3 輪（v3）：3/3 ✅ 通過** — 委員 #1：機制 A/B/C 經忠實模擬 7a-7e 全情境成立；judged 重置無渲染副作用（renderExam 未答分支不讀）；補跳 return 無外層事務遺漏（spell keydown 具名函數去重、resize 匿名監聽反因 return 減少累積）；50+ 斷言全過。委員 #2：計數不變量成立（延遲窗「少 1」窗口 renderExam 不顯示計數、exit flush 補齊）；pendingScore 生命週期無殘留入口；末題全路徑閉合；補跳 return 防 ①phase='result' 重複綁定 ②resize 監聽洩漏；JSON round-trip 實錘（store.js:1592-1602/db.js:342-349）；無 return 對照組實錘重複綁定（mc optBind 12→16）。委員 #3：63 項斷言全過（B1-as-committed 對照組 harness 自檢重現 B1 級聯 bug）；B1 六大驗證項目（applyTags 亂序/round-trip/刪字 lockstep/sentinel/全答完直接結果頁/bottom-nav 返回）無回歸；`results[e.idx]` grep 2 行符合；行號零偏差。3 委員一致建議：spell 明註保留 `w._correct`、mc resumeSession 重置移至 `if(!session)` 前、mc pickOption 防禦性 clear、flip resume 一併重置 answeredCorrect、風險段措辭修正 → **全部併入 v4 定案版**。
