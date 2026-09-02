# F11 修復計畫書 v1

## Bug 定義
`src-tauri/src/drive_sync.rs` OAuth client secret（`GOCSPX-…`）與 client_id 硬編碼於原始碼（實錘行號 :43-44，audit 行號一致），任何取得 source repo 或 binary（字串可直接抽出）的人都能拿到這對 Google Cloud OAuth 憑證；同時 `save_creds`（:56-60）/`save_tokens`（:69-73）用 `std::fs::write` 落地 `drive_creds.json`/`drive_tokens.json`，權限跟 umask（典型 0644），同機任何使用者可讀取 refresh_token（等同 Drive 帳號长期存取權）。

## Root cause
1. :42-44 `DEFAULT_CLIENT_ID`/`DEFAULT_CLIENT_SECRET` 常数字面值硬編碼，`load_creds`（:46-54）在無憑證檔時直接回填這組預設值 → secret 進 source repo、進每個編譯產物。
2. `save_creds`/`save_tokens` 未設定檔案權限，依賴 umask（0644 常見）→ tokens/creds 明文世界可讀。

## 修法（檔案:行號，皆 drive_sync.rs，白名單內）
### 1. 移除硬編碼，改「選配」編譯期 env 注入（:42-44）
```rust
// F11: 憑證不再硬編碼。build 不依賴密件（option_env! 未設定照常編譯，值為 None→""）；
// 發佈者可選注入 TENO_DRIVE_CLIENT_ID / TENO_DRIVE_CLIENT_SECRET；
// 終端使用者經 設定→Google Drive 輸入，落地 0600。
// （R1#3-B1 採納：`option_env!().unwrap_or("")` 於 const 位置=E0658（Option::unwrap_or
//  non-const，rustc 1.96 實錘）；match 形為 const-eval 合法且字串確進 rmeta（委員實測）。）
const DEFAULT_CLIENT_ID: &str = match option_env!("TENO_DRIVE_CLIENT_ID") {
    Some(s) => s,
    None => "",
};
const DEFAULT_CLIENT_SECRET: &str = match option_env!("TENO_DRIVE_CLIENT_SECRET") {
    Some(s) => s,
    None => "",
};
```
- `option_env!` 是編譯期巨集：未設定環境變數時編譯照常（不依賴外部密件，符合任務書「務實可 build」）；設定了才把值嵌入 binary（發佈者自備 Google Cloud 專案的路線）。
- 未注入且未輸入憑證 → `client_id` 空字串 → 既有 `creds_valid()`（:75-78）回 false → `drive_status()` 回「未設定」→ 設定頁顯示憑證輸入區（settings.js:365-379 已有 Client ID/Secret 欄位與 `drive_save_creds`，前端零改動）。`drive_oauth`/`ensure_token` 既有空值檢查（:194-196、:265-267）直接給出引導錯誤訊息。
- client_id 一併移除：client_id 本身非密，但與 secret 成對、無獨立保留價值；一起走 env/使用者輸入，邏輯單一路徑。

### 2. 憑證/token 檔 0600（:56-60、:69-73）
新增 `write_private(path, s)`（R1#1 加固＋R1#3-B2 採納：import 補 `PermissionsExt`、殲滅未使用的 `MetadataExt`；fd 級收緊——`File::set_permissions` stable 1.74＞repo rust-version 1.77.2 OK，明文暴露窗口縮到 open→chmod，且免 path-based TOCTOU）：
```rust
#[cfg(unix)]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true).create(true).truncate(true).mode(0o600)
        .open(path)?;
    // .mode() 僅「建立」時生效；既有 0644 舊檔經 fd 顯式收緊（先 chmod 後寫，
    // 新內容不明文暴露；fd 版免 path TOCTOU——R1#1 建議採納）
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(s.as_bytes())?;
    f.flush()
}
#[cfg(not(unix))]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    std::fs::write(path, s) // Windows：依賴 NTFS ACL/使用者目錄，POSIX mode 無意義
}
```
`save_creds`/`save_tokens` 的 `std::fs::write(...)` 改為 `write_private(...)`。Android 同為 `cfg(unix)`，套用（app 私有目錄本就沙箱化，多一層 mode 收緊無害）。代碼形態釘死（R1 nit）：`#[cfg(unix)]` 屬性緊貼 `fn write_private` 行、中間無 doc 註解、unix 段在前——T6 提取器錨點依賴此形態。

### 3. 迴歸測試（同檔 `mod tests`，R1#1/#3-S1 採納：名稱統一到 verify T2 錨點）
- `f11_no_hardcoded_oauth_secret`：`include_str!("drive_sync.rs")` 自掃本檔（同檔 mod tests 自引用合法且入 cargo dep-info，改檔必重編——R1#1 屬實），斷言不含 Google secret 前綴與舊 client_id 前綴。**防自咬釘（R1#1 陷阱＋E14 同課）**：needle 一律拆串构造 `&format!("{}{}", "GOCSPX", "-")` / `format!("{}-", "880245257428")`——測試碼本身不得出現可被自身或 verify T1 掃描器命中的完整 token。
- `f11_write_private_0600`（cfg(unix)）：暫存檔先以 0o644 建立舊檔 → `write_private` 覆寫 → 斷言 `metadata().mode() & 0o777 == 0o600`；另測全新建立路徑亦 0600。

## 驗證方式
`tools/verify-f11.mjs`（送審前實跑，含負控制；雙態自適應：pre=未修法狀態跑「bug 在場釘」集，post=修法後跑全綠集，腳本偵測 `GOCSPX-` 在場與否自動選態）：
- T1 源碼靜態釘（post 斷言）：`drive_sync.rs` 零 `GOCSPX-` 子串、零 client_id 字面值 `880245257428-`、含 `option_env!("TENO_DRIVE_CLIENT_ID")` 與 `option_env!("TENO_DRIVE_CLIENT_SECRET")`、含 `fn write_private`、`save_creds`/`save_tokens` 函式體內零 `fs::write` 直寫 **且兩體內皆實際呼叫 `write_private(`**（R1#3-S2 採納：正向釘堵「定義了 write_private 但 save 繞道 File::create/OpenOptions 裸寫」的無意重構回歸——純負向 fs::write 掃描对此盲）。
- T2 單元測試牙：repo 內 `cargo test --offline drive_sync` 輸出必含新測試名 `f11_no_hardcoded_oauth_secret`、`f11_write_private_0600` 且全綠（pre 態斷言其缺席=修法未落）。
- T3 零憑證可編譯：`cargo check --offline`（未注入任何 TENO_DRIVE_* env）——「build 不依賴密件」直接證據。
- T4 注入真嵌入：`touch drive_sync.rs`（僅 mtime，強制重編，迴避 cargo 不追 option_env env 變動的既知問題）→ `TENO_DRIVE_CLIENT_ID=F11FAKEID TENO_DRIVE_CLIENT_SECRET=*** cargo check --offline` → 對 `target/debug/deps/` 新产物 **`/^(lib)?teno.*\.(rmeta|rlib)$/`**（R1#3-B4 採納：真實產物全為 `libteno-*` 前綴，原正則命中 0；check 只更新 deps/*.rmeta 不更新 top-level rlib，原計畫書文字同步修正）`grep -a` 必見假值（option_env! 真嵌入證明，非「編過就無感」假綠）；T4c 復位腿加 `fresh2.length>0` 非空守衛殲滅空集假綠。
- T5 負控制（恆常、防 post 腐化）：`git show 9e3116b:src-tauri/src/drive_sync.rs`（pin＝本波基線，F11 commit 落地後 HEAD 含新碼亦不朽化，F9 教訓）→ 對基線內容跑 T1 同一掃描器 → 斷言**精準紅集**（GOCSPX- 在場、client_id 字面值在場、option_env 缺席、write_private 缺席）＝掃描器有牙＋bug 於基線確實存在。
- T6 write_private 行為級微編譯：從源碼錨點切出 `fn write_private` 段＋組裝獨立 main（舊 0644 檔覆寫後收緊 0600／全新建立路徑 0600）→ `rustc --edition 2021` 單檔編譯實跑（純 std 零依賴，毫秒級）；harness preamble 必含 `MetadataExt`（R1#3-B3 採納：main 的 `metadata().mode()` 需此 trait，原 harness 缺import 必 E0599）＋`PermissionsExt`；NC 腿＝同 harness 改 `fs::write` → 斷言 0644 **精準復現**（證測試有牙，非永綠；委員已親測 umask 022 下 fs::write 覆寫既有 0644 檔＝644 保留、`.mode()` 對既有檔不生效——顯式 chmod 是牙的論述屬實）。
- T7 空值語意回歸釘（R1#3-B1/#2-N2 採納：原「`unwrap_or("")` 恰2」隨 match 形失效且計數脆）：釘 `const DEFAULT_CLIENT_ID` 與 `const DEFAULT_CLIENT_SECRET` 兩常量段各含 `option_env!(` 與 `None => ""`（行錨定，其他地方加 `unwrap_or("")`/`None => ""` 不误傷）；`creds_valid` 空字串守衛在場、`drive_status` 「未設定」分支在場（防未來某人把預設值加回去或改壞引導鏈）。
- 為何不採全檔 /tmp 副本 cargo test（v1 原案）：tauri 依賴樹全量重編分鐘~十分鐘級且共享 target 有鎖競爭；行為級牙由 T6 微編譯覆蓋、靜態面由 T1/T5 覆蓋、CI 級永久擋由 T2 的倉內單元測試承擔。
- 回歸義務：`cargo test --offline`（全量，drive_sync 4→6 + lib.rs 等既有測試不劣化）+ `npx vite build` + 既有 `tools/verify-*.mjs` 抽 3（d19/d7/e4）。

## 風險
- R1 既有使用者（本機無 `drive_creds.json`、一直在吃硬編碼預設值）升級後 Drive 狀態變「未設定」，須到設定頁貼一次憑證 → 一次性行為變更，為移除洩漏的必要代價；設定頁輸入框既存，摩擦極小。**R1#2-S1 補完（誠實化）**：(a) 受眾主體是「有 tokens 檔、無 creds 檔」者（用過 OAuth 從未手存憑證＝多數）；(b) 終端使用者手上沒有憑證可貼，需自建 Google Cloud OAuth client 或等發佈者 env 注入版；(c) 舊 refresh_token 綁定原 client_id，僅貼新憑證不重新登入的話 `ensure_token:214` 刷新會被 Google 拒（ureq 非 2xx→:217「重新整理憑證失敗」，該訊息不引導 re-login；access_token 未到期期間 drive_status 報「已登入」會跳過 re-login，使用者撞無引導錯誤直到 token 到期）→ 正確用戶路徑＝**貼憑證後重新走一次 drive_oauth 登入**；此為洩漏移除的既知代價，错误訊息引導語改進列範圍外。
- R2 副本 cargo check/test 需共享 registry cache；使用獨立 target 目錄與 `--offline`，不動 repo `src-tauri/target`，與並行首相零干擾。（v1.1 修訂後驗證不再開副本 target，此風險僅剩 repo 內增量編譯，與既有 PM 波次 cargo 用法相同；鎖競爭以 sleep 重試應對。）
- R3 `set_permissions` 對「檔案正被其他程序寫入」無 atomic 保障——本 app 單實例使用，風險可忽略（現況 `fs::write` 同樣非 atomic）。
- R4（SR 登記）發佈者注入 env 後改值未 `cargo clean` 時 option_env! 不重新求值：正解為 `src-tauri/build.rs` 加 `cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID/TENO_DRIVE_CLIENT_SECRET` 兩行，但 build.rs 在本首相白名單外 → **F11-SR1** 登 `_dev/notes/scope-requests.md` 待總統裁示。本修法不依賴它（驗證以 touch 強制重編證明嵌入鏈；發佈者臨時解為改值後 touch 源檔或 clean）。
- R5（R1#1-L1 採納，洩漏衛生）`_dev/notes/pm4.runner.log`/`pm4.spot.log` 之 diff 轉錄含舊 secret 完整值——已就地 scrub（`[REDACTED-F11-SCRUB]`）；spot.log 為 runner 即時轉錄本會隨會話讀檔回血 → **F11 commit 波前最終 scrub 一次且 pm4 兩 log 不入 commit**；secret 已存於 git 歷史（9e3116b 及更早），輪換仍是唯一根治（範圍外清單，交付通知必列）。
- R6（R1#3-S3 裁決記錄）已知殘餘限制：GOCSPX- 以字串拼接/concat! 迴避掃描器的**惡意**規避不受 T1/T2 覆蓋——攻擊者=自家 commit 者時任何字串掃描器皆可繞，釘選目的為擋無意迴魂與 CI 級事故，邊際效益評估後不加碼（委員#3 裁決：過度防衛，明文登記）。

## 可選項定案（憲法⑦）
- OS keyring（gnome-libsecret/Android Keystore）儲存 tokens：**不做**。理由：跨平台（Linux DE 無 keyring daemon、Android keystore 對普通檔 I/O 非即插即用）+ tauri-plugin 支援度需另立專案評估，違反「務實可 build」；0600 + 單使用者桌面目錄為本輪務實解，keyring 記後續候選。
- 啟動時把既有 0644 檔批次收緊（migration）：**不做顯式 migration**；`write_private` 在每次 save（含 token 自動刷新）時已經把既有檔收緊，實際覆蓋所有持續使用者路徑。手動刪檔重建者走全新建立路徑，同上。
- OAuth 錯誤 detail 記錄：**不做**（範圍外，非本 bug）。

## 範圍外清單
- Google Cloud Console 端洩漏憑證**輪換/撤銷**（任務書明示不在範圍；需手動操作，列入交付通知事項）。
- `src/pages/settings.js` Drive 區塊（PM6 所有；本修法前端零改動，無需 scope-request）。
- tokens 加密靜態儲存（at-rest encryption）：見可選項，本輪只做權限收緊。
- D11/D10（佇列後續，本 commit 不含）。
- `tools/cli.mjs:3233-3279` CLI 鏡像面（R1#2-S2）：CLI token 刷新用 `writeFileSync` 復寫既有檔（保留原 mode，不新增 0644 檔、不劣化），但 CLI-only 使用者的 tokens 檔永不被 write_private 收緊——CLI 域屬 PM 其他首相白名單，登案另處。
- 「更換憑證」UI（R1#2-N4）：settings.js:871-872 憑證存後輸入區永久隱藏無重開入口；F11 後自用憑證者變多，需求上升，記後續佇列（PM6 域）。
- secret 輸入框 `type="text"` 明文顯示（R1#1-nit1，settings.js:378，PM6 域）。
- `ensure_token` 刷新被拒錯誤不引導 re-login（R1#2-S1c 衍生）：錯誤訊息文案改進屬 UX 另案。
- 空檔寫入 `let _ =` 靜默吞失敗（drive_save_creds 寫盤失敗仍回成功）：現況既有非本修法引入，登另案。

## 版本紀錄
- v1（2026-08-27）：初版。行號實錘＝audit 行號一致（:43-44 常數、:56-73 save 函數）。
- v1.1（2026-08-28，送審前定稿，尚未經歷審查輪故仍合規憲法⑤凍結點＝首次送審）：驗證段全面重钉——T4 升級「注入真嵌入」（rlib grep，防編過無感假綠）、T5 負控制改 pin 基線 hash 9e3116b（F9 負控制腐化教訓）、T6 write_private 微編譯行為級 NC 取代全檔 /tmp 副本 cargo（tauri 依賴樹成本）、T7 空值語意回歸釘新增；R4 登記 F11-SR1（build.rs rerun-if-env-changed，白名單外不逕改）；行號覆核 2026-08-28 全數一致（:42-44/:46-54/:56-60/:69-73/:75-78/:194-196/:265-267，drive_download 寫入段 :358-364 供 D11）。
- v1.2（2026-08-28，R1 三委員 2✅1❌ 全吸收）：**B1** const+`unwrap_or`=E0658 改 match 形（T7 同步改釘 None=>"" 段錨定）；**B2** write_private import 補 PermissionsExt 殲 MetadataExt＋採納 #1 fd 級 set_permissions 加固（先 chmod 後寫）；**B3** T6 harness 補 MetadataExt preamble；**B4** T4 產物正則改 `^(lib)?teno`＋T4c 非空守衛；**S1** 測試名統一 f11_* 前綴；**S2(#3)** T1g/T5g 正向釘 save 體實呼 write_private( 反繞道；**S1(#2)** R1 風險誠實化（需 re-login＋自建憑證現實）；**S2(#2)** CLI 鏡像面登範圍外；**L1** pm4 log 洩漏 scrub＋R5 commit 波紀律；**S3(#3)** 拆串迴避列已知殘餘（R6，委員裁決不加碼）；N2/N4/nit1 登範圍外。PRE 態復跑 17/17 ALL PASS。
