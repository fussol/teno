# E15 修復計畫書 v1.1（2026-08-28，首相2／PM2 域）

## 1. Bug 定義（行號實錘 2026-08-28：loadState cli.mjs:103）
`loadState()` words SELECT 列 12 欄：
`id, word, definition, part_of_speech, deck, tags, synonym, antonym, derivative, related, forms, examples`
app 端真值源 src/lib/db.js:142（store hydrate）列 **17 欄**：
`id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, created_at, related, forms, synonym, antonym, derivative, examples`
→ CLI 缺 **5 欄**（佇列列 4：pronunciation/example/image/description；首相掃描順帶發現 created_at 同缺，實錘覆核佇列描述不完整）。
loadState 宣稱是 CLI 側與 app store.state.words 同構的「狀態真值源」（E6/E7 系列修法都以它為基準），欄位面實際不同構＝偽契約：任何 `s.words` 消費者讀 `.pronunciation/.example/.image/.description` 得**靜默 undefined**，零錯誤回聲——與 E13/E14 同族「無聲髒值」模式。

## 2. Root cause
当年 loadState 手挑「評分用得到的欄」，之後 app 詞卡欄位扩张（發音/例句/圖片/描述）未同步；無 round-trip 契約測試把關。

## 3. 實害面窮舉（2026-08-28 逐消費者開檔覆核）
全部 14 個 loadState() 呼叫點＋healthCheck（fsrs-optimizer.js:322 words 僅建 wordMap 取 id）：
現行消費者只讀 id/word/definition/deck/tags/pos/synonym/…——**今日零實害**。
本修復＝契約對齊除雷（防未來消費者靜默 undefined），非修當下崩潰。誠實登記。

## 4. 修法（tools/cli.mjs 單檔一行）
loadState words SELECT 補齊 5 欄 → 17 欄與 db.js:142 全集逐字對齊：
`SELECT id, word, definition, part_of_speech, pronunciation, example, image, description, deck, tags, synonym, antonym, derivative, related, forms, examples, created_at FROM words`
- 可選項定案（憲法⑦）：
  (a) 補 **ORDER BY created_at**（app :142 有、CLI 無）？**不做**——會改變
      cmdStudy 新卡補位順序/佇列順序＝行為決策，登 §6 另案。
  (b) 改 `SELECT *`？**不做**——显式欄清單是防 DB 加欄後物件形態漂移的既有
      防線（cards SELECT 同風格），維持顯式。
  (c) created_at 算不算範圍？**算**——「17 欄全集對齊」比「只補佇列列名 4 欄」
      更接近 root cause（偽契約消滅需欄集合相等）；一行成本零風險，R1 可否決降回 4 欄。

## 5. 驗證方式（tools/verify-e15-loadstate-cols.mjs，全 tmp）
- 測資：tmp DB words 表全 17 欄 schema（鏡像 :1183 cmdExportCsv 所用全集＋created_at），
  兩筆單字四欄**帶判別值**（pronunciation='/ˈæpəl/'、example='an example sent.'、
  image='a.png'、description='a desc.'、created_at='2026-01-01 00:00:00'）。
- T1 源碼契約釘：loadState words SELECT 欄集合（正規化排序）＝ db.js:142 SELECT
  欄集合（正規化排序）——**雙檔正則擷取比較**，非硬編碼清單，未來單邊加欄即紅。
- T2 行為釘：經公開命令吃到 loadState 的輸出路徑無法直觀帶四欄（零消費者），
  故行為面用 import loadState 不可行（非 export）→ 以 T1 契約釘＋T3 防退化釘為主。
- T3 防退化：`--json` 面無 s.words 透傳（實查），改釘 rate/whatif 回歸不碎
  （既有 e4/e7 verify 覆盖，跑回歸即可，本腳本僅跑 e4 煙霧釘）。
- T4 負控制：SELECT 反換回 12 欄版 → T1 紅（欄集合差 5）精準重現。
- T5 結構釘：pronunciation/example/image/description/created_at 五 token 各在
  loadState 段恰 1 次。

## 6. 範圍外清單（憲法⑥）
- loadState 無 ORDER BY（app 有 ORDER BY created_at）——佇列順序行為決策，另案。
- s.words 消費者改吃四欄的顯示增強（CLI study 背面完整詞卡）——功能非 bug，另案。
- cards SELECT 欄位契約同類釘——現行無缺，必要時另案。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席，delegate leaf 唯讀，計畫階段審查）
- 裁決 ✅（0 阻斷／2 次要／3 nit）。程式化 set diff 獨立覆核：CLI 12 欄⊂
  db 17 欄嚴格子集，缺集恰 5＝首相宣稱逐字吻合。
- 零實害獨立覆核 ✅：實際呼叫點 **13** 個（nit：原宣稱 14 含定義行，已勘誤）；
  src/engine 全目錄五欄 grep=0（Session 只吃 id/deck/word）；healthCheck
  wordMap 僅 .id/.word——「除雷」定性正確。
- created_at 納入 ✅ 准行：git show 0b43e48 實錘 words.created_at 存在於
  **initial commit v1 建表**（任何世代 DB 打不爆）；「欄集合相等才消滅偽契約」
  論證成立，駁回降回 4 欄。
- 不補 ORDER BY ✅ 准行＋正當性補強（nit6）：session-v4.js:91-96 A7 日種子
  Fisher-Yates 對輸入順序敏感且 newSlots 截斷在 shuffle 後——加 ORDER BY 會
  連鎖改變 cmdSim/simulate 日種子可重現輸出，另案清單已併入 sim 可重現性。
- **次要#3（採納）**：同構僅在 SQL 投影層——db.js hydrate 出 camelCase
  （pron/createdAt），loadState 回 raw snake_case 行；補欄後讀 w.pron 仍
  undefined。已在產品碼註解＋T1 命名明文「契約面=SELECT 投影欄集合」。
- **次要#4（採納，驗證生死線）**：T1 補「兩邊 size=17＋段內恰 1 條 SQL」斷言
  （防 extractor 落空空集 set-equal 假綠）＋錨點切段（cli 全檔 30 條
  FROM words 必誤咬）；T4 反換採「12 欄同構」版保證紅因=set 差非抽取失效。
- nit7：_dev/cli 死碼雙胞胎同帶 12 欄（白名單禁碰；T1 錨定 tools/ 不受影響）。
- nit8 既有暴露登記：synonym/antonym/derivative/examples 四欄僅 db.js
  migrate() best-effort 加入（非 lib.rs migrations）——現行 12 欄已依賴，
  本修法未新增暴露。

## 6b. 驗證紀錄（落地實跑，法律④）
- `node tools/verify-e15-loadstate-cols.mjs` → 15/15 ALL PASS ×2 連跑。
- T1 三閘（錨點切段＋size=17＋set 差∅）；T3 行為煙霧＝rate/whatif 全欄
  schema tmp DB 實跑不碎；T4＝17→12 同構反換缺集恰 5 重現。
- 誠實登記（測資自傷×3，產品碼零改）：初跑 8 紅——(1) db.js extractor 在
  toUpperCase() 字串上找小寫 needle（自己踩自己體例）；(2) T5 段含首相自寫
  註解 token 令五補欄計數各變 2（E8 課三度應驗，改只掃 SQL 字面量）；
  (3) T2b 誤對 db.js 找 description migration（實在 lib.rs:1610 ALTER v4，
  委員報告已給正確位置）。修準後三連紅全斃。
