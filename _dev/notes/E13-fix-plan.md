# E13 修復計畫書 v1.1（2026-08-28，首相2／PM2 域）

## 1. Bug 定義（行號實錘 2026-08-28：cmdSimParams cli.mjs:1026）
`s[key] = parseFloat(value);` 零驗證。實測：
`simparams set humanSkipRate garbage` → parseFloat=NaN → `JSON.stringify(NaN)`
序列化成 **null** → **null 直接落盤 settings.simParams**（實測
`{"humanSkipRate":null}`）。下游 store.js:363 `{...DEFAULT_SIM, ...simParams}`
——null 覆蓋預設值（展開不濾 null）→ store.js:488 `?? 0` 把 null 變成 0
（maxReviewsPerDay 語意「0=無上限」還是「不學」取決下游分支——無論哪個都非
使用者本意，且**無任何錯誤回聲**，還回了改寫成功的 JSON）。
次生態：`5abc` → parseFloat 靜默截斷成 5（部分解析）。

## 2. Root cause
parseFloat 是寬鬆解析器（NaN＋部分截斷雙特性），對「寫入持久化設定」場景
零防護。

## 3. 修法（tools/cli.mjs cmdSimParams set 分支，~3 行）
```js
if (!key || value === undefined) return console.log('需: sim set <欄位> <值>');
// E13: 寫入守門——NaN 序列化 null 落盤污染（store 展開覆蓋預設值）；
// '5abc' 部分截斷同堵（Number 全字串語意：'5abc'=NaN、''=0 需另堵 trim 空）
const num = Number(value.trim());
if (value.trim() === '' || !Number.isFinite(num)) { process.exitCode = 1; return console.log(`❌ 值須為有限數字（收到 "${value}"）`); }
```
`s[key] = num;`（原 parseFloat 行 → num）。
- 凍結字面量：`❌ 值須為有限數字`。
- `Number()` 取代 `parseFloat()`：全字串語意（'5abc'→NaN 拒絕；parseFloat
  會静默 5）；''/空白→0 陷阱另用 trim 空檢查堵掉；' 5 '/'+5'/'5e2'/'-1.5' 合法。
- Infinity：'Infinity' → Number=Infinity → isFinite 拒（JSON 無法表示 Infinity
  → stringify 也變 null，同族污染）。
- 拒絕時零副作用（守門在 backupDb/writeSetting 之前）＋exitCode 1。
- 可選項（憲法⑦）：(a) 欄位級範圍校驗（skipRate∈[0,1] 等）？**不做**——
  佇列只列 NaN 蟲，範圍表屬新契約需逐欄位定奪（另案登 §6）；(b) 整數欄位
  （maxReviewsPerDay）拒小數？同上不做；(c) simparams 子命令拼錯靜默當 get？
  表面問題另案。

## 4. 驗證方式（tools/verify-e13-simparams-guard.mjs，全 tmp）
- T1 合法寫入：`set humanSkipRate 0.3` → exit 0＋settings 值 0.3＋備份被呼
  （TENO_NO_BACKUP 未設時——用預設跑檢查 bak 檔存在；跑注：主測試仍 NO_BACKUP）。
- T2 壞態拒（凍結字面量＋exit 1＋settings 零變動＋零備份）：garbage／
  '5abc'（部分截斷態）／''（空串）／'Infinity'／'NaN'。
- T3 合法變體收：'5'／' 5 '／'+5'／'5e2'／'-1.5'／'0'（0 是合法值非 falsy 拒）。
- T4 回歸釘：get（無 sub）輸出 JSON 不變。
- T5 負控制：守門段反換 → garbage 重現 `{"humanSkipRate":null}` 落盤。

## 5. 風險
- '5abc' 從「靜默 5」變拒絕——行為變化如實登記（防污染目的）。
- 0/負數/小數照常收（無範圍契約，見 §3(a)）。

## 6. 範圍外清單（憲法⑥）
- 欄位級範圍/整數校驗表（需逐欄位語意定奪，另案）。
- simparams 未知子命令靜默當 get（表面，另案）。
- store.js null 覆蓋防禦（PM1 域；本修法從源頭堵，store 側屬縱深另議）。
- 其他命令的 parseFloat/parseInt 同族掃描（E13 佇列僅列此點；掃描結果若
  有新發現登案——動工時 grep 順帶記錄）。
  **掃描結果（2026-08-28 動工時實跑）**：全檔 parseFloat/Number 寫入點逐處
  開檔覆核——:834 theme intensity、:864 tts speed、:994 cmdAnkiSet、:2854
  cmdMature 皆有 isNaN 閘（NaN 不落庫）；:994 cmdAnkiSet 收部分截斷（'5abc'
  →5 落庫，NaN 已拒）＝截斷族次要態，登案不順手修；:2520 _diffBins NaN 屬
  E12 波次已裁另案（讀路面非寫入面）。**結論：全庫 NaN 直落 setting 零其他站點。**
  **R1 委員補登（2026-08-28，發現 1 次要級）**：原結論對 *NaN* 精確，但同族
  **Infinity→stringify null 向量在 cmdAnkiSet :994-995 漏網**——`isNaN(Infinity)
  ===false` 過得了該閘，實測 `anki set lapseMult Infinity` → ankiSettings
  `{"lapseMult":null}` exit 0（同 store :355 展開覆蓋機制）。本 commit 不動
  （別站點，憲法⑥），修法建議：`if (isNaN(nv)...)` 改 `if (typeof nv ===
  'number' && !Number.isFinite(nv))`（parseInt 鍵不受影響——parseInt('Infinity')
  =NaN 已被閘）。掃描紀錄補完（R1 nit4）：:834/:864 亦有 '5abc'→5→無聲 clamp
  （clamp 鈍化＋寫入為 TEXT 非 JSON null，次要中之次要，同案收錄）。
  另 R1 nit3：`simparams set` 缺參/非法欄位分支仍 exit 0（既有行為），與
  §3(c) 未知子命令同併「CLI exit code 系統化」既登另案。

## 6b. 驗證紀錄（送審前實跑，法律④）
- `node tools/verify-e13-simparams-guard.mjs` → 26/26 ALL PASS ×2 連跑
  （2026-08-28，本首相實跑）。
- 誠實登記：初跑 T5 雙紅＝負控制 clone 放錯深度（/tmp 平鋪斷了 cli.mjs 對
  ../src/engine/session-v4.js 的相對 import，clone 起動即崩被誤讀成「原版也拒」）
  ——修的是測資擺放（`<tmp>/sub/tools/` ＋ symlink src，同 verify-e9 慣例），
  產品碼零改；重跑 T5a/b 原版徵狀（null 落盤＋5abc 截斷 5）精準重現。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席，delegate leaf 唯讀）
- 裁決 ✅。重跑驗證 26/26 屬實；T2 壞態獨立再 spawn 全核對（含補測
  -Infinity 亦拒）；T5 負控制逐字比對＋換入換出確認有牙。
- 攻修法：edge case 全陣零誤殺（0x10/0b101/0o17/'\t5\n'/-0/.5/5./1e308 收，
  1_000/5,0/5n/1.5.5/1e400/'  ' 拒；-0 落盤 0 無幽靈）；原型污染面封堵
  （valid 白名單先於守門）。
- 攻計畫書：§1 三處 store.js 宣稱親驗屬實；§6 isNaN 閘宣稱屬實；
  **發現 1（次要）：Infinity 向量 cmdAnkiSet :994 漏網**→已補登 §6（見上），
  本 commit 不順手修。
- 行為變化：全庫 `simparams set` 零機械消費者（bot/cron/sh 零命中）；
  simParams 寫入面全庫僅 cli:1032＋store updateSimParams（後者傳原生數字
  不经字串解析，不受影響）。'5abc'→拒絕無下游破壞。
- diff 純度：E13 hunk 僅守門段，backupDb/writeSetting/log/輸出逐字未動。
- nit（記錄不改）：拒絕回聲走 stdout（與本 CLI 全 stdout 風格自洽）；
  缺參分支 exit 0（exit code 系統化既登另案）。
- 版本：v1.0→v1.1 僅動 §6/§7（產品碼零改，依 R1 處方）。
