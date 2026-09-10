// ═══════════════════════════════════════════════════════════════
// Example rotation — 例句「下一組」抽樣池（EXNEXT1）
// 規則（使用者 2026-09-10 指定）：
//   1. 初次渲染：全部句子隨機抽 N 句
//   2. 按「下一組」：從「非當前顯示」的句子抽；優先出現次數最少的
//   3. 非當前不足 N 時，從已顯示的補（一樣優先次數最少）
//   4. 周而復始：每句出現次數記帳，永遠先抽最少出現的 → 長期均衡
// ═══════════════════════════════════════════════════════════════

/**
 * 從 lines 抽下一組 N 句。
 * @param {string[]} lines 全部例句
 * @param {number} max 顯示上限（N）
 * @param {string[]} prevShown 目前顯示中的句子（要排除）
 * @param {Object<string,number>} counts 出現次數記帳（會原地更新）
 * @returns {string[]} 新的 N 句
 */
export function pickNextExamples(lines, max, prevShown, counts) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const n = Math.min(max, lines.length);
  const prevSet = new Set(prevShown || []);
  // 候選池：非當前顯示優先
  let pool = lines.filter(l => !prevSet.has(l));
  let fallback = lines.filter(l => prevSet.has(l));
  const picked = [];
  while (picked.length < n) {
    // 抽完候選池 → 切到 fallback（已顯示過的）
    if (pool.length === 0) {
      pool = fallback;
      fallback = [];
      if (pool.length === 0) break; // 全空防護（不會發生）
    }
    // 池內最小出現次數
    const minCount = Math.min(...pool.map(l => counts[l] || 0));
    const least = pool.filter(l => (counts[l] || 0) === minCount);
    const choice = least[Math.floor(Math.random() * least.length)];
    picked.push(choice);
    pool = pool.filter(l => l !== choice);
  }
  for (const p of picked) counts[p] = (counts[p] || 0) + 1;
  return picked;
}

/**
 * 初次渲染的抽樣（也記帳）。
 */
export function pickFirstExamples(lines, max, counts) {
  const picked = pickNextExamples(lines, max, [], counts);
  return picked;
}
