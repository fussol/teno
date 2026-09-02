# 🐛 BUG-LEDGER — Teno 單一 Bug 帳簿

> **唯一帳簿（法典·法律第9條，2026-08-30 元首令）**：全專案 bug 狀態以本檔為準。
> 新發現 bug 一律登錄本檔；修復以 `fix: <ID>` commit 為準並同步銷帳。
> 舊清單（bug-audit-2026-08-13.md / BUGHUNT-TODO.md / scope-requests.md 佇列段）僅作歷史存檔，不再各自維護待修狀態。
> 行號為 2026-08-13 audit 原始值，code 已漂移，動工時需重新定位。

## §1 未修清單（22 顆 = 開帳餘額）

### 🟠 中影響（0）

無 — 已全清。

### 🟡 低影響（11）→ 已修 13

無 — 已全清。

### 📊 資料維護（2）

| ID | 位置 | 問題 | 建議 |
|---|---|---|---|
| H1 | teno-backup.db / phone-db.db | integrity_check 報 idx_review_log_word 索引損壞 | REINDEX 維護作業（非 code bug） |
| H3 | settings._backup_humanEvents | 700KB+ page tracking JSON 累積 | 清理＋上限策略 |

**註記**：G16b 經 G16 案審查證偽（實為 suspend 函式非死碼），不列帳。

## §2 進行中（0）

無 — 全部落地。

## §3 觀察區（不計入帳面）

- 🟠 已修歸檔：**F7**（21ad4e5 / 5.9.12 splash 閃爍＋icon 重試）、**G2**（629aca7 / 5.9.13 手機側欄入口）、**G3**（e40751f / 5.9.14 子頁 nav 高亮＋study-v4 back）、**G6**（00c2b30 / 5.9.15 renderPage generation guard）、**G19+G20**（a550d98 / 5.9.16 autoFillOrder 存取＋分隔符統一）、**G21**（53ac989 / 5.9.17 tags/examples 欄）、**G28**（4fc0fad / 5.9.18 import 重入保護）、**G11**（d998834 / 5.9.19 listener 累積系列）、**G23+G27+D18+G29**（7c91431 / 5.9.20 🟡 批次）、**D12**（1b9ec7e / 5.9.21 Anki TSV 位置式回退）。- 🟡 已修歸檔（續）：**F19**（35c923d / 5.9.22 simulate_fsrs 當地日界線統一）、**G15+G17+G22+D13+G31**（5.9.23 🟡 末批：multi-accent 撞色移除 / browser filter memo / 編輯表單補相似反義衍生物欄 / import·drive audit / splash icon 完整性）。
- 已完 §2：F13-SR2（08c8b4b / 5.9.9）、E16-SR2（fb8bcb0 / 5.9.10）、F′ OCR2（ac8c421+10c6018+deb1202 / 5.9.7~11 匯入多檔+B′ 切割+D′ 入庫）。
- 手機 rate 回歸：症狀暫消失、未實錘復現；再現即立案。
- BUGHUNT-TODO.md 4 顆（BH-01~04）：已全修（205d565 / 634389d / 0b6dcaa / a5d4181），該檔轉歷史存檔。
- absorbed.txt 吸收冊續用（A3=A1、F18=F2）。

## §4 使用規則

1. 新 bug 發現 → 加列 §1（新 ID 沿用 audit 分區前綴：學習 A / 測驗 B / undo C / 匯入 D / CLI E / Rust-F / UI-G / 資料 H）。
2. 修復 commit 落地 → 該列改 ✅ 後整列移入 §3 歸檔註記，或直接刪列並在 §3 留一行。
3. 派工時狀態改「🔧 派工中」並註明首相。
4. 每波結束總統核帳：`git log --grep 'fix: <ID>'` 對拍本檔。
