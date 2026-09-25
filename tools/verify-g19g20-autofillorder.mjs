// verify-g19g20: 自動填入鏈退場後改驗「新接線」＋G19 db 存取規則　（靜態）
// 背景：G19/G20 原為 autoFillOrder 的兩條規則
//   G19: db.js export 裸 getSetting/setSetting（無 db namespace）→ 不可再用 .db.getSetting
//   G20: 三方寫入分隔符統一 '|'（CLI join('|') 為 canonical）
// AUTOFILL2/3 已把 chip 排序鏈整體移除（autoFillOrder 不再被任何程式碼讀寫），
// 故 G20 的「分隔符一致性」議題隨鏈消失；本 harness 改為：
//   ① 保留 G19 規則（仍適用於所有 db 存取）
//   ② 驗整個 src 不再引用 autoFillOrder（防鏈悄悄回歸）
//   ③ 驗四個自動填入入口都走共用執行器（AUTOFILL3 的收斂成果）
import { readFileSync } from 'node:fs';

const fail = [];
const pass = [];
const db = readFileSync('src/lib/db.js', 'utf8');

// ① G19 前提
if (/export async function getSetting/.test(db) && /export async function setSetting/.test(db)) {
  pass.push('db.js export 裸 getSetting/setSetting（G19 前置成立）');
} else {
  fail.push('db.js 未 export 裸 getSetting/setSetting');
}
for (const f of ['src/pages/browser.js', 'src/pages/deck-browser.js', 'src/pages/tools.js']) {
  const c = readFileSync(f, 'utf8');
  const broken = c.match(/\.db\.(?:get|set)Setting\('/g) || [];
  if (broken.length === 0) pass.push(`${f}: 無 .db.getSetting/.db.setSetting 呼叫`);
  else fail.push(`${f}: 殘留 ${broken.length} 個 .db.*Setting 呼叫`);
}

// ② 鏈不再被引用（程式碼層；註解提及不算）
const SRC = ['src/pages/browser.js', 'src/pages/deck-browser.js', 'src/pages/tools.js', 'src/lib/autofill-engine.js', 'src/lib/autofill-run.js'];
for (const f of SRC) {
  const codeOnly = readFileSync(f, 'utf8').split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  if (!codeOnly.includes('autoFillOrder')) pass.push(`${f}: 不引用 autoFillOrder（鏈已退場）`);
  else fail.push(`${f}: 仍引用 autoFillOrder → 鏈可能回歸`);
}

// ③ 四個入口走共用執行器
const brow = readFileSync('src/pages/browser.js', 'utf8');
const deck = readFileSync('src/pages/deck-browser.js', 'utf8');
const cases = [
  ['browser 自動填入', brow, /comboAutoFill\(w, _formExisting\(\)\)/],
  ['browser 例句鈕', brow, /comboExampleCandidate\(w\)/],
  ['deck 新增自動填入', deck, /comboAutoFill\(w, _addExisting\(\)\)/],
  ['deck 編輯自動填入', deck, /comboAutoFill\(w, _editExisting\(\)\)/],
  ['deck 新增例句鈕', deck, /comboExampleCandidate\(w\)/],
];
for (const [name, src, re] of cases) {
  if (re.test(src)) pass.push(`${name}: 走共用執行器`);
  else fail.push(`${name}: 未走共用執行器`);
}

console.log(`\nG19G20 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(p => console.log('  ✓ ' + p));
fail.forEach(f => console.log('  ✗ ' + f));
process.exit(fail.length ? 1 : 0);
