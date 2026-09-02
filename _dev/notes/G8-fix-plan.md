# G8 修正計畫書 v1.1（R1 三席有條件否決→全採納升版，凍結待 R2）

## 0. 白名單依據（v1.1 事實校正 — R1#2 發現 7）
G8-SR1 已放行（scope-requests.md 2026-08-28）。筆誤實證校正後版本：
- 任務書白名單 `src/lib/simulator.js` 不存在（ls 實錘，lib 下無任何 simulator 檔）。
- **病灶徵狀**（`_simResults`＋`params` 快照）全庫唯 `src/pages/simulator.js` 一份；
  （v1.0 宣稱「全庫 simulator.js 唯 pages 一份」有誤——`src/core/simulator.js` 實在，
  store.js:528 import，C5 域，但無本病灶徵狀，不相干。R1#2 逮獲，誠實校正。）
- 佇列行號錨點（simulator.js:330-335）唯 pages 版吻合；任務書註自明
  「G26 若需動 simulator.js **以外檔** → scope-requests」即 simulator.js 本體屬 PM1 領地。
- scope-requests.md 同段錯誤已一併校正。

## 1. Bug 定義（實錘行號）
- **病灶 A（無上限）**：`:11` `let _simResults = []` 無上限；僅手動 pop（:358-364）
  或切模式（:598）縮減。長 session 線性成長。
- **病灶 B（全詞表快照）**：`:331` entry 含 `params: { ...req }`——req 含 `cards`
  （每詞一筆 :79-90）＋`reviews`（每 log 一筆 :91-95）。每筆 entry ≈ O(詞數＋log 數)。
- **代誌**：`entry.params` 零消費者——R1#1 獨立覆核窮舉屬實（全 src 僅 :331 構造點；
  :335/:344 用活變數 `req`；`_simResults`/`_simSelectedIndex` 模組私有無 export；
  tools/cli.mjs 模擬走獨立 CLI 流不碰前端模組態；Discord bot 零引用）。

## 2. Root cause
快照誤存整個 request（死重，從未消費）＋歷史陣列未設上限。

## 3. 修法（src/pages/simulator.js 單檔）
1. **砍全詞表快照**：`:331` entry 移除 `params: { ...req }`；保留標量 `totalWords`
   ＋新增輕量 `meta: { mode:_simMode, days:req.days, seed:req.seed }`。
   - v1.1 登記（R1#2 發現 1／R1#3 V8）：`totalWords` 與 `meta` 均零消費者——
     `meta` 為「死重即砍」原則之**明示例外**（≤100B 鑑別資訊，且無驗證釘依賴，
     屬純約定的靜態面）；`totalWords` 出於除錯對稱保留。
   - 不做「從歷史重跑」（憲法⑦，同 v1.0）。
2. **歷史上限**：`const SIM_HISTORY_MAX = 20;`＋`function pushSimEntry(entry)`：
   `_simResults.push(entry)` 後 `while (length > SIM_HISTORY_MAX) { shift(); <選態調整> }`。
   成功（:332）／錯誤（:351）條目**雙軌同走** pushSimEntry。
3. **選態索引修正（cap 直接後果）**：
   - pushSimEntry shift 後調 `_simSelectedIndex`：null 保持；`===0`（被擠出）→ null；
     `>0` → 減 1。成功路徑 :333 立即 null 化＝既有語意不動（T9 釘防漂移，R1#3-V7）。
   - **新增（R1#1-C4，REPRO 實錘屬實）**：切模式段（:598）`_simResults = []` 處補
     `_simSelectedIndex = null`——HEAD 既存缺陷：選態＋切模式＋錯誤輪 → :571 讀
     stale 索引 → undefined →「尚無模擬結果」假紅字（HEAD 與 v1.0 基準修法皆中，
     T8/T8L 雙態釘封鎖）。同族失效索引讀取，一行修，納入本案。
   - 歷史鈕 click（:679-683）補邊界守衛 `Number.isInteger(i) && i>=0 &&
     i<_simResults.length` 才採納（T10 釘防漏裝，R1#3-V9）。
4. **錯誤條目同軌**：`:351` catch 改走 pushSimEntry（T5 釘）。

## 4. 驗證方式（tools/verify-g8-simhistory-cap.mjs v1.1）
指紋機制：**僅成功輪**計數（FIX-1，R1#1-C2/#3-D1：v1.0 失敗輪也消耗指紋→T6 帳本
任何實作必紅，屬腳本致命傷，誠實承認未實跑之失）。第 N 成功輪 `memorizedPerDay=[N]`
→「末天記憶」stat＝指紋。錯誤輪拋 boom-sim（紅字條目，不耗指紋）。
掛載面：真實 render＋真實 onMount＋真實 DOM click 全鏈。

- T1 25 成功輪 → 鈕 20＋指紋 25（legacy 態：鈕 25）
- T2 靜態群：a 無 `params:{...req}`；b entry 域無 req 展開/**別名/深拷貝**
  （`params:req`/`Object.assign`/`structuredClone`，FIX-3 殺 V10）；c SIM_HISTORY_MAX；
  d 成功條目 `pushSimEntry(entry)`；e 錯誤條目 `pushSimEntry({error...`；
  f 摳除 pushSimEntry 函式體後**無裸 `_simResults.push(`**（FIX-2，v1.0 T2e
  與 §3.2 自相矛盾——pushSimEntry 本身必須 push——三席同逮，重寫）；
  g 選態 null 化計數 ≥4（宣告/:333/clearLast/切模式）。
- T3 選態跟隨（錯誤擠出路徑——成功輪必 null 化故唯一可觀測面，R1#1 確認設計）：
  選 idx2=S11 → 錯誤輪擠出 S9 → 仍指紋 11。變體牙：V1 無調整/V2 不減 1 → T3b 紅。
- T4 選態跌出：選頭部 S10 → 錯誤輪擠出 → 回退最新（boom 紅字非 S11）。V3 變體紅。
- T5 錯誤條目計入 cap（28 顆红线）。
- T6 clearLast 語意回歸釘（雙態恆綠；v1.0 初稿誤宣 stale 缺陷已被首跑證偽，見 §3.3）。
- T7 切模式清空（既有語意）。
- T8 切模式選態重置釘（FIX-6）＋T8L 負控制辨證腿（HEAD 重現假紅字）。
- T9 成功輪自動顯示最新（FIX-4，殺 :333 漂移 V7——R1 預警最可能手滑點）。
- T10 stale DOM ref 守衛釘（FIX-5，殺 V9）。
- 負控制 --expect-legacy（/tmp/g8nc 範式）：7/7，含 T8L 辨證腿。

## 5. 風險與語意變化誠實登記
- 低風險：單檔、非共享模組；`entry.params` 死碼刪除（零消費者雙席窮舉）。
- 第 21 筆起最舊筆無痕消失（原無限保留）。
- **（R1#2 發現 2）`#N` 計數飽和**：:335/:348 `#${_simResults.length}` 第 21 輪起
  恆 #20——非真實累計序號。取捨：不加 `_simRunSeq` 計數器（新增狀態＝新增面，
  標籤僅觀感非語意載體）；登記為「存活筆數（飽和 20）」語意。
- **（R1#2 發現 3）歷史鈕標籤滑動重排**：`#idx+1` 為位置序非身份序；cap 生效後
  語意由「第 N 次模擬」變「現存歷史由舊至新第 N 筆」。本案接受滑動序（與 :333
  新模擬自來顯示最新＋§7 跳頂取捨同族：歷史面板定位＝視窗而非账本）。
- :566「20 筆」標籤恆 20（cap 直接後果，隨上兩項登記）。
- 選中條目被擠出 → 跳顯示最新（§7）。
- 切模式重置選態（新增）：UI 不可見（切模式本就清空歷史），僅消除 stale 讀窗口。
- 模組態跨頁面進出保留——既存語意不動。

## 6. 範圍外（逐名登記）
- G26（同檔 onMount ref 生命週期）——佇列下一顆。
- **（R1#2 發現 5）** :569 `btn-primary` 恒亮**最新鈕**而非選中鈕——既存怪癖，
  選態跟隨 shift 後更刺眼；屬 G26/UX 域，登此免追討。
- `_reportData`/`_workloadResult` 單筆覆寫型——本就 O(1)。
- reviewLog 全量進記憶體（store 域）。
- 歷史持久化（跨重啟）／per-mode 保留——新特性無授權。
- `src/core/simulator.js`（store.js:528）——同名不同檔無本病灶，不碰。

## 7. 明示語意取捨
- 選中條目恰被 cap 擠出（selected===0）→ null（顯示最新）而非順移 neighboring
  （順移會無預警換圖表條目；跳最新與 :333 既有「新模擬自來顯示最新」一致）。
- cap 丟棄無 toast（歷史鈕本身即能見面）。
- `#N`/標籤登記如 §5，不引入計數器。

## 8. 審查紀錄
### R1（2026-08-28，3 委員，全 ❌ 有條件——設計骨幹全數維持，攔點全在腳本／登記面）
- **#1（修法正確性）❌**：選態算術周延（基準實作全綠）；params 零消費者獨立覆核屬實；
  T3/T4 三變體牙檢全紅鑑別精確。**C1（阻斷）T2e 不可滿足**（pushSimEntry 本身必須
  push，正當實作被自己釘紅）→ 採納 FIX-2（T2f 摳函式體）。**C2（阻斷）T6 帳本算術**
  （simCalls++ 計失敗輪→指紋 31≠26 任何實作必紅）→ 採納 FIX-1。**C3（阻斷）T2 快照
  釘可規避**（params:req 綠燈過）→ 採納 FIX-3。**C4 :598 切模式不重置選態 REPRO 實錘**
  （HEAD 與 v1.0 修法皆中）→ 採納入 §3.3 一行修＋T8/T8L 雙態釘。**C5 #N 飽和**→ §5 登記。
- **#2（消費者窮舉＋語意）❌**：零消費者成立且更廣（模組私有無 export、CLI/bot 零碰）；
  addSimRun 吃活變數不受 cap 影響（實核）；clearLast 連點安全（空陣列守衛在場）；
  c7/c10 回歸綠基準。**發現 2 #N 永停 #20（必須）**→ §5 登記；**發現 3 標籤滑動重排
  （必須）**→ §5 登記；**發現 6 T2e 自相矛盾（必須）**→ FIX-2；**發現 7「唯 pages
  一份」事實錯誤（必須）**→ §0 校正（src/core/simulator.js 實在）。建議項發現 1/4/5
  全採納（§3.1 meta 例外登記／§5 :566 登記／§6 btn-primary 怪癖掛名）。
- **#3（變異牙檢）❌**：V1-V6 六變體全數擊斃（紅集精確）；D1=T6 帳本（鐵證「修法後
  ALL PASS 未實跑」）、D2=T2e 矛盾——**承認：v1.0 腳本從未跑過「修法後」態，僅跑過
  修前紅集＋負控制，誠實登記此失**。**盲區 V7（:333 漂移無牙）/V9（守衛無牙）/
  V10（別名快照過關）**→ 採納 FIX-4/5/3；V8（meta 零依賴）→ 如實登記不補牙（釘死碼
  與砍 params 立論矛盾）。
- 首相裁決：三席攔點零衝突、全數採納；修法骨幹（砍快照＋cap＋雙軌＋選態三分支）
  未經任何反對，不動。升 v1.1 送 R2 複審。
### R2（2026-08-28，2 委員，全 ✅ 放行凍結 v1.1）
- **#1（修復點覆核）✅**：負控制 7/7；HEAD 20 FAIL 全對位（T2g 釘緊 ≥4 多一紅屬預期）；
  /tmp/g8r2 基準實裝 30/30 ALL PASS（零不可滿足釘）；v1.1 登記逐條行號對位；
  T2f helper 脆弱性＝單向 fail-closed（只誤殺偏離處方正當寫法、絕不誤放病灶）可接受。
- **#2（變異矩陣重殺）✅**：V7→T9b＋T2g／V9→T10a/b／V10→T2b 三盲區閉合；V1/V2/V3/V4/V6
  重確認仍斃；新探針 V11a 死碼重置→T8＋T2g、V11b const 遮蔽→T8 動態腿兜死、
  V12 off-by-one→T10、V14 快照回魂→T2a/b 全斃；V13（先騰位後 push）＝語意等價變體登記。
  基準連跑 3/3 零非確定性。殘留登記：T2g 可被遮蔽宣告規避但 T8 兜底（勿拆 T8 留 T2g）。
- 首相裁決：R2 全 ✅ → 動工。實施後 ALL PASS×3＋負控制綠＋回歸 c7/c8/c9/c10/g4b EXIT=0
  ＋build 812ms → commit。誠實登記：修前「修法後 ALL PASS」宣稱曾未實跑（R1#3 D1 逮獲），
  v1.1 起所有 ALL PASS 均為本 session 實際輸出。
