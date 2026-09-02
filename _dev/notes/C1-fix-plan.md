# C1-fix-plan — undo 快照模式隔離（多槽 _undoSnapshots[mode]）

> 版本：v1.3（R3 終審勘誤處置 — 定案，准予動工）
> 範圍：組一「學習核心」— src/lib/store.js、src/engine/session-utils.js、src/engine/session-mc-utils.js、src/engine/session-spell-utils.js、src/lib/db.js（C1 計畫所需 — v3 定案明列）、tools/verify-c1-undo-modes.mjs（新增驗證工具）
> 依據：fix-plan-critical-v3.md 批次 4（C1 → C2 同批同一段 code；本計畫為 C1 部分，**C2 另案 — 本任務只做 C1**，但 §3.1c 含 C1 不引入回歸的必要配套）
> 狀態：**R1：#1 ✅附／#2 ❌／#3 ✅附 → R2：#1/#2/#3 全 ❌（HIGH-1 SQL 修正無效實錘＋HIGH-2 mcData 回歸）→ R3：#1/#2/#3 附條件 ❌（HIGH-1 leech 死碼實錘＋MED-1 live 時序＋MED-2 memory 分歧＋!hadCard 補洞）→ v1.3 全數勘誤 → 定案 ✅ 准予動工**

---

## 1. Bug 定義

v3 定案語意（fix-plan-critical-v3.md:115-120，⚠️ 語意定死後可實作）：

1. **選槽規則**：`undoLastRating(mode)` 帶 mode 參數（三個 session-utils 各傳自己的 mode）；`state._undoSnapshots[mode]`
2. **計數器語意**：每 slot 只存/只還原自己 mode 的計數器（flip slot 存 newRatedToday、mc 存 newRatedTodayMc、spell 存 newRatedTodaySpell）；goalStreak 只還原 `dates[mode]` 子陣列 + 重算 current/best
3. **log 刪除**：DB `DELETE FROM review_log WHERE id > ? AND COALESCE(mode,'flip') = ?`；memory pop 改「從尾端移除 mode 相符 entry 至該模式 baseline」

> R1（#3 M2）補註：card/baseCard/mcData 維度的完整還原屬 C2 範圍（快照 :565-566 捕獲條件、undo :723 mode guard、:731-743 restore 分支）— 但 **C1 不得引入新回歸**：§3.1c 含「flip undo 不覆寫他 mode 的 mcData/spellData」合併保護（R2 #2 HIGH-2 實錘必要性，見 §3.1c）。
> R1（#3 L4）補註：**leech tag 還原語意變更（整陣列 → 單 tag）為 C1 附加行為修正**（修正 over-rollback，§3.1g），v3 未明列，本計畫明列送審並已過 R1/R2 裁決。

現況（src/lib/store.js，A1/A2 落地後行號）：

- **單一快照槽**：`state._undoSnapshot`（初始 :84；寫入 :555-571）— 三個 mode（flip/mc/spell）共用同一槽，後評分的 mode 直接覆蓋前一個
- **undo 無 mode 參數**：`undoLastRating()`（:710-779）— 行為完全由最後一次評分的快照決定
- **計數器全域還原**（:754-756）：三顆計數器全部回滾到快照時值
- **goalStreak 整顆還原**（:769-773）：連同其他 mode 的 `dates[mode]` 進度一併回滾
- **DB log 全域刪除**：`db.deleteReviewLogsAfter(snap.logId)`（:752）→ db.js:446 `DELETE FROM review_log WHERE id > $1` **無 mode 過濾**
- **memory log 全域 pop**（:753）：`while (state.reviewLog.length > (snap.reviewLogLength ?? 0)) pop()` — 同樣回滾其他 mode 的 entry

**具體故障（跨模式實境）**：

- flip 評 A → mc 評 B → flip 頁按 undo：session-utils 執行 `undoLastRating()`，快照已被 mc 覆蓋 → 還原的是 B（mc）而非 A，**A 的評分無法 undo**
- 同槽覆蓋後任何 undo：計數器/goalStreak/reviewLog 全部回滾到「最後一次評分」前 — 前一個 mode 的評分記錄（DB log、memory log、計數器、進度）全部被誤刪/誤回滾
- 目標語意（v3）：undo 只還原「該 mode 最後一次評分」造成的變化，其他 mode 的快照、計數器、log、進度一律不動（card/baseCard/mcData 維度：C1 合併保護＋C2 完整還原）

## 2. Root Cause

store.js 的 undo 快照機制為「**單槽 + 全域還原**」設計：

1. 快照只有一份（`state._undoSnapshot`），三個 mode 的 session 共用同一個 store action，跨 mode 評分互相覆蓋 → 只剩最後一個 mode 可 undo；
2. 還原的各維度（計數器 ×3、goalStreak 整顆、review_log 全域）都以「全域」為回滾單位，**沒有 mode 維度** → 即使快照正確，undo 也會回滾其他 mode 的狀態。

共同根因：**快照的儲存粒度與還原粒度都沒有按 mode 隔離**，而 review_log、goalStreak、newRatedToday* 在資料模型上都是 mode 感知的（review_log.mode 欄位、goalStreak.dates[mode]、三顆計數器）。

## 3. 修法（檔名:行號 — 現況行號）

### 3.1 src/lib/store.js

**（a）:84 state 初始** — 單槽改多槽：

```js
_undoSnapshot: null,   →   _undoSnapshots: {},
```

**（b）:555-571 快照寫入** — 依 mode 選槽 + 語意定死：

```js
// R2（#3 L2）：寫端與讀端對稱加防呆
(state._undoSnapshots ||= {})[mode] = {
  wordId, mode,
  logId: maxLogId,
  // 該 mode 在 memory reviewLog 的 entry 數（baseline）— undo 只把該 mode 還原到此數
  modeLogCount: state.reviewLog.filter(l => (l.mode || 'flip') === mode).length,
  // 只存自己 mode 的計數器（v3 定案）
  ratedToday: mode === 'mc' ? state.newRatedTodayMc
    : mode === 'spell' ? state.newRatedTodaySpell
    : state.newRatedToday,
  hadCard: !!card,
  prevCard: card ? { ...card } : null,
  hadBaseCard: !!baseCardForSnapshot,
  prevBaseCardMcData: mode !== 'flip' && state.cardsMc.get(wordId) ? { ...state.cardsMc.get(wordId) } : null,
  prevBaseCardSpellData: mode !== 'flip' && state.cardsSpell.get(wordId) ? { ...state.cardsSpell.get(wordId) } : null,
  // 該 mode 的 leech tag 是否存在 — undo 只增刪自己的 'leech-<mode>' tag
  leechTagBefore: !!word.tags?.includes('leech-' + mode),
  // goal 每日進度：評分時 incrementGoal 會 push today + 更新 current/best
  goalStreakBefore: JSON.parse(JSON.stringify(state.goalStreak)),
};
```

> 舊欄位 `reviewLogLength`（總長度）與 `wordTagsBefore`（完整 tags 陣列）**移除** — 兩者都是「全域還原」的載體。R1/R2 實查：兩欄位僅 :558/:568 寫入 + :753/:761-762 讀取，無其他消費端。
> R1（#1）實查：`word`(:537)、`card`(:550)、`baseCardForSnapshot`(:552)、`maxLogId`(:553-554) 均在 :555 前定義；`modeLogCount` 於 :692 push 之前計算；`leechTagBefore` 先於 :670 leech push 捕獲 — 時點全部正確。

**（c）:710-750 undoLastRating(mode) + flip undo 合併保護**：

```js
async undoLastRating(mode = 'flip') {
  const snap = (state._undoSnapshots || {})[mode];
  if (!snap) return;
  const m = snap.mode;   // 快照內 mode 為準（與選槽 key 必然一致；防呆）
  // R1（#1 MED-1）寫死：新簽名參數 mode 與舊 :714 解構出的 mode 同名 → 同作用域重複 const 宣告會 SyntaxError；
  // :714 解構列移除 mode，body 內原引用 mode 處（:715 cardMap 選槽、:723 'flip' guard）一律改用 m
  const { wordId, prevCard, hadCard, prevBaseCardMcData, prevBaseCardSpellData } = snap;
```

其後 :714-750 邏輯**不變**（cardMap 還原 + baseCard 的 mcData/spellData 還原 + DB saveCard/deleteCard），僅變數來源改為 `m`。⚠️ :723 `if (m !== 'flip')` 的 mode guard 與 :565-566 的捕獲條件屬 **C2 範圍，本計畫只做變數改名（語意不變），不動邏輯**。

> **R2（#2 HIGH-2）＋R3（#1/#2/#3 MED）定案 — flip undo 的 mcData/spellData 合併保護**（C1 不引入回歸的必要配套）：
> - 同卡 A 先 flip 評分、後 mc 評分時，flip undo 的 `saveCard(wordId, prevCard)`（:746）會把 DB baseCard 整卡覆寫成 prevCard（其 mcData 為 flip 快照時值/undefined）→ mc 評分寫入的 baseCard.mcData（:656）在 DB 層被抹掉（memory cardsMc 仍有，reload 後分歧遺失）。修前單槽下此情境 undo 的是 mc（走 :723-743 分支），修後 flip undo 撤銷 flip 是 C1 目的 — 故 C1 必須保護。
> - **R3 勘誤 1（MED-1）**：`live` 必須在 **:717-721 cardMap 還原之前**讀取（flip undo 時 :717 會把 `state.cards` 還原成 prevCard，還原後讀到的 live === prevCard，保護靜默失效 — R3 實測證實）→ live 捕獲移至函式頂部（見下方 code，置於解構之後、:717 之前）。
> - **R3 勘誤 2（MED-2）**：else 分支 `db.saveCard(merged)` 後須同步 memory `state.cards.set(wordId, merged)`（防 memory/DB 分歧 — 否則下次 flip 評分 :662 saveCard(newCard) 再把 DB 的 mcData 抹掉）。
> - **R3 勘誤 3（#2 HIGH-1）**：`!hadCard` 分支（flip 首次評分建立該卡）補洞 — 現況 `deleteCard(wordId)` 連 baseCard row 的他 mode mcData/spellData 一起刪（C2 救不到：flip 快照的 prevBaseCardMcData 恆為 null，:565 排除 flip mode）→ 當 live 卡身上有他 mode 資料時，不整卡刪，改存 restore 形物件（鏡像 :733-739 語意，state=0 無 due — 與 A12 容器卡語意一致）。
>
> ```js
> // ═══ undoLastRating 內，:714 解構之後、:717 cardMap 還原之前 ═══
> const liveFlipCard = state.cards.get(wordId);
> //   ^ 合併保護用 — 必須先於 cardMap 還原讀取（R3 MED-1 勘誤：flip undo 時
> //     cardMap === state.cards，還原後讀取會拿到 prevCard 自身 → 保護失效）
>
> // :717-721 cardMap 還原（現況邏輯不變，變數 mode → m）
>
> // ═══ else 分支（:744-750 對應）定案 ═══
> // } else {
> //   if (hadCard && prevCard) {
> //     const merged = { ...prevCard };
> //     if (liveFlipCard && (liveFlipCard.mcData || liveFlipCard.spellData)) {
> //       merged.mcData = liveFlipCard.mcData ?? prevCard.mcData;
> //       merged.spellData = liveFlipCard.spellData ?? prevCard.spellData;
> //     }
> //     state.cards.set(wordId, merged);   // R3 MED-2：memory 同步（防分歧）
> //     try { await db.saveCard(wordId, merged); } catch (e) { console.warn('[store] undo saveCard error:', e); }
> //   } else if (liveFlipCard && (liveFlipCard.mcData || liveFlipCard.spellData)) {
> //     // R3 勘誤 3：flip 首次建立卡、他 mode 已寫入資料 → 不整卡刪，保留他 mode 資料
> //     const restore = { due: '', stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0,
> //       reps: 0, lapses: 0, state: 0, step: 0, lastReview: null, buried: false, suspended: false,
> //       interval: 0, mcData: liveFlipCard.mcData ?? undefined, spellData: liveFlipCard.spellData ?? undefined };
> //     state.cards.set(wordId, restore);   // memory 同步
> //     try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
> //   } else {
> //     try { await db.deleteCard(wordId); } catch (e) { console.warn('[store] undo deleteCard error:', e); }
> //   }
> // }
> ```

> 語意：flip undo 把卡還原成 prevCard，但**保留現有卡身上的 mcData/spellData**（他 mode 評分寫入的，flip undo 不該動）；`!hadCard` 時若卡是他 mode 資料的載體，以 restore 卡承接（不刪）。C2 另案處理 :565-566 捕獲條件與 :731-743 restore 分支的其餘部分 — 本保護與 C2 互補不重疊。

**（d）:752 DB log 刪除帶 mode**：

```js
try { await db.deleteReviewLogsAfter(snap.logId, m); } catch (e) { console.warn('[store] undo deleteReviewLog error:', e); }
```

**（e）:753 memory pop 改 mode 過濾**：

```js
let mcount = state.reviewLog.filter(l => (l.mode || 'flip') === m).length;
for (let i = state.reviewLog.length - 1; i >= 0 && mcount > (snap.modeLogCount ?? 0); i--) {
  if ((state.reviewLog[i].mode || 'flip') === m) { state.reviewLog.splice(i, 1); mcount--; }
}
```

> 語意：undo flip 只把 flip 的 entry 數還原到快照時的 baseline；快照後 mc/spell 新增的 entry 保留（其 log id > snap.logId 且 mode 不符 → DB 側也不會誤刪，兩端一致）。
> R1（#3 M4）＋R2（#2 MED-1）**memory/DB 等價性前提（寫死）**：① addReviewLog（store.js:678）為 `await` 且先於 `state.reviewLog.push`（:692）→ memory 順序與 DB id 順序一致；**例外：addReviewLog 拋錯被 :688-690 catch 時 memory 有 entry、DB 無（既有行為）→ §5-5c 比「最終狀態一致」而非「移除集合相等」**；② getAllReviewLogs 為 `ORDER BY reviewed_at`（db.js:387）— 同 mode 相對順序與 id 序一致的前提是 **reviewed_at 對 id 單調**（生產端唯一 INSERT 端 store.js:678 恆傳 `now`，成立；R2 #2 實測同刻 tie 回 rowid 序 OK，但亂序 timestamp 即破壞）→ **配套：db.js:387 改 `ORDER BY reviewed_at, id`**（一行消除 spec 不確定性，見 §3.3b）。

**（f）:754-756 計數器只還原自己 mode**：

```js
if (m === 'mc') state.newRatedTodayMc = snap.ratedToday;
else if (m === 'spell') state.newRatedTodaySpell = snap.ratedToday;
else state.newRatedToday = snap.ratedToday;
```

> R1（#1 LOW-4 / #2 L-4 / #3 L2）註記：undo 尾端 :777 `refreshDerived()` 會以 DB 重算三顆計數器（:378-380，mode-scoped DELETE 之後）。正常路徑重算值與快照值恆等，此顯式賦值為 v3 明列要求（保留，非 dead code）；**僅當 DB delete 失敗（:752 catch）時以 refreshDerived 的 DB 值為準**（既有行為）；跨日 undo 重算值 ≠ 快照值亦為既有行為。

**（g）:758-767 leech tag 精準還原**（C1 附加行為修正，R1/R2 已裁決）：

```js
const undoWord = state.words.find(w => w.id === wordId);
if (undoWord) {   // R3（#1/#3 HIGH-1）勘誤：外層只 guard undoWord 存在 —
  //   若外層加 `&& snap.leechTagBefore`，false 時整段跳過 → 下方「移除」分支成死碼，
  //   leech tag 永不還原（R3 實測復現：leechTagBefore=false 評分觸發 leech 後 undo 殘留）
  const tag = 'leech-' + m;
  const has = undoWord.tags?.includes(tag);
  if (snap.leechTagBefore && !has) {
    if (!undoWord.tags) undoWord.tags = [];
    undoWord.tags.push(tag);
  } else if (!snap.leechTagBefore && has) {
    undoWord.tags = undoWord.tags.filter(t => t !== tag);
  }
  try { await db.saveWord(undoWord); } catch (e) { console.warn('[store] undo saveWord error:', e); }
}
```

> R1（#3 M1）論證（已裁決）：rateCard 對 word.tags 的 mutation 為 leech push（:669-672，`includes` guard 冪等），rateCard 之外另有 exam-flip applyTags（src/pages/exam-flip.js:342-346）、store 手動 tag 增刪（store.js:1128-1129/:1172-1173）→ 新法把 undo 語意定義為「只還原 rateCard 造成的變化」，單 mode 無夾雜時與現況等價、有夾雜時不 over-rollback（修正既有缺陷）。
> R1（#3 L1）註記：tags 原本為 `[]` 時現況 :764 是 `delete undoWord.tags`（memory 變 undefined），新法保持 `[]`；DB 側一致（saveWord 序列化 `word.tags || []`，db.js:128），接受。

**（h）:769-773 goalStreak 只還原 dates[mode] + 重算 current/best**：

```js
if (snap.goalStreakBefore) {
  const gs = state.goalStreak;
  const dates = gs.dates || {};
  const beforeDates = snap.goalStreakBefore.dates?.[m];
  dates[m] = beforeDates ? [...beforeDates] : [];
  const tzOffset = m === 'mc' ? state.ankiSettingsMc?.timezoneOffset
    : m === 'spell' ? state.ankiSettingsSpell?.timezoneOffset
    : state.ankiSettings?.timezoneOffset;
  const { computeStreak, computeBestStreak } = requireScheduler();
  const current = computeStreak(dates[m], state.dayCutoff, tzOffset);
  const best = Math.max(gs.best || 0, computeBestStreak(dates[m], state.dayCutoff, tzOffset));
  state.goalStreak = { ...gs, current, best, dates };
  try { await db.saveGoalStreak(state.goalStreak); } catch (e) { console.warn('[store] undo saveGoalStreak error:', e); }
}
```

> R2（#3 L3）註記：`gs`≡`state.goalStreak`、`dates`≡`gs.dates` 同引用；`dates[m] = [...]` 以新陣列替換屬**刻意**（與 incrementGoal :912-918 原地 push 的僅有差異 — 避免污染快照來源），勿改為拷貝 `gs.dates`；`beforeDates` 來自深拷貝快照，無共享。
> current 語意與 incrementGoal（:906-919）一致（per-mode 連續天數；tzOffset 三選一 :908-910、computeStreak/computeBestStreak 參數順序 (dates, dayCutoff, tzOffset) 全部同形 — R1/R2 實查）；best = `max(現有全域 best, 該 mode 還原後重算)` 保守不降級（schema 無 per-mode best 欄位）。R2（#2 LOW-4）註記：computeBestStreak 對未來日期會計入連續段（與 incrementGoal 同款既有行為，非 C1 引入）。

**（i）:775 清槽**：

```js
state._undoSnapshot = null;   →   delete state._undoSnapshots[m];
```

### 3.2 三個 session-utils — undo 呼叫帶自己的 mode

| 檔案:行號 | 現況 | 改為 |
|---|---|---|
| `src/engine/session-utils.js:152` | `await store.actions.undoLastRating();` | `await store.actions.undoLastRating('flip');` |
| `src/engine/session-mc-utils.js:164` | `await store.actions.undoLastRating();` | `await store.actions.undoLastRating('mc');` |
| `src/engine/session-spell-utils.js:154` | `await store.actions.undoLastRating();` | `await store.actions.undoLastRating('spell');` |

> R1（#2）實查：三個 session-utils 的 rateCard mode（session-utils:95 'flip'、mc:106 'mc'、spell:103 'spell'）與 incrementGoal mode（:101/:111/:108）一一對應。

### 3.3 src/lib/db.js（C1 計畫所需 — v3 定案明列 log 刪除語意）

**（a）:445-447 deleteReviewLogsAfter 加 mode 過濾** — **R2 定案（COALESCE 內固定字面量 'flip'，即 v3 原文 fix-plan-critical-v3.md:118）**：

```js
export async function deleteReviewLogsAfter(id, mode) {
  const m = mode || 'flip';   // 防 undefined 參數（呼叫端已窮舉，純保險）
  await requireDB().execute(
    "DELETE FROM review_log WHERE id > $1 AND COALESCE(mode, 'flip') = $2",
    [id, m]
  );
}
```

> ⚠️ **R2（三委員一致實錘）HIGH-1 修正歷程**：v1.0 原案 `COALESCE(mode, $2) = $2` 與 v1.1「`mode || 'flip'` 正規化 + `COALESCE(mode, $2) = $2`」**均為無效修正** — `COALESCE(NULL, $2)` 恆等於 `$2`，mc/spell undo 時 $2='mc'/'spell' → NULL mode 行恆匹配照刪（node:sqlite 實測：['flip','mc','spell',NULL] 跑 mc undo → 剩 ['flip','spell']，NULL 被誤刪；v1.0/v1.1 結果相同）。**正解是 COALESCE 內固定字面量 `'flip'`、比較右側參數化**：NULL 行恆視為 flip，僅 flip undo（$2='flip'）會刪 NULL 舊 log，mc/spell undo 保留 — 三委員各自實測全 PASS。
> R2（#2 MED-2 / #1 LOW-1）註記：真實 schema `mode TEXT NOT NULL DEFAULT 'flip'`（lib.rs:1584，SQLite ADD COLUMN 對既有列回填 DEFAULT）→ **真實資料 NULL 理論上不存在**（唯一 INSERT 端 db.js:380 亦 `entry.mode || 'flip'` 正規化）；COALESCE 純為防禦性保險（v3 定案明列仍須）。§6 風險表已註明影響面理論性。
> 唯一呼叫端 store.js:752（grep 實查）；`deleteLastReviewLog`（:449-451）無呼叫端，不改。

**（b）:387 getAllReviewLogs 排序加 id 次鍵**（R2 #2 MED-1 配套，一行）：

```js
const rows = await requireDB().select('SELECT * FROM review_log ORDER BY reviewed_at, id');
```

> 目的：消除 `ORDER BY reviewed_at` 對同刻 timestamp 的順序不確定性（SQL 標準未保證 tie 順序）— 使 §3.1e 等價性前提②（同 mode 相對順序 = id 序）在 spec 層面成立。不影響既有消費端語意。

### 3.4 tools/verify-c1-undo-modes.mjs（新增驗證工具）

> R1（#2 MED-1 / #3 H2）＋R2（#1 MED-2/MED-3）**理由（寫死）**：store.js 頂層 import 僅 db/backup-scheduler/fsrs/rng；tauri 依賴為 db.js:10 的**動態** `import('@tauri-apps/plugin-sql')`＋backup-scheduler.js:1 → api.js:1 的**靜態** `import { invoke } from '@tauri-apps/api/core'`（node 下可載入，因 node_modules 已安裝）。`import('./src/lib/store.js')` 實測成功。真實障礙：rateCard/undo 尾端 `refreshDerived()`（:705/:777 → :378-380）的 `db.getNewRatedToday` **無 try/catch**，db 未初始化即拋。

工具雙層設計（優先真實 store，SQL 語意獨立實測）：

- **層 1（真實 store 驅動）**：
  1. `node --experimental-test-module-mocks` 下以 `node:test` 的 `mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } })` 攔截 db.js:10 的動態 import（**R3 #1 LOW-1：node v26 用 `exports.default` 新語法，`defaultExport`/`namedExports` 已棄用**）— **FakeDatabase 包 node:sqlite in-memory**；`mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } })` 攔截 api.js:1（防環境缺套件，R2 #1 實測可行）；
  2. **步驟 0（R2 #1 MED-3）**：`await dbMod.initDB()`（拿到假 DB）→ `await actions.init()`（node 下安全：localStorage/startAutoBackup 依賴被既有 try/catch 吞；⚠️ R3 #3 LOW-4：init 內 loadAll 可能於 :312 `window` 未定義中途 throw 被吞、state 部分填充 — 不影響後續覆寫 state，**覆寫必須在 init 之後**）→ 載入 requireScheduler（store.js:448，init 內已完成）→ **覆寫 state**（words/cards/cardsMc/cardsSpell/reviewLog/goalStreak/計數器）→ 之後 `rateCard`/`undoLastRating` 全真實路徑（選槽/計數器/goalStreak/reviewLog/leech/refreshDerived）；
  3. **綁定策略（R2 #3 MED-1 / #2 LOW-2，R3 #1 LOW-2 補）**：node:sqlite `DatabaseSync` **不支援 `$1/$2` 位置綁定**（拋 column index out of range）→ FakeDatabase 的 execute/select **內部須把 db.js 呼叫端傳入的位置陣列（如 :382 的 11 元素陣列）轉成 named-object `{ '$1': v, ... }`** 再綁定（實測可行），承接 db.js 全部 `$N` SQL；層 2 同策略；
  4. **FakeDatabase 建表要求（R3 #2 MED-2）**：cards 表須含 `mc_data`/`spell_data` TEXT 欄位（JSON 序列化），execute 須承接 db.js:200-224 saveCard 的 `INSERT…ON CONFLICT` 全欄位往返 — 否則 §5-11(b) 的「DB baseCard.mcData === mc 評分寫入值」與 reload 斷言空轉（層 2 只測 SQL 語意，測不到 §3.1c 真身）；
  5. 若環境 mock.module 不可用（node < 22.6），降級「複刻呼叫形狀」並在輸出註明（複製品，非真實 store）。
- **層 2（SQL 語意）**：node:sqlite in-memory 建 review_log 表，插入多 mode + NULL mode 資料，named-object 綁定實跑 §3.3(a) 定案 SQL，斷言刪除集合（NULL 視 flip、他 mode 保留、id > logId 邊界）。

### 3.5 不修改

- `src/lib/chart.js`、`src/styles/base.css`（任務禁令）
- 三個 session-utils 的**模組級** `_undoSnapshot`（session 層快照，各 mode 模組獨立變數 — 無跨 mode 覆蓋問題，C1 範圍外）
- `tools/verify-undo-cycle.mjs`、`tools/verify-next-after-undo.mjs`（mode 寫死 flip 的 FSRS/佇列循環驗證，不涉 store 快照 — 回歸實跑；範圍註記：兩工具以自身 JSON 深拷貝 / session 層快照模擬，C1 真驗證仰賴 verify-c1-undo-modes.mjs）
- C2 範圍：store.js :565-566 捕獲條件、:723 mode guard 邏輯、:731-743 restore 分支 — 另案（§3.1c 的合併保護為 C1 不引入回歸的必要配套，與 C2 互補不重疊）
- `goalStreak.dailyGoal`、全域 `best` 欄位語意（incrementGoal 既有行為）
- `deleteLastReviewLog`（無呼叫端死碼）

## 4. 使用點窮舉（grep 三形態）

### 4.1 `undoLastRating` 呼叫端（grep 形態一）

| 檔案:行號 | 用途 | 處置 |
|---|---|---|
| `src/lib/store.js:710` | action 定義 | 簽名改 `(mode = 'flip')` + 選槽 |
| `src/engine/session-utils.js:152` | flip undo | 傳 'flip' |
| `src/engine/session-mc-utils.js:164` | mc undo | 傳 'mc' |
| `src/engine/session-spell-utils.js:154` | spell undo | 傳 'spell' |
| `tools/cli.mjs` | — | **0 處**（grep 實查） |

### 4.2 `_undoSnapshot` 引用（grep 形態二）

| 檔案:行號 | 性質 | 處置 |
|---|---|---|
| `src/lib/store.js:84` | state 初始單槽 | 改 `_undoSnapshots: {}` |
| `src/lib/store.js:555` | 快照寫入 | 改多槽（§3.1b） |
| `src/lib/store.js:711` | undo 取用 | 改選槽（§3.1c） |
| `src/lib/store.js:775` | 清槽 | 改 `delete state._undoSnapshots[m]` |
| `src/engine/session-utils.js:10,103,150,177,181,215` | session 層模組變數 | **不動** |
| `src/engine/session-mc-utils.js:12,113,162,189,197,231` | 同上 | **不動** |
| `src/engine/session-spell-utils.js:11,110,152,179,184,222` | 同上 | **不動** |
| `tools/verify-next-after-undo.mjs:64,86,99,100,114` | 工具 local | **不動** |
| `_dev/notes/*.md` | 文件 | 不動 |

> 註：bug.md:3750/4002/4244 舊行號顯示 `store.state._undoSnapshot` 檢查 — 現行三個 session-utils 已改用模組級 `_undoSnapshot`（:215/:231/:222 實查），store 層快照無其他消費端。

### 4.3 字串/資料形態（grep 形態三）

- `deleteReviewLogsAfter(`：唯一呼叫端 store.js:752；db.js:445 定義 → 加 mode 參數（§3.3a）
- `COALESCE(mode`：db.js 新增（唯一）
- review_log `mode` 欄位：db.js:380 INSERT（`entry.mode || 'flip'`）、:405 getAllReviewLogs map（`r.mode || 'flip'`）、**tools/cli.mjs:1221-1222 直接 INSERT（mode 恆 'flip'、reviewed_at=nowIso — R2 #3 L1 補列；不影響 C1 語意，寫入端計入等價性前提①）** — 不改
- `newRatedToday` 計數器：store.js:378-380（refreshDerived 內讀取）、:400（stats）、:559-561（快照）、:754-756（undo）；session-utils:38,65 / session-mc-utils:38,64 / session-spell-utils:37,64 — 僅快照/undo 兩處改
- `goalStreak`：store.js:87,158,240,570,771,897-899,906-919；`src/pages/dashboard.js:41,53,55,113`；`src/pages/settings.js:115,297,303`；main.js:168 — 僅快照/undo 兩處改
- `leech-` tag：store.js:669（rateCard push）、:104-106（systemTags）、:758-767（undo）；`src/pages/tag-manager.js:16-18,24-26`（UI 對應表）— 快照欄位換 `leechTagBefore`

## 5. 驗證項目（實測證據）

1. **交叉 undo 多槽選槽**：flip 評 A → mc 評 B → flip undo 還原 A（mc 槽保留）→ mc undo 還原 B；flip 再 undo 為 **no-op**（槽已刪）；**同 mode 連續評分覆蓋自己的槽（undo 只回最後一步）**。
2. **計數器隔離**：flip 評（newRatedToday+1）→ mc 評（newRatedTodayMc+1）→ flip undo → 斷言 `newRatedToday` 回滾、`newRatedTodayMc` **不動**；再 mc undo → mc 計數器回滾。斷言以 undo 完成後 state 值為準（refreshDerived 重算路徑正常時與快照值恆等）。
3. **goalStreak 隔離**：兩 mode 各評分（各自 push today）→ flip undo → 斷言 **`dates.mc` 全部 entry 保留**、`dates.flip` 回到快照時；current 重算與 incrementGoal 公式一致；best = max(全域, 該 mode 重算)。含重複日期/斷鏈/空陣列/不含今天案例（R2 #2 實測四案例全過）。
4. **reviewLog memory 過濾（R1 重寫版）**：
   - 場景 A：`[f1, m1, f2, m2]` → flip undo（flip 槽＝f2 快照，baseline=1）→ `[f1, m1, m2]`；再 mc undo → `[f1, m1]`
   - 場景 B：`[f1, m1, f2]` → flip undo → `[f1, m1]`（中段 splice 移除，m1 位置不變）
   - 子斷言：同 mode 雙連評後 undo 只移除最後一步；splice 後順序與 id 對應不亂。
5. **DB SQL 語意（層 2）**：
   - 5a：多 mode 資料 + 各 mode undo → 只刪 `id > logId AND COALESCE(mode,'flip') = $2`；**NULL mode 資料在 mc/spell undo 不被刪、僅 flip undo 刪（HIGH-1 回歸斷言 — §3.3a 定案 SQL 修正後必過）**
   - 5b：快照後他 mode 新增 log 的 id 全部 > logId 且不被刪
   - 5c：**同場景 memory 移除後最終狀態 ≡ DB 刪除後最終狀態**（R2 #2 LOW-1：比最終狀態，非移除集合相等 — addReviewLog 拋錯路徑 memory 有 DB 無）
6. **leech tag 精準還原**：flip 評 A 觸發 leech-flip → mc 評 A 觸發 leech-mc → flip undo → 'leech-mc' 保留、'leech-flip' 依快照增刪；word 無其他 tag 被動（含 exam applyTags 夾雜情境）。
7. **無快照防呆**：未評分直接 undo → no-op 不拋異常；`_undoSnapshots` 空物件時同。
8. **回歸**：`tools/verify-undo-cycle.mjs`、`tools/verify-next-after-undo.mjs` 實跑通過（enableFuzzing=false 路徑不受影響）。
9. **語法**：`node --check` 全部改動檔案（store.js、session-utils.js、session-mc-utils.js、session-spell-utils.js、db.js、verify-c1-undo-modes.mjs）。
10. **build 冒煙**：`npm run build`（vite build）通過（註明環境；**工作區含任務禁令的 chart.js/base.css 未提交舊改動，build 結果為含此干擾的環境記錄**）。
11. **同卡跨 mode 情境（R2 #2 HIGH-2 重寫版＋R3 勘誤 3 補洞）**：
    - (a) **C1 必過核心隔離斷言**：flip 評 A → mc 評 A → flip undo → `cardsMc.get(A)` **不被觸動**（=== mc 評分後值）、`cards.get(A)` 回 flip 快照值 — 修前（單槽）此斷言失敗、修後必過；
    - (b) **合併保護斷言**：同情境 flip undo 後 DB baseCard 的 mcData === mc 評分寫入值（§3.1c 合併保護生效，不覆寫）；reload（重建 state 於 in-memory DB）後 mcData 不遺失；**且 memory `state.cards.get(A).mcData` 與 DB 一致（R3 MED-2：memory 同步斷言）**；
    - (c) 可操作「不動」清單（取代「行為不變」）：他 mode 計數器 / `dates[m]` / reviewLog / leech tag / 三張 cards Map 鍵集合均不動；
    - (d) **R3 勘誤 3 補洞變體**：A **首次由 flip 評分建立**（無既有 flip 卡，hadCard=false）→ mc 評 A → flip undo → 斷言 DB cards 表 A 行**仍存在**且 `mc_data` 解析後 === mc 評分寫入值（restore 卡承接，不 deleteCard）；reload 後 `cards.get(A).mcData` 不遺失。§6 風險表第 4 列同步涵蓋。

## 6. 風險與緩解

| 風險 | 緩解 |
|---|---|
| 多槽化後 flip undo 誤刪他 mode 後續變化（計數器/goalStreak/log/leech tag） | 各維度 mode 隔離（§3.1d-g）；驗證 2/3/4/5/6 |
| **NULL mode 舊 log 誤刪（R1 HIGH-1 → R2 定案）** | §3.3a `COALESCE(mode, 'flip') = $2`（COALESCE 內固定字面量）；驗證 5a 永久攔截；真實資料 NULL 理論上不存在（ADD COLUMN 回填 DEFAULT），影響面防禦性 |
| **flip undo 覆寫 DB mcData/spellData（R2 HIGH-2 → R3 定案）** | §3.1c 合併保護（live 先讀＋merged 保留他 mode 資料＋memory 同步）；**!hadCard 情境以 restore 卡承接不刪（R3 勘誤 3）**；驗證 11(b)(d) |
| 快照語意改變（reviewLogLength→modeLogCount、wordTagsBefore→leechTagBefore）被忽略的消費端 | grep 形態二窮舉（§4.2）；R1/R2 三委員各自 grep 交叉驗證無其他引用 |
| leech tag 精準還原 vs 整陣列還原行為差異 | C1 附加行為修正（§1 明列）；undo 語意定義「只還原 rateCard 造成的變化」；驗證 6 |
| best 全域欄位在 undo 後可能略高（max 保守） | 非資料遺失（只高不低）；incrementGoal 同款 max 公式；未來日期計入連續段為既有行為（R2 LOW-4） |
| 同卡跨 mode undo 的 card/mcData 互動 | C1：合併保護不覆寫他 mode 資料（驗證 11(b)）；C2：:565-566/:723/:731-743 完整 restore（另案） |
| **工具執行地雷（R2）**：node:sqlite 不支援 `$N` 位置綁定；mock.module 需 flag；層 1 需先 init | §3.4 寫死：named-object 綁定、`node --experimental-test-module-mocks`、步驟 0（initDB→init→覆寫 state） |
| session 層快照跨 mode 切換不自動清空（既有行為，R1 LOW-5） | 各 mode session 頁切換即重建流程，store 層已隔離 — 已知既有行為（C1 外） |
| incrementGoal fire-and-forget 競態（既有，R1 LOW-3/R2 L6） | **已知未修，C1 不改**：DB 側最後寫入者不保證為 undo（in-flight saveGoalStreak 可能後到，重載回彈）— 與現況同級，C1 範圍外 |
| `getMaxReviewLogId` 失敗 → logId=0 → undo 刪該 mode 全部 log（既有，R2 L5） | 既有缺陷（現況單槽同問題）；C1 後 blast radius 縮為單 mode（不更糟）；db.getMaxReviewLogId 本身有 try/catch 記錄 |
| 與 C2（同段 code）改動衝突 | C2 另案；本計畫明確標示 :565-566/:723/:731-743 不動（:723 僅變數改名）；§3.1c 合併保護與 C2 互補不重疊 |
| 舊 state 無 _undoSnapshots 欄位 | state 初始含空物件 + 讀端 `\|\| {}` + 寫端 `\|\|= {}` 防呆 |

## 7. 審查歷程

| 輪次 | 委員 | 裁決 | 意見摘要 | 處置 |
|---|---|---|---|---|
| R1 | #1 | ✅ 附條件 | 設計正確、行號全對齊；MED-1 §3.1c 參數與解構 mode 同名 SyntaxError；MED-2 §5-4 場景矛盾；LOW-1~8 | v1.1：§3.1c 寫死；§5-4 重寫；§4/§5 補齊；§6 補 session 層殘留；§3.4 理由改寫 |
| R1 | #2 | ❌ | **HIGH-1 §3.3 SQL `COALESCE(mode,$2)=$2` 誤刪 NULL mode（實錘）**；MED-1 §3.4 理由不實；LOW-1~4 | v1.1：SQL 改「正規化 + $2 雙用」；§3.4 工具升級；§4/§5 補齊 |
| R1 | #3 | ✅ 有條件 | H1 §5-4 場景；H2 §3.4 前提不實（建議雙層工具）；M1 §3.1g 論證；M2 card 維度 C2 依賴；M3 logId 邊界；M4 等價性前提；L1~L5 | v1.1：§1 補註；§3.1g 論證改寫；§3.4 雙層；§5 擴充；§3.1e 寫死前提；§6 補 3 列 |
| R2 | #1 | ❌ | **HIGH-1 §3.3 v1.1「定案 SQL」仍未修（`COALESCE(mode,$2)=$2` 對 NULL 恆真，實測復現）— 正解為 COALESCE 內固定 'flip' 字面量（v3 原文）**；MED-1 v1.0 原案 block 未標示；MED-2 §3.4 漏 backup-scheduler→api.js 靜態鏈；MED-3 層 1 缺 init 步驟（requireScheduler 載入前提）；LOW-1 NULL 論述；LOW-2 build 環境註記 | v1.2：§3.3a 定案 `COALESCE(mode,'flip') = $2`＋`mode \|\| 'flip'` 正規化（三委員實測全 PASS）；§3.4 補 api/core mock＋步驟 0＋named-object 綁定＋flag；§3.3 註記刪 v1.0/v1.1 錯誤 block 改文字說明；§5-10 註記；§6 NULL 論述修正 |
| R2 | #2 | ❌ | **HIGH-1 同 #1（實測復現）**；**HIGH-2 §5-11「行為不變」不可操作＋C1 必引入 mcData 回歸（:744-750 saveCard(prevCard) 覆寫 DB mcData 實錘）**；MED-1 §3.1e 前提②缺 reviewed_at 單調（建議 ORDER BY reviewed_at, id）；MED-2 NULL 論述；LOW-1 §5-5c 比最終狀態；LOW-2 綁定策略；LOW-3 leechTagBefore 死碼；LOW-4 best 未來日期 | v1.2：§3.3a 定案 SQL；§3.1c 加合併保護（live.mcData/spellData 保留）；§5-11 重寫三層 ((a) 核心隔離斷言 (b) 合併保護斷言 (c) 可操作清單)；§3.3b ORDER BY reviewed_at, id；§5-5c 改最終狀態；§3.1g 簡化 truthy；§6 補 logId=0 與競態已知未修 |
| R2 | #3 | ❌ | **HIGH-1 同（實測復現）**；MED-1 層 1/層 2 撞 node:sqlite 位置參數地雷（需 named-object 綁定，實測）；LOW-1 §4.3 漏 cli.mjs:1221 INSERT；LOW-2 §3.1b 寫端防呆；LOW-3 §3.1h dates 同引用註記；LOW-4 leech 語意變更明列；LOW-5 logId=0 揭露；LOW-6 競態措辭 | v1.2：§3.4 綁定策略寫死＋flag；§4.3 補 cli.mjs:1221；§3.1b `\|\|= {}`；§3.1h 註記；§1 明列 leech 附加修正；§6 補 2 列 |
| R3 | #1 | ❌ 附條件 | SQL 定案實測全 PASS、合併保護語意 PASS、層 1 可行性 4/4 PASS、R2 意見 22/22 核對（21✅1❌）；**HIGH-1 §3.1g leech 移除分支死碼（v1.2 把 guard 改 truthy 使 else-if 永不可達，實測復現 tag 殘留）**；MED-1 §3.1c code block 與註記矛盾（live 位置）；MED-2 合併保護未同步 memory；LOW-1 mock.module 棄用語法（exports.default）；LOW-2 FakeDatabase 缺 array→named 轉換層 | v1.3：§3.1g 外層改 `if (undoWord)`（死碼修正）；§3.1c live 移至函式頂部＋memory 同步；§3.4 mock 新語法＋轉換層；§5-11(b) 加 memory 一致斷言 |
| R3 | #2 | ❌ 附條件 | **HIGH-1 §3.1c 合併保護缺 `!hadCard` 分支**（flip 首次建立卡→mc 評→flip undo deleteCard 連 mcData 刪；C2 也救不到 — flip 快照 prevBaseCardMcData 恆 null）；MED-1 code block 與註記矛盾；MED-2 §5-11(b) 可測前提（FakeDatabase cards 表需 mc_data/spell_data 欄位）；LOW-1~6（ORDER BY 語意安全、goalStreak 邊界、pop 演算法、SQL 定案、窮舉、歷程記錄全 PASS） | v1.3：§3.1c 加 `!hadCard` 補洞（restore 卡承接）；§3.4 補 FakeDatabase 建表要求；§5-11(d) 新增變體 |
| R3 | #3 | ❌ 附條件 | **HIGH-1 §3.1g leech 死碼（同 #1 實測復現）**；MED-1 block 與註記矛盾（照抄即 HIGH-2 保護失效）；MED-2 memory 分歧；MED-3 !hadCard 情境未列入驗證；LOW-1~4（requireScheduler 措辭、dates[m] undefined、cli.mjs 等價性、loadAll throw 註記）— 行號全吻合、§6/§7 一致、工具可行性確認；**總體：修訂後准予動工** | v1.3：§3.1g 死碼修正；§3.1c live 頂部＋memory 同步＋!hadCard 補洞；§3.4 loadAll 註記；§5-11(d)；§1 leech 附加修正明列 |
