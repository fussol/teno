# AGENTS.md

## 題庫共編窗口（人只丟資料，AI 負責整理）
- `ai-input/`：使用者丟原始出題資料（txt/md，可未定稿、可含答案）。
- `ai-output/`：AI 寫出整理好的新題（與 `public/packs/grammar/questions.jsonl` 同 schema，每行一題）。

流程（每次工作階段先看 `ai-input/` 有無新檔）：
1. 讀檔轉 schema——MC: `{type:"mc", stem, options[4], answer(0-3), explain, difficulty, pattern, chapter, axis, id}`；TR: `{type:"translate", translation, reference, comment, id, pattern, chapter, axis}`。答案／參考譯文由 AI 補齊；壞題跳過並回報。
2. id = `g-{pattern}-{mc|tr}-{n}`，接現有最大編號；pattern 必須存在 `public/packs/grammar/pattern_titles.json`（新句型先加標題鍵）。
3. 新題寫入 `ai-output/questions.jsonl`，再 append 進 `public/packs/grammar/questions.jsonl`。
4. `node tools/bank.mjs validate` 必過 → `npm run build` → `node tools/verify-plugin-seam.mjs`。
5. 完成後把來源檔移到 `ai-input/done/`，回報題數與跳過清單。

增刪題目（AI 端口，勿手改 JSONL）：`node tools/bank.mjs add <q.json|-> | del <id> | list [pattern] | validate`

app 內入口：工具頁「文法題庫管理」＝AI 出題／刪題，寫 `settings.grammar_bank_overlay`（`{up,rm}` 覆蓋層），文法頁載入時 mergeBank 疊上主本——與 repo jsonl 各管各層，不衝突。

## 題庫分發（SHAREPACK2，勿開倒車）
- 題庫檔住 `public/packs/{gsat,grammar}/`（隨 App 附檔）；**不預載**——app 啟動不讀，使用者在學測頁／文法頁／工具頁／匯出頁點「匯入」才寫進 `settings.gsat_bank`／`grammar_bank_core`。
- 因此 repo jsonl 更新後，已匯入的 app 拿的是匯入當下那份 DB 拷貝；要讓舊使用者看到新題，得重出包或讓其重新匯入（匯出頁「分享包」有匯出鈕可發新包）。
- 個人自建題走 `grammar_bank_overlay`，匯出＝匯出頁「我的題目」（`pack-grammar-overlay` 單檔）；進度一律 `.db` 備份全包，不做獨立進度包。
