#!/usr/bin/env node
// IMG-HOTFIX2 驗證：normalizeImageUrl 純函式＋快照零殘留 uc/usercontent
// 用法: node tools/verify-image-url.mjs（快照需先重倒：python3 tools/export-web-snapshot.py）
import { readFileSync, existsSync } from 'node:fs';
import { normalizeImageUrl } from '../src/lib/image-url.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`PASS ${n}`); }
  else { fail++; console.log(`FAIL ${n} ${e}`); }
};

const ID = '1sz_sqJe9Lvcp80uk5lpZG0YHxaregpjF';
const LH3 = `https://lh3.googleusercontent.com/d/${ID}=w800`;
ok('U1 uc?id', normalizeImageUrl(`https://drive.google.com/uc?id=${ID}`) === LH3);
ok('U2 uc+export', normalizeImageUrl(`https://drive.google.com/uc?export=download&id=${ID}`) === LH3);
ok('U3 open?id', normalizeImageUrl(`https://drive.google.com/open?id=${ID}`) === LH3);
ok('U4 file/d', normalizeImageUrl(`https://drive.google.com/file/d/${ID}/view?usp=sharing`) === LH3);
ok('U5 usercontent', normalizeImageUrl(`https://drive.usercontent.google.com/download?id=${ID}&export=download`) === LH3);
ok('U6 lh3 冪等', normalizeImageUrl(LH3) === LH3);
ok('U7 data: 放行', normalizeImageUrl('data:image/jpeg;base64,AAA') === 'data:image/jpeg;base64,AAA');
ok('U8 非 google 放行', normalizeImageUrl('https://example.com/a.jpg') === 'https://example.com/a.jpg');
ok('U9 空字串', normalizeImageUrl('') === '');
ok('U10 垃圾 id 不誤殺', normalizeImageUrl('https://drive.google.com/uc?id=1') === 'https://drive.google.com/uc?id=1');

const snap = JSON.parse(readFileSync('/home/jupiter/teno 修檢版/public/real-data.json', 'utf8'));
const datas = Object.values(snap.images || {}).flat().map((x) => x.data);
ok('U11 快照有圖', datas.length === 478, `got=${datas.length}`);
ok('U12 零 uc 殘留', !datas.some((u) => u.includes('drive.google.com/uc')));
ok('U13 零 usercontent 殘留', !datas.some((u) => u.includes('drive.usercontent')));
const locals = datas.filter((u) => u.startsWith('img/'));
const remotes = datas.filter((u) => u.startsWith('https://lh3.googleusercontent.com/d/'));
ok('U14 全本地或 lh3（無裸 uc）', locals.length + remotes.length === datas.length, `local=${locals.length} remote=${remotes.length}`);
// 下載腳本跑完後應全本地；若還有殘留遠端（下載失敗保留），列出來不判死
if (remotes.length) console.log(`INFO 殘留遠端 ${remotes.length}（下載失敗保留，可重跑腳本補）`);
const missing = locals.filter((u) => !existsSync('/home/jupiter/teno 修檢版/public/' + u));
ok('U15 本地檔全存在', missing.length === 0, missing.slice(0, 5).join(','));

console.log(fail === 0 ? '═══ ALL PASS ═══' : `═══ ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
