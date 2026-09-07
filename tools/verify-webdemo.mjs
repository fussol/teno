#!/usr/bin/env node
// WEB-DEMO 驗證（2026-09-08 使用者裁示：網頁版內建示範資料）
// 種子資料形狀＋db.js guard 引用的 Demo 名全存在。跑法：node tools/verify-webdemo.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const Demo = await import(join(root, 'src/lib/demo-data.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

await Demo.seed();
const words = await Demo.getAllWords();
ok('W1 36 詞', words.length === 36, `got=${words.length}`);
ok('W2 欄位齊', words.every((w) => w.id && w.word && w.definition && w.pos && w.deck && Array.isArray(w.tags) && Array.isArray(w.related) && Array.isArray(w.forms) && Array.isArray(w.examples) && typeof w.createdAt === 'string'));
ok('W3 三字本', new Set(words.map((w) => w.deck)).size === 3);
ok('W4 韋氏欄有人填', words.some((w) => w.etymology || w.syllables || w.phrases));
const decks = await Demo.getAllDecks();
ok('W5 3 decks', decks.length === 3, `got=${decks.length}`);
const cards = await Demo.getAllCards();
ok('W6 cards 36', cards.size === 36, `got=${cards.size}`);
ok('W7 有到期卡', [...cards.values()].some((c) => new Date(c.due) <= new Date()));
ok('W8 有新卡 state=0', [...cards.values()].some((c) => c.state === 0));
const logs = await Demo.getAllReviewLogs();
ok('W9 revlog 有料', logs.length >= 20, `got=${logs.length}`);
ok('W10 revlog 形狀', logs.every((r) => r.wordId && r.reviewed_at && r.mode));
const cnt = await Demo.getNewRatedTodayAll('2000-01-01', 0);
ok('W11 新卡計數形狀', cnt && typeof cnt.flip === 'number' && typeof cnt.mc === 'number');
const ex = await Demo.getAllExamHistory();
ok('W12 exam 有料', ex.length === 10, `got=${ex.length}`);
const gs = await Demo.getGoalStreak();
ok('W13 streak 形狀', gs.dailyGoal === 20 && Array.isArray(gs.dates.flip));
ok('W14 寫入往返', (await Demo.saveWord({ word: 'demo-test', definition: 'x', pos: 'noun', deck: '日常' }), (await Demo.getWordCount()) === 37));
await Demo.deleteWord((await Demo.getAllWords()).find((w) => w.word === 'demo-test').id);
ok('W15 刪除往返', (await Demo.getWordCount()) === 36);

// db.js guard 引用的 Demo 名必須全存在
const dbSrc = readFileSync(join(root, 'src/lib/db.js'), 'utf8');
const refs = [...new Set([...dbSrc.matchAll(/Demo\.(\w+)/g)].map((m) => m[1]))];
const missing = refs.filter((n) => typeof Demo[n] !== 'function');
ok('W16 guard 引用全存在', missing.length === 0, `missing=${missing.join(',')} refs=${refs.length}`);

console.log(fail === 0 ? '═══ ALL PASS ═══' : `═══ ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
