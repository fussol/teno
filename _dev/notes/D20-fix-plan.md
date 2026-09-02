# D20 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.0 送審 R1 後升版，§7 審查紀錄）

## 1. Bug 定義（行號實錘 2026-08-28：cmdDeleteDeck cli.mjs:750-762、cmdRenameDeck :738-748）

佇列描述：「cmdDeleteDeck 留 review_log 孤兒、decks 記錄未刪」。
實測覆核（/tmp/d20lab 真 DDL 沙箱，沙箱觀測面 sqlite3 CLI FK 預設 OFF）：

1. **decks 表記錄未刪＝實錘**：delete-deck Alpha 後 `decks` 仍餘 `Alpha,Beta`。
   GUI deck 清單唯一真值源＝decks 表（db.js getAllDecks:349-352，
   store.js:252 載入）→ **幽靈牌組永久掛在 GUI**（0 單字、旧色、可點入）。
2. **review_log 孤兒＝現行 schema 不复現，但修仍需**：review_log 定義帶
   `REFERENCES words(id) ON DELETE CASCADE`，CLI 連線（node:sqlite DatabaseSync
   `enableForeignKeyConstraints` 預設 true，cli.mjs:50-52 未關）DELETE words
   時級聯刪 log（沙箱實測 orphans=0）。**但級聯是 schema 系不是行為保證**：
   舊 DB（建表早於 FK 定義的 migration 世代）無該約束 → 孤兒直入。顯式刪除
   ＝schema 無關的確定行為（＋與 GUI deleteWordsByDeck db.js:369 顯式刪同軌）。
   驗證以 **legacy schema（無 FK）沙箱**給此條上牙。
3. **同窮病灶（D7「修類不修點」慣例）exam_history 孤兒＝實錘**：delete-deck 後
   apple 2 筆留存。列欄雙世代混存：**B4（e53a3ce，08-15）後寫 word_id、
   B4 前 legacy 存單字文字**（store.js recordExam:1789 `word: r.wordId` 只收
   id；D14 時 M4 實錘的「存文字」是 B4 前 legacy）。GUI 版兩函式各只蓋一族
   （deleteWordsByDeck:370 只刪 id 族、deleteWord:226 只刪 text 族）——
   **db.js 非白名單 → 登 D20-SR1 呈載示**（見 §7）。CLI 修法兩族皆刪。
4. **同窮病灶 cmdRenameDeck**：只 `UPDATE words SET deck=新名`，decks.name 不動
   → GUI 清單仍列旧名（decks 表真值源）、單字掛到 decks 表無對應行的幽靈牌組
   （GUI 不可見＝單字失蹤）。一行 UPDATE 同檔同類，順帶修。
5. deckOrder settings 殘留舊 id：GUI 排序 orderMap 查表自然忽略（store.js:328-330）
   ＝無害；但 merge-deck（:773-777）有清理先例，順帶對齊。
6. folders 表殘留：`state.folders` 全庫零 UI 消費者（store.js:333 寫入後無讀取，
   grep 實錘）＝休眠面 → 範圍外 §6。

## 2. Root cause
CLI deck 生命週期操作直接摸 words/cards 兩表，从不維護 deck 註冊面
（decks 表/deckOrder）與歷史面（review_log/exam_history）；GUI 端同款清理
（deleteDeck + deleteWordsByDeck）从未被 CLI 移植（同 D7 drive_sync 抄漏模式）。

## 3. 修法（tools/cli.mjs 單檔）

### 3.1 cmdDeleteDeck 重寫（:750-762）
```js
backupDb();
const w = dbw();
w.exec('BEGIN');
try {
  const rec = w.prepare('SELECT id FROM decks WHERE name=?').get(deck);
  // exam_history.word 雙世代（B4 後=word_id／B4 前 legacy=單字文字）兩族皆刪
  w.prepare('DELETE FROM exam_history WHERE word IN (SELECT word FROM words WHERE deck=?) OR word IN (SELECT id FROM words WHERE deck=?)').run(deck, deck);
  w.prepare('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck=?)').run(deck);
  w.prepare('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck=?)').run(deck);
  w.prepare('DELETE FROM words WHERE deck=?').run(deck);
  if (rec) {
    w.prepare('DELETE FROM decks WHERE id=?').run(rec.id);
    const order = w.prepare(`SELECT value FROM settings WHERE key='deckOrder'`).get();
    if (order) {
      try {
        const list = JSON.parse(order.value).filter(id => id !== rec.id);
        w.prepare(`INSERT INTO settings (key,value) VALUES ('deckOrder',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(list));
      } catch {}
    }
  }
  w.exec('COMMIT');
} catch (e) {
  try { w.exec('ROLLBACK'); } catch {}
  w.close();
  log('ERROR', `delete-deck: ${e.message}`);
  process.exitCode = 1; return console.log(`❌ 刪除失敗(已回滾): ${e.message}`);
}
w.close();
```
- 順序釘：exam_history 必須在 words 刪前（子查詢依賴 words 在場）；
  review_log 顯式刪在 words 前（FK CASCADE 與顯式刪雙保險，順序無關但同庫單調）。
- 單一事務：部分失敗全回滾（現行無事務＝中途 crash 半個牌組消失）。
  鏡像 GUI deleteWordsByDeck BEGIN/COMMIT/ROLLBACK 結構（db.js:365-378）。
- deck 不在 decks 表（words-only deck）：rec undef → 跳 decks/deckOrder，
  words/cards/log 照刪不 crash。
- deckOrder JSON 壞值：try/catch 跳過清理不擋刪除主路徑。

### 3.2 cmdRenameDeck 補一行（:741-744）
```js
w.prepare('UPDATE words SET deck=? WHERE deck=?').run(to, from);
w.prepare('UPDATE decks SET name=? WHERE name=?').run(to, from);   // D20 同類
```
並補 BEGIN/COMMIT（兩條 UPDATE 原子）。edge 如實登記：目標名已被他 deck 佔用
→ UNIQUE 衝突整個回滾報錯（語意正確：改名不該默認合併，merge-deck 才是該路徑）。

### 可選項定案（憲法⑦）
- **exam_history 兩族刪 vs 只刪 id 族**：兩族。列内確有雙世代（B4 語意遷移
  實錘 git 時間線），只刪一族＝留一半孤兒。代價：跨 deck 同文字碰撞誤刪——
  舊世代資料本無法區別（word 欄無 deck 歸屬），與 D14 同語意取捨，誠實登記 §6。
- **review_log 顯式刪（CASCADE 現行已涵蓋）**：做。schema 無關性＋事務内行數
  可歸因＋與 GUI 顯式刪同軌；零風險。
- **deckOrder 清理**：做（merge-deck 先例對齊，實測無害但留髒值無必要）。
- **folders 清理**：不做（零消費者休眠面，§6）。
- **buried/suspended settings 殘留 word id**：不做——殘留 id 與現存 cards 無交
  集零功能影響，GUI 下次變更整體重寫該鍵（§6）。
- **process.exitCode=1 於回滾路徑**：做（D19 先例，失敗如實回報；消費者零
  exit-code 解析盤點同 D19 R1#1 結論援用）。

## 4. 驗證方式（tools/verify-d20-delete-deck.mjs，全 tmp DB，嚴禁碰真檔）
- T1 主鏈（現行 schema）：雙 deck+雙世代 exam+log 測資 → delete-deck Alpha --yes：
  Alpha words/cards/review_log/exam(兩族)/decks 行全零；Beta 對照組逐項原封。
- T2 legacy schema 牙（無 FK 約束建 review_log）：修後顯式刪仍零孤兒（級聯
  不可依賴實錘；此為佇列「review_log 孤兒」條目的真牙）。
- T3 deckOrder：seed [dA,dB] → 修後 ["dB"]。
- T4 exam 雙世代：id 族＋文字族皆刪；對照 deck 不同文字行不誤刪。
- T5 無 decks 行的 words-only deck：不 crash、words 照刪、exit 0。
- T6 --yes 閘門保留＋不存在 deck：拒絕/提示不變（回歸釘）。
- T7 rename-deck 同類：decks.name 同步 + words.deck 同步；對照 deck 不動；
  UNIQUE 衝突回滾釘（目標名已存在 → 零部分寫入）。
- T8 負控制：HEAD 版 cmdDeleteDeck/cmdRenameDeck 逐字反換（ORIGINAL_BLOCK
  byte-identical 釘）→ 幽靈 decks 行留存＋exam 孤兒留存＋legacy schema
  review_log 孤兒留存＋rename 後 decks.name 旧名，bug 精準重現。
- T9 結構釘：BEGIN/COMMIT/ROLLBACK 三包在位＋exam_history 刪除語句在
  `DELETE FROM words` 之前（區段限定 indexOf，D19 T8d 教訓）。
- **T10（v1.1，R1#3 m9 補釘）**髒 deckOrder（`not-json-broken{{{`）→ delete-deck
  exit 0＋刪除照完成＋髒值原封不覆寫——行為化釘死「內層 catch 跳過清理
  不擋刪除主路徑」註解契約（m9 變異體＝拆內層 try/catch → T10a/b 精準紅，
  首相獨立復現 29 PASS/2 FAIL 僅 T10 紅）。

## 5. 風險
- 純刪除面擴充＋事務包裹：合法輸入路徑最終態只多少不無（T1 對照釘）。
- rename UNIQUE 回滾是新拒絕路徑（現行默認分裂態）——語意正確性論證見 §3.2。
- cli.mjs 為 PM2 獨有檔；SR-C4 hunk 反剝既定程序。
- backupDb 先行保留（刪除屬高破壞，覆寫前備份慣例不變）。

## 6. 範圍外清單（憲法⑥）
- db.js deleteWord（只刪 text 族）/deleteWordsByDeck（只刪 id 族）半邊清理
  → **D20-SR1 登案**（白名單外）。
- **（R1#2 F-1 補登）cli.mjs cmdDelete（單字刪除）不刪 exam_history 雙族**
  ＝word-level 同款病灶（GUI deleteWord 已蓋，CLI 未蓋）；與本單 delete-deck
  同病灶家族但佇列未列＋凍結範圍⑤ → 另單（建議併 D20-SR1 系列）。
- **（R1#2 F-2 補登）cli.mjs cmdAdd/cmdImportCsv/cmdEdit --deck 寫 words.deck
  不註冊 decks 表** → CLI 端 words-only 幽靈 deck（GUI 清單不可見）；GUI
  importWords 會 createDeck，CLI 不會＝端間不對稱既存缺口 → 另單。
- **（R1#2 F-3 補登）cmdUpdateDeck --rename 無事務無 UNIQUE 防線**（崩序湥幸
  無半態）＋**（R1#3 m6b）cmdRenameDeck words-only deck 改名至既存名 →
  decks UPDATE no-op 默認靜默合併**（UNIQUE 只護 decks 表内無行可衝突）——
  本單 rename UNIQUE 守門宣稱的**已知邊界**，如實登記；統一事務化另單。
- **（R1#1 F2 補登）edits 表同 FK CASCADE 家族（lib.rs:1517）**：無 FK 舊世代
  同留孤兒，GUI deleteWordsByDeck 亦不刪（同軌非回歸）——顯式刪保壙未覆蓋面。
- **（R1#1 F3／R1#2 F-5 資訊）刪除不存在 deck 回 exit 0＋「已刪除」＋audit WRITE**
  （HEAD 同款語意，audit 略誤導）；新失敗路徑錯誤走 stdout（run_cli 讀 stderr，
  現零 deck 指令經行無實害）——各自另單。
- folders 表殘留（零消費者休眠面；若未來接線需同步清理 delete/merge/rename 三處）。
- buried/suspended/buriedAt 六鍵殘留 id（零功能影響，GUI 重寫自癒）。
- merge-deck 的 folders 殘留（同上休眠）。
- 舊世代 exam_history 文字碰撞誤刪語意取捨（無歸屬資料不可判別，D14 同款）。
- GUI deleteDeck 的 deckOrder/buried 清理鏈（store.js 面，零改动）。
- CLI 其餘高破壞命令統一回滾包裹（全檔事務化＝獨注重構單）。
- examSessions settings 存 deck id 指向已刪 deck（GUI deleteDeck 同款＝parity，
  resume 零詞池降級已由既有防線處理）。
- filtered_decks 存檔過濾器引用已刪 deck（動態求值永返空集合，無害，GUI 不清＝parity）。

## 7. 審查紀錄
### R1（v1.0，3 委員）
- **#1 ✅ 放行**：diff×計畫逐句一致；exam 雙世代 git show e53a3ce 實錘
  （exam-run INSERT wd.word→wd.id 同 commit）；Node 26 沙箱裸測
  `PRAGMA foreign_keys`=1＋CASCADE 級聯屬實（現行 schema 不復現孤兒宣稱成立）；
  getAllDecks 消費者穷举＝decks 表單源（無 words 派生第二源）；UNIQUE 回滾
  沙箱實測零部分寫入；自建獨立沙箱 29/29（真 lib.rs DDL＋spawn 真 CLI）；
  負控制 951B byte-identical 復證；exit code 下游穷举（Rust run_cli 呼叫面僅
  simulate/report 兩處、bot.py 零 spawn、cron 零）。非阻斷四筆全採納進 §6
  （F1 words-only rename 靜默合併邊界、F2 edits 表 CASCADE 家族、F3 不存在
  deck audit 誤導、F4 BEGIN 失敗訊息措辞）。
- **#2 ✅ 有條件（登記義務兩項）**：deck 寫入面穷举表十點（cmdCreateDeck 雙寫
  齊全／cmdMergeDeck 先例實在／cmdResetAll 全清）；被刪對象讀者全查——
  cmdAudit 反而受益（legacy 孤兒 log 假 mismatch 消失）、fsrs-optimize 訓練集
  只減死字（正向）、examHistory 全 pages 零讀者、deckOrder `?? Infinity` 天然
  無害；bot/cron/Rust 零機械消費者；filtered_decks 動態求值無害。條件＝F-1
  （cmdDelete 單字版同病灶漏登）與 F-2（add/import decks 註冊面漏登）補 §6
  → v1.1 已補（另加 F-3/F-5）。
- **#3 ❌ 條件性**：變異矩陣 14 體 13 殺（m1→T2b、m2→T1c/f、m4a/b→T1d 雙向
  不對稱互查、m5 錯序→T1d+T9b 雙紅、m6a rec 裸用→T5a、m7 rename 去事務→
  T7e、m8 去 --yes→T6a、m10 拋錯點→回滾全紅、m11 過度刪→T1g、m12 反向 bug→
  T7b；m6b name 等價變異仅靜態 T9d 補位成功）；負控制雙證（951B＋反空洞）。
  **唯一無牙防線**：m9 拆 deckOrder 內層 try/catch → 28/28 全綠存活
  （髒值行為差異真實存在但零釘覆蓋）→ 處方 T10。v1.1 補 T10（產品碼零改），
  首相獨立復現：m9 變異體恰 T10a/b 紅、餘 29 綠。
  **審查事故誠實登記**：#3 自制探測腳本 `mk()` 漏 return → TENO_DB=undefined
  → 對真檔跑了一次 `delete-deck Alpha --yes`。首相獨立覆核：真庫無 Alpha 牌組
  （實為 book1/…/雜誌 14 個）→ DELETE 命中零行、`PRAGMA integrity_check=ok`、
  words 4884 原封；唯一副作用＝audit_log 多一筆 id=244（留置不刪，越唯讀紀律）。
  教訓（「沙箱 spawn 前必須 assert TENO_DB 非空 tmp 路徑」）納入後案 SOP。
- v1.1 變更：§4 補 T10、§6 補登七筆（F-1/F-2/F-3/m6b 邊界/edits 家族/audit
  誤導/stdout 錯置）＋examSessions・filtered_decks parity 兩筆。產品碼零改動。

### R2（v1.1 複審，R1 ❌ 原提人 #3）— ✅ 閉合轉綠，全席過審
- m9 原體自建復現：**恰 T10a＋T10b 紅、29 綠**（與首相宣稱逐字吻合）。
- 自發假修變異雙殺：m9fakeA（catch 內覆寫 '[]'）→ T10c 紅；m9fakeB（整行刪
  settings）→ T10c 紅——「發明了卻不紅」弱釘情境不成立，T10a/b（行為）與
  T10c（反假修）三釘互補無死角。
- 無誤傷抽測：m2→僅 T1f 紅 T10 全綠；m7→T7d/T7e/T9a 紅（較 R1 多殺＝強化）
  T10 全綠。
- 文件/產品碼核證：§6/§7 逐筆在位；cli.mjs mtime 早於 v1.1 文件改動＋以當前
  碼重建 m9 行為指紋等價＝產品碼零改動多路佐證；基線 31/31×2。
- 附带如實登記：真庫 teno.db 審查期 mtime 擾動＝GUI app 排程備份（backups/
  同秒成對），內容三指紋（audit max=244／words 4884／integrity ok）前後不變。
- 裁決：R1 條件全數履行 → ✅。全席過審 → commit（SR-C4 反剝程序如常）。

