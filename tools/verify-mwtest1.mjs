#!/usr/bin/env node
// MWTEST1: 設定頁韋氏連線測試鈕（零網路靜態接線檢查＋merriamToFields 判定語意實測）
// 用法: node tools/verify-mwtest1.mjs
import { readFileSync } from 'node:fs';
import { merriamToFields } from '../src/lib/merriam.js';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };

const settings = readFileSync('src/pages/settings.js', 'utf8');

console.log('[T1] 按鈕＋結果區接線');
chk('測試鈕 HTML 存在', /id="mwKeysTestBtn"/.test(settings));
chk('結果區 div 存在', /id="mwKeysTestResult"/.test(settings));
chk('handler 綁定存在', /getElementById\('mwKeysTestBtn'\)\?\.addEventListener\('click'/.test(settings));
chk('用輸入框當下值（免存檔先測）', /document\.getElementById\('mwDictKeyInput'\)\?\.value/.test(settings));
chk('打 gross 這個字', /lookupMerriam\('gross', dk, tk\)/.test(settings));
chk('空 key 擋下', /請先填入至少一把 Key/.test(settings));
chk('按鈕測試中 disabled', /btn\.disabled = true/.test(settings) && /btn\.disabled = false/.test(settings));

console.log('[T2] 三燈語意');
chk('綠燈＝有 entries', /連線正常/.test(settings));
chk('黃燈＝suggest', /Key 有效，但 gross 查無字/.test(settings));
chk('紅燈＝401/Invalid Key', /401\|Invalid API key\|Not subscribed/.test(settings));
chk('紅燈＝逾時', /timed out/.test(settings) && /請求逾時/.test(settings));

console.log('[T3] 判定函式實測（與 handler 同邏輯）');
const hasEntry = (f) => !!(f.pos || f.definition || f.pron || f.example || f.forms || f.synonym || f.etymology || f.syllables);
// 綠：fixture gross 有 entries（沿用 eternal/gross 夾具形狀：dictionary 陣列＋thesaurus）
const green = merriamToFields({ word: 'gross', dictionary: [{ meta: { id: 'gross:1' }, fl: 'adjective', shortdef: ['very large'], hwi: { hw: 'gross', prs: [{ mw: 'ˈgrōs' }] } }], thesaurus: [] }, 'gross');
chk('有 entries → 綠', hasEntry(green), JSON.stringify({ pos: green.pos }));
// 黃：suggest 形狀
const yellow = merriamToFields({ word: 'gross', dictionary: ['gross', 'grouse'], thesaurus: [] }, 'gross');
chk('suggest → 黃（無 entry 但有 suggest）', !hasEntry(yellow) && yellow.suggest.length > 0, JSON.stringify(yellow.suggest));
// 紅：401 是 Rust 端 throw，handler catch 走紅燈（此處只驗正則命中錯誤字串）
chk('401 字串命中紅燈正則', /401|Invalid API key|Not subscribed/i.test('HTTP error: 401 Unauthorized'));

console.log(`\nMWTEST1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
