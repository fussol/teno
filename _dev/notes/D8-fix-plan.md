# D8 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.0 送審 R1 後升版，§7 審查紀錄）

## 1. Bug 定義（佇列三項全部實錘，另有連帶兩項）
CLI `export-csv`/`import-csv`（tools/cli.mjs:1165-1209，行號實錘）與 app 端
CSV 合同（`src/core/import.js` `buildCSV` :229 header 15 列
`word,definition,pos,pron,example,deck,image,description,tags,related,forms,
synonym,antonym,derivative,examples`）脫節：

1. **7 欄 SELECT → 8 欄丟光**：export 只 SELECT 7 欄 → `image,description,related,forms,
   synonym,antonym,derivative,examples` 8 欄 round-trip 丟光（import 端
   INSERT 全部填 ''/'[]'，:1202）。
2. **pos/pron header 不一致**：合同 header 用 `pos,pron`；CLI export 寫
   `part_of_speech,pronunciation`、CLI import 以 header 原文直索引
   （`obj[h]`，:1193）→ **app 匯出的 CSV 用 CLI import 時 pos/pron 兩欄丟光**
   （obj.part_of_speech undefined→''）。app import 端有 FIELD_MAP 正規化
   （part_of_speech→pos 亦認識）故只壞 CLI 單向。
3. **tags 雙重序列化**：DB `tags` 存 JSON 字串（如 `["a","b"]`）→ export
   原樣輸出 → import `.split(',')` 得 `["a"` 與 `"b"]`（帶括號引號）再
   `JSON.stringify` → 入庫 `["[\"a\"","\"b\"]"]`，tags 永久損壞。
4. （連帶）import 以 `wd`（lowercase）入庫，word 大小寫丟失。
5. （連帶）CLI `parseCsvLine` 逐行解析，quoted 欄含換行即斷行（合同
   `tokenizeCSV` 支援多行）。

## 2. Root cause
CSV 合同在 app 端 `src/core/import.js`（純模組，無 DOM/DB）單一真值源演化
（buildCSV/parseCSVTable/resolveField 全 export 在場；FIELD_MAP 模組私有、經
resolveField 間接使用——R1#1 更正），CLI 早期
自寫平行實作（7 欄＋header 原文索引＋手工 split-tags），未隨合同同步。

## 3. 修法（tools/cli.mjs 單檔；重用單一真值源，消平行實作）
1. 頂層 import：`import { buildCSV, parseCSVTable, resolveField } from '../src/core/import.js';`
2. `cmdExportCsv` 整函式重寫：SELECT 全 15 欄（行序 `ORDER BY word` BINARY 保留）
   → camelCase 鍵映射（pos←part_of_speech、pron←pronunciation）＋ JSON 欄（tags/related/forms/
   examples）一律 `JSON.parse` 成陣本體（parse 失敗原字串直傳，buildCSV 對非陣列原樣
   escape）→ `writeFileSync(out, buildCSV(mapped))` 輸出
   （15 列合同，與 app 匯出逐字同構）。
   **字節合同凍結（R1#3 mutD 補洞）**：產檔字節必須＝`buildCSV(canonical 映射陣列)`，
   即非 canonical JSON（空格/鍵序）入檔前必經 parse→buildCSV 內 rebuild stringify
   正規化；驗證以腳本端 buildCSV 參考值全檔字節比對（T1e，容忍結尾換行）。
3. `cmdImportCsv` 整函式重寫：`parseCSVTable(text)`（多行安全＋BOM 由
   resolveField trim/lower 自然容忍）→ `header.map(resolveField)` 正規化
   （pos/pron/part_of_speech/pronunciation/中文頭全認識）→ 同檔重複跳過邏輯
   保留（lower 比對）→ **陣列欄 fallback 逐欄三規格（R1#2，鏡像 mapWords）**：
   - tags：`JSON.parse` 失敗→ `split(',').map(trim).filter(Boolean)`（import.js:191）
   - examples：`JSON.parse` 失敗→ `split(';').map(e => ({en:e.trim(), zh:''}))`（:193）
   - related/forms：`JSON.parse` 後必查 `Array.isArray`，非陣列才 `split(',').map(trim).filter(Boolean)`（:196-199）
   入庫一律 canonical `JSON.stringify`（無多餘空格）→ word 入庫保留原文大小寫
   （去重比較才 lower）。
4. 刪除 CLI 本地 `parseCsvLine`（消費者穷举：僅 import-csv :1191 一處）。
5. **保留條款（R1#2 條件；驗證跑 TENO_NO_BACKUP=1 測不到漏呼叫，以源碼釘 T6 補防）**：
   重寫後 `cmdImportCsv` 必須保留 `backupDb()` 呼叫與 `audit('import-csv', …)` 記錄；
   三條 stdout/日誌字串逐字保留：`已匯出 ${n} 筆 → ${out}`、
   `log('WRITE', …新增…, 跳過…)`、`匯入完成: 新增 ${n}, 跳過重複 ${m}`
   （下游盤點：bot 零 import/export 呼叫點、cron 零——R1#2 實查）。

### 可選項定案（憲法⑦）
- 復用 `mapWords`：不做。它產 store camelCase shape＋defaults 注入，CLI 需
  DB snake_case 直入，中間多一層轉譯反而糊化語意；採 parseCSVTable＋resolveField。
- export 加 BOM（app 下載路徑加 \uFEFF）：不做。CLI 產檔供工具鏈，BOM 反增
  噪；import 側已容忍。
- TSV/Anki 匯入入口：不做（範圍外新增功能）。

## 4. 驗證方式（tools/verify-d8-csv-roundtrip.mjs，tmp DB，嚴禁碰真檔）
- T1 round-trip 主牙：fixture DB（15 欄全填非空，含：引號/逗號/換行於
  definition、中文、tags 多元素、related/forms/examples JSON、image/description）
  → export-csv → 斷言 CSV header＝合同 15 列逐字 → 匯入 tmp 空 DB →
  **逐欄 15×N 全等比對**（JSON 欄以陣列深度 equal，文字欄逐字）＋word 大小寫保留。
- T2 app 格式寬容：**真 buildCSV 產 app.csv**（R1#3 阻斷洞：手刻转义曾非法致
  合同合規實作 T2c 永紅）→ CLI import → pos/pron 落庫正確（修前＝空字串）＋
  T2f/g 裸文字 fallback 三規格釘（tags split(,)、examples split(;) 產 {en,zh}）。
- T3 tags 牙：多元素 tags round-trip 後精準＝`["fruit","red"]`（免換行测資 Cherry）；
  雙序列化指紋負例由 T5c 同測資正向偵測。
- T4 回歸釘：重複 word 跳過計數、無 word 列跳過、空 tags 欄→`[]`。
- T5 負控制：bugsub 副本以舊版三函式本體逐字反換（腳本內嵌 ORIGINAL 塊，
  與 git HEAD byte-identical 經 R1#1/#3 雙席獨立比對實錘）→ 舊 header＋tags
  雙序列化指紋＋8 欄丟＋app-CSV pos/pron 丟光四損壞模式精準重現。
- T6 保留釘（源碼級，R1#2）：D8 區段必含 `backupDb()`、`audit('import-csv'`、
  兩條 stdout 契约字串（修前修後俱綠的恆守釘，防重寫漏呼叫——因驗證域
  TENO_NO_BACKUP=1 行為測不到備份漏呼叫）。
- T1e 字節合同釘（R1#3 mutD）：FIX4 非 canonical JSON 測資（`["b",  "a"]`、
  `[ "x" , "y" ]`、鍵序 `[{"zh","en"}]`）→ export 全檔字節＝腳本端
  `buildCSV(canonical 映射)` 參考值（容忍尾換行）。
- 比對正規化（R1#1 隱性約束轉明示）：T1c JSON 欄先 parse 再 canonical 比較
  （實作者 import 端入庫必須 canonical stringify，本釘同時防兩者漂移）。

## 4.5 修前基線（實測 2026-08-28）
12 PASS / 11 FAIL：待修項（T1a/e/b/c/d、T2a/b/c/g、T3a、T4c）全紅；T5 負控制
5/5 綠；T6 保留釘 4/4 綠（原版在場）；T2f 修前綠屬正當（舊 split 對裸文字
tags 恰好等值，修後轉為 mapWords 一致性回歸釘）。

## 5. 風險
- export 檔格式變更（7→15 欄、header 改 pos/pron）：app import 有 FIELD_MAP
  全兼容；第三方舊 7 欄檔 import 仍可用（resolveField 認識 part_of_speech）。
- core/import.js 現為 app 關鍵路徑，CLI 引用不改动它（零 app 風險）。
- cli.mjs 為 PM2 獨有檔；SR-C4 hunk 反剝既定程序。

## 6. 範圍外清單（憲法⑥）
- 中文/Anki TSV 匯入 CLI 化（新功能）。
- app 端 export.js（它本就正確走 buildCSV）。
- word 大小寫去重語意變更？不動：lower 去重為既存語意，僅入庫值保留大小寫。
- export 檔 BOM。
- **歷史損壞資料盤點（R1#2 補登）**：實 DB（4,884 words，唯讀掃描 2026-08-28）
  tags 雙序列化指紋 0 筆、非法 JSON 0 筆、related/forms/examples 指紋 0、
  大寫 word 0 → 無需遷移。
- **lowercase 寫入端政策分裂（R1#2 補登）**：本修後 CLI import 保留大小寫，但
  cmdAdd（cli.mjs:424）、app mapWords（import.js:195）、mapAnkiRows（:291）仍
  lower 入庫 → 跨源重複僅 lower 去重可比對（scan dupes 既存 lower 語意），
  統一政策另開單。
- **_dev/cli/CLI.md:283 舊 header 文檔勘誤（R1#2 補登）**：禁區檔，解禁後修。

## 7. 審查紀錄
### R1（v1.0，3 委員）
- **#1 ✅**：五 bug 宣稱逐條實錘、修法可行（三函式 export/簽名/鍵映射/BOM/多行
  全獨立實測）、parseCsvLine 消費者唯一、無平行實作殘留、ORIGINAL_BLOCK 與
  工作區僅差尾空行。隨案三修正（採納入 v1.1）：FIELD_MAP 未 export 假陳述更正、
  標題 8 欄統一、T1c canonical 隱性約束轉明示。
- **#2 ✅ 有條件**：下游零依賴實查（bot 只 call backup/dash/backups restore、
  cron 零）、INSERT NOT NULL 全覆蓋、大小寫去重路徑全 lower 不破壞。四條件
  （全採納入 v1.1）：backupDb/audit/stdout 保留條款＋源碼釘 T6、fallback 逐欄
  三規格、字串契约明文、範圍外補三筆。
- **#3 ❌（兩洞，v1.1 全修）**：①阻斷級——手刻 app.csv 转义非法（`"["red"]"`），
  合同合規實作 T2c 永紅 → 改真 buildCSV 產 fixture；②mutD 假綠——非 canonical
  JSON 對稱損壞三牙全瞎 → FIX4 非 canonical 測資＋T1e 字節合同釘＋T1c parse
  正規化。變異矩陣 mutA/B/C/E 腳本擋住 ✅；負控制與 HEAD byte-identical ✅。
- v1.1 變更：§2 FIELD_MAP 措辭、§1 標題、§3.2 字節合同凍結、§3.3 fallback
  三規格、§3.5 保留條款、§4 釘清單（T1e/T2f/g/T6）、§4.5 基線、§6 補三筆。
### R2（v1.1，#3 複審）✅ 可動工
正確版沙箱 23/23 全綠可達；mutD/mutDnl 唯 T1e 紅精準；T6 探針零誤傷；基線
12P/11F 與 §4.5 逐項相符；負控制 byte-identical 再確認。兩非阻斷隨案：
①T2h related 裸文字釘順補（mutG 溜過封堵，補後 24 釘）；②勘誤——§3.5 列
三條字串契约但 T6 僅釘兩條 console（`log('WRITE'` 屬內部日誌無釘，R2 評可接受，
此處登記為準）。
