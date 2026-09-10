// verify-d-pos1-int.mjs — D-POS1: bare int. must not force 感嘆詞.
import { normalizePos } from '../src/core/import.js';
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
ok('int. stays raw', normalizePos('int.') === 'int.', normalizePos('int.'));
ok('interj still 感嘆詞', normalizePos('interj.') === '感嘆詞', normalizePos('interj.'));
ok('interjection still 感嘆詞', normalizePos('interjection') === '感嘆詞', normalizePos('interjection'));
ok('adj. still 形容詞', normalizePos('adj.') === '形容詞', normalizePos('adj.'));
ok('vi still 動詞', normalizePos('vi') === '動詞', normalizePos('vi'));
process.exit(fail ? 1 : 0);
