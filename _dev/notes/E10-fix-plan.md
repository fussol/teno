# E10 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.1＝R1 過審）

## 1. Bug 定義（行號實錘 2026-08-28：cmdSelfTest §4 cli.mjs:2329）
```js
check('容器 拒絕非SQLite', unpackContainer(Buffer.from('GARBAGE')).teno.length === 7 || true, ...);
```
`|| true` 使斷言**恆真**——前面的 `=== 7` 純裝飾。此檢查項永遠 ✅，即使
unpackContainer 的 fallback 行為整個壞掉（只要不拋例外）。E8 同函式退役後
selftest 僅存/container 三條檢查，這條是其中之一——哨兵本身失明。

## 2. Root cause ＋ 語意定案
斷言意圖（「拒絕非SQLite」）與現實設計（**CLI 端容錯**：非 TENOC 頭 →
`{ teno: 整檔原樣, log: null }` raw fallback）不符；當時作者發現斷言會紅，
用 `|| true` 強行湊綠而非改語意。D19 已定案：嚴格拒絕由 cmdImportDb magic
守門分層負責，CLI 端 unpack 保容錯是**正確契約**——故正確修法＝斷言改寫成
真實契約（連帶標籤誠實化），而非把守門搬進來。

## 3. 修法（tools/cli.mjs cmdSelfTest §4，原一行 → 五兩條，~5 行）
```js
const g = unpackContainer(Buffer.from('GARBAGE'));
check('容器 非SQLite raw fallback', g.teno.length === 7 && g.teno.toString('latin1') === 'GARBAGE' && g.log === null, '(CLI 端容錯, 嚴格攔截=D19 magic 守門)');
const t = unpackContainer(Buffer.concat([Buffer.from('TENOC'), Buffer.from([1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(9999); return b; })()]));
check('容器 截斷頭 raw fallback', t.teno.length === 10 && t.log === null, '(頭宣稱 9999B 實僅 10B)');
```
- 凍結字面量：`容器 非SQLite raw fallback`、`容器 截斷頭 raw fallback`。
- 標籤誠實化：「拒絕非SQLite」→「非SQLite raw fallback」（斷言什麼就叫什麼）。
- 加測截斷頭態（`data.length < pos + l1` 分支——同一容錯契約第二條路徑，
  現行 selftest 零覆蓋；零額外風險順補，屬同一檢查項家族非擴編）。
- 可選項（憲法⑦）：把 magic 守門語意也加進 selftest？**不做**——守門在
  cmdImportDb（selftest 不跑 import 寫入路徑，測它需真 DB 副本＋import 鏈，
  超出 selftest 唯讀定位）；verify-d19 T3-T6 已釘其行為。

## 4. 驗證方式（tools/verify-e10-selftest-container.mjs，全 tmp DB）
- T1 真碼 selftest（TENO_DB tmp）→ 兩條新檢查 ✅＋失敗數 0＋無 `|| true` 殘留。
- T2 源碼釘：`|| true` 在容器檢查段零出現；兩凍結字面量在位。
- T3 負控制牙檢（核心）：
  - (a) HEAD 弱斷言版（反換回 `=== 7 || true`）＋**變異 unpackContainer**
    （非 TENOC 回傳錯誤形狀 `{teno: data.subarray(0,3), log: data}`）→
    selftest 仍全綠＝E10 失明災情精準重現；
  - (b) 修法版＋同一變異 → 對應檢查必紅＝真斷言有牙。
- T4 契約源碼釘：unpackContainer 非 TENOC 分支仍 raw fallback（確保修法方向
  ＝斷言遷就契約，不是契約遷就斷言）。

## 5. 風險
- 僅動 selftest 顯示層（零產品寫入路徑觸及）。
- 之前依赖「selftest 全綠」的腳本（E8 時代已查：無自動化消費者，僅人手
  操作＋備份 bot 診斷）行為不變——除非 selftest 真的該紅（這是目的）。

## 6. 範圍外清單（憲法⑥）
- selftest 其余檢查項的覆蓋率審查（另案）。
- cmdRestore/cmdBackups/cmdDrive magic 面（D19 §6 既登另單）。
- selftest 失敗時 exit code（同 exit code 系統化另單）。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席）
- ✅ **APPROVE**。diff 與 §3 逐句一致；驗證 9/9 屬實重跑；真碼 selftest 12/0。
- 攻擊：(a) 斷言偏寬非過貼（length===7 為內容釘冗餘子集，nit）；(b) 兩條確為
  獨立分支（magic≠TENOC vs 截斷），宣稱誠實；次條件 `length<6` 無專屬測資
  （nit，另單 2B 測資即補）；(c) **同類掃描零殘留**——全檔 `|| true` 僅存
  註解文字；selftest 12 條逐檢，`check('寫入 [TEST]…', true)` 為 try 內
  「未拋即真」有 catch 兜底非 E10 同型；(d) T3a 切點錯位假綠通道封閉
  （replace('') 路徑 T3a 必紅＋mutate 計數 throw＋failCnt -1 哨兵三閘）。
- 委員自選變異 4 體：雙條互不掩護各自有牙（僅變分支#1→非SQLite 條紅、
  僅變#2→截斷條紅、log 誤掛→log===null 子句獨立製牙）。
- 誠實性：§2 湊綠推測有代碼實錘支撐未過頭；§5 零自動化消費者 grep 佐證
  （僅 verify-e8 一次性＋歸檔）。
- Nit×2 登記不擋：length 冗餘子句保留（防禦可讀）；length<6 次條件測資另單。
  既有旁支（非本案）：round-trip log 條 ok 值可能為 Buffer 非布林。
- 結論：**R1 全席 ✅ 過審**（單席制），動工 commit。
