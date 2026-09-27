// 題庫覆蓋層共享邏輯：工具頁出題/刪題 ↔ 文法頁載入合併（終端 bank.mjs 同規則各持一份）
// overlay = { up: {id: 題目}, rm: [id] }；up 同 id 勝過 base（先刪後加＝復活）
export function mergeBank(base, overlay) {
  const { up = {}, rm = [] } = overlay || {};
  const rmSet = new Set(rm);
  return [...base.filter(q => !rmSet.has(q.id) && !(q.id in up)), ...Object.values(up)];
}

// 既定 schema 守門（LLM 產物是信任邊界，入庫前必過）；id/pattern 由入庫端指定不在此驗
export function validateQuestion(q) {
  if (!q || typeof q !== 'object') return '不是物件';
  if (q.type === 'mc') {
    if (!q.stem) return '缺 stem';
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => !o)) return 'options 需 4 個非空';
    if (!(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4)) return 'answer 需 0-3';
    if (!q.explain) return '缺 explain';
  } else if (q.type === 'translate') {
    if (!q.translation) return '缺 translation';
    if (!q.reference) return '缺 reference';
  } else return 'type 需 mc|translate';
  return null;
}

export function nextQid(list, pattern, kind) {
  let max = 0;
  const re = new RegExp('^g-' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-' + kind + '-(\\d+)$');
  for (const q of list) { const m = re.exec(q.id || ''); if (m) max = Math.max(max, +m[1]); }
  return `g-${pattern}-${kind}-${max + 1}`;
}
