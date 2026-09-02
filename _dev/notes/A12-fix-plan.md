# A12 修復計畫書 — 容器卡假 due（state=0 + due 硬填）

> 狀態：**定案（v3.1）**｜審查：5 委員 × 3 輪（第 1 輪 ❌ 重作 → 第 2 輪 3✅2❌ 小修 → 第 3 輪 4✅1❌ 採納 v3.1 → 定案）
> 範圍：僅 A12 專案，不夾帶其他 bug

---

## 1. Bug 定義

**症狀**：9 張卡（tuck/squat/curfew/benevolent/dike/scarcely/usage/pianist/smog）在 flip 面是 state=0（全新），但 DB 帶 `due=2026-08-01`（假 due）→ 統計算成到期卡；且容器卡殘留在 flip queue 被 newPerDay cap 擋住。

**Root cause**（已實錘）：
- 「三模式分開」設計用容器卡實作：base row 永遠代表 flip 面狀態，`mc_data`/`spell_data` 存 MC/Spell 各自排程
- 缺陷 1：`store.js:654` 首次 MC/Spell 作答建立容器卡時硬填 `due: now`（new 卡不該有 due）
- 缺陷 2：`store.js:225` loadStore 清理條件寫反 — 註解原意「移除容器卡」但 `if (c.mcData || c.spellData) continue;` 恰好保留容器卡 → 殘留 flip queue
- 復發路徑：任何「先 MC/Spell 學習、尚未 flip」的新字都會再生容器卡

**資料實查**（teno-backup0814.db）：
- `state=0` 共 9 張、全數 `mc_data` 非空（state=2, stability 2.31~18.52, reps 2~4）、無 spell_data、無 last_review
- `state=0 AND due!='' AND mc_data IS NULL AND spell_data IS NULL` = 0 張（WHERE 不漏不誤傷）
- review_log 23 筆（8/1 起 MC 學習歷史）不觸碰

---

## 2. 修復方案 v3（5 處）

### 2.1 `src/lib/store.js:654` — 容器卡建立 due 改空
```js
// 現況
due: now, stability: 0, difficulty: 5, ...
// 改為
due: '', stability: 0, difficulty: 5, ...
```
- `cards.due` 是 `TEXT NOT NULL`，`''` 合法（NULL 違反 constraint）
- `''` falsy → 所有 `!card.due` 檢查（scheduler.js:119、session-v4.js:68 等）直接跳過
- `saveCard`（db.js:206 `card.due ?? new Date().toISOString()`）— `''` 非 nullish，原樣寫入 ✓

### 2.2 `src/lib/store.js:225-231` — 清理邏輯修正（只刪 flip map）
```js
// 現況（bug）：條件寫反，容器卡被 continue 保留；228-229 對無容器卡才執行（no-op）
if (c.mcData || c.spellData) continue;
if (c.reps === 0 && c.lapses === 0 && c.state === 0 && !c.lastReview) {
  state.cards.delete(wid);
  state.cardsMc.delete(wid);    // ← 必須刪除
  state.cardsSpell.delete(wid); // ← 必須刪除
}
// 改為（照註解原意：移除 flip 從未學的容器卡，mode maps 保留）
if (c.reps === 0 && c.lapses === 0 && c.state === 0 && !c.lastReview && (c.mcData || c.spellData)) {
  state.cards.delete(wid);   // 只移除 flip map
}
```
⚠️ **必須刪掉 228-229 兩行**（#2/#4/#5 一致實錘）：否則每次 load 銷毀 cardsMc/cardsSpell → MC/Spell 進度永久損失（flip 首評時 `oldMcData` fallback 變 undefined → saveCard 把 mc_data 寫 NULL）。
- 條件精準：state=2 且 mc_data 非空的卡（reps>0）不會命中；純 flip 卡（無 mcData/spellData）不會命中
- 容器卡從 flip map 移除後：buildQueue 對無卡的 word 走 `card:null, type:'new'`（session-v4.js:63-65）→ 正常新卡行為，受 newPerDay cap（Anki 語意正確：未學 sibling = new）
- flip 首評時 `hadBaseCard=false` → 重建卡，`oldMcData` fallback 保留 mcData ✓

### 2.3 `src/lib/store.js:759` — undo restore 分支 due 一併改空
```js
// 現況（undo 還原容器卡時重造假 due）
const restore = { due: new Date().toISOString(), ... state: 0, ... };
// 改為
const restore = { due: '', ... state: 0, ... };
```
- 防 undo 路徑持續把 migration 清掉的髒資料寫回（#4/#5 要求）

### 2.4 統計排除 state=0（兩處）
- `store.js:349` computeCombinedStats：`if (!card || !card.due) continue;` → `if (!card || !card.due || card.state === 0) continue;`
- `dashboard.js:173` computeCombinedStats：`if (card.due) {...}` → `if (card.due && card.state !== 0) {...}`
- 對齊 `dashboard.js:880` 已有 isDue guard（`c.due && c.state !== 0`）

### 2.5 Migration — 清現有 9 張假 due

> **載體鎖定（#5 第 3 輪要求）：走 `db.js migrate()`（initDB 每次啟動執行）**，手機端裝新版自動跑；CLI `fix clear-container-due` 僅作桌面兜底。migrate() 內 UPDATE 前先嘗試 Rust `backup_db`（api.js:72），失敗則依賴現有 10 分鐘 backup-scheduler。
```sql
UPDATE cards SET due='' WHERE state=0 AND due!='' AND (mc_data IS NOT NULL OR spell_data IS NOT NULL);
```
- 前置：`backupDb()`（api.js:72 已 export；backups/ 目錄機制齊備，10 分鐘自動備份）
- 冪等（`due!=''` 防重跑）；實測影響 9 行、integrity ok、其他表零影響
- 形式：CLI 子命令 `fix clear-container-due`（tools/cli.mjs cmdFix 先例：backupDb → dbw → SQL → log → audit，help 文字 cli.mjs:3497、命令表 :3544）或 db.js migrate()（initDB 每次執行）
- 手機 DB 需在手機端執行（9 張卡在手機 live DB；桌面 DB 無）

---

### 2.6 `src/lib/store.js:738-755` — undo wrapped 分支對調（v3.1，#1 第 3 輪抓到的 v3 引入 regression）

- **問題**：v3 的 #2 清理生效後，容器卡不在 `state.cards` → MC 模式 `undo` 時 `:731 baseCard=undefined` 跳過 → 命中 `:738 else if (hadCard && prevCard)`（wrapped）→ `{...prevCard}` 把 MC 卡頂層欄位（state≥1、真 due）寫成 base 卡 → **state≥1 假 flip 卡**（#2/#5 清理都清不掉，比原 A12 更糟）+ spell-undo 可能把另一模式 mc_data 寫 NULL
- **修正（對調 :738 與 :756 分支順序）**：restore 分支（:756，含 due:''）優先 — `prevBaseCardMcData || prevBaseCardSpellData` 命中時一律還原成純容器卡；wrapped 分支變不可達可刪除（snap 快照 :562-567 與 `hadCard` 同源證明）
- **驗證**：`mc→mc→undo → 重載 → flip queue 不應出現該字`、`spell-undo 後 mc_data 不應變 NULL`

---

## 3. 審查歷程

### 第 1 輪（原方案：清 due=NULL + 補 state=1）→ ❌ 0/5 過
| 委員 | 裁決 | 關鍵 |
|---|---|---|
| #1 技術 | ❌ | due NOT NULL constraint（NULL 直接失敗）；state=0 卡不讀 due → 清 due 零效果；補 state=1+due=NULL 卡永久消失 |
| #2 Anki | ⚠️ | 移除「補 state=1」（語意錯）；清 due 寫 `''` 非 NULL |
| #3 DB | ⚠️ | 9 張確認、備份充足；清 due 不解除 cap 症狀 |
| #4 資料安全 | ❌ | 方向錯：應解包 mc_data 或純修統計 |
| #5 整合 | ❌ | 復發路徑沒切斷；統計假 due 另案 |

→ 重作：路線 B（分軌）+ root cause 釐清（容器卡 = 分開設計正常產物，兩處實作瑕疵）

### 第 2 輪（v2：due:'' + 清理修正 + 統計 guard + migration）→ 3✅ 2❌（小修）
| 委員 | 裁決 | 關鍵 |
|---|---|---|
| #1 技術 | ✅ | 4/5 項正確；務必刪 :228-229 |
| #2 Anki | ✅ | 語意全過；必改配套：刪 228-229 + undo/C2 交互 |
| #3 DB | ✅ | SQL 精準 9/9、integrity ok、備份齊備 |
| #4 副作用 | ❌ | 漏 store.js:759（undo restore due:''） |
| #5 整合 | ❌ | step 2 刪除目標未寫死 → 資料損失風險；漏 :759 |

→ 採納 2 處精確修正 → v3

### 第 3 輪（v3 → 4✅ 1❌ → 採納 v3.1 → 定案）
| 委員 | 裁決 | 關鍵 |
|---|---|---|
| #1 技術 | ❌ | **undo wrapped 分支（store.js:738-755）**：v3 #2 生效後 mc→mc→undo 命中 wrapped → 造 state≥1 假 flip 卡（比原 bug 更糟）+ spell-undo 可能寫 NULL mc_data → v3.1 對調分支 |
| #2 Anki | ✅ | 5 處全正確；mc→flip→undo 依賴 C2 同批（fix-plan v3 批次 4）或明載 |
| #3 DB | ✅ | migration 精準 9/9、冪等、雙軌執行可行 |
| #4 複審 | ✅ | 上輪 2 個 ❌ 已解決；wrapped 判範圍外（#1 的 regression 論點仍採納） |
| #5 整合 | ✅ | 5 處完整覆蓋；鎖定 migration 載體 = db.js migrate() |

→ 採納 v3.1（對調 undo 分支）+ migration 載體鎖定 → **定案**

---

## 4. 驗證方式

1. **單元**：node 模擬 buildQueue — 容器卡修復後不帶假 due 進 queue；flip 首評重建卡保留 mcData
2. **Migration 模擬**：/tmp 副本跑 SQL → 影響 9 行、integrity_check ok
3. **DB 檢查**：修復後 `SELECT count(*) FROM cards WHERE state=0 AND due!=''` = 0
4. **統計**：dashboard/統計對這 9 張不再計 due
5. **復發測試**：模擬「先 MC 後 flip」新字 → 容器卡 due=''（不再假 due）
6. **undo 測試**：mc→flip→undo 不重造假 due（:759 驗證）
7. 手機端安裝後用新 DB 驗證 9 張卡狀態

## 5. 風險

- **中**：清理邏輯若保留 228-229 → mode 進度永久損失（已在方案明確刪除，複審把關）
- **低**：due:'' 在極少數未防護路徑造成 Invalid Date（#1 實測所有 reachable 點有防護；唯一無防護在 deprecated/sim-engine.js 死碼）
- **低**：migration 只清 state=0 容器卡，其他異常卡（現 DB 無）不在範圍
