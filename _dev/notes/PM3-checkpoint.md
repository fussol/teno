# PM3 檢查點 — 2026-08-29（session 预算熔斷交接）

## 本 session 結案（五欄摘要）
- F14 | 19edaf9 (v5.2.6) | 接手前 session R1-R5 閉合態＋本 session 全套復跑復核 | verify-f14 38/38＋mutation-replay 4 變異全 RED | _dev/notes/F15-fix-plan.md 同軌，F14 紀錄 _dev/notes/subagent-log/2026-08-28-F14.md
- F15 | 1695638 (v5.2.9) | R1 三席 sequential 全✅ 1 輪 3 人次 | verify-f15 雙態 18/18（動工前 9P/8F） | _dev/notes/F15-fix-plan.md
- F16 | fb2b217 (v5.2.10) | R1 單席✅（簡單 bug 降席）1 輪 1 人次 | verify-f16 雙態 16/16＋演化 verify-f15 18/18 | _dev/notes/F16-fix-plan.md

## 佇列總況（PM3 任務書 11 顆）
- ✅ 已有 fix commit：F9 (6cd51c9)、F12 (81125ff)、D16 (0096e88)、D17 (7b1e9c6)、
  F13 (776cb5c)、F14 (19edaf9)、F15 (1695638)、F16 (fb2b217)
- ⏭️ SR 登案跳過（白名單外，非本軌可解）：D5 → D5-SR1（api.js checkpoint→backupDb
  單點封頂，scope-requests.md 在冊待裁示）；F10 → F10-SR1（Kotlin copyUriToCache
  DISPLAY_NAME，patch 封存 _dev/notes/F10-pending.patch＋verify 23/23 綠在冊）
- ⬜ **唯一殘題：F19**（下任首相直接開工）

## F19 下一步（偵察已完成一半）
Bug：simulate_fsrs `today_days` UTC 天數 vs Anki 當地日界線 → 跨時區 ±1 天偏差。
代碼事實（2026-08-29 現行態 fb2b217，審計行 1055 已漂移）：
- lib.rs:1118 `let today_days = (now / 86400) as f32;`（UTC epoch days）
- lib.rs:1126 `due_day = c.due_ms.map(|ms| (ms / 86400000) as f32 - today_days)`
  ＋ last_date=(due_day - interval).min(0.0) 連動
- 同函式 :1084-1088 已算 `next_day_at = compute_next_day_at(now, tz_secs, cutoff)`
  （:1039-1048，當地午夜＋cutoff 語意正確）＝**雙參考系混用**：next_day_at 走
  當地界線、today_days/due_day 走 UTC 午夜。tz≠0 或 cutoff>0 使用者 cards 初始
  due/last_date 全部錯位一天（revlog 端 extract_simulator_config 吃 next_day_at
  正確；錯位面＝existing cards 群）。
修法方向（計畫書要精算）：today_days 改當地 cutoff 系＝`((now + tz_secs -
cutoff_secs) / 86400)` 語意（= Anki timing_today().day 定義），due_ms 端同基準
換算；注意 f32 精度與負時區 floor 語意（Rust / 是截斷非 floor，负值要 div_euclid）。
驗證：純函式抽出可 unit test（compute_next_day_at 已有同款體例＋既有 fsrs 測試群
42 顆計數釘同 F16 演化流程）；負控制＝UTC/tz 對照表（東八區凌晨＋西五區晚間
cutoff240 場景 due_day 差一天精準重現）。**注意**：simulate 域＝FSRS 核心 →
委員一律 3 名（鐵律②不降席）；sim_tests 3 條預存紅＝外部 fixture 缺失（F14 log
R1#3 認定非本帳，驗 T4d 容 f≤3 同款）。
白名單內（lib.rs 本體＋tools/verify-*＋tests/），可直開計畫書 F19-fix-plan.md。

## 環境/治理備忘（本 session 新學）
- 版本機械閘：commit-msg hook（.githooks/，b09a3a1）——code 路徑 commit 必須
  `./tools/version.sh patch`＋三檔 staged；[skip-version] 需總統同意（本軌未用）。
  本軌連帶把 F14-SR2 結案（登 scope-requests 已改「✅已結」——注意共享檔未 staged
  屬工作區態，總統收檔時見）。
- cargo test --lib 基線＝42 tests，39 pass／3 fail（sim_tests fixture 預存紅）。
- NDK env 四件套＋PATH ~/.cargo/bin：android cargo check 必需（F16 腳本頭有範本，
  F19 腳本直接抄）。
- 共享 repo 並行極度活躍（本 session 期間 hea落 F6/D6/D11 等他軌 commit×3+，
  F15 審查期 HEAD 還從 8a35026 跑到 57df06a）：commit 前 `git log --oneline -2`
  ＋ version.sh 前必查 HEAD 版本（本 session 曾因 D6 搶升 5.2.8 而自動接 5.2.9，
  無損但要知道會發生）。
- scope-requests.md 共享髒檔：本軌已追加 F15-SR1/F16-SR1/F14-SR2 結案行（未 staged
  屬預期，嚴禁 add）。
- delegate 委用HF端點 429：委員 sequential 派（F15/F16 流程照走無熔斷）。
