// verify-g-xss-rest.mjs — G-XSS4/5/6: browser chip, dashboard deck, tools issues.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const marks = JSON.parse(process.argv[2] || '{"b":true,"d":true,"t":true}');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
if (marks.b) {
  const s = readFileSync(join(root, 'src/pages/browser.js'), 'utf8');
  ok('browser chip escaped', !/^\s+\$\{d\.name\}$/m.test(s), 'deck filter label line');
}
if (marks.d) {
  const s = readFileSync(join(root, 'src/pages/dashboard.js'), 'utf8');
  ok('dashboard deck escaped', !/\$\{d\.name\}/.test(s), 'zero naked d.name');
}
if (marks.t) {
  const lines = readFileSync(join(root, 'src/pages/tools.js'), 'utf8').split('\n');
  const bad = [465, 471, 476].filter(n => {
    const l = lines[n - 1] || '';
    return /\$\{(lower|w\.word)\}/.test(l) && !/esc\(/.test(l);
  });
  ok('tools issues escaped', bad.length === 0, bad.length ? 'lines ' + bad.join(',') : '465/471/476');
}
process.exit(fail ? 1 : 0);
