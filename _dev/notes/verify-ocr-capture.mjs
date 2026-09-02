// ═══════════════════════════════════════════════════════════════
// verify-ocr-capture.mjs — OCR-CAPTURE 案 harness
// 計畫：OCR-CAPTURE-fix-plan.md §5（L2 功能性測試）
// 測試對象：src/pages/ocr.js 的純函式 mapToSource（顯示座標→原圖座標）
//
// 執行：node _dev/notes/verify-ocr-capture.mjs
// 全部 PASS 才代表切割座標映射邏輯正確（負控制：比例不變/越界 clamp）
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '../../src/pages/ocr.js');

// 手動抽取 mapToSource（從 ESM module 文字抓縫，避免依賴 DOM import 鏈）
const srcText = readFileSync(SRC, 'utf8');
const mapFnMatch = srcText.match(/export function mapToSource\(sx, sy, dispW, dispH, imgW, imgH\) \{[\s\S]*?\n\}/);
if (!mapFnMatch) { console.error('❌ 找不到 mapToSource 函式'); process.exit(1); }
const mapToSource = eval('(' + mapFnMatch[0].replace('export ', '') + ')');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail ?? ''}`); }
}

console.log('T1: 比例一致 —— 顯示 400×800 → 原圖 2000×4000（2px 顯示 = 10px 原圖）');
{
  const r = mapToSource(100, 200, 400, 800, 2000, 4000);
  check('x 100/200 = 500/1000', r.sx === 500 && r.sy === 1000, JSON.stringify(r));
}

console.log('T2: 顯示座標 = 原圖座標（同尺寸，1:1）');
{
  const r = mapToSource(120, 80, 120, 80, 120, 80);
  check('同尺寸不放大', r.sx === 120 && r.sy === 80, JSON.stringify(r));
}

console.log('T3: 越界 clamp —— 顯示超出邊緣仍映射在原圖內');
{
  const r = mapToSource(9999, -50, 400, 800, 2000, 4000);
  check('x clamp 到 2000、y clamp 到 0', r.sx === 2000 && r.sy === 0, JSON.stringify(r));
}

console.log('T4: 負控制 —— dispW/dispH 為 0 不除零（回 0）');
{
  const r = mapToSource(100, 100, 0, 0, 2000, 4000);
  check('除以零回 0', r.sx === 0 && r.sy === 0, JSON.stringify(r));
}

console.log('T5: 原圖尺寸為 0 時 clamp 到 0（不負數）');
{
  const r = mapToSource(100, 100, 400, 800, 0, 0);
  check('imgW/H=0 → 0', r.sx === 0 && r.sy === 0, JSON.stringify(r));
}

console.log('T6: 切割一個區塊（顯示 200x200 左上角 → 原圖左上）');
{
  // 顯示 400×800, 原圖 2000×4000，切割框 (10,10,60,40) 顯示 → 原圖 (50,50,300,200)
  // 測試區塊的兩角映射成原圖座標差 = 邊長
  const a = mapToSource(10, 10, 400, 800, 2000, 4000);
  const b = mapToSource(70, 50, 400, 800, 2000, 4000);
  const w = b.sx - a.sx, h = b.sy - a.sy;
  check('切割寬 60 顯示 = 300 原圖', w === 300, `w=${w}`);
  check('切割高 40 顯示 = 200 原圖', h === 200, `h=${h}`);
}

console.log('\n══════════════════════════════');
console.log(`結果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);