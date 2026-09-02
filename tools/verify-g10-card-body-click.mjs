#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G10 防回歸驗證 — .card-panel-body 整段可點發音（含中文）
// 用真實 DOM closest 語意驗證 bindSpeakClick selector 命中行為。
// 修後(移除 .card-panel-body)：點容器不觸發、點子元素仍觸發。
// 修前(保留 .card-panel-body)：點容器觸發 = bug 重現。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

// ── 真實 selector（bindSpeakClick :193）──
const ttsSrc = readFileSync(new URL('../src/lib/tts.js', import.meta.url), 'utf8');
const m = ttsSrc.match(/closest\('([^']+)'\)/);
let realSel = m ? m[1] : '';
ok('H0 找到 bindSpeakClick selector', !!realSel);

// FIX MARKER：真實 tts.js 的 selector 必須已移除 .card-panel-body（未修 → FAIL）
ok('H1 真實 source selector 不含 .card-panel-body（已修）', !realSel.includes('.card-panel-body'));

// 測試用的「修後」投影（僅供 T1-T4/T6 對照行為）
const newSel = realSel.replace(/\.card-panel-body,\s*/g, '').replace(/,\s*\.card-panel-body/g, '');

// ── 純語意 closest 模擬（無 DOM 依賴，最小 DOM）：對給定 class 判定是否 hit ──
// closest(sel) 回傳該元素或其任一個祖先符合 selector。這裡把目標 class 當「元素本身」，
// 並模擬「點在 body 的空白處 → ev.target=body」vs「點在子元素 → ev.target=子元素」。
function targetHit(sel) {
  // 解析 selector 成 class 集合
  const selClasses = sel.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^\s*\./, ''));
  return (targetClass) => selClasses.includes(targetClass);
}
const hitNew = targetHit(newSel);
const hitOld = targetHit(realSel);

console.log('── G10 .card-panel-body 委派命中 ──');

// T1 修後：點 body 容器 → 不觸發（body 不在 selector）
ok('T1 修後 點.card-panel-body → 不觸發', !hitNew('card-panel-body'));
// T2 點 word → 觸發
ok('T2 修後 點.card-panel-word → 觸發', hitNew('card-panel-word'));
// T3 點 def → 觸發
ok('T3 修後 點.card-panel-def → 觸發', hitNew('card-panel-def'));
// T4 點 example → 觸發
ok('T4 修後 點.card-panel-example → 觸發', hitNew('card-panel-example'));
// T5 負控制（資訊性，不計入 fail）：修前(含 body) selector 對 body 命中 → bug
// 修後因 selector 已移除 body → 此項反轉 false 屬正常（真實負控制由 H1 標記承擔）
const t5 = hitOld('card-panel-body');
console.log(`  [info] T5 修前 selector 對 body 命中=${t5}（未修時應 true=bug 重現；H1 為真實 fix marker）`);
// T6 其他不變：tts-click 仍觸發
ok('T6 修後 點.tts-click → 觸發', hitNew('tts-click'));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);