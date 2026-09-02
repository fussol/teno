# F16 計畫書 — dead command export_csv_data 殲滅（open_report 已由 F15 承接）

狀態：**v1.0（送審凍結）**
基線：1695638（F15 後 HEAD）
審計來源：bug-audit-2026-08-13.md:119「dead commands：open_report / export_csv_data 註冊但無呼叫」

## 1. Bug 定義與本單邊界

審計點名兩死命令。任務書（PM3-MISSION §25）對 F15/F16 重疊之指示＝合併思考、
各開計畫書各 commit。**open_report 全家已於 F15（1695638）殲滅**（其死面論證＋
grep 冊見 F15-fix-plan §2 RC3），本單承接第二顆 `export_csv_data`：
命令註冊（現行 :1781，審計行 1365 已漂移，實錘註明）＋函式本體（:1500-1505，
原審計行 1365 區）零前端呼喚路徑＝幽靈表面（可達、無消費者、純攻擊面）。

F15 審查席#3 已預言此邊界：「F16 單非空殼——export_csv_data 鏈死屬實、JS wrapper
另登 SR、S-2 同步釘 EXPECTED_CMDS 42→41」。本單照辦。

## 2. 憲法② grep 冊（export_csv_data 全消費者表，2026-08-29 實跑）

| 位置 | 形態 | 判定 |
|---|---|---|
| src-tauri/src/lib.rs:1500-1505 | fn 本體（回 BOM 前綴字串，無副作用） | 殲滅目標 |
| src-tauri/src/lib.rs:1781 | generate_handler 註冊 token | 殲滅目標 |
| src/lib/api.js:107-108 | wrapper `exportCsvData`（export 出） | 死 wrapper——白名單外→F16-SR1 |
| src/pages/export.js:8 | import exportCsvData **全檔零呼叫** | 死 import——F16-SR1 |
| src/pages/export.js:93 域 | 桌面走 `exportCsvDialog`、Android 走本地 `downloadBlob` | 活路径旁證（本單不碰） |
| tools/verify-g24-export-render.mjs:19 | G24 harness mock stub | 測試鏡像非消費者；wrapper 存續期不受影響 |
| src-tauri/gen/android/** | Kotlin 直呼通道 | 零（grep 實跑） |
| 動態形態（模板字串/變數/拼接 invoke） | src/ 全掃 | 唯 api.js:108 字面 `'export_csv_data'` 一處 |
| tools/cli.mjs / _dev/cli/cli.mjs | CLI 直呼 | 零（CLI 非 tauri 進程，無 invoke） |
| `export_csv_dialog`（近似名活命令） | — | 非本單目標；驗證含「誤刪封堵釘」 |

前端實際匯出鏈：`export.js:93 → exportCsvDialog`（桌面）／`downloadBlob`（Android，
:90 本地 BOM＋Blob）——Rust `export_csv_data`（BOM 前置回傳）與 Android 路徑功能
重疊但**从未被接上**（exportCsvData 零呼叫）。審計「註冊但無呼叫」對本命令**成立**。

## 3. 修法

- **lib.rs:1500-1505**：刪 `#[tauri::command] async fn export_csv_data`（連 attribute）。
- **lib.rs:1781**：generate_handler 刪 `export_csv_data, ` token（42→41）。
- **同步升版 tools/verify-f15-report-surface.mjs**（S-2 同步釘，F15 §6 預登）：
  `EXPECTED_CMDS` 42→41（去 export_csv_data）、T1f 計數 42→41、T2d 判別性等式
  `== 舊-1` 改 `< 舊`（本單落地後現行態與 19edaf9 差 2，等式必碎——改單調性判別
  並在腳本註明 F16 演進原因）。
- 前端**零改動**（JS wrapper/import 刪除屬 api.js/export.js 白名單外→F16-SR1；
  命令刪除後 wrapper 若未來被誤呼 invoke 即 reject 响亮失敗，非靜默幽靈——誠實可接受）。

備選窮舉（憲法⑦）：(A) 留命令接上 Android 匯出——❌ 產品已有 downloadBlob 現成
路徑，無價值航道；(B) 連 JS wrapper 一併刪——❌ 白名單外（鐵律⑦），SR 承接；
(C) 只除註冊留 fn——❌ F15 EV3 同款「本體殲半」態，T1 釘即紅，留屍無義。

## 4. 驗證方式（tools/verify-f16-csv-data.mjs，先行實跑雙態）

- T1 殲滅釘：lib.rs `\bexport_csv_data\b` 零（含註解）；handler 計數 41、清單無本
  token、其餘 41 逐一在位、幽靈零；**近似名釘**：`export_csv_dialog` 仍在註冊＋
  fn 在位（誤刪封堵）。
- T2 負控制：`git show 1695638:src-tauri/src/lib.rs` 舊 blob 同掃描器——export_csv_data
  hits=2、handler 含之、計數 42 全響；判別性＝新 0<舊 2 且新計數<舊計數。
- T3 消費者恆常釘：src/ `exportCsvData(` 呼叫形態計數 0（死 wrapper 若被接上而
  命令已殲＝本釘＋reject 雙告警）；api.js wrapper 在冊註記（SR 存續期語意）。
- T4 編譯閘：cargo check host＋aarch64-linux-android＋cargo test --lib 計數下限 42。
- verify-f15 演化後復跑全綠（同步釘生效自證）。
- 回歸：verify-f15、verify-f14、verify-d17、build。

## 5. 風險

- 誤刪近似命令 → T1 近似名釘＋逐一在位釘×41 封堵。
- JS 側残 wrapper 被人順手接上 → T3 呼叫釘＋invoke reject 响亮失敗雙層。
- verify-f15 演化改壞 → 演化後全綠復跑＋T2 負控制腿保留不動。

## 6. 範圍外清單（憲法⑥）

- **F16-SR1**：src/lib/api.js:107-108 wrapper＋src/pages/export.js:8 死 import 刪除
  （白名單外；G24 mock 可同單清理）；刪後 T3 呼叫釘語意自動升級。
- F15-SR1（CDN 模板域，前單已登）。
- export_csv_data 之 Android downloadBlob 路径優化（非 bug 域）。

## 7. 版本紀錄

- v1.0（本稿）：送審凍結（憲法⑤）。
- v1.0→送審結果（2026-08-29）：R1 單席 ✅（簡單 bug 降席：單檔／PM3 獨佔／7 行／非 FSRS 核心）
  1 輪 1 人次；必須項①F16-SR1 補登 scope-requests（已落檔）②顯式路徑 add（照辦）；
  發現 #3 照版本新法 M-1 先例——fix commit 帶指紋 `version.sh patch`→5.2.10；
  發現 #4（T2d 單調性弱於原等式）採納登記：下波再殲命令須同款同步釘。
