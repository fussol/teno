# F15 計畫書 — open_report file:// 視窗無 CSP + CDN script 無 SRI

狀態：**v1.1（R1 三席全✅，v1.0 凍結稿＋§7 吸收歷程）**
基線：19edaf9 動工前態（審查期 HEAD 落至 F6=8a35026，lib.rs 零漂移 `git diff 19edaf9..HEAD -- lib.rs` 空實錘）
審計來源：bug-audit-2026-08-13.md:118「open_report file:// 視窗無 CSP + CDN script 無 SRI」

## 1. Bug 定義

`open_report`（lib.rs，審計行 79-96 → **實際 77-91**，行號漂移登記）建立
`WebviewUrl::External("file://…/report.html")` 獨立視窗：

- 該視窗**不受** `tauri.conf.json` 的 `app.security.csp` 管轄——config CSP
  只注入 tauri:// 自訂協議回應的主窗內容，External URL（含 file://）內容由
  webview 直接載入，Tauri 不經手（本波無法在白名單內對其施加任何 CSP：
  lib.rs 無 header 注入 API、meta 注入需改 HTML 生產端，見 §3 備選）。
- report.html 由 `tools/cli.mjs` cmdReport 生成（鏡像 `_dev/cli/cli.mjs` 同模板）：
  `<script src="https://cdn.jsdelivr.net/npm/chart.js">` **無 integrity/SRI**＋
  無版本釘（floating latest）＝供應鏈面；且模板含內嵌 `<script>` 資料塊，
  任何「事後注入 meta CSP」都必須 `script-src 'unsafe-inline'` 才不弄壞圖表
  ＝CSP 形同虛設（§3-B 拒因）。

## 2. Root cause（實錘）

| # | 事實 | 證據 |
|---|---|---|
| RC1 | config CSP 覆蓋不到 External file:// 視窗 | tauri.conf.json `security.csp` 僅 script-src 'self'…；lib.rs:84-85 `WebviewUrl::External` 直接載入，繞過協議層 |
| RC2 | 生產端 CDN 無 SRI＋floating 版本 | tools/cli.mjs:2031/:2821、_dev/cli/cli.mjs 鏡像，模板逐字 `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`；內嵌 `<script>` 資料塊（JSON.stringify×15）使注入式 CSP 必帶 unsafe-inline |
| RC3 | **命令零消費者**（本單修法根基） | 全倉穷举 grep `open_report`：僅 lib.rs:78 定義＋:1797 註冊＋docs/notes。src/ 前端零 invoke；CLI/bot 無通道（tauri command 僅 webview 可 invoke）；src/teno-5.1.0 為舊版散件目錄非建置輸入（frontendDist=dist）。Android 面該命令永不可用（HOME env＋file://＋無入口） |

RC3 已由任務書預告（「F16 若結論是刪 dead command…」）——本單把穷举證據前置，
修法與 F16（export_csv_data 死命令殲滅）分軌分 commit，互不重複動刀：
**F15 殲 open_report 全家（fn＋註冊），F16 殲 export_csv_data 全家**，
F16 計畫書引用本單 grep 冊不重刀。

## 3. 修法（白名單內唯一實效路徑）

刪除死面＝攻擊面永久歸零，最強 CSP：

- **lib.rs:76-91**：刪 `open_report` 整個函式（含註解）。
- **lib.rs:1797**：generate_handler 清單刪 `open_report, ` token（43→42 命令）。
- 前端**零改動**（零消費者＝無可壞）。
- report.html 生成功能**不受影響**（CLI `teno report` 照常產檔，使用者用瀏覽器開；
  app 內模擬 UI 用**自製 SVG 繪圖器** `src/lib/chart.js`（檔頭自明 "No external chart
  library; returns an `<svg>` string"，R1#3 實證非第三方庫）渲染，與本命令無關——E11 域實證）。

### 備選項窮舉（憲法⑦）

| 備選 | 內容 | 裁決＋理由 |
|---|---|---|
| A | 私有副本注入 meta CSP 再開 window | ❌ 模板內嵌資料塊 → 必 `script-src 'unsafe-inline'`＝CSP 假牙；SRI 無法經 meta 實現；副本引入 TOCTOU＋髒檔 |
| B | `.on_navigation` 僅允許 file: | ❌ 只治跳逃出逃，不治 CDN 供應鏈＋無 CSP 本體；死命令值不上緩解層 |
| C | asset: 協議＋config CSP | ❌ 需改 tauri.conf.json（白名單外）＋assetProtocol scope；為死命令鋪航道＝倒置 |
| D | 留命令、修 cli.mjs 模板（SRI＋CSP meta＋本地 chart.js） | ❌ Tools/cli.mjs＋_dev/cli 皆他軌髒檔（SR-C4 在製）；且 RC3 死面不該養 |
| E（採納） | 刪除命令＋生產端登記 SR | ✅ 死面歸零、白名單內完成、生產端改善另單不阻塞 |
| F | `initialization_script` 注入 meta CSP（R1#3 源碼補列） | ❌ tauri-2.11.3/wry-0.55.1 一手實證：wry android/mod.rs:271-277 僅自訂協議兜底；動態插入 meta CSP 屬解析期語意對已承載資源約束不可靠；內嵌執行碼塊仍逼 unsafe-inline（同 A 死因） |
| G | `on_web_resource_request` 改 header（R1#3 源碼補列） | ❌ webview_window.rs:201-204 源碼自明「only implemented for tauri URI protocol／not executed for external URLs」；builder 全檔 header 僅存在於 doc comment，無設定 API |

## 4. 驗證方式

`tools/verify-f15-report-surface.mjs`（送審前實跑，含負控制）：

- T1 靜態殲滅釘（HEAD lib.rs）：`open_report` token 全檔零（含註解字串——防
  「註解掉留屍」）；`WebviewWindowBuilder`/`WebviewUrl`/`file://` 於 lib.rs 零
  （open_report 是 lib.rs 唯一 window 構造者，刪後應乾淨）；generate_handler
  命令計數 43→42 且清單無 open_report、其餘 42 命令逐一在位釘（防順手誤刪）。
- T2 負控制（判別性雙臂）：`git show 19edaf9:src-tauri/src/lib.rs` 舊 blob 餵
  同一掃描器 → 徵狀全響（open_report 在、builder 在、註冊 token 在）＝腳本有牙。
  （S-4 註：T2d 判別性釘於**動工前**恆紅——新態＝舊態時「归零量」等式必不成立，
  屬雙態腳本設計語意，非負控制失效。）
- T3 消費者恆常釘：`grep invoke('open_report')` src/ 計數 0（若未來有人給已刪
  命令接 invoke 而沒接回命令，此釘＋cargo 不會紅、本釘紅＝告警面）。
- T4 編譯閘：cargo check host＋aarch64-linux-android（產品矩陣雙 target；
  PATH 需含 ~/.cargo/bin——環境假紅先復測再歸因，F14 判例）＋cargo test --lib
  計數下限釘（42 tests 不縮水）。
- 回歸：verify-f14 38/38、verify-d16 32/32、verify-d17 32/32、npm build。

## 5. 風險

- 若使用者依賴「app 內一鍵開報告窗」＝功能回退？——該路徑从未存在（前端零
  呼叫者，RC3）；CLI 產檔＋瀏覽器路線零變動。
- 删註冊行誤傷相鄰命令 → T1 逐一在位釘×42 封堵。
- 未來有人重引 window 功能 → 彼單自帶 CSP 設計（asset 協議＋config），本單
  T1 釘使「順手把舊 open_report 解註解」直接紅。

## 6. 範圍外清單（憲法⑥）

- **F15-SR1**（R1#3 M-2 精確化，承接者可直接動工）：CDN 無 SRI 模板共 **4 實例**
  ——tools/cli.mjs:2031（cmdCompare 模板）、:2821（cmdReport 模板）、
  _dev/cli/cli.mjs:1804、:2590（鏡像）。修法要點：
  ① chart.js 釘版本＋integrity/SRI 或改本地資產（消floating 供應鏈面）；
  ② 本計畫 §3-B 拒因僅適用於**事後注入式** meta CSP；模板系生成器，**生成期可
    計算內嵌 script 塊 sha256 寫入 `<meta>` CSP（CSP3 准 hash、禁 nonce）＝真解路徑**；
  ③ 加固註：現行模板嵌入面零字串型使用者資料（R1#3 逐變數溯源實錘：labels＝
    檔名 parseInt 純數字、series 全純數字、ivlDist.g＝SQL CASE 五枚舉、date＝
    `[\d-]+` 捕獲組），但 JSON.stringify 不逃 `<`，**日後任何新增字串欄位必以
    `\u003c` 轉義**；④ 兩鏡像同步（tools＋_dev/cli）。
  SR 行於動工 commit 時追加 `_dev/notes/scope-requests.md` 落檔；共享檔髒（他軌
  未領条目）不夾帶入 commit（F12/F14 先例，總統集中收）。
- F16（export_csv_data 殲滅＋JS wrapper exportCsvData 刪除——後者 src/lib/api.js
  ＋src/pages/export.js 白名單外，F16 另登 SR）。**S-2 註**：F16 刪 export_csv_data
  時須同步 tools/verify-f15-report-surface.mjs `EXPECTED_CMDS`（42→41），否則
  verify-f15 T1g 於 F16 落地後回歸自爆紅。
- `src/teno-5.1.0/`＋`src/teno-5.1.0.tar.gz` 舊版散件混在 src/（R1#1 實錘兩者皆
  gitignore 未入庫、非建置輸入，宜清出工作區）——呈總統。
- tauri.conf csp 政策本身——本單後 lib.rs 已無 window 構造點，議題自然消失。

## 7. 版本紀錄

- v1.0：送審凍結（憲法⑤）。
- v1.1（R1 吸收，三席全✅ 2026-08-29）：M-1 升版行（下）＋M-2 F15-SR1 精確化；
  建議項全採——S-1 備選 F/G（initialization_script／on_web_resource_request 源碼
  封死後世翻案）、S-2 F16 同步釘註、S-3 本地 chart.js 實為自製 SVG 繪圖器措辭
  勘誤、S-4 T2d 雙態語意註（§4）；席次2 建議① T3 目錄存在性釘當輪吸收。
  **M-1**：fix commit 依版本新法（b09a3a1 機械閘）跑 `./tools/version.sh patch`
  三檔齊升（比照 F14=5.2.6／F6=5.2.7 先例 → 本單 5.2.8）。
