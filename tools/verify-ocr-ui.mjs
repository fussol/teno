#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-UI 驗證（T4）— tools.js OCR 區塊靜態斷言＋負控制
//   U1 引擎選單由 registry 動態生成（import listEngines＋map→option）
//   U2 #ocrEngineSelect class=form-input；讀值＝原生 .value（嚴禁 .cs-t/_getMethod）
//   U3 持久化雙向：getSetting('ocr_engine') 還原＋change→setSetting('ocr_engine')
//   U4 camera 圖標：svg.js import＋icons 映射；tools.js 用 icon('camera') 零 emoji
//   U5 區塊位置：Generate Forms 與 Cambridge 之間（計畫 §4）
//   U6 OCR 區塊 HTML 無 emoji（圖標一律 svg.js）
//   U7 token 白名單正則與計畫 §5 逐字一致（/i＋{1,30}）
//   U8 九個元素 id 全綁定；busy 態 disable 邏輯存在
//   U9 registry 實際可匯入：listEngines ⊆ 標籤表覆蓋
//   NC1 剝除動態生成（改寫死 option）→ U1 必紅（測敏感）
//   NC2 剝除 setSetting 持久化 → U3 必紅；NC 反換釘：U1 等其他斷言不误傷
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'src/pages/tools.js');
const SVG = path.join(ROOT, 'src/lib/svg.js');

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
};

const tools = fs.readFileSync(TOOLS, 'utf8');
const svg = fs.readFileSync(SVG, 'utf8');

// OCR 區塊 HTML 切片（render 內：OCR Recognize 註解 → Cambridge 註解）
const ocrStart = tools.indexOf('<!-- OCR Recognize -->');
const ocrEnd = tools.indexOf('<!-- Cambridge Dictionary -->');
const ocrHtml = ocrStart !== -1 && ocrEnd > ocrStart ? tools.slice(ocrStart, ocrEnd) : '';

console.log('═══ OCR-UI T4 驗證 ═══');

// U1 registry 動態生成
check('U1a tools.js import listEngines', /import\s*\{\s*listEngines\s*\}\s*from\s*'\.\.\/lib\/ocr\/engine\.js'/.test(tools), true);
check('U1b 選項由 listEngines().map 生成', ocrHtml.includes("${listEngines().map(e => `<option value=\"${e.id}\">") , true);
check('U1c 無寫死 <option value="tesseract"> 字面', /<option value="tesseract">/.test(ocrHtml), false);

// U2 form-input＋原生 .value 讀值
check('U2a #ocrEngineSelect class=form-input', /<select id="ocrEngineSelect" class="form-input"/.test(ocrHtml), true);
{
  const block = tools.slice(tools.indexOf('function initOcrBlock'), tools.indexOf('_initCustomSelects();', tools.indexOf('function initOcrBlock')));
  check('U2b 讀值用原生 engSel.value', /engSel\.value/.test(block), true);
  check('U2c 無 .cs-t / _getMethod 讀值', /\.cs-t|_getMethod\(['"]ocrEngine/.test(block), false);
}

// U3 持久化雙向
check('U3a getSetting(ocr_engine) 還原', /getSetting\('ocr_engine'\)/.test(tools), true);
check('U3b change→setSetting(ocr_engine, engSel.value)', /setSetting\('ocr_engine', engSel\.value\)/.test(tools), true);
check('U3c change 事件綁定', /engSel\.addEventListener\('change'/.test(tools), true);

// U4 camera 圖標
check('U4a svg.js cameraRaw import', /import cameraRaw from 'lucide-static\/icons\/camera\.svg\?raw'/.test(svg), true);
check('U4b svg.js icons.camera 映射', /camera:\s*\(\) => S\(cameraRaw\)/.test(svg), true);
check('U4c tools.js OCR 區塊用 icon(camera)', (ocrHtml.match(/\$\{icon\('camera'\)\}/g) || []).length, 2);
check('U4d icon(check) 用於入庫按鈕', /\$\{icon\('check'\)\}/.test(ocrHtml), true);

// U5 位置：Generate Forms < OCR < Cambridge
{
  const gf = tools.indexOf('<!-- Generate Forms -->');
  const cb = tools.indexOf('<!-- Cambridge Dictionary -->');
  check('U5 OCR 區塊位於 Generate Forms 與 Cambridge 之間', gf !== -1 && gf < ocrStart && ocrStart < ocrEnd && ocrEnd === cb, true);
}

// U6 零 emoji（OCR HTML 段）
{
  const emoji = ocrHtml.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || [];
  check('U6 OCR HTML 無 emoji', emoji, []);
}

// U7 正則逐字對齊計畫 §5
const _ocrWant = ['const _OCR_TOKEN_RE ', '=', ' ', '/^', '[a-z]', "[a-z'-]", '{1', ',30', '}$', '/i;'].join('');
check('U7 token 白名單正則逐字元＝計畫 §5', tools.includes(_ocrWant), true);

// U8 元素 id 全綁定＋busy disable
{
  const ids = ['ocrCaptureBtn', 'ocrFileInput', 'ocrEngineSelect', 'ocrResultArea', 'ocrLoading',
    'ocrCandidatesContainer', 'ocrCandidatesList', 'ocrSelectAllBtn', 'ocrConfirmBtn'];
  const missing = ids.filter(id => !tools.includes(`'${id}'`) || !ocrHtml.includes(`id="${id}"`));
  check('U8a 九元素 HTML＋綁定齊備', missing, []);
  check('U8b busy 態 capBtn.disabled 切換', /capBtn\.disabled = b/.test(tools), true);
  check('U8c 辨識中點擊防重入（_ocrBusy 守衛）', /if \(!_ocrBusy\) fileIn\.click\(\)/.test(tools), true);
}

// U9 registry 匯入＋標籤覆蓋
{
  const { listEngines } = await import('file://' + path.join(ROOT, 'src/lib/ocr/engine.js'));
  const ids = listEngines().map(e => e.id);
  const labelKeys = [...tools.matchAll(/^\s*(\w+):\s*'[^']*'/gm)].map(m => m[1]);
  const lblBlock = tools.slice(tools.indexOf('_OCR_ENG_LABELS = {'), tools.indexOf('}', tools.indexOf('_OCR_ENG_LABELS = {')));
  const uncovered = ids.filter(id => !lblBlock.includes(`${id}:`));
  check('U9 registry 全部 id 有標籤', { ids, uncovered }, { ids: ['tesseract', 'paddle'], uncovered: [] });
}

// ── NC 負控制 ──
{
  // NC1: 改寫死 option（剝除 registry 動態生成）→ U1b 紅 U1c 紅
  const neg1 = tools.replace(
    /\$\{listEngines\(\)\.map\(e => `<option value="\$\{e\.id\}">\$\{_OCR_ENG_LABELS\[e\.id\] \|\| e\.id\}<\/option>`\)\.join\(''\)\}/,
    '<option value="tesseract">Tesseract.js (預設)</option>');
  if (neg1 === tools) { console.log('FAIL NC1 錨點漂移'); failures++; }
  else {
    const n1Start = neg1.indexOf('<!-- OCR Recognize -->');
    const n1Html = neg1.slice(n1Start, neg1.indexOf('<!-- Cambridge Dictionary -->'));
    check('NC1 剝除後 U1b 紅（動態生成偵測敏感）', /listEngines\(\)\.map/.test(n1Html), false);
    check('NC1 剝除後 U1c 紅（寫死 option 被逮）', /<option value="tesseract">/.test(n1Html), true);
    check('NC1 反換釘：U2a form-input 斷言不受波及', /<select id="ocrEngineSelect" class="form-input"/.test(n1Html), true);
  }
  // NC2: 剝除 setSetting 持久化 → U3b 紅；反換釘 U3a/U3c 不受波及
  const neg2 = tools.replace(
    /import\('\.\.\/lib\/db\.js'\)\.then\(m => m\.setSetting\('ocr_engine', engSel\.value\)\)\.catch\(\(\) => \{\}\);/,
    '/* NEG: persistence stripped */');
  if (neg2 === tools) { console.log('FAIL NC2 錨點漂移'); failures++; }
  else {
    check('NC2 剝除後 U3b 紅（持久化寫入偵測敏感）', /setSetting\('ocr_engine', engSel\.value\)/.test(neg2), false);
    check('NC2 反換釘：U3a 讀取斷言仍綠', /getSetting\('ocr_engine'\)/.test(neg2), true);
    check('NC2 反換釘：U3c change 綁定仍綠', /engSel\.addEventListener\('change'/.test(neg2), true);
  }
}

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
