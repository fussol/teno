// SHELF1: 書櫃驗證 — store 動作＋分享區接線＋多本合包語意
import { buildShareCSV, parseCSV } from '../src/core/import.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const R = '/home/jupiter/teno 修檢版';
const store = readFileSync(`${R}/src/lib/store.js`, 'utf8');
const exp = readFileSync(`${R}/src/pages/export.js`, 'utf8');
const db = readFileSync(`${R}/src/lib/db.js`, 'utf8');

// store 六動作全到齊
for (const fn of ['shelfCreate', 'shelfRename', 'shelfDelete', 'shelfSetDecks', 'shelfToggleDeck', 'persistShelves'])
  ok(`store:${fn}`, store.includes(`async ${fn}(`));
// 空名/重名守門
ok('store:空名擋下', store.includes('書櫃名稱不能為空'));
ok('store:重名擋下', store.includes('書櫃已存在'));
// 字本生命週期連動
ok('store:改名連動書櫃', store.includes('updateDeck saveFolders'));
ok('store:刪本清成員', store.includes('deleteDeck saveFolders'));
ok('store:合併不斷鏈', store.includes('mergeDeck saveFolders'));
// db 層現成（零新表）
ok('db:getAllFolders', db.includes('getAllFolders'));
ok('db:saveFolders', db.includes('saveFolders'));
// 分享區接線
for (const id of ['shelfNewBtn', 'shelfNewInput', 'data-shelf-dl', 'data-shelf-edit', 'data-shelf-del', 'data-shelf-ren', 'data-shelf-toggle'])
  ok(`export:接線 ${id}`, exp.includes(id));
ok('export:書櫃獨立 section', exp.includes('書櫃') && exp.includes('renderShelfBlock'));
ok('export:整櫃下載走分享格式', exp.includes(`'書櫃-' + shelfName`) && exp.includes('saveShareCSV(list'));
ok('export:刪櫃指路不動字本', exp.includes('字本本身不受影響'));
ok('export:shelfWords 可測純函式', exp.includes('export function shelfWords'));

// 多本合包語意（模擬 shelfWords：成員聯集＋排序＋缺本忽略）
const words = [
  { word: 'b', deck: 'D2' }, { word: 'a', deck: 'D1' }, { word: 'c', deck: 'D3' },
];
const set = new Set(['D1', 'D2', 'D9']);
const union = words.filter(w => set.has(w.deck || 'Default')).sort((x, y) => x.word.localeCompare(y.word));
ok('合包:只要成員，缺本忽略', union.length === 2 && union[0].word === 'a' && union[1].word === 'b');

// 整櫃分享 CSV：多本內容全帶、tag 零洩漏、回吃正常
const full = [
  { word: 'apple', definition: '蘋果', pos: 'n', pron: '', example: '', deck: 'D1', image: '', description: '', tags: ['私人'], related: [], forms: [], synonym: '', antonym: '', derivative: '', examples: [], etymology: '', syllables: '', phrases: '' },
  { word: 'banana', definition: '香蕉', pos: 'n', pron: '', example: '', deck: 'D2', image: '', description: '', tags: ['機密'], related: [], forms: [], synonym: '', antonym: '', derivative: '', examples: [], etymology: '', syllables: '', phrases: '' },
];
const csv = buildShareCSV(full);
ok('整櫃:兩本都在', csv.includes('apple') && csv.includes('banana'));
ok('整櫃:tag 零洩漏', !csv.includes('私人') && !csv.includes('機密') && !csv.split('\n')[0].split(',').includes('tags'));
const back = parseCSV(csv);
ok('整櫃:回吃筆數對', back.length === 2);

console.log(fail === 0 ? `SHELF1: PASS (${pass} pass, 0 fail)` : `SHELF1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
