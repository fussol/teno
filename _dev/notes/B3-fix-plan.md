# B3 — exam-mc 恢復卡死＋無 mcData 題錯標（resume 續跳 timer ＋ results 平行陣列）（v5 — 定案 ✅）

狀態：**第 5 輪 3/3 ✅ 通過 — 定案可實作（2026-08）**
關聯：v3 定案 ⚠️→✅「B3. exam-mc 恢復卡死」（fix-plan-critical-v3.md:148-151）；基準 = B1（a9af4ef）＋B2（cb76cbf）已落地架構。
修正方案標題（v4 → v5）：v5 僅改 3(b) 序列化分支加 per-word 一致性 guard＋驗證 9i＋風險段措辭（第 4 輪委員 #2 F1）＋9h/9g 措辭明確化（第 4 輪委員 #1 N1-N3）＋風險段 settings/delay 註記（第 4 輪委員 #1 N4／#3 觀察 B）；餘不變。

## Bug 定義

### 現象一：exam-mc 恢復卡死（resume 後已答題無法續跳）

`resumeSession`（exam-mc.js:235-268）恢復存檔時：
- 有 mcData 的已答題 → `w._answered = true; w._picked = data.picked;`（:248-249）→ **resume 後當前題是「已答」狀態**：renderExam 走已答分支（:139-159）、`pickOption` 被 `if (!w || w._answered) return;`（:272）擋掉、**沒有任何 timer 續跳**。B2 的 onMount 補跳（:368）只在「timer 已被消費」時補跳 **恰 1 題**，但 resume 場景沒有 timer 可消費 → 已答題停在畫面上卡死（顯示「✗ 錯誤/✓ 正確」＋「即將跳下一題...」卻永不跳）。
- 實際觸發：**延遲窗 exit**（答題後 ~delay 秒內退出）→ exit handler flush 計分但 `session.idx` 仍指向已答題（B2 語意）→ resume 後卡在已答題。

### 現象二：無 mcData 的題被強制標記為「已答且答錯」（恢復卡死主因＋applyTags 錯標）

`resumeSession` 無 mcData 分支（:250-255）：
```js
} else {
  w._answered = true;   // ← 把「無選項資料的題」強制標記為已答
  w._picked = -1;       // ← -1 ≠ _correctIdx(0) → 必錯
  w._options = [w.word];
  w._correctIdx = 0;
}
```
- **資料損壞/極端邊角**（session 無 mcData 欄位 — 正常 exit 存檔自 initial commit 0b43e48 起必含 mcData，實錘 `git show 0b43e48:src/pages/exam-mc.js` :369-375 與現行 :390-396 同構）resume → **每題都走 else 分支** → 全部 `_answered=true, _picked=-1` → 第一題靠 B2 補跳跳走後，**下一題又是已答** → 補跳連鎖直到結果頁；且 `applyTags`（:311 `w._picked === w._correctIdx` → -1 ≠ 0）把**每一題都標 wrong**（#4 委員抓到的額外 bug）。
- **exit 時未答的題**（有 mcData、`data.answered=false`）不受影響（走 if 分支，正常還原為未答）— 無 mcData 只發生在損壞/邊角存檔。
- **「舊存檔」的真實形態**（可正常 resume 的舊存檔）= **有 mcData ＋ results 缺失或空 `[]`**（B1 a9af4ef 起 buildSession 已對 mc 序列化 `results: [...(e.results || [])]`，而 B3 前 mc 的 `e` 無 results → 空陣列）— 此形態由本計畫 3(b) fallback 處理，非本 bug 的「無 mcData」分支。

## Root Cause

1. **resume 缺「已答題續跳」機制**：B2 的 onMount 補跳（:368）語意是「bottom-nav 離開返回時恰跳 1 題」，不是「resume 續答」— resume 後的已答題沒有 timer、沒有 firstUn 式跳轉，形成卡死。
2. **無 mcData 分支把「資料缺失」偽裝成「答錯」**：`_answered=true; _picked=-1` 使未答題（資料不可得）被當成已答錯題 — 擋作答（卡死）、applyTags 標 wrong（錯標）。
3. **mc 沒有 per-word 作答結果陣列**：applyTags 只能靠 `_picked === _correctIdx` 推斷，無法區分「未答」（undefined）與「答錯」（false）— B1 已為 flip 建立 results 平行陣列，mc 未跟進。

## 修正方案（v4 — 吸收第 1/2/3 輪 9 委員盲點）

> 對齊語意（v3 定案，語義裁決 — 第 1 輪委員 #2/#3 定死）：無 mcData 題 = **當未作答重渲染**；v3「不計分」= **該題不計入 correct/wrong**（資料缺失下作答也不計分、不因 `_picked=-1` 被自動計 wrong／不因缺失扣分，零雙計）。applyTags 對**作答過**的無 mcData 題（results 有值）**照標**（「不計分」僅指成績計數，不指標籤；未作答則 `results[i]===undefined` skip）。
> ⚠️ **「不計分」僅保障「首次無 mcData resume 當下」**：exit 重存（emExitBtn :391-395 對**全部** `_options` truthy 的題寫 mcData，含未答題）後，二度 resume 全走 if 分支 → 未答損壞題**恢復計分語意**且單選必對（forced-correct 計分）— 與 forced-correct 標 tc 同源，release note 一併明載（第 3 輪委員 #2 F1b）。

### 1. `e` 初始物件加 `results: []`（exam-mc.js:6-18）

```js
results: [],   // B3: per-word 作答結果（undefined=未答 / true=對 / false=錯；對齊 flip B1）
```

### 2. startExam 初始化（exam-mc.js:214-222 per-word reset 區塊＋:223-232 e reset 區塊）

```js
// per-word reset 區塊（:214-222）加一行（在 w._picked = -1; 後）：
w._noScore = false;   // B3: 重置不計分旗標（防損壞 resume 殘留污染新場計分 — 第 2 輪委員 #1 實錘跨場洩漏）
// e reset 區塊（e.words = words 後）加一行：
e.results = new Array(e.words.length).fill(undefined);   // B3: 對齊 flip startExam（exam-flip.js:227）；防跨場 results 長度污染
```
> ⚠️ **`w` 是 `s.state.words` 同物件參照**（wordPool :33-37 filter、wordMap.get :240 皆不 clone）— `_noScore` 必須在 startExam 與 resume 有 mcData 分支**顯式重設 false**，否則損壞 resume 寫入的 true 永久殘留（第 2 輪委員 #1 F1 實錘：新場測驗該單字永不分數）。

### 3. resumeSession（exam-mc.js:235-268）— 三處

**(a) 無 mcData 分支改「當未作答＋不計分」**（:250-255）：
```js
} else {
  // B3: 無 mcData（資料損壞/邊角）→ 當未作答重渲染；該題不計分（v3 定案「不計分」— 作答也不計入 correct/wrong，零雙計）
  w._answered = false;
  w._picked = -1;
  w._options = [w.word];
  w._correctIdx = 0;
  w._noScore = true;   // B3: 標記該題不計分（pickOption 見此不設 pendingScore）
}
```
**有 mcData 分支（:248-249）加一行**（`w._picked = data.picked;` 後）：
```js
w._noScore = false;   // B3: 有 mcData 即恢復計分語意（與 startExam 重設對齊，字面閉合「僅無 mcData 還原當下為 true」）
```
（效果：resume 後當前題若無 mcData → 未答渲染 → 可作答（互動流暢不卡死）但不計分 → 不卡死、不錯標、零雙計。）

**(b) results 還原（mcData 還原迴圈之後、:257 `e.id = session.id;` 一帶）— lockstep 對齊＋per-word 一致性 guard**：
```js
// B3: results 還原 — 序列化陣列僅在「長度 = wordIds 長度 且 = 存活 words 長度」時採用；否則（刪字/畸形/舊存檔空陣列/缺失）per-word 推斷
if (Array.isArray(session.results)
    && session.results.length === session.wordIds.length
    && session.results.length === words.length) {
  e.results = session.results.map((r, i) => (r == null ? undefined : (words[i]?._answered ? r : undefined)));
  //   B3: null→undefined 正規化（JSON round-trip：store.js:1599→db.js:343 stringify→db.js:339 parse，實錘）
  //   B3: per-word 一致性 guard（第 4 輪委員 #2 F1）— results 值僅在 mcData 確認該題已答時採用
  //   防畸形存檔「全長 results＋部分 mcData 缺失」把未答題錯標 wrong（反例：wordIds=[A,B]、results=[true,false]、
  //   mcData={A} 且 B 無 mcData → 雙長度過 → 無 guard 則 B 還原 false → applyTags 標 wrong；guard 棄值 → undefined → skip）
} else {
  e.results = words.map(w => (w._answered && w._picked >= 0 ? (w._picked === w._correctIdx) : undefined));
}
```
> ⚠️ **必須使用區域變數 `words`**（插入點 :257 時 `e.words` 仍是上一場殘留值），且必須位於 mcData 還原迴圈（:243-256）之後（fallback 與 guard 皆依賴還原後狀態 — guard 讀 `words[i]._answered`）。
> **雙長度條件（第 3 輪委員 #2 F2 補強）**：單一 `results.length === words.length` 對「畸形存檔＋刪字」有 false-positive — 反例：畸形存檔 wordIds=[A,B]、results=[true]、A 被刪 → words=[B]、`1===1` 誤走序列化分支 → B 錯配 true（B 實為未答 → applyTags 錯標 tc）。加 `results.length === session.wordIds.length` 後：畸形長度存檔由第一項相等失敗 → 棄序列化、走 fallback（per-word 推斷，`_answered=false` → undefined skip）— 正確。**對健全存檔**（B1 起 buildSession 恆產出 results 長度 = wordIds 長度，exam-session.js:61）：無刪字 → 兩項皆成立 → 序列化分支（guard 恆通過：pickOption 同時寫 results[i] 與 `_answered=true`，exit 同源序列化）；刪字 → 第二項失敗 → fallback；B1-era [] → 第一項失敗 → fallback — **行為零變化**。
> **lockstep 必要性（實錘）**：`session.results` 是 `session.wordIds` 順序對齊的陣列；`words = session.wordIds.map(id => wordMap.get(id)).filter(Boolean)`（:240）過濾掉被刪單字後索引錯位；fallback 按 `w.id` keyed 的 mcData（:244）推斷，天然免疫刪字。

**(c) 尾端續跳 timer ＋ re-arm 遞迴（:265 `e.cardStart = Date.now();` 後、:266 `e.phase = 'exam';` 前）**：
```js
// B3: resume 續跳 — 當前題已答（延遲窗 exit）→ 設 timer 延遲續跳；re-arm 遞迴：每層 fire 後依同一條件續設，直至未答題/結果頁
// 對齊 B2 機制 B：先設後 render、callback 先 nextWord 後清
const w0 = e.words[e.idx];
const armJump = () => {
  e.pendingNext = setTimeout(() => {
    const before = e.idx;
    nextWord(s);
    e.pendingNext = null;
    if (e.idx !== before && e.words[e.idx]?._answered && e.settings.autoNext) armJump();   // B3 re-arm 遞迴（第 3 輪委員 #1 F1：單層 re-arm 對 3 題以上連續已答仍卡死 → 具名遞迴）
  }, e.settings.delay * 1000);
};
if (w0?._answered && e.settings.autoNext) armJump();
```
（時序推演（第 1/2/3 輪委員 #1 全閉合）：JS 單執行緒 → onMount 執行時 `e.pendingNext` 必非 null → 補跳 guard（:368 `!e.pendingNext`）不 fire；timer fire → nextWord → flush（resume 函式頂 :236 已 `pendingScore=null` → no-op 零雙計）→ idx++ 續跳恰 1 題；**re-arm 條件含 `e.idx !== before`**：正常路徑（下一題未答）不 re-arm、bottom-nav 尾窗（page guard 消費、idx 不變）不 re-arm → 返回補跳 guard 接管恰跳 1 題（guardFires=1 語意保留）、末題（idx≥length、`e.words[idx]` undefined）不 re-arm → 結果頁；autoNext 關 → 不設 timer → emNextBtn（:157-159）手動續跳；**損壞存檔（idx 後連續已答 N 題）→ 每層 timer fire 後同條件續設（armJump 遞迴），逐題續跳至未答/結果頁，不卡死** — 無堆疊風險（timer callback 每次 fire 全新呼叫棧，遞迴深度 ≤ words.length；`e.pendingNext` 每層重設 → exit :388 恆清到最新 id）。
> **範圍裁決（第 3 輪委員 #3 nit 補上，字面標記）**：re-arm 遞迴超出 fix-plan-critical-v3.md:149 定案字面的「單一 timer」，但為定案「resume 已答不卡死」意圖在損壞存檔（idx 後多題已答）下的必要閉合，且為第 2 輪 F3 阻塞性發現之指定解決；正常存檔（idx 恆指最後已答題、其後必未答）不觸發 re-arm（條件 `e.idx !== before`＋下一題未答）— 行為與定案字面完全一致，非擴張失控。）

### 4. pickOption 寫入 results ＋ 不計分 guard（exam-mc.js:270-283）

```js
e.results[e.idx] = (idx === w._correctIdx);                    // B3: results 即時寫（不延遲 — 對齊 flip B1「results 不延遲」語意）
if (!w._noScore) e.pendingScore = (idx === w._correctIdx) ? 'correct' : 'wrong';   // B3: 無 mcData 題不計分（v3「不計分」）
```
（原本的 `e.pendingScore = ...` 一行（:276）改以上兩行；順序互不依賴，results 寫入不可延遲。`_noScore` 僅 resume 無 mcData 分支設定 true、startExam/有 mcData 分支顯式 false — 生命週期閉合；`_noScore` **不加入 :393 mcData 序列化**（非持久欄位，生命週期由 mcData 存在與否＋顯式重設決定）。）

### 5. applyTags 改用 results 平行陣列（exam-mc.js:302-322）

```js
for (let i = 0; i < e.words.length; i++) {
  const r = e.results && e.results[i];
  if (r !== true && r !== false) continue;   // B3: 未答（undefined/null，round-trip 後）不標籤 — 不會錯標 wrong（#4 額外 bug）
  const w = e.words[i];
  if (!w) continue;
  const tag = r ? tc : tw;
  const opposite = tag === tc ? tw : tc;
  // ...其餘（filter / push / editWord）不變
}
```
（renderExam :140-147 的 `_picked` 顯示判斷**不動** — 那是渲染展示，非標籤邏輯。）

### 6. 防禦性 NaN clamp（resumeSession :261，一行）

```js
e.idx = Number.isFinite(session.idx) ? Math.max(0, Math.min(session.idx, words.length - 1)) : 0;
```
（對齊 flip B1 的 NaN clamp（exam-flip.js:252-254）；防損壞存檔 `session.idx=NaN`（round-trip 後 null，`Number.isFinite(null)` false）→ `e.words[NaN]` undefined → 白畫面。**範圍裁決**：超出 v3 定案三件事，但屬 resume 健壯性、與 B3 同區塊（resumeSession）、一行且 flip 已有先例 — 納入並附對應驗證 9f。⚠️ mc **無** flip B1 式 `deletedBefore` 偏移修正（exam-flip.js:251-254）— 刪字＋idx 指向已刪字時 clamp 落在存活座標上界而非「第一個未答」；為 mc 既有行為（B3 前 :261 同型）、非 B3 範圍，驗證 7 情境明載前提。）

### 不動清單
- **exam-session.js buildSession**：B1 已序列化 `results`（:61），mc 自動受益（e.results 存在時序列化）— 零變更。
- **exam-mc.js emExitBtn（:387-400）**：零變更（mcData 序列化 :393 讀 `w._options`/`w._answered`/`w._picked`；3(a) 後無 mcData 題 `_options=[w.word]` truthy → exit 寫入 mcData（answered:false/true）→ 再 resume 走 if 分支 — 良性一致，註記；**計分側後果**：未答損壞題二度 resume 恢復計分語意且單選必對 — 見風險段）。timer 清理（:388）與 flush（:389）B2 既有，涵蓋 resume 續跳 timer（含 re-arm 最新 id）。
- **exam-flip.js / exam-spell.js**：不動（B1/B2 已定案；spell 雙計為既有行為，另立議題）。
- **store.js / chart.js / base.css / lib.rs**：任務禁令，不碰。

## 使用點窮舉（憲法第 2 條 — grep 三形態）

grep 形態一（`_answered`/`_picked`/`_noScore` 寫入與讀取點）：
| 位置 | 現況 | 動作 |
|---|---|---|
| exam-mc.js:220-221（startExam per-word reset） | `w._answered=false; w._picked=-1;` | **加 `w._noScore = false;`**（防跨場洩漏） |
| exam-mc.js:248-249（resumeSession 有 mcData） | `w._answered=data.answered; w._picked=data.picked;` | **加 `w._noScore = false;`**（恢復計分語意） |
| exam-mc.js:251-252（resumeSession 無 mcData） | `w._answered=true; w._picked=-1;` | **改 `_answered=false`＋加 `_noScore=true`**（當未作答＋不計分） |
| exam-mc.js:272-274（pickOption guard/寫入） | `if (!w || w._answered) return; w._picked=idx; w._answered=true;` | 不動（作答照常） |
| **exam-mc.js:276（pickOption 計分行）** | `e.pendingScore = (idx === w._correctIdx) ? 'correct' : 'wrong';` | **改兩行**（方案 4：results 寫入＋`if (!w._noScore)` guard） |
| exam-mc.js:139-147/:174（renderExam 顯示） | `w._answered` 分支、`_picked` 顯示判斷 | 不動（3 處 `_picked === _correctIdx` 為合法保留） |
| exam-mc.js:368/:372（onMount 補跳/作答 guard） | B2 既有 | 不動（resume timer 設後 `!e.pendingNext` false → 不競態） |
| exam-mc.js:390-396（emExitBtn mcData 序列化） | 讀 `_options`/`_answered`/`_picked` | 不動 — 註記：3(a) 後無 mcData 題 `_options=[w.word]` truthy → exit 寫入 mcData（良性：再 resume 走 if 分支，與 results 一致）；`_noScore` 不序列化 |

grep 形態二（`results` 讀寫點）：
| 位置 | 現況 | 動作 |
|---|---|---|
| exam-mc.js:6-18（e 初始物件） | 無 | **加 `results: []`** |
| exam-mc.js:223-232（startExam） | 無 | **加 fill(undefined)** |
| exam-mc.js:235-268（resumeSession） | 無 | **加還原（雙長度 lockstep，區域變數 words）** |
| exam-mc.js:276（pickOption） | 無 | **加 `e.results[e.idx] = ...`＋pendingScore guard** |
| exam-mc.js:311（applyTags） | `w._picked === w._correctIdx` | **改 results 判定＋skip** |
| exam-session.js:61（buildSession） | B1 已序列化 | 不動 |

grep 形態三（`pendingNext` 設/清/讀點）：
| 位置 | 現況 | 動作 |
|---|---|---|
| exam-mc.js:16（e 初始物件） | `pendingNext: null`（B2 既有欄位） | 不動（B3 沿用） |
| exam-mc.js:280（pickOption 作答 timer 設點）與 :279（防禦性 clear） | B2 既有 | 不動 |
| exam-mc.js:237/:230（resumeSession/startExam 清） | B2 既有 | 不動 |
| exam-mc.js:265-266 前（resumeSession 尾端） | 無 | **加續跳 timer（armJump 遞迴，含 re-arm）** |
| exam-mc.js:368（onMount 補跳 guard 讀點） | B2 既有 | 不動（resume timer 設後 `!e.pendingNext` false → 不競態；消費後由補跳接管） |
| exam-mc.js:388（emExitBtn 清） | B2 既有 | 不動（resume timer／re-arm 最新 id 亦被此處清） |

## 驗證項目

> 模擬忠實性要求（B2 第 1 輪委員 #3 立）：**harness 以真實源碼控制流為藍本**（讀 src/pages/exam-mc.js → 移除 import → new Function；含 onMount 同步觸發、renderInPlace→onMount 重入、fake timers id≥1、click handler 先設狀態再呼叫作答函式、JSON round-trip），**不得手抄 snippet**。方法沿用 verify-b2.mjs。**verify-b3.mjs 檔頭註記**：buildSession stub 需同時含 results 序列化（對照 src/core/exam-session.js:61）與 mcData 序列化（對照 emExitBtn :390-396）— verify-b2.mjs 現有 stub（:54-59）不含 mcData，B3 的 round-trip 驗證若沿用舊 stub 會全數失真（第 3 輪委員 #3 精度要求 #3），未來變更需同步 harness。

1. **Node 模擬（verify-b3.mjs）— 正常作答回歸**：3 題（對/錯/對）autoNext on → timer fire 逐題 flush → `correct=2, wrong=1`、`results=[true,false,true]`、無級聯（B1/B2 不破）。
2. **Node 模擬 — 延遲窗 exit → resume 續跳（核心）**：答第 1 題 → **不 fire timer** 即 exit（走真實 emExitBtn click handler：flush＋buildSession＋**JSON round-trip**）→ resume → 斷言：當前題已答、`pendingNext` timer 已設、onMount 補跳 guard **不 fire**（guardFires=0）→ fire timer → `idx=1`、`correct=1`（不重答不雙計）、續答未答題；**round-trip 後 `results[0] === true/false`（第 1 題已答保留 — 方案 4 即時寫不丟失）且 `results[1] === undefined && results[2] === undefined`（未答題 null→undefined 正規化）** → applyTags 對 results[1]/[2] skip、對 results[0] 照標。
3. **Node 模擬 — 無 mcData 損壞存檔 resume（核心）**：session 無 results 無 mcData（idx=1）→ resume → 斷言：所有題 `_answered=false` 且 `_noScore=true`（當未作答）→ 當前題作答 → `pendingScore` **不設**、`correct/wrong` **不變**（零雙計、不計分）、`results[1]` 寫入 → **作答後 autoNext timer 已設 → fire → idx 前進、`correct/wrong` 仍不變**（timer 續跳＋不計分閉合）→ applyTags 對該題照標（results 有值）、對其他未答題 skip。
4. **Node 模擬 — applyTags 未答 skip（#4 額外 bug）**：resume 後（有未答題）→ applyTags → 斷言：未答題 tags 不變（**不標 wrong**）；已答題正確標 tc/tw。
5. **Node 模擬 — resume timer × onMount 補跳交互**：resume 設 timer → onMount 執行 → 補跳 guard 不 fire（`guardFires=0`）；timer fire 後續跳恰 1 題。
6. **Node 模擬 — 末題 resume**：末題已答 exit → resume → timer fire → `phase='result'`、計數 = session 還原值、零雙計（re-arm 條件 `e.idx !== before` 且末題後 undefined → 不 re-arm）。
7. **Node 模擬 — 刪字 lockstep**：session 含被刪單字（wordIds 含不存在 id）＋ results 有值 → resume → 斷言：`e.words.length === results.length`；**逐題值對齊**（`results[i]` 對應的 w 與 mcData 推斷一致 — 此斷言在 fallback 分支下為自證性檢查，主要捕捉實作誤用序列化陣列/索引錯位；「序列化陣列優先」分支由驗證 2 覆蓋 — 兩分支互補閉合）。**情境明載**：`session.idx` 指向已刪字 → clamp 落存活座標上界（mc 無 flip B1 式 deletedBefore 偏移修正 — 既有行為、非 B3 範圍）；若落點已答 → 3(c) re-arm 續跳閉合、若落點未答 → 正常作答（驗證只斷言「落點在存活座標範圍內＋已答落點由續跳閉合」，**不宣稱跳到第一個未答**）。
8. **Node 模擬 — autoNext 關 resume**：已答＋autoNext=false → resume → 不設 timer → 手動「下一題」→ flush null 不雙計、續跳正常。
9. **Node 模擬 — 二度 resume**：resume 續答 → 作答 → 重存（round-trip）→ 再 resume → 已答題續跳、未答題停在正確位置、零雙計。
9b. **Node 模擬 — 尾窗 exit（resume timer 殘留防護，第 1 輪委員 #1 補項）**：resume 設續跳 timer → 未 fire 即 exit（走真實 emExitBtn handler）→ 斷言 exit 後 `pendingCount() === 0`（:388 已清，**主斷言**）→ 快轉 delay*2 → **callback 執行次數 = 0**、idx 不變（輔助）→ 再次 resume 正常續跳（對齊 B2 驗證 6「殘留 timer 計數」）。
9c. **Node 模擬 — 尾窗 bottom-nav（timer 消費後補跳，第 1 輪委員 #1 補項）**：resume 設續跳 timer → currentPage 切走（'exam-mc'→其他）→ fire timer（:290 page guard 消費、`e.idx !== before` 不成立 → **不 re-arm**、callback 清 pendingNext）→ 返回 onMount → 補跳恰 1 題（guardFires=1）→ 再 onMount 不雙跳（對齊 B2 驗證 4）。
9d. **Node 模擬 — 尾窗作答嘗試（:272 guard，第 1 輪委員 #1 補項）**：resume 已答題＋timer 待 fire → 呼叫 pickOption → 斷言 `_answered`/`_picked`/`results` 不變（不重答）、timer 未被防禦性 clear 重置 → fire timer 後恰跳 1 題。
9e. **Node 模擬 — B1-era 存檔（第 1 輪委員 #2 補項）**：session 含 `results: []`（空陣列，合法 Array）＋ mcData 有值（idx=1、第 1 題已答）→ resume → 斷言：3(b) 走 fallback（`[].length !== wordIds.length`）、`results` 值與 mcData 推斷一致（第 1 題 true/false 依 picked）、未答題 undefined、續答零雙計。
9f. **Node 模擬 — 損壞存檔 NaN idx（第 1 輪委員 #3 補項）**：session.idx=NaN **經 JSON round-trip（NaN→null）** → resume → 斷言：`e.idx=0`（`Number.isFinite(null)` false → clamp 0）、renderExam 不白畫面、可正常作答。
9g. **Node 模擬 — 方案 A 全生命週期閉合（第 2 輪委員 #2＋第 3 輪補強）**：無 mcData 損壞存檔 resume → 作答（不計分）→ **exit 重存（round-trip）→ 斷言：存檔 mcData 含全部題（含未答題，`_options=[w.word]` 單選 — emExitBtn :391-395 全量序列化）** → **二度 resume → 斷言：所有題皆走 if 分支（`_noScore` 全為 false）、該題 `results[<作答題 idx>] === true`（以情境 idx 為準，勿硬編碼 0）、`correct/wrong` 仍不含該題（零雙計）** → applyTags 標 tc → **再考新場（startExam）→ 斷言該單字在新場 words 中且 `_noScore === false`（跨場洩漏已堵）→ 作答正常計分**。
9h. **Node 模擬 — 損壞存檔 re-arm 遞迴續跳（第 2 輪委員 #1 建議＋第 3 輪補強：3 題連續已答）**：手造存檔 **含當前題共 3 題連續已答（idx、idx+1、idx+2 已答，idx+3 未答）**、**settings 完整（delay/autoNext 有值）**（autoNext on）→ resume → 斷言：逐層 fire timer → **每層 fire 後 idx 前進 1 且若下一題仍已答則 `pendingNext` 非 null（re-arm 續設，每層 fire 前 `pendingCount() === 1`）** → 第 3 次 fire 到達未答題時 `pendingNext === null`（停止 re-arm）→ 全程不卡死、計數零雙計（flush no-op）。
9i. **Node 模擬 — 畸形存檔「全長 results＋部分 mcData 缺失」（第 4 輪委員 #2 F1 補項）**：手造存檔 wordIds=[A,B]、results=[true,false]（長度正確）、mcData={A:{answered:true,...}}、B 無 mcData、autoNext 關 → resume → 斷言：走序列化分支（雙長度全符）但 **`e.results[1] === undefined`（per-word guard 棄值 — B 未答）**、B `_answered=false` 未答 → 手動下一題至結果頁 → applyTags → **B tags 不變（不標 wrong）**、A 照標 tc。
10. **源碼檢查**：`node --check src/pages/exam-mc.js` 語法通過；grep 覆核 **applyTags 函式邊界內（`function applyTags` 起至 `toast('標籤已套用'...)` 終）** 無 `w._picked === w._correctIdx` 殘留（renderExam :140/:141/:146 顯示判斷 3 處為合法保留，不得誤判；注意修改後行號位移，以函式邊界為準）；`e.results[e.idx]` 寫入恰 1 點。
11. **`npm run build`（vite build）通過**。
12. **B1/B2 回歸**：verify-b2.mjs 對照重跑全過（flip/mc/spell 三頁行為不變 — mc 新增欄位不影響既有路徑；verify-b2.mjs 讀真實源碼 :66、其 mc 測試不觸及 resumeSession/applyTags，B3 修改不破其斷言面）。

## 風險

- **資料損壞/邊角存檔（無 mcData）resume 後選項僅剩正確答案單選＋首次 resume 當下作答不計分**（資料缺失降級）：resume 當下無法重建選項（選項隨機產生、不序列化）→ 當未作答重渲染只給 `[w.word]` 單選 → 作答必對但 **不計分**（`_noScore`）。**預期降級**：寧可互動不卡死、不計分也不錯標；release note 明載。
- **⚠️ 「不計分」僅保障首次無 mcData resume 當下**：exit 重存（emExitBtn 對全部題寫 mcData，含未答題）後，二度 resume 全走 if 分支 → 未答損壞題**恢復計分語意**且單選必對（forced-correct 計分）— 與 forced-correct 標 tc 同源，release note 一併明載（第 3 輪委員 #2 F1b）。
- **無 mcData 題作答後標 tc 語意**（forced-correct → results=true → 標「correct」標籤）：v3 只要求「不標 wrong」（results[i]===undefined skip）；作答過即標籤對齊 flip B1「作答的題就標」原則，屬「亂貼」邊緣 — release note 保留降級描述。
- **損壞/邊角存檔 applyTags 全 skip**（無 results 無 mcData → 全 undefined，未作答者）：對齊 B1 'old' sentinel 語意「漏貼不亂貼」；作答過的無 mcData 題照標（results 有值）。正常存檔（B1 起皆有 results＋mcData）不受影響。**序列化分支亦經 per-word 一致性 guard 篩選**（3(b)，未答題值棄為 undefined — 第 4 輪委員 #2 F1），「漏貼不亂貼」宣稱對所有分支成立。
- **B1-era 存檔（results=[] 空陣列＋mcData 有值）**：3(b) 走 fallback per-word 推斷，已驗證（驗證 9e）— 相容、零雙計。
- **buildSession results 欄位對 mc 從「空陣列」變「實內容」**：B1 起 mc 存檔已含空 results；B3 後存檔含實值 — 新舊存檔皆可 resume（fallback/序列化雙分支處理），相容。
- **resume 續跳 timer 殘留**：emExitBtn（:388）與 resumeSession 函式頂（:237）雙保險 clear＋驗證 9b；page guard（nextWord :290）擋非 exam 頁 fire；re-arm 遞迴只發生在 timer fire 且 idx 前進的同步堆疊內，exit 後無殘留。
- **損壞存檔（idx 後連續已答）行為差異已根治**：B3 採 re-arm 遞迴（armJump 具名函式，每層 fire 後依同一條件續設）逐題續跳至未答/結果頁（驗證 9h 三題已答實測）；B2（無 resume timer）靠 guard 連續補跳同達未答題 — 兩者行為一致（皆不卡死）。正常 B1/B2 存檔（idx 恆指最後已答題、其後必未答）不觸發 re-arm（條件 `e.idx !== before`＋下一題未答）— 行為與 v3 定案字面一致。
- **純損壞存檔一輪全作答不計分 → 結果頁標籤按鈕 disabled**（exam-mc.js:196 `total===0`）：correct/wrong 皆 0 → applyTags 無法從 UI 觸發（直接呼叫函式仍有效）— B3 前同型既有行為、非 B3 引入，註記不修。
- **`_answered`/`_noScore` 語意變更**（無 mcData 題 false/true）：renderExam 未答分支渲染正常（_options 已設）；onMount 補跳 guard（:368 `w0?._answered`）對未答題不 fire — 無副作用；`_noScore` 跨場洩漏由 startExam/有 mcData 分支顯式重設堵死（驗證 9g 端到端鎖定）。
- **損壞存檔連 `settings.autoNext` 都缺失**（`{...undefined}={}` → autoNext falsy → 退化成手動模式，emNextBtn 因 `!autoNext` 渲染，不卡死）：B2 既有語意（:259 `e.settings = {...session.settings}` 同源）、非 B3 引入；`settings.delay` 未消毒同理（NaN → timer 立即 fire、不卡死）— 註記不修。
- **spell 延遲窗 resume 重問雙計為既有行為**（B2 風險段已載），非 B3 範圍 — 另立議題。
- **不碰禁區**：store.js / chart.js / base.css / lib.rs 零變更；commit 只 add 本 bug 相關檔案（exam-mc.js＋計畫書＋verify-b3.mjs），與首相 A/C 工作區改動分離（憲法第 9 條）。

## 流程（憲法）

- 計畫書 → 3 名唯讀委員獨立審查（leaf，無寫入權；terminal 只准唯讀＋測試）→ 不過修再送（上限 10 輪，升版紀錄）→ 3/3 ✅ 才動工。
- 動工前再次 `git status` 確認與首相 A/C 檔案分離；commit message 含 B3 標記＋摘要。
- 本計畫書含審查歷程，保存至定案。

## 審查歷程

- v3 定案：⚠️→✅「B3. exam-mc 恢復卡死」（fix-plan-critical-v3.md:148-151）：resumeSession 尾端（renderInPlace 前）`if (w?._answered && autoNext) e.pendingNext = setTimeout(...)`；`_picked === -1`（無 mcData）當未作答重渲染＋不計分；applyTags 因 `results[i]===undefined` skip（#4 額外 bug）。
- **第 1 輪（v1）：3❌（皆小修型）** —
  - 委員 #1（控制流/時序）：機制設計全部閉合（resume timer × onMount guard 無競態恰跳 1 題、flush(null) 零雙計、末題/autoNext 關/無 mcData 三分支閉合、:272 尾窗擋重答、3(b) lockstep 條件充分必要），行號零偏差，verify-b2.mjs 64/64 回歸過；❌ 因驗證項目漏 3 個「延遲窗內中斷」時序測試（尾窗 exit／尾窗 bottom-nav／尾窗作答嘗試 — 對齊 B2 驗證 4/6 標準）＋窮舉形態一漏 :393。→ v2 補驗證 9b/9c/9d＋窮舉表 :393 行。
  - 委員 #2（資料序列化/存檔）：實錘 JSON round-trip 路徑完整（store.js:1599→db.js:343→339→store.js:263）＋3(b) 條件/fallback 免疫刪字、3(c) 競態、NaN clamp round-trip 後仍有效全確認；❌ 核心：3(a)「作答照常計分」與 v3「不計分」字面衝突＋舊存檔重答雙計（session.correct/wrong 還原值＋重答再計）；另實錘 mcData 自 initial commit 0b43e48 即存 →「無 mcData 舊存檔」為事實誤述，舊存檔真實形態 = 有 mcData＋results 缺失/空 []。→ v2 採方案 A（`_noScore` 作答不計分）＋驗證 9e（B1-era 空 results 場景）＋風險段事實更正。
  - 委員 #3（交叉審查）：Bug 定義/禁區/忠實模擬/驗證 12 可行性全實錘過關；❌ 主因同 3(a) 語義矛盾（計畫書 :36 vs :63/:156 自相矛盾）＋風險缺「舊存檔重答疊加計分」；另驗證 10 grep 斷言含糊（全域命中 renderExam :140/:141/:146 合法保留）、方案 6 NaN clamp 無驗證覆蓋、窮舉漏 :16/:279。→ v2 語義定死（對齊語意段）＋驗證 10 限定範圍＋驗證 9f（NaN）＋窮舉表 :16/:279 行。
- **第 2 輪（v2）：3❌（皆小修型）** —
  - 委員 #1（控制流/時序）：機制主體（3(b)/3(c)/_noScore 相容）全閉合；❌ F1（阻塞）：`w._noScore` 跨場洩漏 — `w` 是 `s.state.words` 同物件參照，損壞 resume 寫入 true 後永久殘留 → 再考新場該單字永不分數（startExam/resume if 分支缺重設）；F2（阻塞）：驗證 2 斷言「results[0]===undefined」不可能成立（第 1 題已答 → results[0] 必 true/false）；F3（阻塞）：風險段「B2 同場景同行為」實錘誤述 — B2（無 resume timer）靠 guard 連續補跳不卡死、B3（有 timer）尾跳 1 題後若下一題仍已答 → 卡死（行為差異為 B3 機制引入）→ 建議 re-arm 根治；N1-N4（nit）：窮舉形態三補 :368 讀點、9b 主斷言改 pendingCount、驗證 3 補 timer 續跳斷言、驗證 10 以函式邊界為準。→ v3：3(a)/2 加 `_noScore=false` 顯式重設、驗證 2 斷言改「results[0] 保留＋results[1]/[2] undefined」、3(c) 採 re-arm 根治、驗證補 9h、風險段更正、窮舉表補 :368、9b/9c 走真實 emExitBtn、9f 經 round-trip。
  - 委員 #2（資料序列化/存檔）：修正方案全部 ✅（含 _noScore 資料路徑完整性、3(b) lockstep 與 B1-era fallback、3(c) 時序閉合 — 全推演確認）；❌ 發現 D（必改）：驗證 2 斷言自相矛盾（results[0] 必為 true 非 undefined）；發現 E（必改）：方案 A 全生命週期無端到端驗證閉合（無 mcData 作答→exit 重存→二度 resume→_noScore 解除→applyTags 標 tc→計數一致性）；F/G（不阻擋）：forced-correct 標 tc 語意（release note 保留）、混合部分損壞場景可選加測。→ v3：驗證 2 修正、新增 9g（方案 A 全生命週期）、風險段補 forced-correct 標 tc 註記。
  - 委員 #3（交叉審查）：語義裁決一致性（v3「不計分」= v2 定死的閉合非擴張）、NaN clamp 範圍裁決、flip/spell 零誤傷、禁區遵守、窮舉完整、風險誠實、第 1 輪意見全吸收 — 全實錘過關；❌ F1（硬性）：驗證 2 斷言索引錯誤（同 #1 F2/#2 D）；F2（需明確化）：驗證 7「不跳過未答題」依賴未寫明前提（mc 無 deletedBefore 偏移修正 — clamp 落存活座標上界，可能跳過未答題；既有行為非 B3 範圍）。→ v3：驗證 2 修正、驗證 7 情境明載前提＋斷言降級（不宣稱跳到第一個未答）。
- **第 3 輪（v3）：1✅ 2❌（#3 通過；#1/#2 小修）** —
  - 委員 #1（控制流/時序）：`_noScore` 洩漏修法、驗證 2/3 斷言、三形態窮舉、行號零偏差、B1/B2 回歸 64/64 — 全 ✅；❌ **F1（阻塞）：re-arm 只 arm 一層，非「逐題續跳」** — 3 題以上連續已答的損壞存檔在第二層 timer fire 後卡死（re-arm 設出的 timer callback 內無再檢查，與計畫書「逐題續跳」宣稱矛盾；驗證 9h 的 2 題設定恰好掩蓋缺陷）；修法：具名遞迴函式 `armJump`（每層 fire 後依同一條件續設）＋9h 改 3 題已答（每層 fire 前 pendingCount()===1、到達未答題時 pendingNext===null）＋風險段措辭改「re-arm 遞迴」；N1（nit）：窮舉形態一 :272-274 行標含糊（方案 4 實際改 :276 計分行）→ 拆兩行。→ v4：3(c) 改 armJump 具名遞迴、9h 改 3 題、窮舉表 :276 獨立成行。
  - 委員 #2（資料序列化/存檔）：v3 全部修正點（驗證 2、9g、_noScore 重設、re-arm）經逐行比對＋時序推演驗證正確；❌ F1a（必改）：9g 缺「exit 重存全量 mcData（含未答題）」＋「二度 resume 所有題皆走 if 分支（_noScore 全 false）」斷言（emExitBtn :391-395 對全部題寫 mcData — 未答損壞題二度 resume 恢復計分語意）；F1b（必改）：風險段未載「重存後計分語意恢復」；F2（必改）：3(b) 條件對畸形存檔＋刪字 false-positive（反例 wordIds=[A,B]、results=[true]、A 刪 → 1===1 誤走序列化分支）→ 加 `results.length === session.wordIds.length`；N1/N2（可選）：純損壞全作答不計分 → emTagBtn disabled 既有行為、session.settings 未消毒。→ v4：9g 補全量 mcData 斷言、風險段補「不計分僅保障首次 resume 當下」、3(b) 雙長度條件、風險段補 emTagBtn disabled 註記。
  - 委員 #3（交叉審查）：**✅ 通過（逐節）** — 前兩輪 6 委員意見全部吸收且修正正確；驗證 2/7/10/12 自洽可測；範圍無擴張失控；flip/spell 零誤傷；禁區遵守。附 7 條實作精度要求（3(b) 用區域變數 words、3(c) callback 順序不可改、verify-b3.mjs stub 需 results＋mcData 雙序列化、_noScore 三點生命週期、驗證 10 函式邊界、驗證 7 情境、commit 只 add 3 檔）＋2 nit（re-arm 缺顯式範圍裁決標記、驗證 7 斷言自證性質註記）。→ v4：3(c) 補範圍裁決標記、驗證 7 補斷言目的註記、驗證項目前補 stub 註記。
- **第 4 輪（v4）：2✅ 1❌（#1/#3 通過；#2 小修）** —
  - 委員 #1（控制流/時序）：**✅ 通過（逐節）** — 3(c) armJump 具名遞迴全部閉合（TDZ 安全、每層恰 1 timer、exit 清最新、bottom-nav 不 re-arm、末題不 re-arm、多層續跳）；9h 斷言精確可測；窮舉表 :276 獨立成行；前 3 輪全部 ❌ 點正確落地。附 7 條實作精度要求＋4 nit（N1 9h prose「idx 後有 3 題」off-by-one 歧義 → 明寫「含當前題共 3 題」；N2 9h 手造存檔 settings 完整性明載；N3 9g 新場斷言須確保該單字在新場 words 中；N4 損壞存檔缺 settings.autoNext → 續跳/補跳 guard 皆失效 — B2 既有語意、風險段註記）。→ v5：9h/9g 措辭明確化、風險段補 settings 註記。
  - 委員 #2（資料序列化/存檔）：前 3 輪全部 ❌ 點落地核對 ✅（雙長度條件反例驗證正確、9g 閉合完整、風險段誠實精確）；❌ **F1（必改，新盲點）：3(b) 序列化分支對「畸形存檔：全長 results＋部分 mcData 缺失」信任 results 值 → 未答題被錯標 wrong**（反例：wordIds=[A,B]、results=[true,false]（長度正確）、mcData={A} 且 B 無 mcData → 雙長度過 → B 還原 false → applyTags 標 wrong；fallback 分支反而安全 — 序列化分支防禦力弱）；修法：序列化分支加 per-word 一致性 guard（`r == null ? undefined : (words[i]?._answered ? r : undefined)`，依賴 mcData 迴圈先執行、`_answered` 可得）＋新增驗證 9i＋風險段補半句；附 2 nit（9g 索引硬編碼 0、fallback 與序列化分支對畸形值處理不一致 — skip 較保守可接受）。→ v5：3(b) 加 guard、驗證 9i、風險段補 guard 措辭、9g 索引改「<作答題 idx>」。
  - 委員 #3（交叉審查）：**✅ 通過（逐節）** — 前 3 輪 9 委員意見全吸收（唯一例外為第 2 輪 #2 可選 nit「settings 未消毒」，不阻擋）；v4 與 v3 定案一致、範圍無擴張失控；flip/spell 零誤傷；禁區遵守；驗證 1-9h＋10-12 逐項可測閉合；新盲點掃描無阻塞（2 觀察：A「results 與 mcData 值層面矛盾以 results 為準」— 不採（與 guard 保守語意衝突，guard 落地後全棄值更安全）；B「delay 未消毒既有行為」— 風險段註記）。附 8 條實作精度要求。→ v5：風險段補 delay 註記（觀察 B）。
- **第 5 輪（v5）：3/3 ✅ 通過 — 定案** —
  - 委員 #1（控制流/時序）：**✅ 通過（逐節）** — per-word guard 對健全存檔零變化成立（pickOption 同源寫 results＋_answered=true → guard 恆通過）；guard 位置要求正確（依賴 mcData 迴圈先執行）；9i 精確可測（guard 漏寫必紅）；前 4 輪全部 ❌/nit 全數落地；無新阻塞盲點。附 3 nit（9h 構造依賴 mcData answered:true 明載；9i「走序列化分支」斷言間接 — 分支寫反由驗證 7 兜底；9i 的 A mcData 需完整欄位）＋4 條實作精度要求（3(b) 位置鐵律、9h harness 構造、9i harness 構造、guard 語法一字不差）。
  - 委員 #2（資料序列化/存檔）：**✅ 通過（逐節）** — F1 修法經 6 組 node 模擬實錘全對（F1 反例正確棄值 B→undefined、健全存檔零變化、B1-era fallback、F2 短陣列、刪字、9g 二度 resume）；9i 完整覆蓋 F1 四段斷言；前 4 輪全部 ❌ 點逐一核對落地；新盲點掃描無阻塞。附 2 nit（9i「手動下一題」需 harness 直接呼叫 nextWord 兩次 — B 未答分支無 emNextBtn、且作答 B 會寫 results[1] 破壞斷言；9i 明載 session.idx=0）＋4 條實作精度要求（guard 與 3(a) _answered=false 必須同批落地 — 缺一則 F1 防禦失效）。
  - 委員 #3（交叉審查）：**✅ 通過（最終定案）** — v5 與 v3 定案一致、範圍無擴張（guard 是「更保守」方向）；前 4 輪 12 委員意見零遺漏；3(b) guard 與「results 權威」相容且更保守（觀察 A 落地：mcData 決定 answeredness、results 決定 value）；flip/spell 零誤傷；禁區遵守；驗證 1-9i＋10-12 逐項可測閉合。附 2 nit（v5 標題歸因不精確 — 內容全在文中僅歸因註記不完整；fallback/guard 畸形值條件微不對稱 — 真實存檔不可能觸發）＋10 條實作精度要求（動工檢核清單）。

## 定案聲明（憲法第 3 條 — 3/3 ✅ 通過，准予動工）

- 修法範圍：**僅 `src/pages/exam-mc.js`**（方案 1-6＋3(a)-(c)）＋本計畫書＋`_dev/notes/verify-b3.mjs`（驗證工具）。
- 禁區零變更：store.js / chart.js / base.css / lib.rs。
- commit 只 add 三檔，與首相 A/C 工作區改動（chart.js/base.css 等）分離（憲法第 9 條）。
- 動工後必須：verify-b3.mjs 全綠（含 9b-9i）＋verify-b2.mjs 64/64 回歸＋node --check＋vite build。

## 實測結果（憲法第 4 條 ✅ — 2026-08 動工後）

- **verify-b3.mjs：90/90 全綠**（T1-T9i 全情境：正常作答回歸／延遲窗 exit→resume 續跳不重答不雙計／無 mcData 損壞存檔當未作答＋不計分／applyTags 未答 skip／resume timer×onMount guard 無競態／末題 resume 閉合／刪字 lockstep 值對齊／autoNext 關手動續跳／二度 resume 零雙計／尾窗 exit 殘留防護／尾窗 bottom-nav 補跳恰 1 題／尾窗作答嘗試 :272 擋重答／B1-era 空 results fallback／NaN idx clamp／方案 A 全生命週期（含跨場洩漏堵點）／re-arm 遞迴 3 題連續已答逐層續跳／畸形存檔 per-word guard 棄值不標 wrong）。
- **verify-b2.mjs 回歸：64/64 全過**（B1/B2 架構無回歸）。
- **node --check**：exam-mc.js／exam-flip.js／exam-spell.js／verify-b3.mjs 全過。
- **grep 覆核**：applyTags 函式邊界內 `w._picked === _correctIdx` 殘留 = 0（renderExam :140/:141/:146 顯示判斷 3 處合法保留）；`e.results[e.idx]` 寫入恰 1 點（:303）。
- **`npm run build`（vite build）：通過**（chunk size 警告為既有，非本次引入）。
