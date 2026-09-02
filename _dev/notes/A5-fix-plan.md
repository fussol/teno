# A5 Fix Plan — bury 永不自動解除（v1.1 定案）

> v1.0 → v1.1：吸收 3 委員審查意見（修法正確性/消費端完整性/Anki 官方行為）。核心變更：時間戳改存 mode 本地日期字串（非 ISO）、modeKey 擴充 atKey、原地 Set.delete、guard 成功後設置＋try/catch、migration 錨點修正、補第 3 呼叫點、deleteDeck 同步清 buriedAt、suspend 交互規則、mc/spell saveCard 承接 mcData。

## 1. Bug 事實

**位置**：store.js bury(:848-862)/unbury(:881-894)、state 初始化(:99-104)、loadAll(:162-329)

**問題**：`state.buried`/`buriedMc`/`buriedSpell` 是 `Set<wordId>`，DB settings 存純 array，**無時間戳**。埋掉的卡永遠不回來 — 沒有任何路徑自動解除。

**Anki 官方語意**（rslib bury_and_suspend.rs + 手冊）：bury 是「當天」操作 — **日界線（dayCutoff）一過自動 unbury**（`unbury_if_day_rolled_over()` 比較 day number）。suspend 才是永久隱藏。Anki 用 collection 級 day number（無 per-card 時間戳）；teno 用「埋卡日」字串比較，等價。

## 2. 消費者清單（grep 窮舉）

| # | 位置 | 消費方式 | 受影響 |
|---|---|---|---|
| 1 | scheduler.js:103 getDueCards | `buried.has(word.id)` | 到期卡排除 |
| 2 | session-v4.js:58/255/347 buildQueue/_resyncIntraday/_computeFutureCounts | `this.buried.has(w.id)` | session 隊列排除 |
| 3 | store.js:339 computeCombinedStats | `buried.has(word.id)` | 統計排除 |
| 4 | store.js:386/393/399 refreshDerived → getDueCards | 傳 Set | dueCount |
| 5 | study-v4.js:18 / study-mc.js:19 / study-spell.js:19 | `buried?.size` | 「N 張已 bury」顯示 |
| 6 | store.js bury/unbury/suspend/unsuspend + deleteDeck(:1418-1421) | Set 操作/spread | 自身 |
| 7 | session-utils.js:34 / session-mc-utils.js:35 / session-spell-utils.js:34 | 傳 flip buried 給 Session | 既有怪異（另案註記） |
| 8 | guides-v3.js:49 | buried.has | dead code（無 importer） |

**範圍外**：session-utils 三檔把 flip buried 傳給 mc/spell session 的既有漏洞（另案）；suspend 永久語意本身不變；UI bury 入口不新增（目前 src 無任何 UI/CLI 呼叫 bury — 影響面為未來/測試）。

## 3. 根因

bury 只記錄「哪些卡埋了」，不記錄「哪一天埋的」→ 無法判斷跨日界線 → 無從自動解除。

## 4. 修法設計（v1.1 定案）

### 4.1 平行日期字串（不動既有 Set）

新增 state 欄位 + DB settings key（三 mode 各一）：
- `state.buriedAt` / `buriedAtMc` / `buriedAtSpell`：`{ wordId: 'YYYY-MM-DD' }` plain object
- DB key：`'buriedAt'` / `'buriedAtMc'` / `'buriedAtSpell'`

**既有 `buried` Set 完全不動** — 所有消費端零改動。日期字串直接用 `getToday(dayCutoff, modeTz)` 產生（mode 本地日、dayCutoff 對齊），**無午夜/時區邊界問題**。

### 4.2 modeKey 擴充 atKey（additive）

`modeKey(kind, mode)` 回傳加 `atKey: kind + 'At' + suffix`（'buried'→'buriedAt'、'buriedMc'、'buriedSpell'）。既有呼叫端只解構 stateKey/cardMap，不受影響。

### 4.3 state 初始化 3 處 + loadAll 讀取

1. state 初始化（:99-104 buried 旁）：`buriedAt: {}, buriedAtMc: {}, buriedAtSpell: {}`
2. loadAll settings 讀取（:175-180）：`buriedAt: await db.getSetting('buriedAt')` 等三 key
3. loadAll Set 賦值（:247-252）：`state.buriedAt = settings.buriedAt || {}` 等

### 4.4 bury/unbury 寫入

- `bury()`：`(state[atKey] ||= {})[wordId] = getToday(state.dayCutoff, modeTz)`（modeTz = 該 mode ankiSettings.timezoneOffset，flip 用 state.ankiSettings?.timezoneOffset）；同批 `db.setSetting(atKey, state[atKey])`
- `unbury()`：`delete state[atKey][wordId]`；同批 setSetting
- `suspend()`：**同步從 buried/buriedAt 移除**（Anki：suspend 會 unbury；bury 對已 suspend 卡 no-op → teno 採「suspend 清 bury」單向）
- `deleteDeck`（:1418-1421）：spread 過濾 buried 時**同步過濾 buriedAt**（三 mode 各一，現況只清 flip → 三 mode 一併補齊）

### 4.5 每日自動解除 `autoUnburyIfNewDay()`

```js
let _lastUnburyCheckDay = null;

async function autoUnburyIfNewDay() {
  const { getToday } = requireScheduler();
  const flipTz = state.ankiSettings?.timezoneOffset;
  const today = getToday(state.dayCutoff, flipTz);
  if (_lastUnburyCheckDay === today) return;
  try {
    for (const mode of ['flip', 'mc', 'spell']) {
      const { stateKey, cardMap, atKey } = modeKey('buried', mode);
      const tz = mode === 'mc' ? state.ankiSettingsMc?.timezoneOffset ?? flipTz
              : mode === 'spell' ? state.ankiSettingsSpell?.timezoneOffset ?? flipTz
              : flipTz;
      const at = state[atKey];
      if (!at) continue;
      for (const [wordId, dayStr] of Object.entries(at)) {
        if (dayStr < today) {
          state[stateKey].delete(wordId);          // 原地 delete 保住 session Set 引用
          delete at[wordId];
          const base = (mode === 'flip' ? state.cards : mode === 'mc' ? state.cardsMc : state.cardsSpell).get(wordId);
          // mc/spell 的 cardMap 值是展開副本 → 用 base 承接 mcData/spellData（同 rateCard :662-667 pattern）
          if (base) { base.buried = false; try { await db.saveCard(wordId, base); } catch (e) { console.warn('[store] autoUnbury saveCard:', e); } }
        }
      }
      try {
        await db.setSetting(stateKey, [...state[stateKey]]);
        await db.setSetting(atKey, state[atKey]);
      } catch (e) { console.warn('[store] autoUnbury setSetting:', e); }
    }
    _lastUnburyCheckDay = today;   // 掃描成功後才設 guard
  } catch (e) { console.warn('[store] autoUnbury error:', e); }
}
```

注意：mc/spell 用 base 承接（副本無 .mcData → saveCard 會寫 NULL 抹資料，必須承接）。

### 4.6 呼叫點（3 處）

1. **loadAll 尾端**（:326 `await refreshDerived()` 前）— 啟動即檢查
2. **refreshDerived 開頭**（:378 前）— 當天第一次任何操作觸發；guard 擋重複
3. **visibilitychange → visible**（main.js）或 session ensureQueue 開頭 — 跨天掛著不重啟的補檢查（Android 背景化過夜 resume）

### 4.7 Migration（既有無時間戳資料）

loadAll 賦值後：對「在 buried Set 但 buriedAt 無記錄」的卡，**補寫 `today` 字串**（getToday 結果，必映射到今天 — 不能用 00:00，會因 dayCutoff 回退到昨天）＋ `db.setSetting(atKey, ...)` 落 DB。老埋卡今天保留、明天日界線後解除 — 與 Anki「next day」一致。

### 4.8 防回歸測試 `tools/verify-a5-unbury.mjs`

1. 埋卡 → buried Set 含 id + buriedAt 有當日字串 + DB 同步
2. 同日檢查 → 不解除（guard + 日期比較）
3. 模擬跨天（buriedAt 設昨天字串）→ 自動解除（Set 不含、DB 清、base.buried=false）
4. 三 mode 各自獨立（flip 解除不影響 mc/spell）+ 各自 tz
5. 老資料 migration（無 buriedAt）→ 補 today → 明日解除；dayCutoff 邊界 case（00:00 不誤判）
6. suspend 不受影響（不解除）；suspend 清 bury 交互
7. session Set 引用不破（原地 delete）
8. mc/spell saveCard 承接 mcData 不抹

## 5. 範圍外清單

- suspend 永久語意（不變）
- bury 的 UI 入口（目前無呼叫端，不新增）
- Anki burySiblings（姊妹卡自動 bury）— 不同功能，另案
- dayCutoff 本身（480 已對）
- session-utils 三檔 flip buried 傳給 mc/spell 的既有漏洞 — 另案註記
- clock-rollback 防護（Anki `(today+7)<last_unburied` 強制 unbury）— 低風險，註記不修

## 6. 驗證方式

- node --check store.js main.js
- tools/verify-a5-unbury.mjs 全過
- fsrs-verify / verify-undo / verify-c1-undo-modes 回歸（不動 fsrs 核心）
- vite build

## 7. 風險

- refreshDerived 每 rating 後跑 → guard 一天一次，無效能風險
- saveCard/setSetting 失敗 → console.warn 不阻斷（與既有一致）
- migration 補寫 today → 老埋卡多一天（保守可接受，Anki 語意相符）
- guard 設在 try 成功後 → 失敗當天可重試（自癒）
