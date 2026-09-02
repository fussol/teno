#!/usr/bin/env node
// OCR-ASSETS 驗證（T2）— 建置期離線資產管線完整性
//   A1 npm 依賴：tesseract.js ^7 devDependency 存在且版本匹配
//   A2 package.json script ocr:assets 存在且指向 tools/copy-ocr-assets.mjs
//   A3 vite.config.js optimizeDeps.exclude 含 'tesseract.js'
//   A4 public 資產六件齐備（worker/3 core 變體/lang gz），且與 node_modules 源檔 byte-identical
//   A5 eng.traineddata.gz gunzip 還原後 magic=0x18 且與 tessdata 尺寸一致（非錯誤頁）
//   A6 負控制：剝除 vite exclude 的 'tesseract.js' → 靜態斷言必紅（測敏感）
//      ＋ 截斷 gz → A5 必紅（防假資產）
//   A7 gitignore：public/assets/ocr/ 不入 repo（防 18MB 誤 commit）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
};
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

console.log('═══ OCR-ASSETS T2 驗證 ═══');

// A1
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('A1 tesseract.js devDep ^7', /^[\^~]?7\./.test(pkg.devDependencies?.['tesseract.js'] || ''), true);
const tjVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/tesseract.js/package.json'), 'utf8')).version;
check('A1 安裝版本 7.x', /^7\./.test(tjVer), true);

// A2
check('A2 ocr:assets script', pkg.scripts?.['ocr:assets'], 'node tools/copy-ocr-assets.mjs');
check('A2 腳本存在', fs.existsSync(path.join(ROOT, 'tools/copy-ocr-assets.mjs')), true);

// A3
const vite = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
check('A3 vite exclude 含 tesseract.js', /exclude:\s*\[[^\]]*'tesseract\.js'/.test(vite), true);

// A4
const O = path.join(ROOT, 'public/assets/ocr');
const pairs = [
  ['worker.min.js', 'node_modules/tesseract.js/dist/worker.min.js'],
  ['tesseract.min.js', 'node_modules/tesseract.js/dist/tesseract.min.js'],
  ['core/tesseract-core-lstm.wasm.js', 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js'],
  ['core/tesseract-core-simd-lstm.wasm.js', 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'],
  ['core/tesseract-core-relaxedsimd-lstm.wasm.js', 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'],
];
for (const [dst, src] of pairs) {
  const d = path.join(O, dst), s = path.join(ROOT, src);
  check(`A4 ${dst} 與源檔一致`, fs.existsSync(d) && fs.existsSync(s) && sha(d) === sha(s), true);
}

// A5 gz 完整性
const gz = path.join(O, 'lang/eng.traineddata.gz');
check('A5 eng.traineddata.gz 存在', fs.existsSync(gz), true);
let magicOK = false, sizeOK = false;
try {
  const raw = gunzipSync(fs.readFileSync(gz));
  magicOK = raw.readUInt32LE(0) === 0x18;
  sizeOK = raw.length > 1000000; // tessdata_fast eng = 4,113,088B
} catch (e) { /* 截斷/非 gzip → 紅 */ }
check('A5 gunzip 還原 magic=0x18', magicOK, true);
check('A5 還原尺寸 >1MB', sizeOK, true);

// A6 負控制 a：vite exclude 剝除 → A3 斷言必紅
const stripped = vite.replace(/,\s*'tesseract\.js'/, '');
check('A6 NC vite 剝除後斷言紅（測敏感）', /exclude:\s*\[[^\]]*'tesseract\.js'/.test(stripped), false);
// A6 負控制 b：gz 截斷一半 → gunzip 必拋（防假資產）
let truncFail = false;
try { gunzipSync(fs.readFileSync(gz).subarray(0, 2048)); } catch { truncFail = true; }
check('A6 NC gz 截斷 gunzip 必拋（測敏感）', truncFail, true);

// A7 gitignore
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check('A7 public/assets/ocr 已 gitignore', /public\/assets\/ocr\//.test(gi), true);

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
