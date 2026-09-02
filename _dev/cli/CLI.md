# Teno CLI 完整說明書

Teno CLI 提供終端機完整操作，從單字管理、學習複習、FSRS 排程優化到模擬診斷，全部可在終端機完成。

## 基本用法

```bash
export TENO_DB="/home/jupiter/.config/com.teno.app/teno.db"
node /home/jupiter/teno/tools/cli.mjs <命令> [參數...]
```

所有讀取命令預設唯讀，寫入命令（add/edit/delete/rate/optimize 等）會自動備份 DB。

---

## 互動學習

### `study [模式] [數量]`

終端機互動學習，完全模擬 GUI 學習流程：出題 → 顯示卡片資訊和預估間隔 → 等待評分 → FSRS 更新排程 → 下一題。

```
teno study              # flip 模式，預設 20 張
teno study flip 10      # flip 模式，10 張
teno study mc 15        # 多選模式，15 張
teno study spell 5      # 拼字模式，5 張
```

操作按鍵：
- `a` — Again（忘記）
- `h` — Hard（困難）
- `g` — Good（良好）
- `e` — Easy（簡單）
- `q` — 結束學習

每張卡片會顯示：單字、定義、狀態、穩定性、複習次數，以及四個評分對應的下次複習時間。

### `rate <id> <0|1|2|3>`

直接對指定卡片評分，不走學習佇列。

```
teno rate w_xxx 2       # 評分 Good
teno rate w_xxx 0       # 評分 Again
```

---

## 單字管理

### `add` — 新增單字

```
teno add --word cat --def 貓 --deck 日常 --pos noun --pron /kæt/ \
         --tags animals,pets --related "feline,kitten" --forms "cats,catty" \
         --ex "The cat sat on the mat."
```

必要參數：`--word` `--def`
可選參數：`--deck` `--pos` `--pron` `--tags` `--related` `--forms` `--ex` `--desc` `--synonym` `--antonym` `--derivative` `--examples`

### `edit <id>` — 編輯單字

```
teno edit w_xxx --def 新定義 --deck book2 --tags a,b
```

### `delete <id>` — 刪除單字（需 `--yes`）

```
teno delete w_xxx --yes
```

### `list` — 列出單字

```
teno list                          # 全部
teno list --deck book1             # 指定牌組
teno list --state 0                # 新卡
teno list --state 2                # 複習卡
teno list --tag animals            # 指定標籤
teno list --sort                   # 依到期日排序
teno list --limit 50               # 最多 50 筆
teno list --full                   # 顯示完整資訊
```

### `search <詞>` — 搜尋單字

```
teno search book                   # 模糊搜尋
teno search cat --full             # 完整資訊
teno search report --limit 10      # 限制筆數
```

### `random [數量] [--deck X] [--state N]` — 隨機抽單字

隨機抽取單字並顯示完整資訊（定義、詞性、發音、同義反義、衍生詞、關聯詞、詞形變化、例句、牌組、標籤、卡片狀態）。

```
teno random 5                      # 全庫隨機 5 張
teno random 3 --deck book1         # book1 牌組隨機 3 張
teno random 10 --state 0           # 只看新卡
teno random 10 --state 2           # 只看複習卡
```

---

## 卡片查詢

### `card <id>` — 查看卡片狀態

```
teno card w_xxx
```

### `history <id>` — 查看複習歷史

```
teno history w_xxx
```

### `due` — 查看今日到期卡片

```
teno due
```

---

## 牌組管理

### `decks` — 列出所有牌組

```
teno decks
```

### `create-deck <名> [--color #hex]`

```
teno create-deck 新牌組 --color #ff6600
```

### `rename-deck <舊名> <新名>`

### `merge-deck <來源> <目標>` — 合併牌組

### `delete-deck <名> --yes`

### `deck-order move <名> up|down` — 調整牌組順序

---

## 標籤管理

### `tags` — 列出所有標籤

### `create-tag <名> [--color #hex]`

### `delete-tag <名>`

### `tag-words <名>` — 列出有此標籤的單字

---

## FSRS 排程演算法

### `optimize --yes` — 從歷史資料最佳化 FSRS 權重

```
teno optimize --yes
```

分析全部複習歷史，計算最佳 FSRS 21 個權重參數，自動套用到 flip/mc/spell 三個模式。

### `health` — 健康檢查

```
teno health
```

顯示卡片狀態分佈、平均穩定性/難度、保留率、到期卡片預測保留率、leech 卡清單。

### `behavior` — 行為模型分析

```
teno behavior
```

分析：轉移矩陣（同卡上次評分→下次）、reps 曲線（依複習次數的 Again 率）、難度分級曲線。

### `fsrs-report` — FSRS 監測報告

```
teno fsrs-report
```

顯示評分分布、狀態轉移、間隔分佈、穩定性成長等詳細報告。

### `anki [flip|mc|spell]` — 查看/修改 Anki 設定

```
teno anki                    # 查看 flip 模式設定
teno anki mc                 # 查看 mc 模式設定
teno anki set cardsPerDay 50 # 設定每日卡片數
teno anki set desiredRetention 0.85 --mode mc
```

可設定欄位：`maxIvl` `cardsPerDay` `leechThreshold` `desiredRetention` `fsrsWeights` `learnSteps` `relearnSteps` `reviewMix` `learnAheadLimit` `timezoneOffset`

---

## 模擬器

### `simulate` — 執行日模擬

```
teno simulate --days 30 --seed 42 --speed 1000
teno simulate --days 365 --from-zero           # 從零開始
teno simulate --days 90 --start 2026-01-01     # 指定開始日
```

使用真實行為模型（轉移矩陣 + R-bucket 記憶曲線 + 難度分級）+ FSRS 引擎模擬每日複習。

### `mature` — 成熟度模擬

```
teno mature 95 --max-days 365                  # 到 95% 成熟
teno mature 80 --from-zero --seed 42           # 從零開始到 80%
teno mature 95 --speed 200                     # 加速模式
```

逐日模擬直到目標成熟率或最大天數。

### `diagnose` — 診斷模擬日誌

```
teno diagnose
```

### `report` — 產生 HTML 模擬報告

```
teno report
```

---

## 過濾牌組

### `filtered` — 列出過濾牌組

### `filtered-add` — 新增過濾牌組

```
teno filtered-add --name "高難度卡" --query "props:difficulty>8" --limit 50
```

查詢支援：`is:due` `is:new` `is:learning` `is:review` `deck:名稱` `tag:標籤` `lapses:>5` `props:ivl>30`

### `filtered-delete <id>` — 刪除過濾牌組

---

## 考試

### `exam` — 列出考試紀錄

### `exam-run` — 執行模擬考試

### `exam-sessions` — 考試場次

---

## 匯入 / 匯出

### `import-csv <路徑>` — 匯入 CSV/TSV

```
teno import-csv /path/to/words.csv
```

CSV 欄位：`word,definition,part_of_speech,deck,pronunciation,tags,example`

### `export-csv [路徑]` — 匯出 CSV

### `export-db` — 匯出 TENOC 容器

```
teno export-db /tmp/backup.tenoc          # 不含操作日誌
teno export-db /tmp/backup.tenoc --log    # 含操作日誌
```

### `import-db <路徑>` — 匯入 TENOC 容器

---

## 備份與還原

### `backup` — 建立備份

```
teno backup
```

備份檔保存在 `teno.db.bak-YYYYMMDDhhmm`

### `restore <檔名>` — 還原備份

```
teno restore teno.db.bak-2026-0804-1905
```

### `backups` — 列出備份

```
teno backups list
teno backups restore <name>
teno backups delete <name>
teno backups prune 50
```

---

## 主題設定

### `theme` — 主題外觀

```
teno theme mode dark              # 切換深色
teno theme accent blue            # 色調
teno theme intensity 0.8          # 色調強度
teno theme palette "#hex,#hex,..."
```

可用色調：`blue/purple/green/red/orange/pink/teal/indigo/slate/amber/lime/cyan/rose`

---

## TTS 語音

### `tts` — 語音設定

```
teno tts speed 1.2              # 語速 0.3~3
teno tts voice en_US-ryan-high
teno tts pitch 60               # 音高 0~99
teno tts engine espeak-ng
```

### `tts-play <單字或英文>` — 播放發音

---

## 每日目標

### `day <分鐘>` — 設定日界線

```
teno day 240                    # 凌晨 4:00 重置
teno day 0                      # 午夜重置
```

### `goal <數量>` — 設定每日目標

### `streak` — 查看連續天數

---

## 修復工具

### `fix` — 卡片修復

```
teno fix reset-card w_xxx       # 重置卡片到新狀態
teno fix graduate w_xxx         # 畢業卡片到複習狀態
teno fix rewind w_xxx           # 回到上一次複習狀態
teno fix reset-stray            # 修正遺漏卡
```

### `reset-card <id>` — 刪除卡片和複習紀錄

### `stray` — 檢查遺漏卡

### `doublefire` — 檢查重複評分

---

## 系統診斷

### `selftest` — 跑 14 項自檢

```
teno selftest
```

測試項目：FSRS 公式、模擬引擎、容器匯入匯出、DB 完整性。

### `db-check [路徑]` — 檢查 DB 完整性

```
teno db-check
teno db-check /backup/teno-old.db
```

### `leech-list [門檻]` — 列出 leech 卡

```
teno leech-list                 # 門檻 8
teno leech-list 5               # 自訂門檻
```

---

## 操作日誌

### `logs` — 查看操作日誌

### `sims` — 查看模擬歷史

### `log-retention <天數>` — 設定日誌保留天數

```
teno log-retention 14           # 保留 14 天
teno log-retention 0            # 停用記錄
```

### `log-prune` — 手動清理過期日誌

---

## 統計與儀表板

### `stats` — 基本統計

### `dash` — 儀表板

### `sql <SELECT...>` — 直接執行 SQL（唯讀）

```
teno sql "SELECT word, stability FROM cards JOIN words ON words.id=cards.word_id WHERE state=2 ORDER BY stability DESC LIMIT 10"
```

---

## Google Drive 同步

### `drive` — Drive 同步

```
teno drive status               # 查看狀態
teno drive creds                # 設定憑證
teno drive tokens               # 查看 token
```

---

## 環境變數

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `TENO_DB` | 資料庫路徑 | `~/.config/com.teno.app/teno.db` |
| `TENO_NO_BACKUP` | 停用自動備份 | 未設定 |
| `TENO_BEHAVIOR_W` | 行為混合權重 | 0.6 |
| `TENO_CLI` | CLI 腳本路徑 | `/home/jupiter/teno/tools/cli.mjs` |

---

## 程式化 API

CLI 模組可被匯入使用（供 UI 層、Discord bot、其他腳本）：

```js
import { runCli, api } from './tools/cli.mjs';

// 執行命令
await runCli(['stats']);

// 直接呼叫 API
api.rateCard('w_xxx', 2);
api.editWord(...);
api.addWord(['--word', 'hello', '--def', '哈囉', '--deck', '日常']);
```

---

## 快速鍵 Alias

```bash
alias teno='TENO_DB="$HOME/.config/com.teno.app/teno.db" node "$HOME/teno/tools/cli.mjs"'
alias topt='teno optimize --yes'
alias tdue='teno due'
alias tstat='teno stats'
alias tleech='teno leech-list'
alias trand='teno random'
alias tstudy='teno study'
alias tcheck='teno selftest && teno db-check'
```
