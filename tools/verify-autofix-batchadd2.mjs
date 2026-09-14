// AUTOFIX1+BATCHADD2: (1) getAllWords SELECT 漏 etymology/syllables/phrases → 重啟後自動填入欄位消失
//                      (2) 批量新增分析後「移入/開始」會關掉 modal（僅叉叉/取消/背景可關）
// 跑法：node tools/verify-autofix-batchadd2.mjs
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('== T1 AUTOFIX1: db.js getAllWords SELECT 欄位完整性 ==');
const dbjs = readFileSync('/home/jupiter/teno 修檢版/src/lib/db.js', 'utf8');
const sel = dbjs.match(/SELECT id, word, definition, part_of_speech[^']*FROM words ORDER BY created_at/)?.[0] || '';
const WORD_COLS = ['id','word','definition','part_of_speech','pronunciation','example','deck','tags','image','description','created_at','related','forms','synonym','antonym','derivative','examples','etymology','syllables','phrases'];
for (const c of WORD_COLS) ok(`SELECT 含 ${c}`, sel.includes(c));
// map 端讀取的欄位必須全部在 SELECT 投影內（缺=讀 undefined→'' 靜默滅資料，本 bug 原樣）
const mapBlock = dbjs.match(/return rows\.map\(r => \(\{[\s\S]*?\}\)\);/)?.[0] || '';
for (const c of ['etymology','syllables','phrases']) ok(`map 讀 ${c} 且 SELECT 有`, mapBlock.includes(`r.${c}`) && sel.includes(c));
// 負控制：SELECT 不可再漏任何 words 表實欄（對真 DB schema 全欄位對照）
{
  const real = new DatabaseSync('/home/jupiter/.config/com.teno.app/teno.db', { readOnly: true });
  const cols = real.prepare('PRAGMA table_info(words)').all().map(c => c.name);
  const selectCols = sel.replace(/^SELECT /, '').replace(/ FROM words.*$/, '').split(',').map(s => s.trim());
  for (const c of cols) {
    if (c === 'sort_key') continue; // 排序用衍生欄（如有）
    ok(`words.${c} 在 SELECT 投影`, selectCols.includes(c), `投影缺此欄`);
  }
  real.close();
}

console.log('== T2 AUTOFIX1: CLI loadState 鏡像同欄 ==');
const cli = readFileSync('/home/jupiter/teno 修檢版/tools/cli.mjs', 'utf8');
const cliSel = cli.match(/SELECT id, word, definition, part_of_speech[^']*FROM words'\)/)?.[0] || cli.match(/db\.prepare\('SELECT id, word[\s\S]*?FROM words'\)/)?.[0] || '';
for (const c of ['etymology','syllables','phrases']) ok(`CLI SELECT 含 ${c}`, cliSel.includes(c));

console.log('== T3 AUTOFIX1: 真 DB 讀回（資料在、修後讀得到） ==');
{
  const real = new DatabaseSync('/home/jupiter/.config/com.teno.app/teno.db', { readOnly: true });
  const row = real.prepare("SELECT word, syllables, etymology, phrases FROM words WHERE TRIM(COALESCE(syllables,''))!='' ORDER BY created_at DESC LIMIT 1").get();
  ok('真 DB 有 syllables 資料', !!row && !!row.syllables);
  // 模擬修後 SELECT：抓同欄位（證明資料一直都在，只是 app 讀不到）
  ok('syllables 非空可讀', row?.syllables?.length > 0, JSON.stringify(row));
  real.close();
}

console.log('== T4 BATCHADD2: 批量 modal 關閉語意 ==');
const deck = readFileSync('/home/jupiter/teno 修檢版/src/pages/deck-browser.js', 'utf8');
const moveBlock = deck.match(/deckBatchMoveAll[\s\S]{0,900}?\}\);/)?.[0] || '';
const startBlock = deck.match(/deckBatchStart[\s\S]{0,700}?\}\);/)?.[0] || '';
ok('移入按鈕不呼叫 renderInPlace（modal 不炸）', !moveBlock.includes('renderInPlace'), 'move 區塊仍含 renderInPlace');
ok('移入按鈕不呼叫 close()', !moveBlock.includes('close();'), 'move 區塊仍含 close()');
ok('開始按鈕不呼叫 close()', !startBlock.includes('close();'), 'start 區塊仍含 close()');
ok('開始按鈕不呼叫 renderInPlace', !startBlock.includes('renderInPlace'));
ok('modal 關閉三路保留（叉叉/取消/背景）', 
  /deckBatchClose[^}]*close/.test(deck) && /deckBatchCancel[^}]*close/.test(deck) && /e\.target\.id === 'deckBatchModal'[^}]*close/.test(deck));
// 負控制：模擬舊碼（renderInPlace 在 move handler 內）應被判 FAIL
ok('負控制:舊碼（renderInPlace in move）會被抓', (() => {
  const fake = `document.getElementById('deckBatchMoveAll')?.addEventListener('click', async () => { await s.actions.editWord(); renderInPlace(s); });`;
  const fb = fake.match(/deckBatchMoveAll[\s\S]{0,900}?\}\);/)?.[0] || '';
  return fb.includes('renderInPlace');
})());

console.log(fail === 0 ? `AUTOFIX1+BATCHADD2: PASS (${pass} pass, 0 fail)` : `AUTOFIX1+BATCHADD2: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
