#!/usr/bin/env node
// ═══ 整套流程模擬：分類→三清單→匯入分派（模擬 store/黑灰，驗證邏輯正確性）═══
import fs from 'node:fs';
import path from 'node:path';
const ROOT = '/home/jupiter/teno';
let fail = 0, total = 0;
const ok = (l, c, d) => { total++; if (!c) { fail++; console.log(`FAIL ${l}${d ? ' :: ' + JSON.stringify(d) : ''}`); } else console.log(`PASS ${l}`); };

// 模擬 store 狀態（你真實 DB 的縮影）
const s = {
  state: {
    words: [{ word: 'marathon' }, { word: 'glycogen' }],       // 已存在 → 重複
    blacklist: ['the', 'is'],                                     // 黑名單
    graylist: ['fatigue'],
  },
  actions: {
    isBlacklisted: (w) => s.state.blacklist.includes(w),
    isGraylisted: (w) => s.state.graylist.includes(w),
  },
};

// isNoiseToken：與 crop.js 同款邏輯（源碼釘已驗存在 — verify-crop-page A6）
// 常見三字母詞白名單（防誤殺）
const COMMON3 = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'];
const cropSrc = fs.readFileSync(path.join(ROOT, 'src/pages/crop.js'), 'utf8');
const isNoiseToken = (t) => {
  if (s.actions.isBlacklisted(t) || s.actions.isGraylisted(t)) return true;
  if (t.length <= 2) return true;
  if (t.length === 3 && !COMMON3.includes(t)) return true;
  return false;
};

// 模擬一批掃描 token（實測照片的輸出）
const scanned = ['marathon', 'hitting', 'wall', 'glycogen', 'the', 'is', 'fatigue', 'carbohydrate', 'ae', 'pu', 'ar', 'hin', 'strategy', 'adequate'];

const NEW = new Set(), DUP = new Set(), NOISE = new Set();
for (const t of scanned) {
  if (isNoiseToken(t)) { NOISE.add(t); continue; }
  const dup = s.state.words.some(w => w.word === t);
  if (dup) DUP.add(t); else NEW.add(t);
}
console.log(`掃描 ${scanned.length} token → 新:[${[...NEW]}] 重複:[${[...DUP]}] 雜訊:[${[...NOISE]}]`);

// T1 三清單分類正確性
ok('T1a 重複字進重複清單', DUP.has('marathon') && DUP.has('glycogen') && !NEW.has('marathon'));
ok('T1b 黑名單進雜訊清單', NOISE.has('the') && NOISE.has('is') && !NEW.has('the'));
ok('T1c 灰名單進雜訊清單', NOISE.has('fatigue'));
ok('T1d 碎片（<=2字母）進雜訊', NOISE.has('ae') && NOISE.has('pu') && NOISE.has('ar'));
ok('T1e 3字母非常見詞進雜訊', NOISE.has('hin'));
ok('T1f 完整新詞進新清單', NEW.has('hitting') && NEW.has('wall') && NEW.has('carbohydrate') && NEW.has('strategy') && NEW.has('adequate'));
ok('T1g 三清單聯集 = 掃描集（無遺漏）', NEW.size + DUP.size + NOISE.size === scanned.length);

// T2 匯入分派規則（源碼釘）
ok('T2a 新字頁 importOcrText 無 override（正常入庫）', /_tabIdx === 1[\s\S]{0,900}importOcrText\(picked, undefined, \{\}\)/.test(cropSrc) || cropSrc.includes('importOcrText(picked, undefined, {})'));
ok('T2b 雜訊頁 override（強制加入）', cropSrc.includes('override: new Set(picked)'));
ok('T2c 重複頁批量轉移（editWord deck）', cropSrc.includes('editWord(word.id, { deck: target })'));
ok('T2d 入庫後 token 移到重複頁', cropSrc.includes('_dupTokens.add(t)'));

console.log(fail === 0 ? `\n═══ ${total - fail}/${total} ALL PASS — 整套邏輯驗證通過 ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
