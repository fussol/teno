// verify-display-limit.mjs — HOTFIX50K：全部(0)硬上限 2000 自檢
import assert from 'node:assert';
import { capList, limitNote, normalizeDisplayLimit, HARD_LIST_CAP, DISPLAY_LIMIT_DEFAULT } from '../src/lib/display-limit.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, '❌ ' + msg); pass++; console.log('PASS  ' + msg); };

const many = Array.from({ length: 50000 }, (_, i) => i);

// 0=全部 → 受硬上限保護（50k 列 DOM 實測 >180s 當機）
ok(capList(many, 0).length === HARD_LIST_CAP, 'limit=0 五萬詞裁到硬上限 2000');
ok(HARD_LIST_CAP === 2000, '硬上限 = 2000');
// 不足上限 → 原陣列引用（原本 0 的語意）
const small = many.slice(0, 500);
ok(capList(small, 0) === small, 'limit=0 且未超限 → 回原引用');
// 一般上限不變
ok(capList(many, 500).length === 500, 'limit=500 → 500');
ok(capList(many, 2000).length === 2000, 'limit=2000 → 2000');
// 壞值回預設
ok(normalizeDisplayLimit('abc') === DISPLAY_LIMIT_DEFAULT, '壞值 → 預設 500');
// 文案：超限必帶「顯示前 N 筆」
ok(/顯示前 2000 筆/.test(limitNote(many, 0)), 'limit=0 超限文案含「顯示前 2000 筆」');
ok(limitNote(small, 0) === '500 筆結果', 'limit=0 未超限文案 = 全部筆數');
console.log(`${pass} PASS / 0 FAIL  verify-display-limit.mjs`);
