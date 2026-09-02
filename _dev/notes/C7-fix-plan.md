# C7 修法計畫書 v1.1（2026-08-27，PM1）

> v1.1 變更（R1 審查後，僅動驗證腳本，產品碼修法 9 處零改動）：
> ①T4 假紅缺陷修正（三委員一致實錘）：v1.0 T4 誤排在 T3 重評之後，該點快照非 null，修法正確反而紅燈——移至 T2 undo 後、T3 前（快照確定 null）；
> ②相位級 document 隔離（resetState 重建 jsdom）：消除 harness 特有 stale handler 跨相位污染（貼近真實 App renderPage pageCleanup 語意）；
> ③覆蓋補齊：mc/spell 補 RC2（完成畫面 mount→undo）＋RC3（undo→重評→再完成不 reset）鏡像斷言＋零跨 mode 誤 undo 序列斷言；T6 mode 斷言改絕對位置 `undoCalls[u6b]`（原自參考恆真消除）。斷言 24→32。

## Bug 定義
1. 完成畫面（全部卡片評完）無法 undo 最後一張 — 無任何 undo 路徑（無按鈕、Ctrl+Z 無效）。
2. 評分後下一張已出現但**未翻答案**（QUESTION 態）時，Ctrl+Z 被擋 — 必須先翻開下一張答案才能復原上一張。

## Root Cause（2026-08-27 實錘行號，audit 2026-08-13 :189/:215 已漂移）
三同構檔各自同一組缺陷（flip / mc / spell）：

| # | 檔:行（HEAD 實錘） | 缺陷 |
|---|---|---|
| RC1 | session-utils.js:219、session-mc-utils.js:240、session-spell-utils.js:231 | keydown gate `if (state === 'ANSWER' && _undoSnapshot)` — 評分後 state 轉 QUESTION（下一張）或 EMPTY（完成），snapshot 在場但 gate 擋死 |
| RC2 | session-utils.js:193、session-mc-utils.js:214、session-spell-utils.js:201 | `mount()` 開頭 `if (!session?.running) return;` — 完成畫面 running=false 直接早退，**keydown handler 根本未註冊**（且把上一次 mount 的 handler 已先 keyCleanup 掉 → 完成畫面零 handler） |
| RC3 | 三檔 `undoRating()`（session-utils.js:179-181 區段） | `_completionShown` 未在 undo 時清除 → 完成畫面（`_completionShown=true`）undo → 重評最後一張 → 再次完成時 `ensureQueue`（session-utils.js:55-64）走第二分支 `session.reset()` **清空 results 並重開佇列**，用戶看到的是佇列重組而非完成畫面 |

## 修法（三檔同構、各 3 處、共 9 處，全部白名單內）
檔：`src/engine/session-utils.js`、`src/engine/session-mc-utils.js`、`src/engine/session-spell-utils.js`

1. **RC1 gate 放寬**：`if (state === 'ANSWER' && _undoSnapshot)` → `if (_undoSnapshot)`。
   - 安全性：完成/QUESTION 態下 handler 內其他鍵全有各自 gate（flip: `case '1'..'4'` 需 ANSWER、space→flipCard 需 QUESTION、p 需 current；mc:1-8 需 QUESTION/ANSWER；spell:1-4 需 ANSWER、Enter/[ 需 QUESTION），放寬僅解鎖 Ctrl+Z 一鍵。
2. **RC2 mount 早退條件**：`if (!session?.running) return;` → `if (!session?.running && !_undoSnapshot) return;` — 完成畫面但有快照時仍註冊 keydown + undoBtn 綁定（undoBtn `?.` null-safe，完成 DOM 無此鈕則 skip）。
3. **RC3 undo 清旗標**：`undoRating()` 內 `session.running = true;` 旁補 `_completionShown = false;` — 保证 undo→重評→再完成時走正常完成畫面分支。

### 可選項定案（憲法⑦）
- **undo gate 加 `!_ratingLock`**：**不做**。評分 in-flight 期間 undo race 是 C8 的定義域（本波下一顆）；一 bug 一 commit，提前摺入會讓 C8 失去獨立的負控制錨點。C7 放寬 gate 未擴大 in-flight 暴露面：in-flight 期間 state 恆為 'ANSWER'（rateCard 於 next() 後才改 state），與修前相同。
- **完成畫面加「↩ 復原」按鈕**：**不做**（白名單外）。undoBtn 元素在 `src/pages/study-v4.js:66`、`study-mc.js:96`、`study-spell.js:94` 條件渲染，renderEmpty 無此鈕 → 已登 `_dev/notes/scope-requests.md` C7-SR1（study pages 屬 PM8 白名單）。本 commit desktop（Ctrl+Z）先通；手機（無鍵盤）須待 SR1 改派補按鈕才是完整修復——**誠實登記：本 commit 對手機完成畫面 undo 僅部分修復**。
- **多級 undo（undo 兩張以上）**：不做。`_undoSnapshot` 單槽是既有架構（C1 已修 per-mode 隔離），多級屬新特性。

## 消費者清單（憲法②）
- `_undoSnapshot` 讀方：三檔 `undoRating()` 首行 guard、keydown gate、（本修法新增）mount 早退條件。寫方：rateCard 成功後、undoRating 清空。
- `undoRating()` 呼叫端：mount 內 undoBtn click（三檔）＋ keydown Ctrl+Z（三檔）。本修法不觸碰函式本體除 RC3 一行。
- `_completionShown` 讀寫方：僅 ensureQueue 完成分支（三檔）＋（新增）undoRating 清除。
- `state` 匯出（`export let state`）：頁面 render 端只讀；本修法不改 state 生命週期。

## 驗證方式（tools/verify-c7-undo-gate.mjs，法④先行實跑）
jsdom（本專案 devDep ^30.0.1，verify-g13 先例）提供真實 document + keydown 事件派发；c3 harness 三件套 mock（FakeDatabase/invoke/main.js toast）；**真實 store.actions.rateCard / undoLastRating / FakeDatabase review_log**（非假 store）。

- T1（flip，RC1）：評第一張 → 下一張 QUESTION → 派發 Ctrl+Z → 斷言 store.undoLastRating 生效（review_log flip 計數 -1、session.current 回到原卡、state='ANSWER'）。負控制：舊 gate → 零作用。
- T2（flip，RC2）：drain 全部卡至完成畫面 → 重 call `mount()`（模擬完成頁 onMount）→ 派發 Ctrl+Z → 斷言 undo 生效（results.pop、current 回最后一張、running=true、state='ANSWER'）。負控制：舊 mount 早退 → handler 未註冊 → 零作用。
- T3（flip，RC3）：T2 undo 後重評最後一張 → 再完成 → 呼叫 `ensureQueue()` → 斷言回傳 false（完成畫面）**且 `session.results.length===3`**（未被 reset 清空）。負控制：舊碼走 `session.reset()` → results=0。
- T4（flip，安全回歸）：**快照確定 null 時**（T2 undo 已清空快照）派發 Ctrl+Z → 零副作用（log 不變、不 throw）。v1.1 重排至 T2 後、T3 前。
- T5（靜態 marker）：三檔源碼各含 `C7` 修法標記（修法註解）；負控制模式斷言不存在。
- T6（mc，RC1+RC2）：pickAnswer+rate → QUESTION 派發 Ctrl+Z → undo 生效；完成後重 mount → undo 生效。
- T7（spell，RC1）：submitAnswer+rate → QUESTION 派發 Ctrl+Z → undo 生效。
- 負控制標準做法：`/tmp` 副本 + `git show HEAD:<三檔>` 覆蓋 + `--expect-legacy` 全綠（bug 精準重現：T1/T2/T6/T7 undo 零作用、T3 results 歸零）。委員另有義務於 /tmp 副本雙向重跑。

### 送審前實跑紀錄
**v1.0（2026-08-27，HEAD=3cca336 未修態）**：`--expect-legacy` 24/24 exit 0；正常模式 15 FAIL exit 1。（⚠️ 此態未暴露 T4 缺陷——T4 在舊碼下「為對的理由而綠」，R1 委員於修法副本才抓到，見審查紀錄）
**v1.1（2026-08-27，HEAD=2baa519）**：
- 未修態正常模式 → **exit 1，19 FAIL**：紅集＝辨證斷言全集（T1×3、T2×2、T3、T5×3、T6×5、T7×5），T4 與全部前置結構斷言恆綠（無誤報）。
- 未修態 `--expect-legacy` → **32/32 ALL PASS exit 0**（bug 於 flip/mc/spell 全鏈路精準重現，含新補的 mc/spell 完成態與 RC3 重現）。
- /tmp/c7v11 修法副本（三檔×3 處逐字套 v1.0 §修法，加 `// C7:` 標記）正常模式 → **32/32 ALL PASS exit 0**。
- 三檔 `node --check` 副本語法通過（python 替換後由腳本 import 隱式驗證＋下方動工後再跑）。

## 審查歷程
### R1（v1.0 送審，3 委員）
- **#1 修法正確性 ✅**：RC1-RC3 行號機制逐處對齊；放寬 gate 逐鍵安全性成立；/tmp/c7rev1 親套修法 **22/24**——T4×2 FAIL 實錘＝腳本 T4 前置假設缺陷（快照非 null 處斷言不 undo），修法本身全部意圖斷言轉綠；三 RC ablation 各自獨立必要。
- **#2 消費者/時序 ❌**：消費者清單窮舉無漏網、handler 生命週期無洩漏、跨 mode 隔離成立、C3 相容論證成立；但 T4 與修法目標直接矛盾（必假紅）＋harness stale handler 隱患＋T6 自參考斷言。→ 採納。
- **#3 驗證方法學 ❌**：變異體牙檢三 RC 全有牙（A 收回 gate→T1/T2/T3/T6/T7 紅、B 收回 mount→T2/T3/T6 紅、C 刪旗標→T3 紅）；T4 為「測不到聲稱行為」壞斷言（為對的理由綠）；RC2/RC3 僅 flip 測過（mc/spell 缺口）；處方（T4 重排＋相位 document 隔離）於 /tmp/c7rev3 親測雙向全綠。→ 採納。
### R2（v1.1 送審，2 委員＝R1 ❌ 兩席複審）
- **#2 複審 ✅**：三條發現逐一落地（T4 反證：未修態恆綠、修法副本恆綠；document 隔離反證：跨相位無洩漏）；三態 32/32·19 FAIL·修法副本 32/32 與計畫書逐字吻合；變異收回 RC1→16 FAIL（紅集含全部新增 T6/T7 斷言，牙未鈍化）、收回 RC3→恰好 3 FAIL（T3/T6RC3/T7RC3，獨立乾淨紅集）；T4 兩態恆綠理由不同之正當性論證採納（安全回歸性質，判歧由 T2 承擔）。
- **#3 複審 ✅**：R1 四項處方逐字落地核對表全中；三態各 5 連跑＋變異各 3 連跑零非確定性；變異 A(16 FAIL)⊇{T1,T6,T7}、B(9 FAIL)⊇{T2,T6完成,T7完成}、C(3 FAIL)=恰{T3,T6RC3,T7RC3}——三變異紅集可唯一定位 RC1/RC2/RC3；新斷言無鈍化無恆真（跨 mode 序列斷言經變異實證依賴 undo 真發生）。
- **R2 全席 ✅ → 過審動工。** repo 套 9 處修法（python 逐檔三段替換＋assert 防partials，`git diff --stat`＝3 檔 9+/6−）→ 正常模式 32/32 exit 0；回歸 c3/c1/undo-cycle/next-after-undo/c5/c6/a6/c4 八項 exit 0；node --check 三檔；vite build 703ms。

## 風險
- handler 在完成畫面常駐：僅 Ctrl+Z 一條活路徑（其餘鍵有 state gate，見修法 1）；`window.__pageCleanup` 於 mount 尾註冊，main.js 頁切換既有清理鏈不變。
- 跨模块 handler 累積（flip/mc/spell 各自 addEventListener）：undo gate 命中各自 `_undoSnapshot`（null 即 no-op）＋undoLastRating 帶 mode 參數（C1 隔離），派發互不污染 — 驗證腳本三模块同場即壓力測試。
- 回滾：還原 9 處即完全回滾，無 DB/schema/存檔格式變更。
- 與 C3 鎖（6324eb4）、C1 快照隔離相容：不動 rateCard 鎖语义、不動 store 層快照。

## 範圍外（憲法⑥登記）
- C8：rateCard in-flight 期間 Ctrl+Z race（_ratingLock 不擋 undo、快照 await 後才更新）— 本波下一顆。
- C7-SR1：完成畫面/QUESTION 態「↩ 復原」按鈕能見性（pages/study-v4.js、study-mc.js、study-spell.js renderEmpty/renderCard）— scope-requests.md，PM8 域。
- 多級 undo（Anki 支援多步 undo，本 app 單槽快照）— 新特性另案。
- leech tag / goalStreak 還原細節 — C1/C9 域。

## 審查
一般 bug 但**三檔同構 + 動 undo 核心鏈** → 依法 3 委員。重點審查面：#1 修法正確性（RC1-RC3 逐處對齊＋負控制有牙）、#2 消費者/時序完整性（handler 註冊-清理鏈、跨 mode 事件污染、與 C3 鎖相容）、#3 驗證腳本品質（真實度、斷言區分力）。
