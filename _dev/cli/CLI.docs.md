# Teno 全控 CLI

`/home/jupiter/teno/tools/cli.mjs` — 不需要碰 UI 就能操作/診斷/修復 Teno 應用。

## 快速開始

```bash
node tools/cli.mjs <命令>
node tools/cli.mjs <命令> --help
```

環境變數：
- `TENO_DB` — DB 路徑（預設 `~/.config/com.teno.app/teno.db`）
- `TENO_LOG` — CLI log 路徑（預設 `/tmp/teno-cli.log`）
- `LLM_URL` / `LLM_MODEL` — Ollama API（預設 `http://localhost:11434`）

**原則**：唯讀命令安全；寫入命令**自動備份 DB** 後才執行，且寫入 `/tmp/teno-cli.log`。

## 完整命令清單

### 診斷

| 命令 | 說明 |
|---|---|
| `stats` | 全庫統計（words/cards/review_log/狀態分佈/字本） |
| `dash` | 儀表板全部數字（進度/保留率/目標/字本/按鈕/時段/14天） |
| `due` | 今天到期明細（學習/複習/新卡） |
| `card <id>` | 單卡詳情＋最近複習 |
| `history <id>` | 完整複習歷史 |
| `sql "<SELECT...>"` | 任意唯讀 SQL（僅 SELECT/PRAGMA/WITH） |
| `search <詞> [--full] [--limit N]` | 搜尋全部欄位（字/定義/詞性/發音/例句/字本/標籤/同義/相關/詞形/描述） |
| `list [--deck X] [--state N] [--tag T] [--pos P] [--full] [--limit N] [--desc]` | 篩選瀏覽單字（A-Z 預設） |

### 單字 CRUD

```
add --word cat --def 貓 --deck 日常 --pos noun --pron /kæt/
    --ex "例句" --tags a,b --related x,y --forms cats,catty
    --synonym 同義 --antonym 反義 --derivative 衍生 --desc 描述
edit <id> --def 新定義 --deck X --tags a,b --desc 描述   # 全部欄位皆可, --tags "" 清空
delete <id> --yes
autofill set cambridge,dict-api,tatoeba,llm               # 自動填入順序
autofill move <來源> up|down
```

### Deck（字本）

| 命令 | 說明 |
|---|---|
| `decks` | 字本分佈＋UI 順序 |
| `create-deck <名> [--color #hex]` | 新增字本 |
| `update-deck <名> [--color #hex] [--rename 新名]` | 更新顏色/改名 |
| `merge-deck <來源> <目標>` | 合併字本 |
| `rename-deck <舊> <新>` | 改名（words.deck） |
| `delete-deck <名> --yes` | 刪除字本＋全部單字 |
| `deck-order move <名> up\|down` | 調整 UI 順序 |

### Tag（標籤）

| 命令 | 說明 |
|---|---|
| `tags` | 列出全部 tag |
| `create-tag <名> [--color #hex]` | 新增 tag |
| `delete-tag <名>` | 刪除 tag＋從單字移除 |
| `tag-words <名>` | 列出含此 tag 的單字 |

### 外觀（主題/顏色）

```
theme mode <dark|light>
theme accent <名>          # 40 色可用
theme intensity <0~1>
theme palette <#色,...>    # 常用色
```

40 個強調色：`lemonChiffon skyBlue peach mintGreen lavender coralPink springGreen sunshineYellow babyBlue apricot turquoise candyPink limePunch periwinkle creamyOrange aquamarine orchid buttercup seafoam skyMagenta oceanTeal sage sand mist clay slate peachFuzz olive cloud dustyRose midnight forestMoss parchment stormySky terracotta lavenderMist warmTaupe eveningGlow steelBlue winterPine`

### 發音 / TTS

| 命令 | 說明 |
|---|---|
| `tts speed <0.3~3>` | 朗讀速度 |
| `tts voice <名>` | 語音 |
| `tts pitch <0~99>` | 音高 |
| `tts engine <名>` | 引擎 |
| `tts-play <id或英文> [--text "自訂"]` | 用 espeak-ng 播放發音 |

### 每日 / 目標

| 命令 | 說明 |
|---|---|
| `day <0~1439>` | 每日重置時間（分鐘） |
| `goal <每日目標>` | 設定目標 |
| `streak` | 連續天數詳情 |

### 學習演算法（Anki / FSRS）

```
anki [flip|mc|spell]                    # 顯示該模式設定
anki set <欄位> <值> [--mode flip|mc|spell]
simparams set <欄位> <值>
```

Anki 欄位：`maxIvl cardsPerDay lapseMult leechThreshold desiredRetention learnSteps relearnSteps reviewMix timezoneOffset learnAheadLimit`

### 過濾 Deck

| 命令 | 說明 |
|---|---|
| `filtered` | 列出過濾牌組 |
| `filtered-add <名> --query "..." [--max N] [--color #hex]` | 新增 |
| `filtered-delete <名>` | 刪除 |

### 測驗

| 命令 | 說明 |
|---|---|
| `exam list` | 測驗紀錄 |
| `exam clear --yes` | 清除紀錄 |
| `exam-run <flip\|mc\|spell> [--deck 字本] [--count N] [--answers 1,0,1] [--correct-pct 80] [--tag-correct correct] [--tag-wrong wrong] [--no-autonext]` | 執行測驗（判定＋貼標籤＋寫紀錄） |
| `exam-sessions list\|clear --yes\|max <數>` | 測驗進度組數管理 |

### 工具 — FSRS

| 命令 | 說明 |
|---|---|
| `optimize --yes` | 用複習記錄最佳化 FSRS 權重（覆寫 3 模式） |
| `health` | 健康檢查（卡分佈/保留率/水蛭） |
| `simulate <天數>` | 長期複習量預測 |

### 工具 — 單字庫

| 命令 | 說明 |
|---|---|
| `scan dupes` | 找重複單字 |
| `scan missing [def\|pos\|ex\|pron\|related\|forms]` | 缺欄位統計＋清單 |
| `llm pos\|related\|forms\|pron\|examples [--limit N]` | LLM 批次產生（需 Ollama） |
| `cambridge <單字> [zh]` | Cambridge 字典查詢（IPA/定義/例句） |

### 語音模型 / Drive / 備份

| 命令 | 說明 |
|---|---|
| `piper list\|set <名>\|delete <名>` | 已安裝語音模型管理 |
| `drive status\|creds\|tokens` | Google Drive 同步狀態（授權需在 app 內） |
| `backups list\|restore <名>\|delete <名>\|prune <保留數>` | 自動備份管理 |

### 資料表 / 設定

| 命令 | 說明 |
|---|---|
| `folders` | 資料夾 |
| `additions` | 候選單字 |
| `edits` | 編輯歷史 |
| `settings [key]` | 讀取設定 |
| `set <key> <value>` | 寫入設定（JSON 或字串） |

### CSV

| 命令 | 說明 |
|---|---|
| `export-csv [路徑]` | 匯出 CSV |
| `import-csv <路徑>` | 匯入 CSV/TSV |

### 評分 / 模擬

| 命令 | 說明 |
|---|---|
| `rate <id> <0\|1\|2\|3>` | 評分（Again/Hard/Good/Easy，真實 FSRS） |
| `sim [--ratings 0,2,1]` | Session 模擬（偵測跳卡/循環） |
| `stray` | 找今天到期但不在佇列的遺漏卡 |
| `doublefire [log]` | 分析 rate log 的雙重評分 |

### 修復（寫入，自動備份）

| 命令 | 說明 |
|---|---|
| `fix reset-card <id>` | 重設卡為新卡 |
| `fix graduate <id>` | 強制畢業（state=2 due 明天） |
| `fix rewind <id>` | 把 due 改成現在（重新進佇列） |
| `fix reset-stray` | 修復遺漏卡 |
| `reset-all --yes` | 清空全部資料 |

### 備份

| 命令 | 說明 |
|---|---|
| `backup` | 手動備份 DB |
| `restore <檔>` | 還原 DB |

## Log 監測

所有命令寫入 `/tmp/teno-cli.log`：

| 事件 | 說明 |
|---|---|
| `CMD` | 命令進入，含完整指令 |
| `READ` | 唯讀命令結果（含實際數據） |
| `WRITE` | 寫入命令詳細（改什麼＋備份路徑） |
| `RUN` | 耗時操作開始（optimize/simulate/tts-play） |
| `ERROR` | 命令失敗（含堆疊） |
| `DONE` | 命令完成＋耗時 |

範例：
```
[2026-08-02T01:28:23.099Z] [CLI] READ  | stats: words=4868 cards=1174 review_log=8860 decks=13
[2026-08-02T01:28:23.516Z] [CLI] READ  | anki flip: {"maxIvl": 365, ...}
[2026-08-02T01:29:28.519Z] [CLI] READ  | sim: 顯示=50000 唯一=50 重複=true stray=0
[2026-08-02T01:29:28.564Z] [CLI] WRITE | backup → teno.db.bak-2026-08-020129
```

## 程式化 API

CLI 也可作為 Node 模組被 UI 層 / Discord bot import：

```js
const m = await import('./tools/cli.mjs');
await m.runCli(['stats']);       // 等同 CLI
m.api.loadState();               // 真實狀態
m.api.rateCard('w_xxx', 2);      // 直接評分
```

## 頁面功能對照

| UI 頁面 | CLI 覆蓋 |
|---|---|
| 儀表板 | `dash` `goal` `streak` `stats` |
| 學習 | `rate` `sim` `stray` `anki` |
| 測驗 | `exam-run` `exam` `exam-sessions` |
| 字庫/字本 | `search` `list` `add` `edit` `delete` `create-deck` `merge-deck` `tag` |
| 設定 | `theme` `tts` `day` `goal` `anki set` `simparams` `filtered` `set` |
| 工具 | `optimize` `health` `simulate` `scan` `llm` `cambridge` `piper` `drive` `backups` `import-csv` `export-csv` |

**唯一限制**：Google Drive 實際上傳/下載需在 app 內跑 OAuth 授權（瀏覽器流程），CLI 只能查狀態/憑證。
