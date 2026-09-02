#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G18 防回歸驗證 — tag 函式逐詞 DB round-trip → 批次事務
// 負控制: 修前 removeTagFromAll/updateTag/deleteTag 逐詞 await db.saveWord
// 修後: 收集後一次 await db.saveWordsInTx。
// 也用 FakeDatabase 實測 removeTagFromAll 功能等價（狀態 + DB words 都移除 tag）。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const storeSrc = readFileSync(new URL('../src/lib/store.js', import.meta.url), 'utf8');
const dbSrc = readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8');

console.log('── G18 tag 批次事務 ──');

// T1 db.js 有 saveWordsInTx（FIX MARKER）
ok('T1 db.js 有 saveWordsInTx 批次 API', /export async function saveWordsInTx/.test(dbSrc) && /BEGIN TRANSACTION/.test(dbSrc));

// 用「精確函式 body 切片」檢查（awk 同款）—— 避免全文 greedy regex 誤逮
function fnBody(src, name) {
  // 從函式宣告起（含 '(' 避免 indexOf 誤匹配前綴如 deleteTagConfig）
  const decl = src.indexOf(name + '(');
  if (decl < 0) return '';
  const seg = src.slice(decl);
  const m = seg.match(/[\s\S]*?\n    \},/);
  return m ? m[0] : seg.slice(0, 2500);
}
const rm8b = fnBody(storeSrc, 'async removeTagFromAll');
const udb = fnBody(storeSrc, 'async updateTag');
const dlb = fnBody(storeSrc, 'async deleteTag');

// T2b/d twoTAIL: 函式 body 含 saveWordsInTx 且不含單詞 saveWord(
ok('T2a removeTagFromAll 用 saveWordsInTx', rm8b.includes('saveWordsInTx'));
ok('T2b removeTagFromAll 無逐詞 saveWord(', !/saveWord\(/.test(rm8b));
ok('T2c updateTag 用 saveWordsInTx', udb.includes('saveWordsInTx'));
ok('T2d deleteTag 用 saveWordsInTx', dlb.includes('saveWordsInTx'));
ok('T2e deleteTag 無逐詞 saveWord(', !/saveWord\(/.test(dlb));

// T3 db.js 的其他逐詞 saveWord（非 tag 函式）保留 — 確認沒誤刪
ok('T3 單詞 saveWord 仍保留（browser/undo/edit 等用）', /export async function saveWord\(word\)/.test(dbSrc));

// T4 修前 marker：tag 函式無逐詞 saveWord（已批量化）
ok('T4 三個 tag 函式均無逐詞 saveWord(', !/saveWord\(/.test(rm8b) && !/saveWord\(/.test(udb) && !/saveWord\(/.test(dlb));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);