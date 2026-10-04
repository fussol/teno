// new Function 型 harness 共用件：import 名單自動掃＋預設 stub＋真實 rng 載入＋頁面模組求值。
// 用意：頁面 import 名單會隨拆檔成長（例 bindExNext / mountWordImages / mulberry32），
// harness 把 import 行剝掉後若沒把該名當參數傳入 → ReferenceError（[A] 類過期 harness 主因）。
// 這裡改成從原始 import 語句自動掃名 → 未顯式給 stub 者補預設 stub，之後拆檔不用逐顆補。
import fs from 'node:fs';
import path from 'node:path';

// 從原始檔撈 import 匯入名（named / default / * as ns 三型）
export function importedNames(src) {
  const out = [];
  for (const m of src.matchAll(/^import\s+([^;]+);$/gm)) {
    const clause = m[1];
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) for (const raw of brace[1].split(',')) {
      const t = raw.trim(); if (!t) continue;
      const parts = t.split(/\s+as\s+/);
      out.push((parts[1] || parts[0]).trim());
    }
    const head = clause.replace(/\{[^}]*\}/, ' ')
      .replace(/\s+from\s+\S+.*$/, '')
      .replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    if (head.startsWith('*')) {
      const ns = head.match(/\*\s+as\s+(\w+)/);
      if (ns) out.push(ns[1]);
    } else if (head) {
      out.push(head.split(/\s+as\s+/).pop().trim());
    }
  }
  return [...new Set(out.filter(Boolean))];
}

// 預設 stub＝可呼叫：回傳 String 物件（字串語意 ''，模板字串／字串方法可用）＋ then/catch/finally
// （async 匯入如 mountWordImages 要求回傳 promise → `.catch()` 不炸；`await` 走 thenable 解析）。
// 參數本身要是 function（頁面多以 `typeof x === 'function'` / 直接呼叫）→ 參數給 function、回傳值給字串物件。
export function autoStub() {
  const s = new String('');
  s.then = (a, b) => Promise.resolve('').then(a, b);
  s.catch = () => Promise.resolve('');
  s.finally = () => Promise.resolve('');
  return () => s;
}

// 真實 rng（src/lib/rng.js 無 import，剝 export 即可 eval；mc/測驗頁選項擲用 mulberry32/hashCode）
export function loadRng(root) {
  const src = fs.readFileSync(path.join(root, 'src/lib/rng.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function');
  return new Function(src + '\n;return { mulberry32, hashCode };')();
}

// raw = 原始檔；src = harness 轉換後源碼（已剝 import/export、可選 mutation）；
// fixed = 顯式 stub（Map，key 即參數名，會蓋過自動掃描）；exportNames = 要回傳的函式/變數名。
export function evalPageModule({ raw, src, exportNames, fixed = new Map(), documentStub, windowStub }) {
  const getters = exportNames
    .map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`)
    .join(',');
  const auto = importedNames(raw).filter(n => !fixed.has(n) && n !== 'document' && n !== 'window');
  const params = [...fixed.keys(), ...auto, 'document', 'window'];
  const args = [...fixed.values(), ...auto.map(() => autoStub()), documentStub, windowStub];
  const factory = new Function(...params, src + `\n;return { ${getters} };`);
  return factory(...args);
}
