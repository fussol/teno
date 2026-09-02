# E14 修復計畫書 v1.1（2026-08-28，首相2／PM2 域）

## 1. Bug 定義（行號實錘 2026-08-28）
`db.prepare("SELECT value FROM settings WHERE key='X'").get().value` 無可選鏈，
`get()` 對**不存在的列**回 `undefined` → 讀 `.value` 即 `TypeError: Cannot read
properties of undefined (reading 'value')`，被 runCli 頂層 catch 打成
`命令 theme 失敗: ...` 難懂堆疊＋exit 0 吞錯。全新 DB（settings 表存在但
對應 key 未寫過）必踩。佇列列 9 站點全數實錘：
- cmdTheme：:821 themeMode、:828 themeAccent、:838 themeAccentIntensity、:847 colorPalette
- cmdTts：:868 ttsSpeed、:873 ttsVoice、:882 ttsPitch、:887 ttsEngine
- cmdDay：:924 dayCutoff——**加倍**：:925 把 cur 直接吞進 `Math.floor(cur/60)`
  ＋ `cur%60` 運算，即使 ?. 修掉崩潰，undefined 也會輸出
  `dayCutoff = undefined 分鐘 (NaN:NaN 為日界線)` 垃圾行。

同檔正面教材兩處（零改動，作對齊模板）：
- cmdTtsPlay :903-906 `get()` 存成變數再 `speed ? parseFloat(speed.value) : 0.9`
- cmdAnkiGet :961-962 `if (!r) return console.log('無 ${key}')`

全檔 `.get().value`（無 ?./解構）模式 grep 窮舉＝恰上述 9 站點，無漏網
（其餘 `.get()` 讀點已自帶守門或回物件整體 null-safe 消費）。

## 2. Root cause
node:sqlite `StatementSync.get()` 無列回 `undefined`（非 null、非 throw）；
当年寫 display 回顯時預設「寫過才讀」，未考慮 read-before-write 路徑
（`theme mode` 無參 pure-get 在新 DB 是合法用法）。

## 3. 修法（tools/cli.mjs 單檔）
1) 新增單行 helper（放 writeSetting 旁，:1181 後）：
```js
// E14: settings 讀回顯統一——get() 無列回 undefined，純 ?..value 會輸出
// 『X = undefined』垃圾行且 cmdDay 還吞進運算；回 null 讓顯示層分支誠實標『未設定』。
const readSettingRaw = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
```
2) 9 站點 `const cur = readSettingRaw('X');`＋回顯
`console.log(\`X = ${cur ?? '未設定'}\`)`。log('READ') 行同步吃 cur。
3) cmdDay 獨支（唯一吃進運算者）：
```js
if (cur === null) {
  console.log('dayCutoff = 未設定（app 預設 0 → 0:00 為日界線，store.js:406）');
} else {
  console.log(`dayCutoff = ${cur} 分鐘 (${Math.floor(cur/60)}:${String(cur%60).padStart(2,'0')} 為日界線)`);
}
```
（0=0:00 宣稱出處 store.js:127 `dayCutoff: 0` 初始＋:406 typeof 非 number→0，
非 CLI 自創預設；寫入路徑（writeSetting 後讀）列必存在，行為零變化。）
- 可選項（憲法⑦定案）：(a) 8 站點回顯直接顯示 app 端 defaults（0.9/50/
  en_US-ryan-high…）？**不做**——五個預設值拷進 CLI＝第二真值源，store.js
  改 defaults 即漂移（E11 硬編碼 4868 同課）。誠實標『未設定』。
  (b) exit code 對 pure-get 未設保持 0？**是**——讀未設非錯誤，app 端有預設值。

## 4. 驗證方式（tools/verify-e14-settings-get.mjs，全 tmp）
- 測資：tmp DB 僅 `CREATE TABLE settings(...)` **零列**（全新 DB 語境）。
- T1 九站點 pure-get 全活：`theme mode/accent/intensity/palette`、
  `tts speed/voice/pitch/engine`、`day` → 各自 exit 0、stdout 含對應
  `X = 未設定`、**零** `TypeError`／`命令 .* 失敗` 字樣。
- T2 day 垃圾行殲滅：stdout 零 `NaN:NaN`、零 `undefined 分鐘`；含
  `0:00 為日界線` 註記。
- T3 寫後讀回歸（既有行為零變化釘）：`day 300`→`300 分鐘 (5:00`；
  `theme mode dark`→`themeMode = dark`；`tts speed 1.5`→`ttsSpeed = 1.5`。
- T4 log('READ') 行同步（tmp TENO_LOG 含 `theme mode = 未設定`）。
- T5 負控制：`readSettingRaw` 反換回 `.get().value`（原版語義）→ 九站點
  TypeError 重現＋day 垃圾行重現（反換前後檔不等釘）。
- T6 結構釘：全檔 `.get().value`（無 ?.) 殲滅正則零命中＋helper 定義恰 1。

## 5. 風險
- pure-get 輸出從 crash 變 `未設定`——行為變化＝修復本身，如實登記。
- helper 用 db（唯讀 prepare 常駐連線），writeSetting 用 dbw()（新連線寫）
  ——與現行 9 站點讀寫連線模式逐字相同，零新連線语义。

## 6. 範圍外清單（憲法⑥）
- 顯示 app defaults 數值（§3(a) 定案不做）。
- cmdGoal/cmdStreak 的 goal_streak 缺列顯示『每日目標: undefined...』（:942
  已是 g?. NullSafe，僅顯示 undefined 字樣）——非 E14 佇列（不崩潰），順帶掃描登記另案。
- CLI exit code 系統化（既登另案）。
- 純 get 未設時建議下一步指令的 UX 提示——表面，另案。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席，delegate leaf 唯讀，計畫階段審查）
- 裁決 ✅（0 阻斷／3 次要／3 nit，全數吸收後動工）。
- 義務 1 獨立重現 ✅：tmp DB 九命令原版全 crash（堆疊精確落在 :821-:924
  九站點）；攻擊向量（theme/tts 無 sub、day abc、theme mode badval 等）
  皆走 isNaN/help 分支不觸碰崩潰行，修法後行為不變且合理。
- 義務 2 窮舉覆核 ✅：`.get().value` 恰 9 命中無漏網；「不在範圍」站點逐一
  開檔覆核正確（:568/:587/:1188/:961/:976/:1147/:148/:30/:33/:665/:1577
  各有守門）；cmdGoal 顯示 undefined 字樣不崩→§6 另案合理。
- 義務 3 語意 ✅：連線模式宣稱屬實（頂層 db readOnly 現行即是，helper 逐字
  相同）；`'' ?? null=''`「存在但空」與「未寫過」正確區分；TDZ 安全
  （函式皆 runCli 後呼叫）；寫後讀九站零行為變化親測。
- 義務 4 store.js 宣稱 ✅：:127 初始 0＋:406 降級守門屬實，getToday
  （scheduler.js:52）0=0:00 語意成立；day 邊界 0/300/1439 輸出正確。
- 義務 5 驗證設計牙檢 ✅＋M1/M2 處方（下）；T5 helper-本體單行反換可行性
  委員原型實證。
- **M1（採納）**：T3 擴至全九站寫後讀＋day 0/1439/-5/1500 邊界（委員代跑
  清單固化）→ 實裝 T3 全九站＋四邊界。
- **M2（採納）**：T5 明文 helper-本體反換＋呼叫點零殘留釘 → 實裝 T5a
  （崩潰重現 9/9 計數釘）＋T6a 殘留正則＋T6c 呼叫點恰 9。
- **M3（採納，登記不擋）**：DB 中 value=NULL 列與 key 不存在合併顯示『未設定』
  ——正常寫入路徑必帶字串，實務不可達；NULL 語意≈未寫，誠實性可接受。
- **N1（採納）**：day null 分支訊息去除 `store.js:406` 行號（防漂移），改
  「app 預設 0 → 0:00 為日界線」＋源碼註解記出處不記行號。
- N2/N3：exit code 系統化既登另案；正面教材引用屬實。
- 版本：v1.0→v1.1 補 §6b/§7（動工按 R1 處方實施）。

## 6b. 驗證紀錄（落地實跑，法律④）
- `node tools/verify-e14-settings-get.mjs` → 41/41 ALL PASS ×2 連跑
  （2026-08-28，本首相實跑；T5a＝helper 反換九站崩潰 9/9 重現計數釘）。
- 動工前原版重現：tmp DB（settings 表零列）九命令全
  「ERROR | X 失敗: Cannot read properties of undefined」＋exit 0 吞錯
  （首相＋R1 委員各自獨立重現一致）。
- 誠實登記：首版 helper 註解文字含 `.get().value` token 令 T6a 殘留掃描
  誤咬 1 命中——改寫註解避字面量（E8 同課），產品語意零改。
- M3 登記：value=NULL 列顯示『未設定』（與 key 不存在合併，實務不可達態）。
