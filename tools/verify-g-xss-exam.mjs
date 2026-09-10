// verify-g-xss-exam.mjs — G-XSS1/2/3: exam config deck chips + tag options escaped.
// FIX MARKERs (progressive: X1 flip -> X2 mc -> X3 spell).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const marks = JSON.parse(process.argv[2] || '{"flip":true,"mc":true,"spell":true}');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const check = (file, tag) => {
  const src = readFileSync(join(root, 'src/pages', file), 'utf8');
  ok(`${tag} deck chip escaped`, src.includes('${esc(d.name)}'), file);
  const nakedOpt = (src.match(/\$\{t\.name\}/g) || []).length;
  ok(`${tag} no naked t.name`, nakedOpt === 0, `${nakedOpt} naked`);
};
if (marks.flip) check('exam-flip.js', 'flip');
if (marks.mc) check('exam-mc.js', 'mc');
if (marks.spell) check('exam-spell.js', 'spell');
process.exit(fail ? 1 : 0);
