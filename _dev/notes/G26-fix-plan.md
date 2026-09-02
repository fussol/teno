# G26 修正計畫書 v1.2（R1→v1.1 全採納；R2B→v1.2 補腿 T5w/T5o/S3c/T6e；R3 ✅）

v1.0→v1.1：R1 三委員全 ❌ 有條件，必修全採納（FIX 對照見 §8）。行號 2026-08-28
以 G8 commit 45eedb7 後現檔覆核（v1.0 錨點勘誤見 §8 R1C-F1）。

## 0. 白名單依據
G26-SR1 已放行（scope-requests.md，裁示同 G8-SR1）：病灶檔 `src/pages/simulator.js`。

## 1. Bug 定義（audit 2026-08-13：「simulator.js 手機 viewport——切換模式時舊 render
ref 失效」；根因視窗寬度無關，手機只是高發場景：單臂操作下「点了模擬→立刻切模式/
切頁」最自然。真機 Tauri 實測受環境限制另登 §4）
三病灶同域（render 生命週期），行號現檔實錘：

- **病灶 A（幽靈渲染）**：`renderInPlace`（:729-732）無條件覆寫 `#pageContainer`。
  `renderInPlace(s)` 呼叫點全檔穷举 **15 處**（:302/:307/:322/:327/:366/:371/:382/
  :405/:622/:632/:637/:696/:705/:717/:723），其中 async 完成回調 **6 條鏈**：
  runFrontendSim/Workload/Optimal（simulateFsrs 官方引擎秒級）＋ `run()` CLI 包裝
  （await runCli）＋ `cliReport`（await runCli）＋ `saveParamsToPreset`（await upd）。
  完成期間用戶導航離頁 → 回調把新頁轟成學習分析頁＋onMount 把 handlers 綁上錯頁。
- **病灶 B（模式競態）**：模擬 in-flight 時切模式（mode 鈕 :613-626 清空
  `_simResults/_workloadResult/_optimalRetention`）→ 舊模式結果完成後髒入列新模式
  歷史（pushSimEntry 無驗證）、舊 `_cliOutput` 完成時才讀 `MODE_LABELS[_simMode]`
  貼錯標籤、workload/optimal 裸覆寫單槽。
- **病灶 C（custom-select 轉換遺失，G14 同族）**：`renderInPlace` 只重放 main.js
  三步曲（render→onMount→initCustomSelects，main.js:303-306）的前兩步，
  `#simReviewOrder` 在任何 renderInPlace 後掉回原生肉。

## 2. Root cause
- A/B：async 完成回調無世代/狀態驗證——發起時的頁面/模式與完成時的可能已變。
- C：三步曲漏第三步。

## 3. 修法（src/pages/simulator.js 單檔）
1. **renderInPlace 入口頁面守衛**：
   `if (s?.state?.currentPage && s.state.currentPage !== 'simulator') return;`
   守衛放入口＝15 呼叫點全覆蓋（R1A 論證：若放三函式則 run()/cliReport 漏罩——
   M5 變異形已实证此論證）。store 單寫者、main.js:282 同源讀取。
   語意：**渲染丟棄、資料保留**（結果仍入列/留痕，回頁可見——畫面不该打擾，資料仍對）。
2. **世代計數器守衛**（FIX-5，R1A 糾正 v1.0「token 需 store 配合」誤宣）：
   模組級 `let _simRunGen = 0;`，切模式鈕 `_simRunGen++`；
   `runFrontendSim/Workload/Optimal` 進入捕 `genAtStart`，成功收尾**與 catch**
   均在任何寫入（pushSimEntry/_workloadResult/留痕/render）之前查
   `_simRunGen !== genAtStart → toast('已切換模式，舊模式結果不記錄'); return;`。
   - 計數器非值比對：封 A→B→A 切回原值盲區（R1A 建議採納）。
   - 守衛先於 pushSimEntry 與 addSimRun：模式競態**資料＋留痕整個丟棄**
     （R1C-F4：toast 宣稱「不記錄」必須涵蓋 DB 面）。
3. **addSimRun 改 fire-and-forget**（R1A 建議採納）：原 `await addSimRun` 在
   render/toast 前又開 await 窗口（期間切模式→「#N 完成」誤報窗口）；改
   `import(...).then(...).catch(...)` 置於 render+toast 之後，零 await 尾巴。
4. **renderInPlace 補 initCustomSelects**：import ＋
   `if (typeof initCustomSelects === 'function') initCustomSelects(c);`
   （G14 鏡像 a568a9f 連 typeof 保護一併鏡像，R1C-F5）。

## 4. 驗證方式
`tools/verify-g26-render-lifecycle.mjs` v1.1（已實跑）：
- 注入：simulateFsrs mock 回**雙閘**（resolve/reject 手動放）——確定態 in-flight。
- needle `總時間成本`（唯 renderSimCharts:252 結果區所有）。v1.0 `末天記憶`
  撞 :598 靜態文案＝永真字串（FIX-1，R1A/R1B 雙席實測「修法後 ALL PASS 不可達」）。
- T1 幽靈渲染＋T1d2 導航留痕保留釘；T1e 回頁資料保留。
- T2 模式競態：**狀態面觀察**（放閘後重進頁 renderPage 重渲染數歷史，破 DOM 滯留
  幨破——FIX-3 殺 M7）＋拋棄 toast 正釘（FIX-2 殺 M6 靜默丟棄）＋app-log spy
  零留痕釘（FIX-4 殺「守衛放 addSimRun 後」變體）。
- T3 workload/optimal 同構＋拋棄 toast 正釘。
- T5 catch 路徑（reject 閘）：舊模式報錯不髒入列/不貼標籤/零留痕（殺 M3）。
- T6 正常路徑不傷釘（入列/渲染/toast/留痕 +1，快照化防污染）。
- 靜態釘 S1/S2/S2b/S3/S3b（currentPage 守衛在 renderInPlace 頭、import＋呼叫、
  `_simRunGen` 存在＋三函式皆用）。
- 負控制 --expect-legacy（/tmp/g26nc）：bug 行為 24 腿精確重現 ALL PASS；
  HEAD 跑修法期望模式＝恰 21 FAIL 紅集。
- 手機 viewport 誠實登記：app 依賴 Tauri invoke，純瀏覽器跑不了真殼；jsdom 導航/
  切模式序列與手機事件流同構（viewport 僅決定側欄收合 main.js:357，不入回調鏈）。

## 5. 風險與語意變化誠實登記
- **模式競態＝資料＋留痕整顆丟棄＋拋棄 toast**（原：髒入列）。用戶視角：模擬跑一半
  切模式，該次結果消失並見提示。取捨：髒資料污染歷史曲線且無標記可辨，比無資料壞。
- **導航離頁＝渲染丟棄、資料與留痕保留**（上者語意不同：頁變畫面不宜打擾、資料仍對；
  模式變資料本身錯）。DB 面不对称（導航留痕/切模式不留痕）係上述語意分岔之必然，
  sim_runs 表語意＝「用戶最終會看到的模擬」，切模式丟棄的髒結果本就不該留痕（R1C-F4 裁決）。
- 連點切模式＋多 in-flight → 多顆拋棄 toast 噪音（有界：等於 in-flight 數 ≤ 按鈕連點數）。
- `saveParamsToPreset`（:405 附近）`:399 MODE_LABELS[_simMode]` await 後讀取之標籤競態
  殘留：套用目標 await 前已讀（目標正確），僅輸出標籤可能錯——渲染面受守衛1保護，
  標籤面未修（超出本 bug 資料面範圍，R1A-必修3 登記）。
- 同步呼叫點（切模式/歷史/subgraph/clear）加守衛不誤擋：均在 simulator 頁內點擊，
  currentPage==='simulator' 恆真；唯一邊界＝導航後 ≤1 rAF 幀窗口點擊被擋，該點擊
  本將被 renderPage 覆蓋，無害（R1A 裁定）。
- `getAppPaths().then` 寫 `#cliLogDir` null-safe 既存無害，不動。

## 6. 範圍外（逐名登記）
- 其他頁 async 回調幽靈渲染（同族全庫掃描屬總統另立波次；本檔 async→renderInPlace
  六鏈見 §1，守衛入口全覆蓋）。
- `run()`/`cliReport` 的 `_cliOutput` 新模式標籤面（同病灶 B 輕度同族，無資料入列，
  渲染面已受護）。
- custom-select `_csOpenWraps` 跨 render 殘留（G5 單綁；殭屍 refs 有界自淨）。
- 模擬進行中 spinner/按鈕 disable——新特性。
- 手機真機 Tauri 實測——環境限制，見 §4。
- A→B→A 已由計數器封堵（非範圍外，登記於 §3.2 以防誤讀為值比對）。

## 7. 明示語意取捨
- 拋棄必發 toast（靜默丟更易困惑——驗證 T2e 正釘入法，M6 變異已斃）。
- currentPage 欄比對＋模組級計數器：單檔零成本，store 零改動。

## 8. 審查紀錄
### R1（3 委員，2026-08-28）：全席 ❌ 有條件 → v1.1 全採納
- **R1A ❌（沙箱實證）**：必修1【阻斷】`末天記憶` needle 永真（:598 靜態文案），
  修法後 ALL PASS 物理不可達（沙箱落地三修法後 1 FAIL T2f 實測）→ FIX-1 改
  `總時間成本`；必修2 M3 變異全綠存活（catch 路徑無腿）→ FIX-4 T5 reject 閘腿；
  必修3 §6「async 僅 runFrontend×3」假穷举（實數 6 鏈）→ 採納；必修4 行號勘誤。
  建議採納：A→B→A 計數器（糾正 v1.0『需 store 配合』誤宣）、T4c 快照化、
  addSimRun fire-and-forget、連點 toast 噪音登記。M1/M2/M4/M5 變異實測皆斃。
- **R1B ❌（變異矩陣）**：基線發現同必修1（needle 撞靜態文案，T2e-legacy/T4b 恆綠
  假釘）。矩陣：M1 守衛反向→5 腿斃、M2 漏 guard→T3b/c 斃、M4 捕獲舊值→S1+T1c 斃、
  M8 錯路徑→崩潰+S2b 雙保險；**存活三真缺口**：M3（catch 無守衛）、M6（靜默丟無
  正釘）、M7（守衛放 push 後髒入列，DOM 滯留幨破）→ FIX-2/3/4 補腿 T2e 正釘/
  T2d 狀態面重進頁/T5，補腿已於其沙箱實測「修法基線全綠＋負控制仍全綠＋三存活者精確斃」；
  M5（initCustomSelects 順序對調）判定等價變異體，登記。
- **R1C ❌（誠實/證據）**：執行面零瑕疵（雙跑逐行相符＋nc 逐字節純 HEAD 實錘）；
  事實錯誤三處：F1 §1 :706-709 係 G8 前座標（+23 行漂移，v1.0「45eedb7 後實錘」
  宣稱不實——誠實登記：確為 G8 前讀取）→ 已改 :729-732；F2 ×9 實數 15；F3 async
  穷举漏三鏈；**F4 addSimRun/sim_runs 丟棄語意未定義未釘未登記**→ §3.2 守衛先於
  留痕＋T2h/T5e spy 釘＋§5 DB 不对称理由；F5 typeof 保護鏡像採納。
- v1.0 錯誤誠實登記：行號用 G8 前座標卻宣稱 G8 後覆核（R1C-F1）；「×9」與「async
  僅×3」兩處穷举不實（R1A-3/R1C-F2/F3）。均為文書級，修法本體經三委員沙箱實證
  方向/位置/語意正確。
### R2（2 委員，2026-08-28）：R2A ✅／R2B ❌（存活 N3/N6b）→ v1.2 補腿
- **R2A ✅ 放行**：三態獨立重跑逐數全符（34/34×3＋24/24＋恰 21 FAIL 紅集逐名一致）；
  實施 vs §3 逐條核對零差（守衛入口首條敘述、15 呼叫點全覆蓋、各寫入點親查零漏、
  先於首個寫入）；三攻擊面裁決：(a) `s?.state?.currentPage` 短路——真 app 恆非空
  （store.js:145 初始值＋全寫入點穷举 truthy），falsy 放行＝安全預設；(b) clearLast/
  擠出不 ++ 正確（++ 反誤殺現行模式合法回調，反向論證成立）；(c) saveParamsToPreset
  套用目標 await 前讀取，無資料面漏網，§5「僅標籤面」宣稱屬實。非阻斷登記：
  10ms setTimeout 窗口內導航→預設參數建 request（HEAD 時序相同，非本次引入）。
  commit hygiene 註記：tools/cli.mjs 混有 SR-C4 hunk——G26 commit 反剝不夾帶。
- **R2B ❌（變異 9 體）**：N1a/b/N2/N4/N6a/N7 全斃（N4 由 T2f 負釘恰一腿紅＝精準）、
  N5 等價變異體登記（renderPage 恆寫同節點，快取 ref 等價；全倉無 resize→render 路徑）。
  存活二真缺口：N3（workload/optimal catch 守衛刪除全綠——S3b 包含檢核被 success
  守衛騙過）、N6b（payload 靜默壞欄 only-count spy 全盲）。
### R3（R2B 原席複審，2026-08-28）：✅ 放行
- N3 全變異→S3c 計數釘＋T5w/T5o 三子句雙殺；N3 半變異（只刪 workload catch）→
  S3c＋T5w 紅、T5o 零誤傷；N6b（seed: req.sen typo）→ T6e 獨紅其餘 37 綠。
- 三態復跑：修法 38/38 ×3、HEAD 紅集 23——全符自報。**勘誤一筆（誠實登記）**：
  負控制實為 27 腿非首相自報 26——v1.2 新增 T6e 未包 LEGACY 分支（HEAD payload
  本就含該四欄故 legacy 亦合法綠），沿用 v1.1 舊計屬數字過時非偽綠。
- T6a legacy 期望 2→1 辯護成立（三重證據：HEAD 切模式清空語意既存、HEAD 中
  workload/optimal catch 永不推歷史、T2a 於 HEAD 全綠活體驗證）。
- 最終態：**修法 38/38 ALL PASS ×3｜負控制 27/27 ALL PASS｜HEAD 紅集 23 FAIL**。

