#!/usr/bin/env node
// ═ 題庫維護口（給 AI／終端用；人不用碰題目） ═
//   node tools/bank.mjs validate            全庫校驗：id 唯一、欄位齊、pattern 有標題
//   node tools/bank.mjs add < q.json        新增一題（不帶 id 自動編號；q.json 可用 - 走 stdin）
//   node tools/bank.mjs del <id>            刪除一題
//   node tools/bank.mjs list [pattern]      列出題目（預設只印 id/型別/題幹摘要）
// 改完跑 npm run build 讀入新題；新增 pattern 需先在 pattern_titles.json 加鍵。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QS = path.join(ROOT, 'public/packs/grammar/questions.jsonl');
const TITLES = path.join(ROOT, 'public/packs/grammar/pattern_titles.json');

const loadAll = () => fs.readFileSync(QS, 'utf8').trimEnd().split('\n').map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`第 ${i + 1} 行 JSON 壞了: ${e.message}`); }
});
const titles = () => JSON.parse(fs.readFileSync(TITLES, 'utf8'));
const writeAll = qs => fs.writeFileSync(QS, qs.map(q => JSON.stringify(q)).join('\n') + '\n');

function validate(q, ids, ts) {
  if (!q.id || !/^g-.+-(mc|tr)-\d+$/.test(q.id)) return `id 非法: ${q.id}`;
  if (ids.has(q.id)) return `id 重複: ${q.id}`;
  if (!q.pattern || !ts[q.pattern]) return `pattern 不在 pattern_titles.json: ${q.pattern}（先加標題鍵）`;
  if (q.type === 'mc') {
    if (!q.stem || !q.explain) return `${q.id}: 缺 stem/explain`;
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => !o)) return `${q.id}: options 需 4 個非空`;
    if (!(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4)) return `${q.id}: answer 需 0-3`;
  } else if (q.type === 'translate') {
    if (!q.translation || !q.reference) return `${q.id}: 缺 translation/reference`;
  } else return `${q.id}: type 需 mc|translate`;
  return null;
}

const [cmd, ...args] = process.argv.slice(2);
const fail = m => { console.error(`FAIL ${m}`); process.exit(1); };

if (cmd === 'validate') {
  const qs = loadAll(), ts = titles(), ids = new Set();
  for (const q of qs) { const e = validate(q, ids, ts); if (e) fail(e); ids.add(q.id); }
  console.log(`OK ${qs.length} 題全數通過`);
} else if (cmd === 'add') {
  let raw;
  if (args[0] === '-') raw = fs.readFileSync(0, 'utf8');
  else if (args[0]) raw = fs.readFileSync(args[0], 'utf8');
  else fail('用法: add <q.json> 或 add - (stdin)');
  let q; try { q = JSON.parse(raw); } catch (e) { fail(`輸入不是合法 JSON: ${e.message}`); }
  if (Array.isArray(q)) fail('一次只加一題');
  const qs = loadAll(), ts = titles(), ids = new Set(qs.map(x => x.id));
  if (q.id && ids.has(q.id)) fail(`id 已存在: ${q.id}`);
  if (!q.id) {
    const kind = q.type === 'translate' ? 'tr' : 'mc';
    if (q.type !== 'mc' && q.type !== 'translate') fail('type 需 mc|translate');
    let n = 0;
    for (const x of qs) { const m = x.id.match(new RegExp(`^g-${q.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${kind}-(\\d+)$`)); if (m) n = Math.max(n, +m[1]); }
    q.id = `g-${q.pattern}-${kind}-${n + 1}`;
  }
  const e = validate(q, ids, ts); if (e) fail(e);
  qs.push(q);
  writeAll(qs);
  console.log(`OK 已加入 ${q.id}（共 ${qs.length} 題；npm run build 後生效）`);
} else if (cmd === 'del') {
  const id = args[0]; if (!id) fail('用法: del <id>');
  const qs = loadAll(), i = qs.findIndex(q => q.id === id);
  if (i < 0) fail(`找不到 ${id}`);
  qs.splice(i, 1);
  writeAll(qs);
  console.log(`OK 已刪除 ${id}（共 ${qs.length} 題；npm run build 後生效）`);
} else if (cmd === 'list') {
  const qs = loadAll().filter(q => !args[0] || q.pattern === args[0]);
  for (const q of qs) {
    const text = (q.type === 'mc' ? q.stem : q.translation) || '';
    console.log(`${q.id}\t${q.type}\t${text.slice(0, 40)}`);
  }
  console.log(`共 ${qs.length} 題`);
} else {
  fail('用法: bank.mjs validate | add <q.json|-> | del <id> | list [pattern]');
}
