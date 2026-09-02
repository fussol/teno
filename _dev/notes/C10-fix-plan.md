# C10 修復計畫書 v1.1 — rateCard `_ratingLock` 無 try/finally → 同步尾段拋錯永久鎖死

## 1. Bug 定義
評分後若同步尾段任何呼叫拋錯（easter-egg DOM/JSON.parse、generateOptions、engine 內部
呼叫等），模組級 `_ratingLock` 永停 true：
- 後所有評分在 `if (_ratingLock) return` 靜默丟棄（無 toast、無錯誤面）；
- undo 頭部同款檢查（C8 引入雙向互斥）**同被鎖死** → 評分＋undo 雙路徑癱瘓；
- 唯一解脫＝重進頁面（模組級變數，連 undo 快照一起丟）。

## 2. Root cause（2026-08-28 實錘，含 C9 併入後漂移行號；稽核單原標 :94-131）
- `session-utils.js` rateCard :92-139：鎖取得 :94-95；try/catch 僅包 `await store.actions.rateCard`
  （:99-105，catch 手動釋放 :103）；**同步尾段 :106-136 完全裸奔**，鎖釋放單點 :137。
  （:128-132 `checkStudyMessages/checkMilestone/checkAchievement`
  （easter-eggs.js：showMilestone 純 DOM 操作、checkAchievement :47/:49 兩處裸
  `JSON.parse(localStorage…)` 髒資料即拋——R1#2 覆核屬實：`_achievements` 無防呆寫端）。
- `session-mc-utils.js` :108-155：同構裸奔段，獨有拋源 `generateOptions`（呼叫實位 :149，
  下一題出題；v1.0 誤標 :146＝R1#1 登記漂移）。
- `session-spell-utils.js` :104-144：同構裸奔段（無 easter-egg/generateOptions，但
  session.rate/next/requeueIntraday/computeIntervals 任一拋錯同死）。
- 註：undoRating 側 C8（commit 52da2df）已有 try/finally——**本單即補 rateCard 側的對稱缺口**。

## 3. 修法（三同構檔各 1 重構，結構鏡像 C8 undoRating：finally 釋鎖＋renderFn 出 try）
rateCard 鎖取得之後全包 try，finally 釋鎖；存檔失敗 catch 改「toast＋return」（釋鎖交 finally）；
renderFn 留在 try 外（return 路徑不渲染之現行語意保持）：
```js
  _ratingLock = true;
  const wid = …; const t = …;
  try {
    try {
      await store.actions.rateCard(wid, rating, t, 'flip');
    } catch (err) {
      toast('儲存失敗', 'toast-error');
      return; // C10: 釋鎖交 finally
    }
    …同步尾段原樣（increment 鏈、快照、rate、requeue、next、checks、state、intervals、log）…
  } finally {
    _ratingLock = false; // C10: 任何路徑釋鎖（原手動單點——尾段拋錯＝評分+undo 雙鎖死）
  }
  renderFn();
```
行為等價論證（除拋錯路徑外逐路徑對照）：
- 正常路徑：原「释放→renderFn」＝新「try 完→finally 釋鎖→renderFn」。等價（鎖釋仍先於渲染，
  C3 M-2 語意保持）。
- 存檔失敗：原「toast→釋放→return（不渲染）」＝新「toast→return→finally 釋鎖（跳 renderFn）」。等價。
- 尾段拋錯：原「異常上拋＋鎖死」→ 新「異常上拋（不变，不吞錯）＋鎖釋」。＝本修復本身。
- renderFn 拋錯：原「已釋鎖＋上拋」＝新「finally 已釋＋上拋」。等價。
縮排為主要 diff（尾段整體進 try），邏輯行改動＝內 catch 去手動釋放、外層 finally 新增、
尾段尾行 `_ratingLock=false` 刪除——三檔同構。undoRating 零改動（C8 已閉合）。

## 4. 驗證方式（tools/verify-c10-lock-finally.mjs）
注入點（確定態、無時間擡測）：
- 主注入（三檔通用）：mock.module session-v4.js 包裹 `Session.next()`——武裝式單發拋錯
  （僅評分窗口武裝，構造期不觸發；next() 在快照生成之後、鎖釋放之前＝必中裸奔段）。
- 輔注入（flip 專屬、語意忠於稽核單「easter-egg throw」）：mock easter-eggs.checkMilestone 拋錯。
斷言面（LEGACY＝現 HEAD 含 C9 / FIXED）：
- T1 flip 主鏈：武裝 next 拋 → rateCard 必 reject（屬性釘兩態：不吞錯）→ 解除武裝後
  重評：store.rateCard spy 增量（LEGACY=0 鎖死吞 / FIXED=1）＋ log +1 ＋ renderFn 呼入。
- T2 連坐釘（辨證）：拋錯後按 Ctrl+Z——undoLastRating spy（LEGACY=0 雙路徑鎖死實錘 / FIXED=1，
  快照在 next() 前生成故 undo 有靶）。
- T3 mc 同構（next 注入）：鎖死吞評＋重評恢復。
- T4 spell 同構。
- T5 flip easter-eggs 拋源（checkMilestone 拋 → 重評恢復）。
- T6 靜態標記：三檔 `// C10:`（LEGACY=0/FIXED=1）。
- T7 反覆拋錯抗性：拋→恢復→再拋→恢復→第三次評分成功＋undo 正常（鎖無累積泄漏）。
- T8 正常路徑不傷釘（兩態恆綠）：無拋錯 rate→undo→rate 全對（finally 雙重釋放不破 C8 互斥、
  renderFn 呼入次數正確、log 淨）。
- T9 渲染時序＋重入探測釘（R1#3 盲區封堵，兩態恆綠＋結構變體紅）：renderFn spy 內同步採樣
  `u.state`（必 QUESTION，非評分前 ANSWER 殘留＝封 renderFn 提前變體之 stale render）＋
  採樣 `session.current.word.id`（必非剛評卡）＋ renderFn 內同步重入 `rateCard` 以 rateCalls
  spy 增量探鎖（`await f()` 之 f() 掛起前同步執行＝push 同步可觀測；必 +1＝鎖釋先於渲染，
  封「renderFn 進 try、finally 後置」變體之渲染期持鎖。undo spy 不可作同步鎖探針——其位於
  undoRating 內 `await _goalPending` 微任務之後，v1.1 實測登記）。
- T10 結構忠實靜態釘（封「只包 await 段＋finally」結構違約變體）：三檔 rateCard 段斷言
  ① `finally` 塊含 `_ratingLock = false`；② 外層 try 起點索引 < `_undoSnapshot =` 快照賦值索引
  （尾段確在 try 內）；③ 最後一個 `finally` 閉合索引 < `renderFn()` 呼叫索引。
  （LEGACY=0/FIXED=1；與行為釘分層——行為釘測死鎖封堵，本釘測結構忠實。）
- 負控制：/tmp HEAD 三檔覆蓋跑 `--expect-legacy` ALL PASS；未修碼正常模式紅集=辨證全集。
- 回歸組合拳：verify-c3/c7/c8/c1/c9 + node --check×3 + vite build。

## 5. 風險
- finally 覆蓋 await 拋錯：await 區間本僅存檔 await（其 catch 已處理），finally 不吞錯只釋鎖，
  零新異常面。
- try 起點前陳述式（R1#1 問二補證）：鎖取得與 try 之間僅 `const wid = session.current.word.id`
  與 `const t = Math.max(0, Date.now() - …)`——`!session?.current` 已於頭部守門、`word.id` 為
  構造必存在欄位、Date.now/Math.max 不拋 → 必不拋陳述式，窗口閉合（R1#1 實讀確認結構屬實）。
- 鎖釋放視窗微變：正常路徑「鎖釋→renderFn」順序不變（finally 在 renderFn 前）。
- 尾段拋錯後狀態半進位（next 已跑、state 未指派＝ANSWER 殘留）：與現行完全相同（本單只修鎖
  生命週期，不動錯誤後狀態一致性——完全復原属範圍外 §6）。

## 6. 範圍外清單（憲法⑥）
- 拋錯後 session 狀態一致性（半進位續命/錯誤邊界重建）：另立單。
- easter-eggs 自身健護（JSON.parse 防呆等）：G4 域延伸。
- toast/渲染層異常吞併策略：不動（本單維持異常上拋語意）。
- undoRating finally：C8 已修，非本單。

## 7. 可選項定案（憲法⑦）
- （做）鏡像 C8 結構（finally＋renderFn 出 try）而非「尾段每處 try/catch」：單點收口、
  三檔同構、與 undoRating 對稱可讀。
- （做）不吞異常（僅 finally）：靜默吞 easter-egg 錯誤會掩蓋真 bug（誠實歸責原則）。
- （不做）錯誤後自動重建 session → §6。
- （不做）把尾段包成獨立函式 → 為縮排 diff 掩蓋邏輯面，違最小改動。

## 8. 審查紀錄
### R1（三委員，v1.0）
- **#1 修法正確性 ✅**：root cause 實讀屬實（行號顯微漂移已錄 §2：flip try/catch 實 :99-105、
  mc generateOptions 呼叫實 :149）；四路徑等價逐條查證無謬誤（含 JS finally-on-return 語意實測、
  變異副本 /tmp/c10a 獨立覆現修法 22/22 全綠）；同構穷举 24 matches 恰三檔無第四鎖；
  C8/C9 互斥不破壞（check→acquire 原子對、_goalP 不在鎖保護域）；附帶改善登記（原 catch 內
  toast 若拋反而鎖死，修法後 finally 兜底嚴格更好）。發現：§5 try 前窗口補證（已錄 v1.1）。
- **#2 消費者穷举 ✅**：`_ratingLock` 無匯出、讀者恰三檔；rateCard 呼叫面恰 6 點全在 mount 內
  （click await 無 catch＋keydown fire-and-forget）——rejection 僅 unhandledrejection console
  紅字，監聽註冊鏈路零影響（呼叫點皆分支末語句，無二次傷害）；easter-eggs 另一呼叫者僅
  main.js:368 initKonami（鎖零交集）；undo 誤放跨幀不可能（單線程＋單幀配對論證）。
  登記：click 路徑「拋後評分鈕殘 disabled」既存紋裂（LEGACY/FIXED 同款，屬 §6 半進位域，
  非本單引入）。
- **#3 測試品質 ✅ 有條件**：基準復現全中；變體牙檢——C 吞錯棄案 12 紅雙重公正否定、
  D 漏修 mc/spell 4 紅精準、E 挪快照唯 T8 逮（凸顯正常路徑釘價值）、F noop-finally 10 紅
  （T6 綠但行為釘兜底＝不淪 marker-grep）；注入偽綠通道排查（arm 消費探針）＝完整。
  **盲區三形（全綠）**：A1 renderFn 進 try＋finally 後置（渲染期持鎖）、A2b renderFn 提前
  （stale render）、B 只包 await 段＋finally（結構違約、行為等價）。必補：渲染時序釘、
  鎖釋先於渲染重入探測釘、結構忠實靜態釘。
### v1.1 響應
- §2 行號漂移修正＋R1#2 覆核證據補錄；§5 try 前窗口必不拋論證補錄。
- §4 新增 T9（渲染時序＋重入探測，封 A1/A2b）、T10（結構忠實靜態釘，封 B）——#3 建議三條全採。
### R2（#3 複審，v1.1）
- **✅ 放行動工**（四變體全實跑於 /tmp 副本）：基準復現中（--expect-legacy 全綠、正常模式紅集
  含 T10×3、T9 恆綠零誤報）；手套正確修法全綠基準確立。變體紅分布：**A1**（renderFn 進 try
  ＋finally 後置）→ T9 鎖探針紅＋T10 紅（R1 盲區閉合）；**A2b**（renderFn 提前）→ T9 三釘紅
  （R1 盲區閉合）；**B**（只包 await 段＋finally）→ 純 B 行為釘如實綠（行為等價如 R1 登記）但
  加註釋變體 T10 紅 7/28（結構釘生效）；**G**（catch-all 吞錯）→ T1/T3/T4/T5 上拋屬性釘紅
  （腳本不奖励吞錯）。T9 探針改 rateCard 重入之登記與腳本實裝一致（誠實）。
- 勘誤（非阻斷，v1.1 順登）：斷言總數實測 27（--expect-legacy）/28（正常+undo 連坐綠路徑行），
  v1.1 文內「26」為漏計；§2 mc 段起點 :108→:107。
