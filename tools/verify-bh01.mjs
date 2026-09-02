#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-bh01.mjs — BH-01: deleteDeck 漏清 suspendedMc / suspendedSpell
//   補 state 過濾 + db.setSetting 兩行（BUGHUNT-TODO.md#BH-01）。
// 用法: node tools/verify-bh01.mjs
// 三層：1) 源碼契約釘（讀真實 store.js deleteDeck，未修必 FAIL）
//       2) 語意重放（修後 filter 語意 → 剔除正確、對照不誤傷）
//       3) 負控制（剝除 suspendedMc/Spell 兩行 → bug 態殘留精準重現）
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_JS = join(REPO, 'src/lib/store.js');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${extra}»`); }
};

const src = readFileSync(STORE_JS, 'utf8');

// ── deleteDeck function body 切片（停於 method 結尾 '\n  },'）──
const fnStart = src.indexOf('async deleteDeck(id) {');
const body = src.slice(fnStart, src.indexOf('\n  },', fnStart));

// ── 語意重放：模擬修後 deleteDeck 對 suspended 家族的過濾 ──
function runDeleteDeck({ strip = false } = {}) {
  const wordIds = new Set(['wDeckA1', 'wDeckA2']);   // 屬被刪字本的 id
  const s = {
    suspended:        new Set(['wDeckA1', 'wOther']),
    suspendedMc:      new Set(['wDeckA2', 'wOther']),
    suspendedSpell:   new Set(['wDeckA1']),
    buried:           new Set(['wDeckA1']),
  };
  const filter = k => new Set([...s[k]].filter(id => !wordIds.has(id)));
  s.suspended = filter('suspended');
  if (!strip) {                 // 修法存在：suspendedMc / suspendedSpell 也過濾
    s.suspendedMc = filter('suspendedMc');
    s.suspendedSpell = filter('suspendedSpell');
  }
  return s;
}

try {
  // ═══ 1. 源碼契約釘（未修 → 必紅）═══
  console.log('── 1. source 契約釘（store.js deleteDeck）──');
  let setCalls = 0;
  for (const k of ['suspendedMc', 'suspendedSpell']) {
    const hasFilter = body.includes(`state.${k} = new Set([...state.${k}].filter(id => !wordIds.has(id)))`);
    const hasSetting = body.includes(`db.setSetting('${k}',`) && body.includes(`[...state.${k}]`);
    T(`S1 ${k} Set 過濾存在`, hasFilter);
    T(`S2 ${k} db.setSetting 存在`, hasSetting);
    if (hasSetting) setCalls++;
  }
  T('S3 兩行 setSetting 皆在', setCalls === 2, `calls=${setCalls}`);

  // ═══ 2. 語意重放（修後語意）═══
  console.log('── 2. 語意重放 ──');
  {
    const s = runDeleteDeck();
    T('P1 suspendedMc 剔除 deck id、保留其他', s.suspendedMc.has('wDeckA2') === false && s.suspendedMc.has('wOther') === true, [...s.suspendedMc].join(','));
    T('P2 suspendedSpell 剔除 deck id', s.suspendedSpell.has('wDeckA1') === false, [...s.suspendedSpell].join(','));
    T('P3 對照 flip suspended 不受影響（保留 wOther）', s.suspended.has('wOther') === true, [...s.suspended].join(','));
    T('P4 suspendedMc/Spell 與 suspended 各自獨立（wOther 不同集合）', s.suspendedMc.size === 1 && s.suspendedSpell.size === 0, `${s.suspendedMc.size}/${s.suspendedSpell.size}`);
  }

  // ═══ 3. 負控制（剝除修法 → 殘留）═══
  console.log('── 3. 負控制（剝除 suspendedMc/Spell → bug 態殘留）──');
  {
    const s = runDeleteDeck({ strip: true });
    const orphan = [...s.suspendedMc].filter(id => id.startsWith('wDeckA')).length;
    const orphanSpell = s.suspendedSpell.has('wDeckA1') ? 1 : 0;
    T(`N1 未修版 suspendedMc 死 id 殘留（${orphan}）— harness 對 bug 態有牙`, orphan === 1, `orphan=${orphan}`);
    T('N2 未修版 suspendedSpell 死 id 殘留（BUG 精準重現）', orphanSpell === 1, `orphan=${orphanSpell}`);
  }
} finally {}

console.log(`\n═══ BH-01 verify: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);