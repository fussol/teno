# D11 修復計畫書 v1

## Bug 定義
`src-tauri/src/drive_sync.rs` `drive_download`（audit 行號 :296-303，**實際行號覆核 2026-08-28＝:386-393**，F11 補丁後漂移已登記）：從 Drive 下載的位元組 `buf` 經 **零內容驗證** 直接 `fs::write(tmp)` → 刪本機 `-wal/-shm` → `rename` 覆蓋 `teno.db`。遠端檔為空檔（0B）、損壞檔、或非 DB 檔（同名 `teno.db` 被人為覆蓋成任何內容）時，本機資料庫即時毀滅——且 WAL 同被刪除，連 replay 殘存機會都剝除，零回滾路徑。

## Root cause
:383-384 `read_to_end` 收完位元組後無任何格式判斷，:387 直寫暫存、:389-390 拆掉 WAL/SHM、:391 rename 頂換主檔。信任邊界錯置：把「Drive 上的同名檔」當作必為可信 DB，但該檔可被任何其他裝置/人為操作改寫。

## 修法（drive_sync.rs 單檔，白名單內；lib.rs 零改動）
### 關鍵既有資產（開檔實錘）
`lib.rs:580 unpack_db_container`（crate root **私有 fn——子模組 drive_sync 依 Rust 可見性規則可直接 `crate::unpack_db_container` 呼叫，零需 lib.rs 改動**）已內建：
- TENOC 容器（`TENOC`(5)+ver(1)+[u32 l1][db]+[u32 l2][log]，lib.rs:559 註解）：長度欄缺失/段截斷 → Err；
- 非容器路徑：非 `SQLite format 3\0` 開頭 → Err（:583-585）；空檔天然斃（both magic 不中）。
**殘洞**（必補）：容器分支**不驗內段 SQLite magic**——TENOC 頭掛垃圾 db 段可過 unpack。

### 1. 抽純函式 `validate_drive_download`（F9 純函式委派典範）
```rust
/// D11: 下載內容守門——TENOC 容器（手機備份手放 Drive 的防衛相容）與裸 SQLite
/// 雙態放行，其餘（空檔/垃圾/截斷/容器內段非 SQLite）一切拒絕；拒絕時零寫盤。
/// log 段忽略：本檔唯一正常來源 drive_upload 只傳裸 teno.db（無容器無 log），
/// TENOC 支援為防衛性相容，還原語意=僅還主資料庫（log 還原另有 app 路徑，登記）。
fn validate_drive_download(buf: &[u8]) -> Result<Vec<u8>, String> {
    let (db_bytes, _log) = crate::unpack_db_container(buf)?;
    if db_bytes.len() < 100 || !db_bytes.starts_with(b"SQLite format 3\0") {
        return Err("下載內容不是有效的 SQLite 資料庫，本機資料未變".into());
    }
    Ok(db_bytes)
}
```
- `>=100` 門檻＋16B magic＝**與 D19 CLI import magic 守門同判別子**（同根清零蟲、跨端對齊；真實最小 SQLite 檔 512B page header，100 純防禦下限）。
- 容器內段 magic 補釘＝封 unpack 殘洞（D19 委員測資同族：l1>0 垃圾段）。

### 2. drive_download 委派（:386 前插入，寫盤代價碼零動）
```rust
    let db_bytes = validate_drive_download(&buf)?;   // 拒絕＝函數頂返回，零副作用
    let db = db_path(&app_handle);
    ...
    std::fs::write(&tmp, &db_bytes)...               // buf → db_bytes（容器解包後寫純 SQLite）
```
拒絕路徑時：tmp 未寫、WAL/SHM 未刪、主檔未動——順序釘死（守門先於一切寫點）。

### 3. 迴歸測試（同檔 mod tests，直接測純函式）
- `d11_validates_drive_download_forms`：空檔 Err／垃圾 Err／裸 SQLite（512B 頭測資）Ok 原樣／TENOC+SQLite Ok 且解包段正確／TENOC 段截斷 Err（lib.rs:1794-1798 測資形態對齊）／**TENOC 內掛垃圾段 Err**（殘洞釘）／99B SQLite 頭 Err（門檻邊界）。

## 驗證方式
`tools/verify-d11.mjs`（送審前實跑；雙態自適應，偵測 `validate_drive_download` 在場與否選態）：
- T1 源碼釘：純函式在場＋委派在場＋**順序釘**（validate 呼叫偏移 < `fs::write(&tmp` 偏移 < remove_file(db-wal) 偏移，段內比較）＋寫盤改用 db_bytes＋舊 `fs::write(&tmp, &buf)` 零殘留。
- T2 倉內單元：`cargo test --offline drive_sync` 綠＋`d11_validates_drive_download_forms` 在場執行。
- T3 行為級微編譯（F11-T6 典範）：從源碼提取 `CONTAINER_MAGIC`+`unpack_db_container`（lib.rs）＋`validate_drive_download`（drive_sync.rs）＋字面量替換 `crate::`→直接呼叫，rustc 單檔七腿測資實跑（空/垃圾/裸SQLite/TENOC+SQLite/截斷/TENOC垃圾內段/99B）。零依賴純 std，毫秒級。
- T4 負控制（恆常有牙，免 HEAD 腐化）：同 harness 把守門換成直通版（`Ok(buf.to_vec())` 不驗）→ 空檔/垃圾/99B 三腿必**通過**＝bug 精準復現（毀庫路徑復活證明）。
- T5 基線負控制（pin `9e3116b`，F9 教訓）：基線檔 drive_download 段零 unpack/validate/magic 呼叫＝bug 於基線實錘在場。
- 回歸義務：cargo test 全量（drive_sync 6→7）＋`node --check` 不適用（純 Rust）＋vite build＋既有 verify 抽 3（d19/d7/d6——d19 同 magic 判別子族、d6/d7 DB 生命週期域）。
- 離線紀律：零 Google API。

## 風險
- R1 使用者手放**加密/壓縮**檔到 Drive（如 zip 改名 teno.db）：從「靜默毀庫」變「明確拒絕」——行為變更方向為收緊，正解。
- R2 老 Drive 檔若係**舊容器世代**（非 TENOC v1 頭）：unpack 非容器分支要求 SQLite magic，老容器若裸 SQLite 則過；任務書宣稱相容 TENOC+裸 SQLite 兩態已覆蓋。
- R3 `crate::unpack_db_container` 依賴 lib.rs 現行簽名——同 crate 私有可见性為 Rust 語言 guarantees；若 lib.rs 未來改 private→pub(crate) 或搬家，編譯期即炸（fail-loud 非無聲）。

## 可選項定案（憲法⑦）
- TENOC log 段寫回 app-log.db：**不做**。drive 同步契約=僅主資料庫（drive_upload 亦只傳 teno.db）；log 寫回需碰 app-log WAL 全套（write_db_container 語意）超出守門_bug_範圍，代碼註解＋本節登記。
- 覆蓋前本地自動備份（backupDb 語意鏡像）：**不做**。magic 守門後剩餘風險=「遠端為有效但更舊的 DB」——那是 D10 last-write-wins 語意域（有效檔備份攔不住也**不該**攔，用戶按下載=有意恢復），備份策略屬 D10/產品決策另案，登記不順手修。
- modifiedTime 比對防下載舊檔：歸 D10（佇列下一顆），不在此治。

## 範圍外清單
- D10 同名多檔/modifiedTime/last-write-wins（佇列下一顆）。
- drive_upload 端零校驗（上傳本地 db 原位元組，非本 bug）。
- 覆蓋前備份策略（見可選項，D10/產品域）。
- F12 ureq HTTP 狀態語意（404 error body 存成假檔中毒連鎖——F9 紀錄已登 F12 順治；本修法 magic 守門天然攔截 HTML 錯誤頁，屬副效益非宣稱）。
- app-log.db 還原鏈（見可選項）。

## 版本紀錄
- v1（2026-08-28）：初版送審。行號實錘：audit :296-303 → 現行 :386-393（F11 補丁後）；unpack_db_container lib.rs:580-609、CONTAINER_MAGIC lib.rs:561、容器結構 lib.rs:559。
