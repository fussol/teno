# C2-fix-plan — flip undo 誤刪 mcData（快照捕獲＋restore guard 放寬＋DB 檢查防線）

> 版本：v1.3（R3 終審三委員全數 ✅ 通過 — 定案，准予動工）
> 範圍：組一「學習核心」— src/lib/store.js、src/lib/db.js、tools/verify-c1-undo-modes.mjs（新增 T12 系列驗證）
> 依據：fix-plan-critical-v3.md:122-129 批次 4（C1 → C2 同批同一段 code；C1 已落地 commit 36efe16，本計畫為 C2 部分）
> 狀態：**R1 ⚠️/❌/❌ → v1.1 → R2 ✅/✅/⚠️ → v1.2 → R3 ✅/✅/✅ → 定案 ✅ 准予動工**（LOW 文書修正隨動工一併落地）

---

## 1. Bug 定義

v3 定案（fix-plan-critical-v3.md:122-129，❌ 重作 → ✅）：

1. **快照捕獲排除 flip**（現 store.js:568-569）：`mode !== 'flip'` 條件使 flip 快照恆無 `prevBaseCardMcData`/`prevBaseCardSpellData` — flip undo 缺「該卡為他 mode 資料載體」的快照依據
2. **undo restore 分支的 mode guard**（現 store.js:731）：完整 restore 分支包在 `if (m !== 'flip')` 內，flip undo 走不到；v3 #4 實錘 v2 稱「769-774 分支即生效」是錯的（769-774 是 delete 區）→ 修前 flip undo 直接 deleteCard 連 DB baseCard 的 mcData/spellData 一起刪
3. **補充**（v3:127）：undo delete 前查 DB（防 saveCard 失敗的 memory/DB 分歧 — DB 卡可能帶 memory 側看不見的他 mode 資料）

**C1 落地後現況**（commit 36efe16，行號為 C1 後）：

- C1 已在 flip 分支（:752-776）加「合併保護」（hadCard：merged 保留 live mcData/spellData）＋「!hadCard 補洞」（live 卡有他 mode 資料 → restore 承接不刪）— 原始「誤刪」主路徑已被 C1 堵住大半
- **C2 剩餘缺口**（C1 未涵蓋、v3 明列屬 C2 範圍）：
  - **缺口 a**：flip 快照不捕獲 prevBaseCardMcData/SpellData（:568-569 `mode !== 'flip'`）→ flip undo 的 restore 判斷只有 live 單一來源；live 卡因分歧無 mcData 欄位時判斷失效
  - **缺口 b**：flip undo 的 delete 分支（:773-775）無 DB 檢查 → memory 無他 mode 資料但 DB 卡帶 mc_data/spell_data（分歧）時，deleteCard 連 DB 他 mode 資料一起刪（v3 補充未實作）
  - **缺口 c**：v3 定案明列 :568-569 捕獲條件與 :731-743 restore 分支屬 C2 範圍（C1 計畫書 header :5 與 R1 M2 補註 :18 明示「另案」）

**具體故障情境**：

- **情境 1（saveCard 失敗分歧 — v3 補充防線的真實範圍）**：A 的 DB cards 行帶 mc_data（他 mode 資料），flip 評分 A 時 **saveCard 失敗**（:665 catch 吞錯）→ memory state.cards 有 flip 卡（:645 cardMap.set，:667 對 !hadBaseCard 再 set）、DB 保留舊行（含 mc_data）→ flip undo → live/快照均無他 mode 資料 → delete 分支無檢查 → **deleteCard 把 DB 的 mc_data 一起刪**（他 mode 資料遺失）
- **情境 2（快照依據）**：A 先 mc 學（cardsMc 有值）→ flip 評分 A（快照時 flip 槽 prevBaseCardMcData=null — 因 :568-569 mode 排除）→ flip undo 的 restore 判斷只能依賴 live 單一來源（C1 補洞）；v3 明列 :568-569 捕獲條件屬 C2 範圍，flip 快照應與 mc/spell 同形捕獲
- **已知侷限（R1 三委員一致實錘，明示 C2 範圍外）**：**「rating saveCard 成功＋pre-existing DB 分歧」方向 undo 端救不回** — 情境：DB 行帶 mc_data 但 memory cardsMc/cards 均無 → flip 評分 A 時 rateCard 只從 memory 讀他 mode 資料（:635-640 oldMcData → null）→ newCard 無 mcData → :665 `saveCard(newCard)` 走 db.js:202-208 `ON CONFLICT ... mc_data=excluded.mc_data`＋:223 `card.mcData ? JSON.stringify : null` → **DB mc_data 在 flip 評分當下已被覆寫為 NULL**（流失點在 :665，早於 undo）→ undo 端 getCard 查到的已是空資料。此方向需 rateCard flip 分支（:635-666）加 DB fallback 讀取，超出 v3 授權（v3 只授 undo 端）→ **明示為另案**（§6 風險表第 9 列）。
- **已知侷限（R2 委員 #2/#3 一致實錘，明示不修、列另案）**：**merged 分支缺口（hadCard=true＋flip 評分 saveCard 失敗＋pre-existing 分歧）** — DB 行帶 mc_data、memory 有 flip 卡（hadCard=true）→ flip 評分 saveCard 失敗（:665 catch）→ undo 走 C1 merged 分支（:753-761，C2 未改）→ :761 `saveCard(merged)`（merged 無他 mode 資料 — memory 讀不到）→ db.js:223 把 DB mc_data 覆寫為 NULL。此方向 **undo 端可及**（DB 仍有資料、getCard 攔得到）但 C2 依範圍最小化不在 merged 分支查 DB — 與 rateCard 層另案同源（rateCard :635-640 不讀 DB）→ **明示不修**（§6 風險表第 10 列）。

**目標語意（C2 定案）**：flip undo 只撤銷 flip 評分造成的變化；若該卡是他 mode 資料（mcData/spellData）的載體 — 無論依據來自 live、快照捕獲或 DB 檢查 — 一律以 restore 卡（state=0, due=''，A12 容器卡語意）承接，**不整卡刪除**；僅當 memory 與 DB 雙重確認無他 mode 資料才 deleteCard。

## 2. Root Cause

store.js 的 undo restore 機制把「他 mode 資料的還原/保護」限定在非 flip 模式：

1. **快照捕獲條件排除 flip**（:568-569 `mode !== 'flip'`）— v3 定案指出的核心缺陷：flip 快照不記錄 cardsMc/cardsSpell，使 flip undo 對「該卡是否為他 mode 資料載體」缺乏快照時刻的知識
2. **restore 分支的 mode guard**（:731 `if (m !== 'flip')`）— 原設計把完整 restore 分支（:731-751）留給 mc/spell undo，flip undo 走自己的分支（:752-776）；C1 已用 live 補洞，但 delete 分支仍無 DB 防線（v3 補充未實作）
3. **delete 分支無 DB 檢查**（:773-775）— **saveCard 失敗分歧**（flip 評分 saveCard 拋錯：memory 有卡、DB 保留舊行含他 mode 資料）時，以 memory 判斷為準的 deleteCard 會誤刪 DB 側他 mode 資料（R1 三委員實錘：v3 補充「防 saveCard 失敗的 memory/DB 分歧」的真實範圍即此方向；「rating saveCard 成功＋pre-existing 分歧」方向流失點在 :665 覆寫，undo 端不可及 — 見 §1 已知侷限）

共同根因：**flip undo 的「他 mode 資料識別」只依賴單一來源（live memory），缺快照與 DB 兩個佐證層**；而 DB cards 行才是 mcData/spellData 的持久真相源（saveCard 失敗分歧下 DB 為唯一存活者）。

## 3. 修法（檔名:行號 — C1 落地後行號）

### 3.1 src/lib/store.js

**（a）:568-569 快照捕獲 — 去掉 mode 排除（v3 修法 1）**：

```js
prevBaseCardMcData: state.cardsMc.get(wordId) ? { ...state.cardsMc.get(wordId) } : null,
prevBaseCardSpellData: state.cardsSpell.get(wordId) ? { ...state.cardsSpell.get(wordId) } : null,
```

任何模式（含 flip）都捕獲。flip 槽從此有 prevBaseCardMcData/SpellData（快照時刻 cardsMc/cardsSpell 值）。

> ⚠️ **語意註記（寫死）**：`prevBaseCardMcData`（快照值）**只作「存在性判斷」與「live 缺失 fallback」，不作 restore 資料主源** — 若 undo 前他 mode 又評分（cardsMc 更新為 v2），快照值為舊值 v1，以快照值 restore 會回滾他 mode 後續評分（違反 C1「undo 只還原自己 mode」語意）；live（undo 時刻 base row 的 mcData，由他 mode 評分 :659/:662 in-place 更新）才是他 mode 最新值。
> R1（#3 LOW-4 追蹤確認）：**「live 空＋快照有」組合在現行 rateCard/undo 序列不可達**（flip 首評時 :635-640 oldMcData 承接保證 live 卡帶快照時刻他 mode 值；他 mode undo 的 :734 以快照值還原而非 :735 delete 的前置條件與 flip 快照同源）— 快照項的價值為 **v3 明列要求（必須同形捕獲）＋防禦性存在判斷**（對未來 rateCard/undo 序列變動穩健），非依賴可達路徑。

**（b）:762-775 flip undo 分支 — 放寬 restore 條件 + DB 檢查防線（v3 修法 2 + 補充）**：

```js
} else if (prevBaseCardMcData || prevBaseCardSpellData || (liveFlipCard && (liveFlipCard.mcData || liveFlipCard.spellData))) {
  // C2: 快照捕獲（flip 也捕獲）+ live 雙重判斷 — 該卡為他 mode 資料載體 → restore 承接不刪
  const restore = {
    due: '', stability: 0, difficulty: 5,
    elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
    step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
    // live 優先（undo 時刻他 mode 最新值，不回滾他 mode 後續評分）、快照補缺（同源 fallback）
    mcData: liveFlipCard?.mcData ?? prevBaseCardMcData ?? undefined,
    spellData: liveFlipCard?.spellData ?? prevBaseCardSpellData ?? undefined,
  };
  state.cards.set(wordId, restore);   // memory 同步（:728 cardMap.delete 已先行，需補回）
  try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
} else {
  // C2 (v3 補充)：undo delete 前查 DB — 防 saveCard 失敗的 memory/DB 分歧：
  // memory 無他 mode 資料但 DB 卡帶 mc_data/spell_data → 不整卡刪，restore 承接（DB 資料為準）
  let dbCard = null;
  try { dbCard = await db.getCard(wordId); } catch (e) { console.warn('[store] undo getCard error:', e); }
  if (dbCard && (dbCard.mcData || dbCard.spellData)) {
    const restore = {
      due: '', stability: 0, difficulty: 5,
      elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
      step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
      mcData: dbCard.mcData ?? undefined,
      spellData: dbCard.spellData ?? undefined,
    };
    state.cards.set(wordId, restore);   // memory 同步
    try { await db.saveCard(wordId, restore); } catch (e) { console.warn('[store] undo saveCard error:', e); }
  } else {
    try { await db.deleteCard(wordId); } catch (e) { console.warn('[store] undo deleteCard error:', e); }
  }
}
```

語意：
- 條件 = 快照捕獲到 **或** live 看到他 mode 資料 → restore 承接（不刪）
- restore 資料來源：**live 優先、快照補缺、DB 檢查兜底**（saveCard 失敗分歧情境 DB 為真相源）
- delete 分支：先查 DB（getCard）→ DB 卡帶他 mode 資料 → restore 承接；否則 deleteCard
- memory 側：:725-729 已先行 cardMap 還原/刪除（flip !hadCard → :728 delete）→ restore 承接時補回 `state.cards.set`（現況 :771 已有同形）
- `liveFlipCard` 於 :722 讀取（先於 :725-729 還原），值為 undo 時刻評分後卡 — 順序不變（C1 R3 MED-1 定案）

> ⚠️ **實作偏差明示（R1 #3 MED-1 要求，寫死）**：v3 修法 2 字面「放寬 :733 guard 使 flip undo 走 :731-751 restore 分支」在 C1 落地後**不可直接照做** — hadCard=true 時 :734 `baseCard.mcData = prevBaseCardMcData` 會以**快照值**覆寫 live mcData（回滾他 mode 後續評分，違反 C1「undo 只還原自己 mode」語意）。本計畫改以「擴充 flip 分支 else-if（:762）＋live 優先」達成 v3 意圖（!hadCard 且有快照/live 資料 → restore），hadCard=true 仍走 C1 merged 分支（live 優先）— 等價達成 v3 修法 2 的 intent 且避開回滾陷阱。

### 3.2 src/lib/db.js — 新增 getCard（:196 getAllCards 之後）

v3 說「SELECT EXISTS 查 DB」；實作取**單卡查詢**（getAllCards :171-196 同形單卡版）— 一次取得整行，既能判斷存在性與 mc_data/spell_data 有無，又能作為 restore 資料來源（SELECT EXISTS 僅回 boolean，仍需二次查詢才拿得到資料）：

```js
export async function getCard(wordId) {
  const rows = await requireDB().select(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards WHERE word_id = $1',
    [wordId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    due: r.due, stability: r.stability, difficulty: r.difficulty,
    elapsedDays: r.elapsed_days, scheduledDays: r.scheduled_days,
    reps: r.reps, lapses: r.lapses, state: r.state, step: r.step ?? 0,
    lastReview: r.last_review, buried: !!r.buried, suspended: !!r.suspended,
    interval: r.scheduled_days || 0,
    mcData: parseJSON(r.mc_data, null),
    spellData: parseJSON(r.spell_data, null),
  };
}
```

### 3.3 tools/verify-c1-undo-modes.mjs — 新增 T12 系列（C2 驗證）

**FakeDatabase 擴充（R1 HIGH-1 修正要求）**：加一次性 `failNextSave` 旗標（模擬 saveCard 失敗 — v3 補充防線的真實觸發條件）：

```js
class FakeDatabase {
  ...
  async execute(sql, params = []) {
    if (this.failNextSave && sql.trim().startsWith('INSERT INTO cards')) {
      this.failNextSave = false;
      throw new Error('simulated saveCard failure');
    }
    this.db.prepare(sql).run(this._bind(sql, params));
  }
}
```

（`failNextSave` 用後即清；僅攔 saveCard 的 `INSERT INTO cards` SQL（db.js:200 — grep 實查 **src/ 內**僅此一處；tools/cli.mjs:1210/2523/3325 另有 3 處直接 prepare 寫入、不走 db.js/FakeDatabase 路徑，攔截不影響），不誤傷 review_log 等寫入；rateCard :665 的 try/catch 吞錯後 memory 有卡、DB 保留舊行 — 恰為分歧情境。⚠️ **測試衛生（R2 #2 LOW-1）**：`resetState()`（verify-c1 :91-115）內補 `fakeDb.failNextSave = undefined;` — 「用後即清」只保證消耗後清除，若測試中途斷言失敗提前退出（saveCard 未被呼叫）旗標會殘留污染下一 test。）

- **T12a flip 快照捕獲**：mc 評 A → flip 評 A → 斷言 flip 槽 `prevBaseCardMcData` 非 null 且 `assert.deepEqual(prevBaseCardMcData, cardsMc.get(A))`（修法 3.1a 生效；**物件比較用 deepEqual，勿用 equal** — fsrs 卡為扁平物件但引用不同）
- **T12b flip undo 快照依據（明訂 hadCard=false）**：A 無既有 flip 卡（僅 mc 評過 — hadCard=false，走 C2 !hadCard 分支）→ mc 評 A → flip 評 A → flip undo → DB cards 行存在、`JSON.parse(row.mc_data)` deepEqual mc 評分值、state=0、due=''；memory state.cards.get(A).mcData 同步（不誤刪）
- **T12b' merged 分支變體（hadCard=true — R2 修正版）**：先以 fixture 置 flip 卡（`s.cards.set('wA', mkReviewCard())`，T6/T6b 同款既有寫法 — verify-c1 :219/:232）→ **再** flip 評分（該次快照 hadCard=true、prevCard=fixture 卡）→ mc 評 A（:659 in-place 寫入 baseCard.mcData）→ flip undo → 走 C1 merged 分支（:753-761）：`state.cards.get(A).state === prevCard.state`（**非 0**）、mcData 保留（deepEqual mc 評分值）— 證明 C2 未破壞 merged 路徑（⚠️ 「A 先 flip 評分建立卡」該次評分快照 hadCard=false，走不到 merged — 必須 fixture 置卡後再評分）
- **T12c live 優先（不回滾他 mode）**：mc 評 A(v1) → flip 評 A → mc 再評 A(v2) → flip undo → restore 卡 mcData deepEqual v2（他 mode 後續評分不動；證明快照值不作主源）
- **T12d DB 分歧防線（saveCard 失敗方向 — R1 修正版）**：DB cards 行直接 INSERT 帶 mc_data（模擬評分前 DB 已有他 mode 資料）→ `fakeDb.failNextSave = true` → flip 評 A（saveCard 失敗 → DB 保留舊行）→ `failNextSave = false` → flip undo（live/快照均無 → delete 分支 → getCard 攔截）→ 斷言 DB 行仍存在、mc_data 保留（deepEqual 原值）、state=0、due=''；memory state.cards.get(A).mcData 同步；**reload 一致性以 `dbMod.getAllCards()` 直接驗證**（mapping 與 loadAll :218-221 同形（store.js:157）— DB mc_data → cardsMc 重建；⚠️ 勿重跑 `store.actions.init()`：seedIfEmpty（:450）會在 words 表空時塞預設詞彙污染 state — node 測試環境 `fetch('/seed-data.csv')` 相對 URL 必 throw 被 seedIfEmpty 自身 :526-528 catch 吞、實際不污染，此警告為防禦性 — 且 loadAll :224-228 會把容器卡移出 state.cards；reload 後斷言對象應為 getAllCards 回傳 map 的 mcData，不要求 state.cards 側保留）
- **T12e spell 對稱**：spell 版（T12a/b 同形，驗證 spellData 路徑）
- **T12f 純 flip 卡正常刪除**：無任何他 mode 資料 → flip undo → DB 行刪除（getCard 查到行但無他 mode 資料 → deleteCard）、memory 無卡（不誤傷正常刪除路徑）

### 3.4 不修改

- `src/lib/chart.js`、`src/styles/base.css`（任務禁令）
- 三個 session-utils（C1 已傳 mode；undo 呼叫端不變）
- `:731 if (m !== 'flip')` 結構本身（非 flip 分支的完整 restore 不變 — C1 已驗證）
- `tools/verify-undo-cycle.mjs`、`tools/verify-next-after-undo.mjs`（回歸實跑）
- A12 容器卡語意（restore 卡 due:'' 與 A12 一致 — v3 ⚠️「due=now 突然進 queue」已由 A12 commit 06610c4 消除，changelog 註明）

## 4. 使用點窮舉（grep 三形態）

### 4.1 `prevBaseCardMcData` / `prevBaseCardSpellData`（grep 形態一）

| 檔案:行號 | 性質 | 處置 |
|---|---|---|
| store.js:568-569 | 快照寫入（mode 排除） | 去 mode 條件（§3.1a） |
| store.js:719 | undo 解構 | 不變 |
| store.js:734-746 | 非 flip 分支讀取 | 不變 |
| store.js:762（擴充條件）＋:770-771（restore 快照補缺讀取） | flip 分支 restore 判斷 | 擴充（§3.1b） |
| tools/verify-c1-undo-modes.mjs | T12a 斷言 | 新增 |

### 4.2 `getCard`（grep 形態二 — 新函數）

| 檔案:行號 | 性質 | 處置 |
|---|---|---|
| db.js:196 後 | 新增定義 | §3.2 |
| store.js:778（新增呼叫） | undo delete 前查 DB | §3.1b（else 分支 getCard 呼叫，自 :762 起算第 17 行；行號以落地後為準） |
| tools/verify-c1-undo-modes.mjs | T12d/T12f 斷言 | 新增 |

（grep 實查：現行 `getCard(` 於 src/ 與 tools/ 全域 0 處 — 無命名衝突）

### 4.3 `deleteCard`（grep 形態三）

| 檔案:行號 | 性質 | 處置 |
|---|---|---|
| db.js:459 | 定義 | 不變 |
| store.js:750 | 非 flip 分支 | 不變 |
| store.js:774 | flip 分支 delete | 改為「getCard 檢查後才 delete」（§3.1b） |

（grep 實查：呼叫端僅此 3 處；另 tools/verify-c1-undo-modes.mjs:281 為既有測試斷言註解文字「未 deleteCard」— 非函數引用，文字出現屬預期。修法後 flip 分支的 deleteCard 移至 :790 附近 — 以落地後行號為準）

## 5. 驗證項目（實測證據）

1. **T12a/b/b'/c/d/e/f**（層 1 真實 store 路徑，verify-c1-undo-modes.mjs 新增 7 組）全綠 — 上述情境
2. **C1 回歸**：verify-c1-undo-modes.mjs 既有 14 測試全過（修法不得破壞 C1 語意）
3. **回歸**：tools/verify-undo-cycle.mjs、tools/verify-next-after-undo.mjs 實跑通過
4. **語法**：node --check src/lib/store.js、src/lib/db.js、tools/verify-c1-undo-modes.mjs
5. **build 冒煙**：npm run build（vite build）通過（註明環境：工作區含任務禁令的 chart.js/base.css 未提交舊改動）
6. **DB 真相源 reload 斷言**（T12d）：restore 後以 getAllCards 重建 → DB mc_data → memory mapping 一致、資料不遺失

## 6. 風險與緩解

| 風險 | 緩解 |
|---|---|
| flip undo 誤刪 DB 他 mode 資料（v3 主 bug） | §3.1b 三層識別（live/快照/DB）＋delete 前 getCard 檢查；驗證 T12b/d |
| prevBaseCardMcData（快照值）誤當 restore 主源 → 回滾 undo 前他 mode 後續評分 | §3.1a 語意註記寫死：僅 live 缺失 fallback、不當主源；驗證 T12c |
| restore 卡（state=0, due=''）與 A12 交互 | A12 已落地（06610c4）：容器卡 due='' 不進 flip queue — v3 ⚠️ 已消除；changelog 註明 |
| getCard 對 FakeDatabase 的依賴（層 1 測試） | FakeDatabase cards 表已含全欄位（verify-c1 建表 :28-32 實查）＋ `$1` 位置綁定經 _bind 轉 named-object（既有機制） |
| 分歧情境 restore 承接 → memory state.cards 出現卡 | loadStore :218-221 以 DB mc_data 重建 cardsMc（DB 為真相源，reload 一致）；驗證 T12d getAllCards |
| 與 C1 語意衝突（live 優先 vs 快照） | C1 合併保護（:753-761 merged 分支）不變；§3.1b 只動 !hadCard 分支與 delete 分支；實作偏差論證寫死（§3.1b 註記） |
| DB 卡有資料但 restore saveCard 失敗（寫不回） | memory 側 state.cards.set 已同步（session 內一致）；DB 側 saveCard 失敗為既有風險（console.warn 記錄） |
| 純 flip 卡誤被 restore（DB 有卡但無他 mode 資料） | getCard 檢查 `dbCard.mcData || dbCard.spellData` 才承接；無資料 → deleteCard 正常（驗證 T12f） |
| **已知侷限（R1 三委員一致實錘）：rating saveCard 成功＋pre-existing DB 分歧 — undo 端 getCard 攔不到**（flip 評分 :665 已把 DB mc_data 覆寫為 NULL，流失點在 rateCard） | **明示 C2 範圍外（另案）**：需 rateCard flip 分支（:635-666）加 DB fallback 讀取；§1 已知侷限＋§2 Root Cause #3 已如實記錄，不偽稱本計畫修復 |
| **已知侷限（R2 #2/#3 一致實錘）：merged 分支缺口 — hadCard=true＋flip 評分 saveCard 失敗＋pre-existing 分歧**（undo 走 C1 merged 分支 :753-761，:761 saveCard(merged) 覆寫 DB mc_data=NULL — 此方向 undo 端可及但 C2 依範圍最小化不查 merged） | **明示不修、列另案**：需 merged 分支 saveCard 前加 DB 檢查（與 rateCard 層另案同源 — rateCard :635-640 不讀 DB）；§1 已知侷限已如實記錄；目標語意「memory 與 DB 雙重確認」在 merged 分支為 C1 既有路徑不查 DB（其缺口見已知侷限） |
| **reload 雙面行為（R1 #3 MED-2）**：C2 restore 卡（state=0/reps=0/lapses=0/!lastReview/帶 mcData）命中 A12 清理條件（store.js:224-228）→ 下次 load 自 state.cards 移除、cardsMc 保留 | A12 既有語意（flip 面回 new 卡受 newPerDay cap）非 bug；T12d reload 斷言對象為 getAllCards 的 mcData（不要求 state.cards 側保留）— 與 §5-6 一致 |

## 7. 審查歷程

| 輪次 | 委員 | 裁決 | 意見摘要 | 處置 |
|---|---|---|---|---|
| R1 | #1（undo 語意/資料流） | ⚠️ 修正後 ✅ | **HIGH-1 §1 情境 1/T12d 構造必敗**（資料流失點在 flip 評分 :665 saveCard 覆寫 DB mc_data=NULL、undo 端救不回「rating saveCard 成功＋pre-existing 分歧」；v3 補充真實範圍為 saveCard 失敗方向）；MED-1 快照補缺載重案例敘述不精確；LOW-1 快照項單流程冗餘保留無害；LOW-2 選擇性 cardsMc 同步；LOW-3 deepEqual 提醒；行號全對齊、live 優先論證成立 | v1.1：§1 情境 1 改 saveCard 失敗方向＋加「已知侷限（另案）」；§3.1a 補「live 空＋快照有不可達」註記（#3 LOW-4 確認）；§3.3 T12d 重寫（failNextSave）；LOW-3 採納 |
| R1 | #2（DB 層/驗證工具） | ❌ 附條件 | **HIGH-1 同 #1**（flip 評分 saveCard 先覆寫 DB 他 mode 資料、undo 防線時機太晚、T12d 必紅）；MED-1 merged 分支（hadCard=true）無 DB 檢查（建議 rateCard 補洞 — 未採納，範圍最小化）；MED-2 T12b 需明訂 hadCard=false；LOW-1 reload 斷言陷阱（容器卡移出 state.cards＋seedIfEmpty）；LOW-2 mock 需還原機制；§3.2 getCard 同形性/FakeDatabase 相容/§4 窮舉全 ✅ | v1.1：§3.3 T12d 改 failNextSave 旗標（用後即清）；T12b 明訂 hadCard=false＋新增 T12b'（merged 變體）；T12d reload 改 getAllCards 直接驗證＋seed 陷阱註記；merged 分支分歧列 §6 已知侷限同向（另案） |
| R1 | #3（交叉裁決） | ❌ 附條件 | **HIGH-1 同**（防線時序錯誤、§2 #3/§6 row1 宣稱需修正）；MED-1 v3 字面修法不可行論證需明示；MED-2 §6 缺 reload 雙面行為；LOW-1 §4.2 行號 :766→:776；LOW-2 :281 文字出現；LOW-3 「src/tools」措辭；LOW-4 live 空＋快照有不可達（確認項）；v3 修法 1 完全對齊、A12 消除論證成立、C1 範圍切分乾淨（merged :753-761 未動）全 ✅ | v1.1：§3.1b 加「實作偏差明示」註記（v3 字面放寬 :733 在 C1 後不可行 — hadCard=true 時 :734 以快照值覆寫 live 回滾他 mode；本計畫擴充 else-if 等價達成）；§6 加 reload 雙面行為列；§4.2/:281/措辭修正 |
| R2 | #1（undo 語意/資料流） | ✅ 附條件 | HIGH-1 修正到位（情境 1 改 saveCard 失敗方向、已知侷限如實、failNextSave 觸發正確、getCard 攔截時機正確）；live 優先論證與 memory 同步順序成立；行號全對齊；**MED-1 T12b' 字面構造矛盾**（「先 flip 評分建立卡」的快照 hadCard=false → 走不到 merged、斷言崩潰 — 需 fixture 置卡後再評分）；LOW-1 §1 :667 措辭；LOW-2 §4.2 :776 語意矛盾；LOW-3 §4.1 措辭 | v1.2：T12b' 重寫（fixture 置卡＋再評分，⚠️ 註記）；§1 情境 1 補 :645/:667 措辭；§4.2 →:778；§4.1 改「:762 擴充＋:770-771 補缺」 |
| R2 | #2（DB 層/驗證工具） | ✅ 附條件 | **探針實證 4/4 全綠**（failNextSave 精準性／情境 1 前提／現行誤刪實錘／模擬 C2 修法全流程）；§3.2 getCard 經 FakeDatabase 實證相容；既有 14 測試相容（無測試走 flip delete 分支）；**MED-1 merged 分支缺口未列入 §6**（hadCard=true＋saveCard 失敗＋pre-existing 分歧，undo 端可及但 C2 未查）；LOW-1 resetState 補清旗標；LOW-2 seedIfEmpty 防禦性警告；LOW-3 T12a deepEqual 正確 | v1.2：§1/§6 補 merged 分支缺口（已知侷限第 10 列，明示不修、列另案）；§3.3 補 resetState 清旗標測試衛生；T12d reload 註記補「node 環境 fetch 必失敗（防禦性）」 |
| R2 | #3（交叉裁決） | ⚠️ 修正後 ✅ | R1 HIGH-1 修正全數正確落地；內部一致性 ✅（§1↔§3↔§5↔§6 全吻合、v1.0 敘述零殘留）；已知侷限切法誠實；授權範圍 ✅（未夾帶 rateCard 層）；**MED-A T12b' 序列缺陷**（同 #1 — prevCard=null TypeError）；**MED-B merged 缺口未正式記錄**（同 #2）；LOW-A §4.2 :776 應為 :778；LOW-B §4.3 可選補註 | v1.2：T12b' 重寫；§1/§6 merged 缺口列；§4.2 →:778；§4.3 補註「修法後 flip 分支 deleteCard 移至 :790」 |
| R3 | #1（undo 語意/資料流） | ✅ 通過 | MED-A T12b' fixture 置卡構造在真實 code 成立（:565 hadCard、:753-761 merged、:659 in-place 全推演通過）；MED-B merged 缺口敘述精確（:761 saveCard 覆寫＋undo 端可及區分正確）；v1.0/v1.1 矛盾敘述零殘留；LOW-1 §3.3「全域僅此一處」應為「src/ 內」（cli.mjs:1210/2523/3325 直寫不經 db.js）；LOW-2 T12b' 引用應為 T6/T6b；LOW-3 §4.2 getCard 行號估算約 :787 | v1.3：三項 LOW 全數改入（§3.3 範圍精確化、T6/T6b 引用、§4.2 行號約數） |
| R3 | #2（DB 層/驗證工具） | ✅ 通過 | R2 全數處置到位；§3.2 getCard FakeDatabase 完全相容（$1 綁定/15 欄/parseJSON 實證）；T12a-f 全流程可測；既有 14 測試相容（無測試走「DB 有他 mode 資料＋memory 無」路徑）；LOW-1 :468→:526（seedIfEmpty 自身 catch）；LOW-2 T6/T6b 引用；LOW-3 loadStore→loadAll；LOW-4 §3.3 範圍 | v1.3：全數改入（:526 引用、loadAll 命名、範圍精確化） |
| R3 | #3（交叉裁決） | ✅ 通過 | v1.2 全數處置 R1/R2 意見；v3:122-129 三項授權全數對齊（修法 1 字面一致、修法 2 等價實作＋偏差論證、補充 getCard 防線＋真實範圍）；A12 交互消除論證經 06610c4 diff 實錘；C1 merged :753-761 未動、無 rateCard 層越界；已知侷限切法誠實；grep 三形態與行號抽查全數命中；LOW-1 §3.3 範圍；LOW-2 T6 引用；LOW-3 §1 引用改 header/:18 | v1.3：全數改入（§3.3 範圍、T6 引用、§1 header 引用） |
