# PM-OCR 修訂任務：OCR 計畫書 v1.0 → v1.1（R1 三席全退回）

你是 PM-OCR。你先前產出的 OCR 計畫書 v1.0 經三席審查委員實碼核對全數退回。
下方依序是：①三席審查報告 ②原任務書規格回顧 ③程式碼快照。

## 修訂鐵律
- 逐條回應審查發現：每個 Major/L 開頭項都要麼修復、要麼在計畫書「§修訂對照表」寫明處理方式
- **禁止再引用實碼中不存在的東西**：寫任何 icon 名/API/command/權限前，先在快照裡確認它存在
- 幽靈元件處理原則：`recognize_image` Rust command、`fs:default` 權限、`icon('camera')` —— 要嘛在 §6 補齊完整三件套（Cargo.toml 依賴+lib.rs init+command 定義），要嘛改用純前端路線（`<input type=file>` + FileReader + 純 JS）不需原生權限。**選擇線並在計畫書明說理由**
- 入庫路徑唯一化（審查明示：importWords 有去重是正解，寫死走它，刪掉 addWord 批次與直接 saveWordsInTx 兩條矛盾路）
- 所有憑記憶的數字：補「待驗證」標記或刪掉；PaddleOCR 體積與一手包數據衝突要修正
- CSP（tauri.conf.json:27）修改進 §6 清單
- §6 檔案清單窮舉：tools.js、svg.js（新 icon 完整 SVG 代碼）、package.json、vite.config.js、tauri.conf.json 全列
- OCR token 白名單過濾規則明訂（正則）
- P1 驗收每項補：測試步驟+預期+計時方法+負控制

## 交付
你的最終回覆 = **完整 v1.1 計畫書全文**（不是 diff，是完整九章節+開頭新增「§0 修訂對照表：R1 發現 → v1.1 處理」）。
