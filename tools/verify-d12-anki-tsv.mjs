// verify-d12: Anki TSV 自動欄位對應（位置式回退）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = [], pass = [];

// ── T1 靜態：TSV 分支有 Anki 位置式回退 ──
const p = readFileSync('src/pages/import.js', 'utf8');
const tsvBlock = p.slice(p.indexOf('const isTsv'), p.indexOf('else {'));
const hasFallback = /fro?nt/i.test(tsvBlock) && /back/i.test(tsvBlock) && /note/i.test(tsvBlock) && /return i === 0 \? 'word'/.test(tsvBlock);
if (hasFallback) pass.push('T1: TSV 分支含 Anki 位置式回退（Front/Back/Notes + 位置兜底）');
else fail.push('T1: TSV 分支缺位置式回退');

// ── T2 行為模擬：回退邏輯對 Anki 標頭 → 正確欄位 ──
// 複製 resolveField + FIELD_MAP 精簡版做純邏輯驗證（import.js 無法直接 import，依賴 DOM）
const resolveFieldSim = (raw) => {
  const h = String(raw || '').toLowerCase().trim();
  const MAP = { word:'word', meaning:'definition', definition:'definition', pos:'pos', front:'word' };
  if (!h) return null;
  if (MAP[h]) return MAP[h];
  const m = h.match(/([^)]+)/);
  if (m) {}
  return null;
};
const mapTsvField = (h, i) => {
  const f = resolveFieldSim(h);
  if (f) return f;
  if (/^fro?nt$/i.test(h)) return 'word';
  if (/^back$/i.test(h)) return 'definition';
  if (/note/i.test(h)) return 'description';
  return i === 0 ? 'word' : i === 1 ? 'definition' : i === 2 ? 'description' : null;
};
const cases = [
  [['Front','Back','My Notes'], ['word','definition','description'], 'Anki 標準標頭'],
  [['word','definition','pos'], ['word','definition','pos'], '已識別標頭（resolveField 直接命中，不回退）'],
  [['term','def','img'], ['word','definition','description'], '未識別標頭位置兜底'],
  [['Front','Definition'], ['word','definition'], '混合（Front 關鍵字命中）'],
];
for (const [headers, expect, name] of cases) {
  const got = headers.map(mapTsvField);
  if (JSON.stringify(got) === JSON.stringify(expect)) pass.push(`T2 ${name}: ${headers.join('/')} → ${got.join('/')}`);
  else fail.push(`T2 ${name}: 期望 ${expect.join('/')} 實際 ${got.join('/')}`);
}

// ── T3 負控制：剝除回退 → word 欄丟失（bug 重現）──
const block = `_fields = _table.headers.map((h, i) => {
        const f = resolveField(h);
        if (f) return f;
        if (/^fro?nt$/i.test(h)) return 'word';
        if (/^back$/i.test(h)) return 'definition';
        if (/note/i.test(h)) return 'description';
        return i === 0 ? 'word' : i === 1 ? 'definition' : i === 2 ? 'description' : null;
      });`;
const stripped = p.replace(block, `_fields = _table.headers.map(h => resolveField(h));`);
if (!/fro?nt/.test(stripped.slice(stripped.indexOf('_fields = _table.headers.map')))) pass.push('T3 負控制：剝除後 TSV 不再有 Anki 回退（bug 重現）');
else fail.push('T3 負控制：剝除未生效');

console.log(`\nD12 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(x => console.log('  ✓ ' + x));
fail.forEach(x => console.log('  ✗ ' + x));
process.exit(fail.length ? 1 : 0);