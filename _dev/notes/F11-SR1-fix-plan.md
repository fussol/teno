# F11-SR1 修復計畫書 — build.rs 加 rerun-if-env-changed（防禦性加固，非 bug）

- 波次：SR2（Rust/Drive 域）
- ID：F11-SR1
- 作者：SR2 首相
- 日期：2026-08-30

## 1. 問題定義（v2 更正：非行為 bug，冗餘顯式宣告）

**v1 前提（審查證偽）**：原認 F11 主修 `option_env!`（drive_sync.rs:46-52）後，build.rs 未宣告 `rerun-if-env-changed` → 發佈者改 env 值 cargo 不感知、`option_env!` 不重新求值。

**行為實測證偽**（審查委員會，真 repo 與 MSRV 最小重現雙證）：`option_env!` 的 env 敏感性由 rustc dep-info `.d` `env-dep:` 條目**自動追蹤**（MSRV 1.77.2 即具備，Cargo.toml rust-version 實錘）。cargo 讀 .d 自動標 Dirty → 改 env 值→重編→新值內嵌，真實路徑可達。`/暗.改 env 值（不 touch）` 於 cargo 1.98 印 `Dirty teno: the environment variable TENO_DRIVE_CLIENT_ID changed` 並重編內嵌新值；MSRV 1.77.2 最小重現同。unset 亦會反觸發（env-dep 記錄未設定）。同 env 值連跑 0 次 Compiling（無每次全量重編假象）。**∴ 此不足非 bug，build.rs 現況功能正常。**

現行 verify-f11 T4 的 `touch` 是「測試 mtime 視窗較野的確定性裝置」（保證 listFresh 有新鮮產物），非 workaround——v1 對其因果解讀錯誤。

**本 SR 處置（v2）**：非 bug 不應偽裝 bug fix 過審；但任務書列 F11-SR1 佇列且 build.rs 兩行 `rerun-if-env-changed` 為 **cargo 官方建議的顯式宣告**（對環境敏感 build 的 defense-in-depth）——採納，且以行為探針將「env-dep 自動追蹤」釘為不可回歸（防未來工具鏈/MSRV 調整侵蝕）。

## 2. Root cause 背景

build.rs 現況：
```rust
fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=c++_shared");
    }
}
```
無 rerun 宣告（但依 §1 證偽，功能仍正確）。加兩行是顯式化該 env 敏感性。

## 3. 修法（build.rs 尾部加兩行）

```rust
fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=c++_shared");
    }
    // F11-SR1: option_env! 注入，顯式宣告 env 敏感性（cargo 官方建議，dep-info env-dep 本已自動追蹤）
    println!("cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_SECRET");
}
```

## 4. 驗證

- **tools/verify-f11.mjs 既有 T1-T7 回歸**（drive_sync 完整）。
- **T8-NC 採 pin 基線法**（比照 T5）——`git show 11d218f:src-tauri/build.rs`（F11-SR1 修法前最後 HEAD，無 rerun，固定 hash 永不隨 HEAD 漂移——F9 禁 HEAD 教訓）→ 斷言掃描器對其紅。
- **T9 行為探針（必做，防未來回歸）**：不 touch drive_sync.rs，僅改 env 值（NEW FAKE2）跑 cargo check → 斷言 fresh rmeta 內嵌 FAKE2（no-touch env 變更→重編，env-dep 自動追蹤實錘）。
- 回歸：`cargo check`；`npx vite build`。

## 5. 風險

- 極低。加兩行 rust println。env 值不變時 0 次額外重編（實測），僅該二變數變更觸發重編＝理想時機。不改 drive_sync.rs/lib.rs/Cargo。

## 6. 範圍外（憲法⑥）＋治理註記

- 不碰 drive_sync.rs（F11 主修已完）、lib.rs、Cargo.*（他軌）。
- **build.rs 需總統裁示放行**（scope-requests.md:15 登案「待裁示」）——本 SR 依任務書佇列進行，commit 時載明防禦性加固性質。
- Cargo.lock 自身版本欄滯後（5.2.10→5.8.10 漂移，委員附帶發現）：隨下顆 Rust 側 commit 帶走，本顆 optional。

## 7. 版本

合入後 `./tools/version.sh patch`。三指紋 staged。`scope-requests.md` 絕不 add。

## 8. 審查歷程
- v1（2026-08-30）：送審 1 席。❌ — **v1 前提經行為實測證偽**：option_env! env 敏感性由 cargo/dep-info env-dep 自動追蹤，非 bug；build.rs 兩行無害但冗餘。建議 A 撤回／B 防禦性加固。
- v2（2026-08-30）：採納選項 B——§1 改「非行為 bug、冗餘顯式宣告(defense-in-depth)」附行為證偽鏈；§4 行為驗證改必做（新增 T9 no-touch env 探針）；T8-NC 改 pin 基線法；§4 註 T4 touch 為測試確定性裝置。重送。複審 ❌ — **致命發現：T8-NC 假 pin**（§4 宣稱 pin、實作 `git show HEAD` 漂移，F9 教訓禁 HEAD 重犯；F11 commit 後 verify 掉 33/35）。
- v3（2026-08-30）：採納一行修法——`BR_BASELINE='11d218f'`（F11 修法前最後 HEAD，實測 build.rs 零 rerun）替換 `git show HEAD`。重跑 verify-f11 **35/35 ALL PASS**（T8-NC 用固定 hash 永不漂移）。