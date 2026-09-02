// verify-g19g20: autoFillOrder 存取路徑 + 分隔符統一 |  （靜態雙態）
// G19: db.js export 裸 getSetting/setSetting（無 db namespace）→ 不可再用 .db.getSetting
// G20: 三方寫入分隔符統一 '|'（CLI join('|') 為 canonical）
import { readFileSync } from 'node:fs';

const src = ['src/pages/browser.js', 'src/pages/deck-browser.js'];
const db = readFileSync('src/lib/db.js', 'utf8');
const fail = [];
const pass = [];

// PRE 態：檢查 db.js 確實 export 裸函式（G19 前提成立）
if (/export async function getSetting/.test(db) && /export async function setSetting/.test(db)) {
  pass.push('db.js export 裸 getSetting/setSetting（前置成立）');
} else {
  fail.push('db.js 未 export 裸 getSetting/setSetting');
}

for (const f of src) {
  const c = readFileSync(f, 'utf8');
  // G19：不可殘留 .db.getSetting / .db.setSetting 呼叫（註解提及不計）
  const brokenCall = c.match(/\.db\.(?:get|set)Setting\('/g) || [];
  if (brokenCall.length === 0) pass.push(`${f}: 無 .db.getSetting/.db.setSetting 呼叫`);
  else fail.push(`${f}: 殘留 ${brokenCall.length} 個 .db.*Setting 呼叫`);

  // G20：所有寫入分隔符必須是 '|'（含 CLI 對齊），不得用 join(',')
  const badJoin = [...c.matchAll(/join\(','\)/g)].filter(m => {
    const i = m.index;
    return c.slice(Math.max(0, i - 200), i + 20).includes('autoFillOrder');
  });
  if (badJoin.length === 0) pass.push(`${f}: 寫入統一 .join('|')`);
  else fail.push(`${f}: 存在 join(',') 寫入 ${badJoin.length} 處`);

  // 讀端需容忍 | , ;（split 寬容）
  if (/split\(\/\[,|;\]\/\)/.test(c)) pass.push(`${f}: 讀端 split(/[,|;]/) 容許`);
  else fail.push(`${f}: 讀端未用寬容 split`);
}

console.log(`\nG19G20 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(p => console.log('  ✓ ' + p));
fail.forEach(f => console.log('  ✗ ' + f));
process.exit(fail.length ? 1 : 0);