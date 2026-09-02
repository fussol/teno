# PM-SR1 檢查點 — 2026-08-30（佇列全數完成）

## 狀態
SR1（資料層）4 顆 bug 全部閉環完成。無殘局。

## 已完成 commit 清單（hash + 版本）
| Bug | commit | 版本 | 審查 | 驗證 |
|---|---|---|---|---|
| D5-SR1 backupDb 加 WAL checkpoint | `1655186` | 5.8.2 | 1 輪 1 人次 ✅ | verify-d5-checkpoint 4/4 |
| D20-SR1 exam_history 雙世代孤兒清理 | `d04986a` | 5.8.3 | 1 輪 3 人次 ✅ | verify-d20-dual-generations 10/10 |
| E16-SR1 刪 sim-behavior.js 死檔 | `fd4324e` | 5.8.5 | 1 輪 1 人次 ✅ | verify-e16-sr1-orphan 3/0 |
| F16-SR1 刪死 wrapper exportCsvData | `504049e` | 5.8.6 | 1 輪 3 人次 ✅ | verify-f16 16/0 + g24 |

（註：5.8.0→5.8.1 由並行首相 U-LEARN-RENDER/5.8.4 F10 搶號，SR1 佔 5.8.2/5.8.3/5.8.5/5.8.6）

## 計畫書路徑
- `_dev/notes/D5-SR1-fix-plan.md` (v1.1)
- `_dev/notes/D20-SR1-fix-plan.md` (v1.1)
- `_dev/notes/E16-SR1-fix-plan.md` (v1.1)
- `_dev/notes/F16-SR1-fix-plan.md` (v1.1)

## 驗證工具（新建）
- `tools/verify-d5-checkpoint.mjs`
- `tools/verify-d20-dual-generations.mjs`
- `_dev/notes/verify-e16-sr1-orphan.mjs`（放 _dev/notes 因 tools/ 白名單僅 d5/d20/f16/g24）

## 未完成事項（跨域尾巴，需總統裁示）
1. **`E16-SR2`（登 scope-requests）**：`tools/verify-e16-orphan-deletion.mjs` T5a 臨時釘「sim-behavior 本波必須仍在」於 E16-SR1 刪檔後注定翻紅（post 28/1 實錘）。該工具不在 SR1 白名單（tools/ 僅 d5/d20/f16/g24）→鐵律⑦不逕改。請求：將 T5 段更新為「已刪」態或除役。
2. **CLI 域既有 2 FAIL（非本次引入，symptom 登記）**：`verify-d20-delete-deck` T8b/T8e 與 `verify-e13-simparams-guard` T5a/T5b 工作區 vs HEAD 同 FAIL（stash 對照零因果）——cli.mjs（SR2 領地）負控制反換 harness 對現行 cli 失效，非 SR1 責任。
3. **工具教訓（已計畫書/紀錄註記）**：`git commit -F /dev/stdin` + heredoc 不可靠（hook 吞無輸出）；改用暫存檔 `-F /tmp/xx.txt` 穩定。

## 下一步
佇列已清空，SR1 無剩餘任務。等總統評估跨域尾巴 E16-SR2 與 CLI 既有失敗重新指派。

## 產出文件
- 4 顆 fix-plan (v1.1)
- 4 個 subagent-log（2026-08-30-D5/D20/E16/F16-SR1.md）
- 3 個驗證工具