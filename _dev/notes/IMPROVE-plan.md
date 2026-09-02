# 🎯 IMPROVE-Plan — Bug 獵人 × 優化精算師 × 優化顧問 三合一報告
> 2026-09-01 · 總統 Oliver 親掃（v5.9.29 / 4925 詞真實 DB 實測）

## A. Bug 獵人 — 掃描結論：無新功能 bug，2 個低風險觀察項

### 掃描面與結果
- **listener 累積**（document/window 級 ×8 處）：全數有 guard 或 cleanup（tools.js `_toolsCsBound`、exam-spell `__esKeyHandler` remove、G11 系列已修）✓ 無新洞
- **innerHTML 注入面**：deck-browser `${w.word}` 出現於 confirm() / toast()（純文字 API 非 HTML，無 XSS 面）✓
- **Enter 雙 handler 衝突**（膠囊 vs 聚焦跳欄）：動態驗證 4/4 — 有值→存膠囊 stopPropagation；空值→冒泡跳欄。共存正確 ✓
- **資料邊界**：synonym 欄零 JSON 汙染、例句含分號 21 筆（膠囊不分割分號 ✓ 無損）
- **膠囊 round-trip**：5/5 — related JSON 陣列、synonym 逗號串、例句換行、含逗號例句、LLM setVal 全位元組等價 ✓

### 觀察項（非 bug，記錄待議）
| # | 觀察 | 影響 | 建議 |
|---|---|---|---|
| O1 | 膠囊欄有值 Enter 存入後不跳下一欄（需再按一次空 Enter） | 輸入動線多一次按鍵 | **保留**（連續輸入多筆時反而方便）；若要跳欄可選：Shift+Enter 存入後跳 |
| O2 | `llmFillRelated` fallback 寫 input.value（無膠囊容器的舊 modal 殘留路徑） | 目前四 modal 全有容器，fallback 不觸發 | 留著無害（防未來新 modal 忘接） |

## B. 優化精算師 — 熱點量化（真實規模 4925 詞）

| # | 熱點 | 實測 | 判定 |
|---|---|---|---|
| P1 | sidebar key `JSON.stringify`（每 notify） | **17.9 μs** | ✅ 可忽略 — 動了反而冒險 |
| P2 | `collectTags` 全量（每 render） | **1.16 ms** | 🟡 小痛 — 可 memo（words ref + tags 不變即回快取），但單頁開啟才跑一次，優先級低 |
| P3 | `searchIndex` 建置（G17 已做） | 0.9 ms 一次性 | ✅ 已最優 |
| P4 | 500 列 rowHtml 組裝 | 0.1 ms | ✅ 字串層可忽略 |
| P5 | **500 列 innerHTML DOM parse** | 組裝 0.1ms 的 **5-10x ≈ 1ms+**（WebKitGTK 手機更慢） | 🔴 唯一大項 — 但已被「Enter 觸發搜尋」根本性繞開（打字零 parse）；剩「換頁/首次渲染」場景 |
| P6 | `allStreakDates` sort（每 notify） | 6.6 μs | ✅ 可忽略 |

**結論**：v5.9.26~29 的三連優化（局部渲染+索引+Enter 觸發）後，字庫/字本已無實測可感熱點。P2 可做但收益 <2ms。

## C. 優化顧問 — 建議路線圖（按價值/成本排序）

### C1 立即可做（小改動、真收益）
1. **P2 collectTags memo**（+3 行）— render 鏈省 1.16ms
2. **膠囊 Enter 後 focus 優化**：存入膠囊後 focus 留在原框（已如此）+ placeholder 提示「Enter 跳下一欄」（O1 的零代碼方案）

### C2 中期（體驗升級）
3. **字庫虛擬滾動**（僅「全部」顯示時）：P5 的 500+ 列 parse 在「上限=全部」時回歸 — 用 IntersectionObserver 分批掛載（先渲染 50 列，滾動追加）。預估手機滾動 jank 全消。
4. **LLM 自動填入的並行度**：autoFill 鏈目前 serial（cambridge→dict→tatoeba→llm 逐個 await）— dict-api/tatoeba 可 Promise.all 並行，Cambridge 首位保持（有定義優先權）。

### C3 長期（架構級，收益明確才做）
5. **words 全表載入改增量**（loadAll 4925 詞 ×17 欄全量 SELECT）— 目前 8MB DB 開機載入可測；若上萬詞變慢再做分頁/懶載。**現在不做**（SQLite IPC 快，YAGNI）。
6. **worker 化搜尋**：目前索引比對 0.9ms — 一萬詞內無必要。

### C4 治理建議
7. H1（teno-backup.db 索引損壞）建議下次開 app 後跑 `REINDEX idx_review_log_word`（一次性維護）
8. H3（_backup_humanEvents 68KB）已被這次清洗證實會在未來累積 — 建議加上限（保留最近 500 事件）列為帳簿 H3 的修法

## 結論
**帳面乾淨**：22 顆全清、膠囊系統行為 11/11+round-trip 5/5+Enter 衝突 4/4、效能實測無可感熱點殘留。下一步價值最高的是 C2-3 虛擬滾動（手機「全部」顯示時的最後一塊 jank）與 C2-4 並行填入。
