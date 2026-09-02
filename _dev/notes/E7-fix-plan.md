# E7 計畫書 v1 — study mc/spell 用 base card 評分覆寫 → 污染 flip 卡狀態
（v1 送審凍結；修正在 §修訂紀錄 升版）

## 1. Bug 定義（audit 2026-08-13 E7，行號漂移 → 實錘 2026-08-28）
`tools/cli.mjs` cmdStudy 宣稱支援 `study mc|spell [n]`，但：
- `const cardMap = s.cards`（:3308 註解自曝 "CLI only has base cards map"）——
  queue／評分／存檔全程用 **flip base 卡**。
- 後果 a（污染）：mc/spell 作答直接覆寫 base 卡 due/stability/difficulty/state/
  last_review → flip 排程被 mc 行為打亂（使用者在 CLI 跑一次 study mc，app 的 flip
  到期全亂）。
- 後果 b（丟失）：mc/spell 自己的排程狀態**從未持久化**——存檔 SQL 只寫 base 欄，
  mc_data/spell_data 容器欄不碰。E6 的 log 還把這條髒路徑記進 review_log（mode 標籤
  mc/spell、card_state 取自 base 卡＝記了錯的起點狀態；optimize 消費時 per-mode
  rating 序列與實際該模式穩定度軌跡脫節）。
- 專案權威模型（實錘）：mc/spell 每字卡獨立狀態存於 base 行的 `mc_data`/`spell_data`
  JSON 容器欄：
  - store.js hydrate :312-317 拆入 `state.cardsMc/cardsSpell`；容器卡（reps=0
    state=0 無 lastReview 但有容器資料）有专门語意（:320-322）。
  - store.js rateCard :764-772：`baseCard.mcData = {...newCard}` 後存整行；base
    不存在時建模板（**due:''**、state=0、reps=0）。
  - store.js saveModeCard :181-196：mode data merge 進容器，flip 欄不動。
  - CLI 既有基建：loadState 已讀容器欄（:104,113-114）、`modeCardMap(s,mode)`
    （:124-132）拆 mode 化 card map、cmdWhatif :1772-1773 已用 modeData 讀路徑。
    **唯 cmdStudy 這唯一寫路徑沒接**。

## 2. Root cause
cmdStudy 寫於 per-mode 容器模型之前（或對其不知情），以 base cardMap 一通處理。
`:3308` 註解即墓誌銘。

## 3. 修法（全在 `tools/cli.mjs` cmdStudy，两处手術）
### 3a. 工作卡圖改 mode 化視圖（:3308）
```js
const cardMap = modeCardMap(s, mode);   // flip 時恆等 s.cards（:125 早返回值）
```
其後 queue 建構（due 過濾/preview/buried）、新卡判定（`!cardMap.has`）、評分取卡
（`cardMap.get(item.wid)`）、elapsed（mode 卡 lastReview）、futureCounts（workMap）、
`cardMap.set(newCard)` 全部自動 mode-aware——零額外改動（逐點已核，§4 消費者表）。

### 3b. 存檔段按 mode 分流（:3436-3451）
- flip：現行全量 upsert 循環**原樣**（其 ON CONFLICT 不含 mc_data/spell_data 欄，
  天然不抹容器資料，實錘 :3438-3442 欄清單）。
- mc/spell：只寫容器欄，flip 欄永不觸碰：
```js
const col = mode === 'mc' ? 'mc_data' : 'spell_data';
const stmt = w.prepare(`INSERT INTO cards (word_id, due, state, reps, ${col})
  VALUES (?, '', 0, 0, ?)
  ON CONFLICT(word_id) DO UPDATE SET ${col}=excluded.${col}`);
for (const [wid, card] of cardMap) stmt.run(wid, JSON.stringify(card));
```
  - 容器模板 `due:''`：逐字鏡像 store 模板（:760/:187 due:''）——flip queue 判定
    `new Date('').getTime()`=NaN 非到期、新卡判定 `cardMap.has` 為真 → 容器卡不會
    被 flip study 誤當到期卡（若採 due=datetime('now') 預設則會——此為關鍵細節）。
  - JSON 形狀：camelCase 全卡形（含 due/state/step/lastReview/buried/interval…）＝
    store:769 `{...newCard}` 同形；modeCardMap 拆出→原地 spread 更新→回寫無損。
  - reviews INSERT（E6）位置不變，flip/mc/spell 三分流都走同一 review_log。
- ensureSchema/backupDb 時機不動（E6 段）。

## 4. 連帶消費者核對（憲法②窮舉）
| 消費者 | 影響 | 判定 |
|---|---|---|
| cmdAudit replay | 只 replay flip log（:1681 防線＋E6 T3 實測 mc 行 checked=0） | 不受影響；mc log card_state 自此記 mode 卡真值，優化輸入變乾淨 |
| fsrs-optimize.py | per-mode WHERE；mc/spell 訓練序列自此與該 mode 真實穩定度軌跡一致 | 純改善 |
| cmdWhatif mc/spell | 讀 baseCard.mcData/spellData（:1772） | 自此讀得到 CLI study 的 mc/spell 進度（原本永遠空） |
| app hydrate | 容器欄 JSON 同形同 camelCase；容器卡模板同 due:'' | 兼容（T4 斷言） |
| app undo | CLI 寫的容器欄不在 flip undo 快照还原欄內？ | 範圍外（E6 已登 undo×CLI 交錯既有風險；undo 只还原 flip 欄＋還原 mcData 為快照值——CLI 寫入被 app undo 覆蓋屬 E6 同類既有交錯，不擴充） |
| flip study 存檔 | 全量 upsert 不含容器欄 | 不抹 mc/spell 資料（T3 斷言雙向） |
| cmdFix/cmdStray reset-stray | 掃「flip 無 log 卻有狀態」卡 | mc/spell 不再製造 flip 殭屍卡（bug 消失的副產品） |
| cmdReport/Mature/Dash | 讀 cards/review_log 統計 | mc/spell study 自此不扭曲 flip 卡 stats；log 計數屬預期被看見 |

## 5. 驗證方式（tools/verify-e7-mode-cards.mjs，送審前實跑＋負控制）
- T1 污染封堵：seed base 卡（flip state=2 due=過去）→ study mc 答 Good → **base 行
  flip 欄逐欄不變**（due/stability/difficulty/state/reps/last_review/step 逐欄比對）；
  mc_data 出現完整 mode 卡（state=1、reps=1、JSON camelCase）。
- T2 flip 不受 mc 排程影響：同 T1 後跑 study flip → 該卡仍按**原 flip due** 到期、
  評分用原 flip stability（答完 flip 欄更新、mc_data 欄不動）。
- T3 容器新建＋flip 欄中性：無卡新字 study spell → 新行 due=''（容器模板，鏡像
  store:760）、state=0、reps=0、spell_data 有值；此後 study flip 的 queue **不含**
  該容器卡（due:'' NaN 非到期＋has()=true 非新卡——鏡像 app 容器語意）。
- T4 app 兼容 round-trip：T1 寫的 mc_data JSON.parse 後欄名集 ⊇
  {due,state,stability,difficulty,reps,lapses,step,lastReview,buried,suspended,
  interval,elapsedDays,scheduledDays}（store hydrate 直接 spread 使用）。
- T5 E6 log 起點真值：study mc 對已有 mcData 卡（seed state=2）作答 → log
  card_state=2（mode 卡）且**非** base 卡 state（seed base state=0 對照——修前必記 0）。
- T6 flip 存檔不抹容器：seed 卡帶 mc_data → study flip 答該卡 → mc_data 原值逐字不變。
- T7 audit/optimize 面：T1 情境後跑 `cli audit` → flip replay 0 差異（base 未動 →
  flip log 無新筆，audit 仍綠）；optimize 同款 WHERE mc 計數 +1。
- T8 負控制（bugsub/ 模式）：(a) 还原 `const cardMap = s.cards` → T1 base 污染重現
  （flip 欄被改）＋T5 card_state 記錯；(b) 存檔分流還原成統一 base upsert →
  T1 mc_data 恆 NULL＋T3 due≠'' 重現。
- 回歸：e6 22/22、e5 18/18、e4 24/24、a10/a9/c3（--experimental-test-module-mocks）、
  c5、a3、node --check、vite build。

## 6. 風險
- mc/spell study 的排程結果自此「看不見」（flip 卡不再動）：這正是修復目標；
  想看 mc 進度 → cmdWhatif --mode mc（既有讀路徑）。
- 舊資料（修前被 study mc 污染的 flip 卡）：E7 不回溯修復歷史污染（無法區分
  app flip 評分 vs 舊 CLI mc 覆寫，無稽核資料）——發現個股可用 app 端 reset-card；
  列範圍外（無可靠判別資料）。
- due:'' 容器行在 CLI 其他掃全 cards 的命令（cmdStats/Dash 計數）多一列「0 reps
  卡」：與 app 端容器卡同等存在（app 早已如此渲染），非新形態。
- mc_data 欄 payload 含 interval/buried 等冗余欄：與 store {...newCard} 同形優先
  （兼容 > 精簡），不裁。

## 7. 範圍外清單（憲法⑥）
- 修前歷史污染回溯：無判別資料，不做（§6）。
- study due 錨定 A10／queue 模型／交易包框／undo×CLI 交錯：沿用 E6 §7 登記。
- mc/spell 的 reset-card/fix 子命令容器感知：現行 fix reset-stray 只動 flip 欄，
  如需 mode 卡 reset 另案。
- cmdRate 支援 --mode：另案。

## 修訂紀錄
- **v1.0**：初版送審凍結。
- **v1.1（R1 後）**：三委員全 ✅（一輪過審）。採納：①容器模板補 `stability=0,
  difficulty=5`（#2：原 INSERT 只寫 due/state/reps，S/D 落 DB 預設 2.5/0.0 與 app
  容器行 0/5 值差；T3 斷言同步）；②T8a 負控制改「卡圖＋存檔雙還原」＋seed 改到期
  base 卡＋接受條件改 `dirty===true` 直擊污染主斷言（#3-F：原版靠『新卡不入隊』
  逃生口，未來 due seed 下無任何寫入也算過，污染面沒打到）；③T2 m2 null 守衛
  （#3：變異 A 下 JSON.parse(null) 崩潰中斷後續）。
  如實登記不修：#3-T5 跨午夜秒級窗口（同 E6 T1 既有權衡，同刻位移已最穩）；
  #1-B5 cmdStudy due 錨定 A10 既有分歧（§7 已登記）；CLI 全域 leech 缺失（非 E7、
  非 flip 獨有，另案）。
  R1 附加實錘：#1-B4 app 端 futureCounts（store.js:648→:714）本來就傳 mode 卡圖
  cardsMc → CLI 傳 modeCardMap 兩端同源同構，E6 時的疑慮反轉為證據；#1-A4 CLI 各
  統計路徑 `card.due` 守門齊備，due='' 容器行非 E7 新創（app 向來產生）、無 NaN 面。

## 8. 審查紀錄（R1，3 委員）
- **#1 連帶消費者＋演算法一致性 ✅**：§4 表逐條獨立重核成立（cmdStats/Due/Dash/
  Stray/Fix/Report/Mature 全數有 card.due 或 state 守門）；cmdAudit flip-only WHERE
  實錘；fsrsCtx 權重/currentState/fuzz/futureCounts 四點兩端同構；E6 log 承諾兌現。
- **#2 存檔路徑＋app 相容性 ✅**：容器模板語意/JSON camelCase 雙向/mode 視圖全使用
  點/併發權重/card_state 五面過；唯一發現 S/D 值差 → v1.1 採納補欄。
- **#3 驗證牙檢 ✅**：變異 A–E 五發全紅零假綠（C 變異 ON CONFLICT 碰 flip 欄被逐欄
  比對抓到，無盲區）；F 逃生口發現 → v1.1 採納雙還原測資。
- 修後 e7 20/20、e6 22/22 再全綠；SR-C4 hunk 隔離程序同 E6（commit 前反剝、事後還原）。
