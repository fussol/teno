# F15-SR1 修復計畫書（v1.0，送審凍結）

## Bug 定義
`tools/cli.mjs` 與 `_dev/cli/cli.mjs` 兩鏡像的 report/compare HTML 模板（4 實例）以
**未釘版 CDN `<script src="https://cdn.jsdelivr.net/npm/chart.js">`** 載入 chart.js，
且內嵌 `<script>` 塊（含 `${JSON.stringify(data)}` 動態資料）無 CSP 保護、字串欄位
`<` 未轉義。供應鏈面：CDN 滾動發佈可載入任意新版 chart.js（無 SRI 指紋保證）；無 CSP
時報告頁可被注入/篡改 inline script。F15 主 bug（open_report 死命令）已結案，本顆＝
其登錄之 SR 供應鏈尾巴（checkpoint F15-SR1）。

## Root cause
模板用靜態字串拼嵌 CDN script tag（無版本/無 integrity）；內嵌 script 內容直接含
`${JSON.stringify(data)}`，data 若含 `<` 會讓 `<script>` 提前終止造成 HTML 注入面；
完全無 CSP directive 限制可執行 script。

## 修法（檔案:實錘行號）
白名單：`tools/cli.mjs`、`_dev/cli/cli.mjs`、`tools/verify-f15-report-surface.mjs`。

實錘現行 4 實例（HEAD a53a13c）：
- `tools/cli.mjs:2032`（cmdCompare CDN）＋內嵌 script 至 `:2069 </script>`
- `tools/cli.mjs:2822`（cmdReport CDN）＋內嵌 script 至 `:2887 </script>`
- `_dev/cli/cli.mjs:1804`（cmdCompare CDN）
- `_dev/cli/cli.mjs:2590`（cmdReport CDN）

修法要點：
1. **新增 `finalizeReportHtml(html)` helper**（兩鏡像各一，放 cmdReport 前共通工具區）：
   - 對內嵌 `<script>...</script>`（無 src 屬性、含資料的塊）內容做 `<`→`\u003c` 轉義
     （防 `</script>` 提前終止内部注入；已實錘內嵌 script 除資料注入外無裸 `<`，全
     塊轉義安全）。
   - 計算轉義後 script 內容有 `createHash('sha256').update(content).digest('base64')`，
     生成 `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-<b64>' https://cdnjs.cloudflare.com; img-src 'self' data:; base-uri 'self'; form-action 'none'">`
     置於 `<head>` 後。CSP3 准 hash（禁 nonce，因報告為靜態檔無動態 nonce 機制）。
   - 把 `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` 替換為釘版
     `<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" integrity="sha512-CQBWl4fJHWbryGE+Pc7UAxWMUMNMWzWxF4SQo9CgkJIN1kx6djDQZjh3Y8SZ1d+6I+1zze6Z7kHXO7q3UyZAWw==" crossorigin="anonymous"></script>`。
   - **為何 cdnjs 而非 jsdelivr**：jsdelivr 對 `.min.js` 會 prepend 動態 minify banner
     （官方明示「Do NOT use SRI with dynamically generated files」），banner 變則 hash
     破；cdnjs 服務原始包檔＋官方公告 SRI hash，我實抓位元組
     `curl cdnjs.../chart.umd.min.js` 驗證 sha512 與官方吻合（`CQBWl4fJHWb...`）。
2. **4 處 CDN tag 統一走 helper**：改 `const html = ...` 後 `writeFileSync(outFile,
   html)` 改為 `writeFileSync(outFile, finalizeReportHtml(html))`。CDN tag 換成釘版
   integrity 版本（template literal 內直接換行字串，helper 亦作兜底 replace）。
3. **`_dev/cli/cli.mjs` 補 `createHash` import**（L6 `createInterface` 後加
   `import { createHash } from 'node:crypto';`，tools 已備 L8）。
4. 兩鏡像同步：template literal 內嵌 script 已實錘逐字一致，helper 與呼叫點亦同步。

## 驗證方式
`tools/verify-f15-report-surface.mjs`：
- 保留 T1–T4（F15 open_report 回歸，18/18）。
- **新增 T5 區段**：
  - T5A 每鏡像 4 例 CDN tag 全部釘版（含 `Chart.js/4.4.1`）＋具 `integrity="sha512-`。
  - T5B 內嵌 script 無裸 `<script ...>` 舊模式；helper 存在且含 `createHash`＋
    `digest('base64')`＋`'sha256-'`＋`\\u003c`。
  - T5C CDN 用 cdnjs（非 jsdelivr 動態），integrity 值算 SHA512 對拍官方。
  - T5D **負控制**：`git show HEAD:tools/cli.mjs` 舊 blob（現仍為裸 CDN）餵同一
    掃描器，T5A/B 必紅（腳本有牙）；新工作區 T5 全綠。
  - T5E 兩鏡像 CDN 字串一致（同步釘）。
  - T5F 端到端：可選跑 `node tools/cli.mjs report --sample` 產出報告檔，grep meta
    CSP 存在＋CDN integrity 存在（網路可達才跑，離線 SKIP 不假綠）。
- 回歸：`node tools/verify-f15-report-surface.mjs`（T1-4 保持 18/18）、
  `node --check`（兩檔改動後）、至少 3 個既有 verify。

## 風險
- CSP hash 若與實際內嵌 script 位元組不符會 block 報告 script（出空白圖表）。故 hash
  一律**生成期**對最終 html 位元組算（data 已展平），不用靜態猜值。
- 轉義 `\u003c` 改變資料字面值，但 JS 字串內 `\u003c` 執行時即還原為 `<`，Chart
  label/資料不變；僅 HTML parser 端不會提前終止。
- cdnjs 依賴性：報告檔需網路載 chart.js，與原 jsdelivr CDN 相同（不改離線語義）。

## 版本歷程
- **v1.0（送審）**：初版修法（cdnd 釘版 SRI＋CSP hash＋\\u003c）。
- **v1.1（R1 審查採納）**：委員 1 三項必改＋兩項建議全吸收——
  1. helper 內嵌 script regex 改 `/<script>([\s\S]*?)<\/script>\s*<\/body>/`（非貪婪＋錨定 `</body>`）：
     避免資料含 `</script>` 時提前截斷（原 `*?` 到第一個 `</script>`，造 HTML 注入逃逸＋報告壞死）。
  2. verify T5-I5 改結構性斷言（無 `</script><img` 逃逸序列＋無裸 `<img onerror=`＋轉義位元組在位，
     非開閉平衡——CDN tag 含 `</script>` 尾使 opens/closes 天生不平）。
  3. T5-G 負控制 pin 固定 `a53a13c`（本顆動工前 HEAD），比照 T2 `OLD_PIN` 模式——原用 `HEAD:`
     commit 後 HEAD 前進會指向修復版而自毀。
  4.（建議）CSP 補 `base-uri 'self'; form-action 'none'`（計畫書承諾一致）。
  5.（建議）移除死碼（statSync、evil 樣本）。
- **v1.2（R2 覆核採納）**：委員覆核抓到 2 新問題，全吸收——
  1. helper regex 改貪婪＋捕獲尾 `/<script>([\s\S]*)<\/script>(\s*<\/body>)/`，並以 `m[2]` 補回
     `</body>`：原非貪婪體「錨定 </body>」實作會吃 `</body>`（重建用 m[0] slice 丟尾）→ 尾端
     壞死；且 `\s*` 零空白讓 `</script></body><img…>` 偽造邊界逃逸。貪婪回溯取最後一組＝真模板尾。
  2. verify T5-I5 補兩種攻擊變體（direct＋偽造邊界）斷言＋尾端 `</body>==1`＋`</script></body></html>`
     （覆核證據：原兩種變體都會逃逸且 verify 測不到）；移除 CDN_NEW_SRC/CDN_NEW_INT 死碼。

## 範圍外（自動進追蹤）
- 其他 CLI 輸出的 HTML（如 fsrs-report、selftest）若有同類 CDN/內嵌 script 未涵蓋
  → 登 scope-requests。（本顆僅 cover checkpoint 指定的 cmdReport/cmdCompare 4 例。）
- CSP `connect-src`/`font-src` 精細化；報告頁無法完全離線渲染（仍需 CDN）屬既有限制。

## 可選項定案
- ✅ cdnjs 釘版（理由：官方 SRI 穩定、防 jsdelivr 動態 banner）。
- ✅ 生成期 hash（非靜態 nonce）：報告為離線靜態檔，CSP3 hash 為唯一可行權威機制。
- ❌ 本地資產化 chart.js：報告檔需自含、隱私/體積權衡，且超出本顆供應鏈範圍（追蹤）。