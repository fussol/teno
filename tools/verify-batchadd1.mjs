#!/usr/bin/env node
// BATCHADD1 + MERGEMOVE1（2026-09-11 使用者裁示）
// [B1] parseBatchInput：逗號/換行/中文逗號切分＋lowercase＋去重＋非法分離
// [B2] partitionBatch：已存在 vs 未存入
// [B3] 合併彈窗重設計＋保留舊的第二問（靜態接線）
// [B4] 批量新增 modal＋背景引擎（靜態接線；browser.js 無批量）
// 用法: node tools/verify-batchadd1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parseBatchInput, partitionBatch } from '../src/lib/batch-add.js';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

console.log('[B1] parseBatchInput');
let r = parseBatchInput('apply,rent, remember, pay, touch, torch');
chk('逗號空白全收 6 字', JSON.stringify(r.tokens) === JSON.stringify(['apply', 'rent', 'remember', 'pay', 'touch', 'torch']), JSON.stringify(r.tokens));
r = parseBatchInput('Apply,APPLY, apply\nrent\r\n記住，pay;touch；torch、xxx123、');
chk('大小寫歸一＋去重', JSON.stringify(r.tokens) === JSON.stringify(['apply', 'rent', 'pay', 'touch', 'torch']));
chk('中文/數字非法分離', r.invalid.includes('記住') && r.invalid.includes('xxx123'), JSON.stringify(r.invalid));
r = parseBatchInput('');
chk('空輸入空回', r.tokens.length === 0 && r.invalid.length === 0);
r = parseBatchInput("don't, well-known, a b");
chk("允許 ' - 空格", JSON.stringify(r.tokens) === JSON.stringify(["don't", 'well-known', 'a b']));

console.log('[B2] partitionBatch');
const words = [{ id: '1', word: 'Apply', deck: 'A' }, { id: '2', word: 'rent', deck: 'B' }];
let p = partitionBatch(['apply', 'rent', 'pay'], words);
chk('大小寫命中已存在', p.existing.length === 2 && p.fresh.length === 1 && p.fresh[0] === 'pay');
p = partitionBatch([], words);
chk('空 tokens 全空', p.existing.length === 0 && p.fresh.length === 0);

console.log('[B3] 合併彈窗＋第二問（靜態）');
const dk = readFileSync('src/pages/deck-browser.js', 'utf8');
chk('合併彈窗放大版（680px）', /id="deckMergeModal"[\s\S]{0,300}max-width:680px/.test(dk));
chk('保留舊的接第二問', /deckMergeKeepOld[\s\S]{0,600}showDeckMoveModal\(s, existing, targetDeck\)/.test(dk));
chk('同字本不打擾（deck 相等直接保留）', /\(existing\.deck \|\| 'Default'\) === targetDeck/.test(dk));
chk('第二問 modal 同風格（deckMoveModal＋否/是）', /id="deckMoveModal"/.test(dk) && /id="deckMoveNo"/.test(dk) && /id="deckMoveYes"/.test(dk));
chk('第二問搬字本走 editWord deck', /deckMoveYes[\s\S]{0,300}editWord\(existing\.id, \{ deck: targetDeck \}\)/.test(dk));
chk('browser.js 合併彈窗不動（字本瀏覽器專屬）', !/showDeckMoveModal/.test(readFileSync('src/pages/browser.js', 'utf8')));

console.log('[B4] 批量新增（靜態）');
chk('工具列有批量新增鈕（新增旁）', /id="deckBrowserAdd"[\s\S]{0,200}id="deckBrowserBatch"/.test(dk));
chk('按鈕綁 openBatchModal', /deckBrowserBatch'\)\?\.addEventListener\('click', \(\) => openBatchModal\(s\)\)/.test(dk));
chk('全螢幕級 modal（920px／94vw／88vh）', /id="deckBatchModal"[\s\S]{0,300}max-width:920px/.test(dk) && dk.includes('height:88vh'));
chk('筆記本 textarea＋分析鈕', /id="deckBatchInput"/.test(dk) && /id="deckBatchParse"/.test(dk));
chk('目標字本預設現在字本', /id="deckBatchDeck"/.test(dk) && /const curDeck = \(_deckName/.test(dk));
chk('已存在整批搬（editWord deck）', /deckBatchMoveAll[\s\S]{0,400}editWord\(w\.id, \{ deck: pending\.targetDeck \}\)/.test(dk));
chk('背景任務三件套', /startBackgroundTask\(taskId, `批量新增/.test(dk) && /updateBackgroundTask\(taskId/.test(dk) && /completeBackgroundTask\(taskId/.test(dk));
chk('填字來源＝組合包預設（cambridge/merriam/dict-api/llm）', /lookupCambridge\(word\)/.test(dk) && /lookupMerriam\(word, s\.state\.mwDictKey/.test(dk) && /dictionaryapi\.dev/.test(dk));
chk('韋氏 429 中止整批', /quotaHit\(e\)/.test(dk) && /超過韋氏每日免費額度/.test(dk));
chk('browser.js 無批量（字本瀏覽器專屬）', !/openBatchModal|deckBatchModal|BATCHADD1/.test(readFileSync('src/pages/browser.js', 'utf8')));
chk('batch-add.js 純函式無 DOM', !/document|window/.test(readFileSync('src/lib/batch-add.js', 'utf8')));

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /openBatchModal/.test(execSync('git show HEAD:src/pages/deck-browser.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/pages/deck-browser.js');
  try {
    const d2 = readFileSync('src/pages/deck-browser.js', 'utf8');
    const gone = !/openBatchModal/.test(d2) && !/showDeckMoveModal/.test(d2) && !/batch-add\.js/.test(d2);
    if (gone) { pass++; console.log('  NEG-OK: stash 後批量＋第二問全滅（harness 有效）'); }
    else { fail++; console.log('  NEG-FAIL'); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nBATCHADD1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
