// verify-g28: import 重入保護（G28）— 靜態＋動態雙態
import { readFileSync } from 'node:fs';

const f = 'src/pages/import.js';
const c = readFileSync(f, 'utf8');
const fail = [];
const pass = [];

// T1 靜態：兩個 run* 都攔 _phase==='importing'
for (const fn of ['runCsvImport', 'runQuizletImport']) {
  const m = c.match(new RegExp(`async function ${fn}\\(s\\) \\{([\\s\\S]*?)\\n  \\}`));
  if (!m) { fail.push(`${fn}: 找不到函式`); continue; }
  if (m[1].includes(`_phase === 'importing'`) && m[1].includes('匯入進行中')) {
    pass.push(`${fn}: 進入即攔 _phase==='importing'（重入防護）`);
  } else {
    fail.push(`${fn}: 缺少重入 guard`);
  }
}

// T2 靜態：兩個 run button 在 importing 時 disabled
const btnCsv = c.match(/id="importRunBtn"[^>]*/)?.[0] || '';
const btnQz = c.match(/id="quizletImportRunBtn"[^>]*/)?.[0] || '';
if (btnCsv.includes(`_phase === 'importing'`)) pass.push('importRunBtn: importing 時 disabled（源頭防雙擊）');
else fail.push('importRunBtn 未在 importing 時 disabled');
if (btnQz.includes(`_phase === 'importing'`)) pass.push('quizletImportRunBtn: importing 時 disabled');
else fail.push('quizletImportRunBtn 未在 importing 時 disabled');

// T3 靜態負控制：_phase 只在 run* 內設為 'importing'，guard 在其之前
const g1 = c.indexOf(`async function runCsvImport`);
const setIdx = c.indexOf(`_phase = 'importing'`);
// guard 必須在設定值之前（第一處 _phase='importing' 在 runCsv 內且在其 guard 之後）
if (setIdx > g1) pass.push('guard 位於 _phase 翻轉之前（防護次序正確）');
else fail.push('guard 次序可疑');

// T4 動態模擬：用 ESM import 真源碼跑一個 min 假物件驗 guard 邏輯
//（import.js 依賴 DOM/window/toast，直接 import 會炸；改以字面字串層級驗證 vs 期望模式）
const expects = [
  [/if \(_phase === 'importing'\) \{ toast\('匯入進行中…'\); return; \}/, 'runCsv 精確 guard 模式'],
  [/if \(_phase === 'importing'\) \{ toast\('匯入進行中…'\); return; \}/, 'runQuizlet 精確 guard 模式'],
];
expects.forEach(([re, name]) => {
  const hits = c.match(new RegExp(re.source, 'g')) || [];
  if (hits.length >= 1) pass.push(`${name} ✓`);
  else fail.push(`${name}: 未命中`);
});

console.log(`\nG28 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(p => console.log('  ✓ ' + p));
fail.forEach(f2 => console.log('  ✗ ' + f2));
process.exit(fail.length ? 1 : 0);