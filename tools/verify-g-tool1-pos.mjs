// verify-g-tool1-pos.mjs — G-TOOL1: 工具頁詞性正規化與匯入頁同語意
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePos } from '../src/core/import.js';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const t = readFileSync(join(root, 'src/pages/tools.js'), 'utf8').replace(/\/\/.*$/gm, '');
ok('tools 接 core normalizePos', /import\s*\{[^}]*normalizePos[^}]*\}\s*from\s*['"]\.\.\/core\/import\.js['"]/.test(t), '單一真相');
ok('本地 _posCN 表已刪', !t.includes('_posCN'), '無分叉表');
ok('_normalizePos 委派 core', /const _normalizePos\s*=\s*\(pos\)\s*=>\s*normalizePos\(pos\)/.test(t), '寫入路徑');
ok('adj. 轉形容詞', normalizePos('adj.') === '形容詞', normalizePos('adj.'));
ok('複合去尾點＋去重', normalizePos('noun, adj., noun.') === '名詞, 形容詞', normalizePos('noun, adj., noun.'));
ok('LLM 回文直轉', normalizePos('adjective, adverb') === '形容詞, 副詞', 'prompt 點形偶發亦滅');
process.exit(fail ? 1 : 0);
