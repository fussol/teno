# D1 修復計畫書 — related/forms CSV round-trip 破壞

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅ 全過）
> 範圍：僅 D1 專案，不夾帶其他 bug

---

## 1. Bug 定義

**症狀**：匯出 CSV → 匯入後 `related`/`forms` 陣列被切碎成垃圾（如 `["a,b","c"]` 匯入變 `["[\"a","b\"","\"c\"]"]`）。

**Root cause**：`src/core/import.js:196-197` 對 `related`/`forms` 只做 `val.split(',')`，**沒有先 JSON.parse**；但匯出端 `buildCSV`（:233 `arrayKeys`）用 `JSON.stringify` 序列化 → 寫出 JSON、讀回卻用 split，round-trip 失配。
- `tags`（:190-191）、`examples`（:192-193）已有 `JSON.parse try → fallback split`，round-trip 正常 → 只有 related/forms 壞
- 實測：一般陣列、含逗號元素、空陣列 `[]` round-trip 全掛（3/4 案例）

## 2. 修復方案（1 處）

### `src/core/import.js:196-197` — related/forms 比照 tags 加 JSON.parse try

```js
// 現況（bug）
} else if (key === 'related' || key === 'forms') {
  w[key] = typeof val === 'string' ? val.split(',').map(s => s.trim()).filter(Boolean) : (val || []);
}
// 改為
} else if (key === 'related' || key === 'forms') {
  let parsed = null;
  try { parsed = JSON.parse(val); } catch {}
  w[key] = Array.isArray(parsed) ? parsed : val.split(',').map(s => s.trim()).filter(Boolean);
}
```

**⚠️ `Array.isArray` 守衛不可省**（#1/#2/#3/#4 一致實錘）：`JSON.parse('"abc"')`/`('123')` 會成功但回傳 string/number → 直接賦值會讓 related/forms 變非陣列 → 下游 `.map()` TypeError 整頁 crash（tags 分支現行就有此同款隱患，不在 D1 範圍）。

**examples 維持現行 special-case**（:192-193 JSON.parse → split(';') → {en,zh}），不動。

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | 根因確認（缺 JSON.parse try）；round-trip 實證 |
| #2 | 資料語意 | ✅ | 必須加 Array.isArray（照抄 tags 會複製 crash） |
| #3 | 實測 | ✅ | 3/4 round-trip 掛；擬案實測通過 |
| #4 | 副作用 | ✅ | 無舊行為依賴；Array.isArray 守衛必要 |
| #5 | 整合 | ✅ | 一處改動即修復；邊界全對；D8（CLI tags）是另案勿混入 |

## 4. 驗證方式

1. **單元**：node 測 parseList 邏輯 — `["a,b","c"]`→陣列保留、`a,b`→fallback、`[]`→空陣列、`"abc"`/`123`→fallback 非陣列外洩
2. **Round-trip**：buildCSV → parseCSV 還原（含逗號元素、空陣列、undefined）
3. **Build**：vite build 通過

## 5. 風險

- **低**：改 1 處；legacy 逗號分隔資料（`a, b`）fallback 行為保留；唯一行為差異是 JSON 陣列字串正確還原
