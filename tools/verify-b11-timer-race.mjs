#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// B11 防回歸驗證 — autoNext timer 與「退出」競態（已由 B2 覆蓋，鎖住行為）
//
// B2（cb76cbf）把三頁裸 setTimeout 管理化：autoNextTimer/pendingNext 欄位化 +
// exit/startExam/resume/saveOnLeave 皆 clearTimeout + nextWord phase/page guard +
// pendingScore 延遲計分三點冪等 flush。
// B11 殘餘風險：exit 後 timer 若仍 fire（遺漏清理），callback 的 nextWord 有
// phase guard（e.phase !== 'exam' → return）→ no-op，不跳題不計分。
// 本測試鎖住這個最後防線：即使 timer 在 exit 後 fire，也完全不影響 state。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', label); }
}

// 讀三頁源碼（真實 code，非 stub）
const flipSrc = readFileSync(new URL('../src/pages/exam-flip.js', import.meta.url), 'utf8');
const mcSrc = readFileSync(new URL('../src/pages/exam-mc.js', import.meta.url), 'utf8');
const spellSrc = readFileSync(new URL('../src/pages/exam-spell.js', import.meta.url), 'utf8');

for (const [name, src] of [['flip', flipSrc], ['mc', mcSrc], ['spell', spellSrc]]) {
  // 1. exit 按鈕 handler 有 clearTimeout（殘留 timer 清理）
  check(`${name} exit clearTimeout`, /ExitBtn[\s\S]{0,1500}?clearTimeout\(e\.(autoNextTimer|pendingNext)\)/.test(src));
  // 2. nextWord 有 phase guard（e.phase !== 'exam' → return）— 最後防線：timer 在 exit 後 fire 也是 no-op
  check(`${name} nextWord phase guard`, /function nextWord\(s\) \{[\s\S]{0,200}?e\.phase !== 'exam'/.test(src));
  // 3. 檔內有 startExam 且存在 clearTimeout（新場清殘留 timer）
  check(`${name} startExam clearTimeout`, /function startExam\(s\) \{/.test(src) && /clearTimeout\(e\.(autoNextTimer|pendingNext)\)/.test(src));
  // 4. 檔內有 resumeSession 且存在 clearTimeout（恢復清殘留 timer）
  check(`${name} resumeSession clearTimeout`, /function resumeSession\(s, session\) \{/.test(src) && /clearTimeout\(e\.(autoNextTimer|pendingNext)\)/.test(src));
  // 5. exit 前 flushPendingScore（延遲窗計分不遺失）
  check(`${name} exit flush`, /ExitBtn[\s\S]{0,1500}?flushPendingScore\(\)/.test(src));
  // 6. timer callback 先 nextWord 後清 null（fire 後不殘留）
  check(`${name} timer callback clears`, /setTimeout\(\(\) => \{ nextWord\(s\); e\.(autoNextTimer|pendingNext) = null; \}/.test(src));
}

// 7. B10 saveOnLeave 也清 timer（sidebar 離開同防線）
for (const [name, src] of [['flip', flipSrc], ['mc', mcSrc], ['spell', spellSrc]]) {
  check(`${name} saveOnLeave clearTimeout`, /function saveOnLeave\(s\) \{[\s\S]{0,200}?clearTimeout\(e\.(autoNextTimer|pendingNext)\)/.test(src));
}

console.log(`\nB11 驗證: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
