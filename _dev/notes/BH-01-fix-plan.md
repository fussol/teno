# BH-01 fix plan — deleteDeck 漏清 suspendedMc / suspendedSpell

> 任務書：PM-BH-FIX-MISSION.md / BUGHUNT-TODO.md#BH-01
> 檔：`src/lib/store.js`（共享核心檔 → 3 委員審查，不可降席）
> 動工前 HEAD：`a53a13c`（v5.8.12）

## 1. Bug 定義
`deleteDeck(id)`（store.js:1740-1771）刪字本時，對 buried/suspended 三 mode Set 家族做過濾，但**漏掉 `state.suspendedMc` / `state.suspendedSpell` 兩個 Set**，對應的 `db.setSetting('suspendedMc'/'suspendedSpell')` 也漏寫 → 刪字本後 DB settings 與 memory 都殘留死 wordId。

## 2. Root cause
A5 波次在 deleteDeck 補齊了三 mode 的 buried/buriedAt（:1753-1757, :1761-1765），但 suspended 只補了 flip（:1751），mc/spell 兩個 Set 漏掉。state 端與 DB 端同漏。

## 3. 影響
`settings.suspendedMc`/`suspendedSpell` 殘留死 id。若該 word 透過其他路徑重新進入 state，`computeCombinedStats` 的 `hiddenAll`（:459-460）會因 suspendedMc 含該 id 誤判該卡隱藏，dashboard 統計失真。資料滯留腐化，隨時間累積。

## 4. 修法（store.js deleteDeck）
於 :1752 後補兩行 Set 過濾：
```js
state.suspendedMc   = new Set([...state.suspendedMc].filter(id => !wordIds.has(id)));
state.suspendedSpell= new Set([...state.suspendedSpell].filter(id => !wordIds.has(id)));
```
於 :1762（buriedSpell setSetting）後補兩行 setSetting：
```js
try { await db.setSetting('suspendedMc', [...state.suspendedMc]); } catch (e) { console.warn('[store] deleteDeck setSetting suspendedMc error:', e); }
try { await db.setSetting('suspendedSpell', [...state.suspendedSpell]); } catch (e) { console.warn('[store] deleteDeck setSetting suspendedSpell error:', e); }
```
最小幅、精準、不碰 schema / FSRS / OCR。

## 5. 驗證方式
`tools/verify-bh01.mjs`（源碼契約釘＋語意重放）：
- 源碼釘：讀真實 store.js deleteDeck body，斷言含 suspendedMc/suspendedSpell 過濾 + 兩行 setSetting → 未修時必 FAIL。
- 語意重放：假 state 含三 mode suspended Set 各塞 deck 內 id → 重放修後語意 → suspendedMc/suspendedSpell 剔除、flip suspended/buried 對照不誤傷。
- 負控制：剝除 suspendedMc/suspendedSpell 兩行 → 該 Set 殘留（bug 態精準重現）。
- `git stash` 負控制：stash store.js 後跑 harness 必 FAIL 數個。

## 6. 風險
低。不碰 DB schema、FSRS、OCR。誤刪風險由對照組（flip/buried 不受影響）守護。

## 7. 範圍外
- BH-02（deleteWord memory 端全清）、BH-03（deleteDeck reviewLog/examHistory）各自獨立計畫書/commit。
- `mergeDeck`、`moveDeck` 不屬本顆。
- mem 端 reviewLog/examHistory 清理歸 BH-03，本顆不動。

## 版本
逐顆升 patch：本顆 → `v5.8.13`（`./tools/version.sh 5.8.13`）。