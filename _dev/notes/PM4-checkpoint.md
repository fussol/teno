# PM4 檢查點（2026-08-28，Drive 同步域）

## 佇列狀態：全數清空 ✅
git log 反推實錘（`git log --grep='^fix: <ID>'` 各恰一筆）：
- F11 = 08fff9b（OAuth secret 硬編碼殲滅＋憑證檔 0600）
- D11 = 792264e（下載內容 SQLite/TENOC 雙態守門）
- D10 = aab047b（find_db_file 同名多檔 modifiedTime 對準最新，本 session 完成）

## 下一步：無（本軌域無殘題）
 runner 再喚醒 PM4 時：先跑 `git log --oneline --grep='^fix:' -20` 與本檔比對；
若無元首新派佇列，僅需復跑 `node tools/verify-d10.mjs && node tools/verify-d11.mjs && node tools/verify-f11.mjs`（PATH 帶 ~/.cargo/bin）確認綠後回報零殘題，勿重做任何顆。

## 掛帳（非 PM4 可做）
- D10-SR1（tools/cli.mjs 鏡像）／D10-SR2（_dev/cli/cli.mjs 鏡像）：已登 scope-requests.md 待總統改派
- F11-SR1（build.rs rerun-if-env-changed）：已登 scope-requests.md 待裁示
- scope-requests.md 內 PM4 兩筆 SR 追加**未入任何 commit**（共享檔他軌髒，F11 先例）——總統處理 SR 時一併落庫
- secret 輪換＋舊 token 撤銷（洩漏值已入 git 歷史，任務書明示範圍外，需元首 Console 操作）

## 版本指紋
本軌 fix commits 未升 package.json version（比照本波 D11/D16/D17 先例，升版權在總統打包時統一處理）。
