# D10-SR1 + D10-SR2 修復計畫書 — CLI 雙鏡像 find_db_file 盲取首筆

- 波次：SR2（CLI/Drive/Rust 域）
- ID：D10-SR1（tools/cli.mjs）+ D10-SR2（_dev/cli/cli.mjs），同 bug 同修法，依法行政法§2 跨鏡像同 bug 併單 commit
- 作者：SR2 首相
- 日期：2026-08-30

## 1. Bug 定義

CLI 跨鏡像 `find_db_file` 用 `fields=files(id)` ＋ `list.files?.[0]?.id` 對同名多檔盲取「API 回傳陣列首顆」，未排序未比較時間。Google Drive 對同名多檔回傳順序無保證，挑到的可能不是最新檔 → upload 覆寫舊檔、download 抓錯版，資料可能分岔。Rust 主修（aab047b）已以 `pick_latest_file`（modifiedTime max）修復，兩處 CLI 鏡像未同步。

## 2. Root cause

- `tools/cli.mjs:3385-3391`（實錘，任務書行號 3283-3285 漂移）
- `_dev/cli/cli.mjs:3045-3051`（實錘）

兩處皆：`const q = encodeURIComponent("name='teno.db' and trashed=false")` → `fetch(...?q=${q}&fields=files(id))` → `let fileId = list.files?.[0]?.id || null;`

## 3. 修法（v4 替代結構 — 行為級純函式 + 強型別對齊 Rust `pick_latest_file`）

三輪審查：v1/v2/v3 純靜態字樣掃描器每輪被退（行註解 decoy → 解構盲取 → 多行模板字串/字串偽 block 三縫）。依**憲法⑩**（連續同類 edge 被退 → 停止打補丁、重估替代結構），v4 不再堆疊掃描器補丁，改以**行為級斷言治本**：把 find_db_file 的核心取最新邏輯提取為**命名純函式**，verify 用 `new Function` 提取真碼＋跑向量對拍（對齊 Rust T3 真碼微編譯精神）——語意假修法（字樣全真、行為盲取）在行為級必然現形，靜態掃描降為輔助層。

**hunk（兩鏡像同款，tools 3385-3391 / _dev 3045-3051 整段替換）：**

```js
  // D10-SR: 對齊 Rust drive_sync.rs pick_latest_file 語意 — modifiedTime
  // (RFC3339 UTC 字典序=max)，平手留首見；全缺 mtime 退回首顆有 id；
  // null/缺 id/非字串 條目跳過；空/非陣列 → null。
  const pickLatestDriveFile = (files) => {
    let fileId = null;
    let bestMtime = null;
    let firstWithId = null;
    const arr = Array.isArray(files) ? files : [];
    for (const f of arr) {
      if (!f || typeof f.id !== 'string') continue;
      if (firstWithId === null) firstWithId = f.id;
      if (typeof f.modifiedTime === 'string' && (bestMtime === null || f.modifiedTime > bestMtime)) {
        bestMtime = f.modifiedTime;
        fileId = f.id;
      }
    }
    return fileId ?? firstWithId;
  };
  // find_db_file
  const q = encodeURIComponent("name='teno.db' and trashed=false");
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${encodeURIComponent("modifiedTime desc")}&fields=files(id,modifiedTime)`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const list = await listResp.json();
  let fileId = pickLatestDriveFile(list?.files);
```

語意對齊 vs Rust `pick_latest_file`（drive_sync.rs:262-294）：
| 情境 | Rust | 本修法 |
|---|---|---|
| 取最新 (id,mtime) | max_by 嚴格大於 | `>` 字典序（RFC3339 定寬 UTC） |
| 平手 mtime | 留首見 | 同（嚴格大於才替換） |
| 全缺 mtime | 退回首顆有 id | `return fileId ?? firstWithId` |
| 缺 id 條目 | `as_str()` None 跳過 | `!f || typeof f.id !== 'string'` |
| null 條目 | `Value::Null`→None 跳過 | `!f` guard 跳過（不 crash） |
| 非字串 id | None 跳過 | `typeof f.id !== 'string'` |
| 空/非陣列 | `as_array()?`→None | `Array.isArray`→`[]`→`null` |

## 4. 驗證（tools/verify-d10.mjs，白名單內，行為級 T-HARNESS ＋ 靜態快速輔助）

- **Rust T1-T5** 全數保持（drive_sync.rs 已 POST，全綠）。
- **T-CLI 靜態輔助**：兩鏡像 find_db_file 段，orderBy 在場、fieldsFull 在場、fieldsBare 殲滅、盲取字樣殲滅、`pickLatestDriveFile(` 呼叫在場（v5：以 `pickCall` 取代 v3 的 `bestLoop`——迴圈已移入錨點前之純函式，段內不再含 bestMtime/firstWithId，bestLoop 成 POST 態必紅殘留）。沿用行首錨/先剝 block/結構化 URL/serialised 三款樣本牙（NC/DECOY/DESTRUCT），僅作快速層。
- **T-HARNESS 行為級（替換結構治本）**：對**兩鏡像**逐一提取真碼 `pickLatestDriveFile`（`const pickLatestDriveFile = (files) => {` 至配對 `}` 花括號深度計數），`new Function` 對 12 向量對拍（L1 舊→新、L2 新→舊、L3 全缺 mtime 退首、L4 空、L5 非陣列、L6 單檔、L7 跨年、L8 缺 id 取次新、L9 mixed、L10 平手留首見、N1 null 不 crash、N2 非字串 id 跳過）。**NC 腿**第一()版跑 L1（old-to-new 選錯）＋L7（跨年選錯）必紅。**語意假修法（字樣全真、行為盲取）L1 必選錯判紅**——封死 A2/A8/A12 整族。附**兩鏡像提取碼逐字一致**斷言（跨鏡像同 hunk）。**鏡像不同步（定義/呼叫單邊缺席）→ 紅。**
- **POST 態模擬納入 self-check**：動工前以 /tmp 副本套 hunk 對拍（主席實測最終工具 POST 全綠 **72 PASS/0 FAIL**），避免驗證工具與 hunk 結構不相容（v5 教訓）。
- 回歸：`node --check` 兩鏡像；`npx vite build`（註：CLI 檔不在 vite 構建圖，此項為倉庫健康順帶回歸，非本 hunk 有效閘門）。

## 5. 風險

- 兩鏡像改為呼叫純函式，`fileId` 語意不變（仍可能 null → upload `if(!fileId)` create／download `if(!fileId)` 拒絕，同舊保守）。`pickLatestDriveFile` 為 cmdDrive 內 local（無 top-level 污染，他處同名變數零碰撞）。
- Func `??` 對空字串 id 保留（`'' ?? firstWithId`＝`''`，同 Rust `Some("")`；消費端 `!fileId` falsy 走 create，資訊級分歧與舊 `|| null` 同）。
- 函式提取 regex 依賴命名統一名 `pickLatestDriveFile`＋arrow 格式——計畫書 pin 住格式，提取器與之強一致。

## 6. 範圍外清單（憲法⑥→追蹤）

- 不碰 `src-tauri/src/drive_sync.rs`（主修已完）、`src/lib/*.js`、`src/pages/*.js`、`lib.rs`、Cargo.*（他軌）。
- 不重構 create_db_file 側 create-branch（無同 bug）；不改動 fetch 失敗/401 錯誤處理（另 bug）。
- 盲取表達式變體（`.at(0)`/`.shift()`/spread/find/slice）由行為級 T-HARNESS 語意層涵蓋（非 regex 軍備競賽）；`pickLatestDriveFile` 不因變體命名分歧。
- fetch URL 跨行 prettier 斷行（非本 hunk，結構化 regex 只要求 fetch 行含關鍵 query）。

## 7. 版本

合入後 `./tools/version.sh patch`（以合入當下 package.json 現值 +0.0.1 為準，不起硬編碼）。code 路徑變更 → 三指紋檔（package.json／tauri.conf.json／Cargo.toml）staged 齊全。`scope-requests.md` 為共享檔絕不 add。

## 8. 審查歷程

- v1（2026-08-30）：送審。委員0 ❌ 掃描器只剝 block、行註解 decoy（攻6）全綠突破；委員1/2 ✅ 附非阻塞。
- v2（2026-08-30）：採納委員0 六點掃描器修法＋`typeof mtime` 對齊＋§7 移除硬編碼。重送。委員0 ❌ 兩縫（縫1 `!f.id` 對 null TypeError crash 劣於舊版＝半套 as_str；縫2 解構盲取 I 改樣本遷就掃描器未補掃描器且未登記）；委員1/2 ✅。
- v3（2026-08-30）：縫1 修 `Array.isArray(list?.files)`＋`!f || typeof f.id !== 'string'`；縫2 行首錨＋先剝 block＋結構化 URL regex＋無點形式＋解構釘＋DESTRUCT 牙＋§6 登記行為級追蹤。重送。委員0 ❌ 掃描器仍有 A2/A8/A12（多行模板字串偽行首錨／字串偽 block 剝除／組合）——純靜態字樣掃描本質防不了；委員1/2 ✅ 過審並一致背書「治本在行為級斷言，勿 regex 軍備競賽」。
- **v4（2026-08-30，憲法⑩ 重估替代結構）**：停止掃描器補丁，改行為級斷言。修法提取 `pickLatestDriveFile` 命名純函式＋呼叫；verify 新增 T-HARNESS 行為級（`new Function` 真碼 12 向量對拍＋NC 腿），封死 A2/A8/A12 與全盲取表達式變體；靜態掃描降為快速輔助層。送審 3 名 → 委員0 工具 HTTP 429 無結論；委員1 ❌ 阻斷一（v4 把迴圈移進錨點前之純函式，「bestLoop」斷言已不在段內 → POST 態必紅，staged verify 程式碼滯後於 v4 文字）＋重大二（TH 只覆蓋 tools 鏡像、_dev 零行為級）＋次要三（NC 缺 L7）＋資訊四（PRE 數字 32/10 非 34/10）。
- **v5（2026-08-30，採納委員1 四修）**：① `scanCli` 刪 `bestLoop` 改 `pickCall`（`/\bpickLatestDriveFile\s*\(/`）；② T-HARNESS 改「兩鏡像」迴圈＋`TH-sync` 提取碼逐字一致斷言＋orphan 紅；③ NC 補 L7 腿；④ PRE 數字以實跑 32 PASS/10 FAIL 為準＋§4 補「POST 態模擬納入 self-check」。self-check：PRE 態 32 PASS/10 FAIL（兩鏡像 10 紅精準、三樣本牙過、TH-PRE 過）；POST 態以 /tmp 副本套 hunk 主席實測最終工具 **72 PASS/0 FAIL** 全綠（56 為 v4 中間版工具值）。修法 hunk 與語意對齊表不變（純函式＋呼叫）。重送 → 主席 ✅ 放行（委員0/2 HTTP 429 工具失敗不計席）＋發現① 數字 56→72 修正。