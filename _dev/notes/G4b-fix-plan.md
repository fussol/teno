# G4b 修復計畫書 v1.2 — 里程碑/學習訊息用單 session 計數且重啟歸零（G4 範圍外承接單）

## 1. Bug 定義
G4（commit 0bb9842）已修 `_totalRated` 寫入端，成就（checkAchievement）已終生制。
但其姊妹函式仍有audit G4 後半症狀：
- `checkStudyMessages(total)` / `checkMilestone(total)` 呼叫端傳 `session.results.length`
  （單 session 計數）→ 生涯 500 卡但本 session 只評 3 卡 → 500 里程碑不出。
- `_lastMsgAt` / `_milestonesShown` 為模組級記憶體 → 重啟歸零 → 每次重開新 session
  重新觸發 5/10/25… 訊息與已看過的里程碑（重播）。

## 2. Root cause（2026-08-28 實錘）
- `src/lib/easter-eggs.js`：:12 `let _lastMsgAt = -1`、:24 `let _milestonesShown = new Set()`
  （記憶體單一來源，無持久化）；`checkStudyMessages`/`checkMilestone` 直接吃呼叫端 total。
- `src/engine/session-utils.js` :128-129（C10 併入後行號）：
  `checkStudyMessages(session.results.length); checkMilestone(session.results.length);`
  ——唯一呼叫點（mc/spell 無 easter-eggs import，R1#2 C10 審查已穷举）。
- 讀端基础设施已存在：`localStorage._totalRated`（store.js:1099-1102 G4 寫入，
  JSON 編碼、isFinite 防污染）。

## 3. 修法（easter-eggs.js 主體＋engine 呼叫點 2 行）
### easter-eggs.js
1. 新增模組內 `function lifetimeRated()`：`Number.parseInt(localStorage.getItem('_totalRated') || '0', 10)`
   → `Number.isFinite ? n : 0`，try/catch 回 0（無 localStorage 環境）。
2. 新增持久化進度 `_eggsShown`（localStorage，JSON `{lastMsgAt, milestones:[...]}`）：
   `readShown()` try/catch 髒資料回預設 `{lastMsgAt:-1, milestones:[]}`；
   `writeShown(s)` try/catch 隔離。
3. `checkStudyMessages()`（去參數）：total=lifetimeRated()；`total <= lastMsgAt` 即返回；
   否則**降序找已達的最高節點**放一條 toast，並 `lastMsgAt = total`（跳頂標記）後 writeShown。
   **觸發雙條件（R2#1 守衛補文，v1.2 明文）**：節點 m 可放 ⇔ `total >= m.at` **且
   `m.at > lastMsgAt`**（已放過節點永不重放）；非節點 total 遞進（5→7）→ 零放、靜默
   lastMsgAt=total 跳標。**語意定案（R1#1 發現 A → v1.1 明文）**：中間未及節點**永久跳過**
   ——生涯 300 卡老字號升級後首評只放「🏆 200 cards」級最高一條，不逐條轟炸 5/10/25…。
   棄「逐條補放（m.at 標記）」讀法：encouragement 訊息密集，轟炸 6 條屬騷擾；原單調一次性
   語意的核心（每節點終生一次）保留，節點間跳躍為本單明示取捨。
4. `checkMilestone()`（去參數）：total=lifetimeRated()；**升序逐條補放**（每次呼叫一條，
   milestones.push(m) 持久化）。**不對稱登記（R1#1）**：里程碑稀疏高價值（100/500/1000/5000），
   逐條補放有儀式價值且最多 4 條封頂，與密集訊息的跳頂策略取捨不同，屬明示設計。
5. `checkAchievement` 零改動（已終生制；其 `_achievements` 讀取防呆屬 C10 §6 登記域，
   本單順手以同一 try/catch 風格加固與否見 §7 定案）。
### session-utils.js
:128-129 呼叫點改 `checkStudyMessages(); checkMilestone();`（語意：函式自取自足計數）。

語意變化（誠實登記）：提示訊息/里程碑由「本 session 進度」改「生涯進度、各觸發一次」。
原 5/10/25 訊息本就是一次性 toast（_lastMsgAt 單調），改生涯制是口徑接軌 `_totalRated`
與成就系統，非新增功能。

## 4. 驗證方式（tools/verify-g4b-milestone-persist.mjs）
harness：localStorage stub 全鍵可控＋main.js toast mock＋easter-eggs 動態 import（query 重載
＝重啟模擬）。斷言面（LEGACY＝HEAD / FIXED）：
- T1 終生制：`_totalRated='10'` → `checkStudyMessages()`：FIXED 觸發 10 卡訊息 toast×1
  （LEGACY 無參呼叫 total=undefined → 零 toast）；第二次呼叫不重播。
- T2 跨重啟不重播：T1 後以新 query 重 import（模組態歸零）→ 再呼叫 → 零 toast
  （LEGACY：重 import 歸零必重播 toast）。
- T3 里程碑：`_totalRated='100'` → checkMilestone() → document.body 現 .milestone-overlay
  （LEGACY 無參 → 不出）；重啟模擬再呼叫 → 不重播。
- T4 session 計數解耦釘：呼叫端不再傳 session 數（靜態 grep engine 呼叫點零參數）＋
  `_totalRated='0'` 時无论呼叫多少次零觸發。
- T5 髒資料：`_totalRated='abc'`／`_eggsShown='{壞json'` → 不 throw、視為 0/預設。
- T6 無 localStorage（delete global）→ 本單兩函式呼叫不 throw（checkAchievement 裸讀
  localStorage 於無 LS 環境必拋＝既存缺陷，LEGACY/FIXED  alike，屬 §6 另單域——
  探針納入即混單假紅，v1.0 誠實排除實測登記）。
- T7 靜態標記。
- T9 中間帶探針釘（R2#1 缺項 2）：5→7→10 序列——@7 非節點**零新增 toast**（字面直譯無守衛
  版在此轉紅：同節點重放）、@10 恰一條「10 cards」文字釘。
- 負控制：--expect-legacy 全綠；未修碼 normal 紅集＝辨證全集。
- 回歸：verify-g4（前單）/c3/c10/c7/c8/c9 + node --check×2 + vite build。

## 5. 風險
- 老字號升級後首次越過未觸發過的節點會補放一次 toast（一次性，屬預期補償行為）。
- **localStorage 寫入 throw（無痕模式等）→ 觸發態不持久化 → 重啟重播＝降級回現行 bug 行為，
  罕見環境一次性，接受（R1#1 發現 B 補登）**。readShown 對非物件 JSON（如 `"5"`/`null`）
  回預設降級（R1#1 建議補防呆）。
- restoreBackup 不清 localStorage（既存缺口）：還原備份後 `_totalRated`/`_eggsShown` 與 DB
  進度不同步 → 可能「還原到 100 卡備份但里程碑不再彈」——R1#2 登記，屬 §6 另單域。
- `_eggsShown` 與 `_achievements`/`_totalRated` 同層 localStorage，無 DB 遷移面。
- checkAchievement 的 `_achievements` 讀端仍裸 JSON.parse：本單不動（C10 §6 域，避免混單）。

## 6. 範圍外清單（憲法⑥）
- `_achievements` 讀端防呆（C10 §6 已登記，另單）。
- checkAchievement 裸讀 localStorage 於無 LS 環境必拋（既存，同屬 easter-eggs 健護單）。
- restoreBackup 還原後 localStorage 鍵（_totalRated/_achievements/_eggsShown）與 DB 同步
  （R1#2 發現 1，既存同類，另單）。
- undo 重評 `_totalRated` 高估（G4 v1.1 已登記接受）。
- 成就系統 DB 化（localStorage → SQLite）：大改另案。
- konami/其他 easter-egg：不動。

## 7. 可選項定案（憲法⑦）
- （做）呼叫點去參數而非函式無視參數：呼叫端 `session.results.length` 已無語意，
  留參數會誤導「函式依呼叫端計數」。函式自取＝單一真相（_totalRated）。
- （做）study msgs 與 milestones 共用單 key `_eggsShown`：兩態天然同生命週期，雙 key 徒增
  部分失敗態。
- （不做）_achievements 順手加固 → §6（一單一事）。
- （不做）里程碑閾值調整：不動（非 bug 域）。

## 8. 審查紀錄
### R1（三委員，v1.0）
- **#1 修法正確性 ❌→（v1.1 補登記後轉案）**：root cause/呼叫點穷举/讀寫端對齊/§7 一致性全 ✅；
  變異實驗實錘**發現 A**：§3 「更新 lastMsgAt」未定義目標值，harness 隱式釘 `=total` 跳頂語意
  （m.at 逐條補放讀法必紅 T1-2/T2），要求明文定案＋誠實登記「中間節點永久跳過」＋
  訊息/里程碑不對稱理由。發現 B：無痕 setItem throw→重播降級面補 §5。readShown 非物件
  JSON 防呆補 §5。行號 :12/:24 修正。
- **#2 消費者/契約 ✅**：呼叫面恰 engine 兩行＋main.js:368 initKonami（零交集）；`_eggsShown`
  無鍵衝突；**resetAll 走 `localStorage.clear()`（store.js:1777）全清——新鍵自動納入重置語意、
  無漏鍵缺陷**；Android WebView localStorage 預設持久、無需額外工作；發現 1：restoreBackup
  不清 localStorage（既存同類）→ §6 另單登記；Node 旗標登記。
- **#3 測試品質 ✅ 有條件**：手套正確修法全綠基線；變體 A/B/D/E/F1/F2/G 全被抓（紅分布精准），
  C 可接受變體登記；**F3 漏網**（簽名留預設參、T4a 只 grep engine）；T8 計數同形漏網
  （A 型重啟重播恰好湊數）。必補四條：usage 旗標、T8 toast 文字斷言、T4b 簽名釘、
  safe() 隔離防 E 型崩潰遮蔽。T8 評述：單條＋單調屬原語意，釘死非過度約束。
### v1.1 響應
- §3.3/3.4 語意定案（降序跳頂＋升序逐條＋不對稱理由）；§5 無痕降級/non-object 防呆/
  restoreBackup 三補登；§6 兩項另單登記；§2 行號修正。
- 腳本：safe() 隔離調用（崩潰只紅該釘）、T4b 簽名釘、T8 文字斷言（末條 50 cards＋低節點
  恰一次重播偵測）、T1 跳頂文案釘、usage 旗標。斷言擴至 23 條。
### R2（#1 複審，v1.1）
- **❌ 缺項 2（皆小案，其餘全閉合）**：發現 A/B 閉合確認 ✅；雙向重跑中（23/23、恰 16 FAIL
  紅集逐字吻合）；手套 v1.1 字面修法 26/26 綠；V1/V1b 逐條補放變體 5-6 紅（v1.0 歧義源已被
  釘死）；**但實測「字面直譯無守衛」版（無 `m.at > lastMsgAt` 條件）→ 非節點 total 遞進
  （5→7）同節點重放轟炸、套裝 26 釘全綠**——§3.3 演算法句殘留最後一處觀察歧義。缺項：
  ①§3.3 補觸發雙條件明文；②harness 補中間帶探針釘（5→7→10：@7 零放、@10 恰一條 10 cards）。
  「補文一句＋釘一條即 ✅」（預授有條件放行，機械核驗性質）。
### v1.2 響應＋核驗
- §3.3 觸發雙條件明文（`total >= m.at && m.at > lastMsgAt`；非節點遞進零放靜默跳標）。
- T9 中間帶探針釘上裝；辨證力實錘：/tmp 無守衛變體恰紅 T9 兩條（@7 got=2 轟炸重放精準
  重現、@10 got=0 跳標吞噬），守衛版全綠。R2#1 兩缺項閉合，依其預授條件放行。
