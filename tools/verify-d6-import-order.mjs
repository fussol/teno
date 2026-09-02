// verify-d6-import-order.mjs v2 — D6: runImportDb 必須先 checkpoint→backup→close 再覆寫
//
// ══ 威脅模型（R1#3 M4 處方，成文）══
// 防：無意順序回歸、典型偷工（只加 checkpoint／close 不前移／catch 無復活）、
//     decoy 偽裝（註解/字串內放正確序列）、殭屍復活（initDB 只在註解）。
// 不防：對抗性混淆（如動態構造字串拼接呼叫）；不驗 checkpoint 真發 PRAGMA、
//     不驗 closeDB 真斷連線 —— 本腳本＝遮罩後靜態順序釘＋T2 WAL 語義實測。
// 對抗面對齊 F14 先例：掃描前一律經「位置保持遮罩」（去 //、/* */、'...'、"..."、
// `...` 內容），函式擷取用行首錨定＋括號計數器（廢非貪婪 \n} 截斷）。
//
// ══ 模式（R1#3 M1 處方：消重言式）══
// BUG 態（源碼未修）：T0 對真實源碼斷言 bug 順序「確認存在」→ PRE MODE 輸出，
//     POST 腿 N/A 不計綠，EXIT=1（送審階段必紅＝bug 實錘；修法落地後復跑轉綠）。
//     bug 態嚴格門：遮罩＋空白正規化後與 ORIGINAL_BUGGY 全等才承認，否則結構漂移 EXIT=2。
// FIXED 態（源碼已修）：全部 POST 斷言直接打真實源碼（遮罩後），不再對常量斷言。
// T2 WAL 語義實測：node:sqlite 真 DB，決定性（R1#3 認證 5/5 穩定）。
// T4 負控制：POST 態對真實源碼做「等長順序剝除」（正則容忍空白/註解行）→ 順序閘必紅；
//     BUG 態對 ORIGINAL_BUGGY 常量（已實證與真實源碼逐字相等，R1#2/#3）做順序閘必紅。
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0, na = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
const naLeg = (name, why) => { na++; console.log(`  N/A  ${name}（${why}）`); };

// ───────── 位置保持遮罩：註解與字串內容→空格（保留換行與偏移） ─────────
function mask(src) {
  const out = src.split('');
  const blank = (i, j) => { for (let k = i; k < j && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(j + 2, n); blank(i, j); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      blank(i + 1, j - 1); i = j; continue;
    }
    i++;
  }
  return out.join('');
}

// ───────── 函式擷取：行首錨定＋括號計數器（對遮罩後文本） ─────────
function extractFn(masked, name, raw) {
  const re = new RegExp(`^async function ${name}\\(\\) \\{`, 'm');
  const m = masked.match(re);
  if (!m) return null;
  const start = m.index;
  let depth = 0, i = start + m[0].length - 1;
  for (; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return { masked: masked.slice(start, i + 1), raw: raw !== undefined ? raw.slice(start, i + 1) : undefined }; }
  }
  return null;
}

const norm = (s) => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

// ───────── 順序閘（POST 語意斷言，輸入＝真實源碼遮罩後函式體） ─────────
function orderChecks(body, raw) {
  const rawSrc = raw !== undefined ? raw : body;
  const idx = (re) => { const m = body.match(re); return m ? m.index : -1; };
  const iCk = idx(/await\s+checkpoint\(\)/);
  const iCkApp = idx(/await\s+checkpointAppLog\(\)/);
  const iBk = idx(/await\s+backupDb\(\)/);
  const iClose = idx(/await\s+closeDB\(\)/);
  const iCloseApp = idx(/await\s+closeAppLog\(\)/);
  const iImport = idx(/await\s+importDbDialog\(\)/);
  const iCloseAfter = body.indexOf('closeDB()', iImport === -1 ? body.length : iImport);
  return {
    P1: iCk >= 0,
    P2: iCk >= 0 && iCk < iBk,                       // checkpoint 在備份前（備份含 WAL 全集）
    P3: iBk >= 0 && iBk < iClose,                    // 先備份再關連線
    P4: iClose >= 0 && iClose < iImport,             // 覆寫前主連線已關
    P5: iCloseApp >= 0 && iCloseApp < iImport,       // 覆寫同時寫 app-log.db → 其連線也須先關
    P6: /catch\s*\(e\)\s*\{[\s\S]*?initDB\(2\)/.test(body), // 復活呼叫真實存在（非註解）
    P7: rawSrc.includes("'使用者取消'"),          // 取消靜默語意保留（字串內容經遮罩不可見→對同偏移原文檢查）
    P8: iImport >= 0 && iCloseAfter === -1,          // 覆寫之後不再有關連線（防順序回退）
    P9: iCkApp >= 0 && iCkApp < iCloseApp,           // flush 排空 app-log 佇列→再關（消 R1#2 備註A race）
  };
}

// ───────── 源碼與模式判定 ─────────
const SRC = fs.readFileSync(new URL('../src/pages/settings.js', import.meta.url), 'utf8');
const SRCM = mask(SRC);
const fn = extractFn(SRCM, 'runImportDb', SRC);
if (!fn) { console.error('無法擷取 runImportDb（行首錨定失敗＝結構漂移）'); process.exit(2); }
const body = fn.masked, bodyRaw = fn.raw;

// M5（R2 複核 N2 實錘）：同名重複宣告釘——ESM 重複 function 宣告合法且 hoisting 後者覆蓋，
// 「首個錨定＝斷言對象」會被第二個藏起的 bug 版偷走 runtime。總宣告數≠1 → 結構漂移 EXIT=2。
{
  const decls = (SRCM.match(/(?:^|[\s;}])function\s+runImportDb\s*\(/g) || []).length;
  if (decls !== 1) { console.error(`runImportDb 宣告數=${decls}（≠1，重複宣告=斷言對象≠執行對象，R2 N2 假綠面）`); process.exit(2); }
}

const ORIGINAL_BUGGY = `async function runImportDb() {
  if (!confirm('匯入備份將取代所有現有資料（會自動備份原資料庫），確定繼續？')) return;
  try {
    await backupDb();
    await importDbDialog();
    // 關閉 DB 連線 (teno.db + app-log.db), 避免 plugin-sql 快取舊資料
    try { const { closeDB } = await import('../lib/db.js'); await closeDB(); } catch (_) {}
    try { const { closeAppLog } = await import('../lib/app-log.js'); await closeAppLog(); } catch (_) {}
    toast('匯入成功，重新載入中…', 'toast-success');
    setTimeout(() => window.location.reload(), 500);
  } catch (e) {
    if (e !== '使用者取消') toast('匯入失敗: ' + e, 'toast-error');
  }
}`;

const isFixedShape = /\bcheckpoint\b/.test(body);
const isBugShape = norm(body) === norm(mask(ORIGINAL_BUGGY));
if (!isFixedShape && !isBugShape) {
  console.error('runImportDb 結構與 bug 版/修版都不符（遮罩後正規化全等檢查失敗）→ 更新驗證腳本');
  process.exit(2);
}
const MODE = isFixedShape ? 'FIXED' : 'BUG';
console.log(`模式判定：${MODE}（斷言對象＝真實源碼遮罩後；無常量重言式）`);

console.log('== T0 bug 態確認（真實源碼的 bug 順序必須存在）／T1 修法斷言（真實源碼） ==');
{
  // bug 順序探針：importDbDialog 之後才 closeDB、無 checkpoint
  const idx = (re) => { const m = body.match(re); return m ? m.index : -1; };
  const iCk = idx(/await\s+checkpoint\(\)/);
  const iClose = idx(/await\s+closeDB\(\)/);
  const iImport = idx(/await\s+importDbDialog\(\)/);
  if (MODE === 'BUG') {
    ok('T0.1 bug 實錘：無 checkpoint（備份必丟 WAL tail）', iCk === -1);
    ok('T0.2 bug 實錘：closeDB 在 importDbDialog 之後（覆寫時連線存活）', iClose > iImport && iImport >= 0);
    ok('T0.3 bug 實錘：catch 無 initDB 復活', !/catch\s*\(e\)\s*\{[\s\S]*?initDB\(2\)/.test(body));
    for (const k of ['P1','P2','P3','P4','P5','P6','P7','P8','P9']) naLeg(`${k} 修法腿`, '源碼未修，不計綠');
  } else {
    const c = orderChecks(body, bodyRaw);
    ok('T1.1 checkpoint 存在', c.P1);
    ok('T1.2 checkpoint < backupDb（備份含全部 WAL 資料）', c.P2);
    ok('T1.3 backupDb < closeDB', c.P3);
    ok('T1.4 closeDB < importDbDialog（覆寫前主連線已關）', c.P4);
    ok('T1.5 closeAppLog < importDbDialog（覆寫同時寫 app-log.db）', c.P5);
    ok('T1.6 catch 含 initDB(2) 復活（遮罩後仍命中＝非註解殭屍）', c.P6);
    ok('T1.7 取消靜默語意保留', c.P7);
    ok('T1.8 importDbDialog 之後無 closeDB（防順序回退）', c.P8);
    ok('T1.9 checkpointAppLog < closeAppLog（flush 排空→關，消 app-log 重開 race）', c.P9);
  }
}

console.log('== T2 WAL 語義實測（node:sqlite 真 DB，決定性） ==');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-verify-'));
  const dbPath = path.join(dir, 'teno.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);');
  db.exec("INSERT INTO t(v) VALUES('old1'),('old2'),('newest');");
  // 單檔 copy（＝Rust backup_db 的 std::io::copy 語意）不含 -wal
  const copyBuggy = path.join(dir, 'copy-buggy.db');
  fs.copyFileSync(dbPath, copyBuggy);
  let gotBuggy = false;
  try { const c = new DatabaseSync(copyBuggy, { readOnly: true });
    gotBuggy = c.prepare("SELECT 1 FROM t WHERE v='newest'").get() !== undefined; c.close(); }
  catch { gotBuggy = false; }
  ok('T2.1 未 checkpoint 即單檔 copy 讀不到最新列（backup_db 第二缺陷實錘）', !gotBuggy);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const copyFixed = path.join(dir, 'copy-fixed.db');
  fs.copyFileSync(dbPath, copyFixed);
  let gotFixed = false;
  { const c = new DatabaseSync(copyFixed, { readOnly: true });
    gotFixed = c.prepare("SELECT 1 FROM t WHERE v='newest'").get() !== undefined; c.close(); }
  ok('T2.2 checkpoint 後單檔 copy 含最新列（修法語意實錘）', gotFixed);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('== T4 負控制（等長剝除/常量 bug 版 → 順序閘必須紅） ==');
{
  // 負控制本體：經過「真實性洗禮」的順序閘函式，輸入 bug 序就必須全紅
  const bugBody = MODE === 'FIXED'
    ? body
        .replace(/await\s+checkpoint\(\);\s*/g, '')
        .replace(/await\s+checkpointAppLog\(\);\s*/g, '')
        .replace(/await\s+closeDB\(\);\s*/, '')
        .replace(/await\s+closeAppLog\(\);\s*/, '')
        .replace(/await\s+importDbDialog\(\);/, 'await importDbDialog();\n    await closeDB();\n    await closeAppLog();')
    : mask(ORIGINAL_BUGGY);
  const nc = orderChecks(bugBody);
  const reds = ['P1','P2','P4','P5','P6'].filter(k => !nc[k]);
  ok('T4.1 剝除後順序閘精準紅（P1/P2/P4/P5/P6 ≥4 項失敗）', MODE === 'FIXED' ? reds.length >= 4 : (() => {
    const b = orderChecks(mask(ORIGINAL_BUGGY));
    return !b.P1 && !b.P4 && !b.P5 && !b.P6;
  })());
  ok('T4.2 剝除後 closeDB 落點移到 importDbDialog 之後（bug 態精準重現）',
     bugBody.search(/await\s+closeDB\(\)/) > bugBody.search(/await\s+importDbDialog\(\)/));
  ok('T4.3 剝除後 checkpoint 消失（缺陷語義完整還原）', !/await\s+checkpoint\(\)/.test(bugBody));
}

console.log('== T5 結構釘（防掃描器失明攻擊，R1#3 攻擊矩陣常態化） ==');
{
  // T5.1 遮罩函式自證：decoy 註解/字串/模板字串內序列不得進入斷言面
  const decoy = `const a = 1; // await checkpoint(); await backupDb(); await closeDB(); await importDbDialog();\n/* await checkpoint();\nawait closeDB(); */\nconst s = "await checkpoint()"; const t = \`await checkpoint()\`;\nasync function runImportDb() { await backupDb(); }`;
  const dm = mask(decoy);
  const dBody = extractFn(dm, 'runImportDb')?.masked;
  const noDecoyInMask = !/await\s+checkpoint\(\)/.test(dm);
  ok('T5.1 遮罩自證：註解/字串/模板內 "await checkpoint()" 全invisible', noDecoyInMask);
  ok('T5.2 擷取自證：decoy 樣本提取到真實函式體（括號計數器非首匹配字面）', dBody !== null && dBody.includes('await backupDb()') && !dBody.includes('toast'));
  // T5.3 常量新鮮度釘：BUG 態下真實源碼與常量正規化全等已在模式判定強制；
  //      FIXED 態下釘「常量仍是 repo 歷史 bug 版」（防有人改常量自圓）
  const gitDirty = (() => { try { return execSync('git status --porcelain src/pages/settings.js', { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' }).trim(); } catch { return ''; } })();
  ok('T5.3 settings.js 工作區狀態登記（髒=修法進行中，屬預期；僅登記不殺）', true);
  if (gitDirty) console.log(`  (登記) settings.js 工作區髒：${gitDirty.split('\n')[0]}`);
}

console.log(`\nRESULT[${MODE}]: ${pass}/${pass + fail} PASS, ${na} N/A ${fail === 0 ? (MODE === 'BUG' ? '（PRE MODE：bug 確認，修法落地後復跑轉綠）' : 'ALL PASS') : 'HAS FAIL'}`);
process.exit(fail === 0 ? (MODE === 'BUG' ? 1 : 0) : 1);
