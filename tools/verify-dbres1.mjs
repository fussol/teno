#!/usr/bin/env node
// DB-RES1：寫入韌性 —— 517(BUSY_SNAPSHOT) / 交易不綁連線 / 裸寫入 / 失敗靜默
//
// 根因：plugin-sql 的 execute 走 sqlx Pool（max_connections=10），
//   多次 execute 組出的 BEGIN…COMMIT 不保證同一條連線 → 併發時交易懸置、握死寫鎖。
//   實測後果：264 筆寫入失敗（含 29 筆複習、18 筆連勝），最長鎖死 2 小時 11 分。
//
//   [S] 源碼：交易改 IMMEDIATE、內層改 raw、寫入全數納入 _write
//   [B] 行為：重試策略（517 可重試成功、非 busy 立即丟、耗盡才丟）
//   [NEG] 負控制：舊預算（450ms）撐不過的場景，新預算撐得過
import { readFileSync } from 'node:fs';
const db = await import('../src/lib/db.js');

let pass = 0, fail = 0;
const chk = (name, ok, extra = '') => {
  if (ok) pass++;
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};
const src = readFileSync('src/lib/db.js', 'utf8');
const codeOnly = src.split('\n').filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); }).join('\n');

// ── [B] 重試策略 ──
console.log('[B] 重試策略');
const { retryBusy, isBusy, busyTries } = db.__test;
chk('_isBusy 認得 517', isBusy(new Error('error returned from database: (code: 517) database is locked')));
chk('_isBusy 認得 locked', isBusy(new Error('database is locked')));
chk('_isBusy 不誤判一般錯誤', !isBusy(new Error('no such table: words')));

{
  // 前 10 次丟 517，第 11 次成功 → 新預算（14）應撐過
  let n = 0;
  const flaky = async () => { if (++n <= 10) throw new Error('database is locked (code: 517)'); return 'ok'; };
  const r = await retryBusy(flaky);
  chk('517 連續 10 次後成功（新預算撐得過）', r === 'ok' && n === 11, `n=${n}`);
}
{
  // 一直失敗 → 耗盡後必須 throw（不能靜默回 undefined）
  let n = 0;
  const always = async () => { n++; throw new Error('database is locked (code: 517)'); };
  let threw = false;
  try { await retryBusy(always); } catch (_) { threw = true; }
  chk('持續失敗 → 耗盡後 throw', threw && n === busyTries, `n=${n} tries=${busyTries}`);
}
{
  // 非 busy 錯誤 → 立即丟，不浪費重試
  let n = 0;
  const hard = async () => { n++; throw new Error('no such table: words'); };
  let msg = '';
  try { await retryBusy(hard); } catch (e) { msg = e.message; }
  chk('非 busy 錯誤立即丟（不重試）', n === 1 && /no such table/.test(msg), `n=${n}`);
}
{
  // 520 = SQLITE_BUSY 家族也要認（error_readonly 不算）
  chk('認得 code: 5（SQLITE_BUSY）', isBusy(new Error('database is locked (code: 5)')));
}

// ── [S] 源碼：交易與佇列 ──
console.log('[S] 源碼：交易與佇列');
chk('無 BEGIN TRANSACTION（全改 IMMEDIATE）', !codeOnly.includes('BEGIN TRANSACTION'), `count=${(codeOnly.match(/BEGIN TRANSACTION/g) || []).length}`);
// DB-RES1: 跨整個 src/ —— 別處也不得自己組交易（實測 store.js importWords 曾是鎖死主因）
{
  const { execSync } = await import('node:child_process');
  let hits = '';
  try { hits = execSync("grep -rn \"BEGIN TRANSACTION\" src/ --include=*.js", { encoding: 'utf8' }); } catch (_) {}
  chk('全 src/ 無 BEGIN TRANSACTION（含 store.js importWords）', hits.trim() === '', hits.trim().slice(0, 120));
}
chk('BEGIN IMMEDIATE 至少 8 處', (codeOnly.match(/BEGIN IMMEDIATE/g) || []).length >= 8,
  `count=${(codeOnly.match(/BEGIN IMMEDIATE/g) || []).length}`);
chk('_retryBusy 用指數退避（2 ** i）', /2 \*\* i/.test(codeOnly));
chk('_retryBusy 有抖動（Math.random）', /Math\.random\(\)/.test(codeOnly));
chk('_write 對失敗留痕（console.error）', /console\.error\('\[db\] 寫入失敗/.test(codeOnly));
chk('失敗次數顯性化 window.__dbWriteFailStreak', /__dbWriteFailStreak/.test(codeOnly));

// raw 版存在且不含 _write（否則交易內會自我死鎖）
/** 取某個函式的完整本體：從宣告行到同縮排的收尾 `\n}` */
const fnBody = (marker, src2 = codeOnly) => {
  const i = src2.indexOf(marker);
  if (i < 0) return '';
  const end = src2.indexOf('\n}', i);
  return end < 0 ? src2.slice(i) : src2.slice(i, end + 2);
};
for (const fn of ['_saveWordRaw', '_saveCardRaw']) {
  const body = fnBody(`async function ${fn}(`);
  chk(`${fn} 存在`, body.length > 0);
  chk(`${fn} 不含 _write（避免死鎖）`, body.length > 0 && !body.includes('_write('));
}
// 交易函式不得呼叫走佇列的 saveWord/saveCard
const TX_FNS = ['saveWordsInTx', 'bulkSaveWords', 'bulkSaveCards'];
for (const fn of TX_FNS) {
  const i = codeOnly.indexOf(`export async function ${fn}(`);
  const body = i >= 0 ? codeOnly.slice(i, codeOnly.indexOf('\n}', i) + 2) : '';
  const bad = /[^\w_](saveWord|saveCard)\(/.test(body.replace(/_save\w+Raw/g, ''));
  chk(`${fn} 內層不用走佇列的 saveWord/saveCard`, i >= 0 && !bad);
  chk(`${fn} 納入 _write`, /return _write\(/.test(body));
  chk(`${fn} 用 BEGIN IMMEDIATE`, /BEGIN IMMEDIATE/.test(body));
}
// 裸寫入掃描：逐「匯出的函式」檢查 —— 本體內若有寫入 execute，就必須有 _write（佇列）。
// （不用縮排判斷：deleteWord 等既有函式的內縮排版不一致，縮排啟發式會誤判。）
{
  /** 粗略切出 export async function 的本體（跳過字串內的括號） */
  const fnBodies = (s) => {
    const out = {};
    const re = /export async function (\w+)\(/g;
    let m;
    while ((m = re.exec(s))) {
      const i = s.indexOf('{', m.index);
      if (i < 0) continue;
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === "'" || c === '"' || c === '`') {
          const q = c;
          j++;
          while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      out[m[1]] = s.slice(m.index, j + 1);
    }
    return out;
  };
  const bodies = fnBodies(codeOnly);
  const bare = [];
  for (const [name, body] of Object.entries(bodies)) {
    const hasWrite = /\.execute\('(INSERT|DELETE|UPDATE)/.test(body);
    // _saveWordRaw/_saveCardRaw 為非匯出（不在 bodies 內）；匯出者若有寫入就必須走 _write
    if (hasWrite && !body.includes('_write(')) bare.push(name);
  }
  chk('匯出的寫入函式全部走 _write', bare.length === 0, bare.length ? `未包: ${bare.join(', ')}` : '');
  chk('掃描確有覆蓋到寫入函式（防呆）', Object.values(bodies).filter(b => /\.execute\('(INSERT|DELETE|UPDATE)/.test(b)).length >= 10,
    `覆蓋 ${Object.values(bodies).filter(b => /\.execute\('(INSERT|DELETE|UPDATE)/.test(b)).length} 個`);
}

// ── [NEG] 負控制：證明舊預算不足 ──
console.log('[NEG] 負控制');
{
  // 模擬舊策略：6 次、30ms 線性
  const oldRetry = async (fn, tries = 6) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (!isBusy(e) || i === tries - 1) throw e;
        await new Promise(r => setTimeout(r, 1));   // 縮時：只驗「次數」不足
      }
    }
    throw last;
  };
  let oldN = 0, newN = 0;
  const mk = () => { let n = 0; return async () => { if (++n <= 10) throw new Error('code: 517 database is locked'); return 'ok'; }; };
  let oldOk = true;
  try { await oldRetry(mk()); } catch (_) { oldOk = false; }
  const newOk = (await retryBusy(mk())) === 'ok';
  chk('舊預算（6 次）在 10 次失敗情境下必然失敗（＝bug 成立）', oldOk === false);
  chk('新預算（14 次）同情境下成功', newOk === true);
}

console.log(`\nDB-RES1: ${fail ? 'FAIL' : 'PASS'} (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
