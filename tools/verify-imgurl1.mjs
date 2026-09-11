#!/usr/bin/env node
// IMGURL1: 編輯器貼圖片連結（直連收 / Tenor分享頁轉og:image / 去重）
// 用法: node tools/verify-imgurl1.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  isHttpUrl, isDirectImageUrl, extractOgImage,
  resolvePageImageUrl, filenameForUrl, mergeImageUrls,
  normalizeImageUrl,
} from '../src/lib/image-url.js';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

console.log('[U1] 直連判定');
chk('gif直連', isDirectImageUrl('https://example.com/a.gif'));
chk('jpg帶query直連', isDirectImageUrl('https://example.com/a.JPG?w=800'));
chk('media.tenor直連', isDirectImageUrl('https://media1.tenor.com/m/ABC123/cat.gif'));
chk('tenor分享頁非直連（即使尾.gif）', !isDirectImageUrl('https://tenor.com/ixPDfBn9wTq.gif'));
chk('tenor view頁非直連', !isDirectImageUrl('https://tenor.com/view/jgmm-cat-meme-gif-7034802297606826390'));
chk('giphy詳情頁非直連', !isDirectImageUrl('https://giphy.com/gifs/cat-abc123'));
chk('media.giphy直連', isDirectImageUrl('https://media2.giphy.com/media/abc123/giphy.gif'));
chk('i.imgur直連', isDirectImageUrl('https://i.imgur.com/xyz.png'));
chk('imgur相簿頁非直連', !isDirectImageUrl('https://imgur.com/gallery/xyz'));
chk('data:視為直連', isDirectImageUrl('data:image/png;base64,AAA'));
chk('純文字非直連', !isDirectImageUrl('hello'));
chk('http非localhost拒', !isHttpUrl('http://example.com/a.gif'));
chk('https收', isHttpUrl('https://example.com/a.gif'));

console.log('[U2] og:image 解析（真實 Tenor HTML）');
let tenorHtml = '';
if (existsSync('/tmp/tenor-test.bin')) tenorHtml = readFileSync('/tmp/tenor-test.bin', 'utf8');
else tenorHtml = '<meta property="og:image" content="https://media1.tenor.com/m/ABC/test.gif">';
const og = extractOgImage(tenorHtml);
chk('抓到media.tenor gif', /^https:\/\/media\d?\.tenor\.com\/.+\.gif$/.test(og));
chk('無meta回空', extractOgImage('<html><body>hi</body></html>') === '');
chk('content在前也抓到', extractOgImage('<meta content="https://x.com/a.png" property="og:image">') === 'https://x.com/a.png');

console.log('[U3] resolvePageImageUrl（stub fetch）');
const stubFetch = async (u) => {
  if (u.includes('tenor.com')) return tenorHtml;
  throw new Error('nope');
};
let r = await resolvePageImageUrl('https://example.com/a.gif', stubFetch);
chk('直連原樣回', r.direct === 'https://example.com/a.gif' && r.resolved === false);
r = await resolvePageImageUrl('https://tenor.com/ixPDfBn9wTq.gif', stubFetch);
chk('分享頁解出直連+resolved', r.direct === og && r.resolved === true);
r = await resolvePageImageUrl('https://example.com/page.html', stubFetch);
chk('未知頁面型拒收not-image', r.error === 'not-image');
r = await resolvePageImageUrl('not a url', stubFetch);
chk('非法字串拒收', !!r.error);
r = await resolvePageImageUrl('https://tenor.com/xyz', async () => { throw new Error('net'); });
chk('抓頁失敗fetch-failed', r.error === 'fetch-failed');
r = await resolvePageImageUrl('https://tenor.com/xyz', async () => '<html></html>');
chk('無og回no-og-image', r.error === 'no-og-image');

console.log('[U4] mergeImageUrls（去重＋略過非法）');
const m1 = mergeImageUrls([{ filename: 'a.gif', data: 'https://x.com/a.gif' }], 'https://x.com/a.gif https://x.com/b.png bad-text');
chk('重複+非法略過、只加1', m1.added === 1 && m1.skipped === 2 && m1.list.length === 2);
chk('檔名取尾段', m1.list[1].filename === 'b.png');
const m2 = mergeImageUrls([], 'https://x.com/a.gif,https://x.com/b.gif\nhttps://x.com/c.gif');
chk('逗號換行多個全收', m2.added === 3);
chk('filenameForUrl無尾段用host', filenameForUrl('https://x.com/') === 'x.com');

console.log('[U5] 呼叫端接線（靜態）');
const wi = readFileSync('src/lib/word-image.js', 'utf8');
const br = readFileSync('src/pages/browser.js', 'utf8');
const dk = readFileSync('src/pages/deck-browser.js', 'utf8');
chk('thumbsApi.addUrls存在', /addUrls: \(text\)/.test(wi));
chk('addImageUrlFlow存在', /export async function addImageUrlFlow/.test(wi));
chk('browser有URL輸入列', /id="fImageUrl"/.test(br));
chk('browser綁加入鈕+Enter', /fImageUrlAdd.*addEventListener\('click'/.test(br) && /fImageUrl.*keydown/.test(br));
chk('browser走fetchGet繞CSP', /fetchGet\(u\)/.test(br));
chk('deck新增+編輯兩列', /id="deckAddImgUrl"/.test(dk) && /id="deckEditImgUrl"/.test(dk));
chk('deck attachImagePicker吃url參數', /urlInputId: 'deckAddImgUrl', urlAddId: 'deckAddImgUrlAdd'/.test(dk) && /urlInputId: 'deckEditImgUrl', urlAddId: 'deckEditImgUrlAdd'/.test(dk));
chk('normalizeImageUrl舊行為不回歸（Drive轉lh3）', normalizeImageUrl('https://drive.google.com/uc?id=ABCDEFGHIJK123').startsWith('https://lh3.googleusercontent.com/d/'));
chk('normalizeImageUrl直連原樣', normalizeImageUrl('https://media1.tenor.com/m/ABC/cat.gif') === 'https://media1.tenor.com/m/ABC/cat.gif');

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /addImageUrlFlow/.test(execSync('git show HEAD:src/lib/word-image.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/lib/image-url.js src/lib/word-image.js src/pages/browser.js src/pages/deck-browser.js');
  try {
    const w2 = readFileSync('src/lib/word-image.js', 'utf8');
    const b2 = readFileSync('src/pages/browser.js', 'utf8');
    const gone = !/addImageUrlFlow/.test(w2) && !/fImageUrl/.test(b2);
    if (gone) { pass++; console.log('  NEG-OK: stash 後特徵全滅（harness 有效）'); }
    else { fail++; console.log('  NEG-FAIL'); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nIMGURL1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
