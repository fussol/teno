# F4 修復計畫 v1（凍結送審）

## 1. Bug 定義（audit 2026-08-13:107）
> F4 IconPlugin.kt:231-257 🟠 alarm requestCode 0 無 cancel、finish 在 try 外、
> 停用 running alias 的 disabled-package race

## 2. 實錘結果（行號零漂移：`git diff b4cc444..HEAD` 對本檔為空；audit 行號即現行）
檔案：`src-tauri/gen/android/app/src/main/java/com/teno/app/IconPlugin.kt`（264 行）

| audit 宣稱 | 實錘 | 說明 |
|---|---|---|
| alarm requestCode 0 無 cancel | **✔ 真** | :238-241 `getActivity(activity, 0, restart, IMMUTABLE\|UPDATE_CURRENT)`，Intent 帶 `setComponent(各目標)` → **每個目標是不同的 PendingIntent**（PI 匹配比對 intent filterEquals，component 不同即不同 PI）。UPDATE_CURRENT 只覆蓋「同一目標重設」，**舊目標的已排定 alarm 永不取消**。1.2s 窗內快速切 a→b→c → 累積 3 條 restart alarm 依序觸發，app 被連環重啟、最終圖示非預期 |
| finish 在 try 外 | **✘ 不實**（登記） | :254 `activity.finish()` 在內層 try（:233-257）內，audit 掃描時點＝HEAD 零漂移。誠實登記為不實；但同族真缺陷見下一行 |
| disabled-package race | **◐ 部分真（形態不同）** | 順序 alarm先/disable後 正確（:245→:249）。真洞三處：**(a)** 排程失敗（SecurityException 等）→ catch(:255) 無條件吞掉且**不回滾**：此時 target 已 enabled（:206）、其他 alias 已全 disabled（:215 迴圈）、runningComp 仍 enabled → **殘留雙 enabled** → launcher resolve 歧義（ResolverActivity，F5 域但由 F4 路徑產生）＋ JS 已收 ok:true 誤判成功；**(b)** `setAndAllowWhileIdle(RTC, System.currentTimeMillis()+1200)`(:245) 用**牆鐘**——使用者改系統時間/時區同步 → alarm 永不到點或立即觸發（與 G9 T9 同族時鐘缺陷）；**(c)** finish() 若在 disabling 连锁中被系統抢先 finish，冪等無害（不修，登記） |

## 3. 修法（僅動 setIcon，IconPlugin.kt）
1. **統一 PI 構造器**：private fun `restartPending(name: String, flags: Int)` 集中
   `Intent(ACTION_MAIN)+CATEGORY_LAUNCHER+setComponent+NEW_TASK` 構造（確保 cancel 探測
   與排程的 Intent 逐欄位一致——PI 匹配不含 flags，但 action/category/component 必對齊）。
2. **排程前掃蕩 cancel**：排新 alarm 前，對全部 20 個 alias 用
   `restartPending(n, FLAG_NO_CREATE)` 探測——非 null 者 `am.cancel(pending) +
   pending.cancel()`。保證任一時刻至多一條 restart alarm。（全掃而非只 cancel 現行
   resolved：因舊 alarm 目標無記憶，掃蕩是唯一機械性完備解。）
3. ** elapsedRealtime 換掉牆鐘**：`setAndAllowWhileIdle(ELAPSED_REALTIME_WAKEUP,
   SystemClock.elapsedRealtime() + 1200, pending)`（import android.os.SystemClock）。
4. **失敗回滾**：內層 catch 補救——`setComponentEnabledSetting(target, DISABLED)` 回滾
   （回到切換前唯一 enabled=runningComp 的乾淨態，launcher 仍可正常啟動）＋ Log 如實。
   catch 內回滾再包 try（回滾自身失敗只 Log）。
5. **payload 誠實化**：resolve payload 加 `restart: <bool>`（排定重啟=true；running 非
   alias 不需重啟=false）。向後相容（JS 端 :46 fire-and-forget 不讀額外欄位）。
6. 可選項裁示：**不做**「成功路徑也 pending.cancel()」——alarm 觸發後 PI 自然失效，多餘
   呼叫無效操作；**不做** JS 端 restart 欄位消費（UI 決策屬範圍外）。

## 4. 驗證方式（機械性，真機不可行 → 靜態釘＋編譯閘＋語義 harness）
`tools/verify-f4-icon-restart.mjs`（PRE pin 前 HEAD；正則解析 Kotlin 源）：
- T0 PRE：PRE 版含 `requestCode 0 + 無 cancel 跡象（getActivity(...,0,...) 且全檔無
  AlarmManager.cancel/FLAG_NO_CREATE）`＋RTC+currentTimeMillis 排程＋catch 內無 setComponentEnabledSetting
  （回滾缺失）——紅基線。
- T1 掃蕩 cancel 在位：全 alias 迴圈＋FLAG_NO_CREATE＋am.cancel 組合釘。
- T2 ELAPSED_REALTIME：`ELAPSED_REALTIME_WAKEUP`＋`elapsedRealtime()`＋不得再出现
  `RTC`+`currentTimeMillis()` 排程組合。
- T3 失敗回滾：內層 catch 塊內必含 DISABLED 回滾呼叫（解析 catch 括號塊）。
- T4 統一構造器：getActivity 呼叫點全走 restartPending（grep `getActivity(` 於 setIcon
  內只允許 helper 一處）。
- T5 payload restart 欄位＋T6 順序釘（am.cancel 段在 setAndAllowWhileIdle 前；
  setAndAllowWhileIdle 在 disable runningComp 前——防回歸打亂）。
- T7 finish 仍在 try 內（防「修 ②不實宣稱」時反向弄壞）。
- NC1/NC2 負控制：只換回 RTC / 只拿掉回滾 → 對應斷言精準紅。
- **編譯閘**：`JAVA_HOME=~/jdk21 ./gradlew :app:compileArmDebugKotlin --offline` 必過
  （Kotlin 型別/import 正確性以編譯為準）。
- 回帰：既有 verify-* 全套＋npm run build（本檔 JS 零關聯，防误傷）。

## 5. 風險
- FLAG_NO_CREATE 探測依賴 PI Intent 構造一致性 → T4 統一構造器釘強制（发散必紅）。
- ELAPSED_REALTIME_WAKEUP 語意：深睡喚醒觸發（RTC 版在 Doze 下本就可能延後）——行為
  變好不變壞；無需 SCHEDULE_EXACT_ALARM（non-exact，現行註解已論證）。
- 回滾 disable target 極小窗口：使用者在 catch 後立刻按 home 看 launcher——顯示舊圖示
  （正確，因為確實切換失敗）。
- 真機行為（連環重啟消失）無法本地實測——以 code 事實＋靜態釘＋編譯為準（PM5-MISSION
  明示允許），危害場景（多 alarm 累積）在 PRE 碼為確定性事實。

## 6. 範圍外清單
- F5（ResolverActivity 清理跳過＋getCurrentIcon DEFAULT 誤判）——下一顆独立 commit。
- load() 區（:100-131 自癒/清理）——F5 域。
- getCurrentIcon（:136-160）——F5 域，本 commit 零動。
- SCHEDULE_EXACT_ALARM 精確排程（需求不存在）。
- JS 端 icon 切換 UI 反饋（restart 欄位消費）。

## 版本紀錄
- v1（本檔）：首版送審。凍結。
- v1.1（R1 結果 ✅❌✅ → #2 四必須項＋#1 建議項修畢）：
  - 【R1#2 必須① 採納】T1 探測引數 backreference 綁定迴圈變數——e2 變體（探錯
    target.second＝掃蕩壞死原 bug 復活）曾 10/10 假綠，修後精準 T1 單點紅（自證）。
  - 【R1#2 必須② 採納】T2 時鐘型別＋運算釘進 setAndAllowWhileIdle 同一實參位址，
    負向 `RTC\b`（含 RTC_WAKEUP）——c2 死變數偽裝變體曾全綠，修後精準 T2 單點紅（自證）。
  - 【R1#2 必須③ 採納】T7 改 strip 域（doc 註解提及 finish 不再假紅）。
  - 【R1#2 必須④ 採納】NC1 guard 讀 KT＋刪恆真死斷言＋「其餘不受染」改實釘
    （cancel 完備性＋reject 出口連動檢查）。
  - 【R1#1 建議·高 採納】探測 flags 補 FLAG_IMMUTABLE（與排程 PI 同 mutability，零行為變化）。
  - 【R1#1 建議2＋R1#3 S1 採納】回滾出口 resolve(ok:true)→**reject("restart scheduling failed")**：
    實錘消費者 settings.js:827 await resolve 即 toast「重新啟動中…」，回滾態 ok:true 會說謊；
    JS try/catch 現成消化 reject→toast-error。新增 T8 釘。
  - 【R1#2 建議採納】T4 接受 ComponentName(pkg,name) 替代形（不变量＝單一構造點＋參數化）；
    釘契約頭註明示（構造經 helper、cancel 迴圈內聯，消 T1/T4 表面矛盾）；SRC 模式標題顯示。
  - 【R1#2 建議未採納·登記】blockAfter 字串感知跳脫——本檔實零觸發點（#2 自證），潛伏級；
    錨點 assert 移具名 test——analyze 內錨點 assert 已雙重覆蓋（T0 即會紅），不改模組級结构。
  - 【R1#1 登記】PendingIntent.cancel() API31 deprecation（36 仍可用）；非 alias running
    1.2s 窗不掃蕩（PRE 同態時序不可救）；Doze 節流延後（不比舊態差）。
  - 驗證 10→11 斷言全綠；e2/c2 攻擊自證收斂單點紅；gradle --rerun-tasks 真編譯綠。
  - R1#2 明示「修畢升版可逕改判✅」→ 依 F17/G9 判例單席複核。
