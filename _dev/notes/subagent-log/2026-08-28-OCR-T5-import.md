# PM-OCR2 · T5 `feat(ocr): importOcrText` — store 唯一入庫路徑（2026-08-28）

## 任務目標
§6.2b：store.js 增 `importOcrText(rawWords, deckName='OCR Inbox')`——
§5 正則白名單過濾＋正規化→走 importWords（內建去重＋自動建 Deck＋單事務）。
消費者：tools.js confirm（T4 已接線，PRE 紅態待本檔轉綠）。

## 交付
- `src/lib/store.js`：importOcrText 插入 importWords 之後（editWord 前），
  計畫 §6.2b 代碼逐字照錄（String() 防禦非字串輸入）；正則行 od 位元組級
  驗證＝`/^[a-z][a-z'-]{1,30}$/i` 逐字元吻合（本 session 傳輸損毀史防範）。
- `tools/verify-ocr-import.mjs`：T0~T5＋PRE 雙態＋NC 反換釘。

## 四層內測門
1. **靜態**：node --check store.js/verify ✅；`npm run build` 740ms 綠
2. **驗證腳本** `tools/verify-ocr-import.mjs` **16/16 ALL PASS**
   - T0 靜態釘四項（存在/§5 正則逐字元/this.importWords 唯一路徑/預設 deck）
   - T1 過濾矩陣：`['Apple',' BANANA ','3d','a','cafe?','x×32',"don't",
     'well-known','UPPER','alpha']` → added=5（apple/banana/don't/upper/
     well-known 落盤）、skipped=1（alpha 既有）、3d/a/超長/cafe? 過濾非 skip
   - T2 deck='OCR Inbox'＋definition='' DB 實查
   - T3 去重：批內大小寫收斂（star/STAR→1）＋跨既有 skipped
   - T4 自訂 deckName 透傳
   - T5 全垃圾 added=0 skipped=0 不拋（UI「入庫失敗」分支依據）
   - **PRE 雙態**：NEG 檔 importOcrText 整段剝除（=T4 時點實態）→
     呼叫 TypeError 紅；**NC 反換釘**：NEG.importWords 正常綠
3. **Browser 內測（dev:5199 實跑）**：
   - **confirm 轉綠**：真辨識 journey/example → confirm → toast 從 T4 的
     「not a function」升級為正確 DB 邊界錯誤（bare browser 無 Tauri SQL，
     requireDB 優雅 toast、候選保留可重試）——接線端到端通
   - **學習主流程冒煙**（store.js 共享檔鐵律）：OCR 入庫的 2 新詞自動入佇列
     →進翻卡 session→journey 卡 render→翻面→評分鈕（Hard/Good 實點）→
     下一張＋↩復原出现；「儲存失敗」toast＝無 DB 環境既有基線（非本軌回歸）
   - 既存回歸抽跑：d19 32/0、d6 14/14、c1 21/0、next-after-undo 零紅
4. **證據**：本檔＋verify-ocr-import.mjs

## 範圍外／登記（誠實）
- 無 DB 環境下 importWords 失敗路徑仍 push state.words（記憶體態污染，
  側欄顯 OCR Inbox 2）——importWords 既有基線（T1 已登記 ROLLBACK 二次拋錯
  未擴權同源），生產 initDB 必成不觸發；本軌零擴大。
- verify 腳本 T1 標籤「5? 不，過濾非 skip」為設計期備註殘留，斷言值正確。

## commit
`feat(ocr): importOcrText` — src/lib/store.js、tools/verify-ocr-import.mjs、本 log
