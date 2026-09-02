# F16-SR1 修復計畫書 — 刪 JS 側死 wrapper exportCsvData（雙向鎖）

- **Bug ID**: F16-SR1
- **規格來源**: scope-requests.md F16-SR1（PM3 登案，2026-08-29）
- **任務書**: PM-SR1-MISSION §佇列4
- **基線**: HEAD `fd4324e`(v5.8.5)
- **首相**: SR1（資料層）

## 1. Bug 定義
Rust 側 F16 死命令 `export_csv_data` 已殲滅（fn＋generate_handler），JS 側殘鏈白名單未清：
- `src/lib/api.js:107-108` 死 wrapper `exportCsvData`（呼叫 `invoke('export_csv_data')`，指向已刪死命令）。
- `src/pages/export.js:8` 死 import `exportCsvData`（全檔零呼叫，實錘：僅 :8 import，exportCsvDialog 在 :93 使用需保留）。

## 2. Root cause
F16 上波（Rust 側）刪命令時未同步清 JS 端定義/import wrapper，遺留指向死命令的殘鏈。verify-f16 T3b 原「wrapper 在冊」fail-closed 存續期釘（防 SR 落地前被誤刪），現 SR 落地須同步翻轉。

## 3. 修法（雙向鎖）
1. `src/lib/api.js:107-108`：刪 `export const exportCsvData = (csv, filename) => invoke('export_csv_data', { csv, filename })` 整段（連上方 `// ─── Android export ...` 註解保留——下方 exportDbData/exportBackupData 仍屬此組，只刪 exportCsvData 兩行）。
2. `src/pages/export.js:8`：改 `import { exportCsvDialog, exportCsvData } from '../lib/api.js'` → `import { exportCsvDialog } from '../lib/api.js'`（只撤 dead，保留 in-use）。
3. **雙向鎖：同步修訂**
   - `tools/verify-f16-csv-data.mjs` T3b：由「wrapper 在冊」翻轉為「wrapper 已撤」。
   - `tools/verify-g24-export-render.mjs:19` mock stub：移除 `exportCsvData: async () => {}`。

## 4. 驗證
- `node --experimental-test-module-mocks tools/verify-f16-csv-data.mjs` 全綠（T3b 更新後）。
- grep `exportCsvData` src/ 歸零。
- `node --check src/lib/api.js src/pages/export.js`。
- 回歸：verify-g24-export-render.mjs ALL PASS（stub 清理後）＋ verify-d5（backupCheckpoint）＋ verify-g30。

## 5. 風險
- 低。exportCsvData 全庫零呼叫（除死 import），刪除零作用面。安卓 blob 下載路徑用 exportDbData/exportBackupData（grep 實錘在冊），非 exportCsvData。

## 6. 範圍外
- lib.rs/export_csv_data Rust（已殲滅，不動）。
- 安卓真 export blob 其他路徑。

## 7. 可選項
- 保留 wrapper 供未來 → **不做**（指向死命令的 wrapper 屬迴路殘鏈，官方已刪命令）。

## 8. 過審後動工 checklist
- [x] api.js 刪 exportCsvData 段（3 行，exportCsvDialog/exportDbData/exportBackupData 完好）
- [x] export.js 撤 exportCsvData import（exportCsvDialog 保留，:93 在用）
- [x] verify-f16 T3b 翻轉「已撤」
- [x] verify-g24 stub 移除 exportCsvData
- [x] node --check src/lib/api.js + src/pages/export.js → OK
- [x] verify-f16 16/0 ALL PASS（T3b 翻轉後）+ grep exportCsvData src/ 零命中
- [x] 回歸 g24 ALL PASS + d5 ALL PASS + g30 ALL PASS + d20 10/10

## 版本
F16 屬 code 路徑變更 → 下一版 5.8.6（version.sh patch）。

## 版本紀錄
- v1.0（送審）：初版。
- v1.1（審查採納，R1）：①§8 checklist 補勾；②微小備註——verify-f16 T3a 註解行號「api.js:107」已漂移但屬歷史說明無害，T4d 容忍 f≤3 為預存 sim fixture 既有，均非本次引入；③兩人次✅。程式碼零變動。