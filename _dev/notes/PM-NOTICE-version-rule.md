# PM-NOTICE：版本規則改制（2026-08-28 元首核准，總統落法）

## 新規則（法典・版本制定規範 v2，取代旧「一 commit 一版本」）
1. **一結案一版本**：bug 結案 commit → `./tools/version.sh patch`；功能完整落地（最後一顆）→ minor。
   功能中間顆（T1~Tn-1）、docs/test/覆核/計畫書/tools commit 一律免升。
2. **升版唯一路徑 `tools/version.sh`**：一次寫齊 package.json + tauri.conf.json + Cargo.toml。
   手改單檔 = 指紋分裂（今日實錘病根：舊版 version.sh 讀 Cargo 舊值 sed tauri.conf 靜默跳過，
   三檔已漂 5.1.19/5.1.19/5.1.18）。
3. **機械閘已上**：`.githooks/pre-commit`（core.hooksPath 已設）——code 路徑變更的 commit
   若未 staged 三檔齊升／三檔不等／版本未升 → **直接拒 commit**。
   `--no-verify` 繞過 = 治理事件，別幹。
4. **逃生門**：message 加 `[skip-version]`（可 grep 追溯，需總統同意）。

## 補登
HEAD `ee93ffa`（F5）連同之前 34 fix + OCR 4 feat 補登為 **5.2.5**。
**下一顆結案（F6）起適用**：F6 落地 commit 應帶 `version.sh patch` → 5.2.6。

## 驗證工具
- `node tools/verify-version-sync.mjs` — 三檔全等 + live DB 指紋對拍（滯後=黃，倒退=紅）。
  建議併入每波回歸清單。
