# 🐛 BUG-LEDGER — Teno 修檢版 Bug 帳簿

> 全專案 bug 狀態以本檔為準。新發現 bug 一律登錄 §1；修復以 `fix: <ID>` commit 為準並同步銷帳。
> ID 前綴：學習 A / 測驗 B / undo C / 匯入 D / CLI E / Rust-F / UI-G / 資料 H。
> 行號為立案時快照（main @ v5.16.24），code 漂移後動工需重新定位。
> 立帳：2026-09-09，總統親掃（5 子代理全被 rate-limit 打下，改總統手掃：讀碼＋harness＋實測）。

## §1 未修清單

無（2026-09-10 核帳：立案 35 筆全結 —— 34 修（法典§4 一 bug 一 commit，全帶 harness＋反向驗證）＋1 轉觀察（A-EXAM1，非 bug，見 §3）。行號為立案快照，動工已重定位。）

## §2 進行中（0）

無。

### 本波歸檔（34 修）

| ID | commit | 備註 |
|---|---|---|
| G-XSS0 | 4422596 | toast sink 轉 textContent，全 repo 一次滅 |
| G-XSS1 | f389322 | exam-flip deck/tag 名 escape |
| G-XSS2 | 9a4fe12 | exam-mc 同上 |
| G-XSS3 | 179cdcd | exam-spell 同上 |
| G-XSS4 | 251dcd2 | browser 篩選 chip 標籤 escape |
| G-XSS5 | 7a9a143 | dashboard 字本卡名 escape |
| G-XSS6 | a46a5ca | tools 體檢 issues escape |
| G-ICON1 | 4827aae | 補 12 缺名圖標 |
| G-BTN1 | 7e11c48 | secondary/xs 定義＋裸 btn-sm 滅 |
| D-TSV1 | a149df8 | 無標頭保首列（與 D-CSV1 同 commit） |
| D-CSV1 | a149df8 | 同上 |
| D-IMG1 | d5e90a7 | id→word＋cell 索引＋CON=5 pool |
| D-CNT1 | 1e33193 | 跳過數拆重複／空／無效 |
| D-NAME1 | 656ae14 | 真實檔名進完成頁 |
| D-PROG1 | 1c92183 | 圖片階段併進度條 |
| D-POS1 | f181bbc | 獨立 int. 不轉感嘆詞 |
| B-SHUF1 | c8fd5d1 | study＋exam 測驗 seeded Fisher-Yates（掃出 exam 同病附帶） |
| H-CASE1 | 5e0b500 | 新增／匯入保大小寫 |
| G-SVG1 | 8df0ea1 | 手寫 SVG 全走 icon()＋pause 註冊＋px/cls 參數 |
| G-HARD1 | 1e33a55 | accent 衍生三處跟主題；數據色刻意不動 |
| G-DIS1 | 398bdf4 | 主鈕 disabled 全域視覺 |
| G-SIZE1 | 7640f3d | btn-primary 補 nowrap |
| G-SIZE2 | e9bfa23 | chip nowrap＋count 等寬保底 |
| G-SIZE3 | c0cfdbb | scope/sort/select 雙態鎖寬（附帶 select） |
| G-SIZE4 | 85f393a | size 類移 variant 之後（G-BTN1 驗項不足半條命，cascade 才是根） |
| G-TOOL1 | fffdda6 | 工具頁詞性併入 core normalizePos（8 點全收斂） |
| G-TINY1 | ab718a4 | 行動 44px 線＋時間標 9→11；10/11px 微標籤屬設計不動 |
| G-I18N1 | dde5665 | 圖表空態繁中＋主題色；OCR 區實測已中文轉防倒退 |
| F-ENC1 | 9352265 | urlcodec 按 UTF-8 bytes；非法 % 保留字面 |
| F-RACE1 | fdcc890 | media_token 綁定取圖；mtime 掃描退居退路 |
| F-TMP1 | caa7abe | TempAnki2 RAII＋24h 陳屍清；途中抓一並行 flaky 改單檔斷言 |
| F-PACK1 | ae8c370 | 段長 try-U32 守門；v1 格式不動，超限拒包 |
| F-ATOM1 | 77205c6 | log 改原子寫＋sync_all；tmp 慣例保留 |
| A-DASH1 | f81a890 | resume 換日重算＋dashboard 重繪；學習／測驗不擾 |

### 本波觀察（1，非 bug）
## §3 觀察區／已驗證乾淨（不計入帳面）

- A-EXAM1（銷帳，非 bug）：測驗開場詞表凍結為正確語意。實證：計分只寫 exam_history（store.js recordExam→db.addExamEntry＋examHistory push），不碰 cards／review_log／新卡額度；examinedAt 按作答時刻戳記；e.words 凍結反為計分索引（_correctIdx／_answered／B4 去重）所必需——中途換名單才會製造 bug。影響≈0（分鐘級測驗跨日）＋修了更壞＝觀察結案，不動碼。

- 搜尋索引殘留：leech tag 原地 push（store.js:864-865）、undo tag（1003-1006）、removeTagFromAll（1624）、rename（1671）、deleteTag（1698）——全只動 `tags`，不在 searchIndex 索引欄內（word/definition/example/pos/description/related/forms），無殘留。v5.16.18 修的是 words 陣列三處，已驗。
- 全頁 `node --check` 乾淨（pages／lib／core／engine 全過）。
- Rust：`cargo test apkg` 9/9；全量 54 過＋3 敗為已知 `sim_tests` 缺 fixture（与本次無關）。
- Rust 守門已驗：`file_name` 穿越 guard、單檔 5MB、總檔 500MB、2 萬列上限、cell_images row/col 對齊、media 去重一致。
- 7000 真實牌組 E2E：7131 列 0.14s，欄位／deck 名／列寬全對。
- vite build EXIT 0（880ms）。

## §4 使用規則

1. 新 bug 發現 → 加列 §1（ID 沿用分區前綴，流水號）。
2. 修復 commit 落地（`fix: <ID>`＋版本號）→ 該列改 ✅ 後移入 §3 歸檔，或刪列並在 §3 留一行。
3. 一 bug 一 commit；動手前先報修法（既有治理）。
4. 每波結束核帳：`git log --grep 'fix: <ID>'` 對拍本檔。

### 2026-09-10 追打（4 修，使用者回報波）
| ID | commit | 備註 |
|---|---|---|
| G-SIZE2b | 9eed3e7 前一顆 | 匯出頁色點橢圓：count 規則縮到 .deck-count |
| TAG-ADD1 | 同上上 | 新增鈕被透明 color input 蓋住：規則縮到 .form-input |
| IMPORT-NODB | 同上上上 | 無 teno.db 時備份放行，匯入不再被安全網卡死 |
| NO-DEMO | 9eed3e7 | 展示模式切除（使用者裁示）：db 分流49處＋demo-data＋banner＋seedIfEmpty 全清 |
