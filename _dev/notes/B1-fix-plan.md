# B1 — exam-flip applyTags 平行陣列（v5 — 定案 ✅）

狀態：**第 5 輪 3/3 ✅ 通過 — 定案可實作（2026-08）**
關聯：v3 定案 ✅（+buildSession 補強）

## ⚠️ 實作精度要求（第 5 輪委員附，必須遵守）

1. **e.id/e.decks/e.settings/e.correct/e.wrong/e.totalTime 六行移到 `if (!Array.isArray(session.results))` 之前** — 否則 sentinel 分支與 -1 結果頁拿到上一場殘留統計（renderResult 顯示錯誤、efTagBtn disabled）
2. **sentinel 分支刪字 remap**：`session.idx` 是原始座標，`e.words` 是存活座標 — 用 `const deletedBefore = session.wordIds.slice(0, session.idx).filter(id => !wordMap.has(id)).length; e.idx = Math.max(0, Math.min((session.idx ?? 0) - deletedBefore, e.words.length - 1));`
3. **-1 分支補 `e.idx`**（殘留髒狀態）
4. **NaN clamp**：`Number.isFinite(session.idx) ? ... : 0`
5. **guard 卡死補救**（onMount exam 區塊）：`if (e.judged && e.settings.autoNext && !e.autoNextTimer) nextWord(s);` — bottom-nav 離開又回來時不卡死

## Bug 定義

exam-flip 的「套用標籤」功能用**前綴推斷**判斷每題對錯，答題順序非「先全對再全錯」時標籤會標錯：

```js
// exam-flip.js:281-286（現況）
const wc = e.words.slice(0, e.correct + e.wrong);
for (let i = 0; i < wc.length; i++) {
  const tag = i < e.correct ? tc : tw;  // ← 前綴推斷：前 correct 題都是對的？
```

實錘：e.correct=2、e.wrong=1，但實際順序是 對/錯/對 → i=0 推斷 tc（對✅）、i=1 推斷 tc（錯❌，實際答錯）、i=2 推斷 tw（錯❌，實際答對）→ 第 2、3 題標籤反了。

**範圍確認**：exam-mc.js:298 用 `w._picked === w._correctIdx`、exam-spell.js:290 用 `w._correct` — **都已 per-word 正確，只有 exam-flip 有 bug**。

## Root Cause

exam-flip 只有累計計數器 `e.correct`/`e.wrong`，沒有記錄「每一題的作答結果」；applyTags 只好用前綴推斷，順序一亂就錯。

## v5 修正方案（吸收第 1/2/3/4 輪委員盲點）

### 1. `e` 初始物件加 `results`＋`autoNextTimer`（exam-flip.js:6-18）

```js
let e = {
  // ...現有欄位
  results: [],       // per-word 作答結果：undefined/null=未答 / true=對 / false=錯 / 'old'=舊存檔未知
  autoNextTimer: null,  // autoNext 的 timer id（exit/重啟時清理）
};
```

### 2. startExam 初始化（**在 :213 `e.words = words` 之後**，:214-219 reset 區塊內）

```js
if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }  // 不能只設 null（殘留 timer 污染下一場）
e.results = new Array(e.words.length).fill(undefined);
```

### 3. resumeSession 還原（:224-241）— lockstep 過濾＋**v5：sentinel 舊存檔分支**

⚠️ **保留既有 :228-230（e.id/e.decks/e.settings）與 :233-235（e.correct/e.wrong/e.totalTime）賦值** — snippet 是 resume 流程的 results/idx 部分，不是整段替換。

```js
const pairs = session.wordIds
  .map((id, i) => [wordMap.get(id), session.results ? session.results[i] : undefined])
  .filter(([w]) => w);
if (!pairs.length) { toast('無法恢復進度：單字已不存在', 'toast-error'); return; }
e.words = pairs.map(p => p[0]);
if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }

if (!Array.isArray(session.results)) {
  // v5：舊存檔（無 results）→ sentinel 'old' 標記「舊答、未知對錯」+ 之後真正未答
  // 效果：重存後 firstUn = e.idx（正確續答），不跳回、不雙計；applyTags 對 'old' 漏貼（預期降級）
  e.idx = Math.max(0, Math.min(session.idx ?? 0, e.words.length - 1));
  e.results = new Array(e.words.length).fill('old');
  e.results.fill(undefined, e.idx);
  e.phase = 'exam';
  e.answered = false; e.judged = false; e.cardStart = Date.now();
  renderInPlace(s);
  return;
}

e.results = pairs.map(p => (p[1] == null ? undefined : p[1]));  // null→undefined 正規化
const firstUn = e.results.findIndex(r => r == null);
if (firstUn === -1) {
  // v5：全部答完（最後一題延遲窗退出）→ 直接結果頁（計數與 results 完整，applyTags 可全標，零雙計）
  e.phase = 'result';
  renderInPlace(s);
  return;
}
e.idx = firstUn;
e.answered = false; e.judged = false; e.cardStart = Date.now();
e.phase = 'exam';
renderInPlace(s);
```

（v5 修正：-1 不再 fallback session.idx 重問最後一題 — 那是已答已計的卡，重問會覆寫 results[last]＋雙計。直接結果頁最乾淨。）

### 4. 作答時寫入（answerCorrect :243 / answerWrong :252）

```js
// answerCorrect：e.results[e.idx] = true;   （在 e.correct++ 旁）
// answerWrong：  e.results[e.idx] = false;  （在 e.wrong++ 旁）
// autoNext（:248/:257）：
if (e.autoNextTimer) clearTimeout(e.autoNextTimer);   // 堵死殘留
e.autoNextTimer = setTimeout(() => { e.autoNextTimer = null; nextWord(s); }, e.settings.delay * 1000);
```

### 5. nextWord 加 phase＋page guard（:261-271）— v5：bottom-nav 也蓋

```js
function nextWord(s) {
  if (e.phase !== 'exam' || s.state.currentPage !== 'exam-flip') return;  // v5：bottom-nav 直連 navigate 時 phase 仍 'exam'，需 page 檢查
  e.idx++;
  // ...其餘不變
}
```

### 6. applyTags 改用 results（:273-296）— v5：嚴格 true/false

```js
for (let i = 0; i < e.words.length; i++) {
  const r = e.results && e.results[i];
  if (r !== true && r !== false) continue;   // v5：跳過 undefined/null/'old'（'old' 是舊存檔未知，不能標）
  const w = e.words[i];
  if (!w) continue;
  const tag = r ? tc : tw;
  // ...其餘（opposite / filter / push / editWord）不變
}
```

### 7. buildSession 序列化 results（exam-session.js:48-62）

```js
// 加一行：results: [...(e.results || [])],
```

（對 mc/spell 無害：兩者 e 無 results → `[]`，無讀取者。）

### 8. efExitBtn 清 timer（:365-370）

```js
// handler 第一行：
if (e.autoNextTimer) { clearTimeout(e.autoNextTimer); e.autoNextTimer = null; }
// 再 buildSession → saveExamSession → config
```

## 使用點窮舉（憲法第 2 條）

| 檔案 | 位置 | 動作 |
|---|---|---|
| exam-flip.js | :6-18 | e 初始物件加 results: []＋autoNextTimer: null |
| exam-flip.js | :213 後（reset 區塊） | startExam clearTimeout＋fill(undefined) |
| exam-flip.js | :224-241 | resumeSession lockstep＋**sentinel 舊分支＋-1 結果頁** |
| exam-flip.js | :243-250 | answerCorrect 寫 results＋timer 設前 clear |
| exam-flip.js | :252-259 | answerWrong 寫 results＋timer 設前 clear |
| exam-flip.js | :261-271 | nextWord 加 phase＋page guard |
| exam-flip.js | :273-296 | applyTags 改 per-word（嚴格 true/false） |
| exam-flip.js | :365-370 | efExitBtn clearTimeout＋buildSession |
| exam-session.js | :48-62 | buildSession 加 results 欄位 |
| exam-mc.js / exam-spell.js | — | **不動**（已正確） |

## 驗證項目

1. Node 模擬：對/錯/對 亂序 3 題 → applyTags 標籤 = tc/tw/tc
2. Node 模擬：未答題（undefined 與 **JSON round-trip 後的 null**）→ 跳過不改 tag
3. **JSON round-trip 驗證**：`JSON.stringify/JSON.parse` 模擬 db.js:342/338 → resume → applyTags，未答題不被標
4. **刪字錯位驗證**：session 含被刪單字 → resume → results 與 words 對齊
5. **當前題被刪驗證**：session.idx 指向的字被刪 → resume → idx 落在下一個未答
6. **全答完 resume 驗證**（v4/v5）：results 全非 null → resume → 直接結果頁，零雙計
7. **舊存檔 resume 驗證**（v4/v5）：無 results 欄位 → sentinel 'old'＋idx=min(session.idx)，從中途繼續
8. **舊存檔二次 resume 驗證**（v5 新增）：舊分支 resume → 作答 → 重存 → **第二次 resume firstUn = e.idx，不跳回第 1 題**
9. **bottom-nav 離開驗證**（v5 新增）：exam 中點 bottom-nav → 殘留 timer fire → page guard 擋住不蓋頁
10. autoNext timer：exit 後無殘留 fire（三保險）
11. `vite build` 通過
12. 瀏覽器實測：exam-flip 亂序作答 → 套用標籤 → 檢查每題 tag

## 風險

- 舊存檔（無 results）resume 後 applyTags 對 'old' 段跳過不貼標籤（現況是「貼錯但至少貼了」）— **預期降級：寧可漏貼不亂貼**，release note 明載
- buildSession 多 results 欄位對 mc/spell 存檔多空陣列（無害）
- applyTags 逐題 await editWord 是既有 O(n) 瓶頸，非本次引入 — 另立後續議題
- resume 後重答當前題會使 correct/wrong 重複計數（既有行為，非本次引入）— 另立議題
- **mc/spell 也有同款 autoNext timer 競態＋bottom-nav 離開無清理**（exam-mc.js:274、exam-spell.js:261/:263；main.js:235-243 bottom-nav 直連 navigate）— 另立議題，不在 B1 範圍。**v5 的 page guard 只修 flip，mc/spell 未修**

## 審查歷程

- v3 定案：✅（buildSession 補強，+results 序列化）
- 第 1 輪（v1）：2❌1✅ — undefined→null 序列化＋resume filter 索引錯位 → v2
- 第 2 輪（v2）：2✅1❌ — idx edge case（當前題被刪跳回第 1 題）→ v3
- 第 3 輪（v3）：3❌ — 首個未答 idx -1 死角＋舊存檔重頭回歸＋timer clear → v4
- 第 4 輪（v4）：2✅1❌ — **舊存檔二次 resume 跳回第 1 題（sentinel 方案）＋保留既有賦值＋-1 直接結果頁＋bottom-nav page guard＋負值 clamp** → v5 修正
- 第 5 輪：送審中
