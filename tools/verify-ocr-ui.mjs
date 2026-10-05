#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-UI 驗證（T4）— src/pages/ocr.js（OCR 已從 tools.js 獨立成頁）
//   U1 引擎選單由 registry 動態生成（import listEngines＋engineSelectOptions→option）
//   U2 #ocrEngineSelect class=form-input；讀值＝原生 .value（嚴禁 _getMethod/custom-select）
//   U3 持久化雙向：getSetting('ocr_engine') 還原＋change→setSetting('ocr_engine')
//   U4 camera/check 圖標：svg.js import＋映射；OCR 頁用 icon(...) 零 emoji
//   U5 OCR 為獨立頁：render/onMount 匯出
//   U6 OCR render HTML 無 emoji（圖標一律 svg.js；badge 於 JS 邏輯不在此段）
//   U7 token 白名單正則與計畫 §5 逐字一致（/i＋{1,30}）
//   U8 元素 id 全綁定；busy 態 disable 邏輯存在
//   U9 registry 全部 id 有標籤覆蓋
//   NC1 剝除動態生成（改寫死 option）→ U1 必紅（測敏感）
//   NC2 剝除 setSetting 持久化 → U3 必紅；NC 反換釘：U1/U3a/U3c 不誤傷
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OCR = path.join(ROOT, 'src/pages/ocr.js');
const SVG = path.join(ROOT, 'src/lib/svg.js');

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
};

const ocr = fs.readFileSync(OCR, 'utf8');
const svg = fs.readFileSync(SVG, 'utf8');

// OCR render HTML 切片（render → onMount）
const renderStart = ocr.indexOf('export function render(s)');
const renderEnd = ocr.indexOf('export function onMount(s)');
const ocrHtml = renderStart !== -1 && renderEnd > renderStart ? ocr.slice(renderStart, renderEnd) : '';

console.log('═══ OCR-UI T4 驗證 ═══');

// U1 registry 動態生成
check('U1a ocr.js import listEngines', /import\s*\{\s*listEngines\s*\}\s*from\s*'\.\.\/lib\/ocr\/engine\.js'/.test(ocr), true);
check('U1b 選項由 engineSelectOptions().map 生成', ocrHtml.includes('engineSelectOptions().map') && ocr.includes('listEngines()'), true);
check('U1c 無寫死 <option value="tesseract"> 字面', /<option value="tesseract">/.test(ocrHtml), false);

// U2 form-input＋原生 .value 讀值
check('U2a #ocrEngineSelect class=form-input', /<select id="ocrEngineSelect" class="form-input"/.test(ocrHtml), true);
check('U2b 讀值用原生 engSel.value', /setSetting\('ocr_engine', engSel\.value\)/.test(ocr), true);
check('U2c 非 custom-select 讀值', /_getMethod\(['"]ocrEngine|ocrEngineCs/.test(ocr), false);

// U3 持久化雙向
check('U3a getSetting(ocr_engine) 還原', /getSetting\('ocr_engine'\)/.test(ocr), true);
check('U3b change→setSetting(ocr_engine, engSel.value)', /setSetting\('ocr_engine', engSel\.value\)/.test(ocr), true);
check('U3c change 事件綁定', /engSel\.addEventListener\('change'/.test(ocr), true);

// U4 camera/check 圖標
check('U4a svg.js cameraRaw import', /import cameraRaw from 'lucide-static\/icons\/camera\.svg\?raw'/.test(svg), true);
check('U4b svg.js icons.camera 映射', /camera:\s*\(\) => S\(cameraRaw\)/.test(svg), true);
check('U4c OCR render 用 icon(camera)', (ocrHtml.match(/\$\{icon\('camera'\)\}/g) || []).length, 2);
check('U4d icon(check) 用於入庫按鈕', /\$\{icon\('check'\)\}/.test(ocrHtml), true);

// U5 OCR 為獨立頁
check('U5 ocr.js 匯出 render/onMount（獨立頁）', renderStart !== -1 && renderEnd > renderStart, true);

// U6 零 emoji（OCR render HTML 段）
{
  const emoji = ocrHtml.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || [];
  check('U6 OCR render HTML 無 emoji', emoji, []);
}

// U7 正則逐字對齊計畫 §5
const _ocrWant = ['const _OCR_TOKEN_RE', '=', '/^', '[a-z]', "[a-z'-]", '{1', ',30', '}$', '/i;'].join('');
check('U7 token 白名單正則逐字元＝計畫 §5', ocr.includes(_ocrWant), true);

// U8 元素 id 全綁定＋busy disable
{
  const ids = ['ocrCaptureBtn', 'ocrCameraInput', 'ocrImportInput', 'ocrEngineSelect', 'ocrResultArea', 'ocrLoading',
    'ocrCandidatesContainer', 'ocrSelectAllBtn', 'ocrConfirmBtn'];
  const missing = ids.filter(id => !ocr.includes(`'${id}'`) || !ocrHtml.includes(`id="${id}"`));
  check('U8a 元素 HTML＋綁定齊備', missing, []);
  check('U8b busy 態按鈕 disabled 切換', /\[capBtn, impBtn\]\.forEach\(bn => \{ bn\.disabled = b/.test(ocr), true);
  check('U8c 辨識中點擊防重入（_busy 守衛）', /if \(!_busy\) camIn\.click\(\)/.test(ocr), true);
}

// U9 registry 匯入＋標籤覆蓋
{
  const { listEngines } = await import('file://' + path.join(ROOT, 'src/lib/ocr/engine.js'));
  const ids = listEngines().map(e => e.id);
  const lblBlock = ocr.slice(ocr.indexOf('_ENG_LABELS = {'), ocr.indexOf('}', ocr.indexOf('_ENG_LABELS = {')));
  const uncovered = ids.filter(id => !(lblBlock.includes(`${id}:`) || lblBlock.includes(`'${id}':`)));
  check('U9 registry 全部 id 有標籤', uncovered, []);
}

// ── NC 負控制 ──
{
  // NC1: 改寫死 option（剝除 registry 動態生成）→ U1b 紅 U1c 紅
  const neg1 = ocr.replace(
    /\$\{engineSelectOptions\(\)\.map\(e => `<option value="\$\{e\.id\}">\$\{e\.label\}<\/option>`\)\.join\(''\)\}/,
    '<option value="tesseract">Tesseract.js (預設)</option>');
  if (neg1 === ocr) { console.log('FAIL NC1 錨點漂移'); failures++; }
  else {
    const n1Start = neg1.indexOf('export function render(s)');
    const n1Html = neg1.slice(n1Start, neg1.indexOf('export function onMount(s)'));
    check('NC1 剝除後 U1b 紅（動態生成偵測敏感）', /engineSelectOptions\(\)\.map/.test(n1Html), false);
    check('NC1 剝除後 U1c 紅（寫死 option 被逮）', /<option value="tesseract">/.test(n1Html), true);
    check('NC1 反換釘：U2a form-input 斷言不受波及', /<select id="ocrEngineSelect" class="form-input"/.test(n1Html), true);
  }
  // NC2: 剝除 setSetting 持久化 → U3b 紅；反換釘 U3a/U3c 不受波及
  const neg2 = ocr.replace(
    /setSetting\('ocr_engine', engSel\.value\)\.catch\(\(\) => \{\}\);/,
    '/* NEG: persistence stripped */');
  if (neg2 === ocr) { console.log('FAIL NC2 錨點漂移'); failures++; }
  else {
    check('NC2 剝除後 U3b 紅（持久化寫入偵測敏感）', /setSetting\('ocr_engine', engSel\.value\)/.test(neg2), false);
    check('NC2 反換釘：U3a 讀取斷言仍綠', /getSetting\('ocr_engine'\)/.test(neg2), true);
    check('NC2 反換釘：U3c change 綁定仍綠', /engSel\.addEventListener\('change'/.test(neg2), true);
  }
}

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
