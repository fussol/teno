#!/usr/bin/env node
// OCR-ENGINE 驗證（T3）— engine.js 註冊表＋回退鏈 單元斷言（mock getSetting）
//   E1 registerEngine 參數驗證
//   E2 選 paddle（available=false 佔位）→ 回退 tesseract
//   E3 getSetting 拋錯 → 回退 tesseract
//   E4 設定幽靈 id → 回退 tesseract
//   E5 設定 null（沒設過）→ 預設 tesseract
//   E6 自訂引擎 available() 拋錯 → 視同不可用 → 回退
//   E7 預設引擎本身不可用 → reject（不靜默回傳炸彈）
//   E8 listEngines 含 tesseract/paddle；getActiveEngine 現讀 setting（無痛切換）
//   NC 負控制：剝除 available 回退段 → paddle 直通（測敏感）；
//      NC 反換釘：NEG 檔正常 tesseract 路徑仍綠（NC 只打回退態）
// 註：node 匯入 engine.js 安全（built-in factory lazy，tesseract-adapter
//     頂層無瀏覽器 API）；本檔絕不呼叫真實 tesseract recognize。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src/lib/ocr/engine.js');
const NEG = path.join(ROOT, 'src/lib/ocr/.ocr-engine-neg.mjs');

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};

const fakeEngine = (id, avail) => ({
  id,
  available: typeof avail === 'function' ? avail : async () => avail,
  recognize: async () => ({ id }),
});
const okSetting = (v) => async () => v;

const { registerEngine, _getActiveEngine, listEngines, hasEngine } = await import('file://' + ENGINE);

console.log('═══ OCR-ENGINE T3 驗證 ═══');

// E1
let t1 = [];
try { registerEngine('', async () => {}); } catch { t1.push('id'); }
try { registerEngine('x', 42); } catch { t1.push('factory'); }
check('E1 registerEngine 參數驗證', t1, ['id', 'factory']);

// E2 佔位 paddle → 回退（用可控 fake 覆蓋內建 tesseract factory，node 安全）
registerEngine('tesseract', async () => fakeEngine('tesseract', true));
{
  const r = await _getActiveEngine(okSetting('paddle'));
  check('E2 paddle(available=false) 回退 tesseract', r.id, 'tesseract');
}
// E3 setting 拋錯
{
  const boom = async () => { throw new Error('DB not connected'); };
  const r = await _getActiveEngine(boom);
  check('E3 getSetting 拋錯回退 tesseract', r.id, 'tesseract');
}
// E4 幽靈 id
{
  const r = await _getActiveEngine(okSetting('cloud-gpt'));
  check('E4 幽靈 id 回退 tesseract', r.id, 'tesseract');
}
// E5 null
{
  const r = await _getActiveEngine(okSetting(null));
  check('E5 未設定 → 預設 tesseract', r.id, 'tesseract');
}
// E6 available() 拋錯 → 視同不可用
{
  registerEngine('flaky', async () => fakeEngine('flaky', async () => { throw new Error('boom'); }));
  const r = await _getActiveEngine(okSetting('flaky'));
  check('E6 available 拋錯 → 回退 tesseract', r.id, 'tesseract');
}
// E7 預設引擎不可用 → reject
{
  registerEngine('tesseract', async () => fakeEngine('tesseract', false));
  let rejected = false;
  try { await _getActiveEngine(okSetting(null)); } catch (_) { rejected = true; }
  check('E7 預設引擎不可用 → reject', rejected, true);
  registerEngine('tesseract', async () => fakeEngine('tesseract', true)); // 還原
}
// E8 registry 現讀語意
{
  check('E8 listEngines 含內建兩引擎', ['tesseract', 'paddle'].every(i => listEngines().some(e => e.id === i)), true);
  check('E8 hasEngine paddle', hasEngine('paddle'), true);
  const r1 = await _getActiveEngine(okSetting('tesseract'));
  registerEngine('second', async () => fakeEngine('second', true));
  const r2 = await _getActiveEngine(okSetting('second'));   // 同 instance 換 setting 即生效
  check('E8 無痛切換（setting 換→engine 換，零 import 寫死）', [r1.id, r2.id], ['tesseract', 'second']);
}

// NC 負控制：剝除 available→回退段
{
  const src = fs.readFileSync(ENGINE, 'utf8');
  const anchor = `  if (!ok) {
    if (id === DEFAULT_ENGINE_ID) {
      throw new Error(\`[ocr] 預設引擎 '\${id}' 在此環境不可用\`);
    }
    return _loadDefault(defaultFactory);
  }`;
  if (!src.includes(anchor)) { console.log('FAIL NC 錨點漂移'); failures++; }
  else {
    const negRun = NEG + '.' + process.pid + '.mjs';
    fs.writeFileSync(negRun, src.replace(anchor, '  // NEG: available 回退段剝除'));
    try {
      const neg = await import('file://' + negRun);
      neg.registerEngine('tesseract', async () => fakeEngine('tesseract', true));
      const r = await neg._getActiveEngine(okSetting('paddle'));
      check('NC 剝除後 paddle(不可用) 直通（測敏感）', r.id, 'paddle');
      const r2 = await neg._getActiveEngine(okSetting('tesseract'));
      check('NC 反換釘：NEG 正常 tesseract 路徑仍正確', r2.id, 'tesseract');
    } finally {
      if (fs.existsSync(negRun)) fs.unlinkSync(negRun);
    }
  }
}

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
