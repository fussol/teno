#!/usr/bin/env node
// OCR 建置期離線資產複製（計畫 v1.3 §6.7）：
//   worker.min.js + tesseract-core-*-lstm.wasm.js 變體 → public/assets/ocr/
//   eng.traineddata.gz（tessdata_fast raw URL，缺檔才下載）→ public/assets/ocr/lang/
// 執行期零下載（CSP connect-src 零放寬）。npm run ocr:assets 觸發。
import { cpSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'public/assets/ocr');
const CORE = path.join(ROOT, 'node_modules/tesseract.js-core');
const DIST = path.join(ROOT, 'node_modules/tesseract.js/dist');
const TESSDATA_URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata';

function need(dir, file, src) {
  const dst = path.join(dir, file);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) { console.log(`  skip ${file} (unchanged)`); return; }
  cpSync(src, dst);
  console.log(`  copy ${file}`);
}

console.log('[ocr:assets] worker + core 變體');
mkdirSync(path.join(OUT, 'core'), { recursive: true });
mkdirSync(path.join(OUT, 'lang'), { recursive: true });
need(OUT, 'worker.min.js', path.join(DIST, 'worker.min.js'));
// 主 API UMD dist：adapter 以 <script src> 注入（window.Tesseract），
// 繞開 tesseract.js main=CJS 與 optimizeDeps.exclude／public JS import 的雙重衝突
need(OUT, 'tesseract.min.js', path.join(DIST, 'tesseract.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  need(path.join(OUT, 'core'), f, path.join(CORE, f));
}

// eng.traineddata.gz — tesseract.js gzip:true 預設要求 lang/<lang>.traineddata.gz
const gz = path.join(OUT, 'lang', 'eng.traineddata.gz');
if (!existsSync(gz)) {
  const raw = path.join(OUT, 'lang', 'eng.traineddata');
  if (!existsSync(raw)) {
    console.log('[ocr:assets] 下載 eng.traineddata (tessdata_fast)...');
    execSync(`curl -sL --fail -o ${JSON.stringify(raw)} ${TESSDATA_URL}`, { stdio: 'inherit' });
  }
  // traineddata 檔頭 uint32 LE = 0x18（本機 /usr/share/tessdata 四檔實測一致）— 防抓到 HTML 錯誤頁
  const head = readFileSync(raw).subarray(0, 4);
  const magic = head.readUInt32LE(0);
  if (magic !== 0x18 || statSync(raw).size < 1000000) {
    console.error('[ocr:assets] eng.traineddata magic/大小不符（下載損壞/錯誤頁？）', magic.toString(16), statSync(raw).size);
    process.exit(1);
  }
  writeFileSync(gz, gzipSync(readFileSync(raw), { level: 9 }));
  console.log(`  gzip eng.traineddata → eng.traineddata.gz (${(statSync(gz).size / 1048576).toFixed(1)} MB)`);
} else {
  console.log('  skip eng.traineddata.gz (exists)');
}
console.log('[ocr:assets] done →', path.relative(ROOT, OUT));
