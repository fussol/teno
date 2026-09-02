# F5 修復計畫 v1.2（v1 凍結送審→v1.1 R1 採納→v1.2 R2 補針，歷程見版本紀錄）

## 1. Bug 定義（audit 2026-08-13:108）
> F5 IconPlugin.kt:93-160 🟠 resolve=ResolverActivity 時清理不執行、
> getCurrentIcon fallback 對 DEFAULT 誤判

## 2. 實錘（基線＝F4 commit ace9306；行號以現檔為準）
檔案 `src-tauri/gen/android/app/src/main/java/com/teno/app/IconPlugin.kt`。
manifest 事實（AndroidManifest.xml 實讀）：Icon1 `enabled="true"`、Icon2..20 `enabled="false"`
→ **DEFAULT 態對 Icon1＝active、對 Icon2..20＝inactive**（setComponentEnabledSetting 未設過回 DEFAULT）。

| # | 宣稱/挖出 | 实錘 | 位置（ace9306 版） |
|---|---|---|---|
| ① | resolve=ResolverActivity 清理不執行 | **真（死鎖環）**：`load()` 清理閘 `if (resolvedIsAlias)`——清理需求最熾熱時（多 enabled）恰是 resolve 失去信任時 → 殘留永不自癒。產生路徑：setIcon 排程成功後 process 被殺（finish 前）→ target+runningComp 雙 ENABLED → 下次啟動 ResolverActivity → skip → launcher 雙圖示+點擊出選擇器 | load 清理段（原 audit :117-131） |
| ② | DEFAULT 誤判（load） | **真**：`state != DISABLED → enabledList.add` 把 Icon2..20 的 DEFAULT（實為 inactive）計入 active；label `"default(=active)"` 對 Icon2..20 錯。場景：備份恢復/清除設定後 runtime 設置清空 → 全表 DEFAULT → enabledList 虛報 20 個 | load dump 段 |
| ③ | DEFAULT 誤判（getCurrentIcon） | **真（挖深）**：fallback `firstOrNull(st==ENABLED)` (a) 漏 Icon1 DEFAULT（僥傯正確靠的是兜底字串 "original"，非查實）(b) ResolverActivity 時取 **aliases 順序首個 ENABLED**（original 優先），不是使用者實際在跑的 component | getCurrentIcon fallback 段 |
| ④ | 挖出：自癒閘與 ② 連動 | enabledList 用錯定義 → 自癒「全 disabled」判定在 DEFAULT 海洋中永不觸發（僥傯：Icon1 DEFAULT 真 active 時不需自癒；但 Icon1 被 runtime DISABLED＋其餘 DISABLED 時 enabledList 確為空→觸發，語意湢巧正確） | load 自癒段 |

## 3. 修法（只動 load() dump/自癒/清理三段＋getCurrentIcon）
1. **单一事實源 helper**：`private fun isComponentActive(name: String): Boolean`＝
   `st==ENABLED || (st==DEFAULT && name == DEFAULT_ALIAS)`，`DEFAULT_ALIAS="com.teno.app.MainActivityIcon1"`
   （僅 Icon1 manifest enabled=true）。附註解釘 manifest 對照責任。
2. **load() dump 段**：label 如實化（DEFAULT → `default(=${name==DEFAULT_ALIAS?"active":"inactive"})`）；
   enabledList 改 `filter isComponentActive`。
3. **load() 清理段重構**（治①死鎖）：移除 `resolvedIsAlias` 前置閘，改**狀態掃描**：
   - `keep = runningComp`（若 ∈aliases 且 active）；否則 keep = active 清單中第一個 ENABLED；
     否則 null（無可留）。
   - 對每個 name：`name != keep && st==ENABLED` → disable（**只動 runtime ENABLED**，
     不碰 DEFAULT——DEFAULT 對 Icon2..20 本就 inactive；Icon1 DEFAULT 若 keep=null 亦不動
     （它是系統最後入口，disable 它违反「MainActivity 本體永不 disabled」同源原則））。
   - resolvedIsAlias 時 keep 優先取 resolvedName（resolve 唯一＝系統答案最準），其餘同上。
   - 日誌如實（`cleanup keep=$keep disabled=[...]`）。
4. **getCurrentIcon fallback 重構**（治③）：順序 = runningComp(∈aliases) → resolvedName 若 alias
   → 首個 runtime-ENABLED → Icon1 DEFAULT 檢查 → "original" 兜底。
5. 可選項裁示：**不做** load 清理對 DEFAULT-Icon1 的 disable（保 launcher 入口底線）；
   **不做** 清理排程到下次啟動（本輪同步清理＝現行時序，縮小改動）。

## 4. 驗證（Kotlin 真機不可行 → 靜態釘＋編譯閘，比照 F4 範式）
`tools/verify-f5-icon-cleanup.mjs`（SRC env＋strip 域＋錨點 fail-loud）：
- T0 PRE：b4cc444/ace9306 基線正宗釘——`if (resolvedIsAlias) {` 清理閘、`state != DISABLED`
  enabledList、fallback 無 runningComp 引用。
- T1 isComponentActive 在位：ENABLED＋(DEFAULT && DEFAULT_ALIAS) 語義結構釘＋DEFAULT_ALIAS 常量＝Icon1。
- T2 清理不再被 resolvedIsAlias 短路：清理迴圈對 resolvedIsAlias=false 路徑可達（結構釘）。
- T3 清理只動 runtime ENABLED：清理段無 DEFAULT disable（`doesNotMatch` DEFAULT 於 disable 呼叫路徑）。
- T4 getCurrentIcon 優先序：runningComp 引用先於 firstOrNull(ENABLED)。
- T5 enabledList/dump 用 isComponentActive＋label 如實（無 "default(=active)" 一刀切字串）。
- NC1/NC2：還原 resolvedIsAlias 閘 → T2 紅；fallback 去 runningComp → T4 紅。
- 編譯閘 gradle --rerun-tasks；回歸 build＋verify-f4 全套。
- **語義 harness**：以 JS 重構狀態機偽碼決策表（輸入 20×{ENABLED,DISABLED,DEFAULT}×resolved×running
  → keep/disable 集）——對 4 關鍵場景斷言（雙 ENABLED 殘留／備份恢復全 DEFAULT／Icon1 被殺自癒／
  正常單 active）——決策表由 Kotlin 碼逐行轉寫，登記轉寫風險（非同源執行）。

## 5. 風險
- 清理語意改變：PRE「ResolverActivity 一律不動（保守）」→ POST「掃描後動」——誤殺風險由
  「只 disable runtime ENABLED＋保留 keep」約束；最壞誤殺＝使用者重點圖示可恢復（icon 非資料）。
- DEFAULT 態僅 Icon1 特殊——manifest 未來加新 alias 若忘 enabled="false" → 新 alias DEFAULT=active
  但 DEFAULT_ALIAS 常量只認 Icon1 → isComponentActive 誤判其 inactive → 不會誤 disable（只動
  runtime ENABLED），僅 getCurrentIcon 可能少認——安全方向錯誤，登記＋T1 註解釘。
- getCurrentIcon 改 runningComp 優先：activity.intent.component 對 alias 啟動回 alias 名（F4 同源事實）。

## 6. 範圍外清單
- setIcon 區塊（F4 域，已修）；TtsPlugin/lib.rs（他軌）；load() MainActivity 修復段（現行正確）。
- settings.js:823 投機寫入 DB（R2 殘留，JS 域另單）。
- launcher 快取延遲（第三方 launcher 行為，不可控）。

## 版本紀錄
- v1（本檔）：首版送審。凍結。
- v1.1（R1 結果 ✅❌✅ → #2 四必須項＋兩席建議修畢）：
  - 【R1#2 必須① 採納】T3 guard 窗口 500→200＋真 guard 形釘（`st == ...ENABLED`）——
    b 攻擊（disable 前置回潮 `st!=DISABLED`）曾 9/9 假綠（500 窗吞進 keep-else 的
    ENABLED 比較造出假 guard），修後精準 T3 單點紅（自證）。
  - 【R1#2 必須② 採納】T2 補 load keep running 分支釘＋runningIsAliasActive 三元定義釘
    ——c 攻擊（刪 running 分支）曾假綠（T4 只管 getCurrentIcon，load 側純缺口），修後紅。
  - 【R1#2 必須③ 採納】T2 堵否定式閘變體（`if (!resolved…)`／`.not()`／定義→迴圈間
    return 結構釘）——d 攻擊（early-return 繞過掃描）曾假綠＝最重一擊，修後紅。
  - 【R1#2 必須④ 採納】SPEC S3 修表 keep null→Icon1＋decide() 改 live 模型
    （自癒 mutate 先於 keep）——原表與碼（live-read）矛盾，表與碼只留一個真相。
  - 【R1#1 S1＋R1#2 建議3 採納·代碼】getCurrentIcon runningComp 支路補 isComponentActive
    （與 load 對齊）；keep resolvedActive 分支補 active 查——堵 fuzz B 類
    「瞬態 resolve 把剛自癒 Icon1 回殺」（真機不可達但模型縫合）。
  - 【R1#3 S1/S3 採納·文字】§3.3 keep 優先序措辭改正：running-first（原文字 resolved-first
    與實作矛盾）；§4「逐行轉寫」措辭對齊腳本「規格測試」立場。
  - 【R1#3 S2 採納】§2 表 ② 補標「PM 擴充（audit 原宣稱僅 getCurrentIcon）」。
  - 【R1#2 建議1 採納】NC1/NC2 重寫為真突變負控（注入 d/c 攻擊原樣→斷言釘必命中），
    原恆真 NC（early-skip＋近永真式）全滅；建議2 maxLen 4000→6000。
  - 驗證 9/9＋b/c/d 三攻擊變體收斂單點紅自證；gradle --rerun-tasks 真編譯綠；
    回歸 verify-f4 11/11、build 綠。
  - R1#2 未明示逕判 ✅→仍單席複核（F17 判例，複核僅驗處方落實＋攻擊重現）。
- 【R1 登記項（不修）】「Icon1 DEFAULT＋Icon2 runtime ENABLED」受限自癒邊界（DEFAULT 永不
  disable 之計畫裁示 §3.5 後果，非 PRE 劣化）；getComponentEnabledSetting 重複 binder 讀
  ~40 次/啟動（可快照化，性能非正確性）；launcher 第三方快取延遲。
- 【R2 單席 ✅（c1，F4 判例複核）】處方六項全落實；d/c/b/a 四攻擊收斂單點紅；
  --rerun-tasks 66/66 真編譯綠。新攻擊 e（keep-else 偷翻 != DISABLED）/g（偷簡 runningComp
  active 查）逃網→當輪吸收（僅動腳本，代碼零變動）。紀錄 subagent-log/2026-08-28-F5-R2-c1.md。
- v1.2（R2 ✅ 後順手補針，非阻斷建議全採納）：
  - T2 加 keep-else 定義形釘（禁 != DISABLED 變體）→ 攻擊 e 收斂 T2 單點紅實測。
  - T4 加 runningComp 支路 isComponentActive 形釘（原或式釘因 "original" 常駐近恆真）
    → 攻擊 g 收斂 T4 單點紅實測。
  - NC1 偵測正則提共用 const NEG_GATE_RE（T2/NC1 複製品漂移防範）。
  - 補針後雙態復跑：PRE 5/9（紅集不變 T1/T2/T4/T5）＋POST 9/9 綠＋a-d 攻擊紅域不變。
