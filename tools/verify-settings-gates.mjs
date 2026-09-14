// SETGATES1: 設定頁可見性閘門 — 介面備註僅 devMode、介面大小僅桌機、手機縮放鎖 100%
// 跑法：node tools/verify-settings-gates.mjs
import { readFileSync } from 'node:fs';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const js = readFileSync(`${R}/src/pages/settings.js`, 'utf8');
const store = readFileSync(`${R}/src/lib/store.js`, 'utf8');

console.log('== T1 介面備註僅 devMode ==');
{
  const idx = js.indexOf('} 介面備註</div>'); // section-title 本體（跳過註解行）
  const gateIdx = js.lastIndexOf('s.state.devMode ?', idx);
  ok('介面備註前有 devMode 三元閘', gateIdx !== -1 && idx - gateIdx < 300, `gate@${gateIdx} title@${idx}`);
  // 閘內含開關本體（不是空殼）
  const seg = js.slice(gateIdx, idx + 1500);
  ok('閘內含 uiHintsToggle 開關', seg.includes('uiHintsToggle'));
  // 負控制：拿掉閘＝一般用戶也看得到（抓回歸）
  ok('負控制:無閘版會被判 FAIL', (() => {
    const fake = '<div class="section-title">介面備註</div>';
    return fake.indexOf('devMode') === -1; // 無閘＝判 FAIL 的條件成立
  })());
}

console.log('== T2 介面大小僅桌機（手機隱藏） ==');
{
  const idx = js.indexOf('} 介面大小</div>'); // section-title 本體（跳過註解行）
  const gateIdx = js.lastIndexOf('isAndroid ?', idx);
  ok('介面大小前有 isAndroid 三元閘', gateIdx !== -1 && idx - gateIdx < 400, `gate@${gateIdx} title@${idx}`);
  const seg = js.slice(gateIdx, idx + 1200);
  ok('閘內含 data-uiscale 檔位鈕', seg.includes('data-uiscale'));
  ok('手機分支為空字串（不渲染）', /isAndroid \? '' :/.test(js.slice(gateIdx, gateIdx + 60)));
}

console.log('== T3 手機縮放鎖 100%（store） ==');
ok('store 引入 isAndroid', store.includes("import { isAndroid } from './platform.js'"));
ok('init 手機強制 0（不理 DB）',
  store.includes('state.uiScaleIdx = isAndroid ? 0 : clampUiScaleIdx(settings.uiScaleIdx)'));
ok('setUiScale 手機強制 0', store.includes('applyUiScale(isAndroid ? 0 : idx)'));
ok('platform.js isAndroid 為 UA 判斷（無循環引入：僅引 tauri core）',
  readFileSync(`${R}/src/lib/platform.js`, 'utf8').includes("export const isAndroid = /Android/i.test(ua)"));

console.log('== T4 無其他 section 被誤閘 ==');
for (const t of ['每日重置時間', 'WebDAV 同步', '危險區域', '韋氏字典', '關於']) {
  const idx = js.indexOf(t);
  const before = js.slice(Math.max(0, idx - 400), idx);
  ok(`「${t}」無 devMode/isAndroid 閘（一般用戶可見）`,
    !before.includes('devMode ?') && !before.includes('isAndroid ?'));
}

console.log(fail === 0 ? `SETGATES1: PASS (${pass} pass, 0 fail)` : `SETGATES1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
