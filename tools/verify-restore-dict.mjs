#!/usr/bin/env node
// dictionary.js 離線 OCR 還原層驗證（Damerau edit-distance ↔ words.txt）
// 用法: node tools/verify-restore-dict.mjs
// 需在 vite 環境載入 ?raw —— 用 vitest 較重；此 harness 直接 import（Vite 處理 ?raw）
// 故改用編譯後客戶端跑 → 此檔作為「邏輯對照」：用純 JS 重現 damerau + 驗證同 index 行為，
// 並透過 vite build 後 browser 驗證真實 dictionary.js。此處僅測純函式邏輯等價。

// 產生一小份測試字典模擬 words.txt 的 index 行為
function buildIndex(words) {
  const set = new Set(words);
  const byFirst = new Map(), byLen = new Map();
  for (const w of words) {
    if (!set.has(w)) set.add(w);
    if (!byFirst.has(w[0])) byFirst.set(w[0], []);
    byFirst.get(w[0]).push(w);
    if (!byLen.has(w.length)) byLen.set(w.length, []);
    byLen.get(w.length).push(w);
  }
  return { set, byFirst, byLen };
}
function damerau(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 99;
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

function main() {
  console.log('═══ RESTORE-DICT 邏輯驗證（damerau 核心）═══');
  // damerau 基本
  check('damerau 相同', damerau('cat', 'cat'), 0);
  check('damerau 換位 teh→the', damerau('teh', 'the'), 1);
  check('damerau 換位 recieve→receive', damerau('recieve', 'receive'), 1);
  check('damerau 容差恰2不剪枝（cat→caaat 距離2）', damerau('cat', 'caaat'), 2);
  check('damerau 容差超界3 剪枝', damerau('cat', 'caaaat'), 99);
  check('damerau 單字元替換', damerau('cat', 'bat'), 1);
  // OCR 亂碼距離（對照離線層預期）
  check('monntain→mountain 距離', damerau('monntain', 'mountain'), 1);
  check('joumey→journey 距離', damerau('joumey', 'journey'), 2);
  check('restaurent→restaurant 距離', damerau('restaurent', 'restaurant'), 1);
  check('knowleoge→knowledge 距離', damerau('knowleoge', 'knowledge'), 1);
  check('vocaburlry→vocabulary 距離', damerau('vocaburlry', 'vocabulary'), 2);
  // 歧義：teh 對 the 距離 1（應被嚴格唯一守門擋，因 te 同距）
  check('teh→the 距離 1', damerau('teh', 'the'), 1);
  check('teh→te 距離 1（歧義來源）', damerau('teh', 'te'), 1);

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}
main();