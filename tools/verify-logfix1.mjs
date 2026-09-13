// LOGFIX1: 舊 log 三 bug 驗證 — overlap 降噪／busy 重試／txn 守門＋舊檔相容
import { readFileSync } from 'node:fs';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const src = (p) => readFileSync(`${R}/${p}`, 'utf8');

console.log('== BUG1 overlap 降噪 ==');
for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
  const s = src(f);
  ok(`${f}: 無 console.error overlap`, !s.includes("console.error('[overlap]'"));
  ok(`${f}: warn＋once guard`, s.includes('_overlapWarned') && s.includes("console.warn('[overlap]"));
}

console.log('== BUG2 busy 排隊＋重試 ==');
const db = src('src/lib/db.js');
ok('helpers 到齊', db.includes('_writeChain') && db.includes('_retryBusy') && db.includes('_safeRollback') && db.includes('_isBusy'));
ok('busy 正則含 code 5/517', db.includes('code:') && db.includes('517'));
for (const fn of ['saveWord', 'saveCard', 'setSetting', 'addAudit', 'addReviewLog', 'deleteWord'])
  ok(`db:${fn} 走 _write`, new RegExp(`(export async function ${fn}[\\s\\S]{0,400})_write\\(`).test(db));
ok('重試回退遞增', db.includes('30 * (i + 1)'));

console.log('== BUG3 txn 守門 ==');
ok('deleteWord inTxn 旗標', db.includes('let inTxn = false') && db.includes('if (inTxn) await _safeRollback(d)'));
ok('COMMIT 後清旗標', db.includes('inTxn = false'));

console.log('== BUG4 OCR 撇號 ==');
const st = src('src/lib/store.js');
ok('所有格剝離', st.includes("replace(/'s$/i, '')"));
const strip = (w) => w.replace(/'s$/i, '').replace(/^'+|'+$/g, '') || w;
ok("region's→region", strip("region's") === 'region');
ok("保留內部撇號 don't→don't", strip("don't") === "don't");
ok('millions 不動', strip('millions') === 'millions');

console.log('== 舊檔相容（新版吃得下舊 log）==');
const v4 = readFileSync('/home/jupiter/workspace/teno-applog-2026-09-13-v4.txt', 'utf8');
const lines = v4.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
ok('v4 筆數 7 萬＋', lines.length > 70000, `實際 ${lines.length}`);
let bad = 0;
const SCOPES = new Set(['study', 'sync', 'ocr', 'system', 'misc']);
for (const l of lines.slice(0, 2000)) {
  const p = l.split(' | ');
  if (p.length < 4) { bad++; continue; }
  if (!SCOPES.has(p[2])) bad++;
}
ok('抽查前 2000 筆四段＋合法 scope', bad === 0, `壞 ${bad}`);
// 舊三段按新 parser 語意：四段切＋第 3 段合法 scope 才算新格式，否則整段按舊三段吃
const parseLine = (line) => {
  const p4 = line.split(' | ');
  if (p4.length >= 4 && SCOPES.has(p4[2].trim())) {
    const [ts, level, scope, ...rest] = p4;
    return { ts, level: level.trim(), scope: scope.trim(), msg: rest.join(' | ') };
  }
  const m = line.split(' | ');
  if (m.length < 3) return null;
  return { ts: m[0], level: m[1].trim(), scope: 'misc', msg: m.slice(2).join(' | ') };
};
const oldSample = '2026-08-13 09:44:51.209 | log | [build] words= 4892 cards= 1657';
const r1 = parseLine(oldSample);
ok('舊三段落 misc 不丟訊息', r1 && r1.scope === 'misc' && r1.msg.includes('[build]'));
const tricky = '2026-08-13 10:01:00.000 | warn | pipe | inside | message';
const r2 = parseLine(tricky);
ok('舊三段 message 內 | 照收', r2 && r2.scope === 'misc' && r2.msg === 'pipe | inside | message');
const newSample = '2026-09-13 10:00:00.000 | log | study | 複習完成';
const r3 = parseLine(newSample);
ok('新四段正常', r3 && r3.scope === 'study' && r3.msg === '複習完成');
const bogus = '2026-09-13 11:00:00.000 | log | bogus | hello';
const r4 = parseLine(bogus);
ok('非法 scope 不斷章取義', r4 && r4.scope === 'misc' && r4.msg === 'bogus | hello');

console.log(fail === 0 ? `LOGFIX1: PASS (${pass} pass, 0 fail)` : `LOGFIX1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
