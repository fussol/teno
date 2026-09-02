# Teno review_log 分析資料包（供免費端點深度審查）

## DB
路徑 /tmp/teno-analysis.db（TENOC 容器解包，integrity ok），18609 資料表，18080 筆 review_log，橫跨 2026-07-04 ~ 2026-08-27（修復前後）。

## review_log schema
```
id INTEGER PK, word_id TEXT REFERENCES words(id) ON DELETE CASCADE,
rating INTEGER, elapsed_days INTEGER, scheduled_days INTEGER,
stability REAL, difficulty REAL, reviewed_at TEXT(混合無Z/帶Z),
duration INTEGER, mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER
```

## 已撈異常數據（你在此基礎深化，勿重複盲掃）
1. reviewed_at 格式混合：14372 筆無 Z（naive datetime 'YYYY-MM-DD HH:MM:SS'）+ 3708 筆帶 Z（ISO '...T...Z'）— E2 bug 修復分界
2. rating 極偏斜: Good=11084(61%)/Again=6569(36%)/Hard=378(2%)/Easy=49(0.3%)
3. mode: flip=17834, mc=136, spell=110
4. stability 範圍 [0.001, 213.40]，difficulty 範圍 [1.0, 9.98]
5. stability=0 或 NULL: 0 筆；scheduled_days<0 或 >3650: 0 筆
6. new_state NULL: 10786/18080 (60%)
7. duration>3600000(1hr): 28 筆
8. elapsed_days>=1: 7564 筆
9. 單日爆量: 8/20=1160, 7/28=1084, 8/26=1078, 8/8=904 — 單日成百上千筆
10. 同秒重複 rating 多組（例 2026-07-19 17:21:04 flip 3 筆）

## 你被要求的兩大任務
### 任務一：深度找錯/bug
用 SQL 實查 DB 深化分析，找出：
- stability/difficulty 異常聚集（是否卡在上限 213/10）
- 特定字的排程異常（同一 word_id 大量重複評分?）
- 修復前後（無Z vs Z）的模式差異
- 是否有「某些筆 elapsed_days 計算錯」「learning 卡迴圈」跡象
- FSRS 權重健康度（極偏斜是否反映權重爆炸）

### 任務二：建議新增 log 監測點（使用者特別要求）
以「若要在 app 加更多 log 監測使未來找 bug 更容易」為目標，具體建議：
- 在哪些 code 位置加什麼 log（如：評分時記錄 fsrs 輸入/輸出參數、session 開始/結束、queue build 快照、timezone/dayCutoff 快照、連按防護觸發、遷移執行、權重載入時 log 實際權重）
- 哪些現有欄位值得延伸（如 review_log 加 session_id、device_id、mode 已有）
- 哪些異常應該「主動 log/warn」而非只有寫入後才可查

## 輸出要求
任務一 + 任務二合併報告，繁體中文，資料驅動（任務一每點附 SELECT 證據）。leaf 唯讀，勿改檔案。