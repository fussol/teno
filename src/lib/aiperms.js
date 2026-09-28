// AI 權限矩陣：逐類別 × 讀(r)/寫(w)/刪(d)，預設全關、fail-closed。
// 物理保證三層：未開 r → 資料不注入 prompt（buildPrompt 呼叫端 gate）＋工具不暴露（buildToolList）；
// 未開 w/d → 寫入點 guard() 硬擋（execTool 二道防線）；ai_perms 本身 AI 永遠不可寫（防自我授權）。
export const AI_CATS = ['bank', 'settings', 'words'];
export const AI_ACTS = ['r', 'w', 'd'];
export const AI_PERMS_KEY = 'ai_perms'; // AI 拒寫（core 硬編碼），只有使用者 UI 能改

export const defaultPerms = () =>
  Object.fromEntries(AI_CATS.map(c => [c, { r: false, w: false, d: false }]));

// 任何畸形/缺失/型別錯 → 當關（fail-closed：讀不到設定＝未授權）
export function normPerms(raw) {
  const out = defaultPerms();
  if (!raw || typeof raw !== 'object') return out;
  for (const c of AI_CATS) {
    const v = raw[c];
    if (v && typeof v === 'object') for (const a of AI_ACTS) out[c][a] = v[a] === true;
  }
  return out;
}

export function can(perms, cat, act) {
  return !!(perms && perms[cat] && perms[cat][act] === true);
}

export function guard(perms, cat, act) {
  if (!can(perms, cat, act)) throw new Error(`ai-perm-denied:${cat}.${act}`);
}
